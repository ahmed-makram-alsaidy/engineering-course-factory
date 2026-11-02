// Guest supervisor — build entry (esbuild -> container/dist/supervisor.mjs,
// plain JS for Node 24). GUEST-ONLY: this file runs only as the container
// entrypoint; it is never imported by Windows host code and is therefore
// excluded from the package's public exports.
//
// P5.5 wiring: the adapter remains a byte-and-clock mover around the pure
// core (supervisor-core.ts) and the guest process table (process-groups.ts).
// All process creation lives HERE (the container entrypoint): every managed
// lesson process is spawned detached so it becomes its own POSIX process
// group leader (pgid == pid), giving the supervisor real group-kill ability.
// Decisions come from the core/table; this adapter only moves bytes and
// clocks.
//
// Guest safety invariants (design):
//   - EOF / lease expiry / shutdown / SIGTERM all stop every managed group
//     and exit the supervisor within the 5 s deadline even if descendants
//     resist (SIGKILL to the whole group).
//   - Supervisor stdout is frames only; Docker/supervisor stderr is
//     diagnostics, never lesson output.
//   - Sustained writer blockage (> 2 s with a large pending queue)
//     initiates cleanup — the supervisor kills its groups and exits rather
//     than growing memory without bound.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { checkFrameByteLimit, type GuestFrame } from "./protocol.ts";
import { SupervisorCore } from "./supervisor-core.ts";
import {
  GuestProcessTable,
  GUEST_WRITER_QUEUE_LIMIT_BYTES,
  type GuestSpawnedProcess,
} from "./process-groups.ts";

const TICK_MS = 500;
const FLUSH_EXIT_DELAY_MS = 50;
const WRITER_BLOCKAGE_LIMIT_MS = 2_000;
const WRITER_BLOCKAGE_CHECK_MS = 500;
/** P5.9: bounded window for the /proc group inventory probe (stop confirmation). */
const INVENTORY_PROBE_TIMEOUT_MS = 2_000;

const nodeVersion = process.version;
const nodeMajor = Number(nodeVersion.slice(1).split(".")[0]);
const core = new SupervisorCore({ node_major: nodeMajor, node_version: nodeVersion });

/** Guest monotonic clock (monotonic from guest process start). */
const now = () => performance.now();

let pendingWriterBytes = 0;
let writerBlockedSinceMs: number | null = null;
let exiting = false;

function writeFrames(frames: readonly GuestFrame[]): void {
  // Supervisor stdout is frames only — never diagnostics, never prompts.
  for (const frame of frames) {
    const line = JSON.stringify(frame) + "\n";
    pendingWriterBytes += Buffer.byteLength(line, "utf8");
    const ok = process.stdout.write(line, () => {
      pendingWriterBytes = Math.max(0, pendingWriterBytes - Buffer.byteLength(line, "utf8"));
    });
    if (ok) {
      writerBlockedSinceMs = null;
    } else if (writerBlockedSinceMs === null) {
      writerBlockedSinceMs = now();
    }
  }
}

function exitWith(code: number): void {
  // Small deferred exit lets the pipe flush the final frames.
  if (exiting) return;
  exiting = true;
  setTimeout(() => process.exit(code), FLUSH_EXIT_DELAY_MS);
}

// Sustained writer blockage initiates cleanup (design output-bounds rule):
// if the host stops draining for > 2 s while a large queue is pending, the
// supervisor stops its groups and exits instead of growing memory.
const blockageTicker = setInterval(() => {
  const blockedFor = writerBlockedSinceMs === null ? 0 : now() - writerBlockedSinceMs;
  if (blockedFor > WRITER_BLOCKAGE_LIMIT_MS && pendingWriterBytes > GUEST_WRITER_QUEUE_LIMIT_BYTES) {
    clearInterval(blockageTicker);
    clearInterval(ticker);
    processTable.stopAll(true);
    writeFrames([
      {
        type: "error",
        seq: core.allocateSeq(),
        session_id: core.session?.session_id ?? null,
        generation: core.session?.generation ?? null,
        code: "LOG_BACKPRESSURE",
        message: "supervisor writer queue blocked beyond the bounded window",
      },
    ]);
    exitWith(1);
  }
  if (pendingWriterBytes === 0) writerBlockedSinceMs = null;
}, WRITER_BLOCKAGE_CHECK_MS);

function apply(transition: ReturnType<SupervisorCore["advance"]>): void {
  writeFrames(transition.frames);
  for (const dispatch of transition.dispatches) {
    if (dispatch.kind === "start_process") processTable.start(dispatch.frame);
    else if (dispatch.kind === "stop_process") processTable.stop(dispatch.frame.process_id);
    else if (dispatch.kind === "shutdown") {
      // Bounded shutdown: stop all groups (grace -> force), ack, exit.
      processTable.requestShutdown(() => exitWith(0));
    }
  }
  if (transition.exit_requested) {
    // Lease expiry / protocol failure: stop every managed group forcefully
    // (bounded) and exit within the 5 s deadline even if descendants resist.
    processTable.stopAll(true);
    const code = transition.phase === "failed" || transition.phase === "expired" ? 1 : 0;
    exitWith(code);
  }
}

/** The one process-creation seam of the guest bundle (container entrypoint only). */
function spawnManaged(args: { command: string; cwd: string; env: Record<string, string> }): GuestSpawnedProcess {
  const child = spawn("/bin/sh", ["-c", args.command], {
    cwd: args.cwd,
    env: args.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    pid: child.pid ?? 0,
    pgid: child.pid ?? 0,
    onStdout: (listener) => child.stdout?.on("data", (chunk: Buffer) => listener(chunk)),
    onStderr: (listener) => child.stderr?.on("data", (chunk: Buffer) => listener(chunk)),
    onExit: (listener) =>
      child.on("exit", (code, signal) => listener(code, signal ?? null)),
    onClose: (listener) =>
      child.on("close", (code, signal) => listener(code, signal ?? null)),
    signalGroup: (signal) => {
      if (child.pid === undefined || child.pid === 0) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // Group already gone.
      }
    },
    groupAlive: () => {
      if (child.pid === undefined || child.pid === 0) return false;
      try {
        // Signal 0: existence probe for ANY member of the group.
        process.kill(-child.pid, 0);
        return true;
      } catch {
        return false;
      }
    },
  };
}

const processTable = new GuestProcessTable({
  spawn: spawnManaged,
  now,
  seq: () => core.allocateSeq(),
  emit: (frame) => writeFrames([frame]),
  timer: {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
  },
  inventoryGroups,
});

/**
 * P5.9 group-escape inventory (design "Stop / Cleanup"): enumerate the POSIX
 * process groups alive on the guest so a stop can never be confirmed while a
 * setsid/daemonized descendant survived outside the managed groups. The probe
 * is one /bin/sh -c invocation reading /proc (a container-internal
 * diagnostic; no host/network surface). The supervisor's own group is
 * reported separately so the pure table can exclude init, the supervisor and
 * the probe itself. A failed/timed-out probe reports null (ambiguity,
 * fail closed).
 */
function inventoryGroups(done: (result: { pgids: number[]; selfPgid: number | null } | null) => void): void {
  const script =
    "for f in /proc/[0-9]*/stat; do l=$(cat \"$f\" 2>/dev/null) || continue; l=${l#*) }; set -- $l; echo \"$3\"; done; " +
    `l=$(cat /proc/${process.pid}/stat 2>/dev/null); l=\${l#*) }; set -- $l; echo "S $3"`;
  let settled = false;
  const finish = (result: { pgids: number[]; selfPgid: number | null } | null): void => {
    if (settled) return;
    settled = true;
    done(result);
  };
  let probe: ReturnType<typeof spawn> | null = null;
  const timer = setTimeout(() => {
    try { probe?.kill("SIGKILL"); } catch { /* already gone */ }
    finish(null);
  }, INVENTORY_PROBE_TIMEOUT_MS);
  try {
    probe = spawn("/bin/sh", ["-c", script], {
      env: { PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    clearTimeout(timer);
    finish(null);
    return;
  }
  let out = "";
  probe.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
  probe.on("error", () => { clearTimeout(timer); finish(null); });
  probe.on("close", (code) => {
    clearTimeout(timer);
    if (code !== 0) { finish(null); return; }
    let selfPgid: number | null = null;
    const pgids: number[] = [];
    for (const line of out.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("S ")) {
        const value = Number(trimmed.slice(2));
        if (Number.isInteger(value) && value > 0) selfPgid = value;
        continue;
      }
      const value = Number(trimmed);
      if (Number.isInteger(value) && value > 0) pgids.push(value);
    }
    finish({ pgids, selfPgid });
  });
}
processTable.useDecoderFactory({ create: () => new StringDecoder("utf8") });

// -- outbound clock -----------------------------------------------------------

// Boot: emit hello and start the guest monotonic 15 s lease before the ticker
// starts enforcing it (the adapter never skips boot).
apply(core.boot(now()));

const ticker = setInterval(() => apply(core.advance(now())), TICK_MS);

// -- inbound host frames ------------------------------------------------------

function handleRawLine(line: string): void {
  const byteLength = Buffer.byteLength(line, "utf8");
  let parsed: unknown;
  let type: string | null = null;
  let jsonOk = true;
  try {
    parsed = JSON.parse(line);
    if (typeof parsed === "object" && parsed !== null && "type" in parsed) {
      type = String((parsed as { type: unknown }).type);
    }
  } catch {
    jsonOk = false;
  }
  if (!jsonOk || checkFrameByteLimit(byteLength, type) === "oversized") {
    // Malformed or oversized: the core fails closed (PROTOCOL_FAILED error
    // frame + exit request). The host is still attached to receive it.
    apply(core.handleHostFrame(null, now()));
    return;
  }
  apply(core.handleHostFrame(parsed, now()));
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", handleRawLine);
lines.on("close", () => {
  clearInterval(ticker);
  clearInterval(blockageTicker);
  // Host pipe closed: stop every managed group (force, bounded) and exit
  // promptly. The lease covers a delayed/surviving helper as well.
  processTable.stopAll(true);
  const transition = core.notifyEof();
  writeFrames(transition.frames);
  // Host pipe closed: nothing abnormal was observed by the guest itself, so
  // the supervisor exits 0; failure paths exit 1.
  exitWith(0);
});

// Container stop path (docker stop -> docker-init -> SIGTERM). Stop all
// managed groups (bounded force) and exit within the deadline.
process.on("SIGTERM", () => {
  clearInterval(ticker);
  clearInterval(blockageTicker);
  processTable.stopAll(true);
  exitWith(0);
});
