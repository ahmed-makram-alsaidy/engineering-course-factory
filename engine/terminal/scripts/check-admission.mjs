// P5.2 validation helper: exercises the trusted admission layer end-to-end
// through the canonical compile pipeline and prints a machine-checkable
// verdict. Invoked by scripts/validate-p5-2.sh. Performs NO execution —
// admission is authorization/translation only.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const repoRoot = join(packageRoot, "..", "..");

const { parseLessonData } = await import(pathToFileURL(join(packageRoot, "..", "..", "packages", "shared-types", "src", "validate.ts")));
const COMPILE_MODULE = "@course-factory/lesson-compiler/compile";
const compileModule = await import(COMPILE_MODULE);

const admissionUrl = pathToFileURL(join(packageRoot, "src", "admission.ts"));
const policyUrl = pathToFileURL(join(packageRoot, "src", "policy.ts"));
const { createAdmissionService, ExecutionGrantSchema } = await import(admissionUrl);
const { ADMISSION_POLICY } = await import(policyUrl);
const protocol = await import(pathToFileURL(join(packageRoot, "src", "protocol.ts")));

const problems = [];
function check(label, condition, detail = "") {
  if (!condition) problems.push(`${label}${detail ? `: ${detail}` : ""}`);
}

// -- canonical pipeline + grants ---------------------------------------------

const mixedRaw = JSON.parse(readFileSync(join(packageRoot, "tests", "fixtures", "p52-terminal-mixed.json"), "utf8"));
const mixedParsed = parseLessonData(mixedRaw);
check("mixed fixture parses", mixedParsed.ok === true);
const mixedIr = compileModule.compileLesson(mixedParsed.lesson);

const service = createAdmissionService();
const catalog = service.installLesson(mixedIr);
check("catalog accepted", catalog.ok === true, catalog.ok ? "" : catalog.rejection.message);
if (!catalog.ok) {
  console.log("ADMISSION_CHECKS_FAILED " + JSON.stringify(problems));
  process.exit(1);
}

const session = service.openSession(catalog.value, { executionAuthorized: true });
check("session opened", session.ok === true);
if (!session.ok) {
  console.log("ADMISSION_CHECKS_FAILED " + JSON.stringify(problems));
  process.exit(1);
}
const identity = session.value.identity;

const FOREGROUND_OP = "C01-L052-S001-B002";
const BACKGROUND_OP = "C01-L052-S002-B001";
const BROWSER_OP = "C01-L052-S001-B003";
const STOP_OP = "C01-L052-S003-B002";

const fg = service.admitRunOperation(identity, { session_id: identity.session_id, operation_id: FOREGROUND_OP, request_id: "req-fg" });
check("foreground admitted", fg.ok === true, fg.ok ? "" : fg.rejection.message);
if (fg.ok && fg.value.kind === "execution_grant") {
  check("exact command preserved", fg.value.command === "node --version", fg.value.command);
  check("project-relative cwd preserved", fg.value.cwd === "scripts", String(fg.value.cwd));
  check("authored timeout preserved", fg.value.timeout_ms === 30_000);
  check("authored expected exit preserved", fg.value.expected_exit_code === 0);
  check("foreground process_id null", fg.value.process_id === null);
  check("grant frozen", Object.isFrozen(fg.value) === true);
}

// stop of a defined-but-unstarted process must be rejected before the run
const earlyStop = service.admitRunOperation(identity, { session_id: identity.session_id, operation_id: STOP_OP, request_id: "req-stop-early" });
check("stop of unstarted process rejected", !earlyStop.ok && earlyStop.rejection.code === "PROCESS_NOT_STARTED");

const bg = service.admitRunOperation(identity, { session_id: identity.session_id, operation_id: BACKGROUND_OP, request_id: "req-bg" });
check("background admitted", bg.ok === true, bg.ok ? "" : bg.rejection.message);
if (bg.ok && bg.value.kind === "execution_grant") {
  check("logical process_id preserved", bg.value.process_id === "dev-server", String(bg.value.process_id));
  check("background command preserved", bg.value.command === "node server.js");
  check("background cwd preserved", bg.value.cwd === "app");
  check("background has no foreground timeout", bg.value.timeout_ms === null);
}

// -- wrong engine / stale / hostile -------------------------------------------

const browser = service.admitRunOperation(identity, { session_id: identity.session_id, operation_id: BROWSER_OP, request_id: "req-browser" });
check("browser op rejected", !browser.ok && browser.rejection.code === "UNSUPPORTED_PHASE");

const stale = service.admitRunOperation(
  { session_id: identity.session_id, generation: identity.generation + 5 },
  { session_id: identity.session_id, operation_id: FOREGROUND_OP, request_id: "req-stale" },
);
check("stale generation rejected", !stale.ok && stale.rejection.code === "STALE_SESSION");

const hostile = service.admitRunOperation(identity, {
  session_id: identity.session_id,
  operation_id: FOREGROUND_OP,
  request_id: "req-hostile",
  command: "echo pwned > pwned.txt",
  cwd: "E:\\course-factory",
  env: { NODE_OPTIONS: "--require pwn.js" },
  image: "evil:latest",
});
check("hostile command-bearing request rejected", !hostile.ok && hostile.rejection.code === "INVALID_REQUEST");

// -- stop admission resolves without stopping ----------------------------------

const stop = service.admitStopProcess(identity, { session_id: identity.session_id, process_id: "dev-server", request_id: "req-stop" });
check("operator stop admitted against started process", stop.ok === true, stop.ok ? "" : stop.rejection.message);
if (stop.ok && stop.value.kind === "stop_admission") {
  check("trusted stop target", stop.value.target.process_id === "dev-server" && stop.value.target.defined_in.beat_id === BACKGROUND_OP);
}

// -- sentinel: admission must never execute ------------------------------------

const profileRaw = JSON.parse(readFileSync(join(packageRoot, "tests", "fixtures", "p52-command-profile.json"), "utf8"));
const profileParsed = parseLessonData(profileRaw);
check("profile fixture parses", profileParsed.ok === true);
const profileIr = compileModule.compileLesson(profileParsed.lesson);
const service2 = createAdmissionService();
const catalog2 = service2.installLesson(profileIr);
check("profile catalog accepted", catalog2.ok === true);
let sentinelAdmitted = false;
if (catalog2.ok) {
  const session2 = service2.openSession(catalog2.value, { executionAuthorized: true });
  check("profile session opened", session2.ok === true);
  if (session2.ok) {
    const profileIdentity = session2.value.identity;
    const sentinel = service2.admitRunOperation(profileIdentity, {
      session_id: profileIdentity.session_id,
      operation_id: "C01-L053-S001-B001",
      request_id: "req-sentinel",
    });
    check("sentinel op admitted", sentinel.ok === true);
    if (sentinel.ok && sentinel.value.kind === "execution_grant") {
      sentinelAdmitted = true;
      check("sentinel command byte-exact", sentinel.value.command === "echo COURSE_FACTORY_P52_SENTINEL > p52-sentinel.txt");
    }
    const nul = service2.admitRunOperation(profileIdentity, {
      session_id: profileIdentity.session_id,
      operation_id: "C01-L053-S001-B002",
      request_id: "req-nul",
    });
    check("no NUL command admitted", !nul.ok && nul.rejection.code === "UNSUPPORTED_COMMAND_PROFILE");
  }
}
void sentinelAdmitted;
check("sentinel file absent in repo root", !existsSync(join(repoRoot, "p52-sentinel.txt")));

// -- renderer protocol unchanged (identifier-only) ------------------------------

const five = ["CancelOperationRequestSchema", "GetSnapshotRequestSchema", "ResetRuntimeRequestSchema", "RunOperationRequestSchema", "StopProcessRequestSchema"];
check("protocol exports exactly five request schemas", JSON.stringify(Object.keys(protocol).filter((k) => k.endsWith("RequestSchema")).sort()) === JSON.stringify(five));
check("grant schema has no execution-policy fields", ["env", "image", "mounts", "user", "network", "shell", "stdin"].every((k) => !(k in ExecutionGrantSchema.shape)));
check("policy constants are the design values",
  ADMISSION_POLICY.foreground_timeout_default_ms === 60_000 &&
  ADMISSION_POLICY.foreground_timeout_max_ms === 3_600_000 &&
  ADMISSION_POLICY.max_concurrent_backgrounds === 4 &&
  ADMISSION_POLICY.max_command_bytes === 16_384 &&
  ADMISSION_POLICY.max_ir_bytes === 1_048_576);

if (problems.length > 0) {
  console.log("ADMISSION_CHECKS_FAILED " + JSON.stringify(problems));
  process.exit(1);
}
console.log("ADMISSION_CHECKS_OK (grants/resolution/stale/hostile/stop/sentinel/protocol verified; nothing executed)");
