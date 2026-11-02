// P5.1 image lock tests — the canonical runtime base-image lock must parse,
// pin exactly the digest verified by the P5.0 Docker isolation prerequisite,
// carry a digest-pinned immutable reference, and stay deterministic and
// portable (no machine paths, no timestamps, no usernames).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const imageDir = join(here, "..", "image");
const lockPath = join(imageDir, "base-image.lock.json");
const dockerfilePath = join(imageDir, "Dockerfile");

/** The exact digest recorded by P5.0 evidence (docs/evidence/P5/P5.0-docker-prerequisite.log). */
const P5_0_VERIFIED_DIGEST = "sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";

const BaseImageLockSchema = z.strictObject({
  lock_format_version: z.literal(1),
  description: z.string().min(1),
  image: z.strictObject({
    registry_repository: z.string().min(1),
    tag: z.string().min(1),
    platform: z.literal("linux/amd64"),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    pinned_reference: z.string().regex(/^node:24-bookworm-slim@sha256:[0-9a-f]{64}$/),
    digest_kind: z.string().min(1),
  }),
  runtime: z.strictObject({
    kind: z.literal("node"),
    node_major: z.literal(24),
    guest_node_version_recorded: z.string().regex(/^v\d+\.\d+\.\d+$/),
    host_node_version_recorded: z.string().regex(/^v\d+\.\d+\.\d+$/),
    node_version_note: z.string().min(1),
  }),
  policy: z.strictObject({
    pull: z.literal("never"),
    moving_tags_forbidden: z.literal(true),
    unpinned_references_forbidden: z.array(z.string().min(1)).min(1),
    runtime_image_id: z.string().min(1),
  }),
  provenance: z.strictObject({
    resolved_by: z.string().min(1),
    evidence: z.string().min(1),
    prerequisite_commit: z.string().regex(/^[0-9a-f]{40}$/),
    dockerfile: z.string().min(1),
  }),
});

function readLock(): { raw: string; parsed: unknown; lock: z.infer<typeof BaseImageLockSchema> } {
  const raw = readFileSync(lockPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const lock = BaseImageLockSchema.parse(parsed);
  return { raw, parsed, lock };
}

describe("P5.1 base image lock", () => {
  it("parses as strict JSON conforming to the lock schema", () => {
    const { lock } = readLock();
    assert.equal(lock.lock_format_version, 1);
  });

  it("pins exactly the digest verified by P5.0 evidence", () => {
    const { lock } = readLock();
    assert.equal(lock.image.digest, P5_0_VERIFIED_DIGEST);
  });

  it("carries a digest-pinned immutable reference (never a moving tag)", () => {
    const { lock } = readLock();
    assert.equal(lock.image.pinned_reference, `node:24-bookworm-slim@${P5_0_VERIFIED_DIGEST}`);
    assert.deepEqual(lock.policy.unpinned_references_forbidden, ["node:latest", "node:24", "node:24-bookworm-slim"]);
    assert.equal(lock.policy.pull, "never");
    assert.equal(lock.policy.moving_tags_forbidden, true);
  });

  it("records the platform and Node runtime information", () => {
    const { lock } = readLock();
    assert.equal(lock.image.platform, "linux/amd64");
    assert.equal(lock.image.registry_repository, "node");
    assert.equal(lock.image.tag, "24-bookworm-slim");
    assert.equal(lock.runtime.kind, "node");
    assert.equal(lock.runtime.node_major, 24);
    assert.equal(lock.runtime.guest_node_version_recorded, "v24.20.0");
    assert.equal(lock.runtime.host_node_version_recorded, "v24.18.0");
  });

  it("is deterministic and portable: no machine paths, timestamps or usernames", () => {
    const { raw } = readLock();
    const leaks: string[] = [];
    if (/[A-Za-z]:[\\/]/.test(raw)) leaks.push("drive-letter path");
    if (raw.includes("\\")) leaks.push("backslash path");
    if (/\/home\/|\/Users\//.test(raw)) leaks.push("unix home path");
    if (/AppData|Ahmed|USERPROFILE/i.test(raw)) leaks.push("personal/machine value");
    if (/\d{4}-\d{2}-\d{2}T\d{2}:/.test(raw)) leaks.push("timestamp");
    assert.deepEqual(leaks, [], `lock must stay portable, found: ${leaks.join(", ")}`);
  });

  it("points provenance at the P5.0 prerequisite commit and evidence", () => {
    const { lock } = readLock();
    assert.equal(lock.provenance.prerequisite_commit, "dfe166f1d8bdac666221b184a4fe049df22a5859");
    assert.equal(lock.provenance.evidence, "docs/evidence/P5/P5.0-docker-prerequisite.log");
    assert.equal(lock.provenance.dockerfile, "engine/terminal/image/Dockerfile");
  });

  it("the Dockerfile FROM line is digest-pinned to the same locked digest", () => {
    const dockerfile = readFileSync(dockerfilePath, "utf8");
    const fromLines = dockerfile
      .split("\n")
      .filter((line) => /^FROM\s/.test(line));
    assert.equal(fromLines.length, 1, "exactly one FROM stage");
    assert.equal(fromLines[0].trim(), `FROM node:24-bookworm-slim@${P5_0_VERIFIED_DIGEST}`);
  });

  it("the Dockerfile recipe encodes non-root and a JSON entrypoint with no writable image affordances", () => {
    const dockerfile = readFileSync(dockerfilePath, "utf8");
    assert.match(dockerfile, /^USER 1000:1000$/m, "non-root user 1000:1000");
    assert.match(dockerfile, /^WORKDIR \/workspace$/m, "workspace workdir");
    assert.match(dockerfile, /^ENTRYPOINT \["node", "\/opt\/course-factory\/supervisor\.mjs"\]$/m, "JSON entrypoint");
    assert.doesNotMatch(dockerfile, /^HEALTHCHECK/m, "no healthcheck");
    assert.doesNotMatch(dockerfile, /^VOLUME/m, "no volume");
    assert.doesNotMatch(dockerfile, /^EXPOSE/m, "no exposed ports");
    assert.doesNotMatch(dockerfile, /^RUN\s/m, "no RUN steps (COPY --chmod only)");
    assert.match(dockerfile, /COPY --chmod=0555 dist\/supervisor\.mjs/, "root-owned read-only-to-user bundle");
  });
});
