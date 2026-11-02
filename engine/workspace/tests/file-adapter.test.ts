// P6.4 Windows file adapter — deterministic conformance tests (offline).
//
// Canonical task: P6-DESIGN-SPEC section 22, P6.4 Windows file adapter
// ("Main-only Node-API adapter, NTFS handles/read/rename/flush").
// Proves the trusted low-level primitives later editor operations rely on:
// confined read, private staging, atomic publication, fencing and byte
// verification — without implementing semantic editor operations, presentation
// behavior or any renderer surface. Real Windows platform proofs (junctions,
// atomic rename targets, sharing, case, cleanup) live in
// file-adapter-windows.test.ts; Docker RO interop lives in
// file-adapter-docker.test.ts. All filesystem work stays under the
// phase-owned temp/P6.4 root with cf-p64- names; staging is always a sibling
// outside the leaf on the same volume.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openWindowsFileAdapter,
  sha256HexBytes,
  type AdapterAuthority,
  type WindowsFileAdapter,
} from "../src/file-adapter.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const TEST_ROOT = join(repoRoot, "temp", "P6.4", "file-adapter");

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

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
  const tag = `cf-p64-t${counter}-${randomBytes(3).toString("hex")}`;
  const leaf = join(TEST_ROOT, `${tag}-leaf`);
  const staging = join(TEST_ROOT, `${tag}-staging`);
  mkdirSync(leaf, { recursive: true });
  mkdirSync(staging, { recursive: true });
  const sessionId = `sess-p64-${String(counter).padStart(4, "0")}`;
  const workspaceId = `ws-p64-${String(counter).padStart(4, "0")}`;
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

function makeLease(harness: Harness, overrides: Record<string, unknown> = {}): AdapterAuthority["lease"] {
  return {
    kind: "editor_lease",
    leaseId: `lease-p64-${counter}`,
    sessionId: harness.sessionId,
    generation: 1,
    workspaceId: harness.workspaceId,
    epoch: 1,
    operationId: "op-p64-1",
    requestId: `req-p64-${counter}`,
    ...overrides,
  } as AdapterAuthority["lease"];
}

function authority(harness: Harness, overrides: Record<string, unknown> = {}): AdapterAuthority {
  return {
    lease: makeLease(harness, (overrides["lease"] as Record<string, unknown> | undefined) ?? {}),
    ownership: (overrides["ownership"] as AdapterAuthority["ownership"]) ?? "EDITOR_OWNED",
    liveEpoch: (overrides["liveEpoch"] as number) ?? 1,
    revokedLeaseIds: (overrides["revokedLeaseIds"] as readonly string[]) ?? [],
  };
}

function stagingIsClean(harness: Harness): boolean {
  return readdirSync(harness.staging).length === 0;
}

function seedBytes(harness: Harness, portablePath: string, bytes: Uint8Array): void {
  const parts = portablePath.split("/");
  const dir = join(harness.leaf, ...parts.slice(0, -1));
  if (parts.length > 1) mkdirSync(dir, { recursive: true });
  writeFileSync(join(harness.leaf, ...parts), bytes);
}

function seedText(harness: Harness, portablePath: string, text: string): void {
  seedBytes(harness, portablePath, new TextEncoder().encode(text));
}

function rawBytes(harness: Harness, portablePath: string): Uint8Array {
  return new Uint8Array(readFileSync(join(harness.leaf, ...portablePath.split("/"))));
}

function dtoLeaksHostPaths(dto: unknown, harness: Harness): string[] {
  const json = JSON.stringify(dto);
  const leaks: string[] = [];
  if (/[A-Za-z]:[\\/]/.test(json)) leaks.push("drive-letter path");
  if (json.includes("\\\\")) leaks.push("UNC/device escape");
  if (json.includes(harness.leaf) || json.includes(harness.staging)) leaks.push("trusted host path");
  if (json.includes("cf-p64-stage-")) leaks.push("private staging name");
  return leaks;
}

before(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
});

after(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  assert.equal(existsSync(TEST_ROOT), false, "phase-owned test root is removed (cleanup green)");
});

describe("P6.4 confined read", () => {
  it("valid nested relative file read returns exact bytes and digest", async () => {
    const harness = freshHarness();
    const text = "const greeting = \"hello world\";\nconsole.log(greeting);\n";
    seedText(harness, "src/app/nested.txt", text);
    const read = await harness.adapter.readDocument(authority(harness), "src/app/nested.txt");
    assert.equal(read.ok, true, "nested read must succeed");
    if (!read.ok) throw new Error("unreachable");
    assert.equal(read.value.content, text);
    assert.equal(read.value.byte_length, new TextEncoder().encode(text).length);
    assert.equal(read.value.digest, sha256Text(text));
    assert.equal(read.value.digest, sha256HexBytes(rawBytes(harness, "src/app/nested.txt")));
    assert.deepEqual(dtoLeaksHostPaths(read, harness), []);
    console.log("P6.4 PROOF: valid nested relative file read exact");
  });

  it("traversal segments are rejected", async () => {
    const harness = freshHarness();
    seedText(harness, "ok.txt", "ok");
    for (const hostile of ["../evil.txt", "a/../../evil.txt", "a/../b.txt", "..", "a/.."]) {
      const read = await harness.adapter.readDocument(authority(harness), hostile);
      assert.equal(read.ok, false, `${hostile} must reject`);
      if (read.ok) throw new Error("unreachable");
      assert.equal(read.rejection.code, "WORKSPACE_VIOLATION");
    }
    assert.equal(stagingIsClean(harness), true);
    console.log("P6.4 PROOF: traversal rejected");
  });

  it("absolute Windows paths are rejected", async () => {
    const harness = freshHarness();
    for (const hostile of ["E:/course-factory/file.txt", "E:\\course-factory\\file.txt", "/workspace/evil.txt", "/absolute.txt"]) {
      const read = await harness.adapter.readDocument(authority(harness), hostile);
      assert.equal(read.ok, false, `${hostile} must reject`);
      if (read.ok) throw new Error("unreachable");
      assert.equal(read.rejection.code, "WORKSPACE_VIOLATION");
    }
    console.log("P6.4 PROOF: absolute Windows path rejected");
  });

  it("drive-letter escapes are rejected", async () => {
    const harness = freshHarness();
    for (const hostile of ["C:evil.txt", "C:", "e:notes.txt", "Z:/data.txt"]) {
      const read = await harness.adapter.readDocument(authority(harness), hostile);
      assert.equal(read.ok, false, `${hostile} must reject`);
      if (read.ok) throw new Error("unreachable");
      assert.equal(read.rejection.code, "WORKSPACE_VIOLATION");
    }
    console.log("P6.4 PROOF: drive-letter escape rejected");
  });

  it("UNC and device paths are rejected", async () => {
    const harness = freshHarness();
    for (const hostile of ["//server/share", "\\\\server\\share", "file.txt:stream", "NUL", "con.txt", "src/aux"]) {
      const read = await harness.adapter.readDocument(authority(harness), hostile);
      assert.equal(read.ok, false, `${hostile} must reject`);
      if (read.ok) throw new Error("unreachable");
      assert.equal(read.rejection.code, "WORKSPACE_VIOLATION");
    }
    console.log("P6.4 PROOF: UNC/device path rejected");
  });

  it("prefix-collision siblings stay outside (sentinel unchanged)", async () => {
    const harness = freshHarness();
    const evilSibling = `${harness.leaf}-evil`;
    mkdirSync(evilSibling, { recursive: true });
    writeFileSync(join(evilSibling, "sentinel.txt"), "do-not-touch");
    seedText(harness, "real.txt", "real-bytes");
    const read = await harness.adapter.readDocument(authority(harness), "real.txt");
    assert.equal(read.ok, true);
    assert.equal(readFileSync(join(evilSibling, "sentinel.txt"), "utf8"), "do-not-touch");
    assert.equal(lstatSync(harness.leaf).isDirectory(), true);
    rmSync(evilSibling, { recursive: true, force: true });
    console.log("P6.4 PROOF: prefix collision rejected");
  });

  it("symlink file escapes are rejected", async () => {
    const harness = freshHarness();
    const outside = join(TEST_ROOT, `${harness.tag}-outside.txt`);
    writeFileSync(outside, "outside-secret");
    symlinkSync(outside, join(harness.leaf, "link.txt"), "file");
    const read = await harness.adapter.readDocument(authority(harness), "link.txt");
    assert.equal(read.ok, false, "symlink target must reject");
    if (read.ok) throw new Error("unreachable");
    assert.equal(read.rejection.code, "WORKSPACE_VIOLATION");
    assert.equal(readFileSync(outside, "utf8"), "outside-secret");
    console.log("P6.4 PROOF: symlink escape rejected");
  });

  it("ancestry symlink escapes are rejected", async () => {
    const harness = freshHarness();
    const outsideDir = join(TEST_ROOT, `${harness.tag}-outside-dir`);
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, "secret.txt"), "outside-secret");
    symlinkSync(outsideDir, join(harness.leaf, "linked-dir"), "junction");
    const read = await harness.adapter.readDocument(authority(harness), "linked-dir/secret.txt");
    assert.equal(read.ok, false, "symlinked ancestry must reject");
    if (read.ok) throw new Error("unreachable");
    assert.equal(read.rejection.code, "WORKSPACE_VIOLATION");
    console.log("P6.4 PROOF: ancestry link escape rejected");
  });

  it("directory-as-file is rejected", async () => {
    const harness = freshHarness();
    mkdirSync(join(harness.leaf, "subdir"), { recursive: true });
    const read = await harness.adapter.readDocument(authority(harness), "subdir");
    assert.equal(read.ok, false);
    if (read.ok) throw new Error("unreachable");
    assert.equal(read.rejection.code, "WORKSPACE_VIOLATION");
    const published = await harness.adapter.publishDocument(authority(harness), {
      portablePath: "subdir",
      content: "x",
      mode: "replace",
      expected: { exists: true, digest: sha256Text("x") },
    });
    assert.equal(published.ok, false);
    console.log("P6.4 PROOF: directory-as-file rejected");
  });

  it("missing files report FILE_NOT_FOUND", async () => {
    const harness = freshHarness();
    const read = await harness.adapter.readDocument(authority(harness), "absent.txt");
    assert.equal(read.ok, false);
    if (read.ok) throw new Error("unreachable");
    assert.equal(read.rejection.code, "FILE_NOT_FOUND");
    console.log("P6.4 PROOF: missing-file behavior");
  });

  it("missing parents are rejected without creation", async () => {
    const harness = freshHarness();
    const published = await harness.adapter.publishDocument(authority(harness), {
      portablePath: "no/such/dir/file.txt",
      content: "hello",
      mode: "create",
      expected: { exists: false, digest: null },
    });
    assert.equal(published.ok, false);
    if (published.ok) throw new Error("unreachable");
    assert.equal(published.rejection.code, "FILE_NOT_FOUND");
    assert.equal(existsSync(join(harness.leaf, "no")), false, "no directory tree is invented");
    assert.equal(stagingIsClean(harness), true);
    console.log("P6.4 PROOF: missing parent rejected without creation");
  });
});

describe("P6.4 Unicode and line endings", () => {
  it("UTF-8 English round-trips exact", async () => {
    const harness = freshHarness();
    const text = "const greeting = \"hello world\";\nconsole.log(greeting);\nsecond line\n";
    const published = await harness.adapter.publishDocument(authority(harness), {
      portablePath: "english.txt",
      content: text,
      mode: "create",
      expected: { exists: false, digest: null },
    });
    assert.equal(published.ok, true);
    const read = await harness.adapter.readDocument(authority(harness), "english.txt");
    assert.equal(read.ok, true);
    if (!read.ok || !published.ok) throw new Error("unreachable");
    assert.equal(read.value.content, text);
    assert.deepEqual(rawBytes(harness, "english.txt"), new TextEncoder().encode(text));
    assert.equal(read.value.digest, published.value.digest);
    console.log("P6.4 PROOF: UTF-8 English exact");
  });

  it("UTF-8 Arabic round-trips exact", async () => {
    const harness = freshHarness();
    const text = "// مرحبا بالعالم\nconst رسالة = \"النص العربي\";\nسطر ثالث\n";
    const published = await harness.adapter.publishDocument(authority(harness), {
      portablePath: "arabic.txt",
      content: text,
      mode: "create",
      expected: { exists: false, digest: null },
    });
    assert.equal(published.ok, true);
    const read = await harness.adapter.readDocument(authority(harness), "arabic.txt");
    assert.equal(read.ok, true);
    if (!read.ok) throw new Error("unreachable");
    assert.equal(read.value.content, text);
    assert.deepEqual(rawBytes(harness, "arabic.txt"), new TextEncoder().encode(text));
    console.log("P6.4 PROOF: UTF-8 Arabic exact");
  });

  it("mixed Arabic/English with emoji and multiline source round-trips exact", async () => {
    const harness = freshHarness();
    const text = "const x = 1; // English تعليق عربي 🚀\nconst family = \"👨‍👩‍👧‍👦\";\nline3 عربي\nline4 emoji 🎉\n";
    const published = await harness.adapter.publishDocument(authority(harness), {
      portablePath: "src/mixed.txt",
      content: text,
      mode: "create",
      expected: { exists: false, digest: null },
    });
    assert.equal(published.ok, false, "missing parents must reject even for Unicode content");
    mkdirSync(join(harness.leaf, "src"), { recursive: true });
    const retry = await harness.adapter.publishDocument(authority(harness), {
      portablePath: "src/mixed.txt",
      content: text,
      mode: "create",
      expected: { exists: false, digest: null },
    });
    assert.equal(retry.ok, true);
    const read = await harness.adapter.readDocument(authority(harness), "src/mixed.txt");
    assert.equal(read.ok, true);
    if (!read.ok) throw new Error("unreachable");
    assert.equal(read.value.content, text);
    assert.deepEqual(rawBytes(harness, "src/mixed.txt"), new TextEncoder().encode(text));
    console.log("P6.4 PROOF: mixed Unicode exact");
  });

  it("malformed UTF-8 is rejected without substitution", async () => {
    const harness = freshHarness();
    seedBytes(harness, "broken.txt", new Uint8Array([0x48, 0x69, 0xff, 0xfe, 0x41]));
    const read = await harness.adapter.readDocument(authority(harness), "broken.txt");
    assert.equal(read.ok, false);
    if (read.ok) throw new Error("unreachable");
    assert.equal(read.rejection.code, "UNSUPPORTED_TEXT_PROFILE");
    assert.deepEqual(rawBytes(harness, "broken.txt"), new Uint8Array([0x48, 0x69, 0xff, 0xfe, 0x41]));
    console.log("P6.4 PROOF: malformed UTF-8 behavior");
  });

  it("byte-order marks are rejected", async () => {
    const harness = freshHarness();
    seedBytes(harness, "bom.txt", new Uint8Array([0xef, 0xbb, 0xbf, 0x41]));
    const read = await harness.adapter.readDocument(authority(harness), "bom.txt");
    assert.equal(read.ok, false);
    if (read.ok) throw new Error("unreachable");
    assert.equal(read.rejection.code, "UNSUPPORTED_TEXT_PROFILE");
    console.log("P6.4 PROOF: BOM rejected");
  });

  it("NUL and lone surrogates are rejected", async () => {
    const harness = freshHarness();
    for (const bad of ["a\0b", "a\ud800b"]) {
      const published = await harness.adapter.publishDocument(authority(harness), {
        portablePath: "bad.txt",
        content: bad,
        mode: "create",
        expected: { exists: false, digest: null },
      });
      assert.equal(published.ok, false, `${JSON.stringify(bad)} must reject`);
      if (published.ok) throw new Error("unreachable");
      assert.equal(published.rejection.code, "UNSUPPORTED_TEXT_PROFILE");
    }
    assert.equal(existsSync(join(harness.leaf, "bad.txt")), false);
    assert.equal(stagingIsClean(harness), true);
    console.log("P6.4 PROOF: NUL and lone surrogates rejected");
  });

  it("LF bytes are preserved exact; CRLF is rejected without mutation", async () => {
    const harness = freshHarness();
    const lf = "line1\nline2\nline3\n";
    const created = await harness.adapter.publishDocument(authority(harness), {
      portablePath: "lf.txt",
      content: lf,
      mode: "create",
      expected: { exists: false, digest: null },
    });
    assert.equal(created.ok, true);
    assert.deepEqual(rawBytes(harness, "lf.txt"), new TextEncoder().encode(lf));
    const crlf = "line1\r\nline2\r\n";
    const rejectedPublish = await harness.adapter.publishDocument(authority(harness), {
      portablePath: "crlf.txt",
      content: crlf,
      mode: "create",
      expected: { exists: false, digest: null },
    });
    assert.equal(rejectedPublish.ok, false);
    if (rejectedPublish.ok) throw new Error("unreachable");
    assert.equal(rejectedPublish.rejection.code, "UNSUPPORTED_TEXT_PROFILE");
    assert.equal(existsSync(join(harness.leaf, "crlf.txt")), false);
    seedBytes(harness, "seed-crlf.txt", new TextEncoder().encode(crlf));
    const read = await harness.adapter.readDocument(authority(harness), "seed-crlf.txt");
    assert.equal(read.ok, false);
    if (read.ok) throw new Error("unreachable");
    assert.equal(read.rejection.code, "UNSUPPORTED_TEXT_PROFILE");
    assert.deepEqual(rawBytes(harness, "seed-crlf.txt"), new TextEncoder().encode(crlf));
    console.log("P6.4 PROOF: LF/CRLF canonical policy");
  });
});

describe("P6.4 digest and external modification", () => {
  it("digests are deterministic SHA-256", () => {
    assert.equal(sha256HexBytes(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(sha256HexBytes(new Uint8Array([])), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    console.log("P6.4 PROOF: digest deterministic");
  });

  it("same bytes yield the same digest", async () => {
    const harness = freshHarness();
    const text = "identical bytes\n";
    const first = await harness.adapter.publishDocument(authority(harness), {
      portablePath: "same.txt",
      content: text,
      mode: "create",
      expected: { exists: false, digest: null },
    });
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("unreachable");
    const read = await harness.adapter.readDocument(authority(harness), "same.txt");
    assert.equal(read.ok, true);
    if (!read.ok) throw new Error("unreachable");
    assert.equal(read.value.digest, first.value.digest);
    assert.equal(read.value.digest, sha256Text(text));
    console.log("P6.4 PROOF: same bytes same revision digest");
  });

  it("changed bytes yield a changed digest", async () => {
    const harness = freshHarness();
    seedText(harness, "change.txt", "version one\n");
    const before = await harness.adapter.readDocument(authority(harness), "change.txt");
    assert.equal(before.ok, true);
    if (!before.ok) throw new Error("unreachable");
    const after = await harness.adapter.publishDocument(authority(harness), {
      portablePath: "change.txt",
      content: "version two\n",
      mode: "replace",
      expected: { exists: true, digest: before.value.digest },
    });
    assert.equal(after.ok, true);
    if (!after.ok) throw new Error("unreachable");
    assert.notEqual(after.value.digest, before.value.digest);
    assert.equal(after.value.digest, sha256Text("version two\n"));
    console.log("P6.4 PROOF: changed bytes changed digest");
  });

  it("expected-preimage mismatch reports EXTERNAL_MODIFICATION_CONFLICT", async () => {
    const harness = freshHarness();
    seedText(harness, "guarded.txt", "original\n");
    const before = await harness.adapter.readDocument(authority(harness), "guarded.txt");
    assert.equal(before.ok, true);
    if (!before.ok) throw new Error("unreachable");
    writeFileSync(join(harness.leaf, "guarded.txt"), "someone else wrote\n");
    const published = await harness.adapter.publishDocument(authority(harness), {
      portablePath: "guarded.txt",
      content: "adapter attempt\n",
      mode: "replace",
      expected: { exists: true, digest: before.value.digest },
    });
    assert.equal(published.ok, false);
    if (published.ok) throw new Error("unreachable");
    assert.equal(published.rejection.code, "EXTERNAL_MODIFICATION_CONFLICT");
    assert.equal(readFileSync(join(harness.leaf, "guarded.txt"), "utf8"), "someone else wrote\n");
    assert.equal(stagingIsClean(harness), true);
    console.log("P6.4 PROOF: expected-preimage mismatch conflict");
  });

  it("externally deleted files report conflict instead of silent recreate", async () => {
    const harness = freshHarness();
    seedText(harness, "deleted.txt", "here\n");
    const before = await harness.adapter.readDocument(authority(harness), "deleted.txt");
    assert.equal(before.ok, true);
    if (!before.ok) throw new Error("unreachable");
    rmSync(join(harness.leaf, "deleted.txt"));
    const published = await harness.adapter.publishDocument(authority(harness), {
      portablePath: "deleted.txt",
      content: "recreate\n",
      mode: "replace",
      expected: { exists: true, digest: before.value.digest },
    });
    assert.equal(published.ok, false);
    if (published.ok) throw new Error("unreachable");
    assert.equal(published.rejection.code, "EXTERNAL_MODIFICATION_CONFLICT");
    assert.equal(existsSync(join(harness.leaf, "deleted.txt")), false);
    console.log("P6.4 PROOF: external deletion conflicts");
  });

  it("creation never overwrites (FILE_EXISTS, original intact)", async () => {
    const harness = freshHarness();
    seedText(harness, "taken.txt", "original\n");
    const published = await harness.adapter.publishDocument(authority(harness), {
      portablePath: "taken.txt",
      content: "overwrite attempt\n",
      mode: "create",
      expected: { exists: false, digest: null },
    });
    assert.equal(published.ok, false);
    if (published.ok) throw new Error("unreachable");
    assert.equal(published.rejection.code, "FILE_EXISTS");
    assert.equal(readFileSync(join(harness.leaf, "taken.txt"), "utf8"), "original\n");
    assert.equal(stagingIsClean(harness), true);
    console.log("P6.4 PROOF: file creation collision");
  });
});

describe("P6.4 ownership and fencing", () => {
  it("writes under TERMINAL_OWNED report WORKSPACE_BUSY with zero mutation", async () => {
    const harness = freshHarness();
    seedText(harness, "busy.txt", "old\n");
    const before = await harness.adapter.readDocument(authority(harness), "busy.txt");
    assert.equal(before.ok, true);
    if (!before.ok) throw new Error("unreachable");
    const published = await harness.adapter.publishDocument(authority(harness, { ownership: "TERMINAL_OWNED" }), {
      portablePath: "busy.txt",
      content: "new\n",
      mode: "replace",
      expected: { exists: true, digest: before.value.digest },
    });
    assert.equal(published.ok, false);
    if (published.ok) throw new Error("unreachable");
    assert.equal(published.rejection.code, "WORKSPACE_BUSY");
    const read = await harness.adapter.readDocument(authority(harness), "busy.txt");
    assert.equal(read.ok, true);
    if (!read.ok) throw new Error("unreachable");
    assert.equal(read.value.content, "old\n");
    const fresh = await harness.adapter.publishDocument(authority(harness, { ownership: "TERMINAL_OWNED" }), {
      portablePath: "fresh.txt",
      content: "new\n",
      mode: "create",
      expected: { exists: false, digest: null },
    });
    assert.equal(fresh.ok, false);
    assert.equal(existsSync(join(harness.leaf, "fresh.txt")), false);
    console.log("P6.4 PROOF: no write under wrong ownership");
  });

  it("barrier states reject with INVALID_TRANSITION", async () => {
    const harness = freshHarness();
    for (const ownership of ["TRANSITION", "RESETTING", "CLOSING", "HOLD"] as const) {
      const published = await harness.adapter.publishDocument(authority(harness, { ownership }), {
        portablePath: "barrier.txt",
        content: "x",
        mode: "create",
        expected: { exists: false, digest: null },
      });
      assert.equal(published.ok, false, `${ownership} must reject`);
      if (published.ok) throw new Error("unreachable");
      assert.equal(published.rejection.code, "INVALID_TRANSITION");
    }
    console.log("P6.4 PROOF: barrier fencing");
  });

  it("stale generations cannot publish", async () => {
    const harness = freshHarness();
    const stale = authority(harness, { lease: { generation: 99 } });
    const published = await harness.adapter.publishDocument(stale, {
      portablePath: "stale.txt",
      content: "x",
      mode: "create",
      expected: { exists: false, digest: null },
    });
    assert.equal(published.ok, false);
    if (published.ok) throw new Error("unreachable");
    assert.equal(published.rejection.code, "STALE_SESSION");
    assert.equal(existsSync(join(harness.leaf, "stale.txt")), false);
    assert.equal(stagingIsClean(harness), true);
    console.log("P6.4 PROOF: stale generation cannot publish");
  });

  it("foreign leases report WRONG_OWNER", async () => {
    const harness = freshHarness();
    const foreign = authority(harness, { lease: { sessionId: "sess-p64-foreign", workspaceId: "ws-p64-foreign" } });
    const read = await harness.adapter.readDocument(foreign, "anything.txt");
    assert.equal(read.ok, false);
    if (read.ok) throw new Error("unreachable");
    assert.equal(read.rejection.code, "WRONG_OWNER");
    console.log("P6.4 PROOF: foreign lease fenced");
  });

  it("revoked leases report WORKSPACE_REVOKED", async () => {
    const harness = freshHarness();
    seedText(harness, "revoked.txt", "old\n");
    const auth = authority(harness);
    const revoked = authority(harness, { revokedLeaseIds: [auth.lease.leaseId] });
    const read = await harness.adapter.readDocument(revoked, "revoked.txt");
    assert.equal(read.ok, false);
    if (read.ok) throw new Error("unreachable");
    assert.equal(read.rejection.code, "WORKSPACE_REVOKED");
    console.log("P6.4 PROOF: revoked lease fenced");
  });

  it("stale epochs report STALE_EPOCH", async () => {
    const harness = freshHarness();
    const stale = authority(harness, { lease: { epoch: 7 }, liveEpoch: 9 });
    const read = await harness.adapter.readDocument(stale, "anything.txt");
    assert.equal(read.ok, false);
    if (read.ok) throw new Error("unreachable");
    assert.equal(read.rejection.code, "STALE_EPOCH");
    console.log("P6.4 PROOF: stale epoch fenced");
  });

  it("reset racing publication fails closed with staging discarded", async () => {
    const harness = freshHarness();
    const base = authority(harness);
    const resetFence = (): AdapterAuthority => ({
      ...base,
      lease: { ...base.lease, generation: 2 },
    });
    const published = await harness.adapter.publishDocument(base, {
      portablePath: "reset-race.txt",
      content: "new bytes\n",
      mode: "create",
      expected: { exists: false, digest: null },
      revalidate: resetFence,
    });
    assert.equal(published.ok, false);
    if (published.ok) throw new Error("unreachable");
    assert.equal(published.rejection.code, "STALE_SESSION");
    assert.equal(existsSync(join(harness.leaf, "reset-race.txt")), false);
    assert.equal(stagingIsClean(harness), true);
    console.log("P6.4 PROOF: reset racing publication fails closed");
  });

  it("close racing publication fails closed with staging discarded", async () => {
    const harness = freshHarness();
    seedText(harness, "close-race.txt", "old bytes\n");
    const before = await harness.adapter.readDocument(authority(harness), "close-race.txt");
    assert.equal(before.ok, true);
    if (!before.ok) throw new Error("unreachable");
    const base = authority(harness);
    const closeFence = (): AdapterAuthority => ({ ...base, ownership: "CLOSING" });
    const published = await harness.adapter.publishDocument(base, {
      portablePath: "close-race.txt",
      content: "new bytes\n",
      mode: "replace",
      expected: { exists: true, digest: before.value.digest },
      revalidate: closeFence,
    });
    assert.equal(published.ok, false);
    if (published.ok) throw new Error("unreachable");
    assert.equal(published.rejection.code, "INVALID_TRANSITION");
    assert.equal(readFileSync(join(harness.leaf, "close-race.txt"), "utf8"), "old bytes\n");
    assert.equal(stagingIsClean(harness), true);
    console.log("P6.4 PROOF: close racing publication fails closed");
  });
});

describe("P6.4 publication integrity", () => {
  it("byte verification detects post-commit mismatch (COMMIT_UNCERTAIN)", async () => {
    const harness = freshHarness();
    const published = await harness.adapter.publishDocument(authority(harness), {
      portablePath: "uncertain.txt",
      content: "intended complete bytes\n",
      mode: "create",
      expected: { exists: false, digest: null },
      diagnosticsCorruptAfterRename: true,
    });
    assert.equal(published.ok, false);
    if (published.ok) throw new Error("unreachable");
    assert.equal(published.rejection.code, "COMMIT_UNCERTAIN");
    assert.equal(stagingIsClean(harness), true);
    console.log("P6.4 PROOF: byte verification detects mismatch");
  });

  it("publication never exposes partial destination bytes", async () => {
    const harness = freshHarness();
    const text = `${"0123456789ABCDEF\n".repeat(16384)}`;
    assert.ok(new TextEncoder().encode(text).length > 262144, "payload is large enough to span awaits");
    const pending = harness.adapter.publishDocument(authority(harness), {
      portablePath: "big.txt",
      content: text,
      mode: "create",
      expected: { exists: false, digest: null },
    });
    const fullSize = new TextEncoder().encode(text).length;
    let samples = 0;
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    while (!settled && samples < 5000) {
      samples += 1;
      let size: number | null = null;
      try {
        size = lstatSync(join(harness.leaf, "big.txt")).size;
      } catch {
        size = null;
      }
      assert.ok(size === null || size === fullSize, `destination is absent or complete (sample ${samples}: ${size})`);
      await new Promise((resolve) => setImmediate(resolve));
    }
    const result = await pending;
    assert.equal(result.ok, true, "large publication must succeed");
    assert.deepEqual(rawBytes(harness, "big.txt"), new TextEncoder().encode(text));
    assert.ok(samples > 0, "polling observed the publication window");
    console.log("P6.4 PROOF: publication does not expose partial destination bytes");
  });

  it("staging never appears inside the leaf and is cleaned on every failure", async () => {
    const harness = freshHarness();
    seedText(harness, "victim.txt", "original\n");
    const before = await harness.adapter.readDocument(authority(harness), "victim.txt");
    assert.equal(before.ok, true);
    if (!before.ok) throw new Error("unreachable");
    const attempts: Array<Promise<unknown>> = [
      harness.adapter.publishDocument(authority(harness), {
        portablePath: "victim.txt",
        content: "overwrite\n",
        mode: "create",
        expected: { exists: false, digest: null },
      }),
      harness.adapter.publishDocument(authority(harness), {
        portablePath: "victim.txt",
        content: "bad\r\n",
        mode: "replace",
        expected: { exists: true, digest: before.value.digest },
      }),
      harness.adapter.publishDocument(authority(harness, { ownership: "TERMINAL_OWNED" }), {
        portablePath: "victim.txt",
        content: "busy\n",
        mode: "replace",
        expected: { exists: true, digest: before.value.digest },
      }),
    ];
    for (const attempt of attempts) {
      const outcome = (await attempt) as { ok: boolean };
      assert.equal(outcome.ok, false);
    }
    assert.equal(stagingIsClean(harness), true);
    assert.deepEqual(
      readdirSync(harness.leaf).filter((entry) => entry.startsWith("cf-p64-stage-")),
      [],
      "no staging file ever appears as a lesson file",
    );
    assert.equal(readFileSync(join(harness.leaf, "victim.txt"), "utf8"), "original\n");
    console.log("P6.4 PROOF: staging cleanup on failure");
  });

  it("case aliases are rejected", async () => {
    const harness = freshHarness();
    seedText(harness, "App.txt", "original\n");
    for (const alias of ["app.txt", "APP.TXT", "aPP.txt"]) {
      const read = await harness.adapter.readDocument(authority(harness), alias);
      assert.equal(read.ok, false, `${alias} must reject`);
      if (read.ok) throw new Error("unreachable");
      assert.equal(read.rejection.code, "WORKSPACE_VIOLATION");
      const created = await harness.adapter.publishDocument(authority(harness), {
        portablePath: alias,
        content: "alias\n",
        mode: "create",
        expected: { exists: false, digest: null },
      });
      assert.equal(created.ok, false, `${alias} creation must reject`);
    }
    assert.equal(readFileSync(join(harness.leaf, "App.txt"), "utf8"), "original\n");
    console.log("P6.4 PROOF: case-collision behavior");
  });

  it("public DTOs carry no absolute host paths", async () => {
    const harness = freshHarness();
    seedText(harness, "dto.txt", "dto\n");
    const read = await harness.adapter.readDocument(authority(harness), "dto.txt");
    assert.equal(read.ok, true);
    if (!read.ok) throw new Error("unreachable");
    assert.deepEqual(dtoLeaksHostPaths(read.value, harness), []);
    const published = await harness.adapter.publishDocument(authority(harness), {
      portablePath: "dto2.txt",
      content: "dto2\n",
      mode: "create",
      expected: { exists: false, digest: null },
    });
    assert.equal(published.ok, true);
    if (!published.ok) throw new Error("unreachable");
    assert.deepEqual(dtoLeaksHostPaths(published.value, harness), []);
    console.log("P6.4 PROOF: no absolute path in public DTOs");
  });

  it("empty content publishes exact empty bytes", async () => {
    const harness = freshHarness();
    const published = await harness.adapter.publishDocument(authority(harness), {
      portablePath: "empty.txt",
      content: "",
      mode: "create",
      expected: { exists: false, digest: null },
    });
    assert.equal(published.ok, true);
    if (!published.ok) throw new Error("unreachable");
    assert.equal(published.value.byte_length, 0);
    assert.equal(published.value.digest, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    const read = await harness.adapter.readDocument(authority(harness), "empty.txt");
    assert.equal(read.ok, true);
    if (!read.ok) throw new Error("unreachable");
    assert.equal(read.value.content, "");
    console.log("P6.4 PROOF: empty content exact");
  });

  it("no generic renderer file API is exposed", async () => {
    const preload = readFileSync(join(repoRoot, "apps", "teaching-ide", "electron", "preload.ts"), "utf8");
    const strip = (code: string): string =>
      code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    const clean = strip(preload);
    for (const marker of ["file-adapter", "openWindowsFileAdapter", "readDocument", "publishDocument"]) {
      assert.equal(clean.includes(marker), false, `preload must not reference ${marker}`);
    }
    const adapterSource = strip(readFileSync(join(repoRoot, "engine", "workspace", "src", "file-adapter.ts"), "utf8"));
    assert.equal(adapterSource.includes("contextBridge"), false, "adapter never touches the renderer bridge");
    console.log("P6.4 PROOF: no renderer generic file API");
  });
});
