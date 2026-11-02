// P5.5 host process registry — race-safe lifecycle tests. Pure state machine:
// no Docker, no timers, no frames. The prompt's required race matrix is
// covered here deterministically (explicit transitions, never sleeps):
//   two concurrent starts / duplicate reservation, stop during STARTING,
//   natural exit during STOPPING, duplicate guest exit frames, late output
//   after exit, heartbeat/dispose interaction, stale-tombstone stop, PID
//   privacy in the snapshot.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProcessRegistry } from "../src/registry.ts";

function newRegistry(): ProcessRegistry {
  return new ProcessRegistry("sess-p55-unit", 1);
}

const RESERVATION = {
  process_id: "dev_server",
  operation_id: "op-1",
  attempt_id: "att-1",
};

describe("P5.5 process registry: ownership + lifecycle", () => {
  it("reserve -> markStarted -> markStopping -> markExited is the happy lifecycle", () => {
    const registry = newRegistry();
    const reserved = registry.reserve(RESERVATION);
    assert.equal(reserved.ok, true);
    assert.equal(reserved.ok && reserved.entry.state, "STARTING");
    assert.equal(registry.markStarted("dev_server", 4242, 4242, 10), true);
    assert.equal(registry.markStopping("dev_server"), true);
    assert.equal(
      registry.markExited("dev_server", { exit_code: 0, signal: null, stopped: true, forced: false }, 20),
      true,
    );
    const entry = registry.get("dev_server");
    assert.equal(entry?.state, "EXITED");
    assert.equal(entry?.exit_code, 0);
    assert.equal(entry?.pid, 4242, "runtime pid stored privately");
  });

  it("two concurrent starts of the same process: the second is rejected atomically", () => {
    const registry = newRegistry();
    assert.equal(registry.reserve(RESERVATION).ok, true);
    const second = registry.reserve({ ...RESERVATION, attempt_id: "att-2", operation_id: "op-2" });
    assert.equal(second.ok, false);
    assert.ok(!second.ok && second.code === "DUPLICATE_START");
    assert.equal(registry.snapshot().length, 1, "no second registry entry");
  });

  it("an exited tombstone keeps ownership: restart in the same generation rejects", () => {
    const registry = newRegistry();
    registry.reserve(RESERVATION);
    registry.markStarted("dev_server", 1, 1, 0);
    registry.markExited("dev_server", { exit_code: 0, signal: null, stopped: false, forced: false }, 5);
    const restart = registry.reserve({ ...RESERVATION, attempt_id: "att-2", operation_id: "op-2" });
    assert.equal(restart.ok, false, "only reset (new generation) reuses a definition");
  });

  it("stop during STARTING latches; the ack still marks RUNNING and the latch survives", () => {
    const registry = newRegistry();
    registry.reserve(RESERVATION);
    assert.equal(registry.latchStop("dev_server"), true);
    assert.equal(registry.markStarted("dev_server", 7, 7, 1), true);
    const entry = registry.get("dev_server");
    assert.equal(entry?.state, "RUNNING");
    assert.equal(entry?.stopLatched, true, "the latched stop must be executed after the ack");
  });

  it("stop during STARTING then natural exit: the record goes straight to EXITED", () => {
    const registry = newRegistry();
    registry.reserve(RESERVATION);
    registry.latchStop("dev_server");
    assert.equal(
      registry.markExited("dev_server", { exit_code: 3, signal: null, stopped: false, forced: false }, 9),
      true,
    );
    const entry = registry.get("dev_server");
    assert.equal(entry?.state, "EXITED");
    assert.equal(entry?.exit_code, 3);
  });

  it("duplicate guest exit frames are idempotent: only the first death fact wins", () => {
    const registry = newRegistry();
    registry.reserve(RESERVATION);
    registry.markStarted("dev_server", 5, 5, 0);
    assert.equal(registry.markExited("dev_server", { exit_code: 2, signal: null, stopped: false, forced: false }, 1), true);
    assert.equal(registry.markExited("dev_server", { exit_code: 0, signal: null, stopped: true, forced: true }, 2), false);
    const entry = registry.get("dev_server");
    assert.equal(entry?.exit_code, 2, "the second (contradictory) exit frame is ignored");
    assert.equal(entry?.forced, false);
  });

  it("exit during STOPPING: STOPPING -> EXITED is legal and terminal", () => {
    const registry = newRegistry();
    registry.reserve(RESERVATION);
    registry.markStarted("dev_server", 9, 9, 0);
    registry.markStopping("dev_server");
    assert.equal(registry.markStopping("dev_server"), true, "markStopping is idempotent");
    assert.equal(registry.markExited("dev_server", { exit_code: null, signal: "SIGKILL", stopped: true, forced: true }, 5), true);
  });

  it("late output after exit is rejected; output while alive is accepted and counted", () => {
    const registry = newRegistry();
    registry.reserve(RESERVATION);
    registry.markStarted("dev_server", 3, 3, 0);
    assert.equal(registry.acceptOutput("dev_server"), true);
    registry.recordOutputBytes("dev_server", "stdout", 10);
    registry.recordOutputBytes("dev_server", "stderr", 4);
    registry.markExited("dev_server", { exit_code: 0, signal: null, stopped: false, forced: false }, 9);
    assert.equal(registry.acceptOutput("dev_server"), false, "no output after exit");
    assert.equal(registry.get("dev_server")?.output_bytes.stdout, 10);
  });

  it("unknown process output/exit/stop-latch are all rejected", () => {
    const registry = newRegistry();
    assert.equal(registry.acceptOutput("ghost"), false);
    assert.equal(registry.markExited("ghost", { exit_code: 0, signal: null, stopped: false, forced: false }, 1), false);
    assert.equal(registry.latchStop("ghost"), false);
    assert.equal(registry.markStarted("ghost", 1, 1, 1), false);
  });

  it("disposeAll turns live entries DISPOSED; isLive/liveEntries empty afterwards", () => {
    const registry = newRegistry();
    registry.reserve(RESERVATION);
    registry.markStarted("dev_server", 2, 2, 0);
    registry.reserve({ process_id: "worker", operation_id: "op-w", attempt_id: "att-w" });
    assert.equal(registry.liveEntries().length, 2);
    registry.disposeAll();
    assert.equal(registry.liveEntries().length, 0);
    assert.equal(registry.allDisposedOrExited(), true);
    assert.equal(registry.get("dev_server")?.state, "DISPOSED");
    assert.equal(registry.acceptOutput("dev_server"), false, "heartbeat/output after dispose is inert");
  });

  it("repeat stop of a stopped tombstone sees isLive false (no second signal)", () => {
    const registry = newRegistry();
    registry.reserve(RESERVATION);
    registry.markStarted("dev_server", 4, 4, 0);
    registry.markStopping("dev_server");
    registry.markExited("dev_server", { exit_code: 0, signal: "SIGINT", stopped: true, forced: false }, 8);
    assert.equal(registry.isLive("dev_server"), false);
  });

  it("the snapshot never exposes runtime PID/PGID", () => {
    const registry = newRegistry();
    registry.reserve(RESERVATION);
    registry.markStarted("dev_server", 111, 222, 0);
    for (const entry of registry.snapshot()) {
      assert.equal("pid" in entry, false);
      assert.equal("pgid" in entry, false);
    }
  });

  it("liveEntries excludes tombstones so cleanup targets only real work", () => {
    const registry = newRegistry();
    registry.reserve(RESERVATION);
    registry.markStarted("dev_server", 1, 1, 0);
    registry.markExited("dev_server", { exit_code: 0, signal: null, stopped: false, forced: false }, 1);
    registry.reserve({ process_id: "worker", operation_id: "op-w", attempt_id: "att-w" });
    registry.markStarted("worker", 2, 2, 1);
    const live = registry.liveEntries();
    assert.equal(live.length, 1);
    assert.equal(live[0]?.process_id, "worker");
  });
});
