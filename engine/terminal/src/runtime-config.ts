// P5.3 machine-local runtime configuration — the trusted source of the
// workspace root and the pinned image identity (docs/P5-DESIGN-SPEC.md:
// "Runtime config for all phases" / "Trusted workspace resolution").
//
// The workspace root NEVER comes from renderer input, lesson content, IR, or
// any committed file. It comes from the git-ignored machine-local config
// `config/paths.json` (see config/paths.example.json for the documented
// shape). The image identity comes from the committed, immutable
// engine/terminal/image/base-image.lock.json (P5.0), never from a moving tag
// and never from runtime input.
//
// Like every P5.3 module this file performs no execution of any kind.

import { readFileSync } from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { RuntimeErrorCode } from "./protocol.ts";
import type { RuntimeImageIdentity } from "./workspace.ts";
import type { WorkspaceOutcome } from "./workspace.ts";

export { defaultRepositoryRoot } from "./workspace.ts";

export interface RuntimeConfigRejection {
  readonly code: RuntimeErrorCode;
  readonly message: string;
}

function configRejected(code: RuntimeErrorCode, message: string): { ok: false; error: RuntimeConfigRejection } {
  return { ok: false, error: { code, message } };
}

const IMAGE_LOCK_DIRNAME = "image";
const IMAGE_LOCK_BASENAME = "base-image.lock.json";

/**
 * Shape of the committed P5.0 lock (strict: unknown keys rejected). Only the
 * deterministic identity/policy fields are described; provenance and runtime
 * evidence fields are intentionally not required here.
 */
const ImageLockFileSchema = z.object({
  lock_format_version: z.literal(1),
  image: z.object({
    registry_repository: z.string().min(1),
    tag: z.string().min(1),
    platform: z.string().min(1),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    pinned_reference: z.string().min(1),
  }),
  policy: z.object({
    pull: z.literal("never"),
    moving_tags_forbidden: z.literal(true),
  }),
});

/**
 * Pinned image identity — a strict subset view of the P5.0 lock file. The
 * digest and pull_policy=never are mandatory: a moving tag can never become
 * a runtime image identity here.
 */
export const ImageLockIdentitySchema = z.strictObject({
  pinned_reference: z.string().min(1),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  platform: z.string().min(1),
  pull_policy: z.literal("never"),
  source: z.literal("base-image.lock.json"),
});

/**
 * Load the pinned runtime image identity from the committed base-image lock.
 * Structured rejection (IMAGE_UNAVAILABLE) on missing/malformed/moving-tag
 * content — never a fallback to a tag.
 */
export function loadRuntimeImageIdentity(repoRoot: string): WorkspaceOutcome<RuntimeImageIdentity> {
  const lockPath = nodePath.join(repoRoot, "engine", "terminal", IMAGE_LOCK_DIRNAME, IMAGE_LOCK_BASENAME);
  let read: string | null = null;
  try {
    read = readFileSync(lockPath, "utf8");
  } catch {
    read = null;
  }
  if (read === null) {
    return configRejected("IMAGE_UNAVAILABLE", `${IMAGE_LOCK_DIRNAME}/${IMAGE_LOCK_BASENAME} is missing — run the P5.0 prerequisite steps first`);
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(read);
  } catch {
    return configRejected("IMAGE_UNAVAILABLE", `${IMAGE_LOCK_DIRNAME}/${IMAGE_LOCK_BASENAME} is not valid JSON`);
  }
  const parsed = ImageLockFileSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return configRejected("IMAGE_UNAVAILABLE", `${IMAGE_LOCK_DIRNAME}/${IMAGE_LOCK_BASENAME} must pin an image by sha256 digest with pull_policy=never`);
  }
  const { image, policy } = parsed.data;
  // Defense-in-depth: the pinned_reference must embed the exact digest, and
  // the lock must forbid moving tags. A bare tag reference is never accepted.
  if (!image.pinned_reference.includes(`@${image.digest}`)) {
    return configRejected("IMAGE_UNAVAILABLE", `${IMAGE_LOCK_DIRNAME}/${IMAGE_LOCK_BASENAME} pinned_reference must embed the sha256 digest`);
  }
  const identity: RuntimeImageIdentity = {
    pinned_reference: image.pinned_reference,
    digest: image.digest,
    platform: image.platform,
    pull_policy: policy.pull,
    source: IMAGE_LOCK_BASENAME,
  };
  const checked = ImageLockIdentitySchema.safeParse(identity);
  if (!checked.success) {
    return configRejected("IMAGE_UNAVAILABLE", `${IMAGE_LOCK_DIRNAME}/${IMAGE_LOCK_BASENAME} does not yield a valid pinned image identity`);
  }
  return { ok: true, value: Object.freeze(checked.data) };
}
