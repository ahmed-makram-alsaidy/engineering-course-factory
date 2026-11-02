// P6.13 terminal interoperability — REAL Windows host byte-coherence proofs.
//
// Canonical task: P6-DESIGN-SPEC P6.13 (real Windows required: the actual
// Windows host workspace is the byte authority both engines share).
// Proves with the REAL NTFS leaf, the REAL adapter and the REAL
// coordinator/lifecycle that committed disk bytes are the only truth the
// terminal side can observe: old bytes before save, exact new bytes after
// save, pending creations absent before save, no partial typing on disk,
// multilingual byte-exactness and strict-profile rejection with zero
// mutation. Terminal-side observations flow through the admitted interop
// observation path; host truth is asserted with node:fs directly on the
// leaf (the same bytes a container bind would expose — the bind itself is
// proven by the gate-only Docker suite). Fixture IR is NEVER hand-authored.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  life,
  op,
  nextRequest,
  openHarness,
  rejectionCode,
  repoRoot,
  terminalRunForeground,
  terminalWatcher,
  type OpenHarness,
} from "./editor-terminal-interop-harness.ts";

const TEST_ROOT = join(repoRoot, "temp", "P6.13", "interop-windows");
const PREFIX = "cf-p613-";

function proof(message: string): void {
  console.log(`P6.13 PROOF: ${message}`);
}

function sidOf(harness: OpenHarness): { session_id: string; generation: number } {
  const described = harness.interop.describe();
  return { session_id: described.session_id, generation: described.generation };
}

before(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
});

after(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  assert.equal(existsSync(TEST_ROOT), false, "no phase temp workspaces remain");
  proof("CLEANUP phase temp workspaces removed");
});

describe("P6.13 real Windows byte coherence", () => {
  it("P6.13 PROOF: host disk holds old bytes until the verified save commits", async () => {
    const harness = openHarness({
      root: TEST_ROOT,
      tag: "windows-old-new",
      namePrefix: PREFIX,
      actions: [
        { action: { type: "file_open", path: "src/report.txt" } },
        { action: { type: "type_code", path: "src/report.txt", content: "new line\n" } },
        { action: { type: "replace_code", path: "src/report.txt", find: "old", replace: "OLDER" } },
        { action: { type: "file_save", path: "src/report.txt" } },
        terminalWatcher("watcher", "cat src/report.txt"),
      ],
      seedFiles: { "src/report.txt": "old line\n" },
      terminalModes: ["read_only"],
    });
    const { interop, ops, leaf } = harness;
    const [open, type, replace, save, watch] = ops as [string, string, string, string, string];
    const sid = sidOf(harness);
    const hostPath = join(leaf, "src", "report.txt");

    assert.equal((await interop.startWatcher(op(interop, watch, "watch"))).ok, true);
    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal(readFileSync(hostPath, "utf8"), "old line\n");
    assert.equal((await interop.runTypeDocument(op(interop, type, "type"))).ok, true);
    assert.equal(readFileSync(hostPath, "utf8"), "old line\n", "type install never touches disk");
    assert.equal((await interop.runReplaceDocument(op(interop, replace, "replace"))).ok, true);
    assert.equal(readFileSync(hostPath, "utf8"), "old line\n", "replace install never touches disk");

    const seen = await interop.observeCommitted({ ...sid, rel_path: "src/report.txt" });
    assert.equal(seen.ok, true);
    if (!seen.ok) throw new Error("unreachable");
    assert.equal(seen.value.stdout, "old line\n", "admitted observation sees committed bytes only");

    assert.equal((await interop.runSaveDocument(op(interop, save, "save"))).ok, true);
    assert.equal(readFileSync(hostPath, "utf8"), "OLDER line\nnew line\n");
    const after = await interop.observeCommitted({ ...sid, rel_path: "src/report.txt" });
    assert.equal(after.ok, true);
    if (!after.ok) throw new Error("unreachable");
    assert.equal(after.value.stdout, "OLDER line\nnew line\n");
    assert.equal((await interop.stopWatcher({ ...sid, operation_id: watch, request_id: nextRequest("stop") })).ok, true);
    await interop.closeSession(life(interop, "close"));
    proof("Windows: old bytes until save, exact new bytes after");
  });

  it("P6.13 PROOF: pending creation absent on host disk until save", async () => {
    const harness = openHarness({
      root: TEST_ROOT,
      tag: "windows-pending",
      namePrefix: PREFIX,
      actions: [
        { action: { type: "file_create", path: "src/new.txt" } },
        { action: { type: "type_code", path: "src/new.txt", content: "hello\n" } },
        { action: { type: "file_save", path: "src/new.txt" } },
      ],
      seedFiles: {},
      seedDirs: ["src"],
      terminalModes: [],
    });
    const { interop, ops, leaf } = harness;
    const [create, type, save] = ops as [string, string, string];
    const hostPath = join(leaf, "src", "new.txt");

    assert.equal((await interop.runCreateDocument(op(interop, create, "create"))).ok, true);
    assert.equal(existsSync(hostPath), false);
    assert.equal((await interop.runTypeDocument(op(interop, type, "type"))).ok, true);
    assert.equal(existsSync(hostPath), false, "typed staging never materializes");
    assert.equal((await interop.runSaveDocument(op(interop, save, "save"))).ok, true);
    assert.equal(readFileSync(hostPath, "utf8"), "hello\n");
    await interop.closeSession(life(interop, "close"));
    proof("Windows: pending absent until save, exact after");
  });

  it("P6.13 PROOF: large typing publishes atomically (old or new complete bytes only)", async () => {
    const big = `${"x".repeat(4096)}\n`.repeat(50);
    const harness = openHarness({
      root: TEST_ROOT,
      tag: "windows-large",
      namePrefix: PREFIX,
      actions: [
        { action: { type: "file_open", path: "src/big.txt" } },
        { action: { type: "type_code", path: "src/big.txt", content: big } },
        { action: { type: "file_save", path: "src/big.txt" } },
      ],
      seedFiles: { "src/big.txt": "small\n" },
      terminalModes: [],
    });
    const { interop, ops, leaf } = harness;
    const [open, type, save] = ops as [string, string, string];
    const hostPath = join(leaf, "src", "big.txt");

    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runTypeDocument(op(interop, type, "type"))).ok, true);
    assert.equal(readFileSync(hostPath, "utf8"), "small\n", "200 KiB of typing never lands partially");
    assert.equal((await interop.runSaveDocument(op(interop, save, "save"))).ok, true);
    assert.equal(readFileSync(hostPath, "utf8"), `small\n${big}`);
    await interop.closeSession(life(interop, "close"));
    proof("Windows: large save publishes complete bytes only");
  });

  it("P6.13 PROOF: multilingual bytes survive the full interop round trip", async () => {
    const seed = " Berne\n";
    const appended = " \n";
    const harness = openHarness({
      root: TEST_ROOT,
      tag: "windows-unicode",
      namePrefix: PREFIX,
      actions: [
        { action: { type: "file_open", path: "src/notes.txt" } },
        { action: { type: "type_code", path: "src/notes.txt", content: appended } },
        { action: { type: "file_save", path: "src/notes.txt" } },
        terminalRunForeground("cat src/notes.txt"),
      ],
      seedFiles: { "src/notes.txt": seed },
      terminalModes: ["read_only"],
    });
    const { interop, ops, leaf } = harness;
    const [open, type, save, read] = ops as [string, string, string, string];
    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runTypeDocument(op(interop, type, "type"))).ok, true);
    assert.equal((await interop.runSaveDocument(op(interop, save, "save"))).ok, true);
    assert.equal(readFileSync(join(leaf, "src", "notes.txt"), "utf8"), `${seed}${appended}`);
    const observed = await interop.terminalReadSaved(op(interop, read, "read"));
    assert.equal(observed.ok, true);
    if (!observed.ok) throw new Error("unreachable");
    assert.equal(observed.value.stdout, `${seed}${appended}`);
    await interop.closeSession(life(interop, "close"));
    proof("Windows: multilingual bytes exact end to end");
  });

  it("P6.13 PROOF: CRLF authored content rejects with zero disk mutation", async () => {
    const harness = openHarness({
      root: TEST_ROOT,
      tag: "windows-crlf",
      namePrefix: PREFIX,
      actions: [
        { action: { type: "file_open", path: "src/report.txt" } },
        { action: { type: "type_code", path: "src/report.txt", content: "bad\r\nline\n" } },
      ],
      seedFiles: { "src/report.txt": "good\n" },
      terminalModes: [],
    });
    const { interop, ops, leaf } = harness;
    const [open, type] = ops as [string, string];
    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    const typed = await interop.runTypeDocument(op(interop, type, "type"));
    assert.equal(typed.ok, false);
    assert.equal(rejectionCode(typed), "UNSUPPORTED_TEXT_PROFILE");
    assert.equal(readFileSync(join(leaf, "src", "report.txt"), "utf8"), "good\n", "rejected typing mutates nothing");
    assert.equal(interop.describe().dirty_buffers, 0);
    await interop.closeSession(life(interop, "close"));
    proof("Windows: strict LF profile enforced, zero mutation");
  });

  it("P6.13 PROOF: CRLF seed bytes never load and never convert", async () => {
    const harness = openHarness({
      root: TEST_ROOT,
      tag: "windows-crlf-seed",
      namePrefix: PREFIX,
      actions: [{ action: { type: "file_open", path: "src/report.txt" } }],
      seedFiles: { "src/report.txt": "crlf\r\nbytes\r\n" },
      terminalModes: [],
    });
    const { interop, ops, leaf } = harness;
    const [open] = ops as [string];
    const opened = await interop.runOpenDocument(op(interop, open, "open"));
    assert.equal(opened.ok, false);
    assert.equal(rejectionCode(opened), "UNSUPPORTED_TEXT_PROFILE");
    assert.equal(readFileSync(join(leaf, "src", "report.txt"), "utf8"), "crlf\r\nbytes\r\n", "on-disk bytes untouched");
    await interop.closeSession(life(interop, "close"));
    proof("Windows: CRLF seeds rejected without conversion");
  });
});
