// P5.6 main journal — deterministic unit tests (no Docker, no timers): seq and
// monotonic stamping, identity fencing, trace-coherence invariants, chunk-
// spanning redaction BEFORE storage (no raw duplicate anywhere), per-stream
// transcripts, bounds (per-process output, session journal, lifecycle reserve,
// sealing) and bounded replay pages.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionJournal } from "../src/journal.ts";
import { JOURNAL_POLICY } from "../src/policy.ts";
import type { ProviderEvent } from "../src/providers/execution-provider.ts";
import type { RuntimeEvent } from "../src/protocol.ts";
import type { SessionJournal as SessionJournalType } from "../src/journal.ts";

const SESSION = "sess-p56-unit";
const PROVENANCE = {
  course_id: "C01",
  lesson_id: "C01-L056",
  scene_id: "C01-L056-S001",
  beat_id: "C01-L056-S001-B001",
} as const;

function newJournal(secrets: string[] = []): SessionJournalType {
  let tick = 0;
  return new SessionJournal({ session_id: SESSION, generation: 1, secrets, nowMs: () => (tick += 5) });
}

function baseEvent(partial: Partial<ProviderEvent> & { type: ProviderEvent["type"]; payload: unknown }): ProviderEvent {
  return {
    runtime_event_version: 1,
    session_id: SESSION,
    generation: 1,
    operation_id: "op-1",
    attempt_id: "att-1",
    course_id: PROVENANCE.course_id,
    lesson_id: PROVENANCE.lesson_id,
    scene_id: PROVENANCE.scene_id,
    beat_id: PROVENANCE.beat_id,
    process_id: null,
    ...partial,
  } as ProviderEvent;
}

function accepted(processId: string, opId = "op-1", attemptId = "att-1"): ProviderEvent {
  return baseEvent({ type: "operation.accepted", payload: {}, operation_id: opId, attempt_id: attemptId, process_id: processId });
}

function started(processId: string | null, opId = "op-1", attemptId = "att-1"): ProviderEvent {
  return baseEvent({ type: "process.started", payload: {}, operation_id: opId, attempt_id: attemptId, process_id: processId });
}

function output(processId: string | null, text: string, stream: "stdout" | "stderr" = "stdout", offset = 0, opId = "op-1", attemptId = "att-1"): ProviderEvent {
  return baseEvent({ type: "process.output", payload: { stream, text, stream_offset: offset }, operation_id: opId, attempt_id: attemptId, process_id: processId });
}

function exited(processId: string | null, exitCode: number | null, attemptId = "att-1"): ProviderEvent {
  return baseEvent({ type: "process.exited", payload: { exit_code: exitCode, signal: null, duration_ms: 5 }, attempt_id: attemptId, process_id: processId });
}

function storedText(journal: SessionJournalType, processId: string): { stdout: string; stderr: string } {
  const transcript = journal.transcript(processId);
  return { stdout: transcript.stdout, stderr: transcript.stderr };
}

describe("P5.6 journal: stamping, identity fencing, coherence", () => {
  it("assigns strictly increasing journal seq and host monotonic stamps; stores frozen immutable events", () => {
    const journal = newJournal();
    const seen: RuntimeEvent[] = [];
    journal.subscribe((event) => seen.push(event));
    assert.equal(journal.ingest(accepted("p1")).ok, true);
    assert.equal(journal.ingest(started("p1")).ok, true);
    const out = journal.ingest(output("p1", "hello\n"));
    assert.ok(out.ok && out.event !== null);
    assert.equal(out.event.seq, 3);
    assert.equal(out.event.monotonic_ms, 15, "injected host clock, strictly after prior stamps (5/10/15)");
    assert.equal(out.event.process_id, "p1");
    assert.equal(Object.isFrozen(out.event), true, "stored events are immutable");
    assert.equal(Object.isFrozen(out.event.payload), true);
    assert.deepEqual(seen.map((e) => e.seq), [1, 2, 3], "subscribers receive every stamped event in order");
    const status = journal.status();
    assert.equal(status.high_seq, 3);
    assert.equal(status.event_count, 3);
    assert.ok(status.journal_bytes > 0);
    assert.equal(status.sealed, null);
  });

  it("rejects events of another session/generation with STALE_SESSION (no cross-generation bleed)", () => {
    const journal = newJournal();
    const stale = baseEvent({ session_id: "sess-other", type: "runtime.closing", payload: { cause: "reset" }, operation_id: null, attempt_id: null });
    const result = journal.ingest(stale);
    assert.ok(!result.ok && result.code === "STALE_SESSION");
    const staleGen = baseEvent({ generation: 2, type: "runtime.closing", payload: { cause: "reset" }, operation_id: null, attempt_id: null });
    assert.ok(!journal.ingest(staleGen).ok);
    assert.equal(journal.status().event_count, 0, "nothing from a foreign identity was stored");
  });

  it("rejects schema-violating events with PROTOCOL_FAILED (unknown payload keys, broken provenance)", () => {
    const journal = newJournal();
    const badPayload = baseEvent({ type: "process.started", payload: { extra: true }, process_id: "p1" });
    assert.ok(!journal.ingest(badPayload).ok);
    const sessionWithOperation = baseEvent({ type: "runtime.closing", payload: { cause: "reset" }, operation_id: "op-1", attempt_id: "att-1" });
    const r1 = journal.ingest(sessionWithOperation);
    assert.ok(!r1.ok && r1.code === "PROTOCOL_FAILED", "runtime.* must use null operation provenance");
    const operationWithoutIds = baseEvent({ type: "operation.accepted", payload: {}, operation_id: null, attempt_id: null });
    const r2 = journal.ingest(operationWithoutIds);
    assert.ok(!r2.ok && r2.code === "PROTOCOL_FAILED", "operation.* must carry non-null identity");
  });

  it("enforces 'Started precedes buffered output' — output for a never-started process is rejected", () => {
    const journal = newJournal();
    journal.ingest(accepted("p1"));
    const early = journal.ingest(output("p1", "early\n"));
    assert.ok(!early.ok && early.code === "PROTOCOL_FAILED");
    assert.equal(journal.status().event_count, 1, "the rejected event was never stored");
    assert.equal(journal.ingest(started("p1")).ok, true);
    assert.equal(journal.ingest(output("p1", "after start\n")).ok, true);
    assert.equal(journal.status().event_count, 3);
  });

  it("foreground (null process_id) output is journaled after its own started event", () => {
    const journal = newJournal();
    assert.equal(journal.ingest(started(null)).ok, true, "the foreground started event carries process_id null");
    const out = journal.ingest(output(null, "fg output\n"));
    assert.ok(out.ok && out.event !== null);
    assert.equal(out.event.process_id, null, "foreground process_id stays null");
    assert.equal(journal.transcript(null).stdout, "fg output\n");
  });

  it("one immutable final result: a second operation.completed for the same operation/attempt is rejected", () => {
    const journal = newJournal();
    journal.ingest(accepted("p1"));
    const completed = baseEvent({ type: "operation.completed", payload: { outcome: "PASS", reason: null, exit_code: 0, forced: false }, process_id: "p1" });
    assert.equal(journal.ingest(completed).ok, true);
    const duplicate = journal.ingest(completed);
    assert.ok(!duplicate.ok && duplicate.code === "PROTOCOL_FAILED");
    assert.ok(!journal.ingest(completed).ok, "still rejected after the first rejection");
  });

  it("rejects empty output chunks", () => {
    const journal = newJournal();
    journal.ingest(accepted("p1"));
    journal.ingest(started("p1"));
    const empty = journal.ingest(output("p1", ""));
    assert.ok(!empty.ok && empty.code === "PROTOCOL_FAILED");
  });
});

describe("P5.6 journal: redaction before disk/IPC (chunk-spanning, no raw duplicate)", () => {
  it("redacts a whole secret inside one chunk; the raw value never appears in stored events or snapshots", () => {
    const SECRET = "sk-FAKE-p56-9f2c81";
    const journal = newJournal([SECRET]);
    journal.ingest(accepted("p1"));
    journal.ingest(started("p1"));
    assert.equal(journal.ingest(output("p1", `token=${SECRET}\nall good\n`)).ok, true);
    assert.equal(journal.ingest(exited("p1", 0)).ok, true, "the terminal event flushes the held raw tail first");
    const page = journal.snapshot(0);
    const serialized = JSON.stringify(page);
    assert.equal(serialized.includes(SECRET), false, "no raw secret anywhere in the journal page");
    assert.ok(serialized.includes(JOURNAL_POLICY.redaction_marker));
    const transcript = storedText(journal, "p1").stdout;
    assert.equal(transcript, "token=[REDACTED]\nall good\n", "redacted text is coherent, order preserved");
    assert.equal(journal.pendingHolds(), 0, "no holdback residue after the flush");
  });

  it("redacts a secret split across two consecutive chunks (chunk-spanning), flushing before the terminal event", () => {
    const SECRET = "AAABBB123";
    const journal = newJournal([SECRET]);
    journal.ingest(accepted("p1"));
    journal.ingest(started("p1"));
    // Chunk 1 ends mid-secret; chunk 2 completes it. The suffix-prefix
    // holdback keeps the raw "sk-"-like prefix unemitted until the secret is
    // completed (chunk 2) or the process's terminal event flushes it.
    const first = journal.ingest(output("p1", "tok=AAA", "stdout", 0));
    assert.ok(first.ok && first.event !== null, "the secret-free prefix is emitted immediately");
    assert.ok(first.event !== null && (first.event.payload as { text: string }).text === "tok=");
    const second = journal.ingest(output("p1", "BBB123\n", "stdout", 7));
    assert.ok(second.ok && second.event !== null, "the completed secret is redacted on arrival");
    assert.ok(second.event !== null && (second.event.payload as { text: string }).text === "[REDACTED]\n");
    // A terminal event flushes the held tail BEFORE the death fact is stored.
    assert.equal(journal.ingest(exited("p1", 0)).ok, true);
    const page = journal.snapshot(0);
    const serialized = JSON.stringify(page);
    assert.equal(serialized.includes(SECRET), false, "no raw duplicate of the spanning secret anywhere in the journal");
    assert.equal(serialized.includes("BBB123"), false);
    const transcript = storedText(journal, "p1").stdout;
    assert.equal(transcript, "tok=[REDACTED]\n", "redacted text is coherent, order preserved");
    // The flushed output event precedes the exited event in journal order.
    const events = page.events.filter((e) => e.process_id === "p1");
    const types = events.map((e) => e.type);
    assert.ok(types.indexOf("process.output") < types.indexOf("process.exited"), "flushed output precedes the terminal event");
    assert.equal(journal.pendingHolds(), 0);
  });

  it("a secret that is a suffix-extension of another is matched longest-first (no raw tail leak)", () => {
    const journal = newJournal(["ab", "abcd"]);
    journal.ingest(accepted("p1"));
    journal.ingest(started("p1"));
    const result = journal.ingest(output("p1", "xabcdy", "stdout", 0));
    assert.ok(result.ok && result.event !== null, "one chunk, redacted on arrival");
    assert.ok(result.event !== null && (result.event.payload as { text: string }).text === "x[REDACTED]y", "one longest-match span, no partial raw emission");
    assert.equal(journal.ingest(exited("p1", 0)).ok, true);
    assert.equal(storedText(journal, "p1").stdout, "x[REDACTED]y");
  });

  it("rejects invalid secret registrations (empty, oversized, the marker itself)", () => {
    assert.throws(() => newJournal([""]));
    assert.throws(() => newJournal(["x".repeat(JOURNAL_POLICY.secret_max_chars + 1)]));
    assert.throws(() => newJournal([JOURNAL_POLICY.redaction_marker]));
  });

  it("without registered secrets output passes through unmodified with exact offsets", () => {
    const journal = newJournal();
    journal.ingest(accepted("p1"));
    journal.ingest(started("p1"));
    const result = journal.ingest(output("p1", "plain text\n", "stdout", 11));
    assert.ok(result.ok && result.event !== null);
    assert.equal((result.event!.payload as { stream_offset: number }).stream_offset, 11, "offsets pass through when nothing is held");
    assert.equal(storedText(journal, "p1").stdout, "plain text\n");
  });
});

describe("P5.6 journal: per-stream order, offsets and transcripts", () => {
  it("keeps stdout and stderr independent with monotonic per-stream offsets; never blended", () => {
    const journal = newJournal();
    journal.ingest(accepted("p1"));
    journal.ingest(started("p1"));
    journal.ingest(output("p1", "out-1\n", "stdout", 0));
    journal.ingest(output("p1", "err-1\n", "stderr", 0));
    journal.ingest(output("p1", "out-2\n", "stdout", 6));
    journal.ingest(output("p1", "err-2\n", "stderr", 6));
    const transcript = journal.transcript("p1");
    assert.deepEqual(transcript.stdout_offsets, [0, 6]);
    assert.deepEqual(transcript.stderr_offsets, [0, 6]);
    assert.equal(transcript.stdout, "out-1\nout-2\n");
    assert.equal(transcript.stderr, "err-1\nerr-2\n");
    const events = journal.snapshot(0).events.filter((e) => e.type === "process.output");
    const stdoutText = events.filter((e) => (e.payload as { stream: string }).stream === "stdout").map((e) => (e.payload as { text: string }).text);
    assert.deepEqual(stdoutText, ["out-1\n", "out-2\n"], "stdout order preserved in the global journal");
  });

  it("holds only the partial-secret suffix; ordinary output is never delayed; flushed tails are redacted", () => {
    const journal = newJournal(["S3CRETVALUE"]);
    journal.ingest(accepted("p1"));
    journal.ingest(started("p1"));
    const first = journal.ingest(output("p1", "abc", "stdout", 0));
    assert.ok(first.ok && first.event !== null, "no partial match at the boundary: output is emitted immediately");
    assert.ok(first.event !== null && (first.event.payload as { text: string }).text === "abc");
    const second = journal.ingest(output("p1", "S3CRETVAL", "stdout", 3));
    assert.ok(second.ok && second.event === null, "the whole chunk is a proper prefix of the secret: fully held");
    const third = journal.ingest(output("p1", "UE tail\n", "stdout", 12));
    assert.ok(third.ok && third.event !== null, "the completed secret is redacted on arrival");
    assert.ok(third.event !== null && (third.event.payload as { text: string }).text === "[REDACTED] tail\n");
    assert.equal((third.event!.payload as { stream_offset: number }).stream_offset, 3, "emission offset = raw offset of the emitted chunk");
    assert.equal(storedText(journal, "p1").stdout, "abc[REDACTED] tail\n", "redaction before storage, order preserved");
    assert.equal(journal.pendingHolds(), 0, "no holdback residue after a completed match");
    const offsets = journal.transcript("p1").stdout_offsets;
    assert.deepEqual(offsets, [0, 3], "raw-stream offsets are monotonic and raw-true");
  });
});

describe("P5.6 journal: bounds (no silent drops, lifecycle reserve, sealing)", () => {
  it("rejects output beyond the per-process decoded bound with OUTPUT_LIMIT", () => {
    const journal = newJournal();
    journal.ingest(accepted("p1"));
    journal.ingest(started("p1"));
    const big = "x".repeat(JOURNAL_POLICY.per_process_output_bytes - 10);
    assert.equal(journal.ingest(output("p1", big)).ok, true);
    const overflow = journal.ingest(output("p1", "0123456789abc", "stdout", big.length));
    assert.ok(!overflow.ok && overflow.code === "OUTPUT_LIMIT");
    assert.equal(journal.status().sealed, null, "a per-process overflow is not a journal seal (the caller owns teardown)");
  });

  it("output is refused at the reserved budget while error capacity still works; the journal seals past the session bound", () => {
    const journal = newJournal();
    const chunkSize = 1_000_000;
    for (let i = 0; ; i += 1) {
      const processId = `p${i}`;
      assert.equal(journal.ingest(accepted(processId, `op-${i}`, `att-${i}`)).ok, true);
      assert.equal(journal.ingest(started(processId, `op-${i}`, `att-${i}`)).ok, true);
      const result = journal.ingest(output(processId, "y".repeat(chunkSize), "stdout", 0, `op-${i}`, `att-${i}`));
      if (!result.ok) {
        assert.equal(result.code, "LOG_BACKPRESSURE", "output overflow is LOG_BACKPRESSURE");
        break;
      }
      assert.ok(i < 40, "the output budget must be reachable");
    }
    const afterOutputStop = journal.status();
    assert.ok(
      afterOutputStop.journal_bytes <= JOURNAL_POLICY.session_limit_bytes - JOURNAL_POLICY.lifecycle_reserve_bytes + chunkSize,
      "output stops inside the reserved budget",
    );
    const fail = baseEvent({ type: "runtime.failed", payload: { code: "LOG_BACKPRESSURE", message: "output budget exhausted" }, operation_id: null, attempt_id: null });
    assert.equal(journal.ingest(fail).ok, true, "the reserved lifecycle/error capacity still accepts the failure event");
    let sealed = false;
    for (let i = 0; i < 20_000 && !sealed; i += 1) {
      const closed = baseEvent({ type: "runtime.closed", payload: { cleanup_status: "confirmed" }, operation_id: null, attempt_id: null });
      const result = journal.ingest(closed);
      if (!result.ok) {
        sealed = true;
        assert.equal(result.code, "LOG_BACKPRESSURE");
      }
    }
    assert.equal(sealed, true, "the full session bound is enforceable");
    assert.ok(journal.status().sealed !== null, "the journal sealed itself past the session bound");
    const later = baseEvent({ type: "runtime.closing", payload: { cause: "failure" }, operation_id: null, attempt_id: null });
    const rejected = journal.ingest(later);
    assert.ok(!rejected.ok && rejected.code === "LOG_BACKPRESSURE", "a sealed journal rejects loudly (no silent drops)");
  });
});

describe("P5.6 journal: bounded replay pages", () => {
  it("caps pages at 256 events and continues from the page cursor", () => {
    const journal = newJournal();
    for (let i = 0; i < 300; i += 1) {
      assert.equal(journal.ingest(accepted(`p${i}`, `op-${i}`, `att-${i}`)).ok, true);
    }
    const page1 = journal.snapshot(0);
    assert.equal(page1.events.length, JOURNAL_POLICY.snapshot_max_events);
    assert.equal(page1.journal_high_seq, 300);
    assert.equal(page1.reset, false);
    assert.equal(page1.page_end_seq, 256);
    const page2 = journal.snapshot(page1.page_end_seq);
    assert.equal(page2.events.length, 44);
    assert.equal(page2.events[0]!.seq, 257);
    assert.equal(page2.page_end_seq, 300);
    const page3 = journal.snapshot(300);
    assert.equal(page3.events.length, 0);
    assert.equal(page3.reset, false, "the cursor at the high-water mark is a normal empty page");
  });

  it("never returns more than 256 KiB of events per page and always makes progress", () => {
    const journal = newJournal();
    journal.ingest(accepted("p1"));
    journal.ingest(started("p1"));
    for (let i = 0; i < 40; i += 1) {
      assert.equal(journal.ingest(output("p1", "z".repeat(14_000), "stdout", i * 14_000)).ok, true);
    }
    const page = journal.snapshot(0);
    const bytes = page.events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event), "utf8"), 0);
    assert.ok(bytes <= JOURNAL_POLICY.snapshot_max_bytes, `page bytes ${bytes} within the 256 KiB bound`);
    assert.ok(page.events.length < 256, "the byte bound truncated the page before the count bound");
    assert.ok(page.page_end_seq > page.after_seq, "the page always makes progress");
    const next = journal.snapshot(page.page_end_seq);
    assert.ok(next.events.length > 0, "the continuation page exists");
  });

  it("a cursor beyond the journal high-water mark is an explicit snapshot-reset", () => {
    const journal = newJournal();
    journal.ingest(accepted("p1"));
    const page = journal.snapshot(99);
    assert.equal(page.reset, true);
    assert.equal(page.events.length, 0);
    assert.equal(page.page_end_seq, 1, "the reset page re-anchors at the journal high-water mark");
    assert.equal(page.journal_high_seq, 1);
  });

  it("pages round-trip through the canonical snapshot-page schema", () => {
    const journal = newJournal();
    journal.ingest(accepted("p1"));
    journal.ingest(started("p1"));
    const page = journal.snapshot(1);
    assert.equal(page.session_id, SESSION);
    assert.equal(page.generation, 1);
    assert.equal(page.runtime_event_version, 1);
  });
});
