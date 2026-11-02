// P5.3 validation helper: exercises trusted workspace resolution, the
// environment policy, the runtime image identity and the resolved execution
// context end-to-end — from a grant produced by the canonical admission
// pipeline — and prints a machine-checkable verdict. Invoked by
// scripts/validate-p5-3.sh. Performs NO execution of any kind: no command is
// run, no container is created, no process is started. All host paths used
// here are synthetic per-run temp directories (os.tmpdir()).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const repoRoot = join(packageRoot, "..", "..");

const workspace = await import(pathToFileURL(join(packageRoot, "src", "workspace.ts")));
const environment = await import(pathToFileURL(join(packageRoot, "src", "environment.ts")));
const runtimeConfig = await import(pathToFileURL(join(packageRoot, "src", "runtime-config.ts")));
const { parseLessonData } = await import(pathToFileURL(join(repoRoot, "packages", "shared-types", "src", "validate.ts")));
const compileModule = await import("@course-factory/lesson-compiler/compile");
const admission = await import(pathToFileURL(join(packageRoot, "src", "admission.ts")));

const problems = [];
function check(label, condition, detail = "") {
  if (!condition) problems.push(`${label}${detail ? `: ${detail}` : ""}`);
}

// -- canonical pipeline: the grant comes from trusted admission, never hand-built
const fixtureRaw = JSON.parse(readFileSync(join(packageRoot, "tests", "fixtures", "p52-terminal-mixed.json"), "utf8"));
const fixtureParsed = parseLessonData(fixtureRaw);
check("fixture parses", fixtureParsed.ok === true);
if (!fixtureParsed.ok) {
  console.log("WORKSPACE_CHECKS_FAILED " + JSON.stringify(problems));
  process.exit(1);
}
const ir = compileModule.compileLesson(fixtureParsed.lesson);
const service = admission.createAdmissionService();
const catalog = service.installLesson(ir);
check("catalog accepted", catalog.ok === true, catalog.ok ? "" : catalog.rejection.message);
if (!catalog.ok) {
  console.log("WORKSPACE_CHECKS_FAILED " + JSON.stringify(problems));
  process.exit(1);
}
const session = service.openSession(catalog.value, { executionAuthorized: true });
check("session opened", session.ok === true);
if (!session.ok) {
  console.log("WORKSPACE_CHECKS_FAILED " + JSON.stringify(problems));
  process.exit(1);
}
const identity = session.value.identity;
const grantResult = service.admitRunOperation(identity, {
  session_id: identity.session_id,
  operation_id: "C01-L052-S001-B002",
  request_id: "req-p53-check",
});
check(
  "foreground grant admitted",
  grantResult.ok === true && grantResult.ok && grantResult.value.kind === "execution_grant",
  grantResult.ok ? "" : grantResult.rejection.message,
);
if (!grantResult.ok || grantResult.value.kind !== "execution_grant") {
  console.log("WORKSPACE_CHECKS_FAILED " + JSON.stringify(problems));
  process.exit(1);
}
const grant = grantResult.value;
check("authored cwd present", typeof grant.cwd === "string" && grant.cwd.length > 0, String(grant.cwd));

// -- machine-local runtime configuration (synthetic repo copy; the real
//    config/paths.json is git-ignored and never read by this check)
const fakeRepo = mkdtempSync(join(tmpdir(), "cf-p53-check-repo-"));
const wsRoot = realpathSync(mkdtempSync(join(tmpdir(), "cf-p53-check-ws-")));
mkdirSync(join(fakeRepo, "config"));
writeFileSync(join(fakeRepo, "config", "paths.json"), JSON.stringify({ runtimeWorkspaceRoot: wsRoot }));

const created = [];
const cwdDir = typeof grant.cwd === "string" ? grant.cwd : "scripts";
try {
  const paths = workspace.loadTerminalRuntimePaths(fakeRepo);
  check("runtime config loads", paths.ok === true, paths.ok ? "" : paths.error.message);
  if (paths.ok) {
    const rootRes = workspace.resolveConfiguredWorkspaceRoot(paths.value.runtimeWorkspaceRoot);
    check("configured root accepted", rootRes.ok === true, rootRes.ok ? "" : rootRes.error.message);
    if (rootRes.ok) {
      const leafRes = workspace.createSessionWorkspace(rootRes.value, {
        lesson_id: grant.lesson_id,
        session_id: grant.session_id,
        generation: grant.generation,
      });
      check("session leaf created", leafRes.ok === true, leafRes.ok ? "" : leafRes.error.message);
      if (leafRes.ok) {
        const leaf = leafRes.value;
        created.push(leaf.host_root);
        check("leaf exists on disk", existsSync(leaf.host_root));
        check("container root is /workspace", leaf.container_root === "/workspace");
        const reuse = workspace.createSessionWorkspace(rootRes.value, {
          lesson_id: grant.lesson_id,
          session_id: grant.session_id,
          generation: grant.generation,
        });
        check("leaf reuse rejected", reuse.ok === false && reuse.error.code === "WORKSPACE_VIOLATION");

        mkdirSync(join(leaf.host_root, cwdDir));
        const resolved = workspace.resolveGrantWorkspace(leaf, { ...grant });
        check("grant resolved", resolved.ok === true, resolved.ok ? "" : resolved.error.message);
        if (resolved.ok) {
          const pathsOut = resolved.value;
          check("container cwd confined", pathsOut.container_cwd === `/workspace/${cwdDir}`, pathsOut.container_cwd);
          check("host cwd physically inside leaf", workspace.isInsideWorkspace(leaf.host_root, pathsOut.host_cwd) === true);
          check("host cwd under host root", pathsOut.host_cwd.startsWith(leaf.host_root));
          check("host root equals leaf", pathsOut.host_workspace_root === leaf.host_root);

          const hostile = [
            ["traversal", "../escape"],
            ["deep traversal", `${cwdDir}/../../escape`],
            ["encoded traversal", "%2e%2e"],
            ["absolute", "/etc"],
            ["drive letter", "C:/windows"],
          ];
          for (const [label, cwd] of hostile) {
            const rej = workspace.resolveGrantWorkspace(leaf, { ...grant, cwd });
            check(`hostile cwd rejected (${label})`, rej.ok === false, rej.ok ? "accepted" : rej.error.code);
          }

          // prefix-collision escape: a sibling whose name extends the root's name
          check("prefix collision outside", workspace.isInsideWorkspace(leaf.host_root, `${leaf.host_root}-evil`) === false);

          // symlink/junction escape: an external directory linked inside the leaf
          const outside = realpathSync(mkdtempSync(join(tmpdir(), "cf-p53-check-out-")));
          created.push(outside);
          const linkPath = join(leaf.host_root, cwdDir, "escape-link");
          symlinkSync(outside, linkPath, process.platform === "win32" ? "junction" : "dir");
          const escaped = workspace.resolveGrantWorkspace(leaf, { ...grant, cwd: `${cwdDir}/escape-link` });
          check(
            "symlink/junction escape rejected",
            escaped.ok === false && escaped.error.code === "WORKSPACE_VIOLATION",
            escaped.ok ? "accepted" : escaped.error.code,
          );


          const mount = workspace.buildWorkspaceMountPlan(resolved.value);
          check("mount plan built", mount.ok === true, mount.ok ? "" : mount.error.message);
          if (mount.ok) {
            check("exactly one mount", mount.value.length === 1, String(mount.value.length));
            const only = mount.value[0];
            check("mount target /workspace", only.target === "/workspace", only.target);
            check("mount is writable bind", only.type === "bind" && only.read_only === false);
            check("mount source is the session leaf", only.source === resolved.value.host_workspace_root);
          }

          // environment policy: fixed base + explicit allowlist only
          const hostileHostEnv = Object.freeze({
            TZ: "UTC",
            PATH: "synthetic-host-path",
            GITHUB_TOKEN: "synthetic-github-secret",
            AWS_SECRET_ACCESS_KEY: "synthetic-aws-secret",
            NODE_ENV: "production",
          });
          const env = environment.resolveEnvironmentPlan(hostileHostEnv, ["TZ"]);
          check("environment plan resolved", env.ok === true, env.ok ? "" : env.error.message);
          if (env.ok) {
            check("only requested name forwarded", env.value.host_forwarded.length === 1 && env.value.host_forwarded[0].name === "TZ");
            const serialized = JSON.stringify(env.value);
            check("no secret values in plan", !serialized.includes("synthetic") && !serialized.includes("GITHUB") && !serialized.includes("PATH"));
            const description = environment.describeEnvironmentPlan(env.value);
            check(
              "description redacts values",
              description.values_redacted === true && description.host_forwarded.every((e) => e.value === "redacted"),
            );
            const pathReq = environment.resolveEnvironmentPlan(hostileHostEnv, ["PATH"]);
            check("PATH request rejected", pathReq.ok === false && pathReq.error.code === "ENVIRONMENT_POLICY_VIOLATION");
            const secretReq = environment.resolveEnvironmentPlan(hostileHostEnv, ["GITHUB_TOKEN"]);
            check("secret request rejected", secretReq.ok === false && secretReq.error.code === "ENVIRONMENT_POLICY_VIOLATION");
          }

          const image = runtimeConfig.loadRuntimeImageIdentity(repoRoot);
          check("pinned image identity loaded", image.ok === true, image.ok ? "" : image.error.message);
          if (image.ok) {
            check("image digest pinned", /^sha256:[0-9a-f]{64}$/.test(image.value.digest));
            check("image pull policy never", image.value.pull_policy === "never");
            const ctx = workspace.resolveExecutionContext({
              workspace_paths: resolved.value,
              mount_plan: mount.ok ? mount.value : [],
              environment_plan: env.ok ? env.value : { environment_policy_version: 1, base: {}, host_forwarded: [] },
              image_identity: image.value,
            });
            check("context resolved", ctx.ok === true, ctx.ok ? "" : ctx.error.message);
            if (ctx.ok && mount.ok && env.ok) {
              check("context sandbox ref", ctx.value.sandbox_policy_ref === workspace.SANDBOX_POLICY_REF);
              check("context container root /workspace", ctx.value.workspace.container_workspace_root === "/workspace");
              check("context deep-frozen", Object.isFrozen(ctx.value) && Object.isFrozen(ctx.value.workspace));
              const portable = JSON.stringify({
                container_cwd: ctx.value.workspace.container_cwd,
                container_workspace_root: ctx.value.workspace.container_workspace_root,
                grant: ctx.value.grant,
              });
              check("portable contracts machine-path-free", !/[A-Za-z]:[\\\\/]/.test(portable) && !portable.includes(wsRoot));
            }
            // forged inputs must fail: a smuggled environment plan
            const badEnv = {
              environment_policy_version: 1,
              base: { ...environment.ENVIRONMENT_POLICY.base_environment },
              host_forwarded: [{ name: "PATH", value: "synthetic-host-path", source: "host_allowlist" }],
            };
            const badCtx = workspace.resolveExecutionContext({
              workspace_paths: resolved.value,
              mount_plan: mount.ok ? mount.value : [],
              environment_plan: badEnv,
              image_identity: image.value,
            });
            check("smuggled env plan rejected", badCtx.ok === false && badCtx.error.code === "ENVIRONMENT_POLICY_VIOLATION");
          }
        }
      }
    }
  }
} finally {
  rmSync(fakeRepo, { recursive: true, force: true });
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
  rmSync(wsRoot, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.log("WORKSPACE_CHECKS_FAILED " + JSON.stringify(problems));
  process.exit(1);
}
console.log("WORKSPACE_CHECKS_OK (config/root/leaf/grant/cwd-confine/symlink/mount/env/image/context verified; nothing executed)");

