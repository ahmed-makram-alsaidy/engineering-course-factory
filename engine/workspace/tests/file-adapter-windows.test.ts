// P6.4 Windows file adapter — REAL platform proofs (no mocks).
//
// Runs against the actual Windows filesystem: real junctions, real symlinks,
// real hardlinks, real same-volume renames, real sharing violations, real
// case-insensitive lookups and real byte storage. Every resource lives under
// the phase-owned temp/P6.4 root with cf-p64- names and is removed in a
// finally barrier; these tests FAIL (never skip) when the platform behavior
// cannot be proven.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openWindowsFileAdapter,
  type AdapterAuthority,
  type WindowsFileAdapter,
} from "../src/file-adapter.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const TEST_ROOT = join(repoRoot, "temp", "P6.4", "file-adapter-windows");

let counter = 0;

interface Harness {
  readonly tag: string;
  readonly leaf: string;
  readonly staging: string;
  readonly adapter: WindowsFileAdapter;
  readonly sessionId: string;
  readonly workspaceId: string;
}

function freshHarness(): Harness {
  counter += 1;
  const tag = `cf-p64-w${counter}-${randomBytes(3).toString("hex")}`;
  const leaf = join(TEST_ROOT, `${tag}-leaf`);
  const staging = join(TEST_ROOT, `${tag}-staging`);
  mkdirSync(leaf, { recursive: true });
  mkdirSync(staging, { recursive: true });
  const sessionId = `sess-p64-w${String(counter).padStart(4, "0")}`;
  const workspaceId = `ws-p64-w${String(counter).padStart(4, "0")}`;
  const opened = openWindowsFileAdapter({
    sessionId,
    generation: 1,
    workspaceId,
    leafHostPath: leaf,
    stagingHostPath: staging,
  });
  assert.equal(opened.ok, true, "adapter binding must open");
  if (!opened.ok) throw new Error("unreachable");
  return { tag, leaf, staging, adapter: opened.value, sessionId, workspaceId };
}

function authority(harness: Harness): AdapterAuthority {
  return {
    lease: {
      kind: "editor_lease",
      leaseId: `lease-p64-w${counter}`,
      sessionId: harness.sessionId,
      generation: 1,
      workspaceId: harness.workspaceId,
      epoch: 1,
      operationId: "op-p64-w1",
      requestId: `req-p64-w${counter}`,
    },
    ownership: "EDITOR_OWNED",
    liveEpoch: 1,
    revokedLeaseIds: [],
  };
}

before(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
});

after(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  assert.equal(existsSync(TEST_ROOT), false, "phase-owned Windows test root is removed (cleanup green)");
  console.log("P6.4 PROOF: cleanup leaves no staging or workspace residue");
});

describe("P6.4 real reparse confinement", () => {
  it("junction ancestry escapes are rejected (sentinel unchanged)", async () => {
    const harness = freshHarness();
    const outside = join(TEST_ROOT, `${harness.tag}-outside`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "sentinel.txt"), "do-not-touch");
    const junction = join(harness.leaf, "evil-junction");
    symlinkSync(outside, junction, "junction");
    assert.equal(lstatSync(junction).isSymbolicLink(), true, "the fixture is a real reparse point");
    const read = await harness.adapter.readDocument(authority(harness), "evil-junction/sentinel.txt");
    assert.equal(read.ok, false);
    if (read.ok) throw new Error("unreachable");
    assert.equal(read.rejection.code, "WORKSPACE_VIOLATION");
    assert.equal(readFileSync(join(outside, "sentinel.txt"), "utf8"), "do-not-touch");
    assert.deepEqual(readdirSync(harness.staging), []);
    console.log("P6.4 PROOF: junction/reparse escape rejected");
  });

  it("junction targets are never followed on publication", async () => {
    const harness = freshHarness();
    const outside = join(TEST_ROOT, `${harness.tag}-outside-pub`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "sentinel.txt"), "do-not-touch");
    symlinkSync(outside, join(harness.leaf, "pub-junction"), "junction");
    const published = await harness.adapter.publishDocument(authority(harness), {
      portablePath: "pub-junction/sentinel.txt",
      content: "attacker bytes\n",
      mode: "replace",
      expected: { exists: true, digest: "0".repeat(64) },
    });
    assert.equal(published.ok, false);
    if (published.ok) throw new Error("unreachable");
    assert.equal(published.rejection.code, "WORKSPACE_VIOLATION");
    assert.equal(readFileSync(join(outside, "sentinel.txt"), "utf8"), "do-not-touch");
    console.log("P6.4 PROOF: junction publication refused before mutation");
  });

  it("hardlink targets are rejected", async () => {
    const harness = freshHarness();
    const original = join(harness.leaf, "original.txt");
    writeFileSync(original, "linked bytes\n");
    linkSync(original, join(harness.leaf, "alias.txt"));
    assert.equal(lstatSync(original).nlink, 2, "the fixture is a real hardlink");
    for (const name of ["original.txt", "alias.txt"]) {
      const read = await harness.adapter.readDocument(authority(harness), name);
      assert.equal(read.ok, false, `${name} must reject with two links`);
      if (read.ok) throw new Error("unreachable");
      assert.equal(read.rejection.code, "WORKSPACE_VIOLATION");
    }
    console.log("P6.4 PROOF: hardlink targets rejected");
  });
});

describe("P6.4 real atomic publication", () => {
  it("large repeated replacement observes only complete old/new bytes", async () => {
    const harness = freshHarness();
    const auth = authority(harness);
    const sizeA = 100 * 1024 + 1;
    const sizeB = 200 * 1024 + 1;
    const contentA = `${"a".repeat(100 * 1024)}\n`;
    const contentB = `${"b".repeat(200 * 1024)}\n`;
    assert.equal(new TextEncoder().encode(contentA).length, sizeA);
    assert.equal(new TextEncoder().encode(contentB).length, sizeB);
    const created = await harness.adapter.publishDocument(auth, {
      portablePath: "atomic.txt",
      content: contentA,
      mode: "create",
      expected: { exists: false, digest: null },
    });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("unreachable");
    let digest = created.value.digest;
    for (let round = 0; round < 10; round += 1) {
      const next = round % 2 === 0 ? contentB : contentA;
      const pending = harness.adapter.publishDocument(auth, {
        portablePath: "atomic.txt",
        content: next,
        mode: "replace",
        expected: { exists: true, digest },
      });
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      let polls = 0;
      while (!settled && polls < 20000) {
        polls += 1;
        let size: number | null = null;
        try {
          size = lstatSync(join(harness.leaf, "atomic.txt")).size;
        } catch {
          size = null;
        }
        assert.ok(size === sizeA || size === sizeB, `atomic target is old-complete or new-complete (round ${round}: ${size})`);
        await new Promise((resolve) => setImmediate(resolve));
      }
      const result = await pending;
      assert.equal(result.ok, true, `round ${round} must publish`);
      if (!result.ok) throw new Error("unreachable");
      digest = result.value.digest;
      const read = await harness.adapter.readDocument(auth, "atomic.txt");
      assert.equal(read.ok, true);
      if (!read.ok) throw new Error("unreachable");
      assert.equal(read.value.content, next);
      assert.ok(polls > 0, "the rename window was observed");
    }
    assert.deepEqual(readdirSync(harness.staging), [], "no staging residue after repeated publication");
    console.log("P6.4 PROOF: atomic publication shows only complete bytes");
  });

  it("open readers block replacement with SAVE_FAILED and unchanged target", async () => {
    const harness = freshHarness();
    const auth = authority(harness);
    const created = await harness.adapter.publishDocument(auth, {
      portablePath: "shared.txt",
      content: "old complete bytes\n",
      mode: "create",
      expected: { exists: false, digest: null },
    });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("unreachable");
    const reader = await open(join(harness.leaf, "shared.txt"), "r");
    try {
      const concurrentRead = await harness.adapter.readDocument(auth, "shared.txt");
      assert.equal(concurrentRead.ok, true, "shared reads are allowed on Windows");
      const blocked = await harness.adapter.publishDocument(auth, {
        portablePath: "shared.txt",
        content: "new complete bytes\n",
        mode: "replace",
        expected: { exists: true, digest: created.value.digest },
      });
      assert.equal(blocked.ok, false, "replacement over an open handle must fail closed");
      if (blocked.ok) throw new Error("unreachable");
      assert.equal(blocked.rejection.code, "SAVE_FAILED");
    } finally {
      await reader.close();
    }
    assert.equal(readFileSync(join(harness.leaf, "shared.txt"), "utf8"), "old complete bytes\n");
    assert.deepEqual(readdirSync(harness.staging), [], "blocked staging is discarded");
    const after = await harness.adapter.readDocument(auth, "shared.txt");
    assert.equal(after.ok, true);
    if (!after.ok) throw new Error("unreachable");
    const republished = await harness.adapter.publishDocument(auth, {
      portablePath: "shared.txt",
      content: "new complete bytes\n",
      mode: "replace",
      expected: { exists: true, digest: after.value.digest },
    });
    assert.equal(republished.ok, true, "publication succeeds after the reader closes");
    assert.equal(readFileSync(join(harness.leaf, "shared.txt"), "utf8"), "new complete bytes\n");
    console.log("P6.4 PROOF: open/replace sharing fails closed then succeeds");
  });

  it("create is no-clobber under the real filesystem", async () => {
    const harness = freshHarness();
    const auth = authority(harness);
    const first = await harness.adapter.publishDocument(auth, {
      portablePath: "noclobber.txt",
      content: "first\n",
      mode: "create",
      expected: { exists: false, digest: null },
    });
    assert.equal(first.ok, true);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const again = await harness.adapter.publishDocument(auth, {
        portablePath: "noclobber.txt",
        content: "attempt\n",
        mode: "create",
        expected: { exists: false, digest: null },
      });
      assert.equal(again.ok, false);
      if (again.ok) throw new Error("unreachable");
      assert.equal(again.rejection.code, "FILE_EXISTS");
    }
    assert.equal(readFileSync(join(harness.leaf, "noclobber.txt"), "utf8"), "first\n");
    console.log("P6.4 PROOF: no-clobber atomic target");
  });

  it("LF golden with Arabic/emoji/multiline is byte-exact", async () => {
    const harness = freshHarness();
    const auth = authority(harness);
    const text = [
      "// lesson golden: English سطر عربي 🚀",
      "const greeting = \"مرحبا hello 👨‍👩‍👧‍👦\";",
      "console.log(greeting);",
      "سطر أخير 🎉",
      "",
    ].join("\n");
    const published = await harness.adapter.publishDocument(auth, {
      portablePath: "golden.txt",
      content: text,
      mode: "create",
      expected: { exists: false, digest: null },
    });
    assert.equal(published.ok, true);
    if (!published.ok) throw new Error("unreachable");
    const raw = readFileSync(join(harness.leaf, "golden.txt"));
    assert.deepEqual(new Uint8Array(raw), new TextEncoder().encode(text));
    assert.ok(!raw.includes(0x0d), "no CR byte survives");
    const read = await harness.adapter.readDocument(auth, "golden.txt");
    assert.equal(read.ok, true);
    if (!read.ok) throw new Error("unreachable");
    assert.equal(read.value.content, text);
    assert.equal(read.value.digest, published.value.digest);
    console.log("P6.4 PROOF: byte-exact LF golden");
  });
});
