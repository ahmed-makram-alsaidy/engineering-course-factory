// P6.4 Windows file adapter — trusted main-only host filesystem primitives.
//
// Canonical authority: docs/P6-DESIGN-SPEC.md sections 12 (LF profile), 17
// (path rules), 22 task P6.4 ("Main-only Node-API adapter, NTFS
// handles/read/rename/flush"; PASS "Node/Electron load/build;
// links/hardlinks/reparse/no-clobber/atomic target probes"), 26.6 (host file
// backend), 26.7 (save algorithm and watcher visibility), 26.12 (atomic
// publication, link attacks, watch visibility) and
// docs/adr/ADR-0011-shared-workspace-ownership.md decision 6.
//
// Canonical P6.4 name: P6.4 Windows file adapter.
// Objective: the low-level trusted file-system primitives that later editor
// operations can rely on — nothing more. This module is infrastructure, not
// lesson behavior.
//
// Owned scope (and only this):
//   - confined read of one lesson-relative file (exact bytes, strict text
//     profile, digest, logical metadata only);
//   - private staging plus same-volume atomic publication of complete bytes
//     with preimage fencing, flush and byte verification.
// Deferred to owning tasks (explicitly NOT implemented here): semantic
// open/create/save operations, planners/schedulers, replacement semantics,
// journals, IPC wiring, presentation behavior. The renderer never imports
// this module and no generic renderer filesystem bridge is exposed.
//
// Trust model:
//   - Every path input is a lesson-relative portable path validated by the
//     P6.1 PortablePathSchema (no absolute/drive/UNC/device/ADS/backslash/
//     control/NUL forms, no empty or dot segments, no reserved names, no
//     trailing dots/spaces). Translation to host paths happens only inside
//     this adapter.
//   - Every operation takes a coordinator-issued editor lease plus an explicit
//     live fence (ownership, live epoch, revoked leases). The coordinator
//     remains the sole ownership authority; this adapter never grants it.
//   - Writer exclusion comes from coordinator ownership (Docker RO or absent
//     container during EDITOR_OWNED), never from file locks. Handle checks
//     detect a stable malicious tree left by a prior writer; they do not
//     constrain a live writer.
//   - Lexical checks alone are never sufficient: ancestry is walked with
//     lstat (reparse points rejected), containment uses relative() semantics
//     (prefix collisions rejected), and the final location is re-verified
//     through realpath against the recorded leaf identity. Security-sensitive
//     publications revalidate the fence and the target preimage after staging
//     and before the rename (no check-then-await-then-use-string gap).
//
// Text policy (frozen section 12): strict LF profile. BOM, invalid UTF-8,
// NUL, lone surrogates and any CR byte reject with UNSUPPORTED_TEXT_PROFILE;
// other Unicode is preserved byte-exact with no normalization. Nothing is
// silently converted.
//
// Digest: SHA-256 hex over exact bytes (the same byte-digest function the
// seed manifest binds). Same bytes always yield the same digest.
//
// Staging/publication: unique CREATE_NEW staging files under a
// coordinator-owned sibling staging directory on the same volume (never
// inside the guest-visible leaf, never at a renderer-chosen name), full
// write plus flush, stage length/hash verification, fence plus preimage
// revalidation, then one same-volume rename (no-clobber for creation,
// replacement for existing files; never copy/delete fallback). The rename is
// the commit point: failures before it report SAVE_FAILED with the target
// unchanged; verification uncertainty after it reports COMMIT_UNCERTAIN and
// freezes (never silent rollback). Watchers therefore observe either the old
// complete file or the new complete file, never partial bytes.
//
// Platform note: this TypeScript module implements the section 26.6 contract
// with Node file APIs plus Windows-safe logic (reparse rejection via lstat,
// hardlink rejection via link count, case-alias rejection via directory
// listing, same-volume enforcement via device identity, durability via
// filehandle sync which maps to FlushFileBuffers on Windows, atomic
// publication via same-volume rename). A future native build may replace the
// internals behind this same surface; the confinement, text, digest,
// staging, fencing and verification rules above stay identical.

import { createHash, randomBytes } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { open, lstat, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import * as nodePath from "node:path";
import { OpaqueHandleSchema, PortablePathSchema, WorkspaceOwnershipSchema } from "./protocol.ts";
import type { WorkspaceOwnership, WorkspaceRejection } from "./protocol.ts";
import { EditorLeaseSchema } from "./coordinator.ts";
import type { EditorLease } from "./coordinator.ts";

/** Adapter protocol version (matches the workspace protocol). */
export const WINDOWS_FILE_ADAPTER_VERSION = 1;

/** Staging file prefix (coordinator-owned names only, never renderer input). */
export const STAGING_FILE_PREFIX = "cf-p64-stage-";

export type AdapterOutcome<T> = { ok: true; value: T } | { ok: false; rejection: WorkspaceRejection };

function rejected(code: WorkspaceRejection["code"], message: string): { ok: false; rejection: WorkspaceRejection } {
  return { ok: false, rejection: { code, message } };
}

/** Main-held session binding. Host paths never leave main and never enter DTOs. */
export interface WindowsAdapterBinding {
  readonly sessionId: string;
  readonly generation: number;
  readonly workspaceId: string;
  /** Trusted absolute leaf directory (main-held, never renderer input). */
  readonly leafHostPath: string;
  /** Trusted absolute sibling staging directory: same volume, outside the leaf. */
  readonly stagingHostPath: string;
}

/** Live coordinator fence presented with every operation (main-held facts). */
export interface AdapterAuthority {
  readonly lease: EditorLease;
  readonly ownership: WorkspaceOwnership;
  readonly liveEpoch: number;
  readonly revokedLeaseIds: readonly string[];
}

/** Expected on-disk preimage the caller observed (never silently overwritten). */
export interface ExpectedPreimage {
  readonly exists: boolean;
  readonly digest: string | null;
}

export type PublishMode = "create" | "replace";

export interface PublishArgs {
  readonly portablePath: string;
  readonly content: string;
  readonly mode: PublishMode;
  readonly expected: ExpectedPreimage;
  /**
   * Fresh fence supplier consulted after staging and before the rename. When
   * omitted the presentation-time authority is revalidated as-is. A reset,
   * close or revocation that lands mid-flight is observed here and aborts
   * before publication (no half-written destination).
   */
  readonly revalidate?: () => AdapterAuthority;
  /**
   * Test-only corruption seam (never set in production): after the rename,
   * flip one committed byte before verification so the byte-verification
   * detector must report COMMIT_UNCERTAIN. Confined to this module plus its
   * tests; PublishArgs is main-held and never renderer input, so no renderer
   * request can reach this flag. Mirrors the P5.9/P6.3 diagnostics-seam
   * precedent for proving failure detectors deterministically.
   */
  readonly diagnosticsCorruptAfterRename?: boolean;
}

/** Trusted read facts. Host paths are never exposed. */
export interface ReadDocumentResult {
  readonly portable_path: string;
  readonly exists: true;
  readonly byte_length: number;
  readonly digest: string;
  readonly file_identity: string;
  readonly content: string;
}

/** Trusted publication facts. Host paths are never exposed. */
export interface PublishDocumentResult {
  readonly portable_path: string;
  readonly byte_length: number;
  readonly digest: string;
  readonly file_identity: string;
  readonly mode: PublishMode;
}

export interface WindowsFileAdapter {
  readonly adapterVersion: 1;
  readonly sessionId: string;
  readonly generation: number;
  readonly workspaceId: string;
  readDocument(authority: AdapterAuthority, portablePath: string): Promise<AdapterOutcome<ReadDocumentResult>>;
  publishDocument(authority: AdapterAuthority, args: PublishArgs): Promise<AdapterOutcome<PublishDocumentResult>>;
}

// ---------------------------------------------------------------------------
// Small pure helpers.
// ---------------------------------------------------------------------------

/** SHA-256 hex over exact bytes (canonical disk digest). */
export function sha256HexBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameAbsolute(a: string, b: string): boolean {
  const na = nodePath.normalize(a);
  const nb = nodePath.normalize(b);
  return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** Relative-based containment (prefix-collision safe: leaf-evil is outside). */
function insideRoot(rootAbsolute: string, candidateAbsolute: string): boolean {
  const root = nodePath.normalize(rootAbsolute);
  const candidate = nodePath.normalize(candidateAbsolute);
  const rel =
    process.platform === "win32"
      ? nodePath.relative(root.toLowerCase(), candidate.toLowerCase())
      : nodePath.relative(root, candidate);
  if (rel === "") return true;
  if (nodePath.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${nodePath.sep}`);
}

function checkPortablePath(value: unknown): { ok: true; path: string } | { ok: false; rejection: WorkspaceRejection } {
  const parsed = PortablePathSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return rejected("WORKSPACE_VIOLATION", `path is not an allowed lesson-relative file: ${first?.message ?? "rejected"}`);
  }
  return { ok: true, path: parsed.data };
}

function checkAuthority(
  authority: unknown,
  binding: { sessionId: string; generation: number; workspaceId: string },
): { ok: true; value: AdapterAuthority } | { ok: false; rejection: WorkspaceRejection } {
  if (authority === null || typeof authority !== "object") {
    return rejected("INVALID_REQUEST", "adapter authority failed strict validation");
  }
  const record = authority as Record<string, unknown>;
  const leaseCheck = EditorLeaseSchema.safeParse(record["lease"]);
  if (!leaseCheck.success) {
    return rejected("INVALID_REQUEST", "editor lease failed strict validation");
  }
  const ownershipCheck = WorkspaceOwnershipSchema.safeParse(record["ownership"]);
  if (!ownershipCheck.success) {
    return rejected("INVALID_REQUEST", "ownership fence failed strict validation");
  }
  const liveEpoch = record["liveEpoch"];
  const revoked = record["revokedLeaseIds"];
  if (!Number.isInteger(liveEpoch) || (liveEpoch as number) < 1) {
    return rejected("INVALID_REQUEST", "live epoch fence must be a positive integer");
  }
  if (!Array.isArray(revoked) || revoked.some((entry) => typeof entry !== "string")) {
    return rejected("INVALID_REQUEST", "revoked lease fence failed strict validation");
  }
  const lease = leaseCheck.data;
  const ownership = ownershipCheck.data;
  if (lease.sessionId !== binding.sessionId || lease.workspaceId !== binding.workspaceId) {
    return rejected("WRONG_OWNER", "editor lease names a different session or workspace");
  }
  if (lease.generation !== binding.generation) {
    return rejected("STALE_SESSION", "editor lease carries a stale session generation");
  }
  if (lease.epoch !== (liveEpoch as number)) {
    return rejected("STALE_EPOCH", "editor lease carries a stale container epoch");
  }
  if ((revoked as readonly string[]).includes(lease.leaseId)) {
    return rejected("WORKSPACE_REVOKED", "editor lease was revoked");
  }
  return { ok: true, value: { lease, ownership, liveEpoch: liveEpoch as number, revokedLeaseIds: [...(revoked as string[])] } };
}

function checkOwnershipForFileAccess(ownership: WorkspaceOwnership): WorkspaceRejection | null {
  if (ownership === "EDITOR_OWNED") return null;
  if (ownership === "TERMINAL_OWNED") {
    return { code: "WORKSPACE_BUSY", message: "terminal read-write owns the leaf: no host file access" };
  }
  return { code: "INVALID_TRANSITION", message: `host file access is barred while ${ownership}` };
}

// Strict text profile (frozen section 12): fatal UTF-8 decode, BOM/NUL/CR and
// lone-surrogate rejection, no normalization, no silent substitution.
const LONE_SURROGATE_PATTERN = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const BOM_BYTES = [0xef, 0xbb, 0xbf];

function decodeStrictUtf8(bytes: Uint8Array): { ok: true; text: string } | { ok: false; rejection: WorkspaceRejection } {
  if (bytes.length >= 3 && bytes[0] === BOM_BYTES[0] && bytes[1] === BOM_BYTES[1] && bytes[2] === BOM_BYTES[2]) {
    return rejected("UNSUPPORTED_TEXT_PROFILE", "byte-order mark is not part of the LF execution profile");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return rejected("UNSUPPORTED_TEXT_PROFILE", "bytes are not valid UTF-8");
  }
  if (text.includes("\0")) {
    return rejected("UNSUPPORTED_TEXT_PROFILE", "NUL is not part of the execution text profile");
  }
  if (text.includes("\r")) {
    return rejected("UNSUPPORTED_TEXT_PROFILE", "CR bytes are not part of the LF execution profile; files keep exact bytes until an explicit edit");
  }
  if (LONE_SURROGATE_PATTERN.test(text)) {
    return rejected("UNSUPPORTED_TEXT_PROFILE", "unpaired surrogates are not part of the execution text profile");
  }
  return { ok: true, text };
}

function encodeStrictUtf8(text: string): { ok: true; bytes: Uint8Array } | { ok: false; rejection: WorkspaceRejection } {
  if (typeof text !== "string") {
    return rejected("INVALID_REQUEST", "content must be text");
  }
  if (text.length > 1024 * 1024) {
    return rejected("RESOURCE_LIMIT", "content exceeds the 1 MiB per-file ceiling");
  }
  if (text.startsWith("﻿")) {
    return rejected("UNSUPPORTED_TEXT_PROFILE", "byte-order mark is not part of the LF execution profile");
  }
  if (text.includes("\0")) {
    return rejected("UNSUPPORTED_TEXT_PROFILE", "NUL is not part of the execution text profile");
  }
  if (text.includes("\r")) {
    return rejected("UNSUPPORTED_TEXT_PROFILE", "CR bytes are not part of the LF execution profile; content must already be LF");
  }
  if (LONE_SURROGATE_PATTERN.test(text)) {
    return rejected("UNSUPPORTED_TEXT_PROFILE", "unpaired surrogates are not part of the execution text profile");
  }
  return { ok: true, bytes: new TextEncoder().encode(text) };
}

/** Opaque file identity from handle facts (never a host path). */
function opaqueFileIdentity(dev: unknown, ino: unknown): string {
  const raw = `win-${String(dev)}-${String(ino)}`;
  const parsed = OpaqueHandleSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  return `win-${sha256HexBytes(new TextEncoder().encode(raw)).slice(0, 32)}`;
}

async function bestEffortUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Staging cleanup is best-effort; the original rejection stays authoritative.
  }
}

// ---------------------------------------------------------------------------
// Adapter factory — validates the trusted binding once, then confines every
// operation to it. Host paths stay in the closure; DTOs never carry them.
// ---------------------------------------------------------------------------

interface RecordedBinding {
  readonly sessionId: string;
  readonly generation: number;
  readonly workspaceId: string;
  readonly leafHost: string;
  readonly leafReal: string;
  readonly stagingHost: string;
  readonly stagingReal: string;
  readonly volumeDev: unknown;
}

function recordBinding(binding: unknown): { ok: true; recorded: RecordedBinding } | { ok: false; rejection: WorkspaceRejection } {
  if (binding === null || typeof binding !== "object") {
    return rejected("INVALID_REQUEST", "adapter binding failed strict validation");
  }
  const record = binding as Record<string, unknown>;
  if (typeof record["sessionId"] !== "string" || record["sessionId"]!.length < 1 || record["sessionId"]!.length > 128) {
    return rejected("INVALID_REQUEST", "binding session id must be 1..128 characters");
  }
  if (!Number.isInteger(record["generation"]) || (record["generation"] as number) < 1) {
    return rejected("INVALID_REQUEST", "binding generation must be a positive integer");
  }
  if (typeof record["workspaceId"] !== "string" || OpaqueHandleSchema.safeParse(record["workspaceId"]).success !== true) {
    return rejected("INVALID_REQUEST", "binding workspace id failed strict validation");
  }
  const leafHost = record["leafHostPath"];
  const stagingHost = record["stagingHostPath"];
  if (typeof leafHost !== "string" || leafHost.length === 0 || leafHost.includes("\0")) {
    return rejected("INVALID_REQUEST", "binding leaf path failed strict validation");
  }
  if (typeof stagingHost !== "string" || stagingHost.length === 0 || stagingHost.includes("\0")) {
    return rejected("INVALID_REQUEST", "binding staging path failed strict validation");
  }
  if (!nodePath.isAbsolute(leafHost) || !nodePath.isAbsolute(stagingHost)) {
    return rejected("WORKSPACE_VIOLATION", "adapter binding paths must be absolute host directories");
  }
  let leafLst;
  let stagingLst;
  try {
    leafLst = lstatSync(leafHost);
    stagingLst = lstatSync(stagingHost);
  } catch {
    return rejected("WORKSPACE_VIOLATION", "adapter binding leaf and staging directories must already exist");
  }
  if (leafLst.isSymbolicLink() || stagingLst.isSymbolicLink()) {
    return rejected("WORKSPACE_VIOLATION", "adapter binding must be physical directories, never links");
  }
  if (!leafLst.isDirectory() || !stagingLst.isDirectory()) {
    return rejected("WORKSPACE_VIOLATION", "adapter binding leaf and staging must be directories");
  }
  let leafReal: string;
  let stagingReal: string;
  try {
    leafReal = realpathSync(leafHost);
    stagingReal = realpathSync(stagingHost);
  } catch {
    return rejected("WORKSPACE_VIOLATION", "adapter binding paths could not be resolved");
  }
  if (!sameAbsolute(leafHost, leafReal) && !insideRoot(leafReal, leafReal)) {
    return rejected("WORKSPACE_VIOLATION", "adapter binding leaf is behind a link");
  }
  if (insideRoot(leafReal, stagingReal) || insideRoot(stagingReal, leafReal) || sameAbsolute(leafReal, stagingReal)) {
    return rejected("WORKSPACE_VIOLATION", "staging must be a sibling outside the guest-visible leaf, never inside it");
  }
  let leafDev: unknown;
  let stagingDev: unknown;
  try {
    leafDev = statSync(leafReal).dev;
    stagingDev = statSync(stagingReal).dev;
  } catch {
    return rejected("WORKSPACE_VIOLATION", "adapter binding volumes could not be observed");
  }
  if (String(leafDev) !== String(stagingDev)) {
    return rejected("WORKSPACE_VIOLATION", "staging must live on the same volume as the leaf for same-volume publication");
  }
  return {
    ok: true,
    recorded: {
      sessionId: record["sessionId"] as string,
      generation: record["generation"] as number,
      workspaceId: record["workspaceId"] as string,
      leafHost: nodePath.normalize(leafHost),
      leafReal: nodePath.normalize(leafReal),
      stagingHost: nodePath.normalize(stagingHost),
      stagingReal: nodePath.normalize(stagingReal),
      volumeDev: leafDev,
    },
  };
}

/** Revalidate leaf and staging provenance (every operation and after awaits). */
async function revalidateProvenance(recorded: RecordedBinding): Promise<WorkspaceRejection | null> {
  let leafLst;
  let stagingLst;
  try {
    leafLst = await lstat(recorded.leafHost);
    stagingLst = await lstat(recorded.stagingHost);
  } catch {
    return { code: "WORKSPACE_VIOLATION", message: "workspace leaf or staging is missing" };
  }
  if (leafLst.isSymbolicLink() || stagingLst.isSymbolicLink()) {
    return { code: "WORKSPACE_VIOLATION", message: "workspace leaf or staging became a link" };
  }
  if (!leafLst.isDirectory() || !stagingLst.isDirectory()) {
    return { code: "WORKSPACE_VIOLATION", message: "workspace leaf or staging is not a directory" };
  }
  let leafReal: string;
  let stagingReal: string;
  try {
    leafReal = nodePath.normalize(await realpath(recorded.leafHost));
    stagingReal = nodePath.normalize(await realpath(recorded.stagingHost));
  } catch {
    return { code: "WORKSPACE_VIOLATION", message: "workspace leaf or staging could not be resolved" };
  }
  if (!sameAbsolute(leafReal, recorded.leafReal) || !sameAbsolute(stagingReal, recorded.stagingReal)) {
    return { code: "WORKSPACE_VIOLATION", message: "workspace leaf or staging moved behind a link" };
  }
  try {
    const leafDev = (await stat(recorded.leafReal)).dev;
    const stagingDev = (await stat(recorded.stagingReal)).dev;
    if (String(leafDev) !== String(recorded.volumeDev) || String(stagingDev) !== String(recorded.volumeDev)) {
      return { code: "WORKSPACE_VIOLATION", message: "workspace volume changed: same-volume publication no longer holds" };
    }
  } catch {
    return { code: "WORKSPACE_VIOLATION", message: "workspace volume could not be observed" };
  }
  return null;
}

interface ResolvedTarget {
  readonly portablePath: string;
  readonly hostPath: string;
  readonly parentHost: string;
  readonly fileName: string;
}

/**
 * Resolve one portable path to a host target with physical confinement.
 * Walks every ancestry component with lstat (links rejected, parents must be
 * real directories), rejects case aliases via directory listings, and keeps
 * the lexical join inside the leaf (prefix-collision safe). Missing parents
 * are reported, never created.
 */
async function resolveConfinedTarget(
  recorded: RecordedBinding,
  portablePath: string,
): Promise<{ ok: true; target: ResolvedTarget } | { ok: false; rejection: WorkspaceRejection }> {
  const segments = portablePath.split("/");
  const hostPath = nodePath.join(recorded.leafHost, ...segments);
  if (!insideRoot(recorded.leafHost, hostPath)) {
    return rejected("WORKSPACE_VIOLATION", "resolved path escapes the workspace leaf");
  }
  let current = recorded.leafHost;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    const next = nodePath.join(current, segment);
    if (!insideRoot(recorded.leafHost, next)) {
      return rejected("WORKSPACE_VIOLATION", "resolved ancestry escapes the workspace leaf");
    }
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch {
      return rejected("FILE_NOT_FOUND", "a parent directory of the file does not exist");
    }
    if (!entries.includes(segment)) {
      const alias = entries.find((entry) => entry.toLowerCase() === segment.toLowerCase());
      if (alias !== undefined) {
        return rejected("WORKSPACE_VIOLATION", "a parent directory differs only by case from an existing entry");
      }
      return rejected("FILE_NOT_FOUND", "a parent directory of the file does not exist");
    }
    let lst;
    try {
      lst = await lstat(next);
    } catch {
      return rejected("FILE_NOT_FOUND", "a parent directory of the file does not exist");
    }
    if (lst.isSymbolicLink()) {
      return rejected("WORKSPACE_VIOLATION", "workspace ancestry contains a link");
    }
    if (!lst.isDirectory()) {
      return rejected("WORKSPACE_VIOLATION", "a parent of the file is not a directory");
    }
    current = next;
  }
  const parentHost = current;
  const fileName = segments[segments.length - 1]!;
  let siblings: string[];
  try {
    siblings = await readdir(parentHost);
  } catch {
    return rejected("FILE_NOT_FOUND", "the parent directory of the file does not exist");
  }
  if (!siblings.includes(fileName)) {
    const alias = siblings.find((entry) => entry.toLowerCase() === fileName.toLowerCase());
    if (alias !== undefined) {
      return rejected("WORKSPACE_VIOLATION", "a file differing only by case already exists on this volume");
    }
  }
  return { ok: true, target: { portablePath, hostPath, parentHost, fileName } };
}

interface ObservedFile {
  readonly exists: boolean;
  readonly bytes: Uint8Array | null;
  readonly digest: string | null;
  readonly identity: string | null;
}

/** Observe the live target without following links (regular files only). */
async function observeLiveTarget(
  recorded: RecordedBinding,
  target: ResolvedTarget,
): Promise<{ ok: true; observed: ObservedFile } | { ok: false; rejection: WorkspaceRejection }> {
  let lst;
  try {
    lst = await lstat(target.hostPath);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") {
      return { ok: true, observed: { exists: false, bytes: null, digest: null, identity: null } };
    }
    return rejected("SAVE_FAILED", "the file could not be observed before publication");
  }
  if (lst.isSymbolicLink()) {
    return rejected("WORKSPACE_VIOLATION", "the file is a link");
  }
  if (lst.isDirectory()) {
    return rejected("WORKSPACE_VIOLATION", "a directory exists where a file was expected");
  }
  if (!lst.isFile()) {
    return rejected("WORKSPACE_VIOLATION", "unsupported file type where a regular file was expected");
  }
  const nlink = (lst as { nlink?: unknown }).nlink;
  if (typeof nlink === "number" && nlink !== 1) {
    return rejected("WORKSPACE_VIOLATION", "hardlink targets are not supported");
  }
  if (typeof nlink === "bigint" && nlink !== 1n) {
    return rejected("WORKSPACE_VIOLATION", "hardlink targets are not supported");
  }
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(target.hostPath, "r");
    const felt = await handle.stat();
    if (!felt.isFile()) {
      return rejected("WORKSPACE_VIOLATION", "unsupported file type where a regular file was expected");
    }
    const handleNlink = (felt as { nlink?: unknown }).nlink;
    if (typeof handleNlink === "number" && handleNlink !== 1) {
      return rejected("WORKSPACE_VIOLATION", "hardlink targets are not supported");
    }
    if (typeof handleNlink === "bigint" && handleNlink !== 1n) {
      return rejected("WORKSPACE_VIOLATION", "hardlink targets are not supported");
    }
    const bytes = new Uint8Array(await handle.readFile());
    const realTarget = nodePath.normalize(await realpath(target.hostPath));
    if (!insideRoot(recorded.leafReal, realTarget)) {
      return rejected("WORKSPACE_VIOLATION", "the file resolves outside the workspace leaf");
    }
    return {
      ok: true,
      observed: {
        exists: true,
        bytes,
        digest: sha256HexBytes(bytes),
        identity: opaqueFileIdentity((felt as { dev?: unknown }).dev, (felt as { ino?: unknown }).ino),
      },
    };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") {
      return { ok: true, observed: { exists: false, bytes: null, digest: null, identity: null } };
    }
    if (error instanceof Error && "rejection" in (error as unknown as Record<string, unknown>)) throw error;
    return rejected("SAVE_FAILED", "the file could not be read before publication");
  } finally {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        // Observation cleanup is best-effort.
      }
    }
  }
}

/** Create the adapter behind a validated binding (host paths stay in main). */
export function openWindowsFileAdapter(binding: WindowsAdapterBinding): AdapterOutcome<WindowsFileAdapter> {
  const recordedOutcome = recordBinding(binding);
  if (!recordedOutcome.ok) return recordedOutcome;
  const recorded = recordedOutcome.recorded;
  const bindingFacts = { sessionId: recorded.sessionId, generation: recorded.generation, workspaceId: recorded.workspaceId };

  async function readDocument(authority: AdapterAuthority, portablePath: string): Promise<AdapterOutcome<ReadDocumentResult>> {
    const authorityCheck = checkAuthority(authority, bindingFacts);
    if (!authorityCheck.ok) return authorityCheck;
    const ownershipProblem = checkOwnershipForFileAccess(authorityCheck.value.ownership);
    if (ownershipProblem !== null) return { ok: false, rejection: ownershipProblem };
    const pathCheck = checkPortablePath(portablePath);
    if (!pathCheck.ok) return pathCheck;
    const provenance = await revalidateProvenance(recorded);
    if (provenance !== null) return { ok: false, rejection: provenance };
    const resolved = await resolveConfinedTarget(recorded, pathCheck.path);
    if (!resolved.ok) return resolved;
    const observed = await observeLiveTarget(recorded, resolved.target);
    if (!observed.ok) return observed;
    if (!observed.observed.exists || observed.observed.bytes === null) {
      return { ok: false, rejection: { code: "FILE_NOT_FOUND", message: "the file does not exist" } };
    }
    const decoded = decodeStrictUtf8(observed.observed.bytes);
    if (!decoded.ok) return decoded;
    const bytes = observed.observed.bytes;
    return {
      ok: true,
      value: {
        portable_path: resolved.target.portablePath,
        exists: true,
        byte_length: bytes.length,
        digest: sha256HexBytes(bytes),
        file_identity: observed.observed.identity ?? opaqueFileIdentity("unknown", `${bytes.length}`),
        content: decoded.text,
      },
    };
  }

  async function publishDocument(authority: AdapterAuthority, args: PublishArgs): Promise<AdapterOutcome<PublishDocumentResult>> {
    const authorityCheck = checkAuthority(authority, bindingFacts);
    if (!authorityCheck.ok) return authorityCheck;
    const ownershipProblem = checkOwnershipForFileAccess(authorityCheck.value.ownership);
    if (ownershipProblem !== null) return { ok: false, rejection: ownershipProblem };
    if (args === null || typeof args !== "object") {
      return rejected("INVALID_REQUEST", "publication arguments failed strict validation");
    }
    const candidate = args as unknown as Record<string, unknown>;
    if (candidate["mode"] !== "create" && candidate["mode"] !== "replace") {
      return rejected("INVALID_REQUEST", "publication mode must be exactly create or replace");
    }
    const mode = candidate["mode"] as PublishMode;
    const pathCheck = checkPortablePath(candidate["portablePath"]);
    if (!pathCheck.ok) return pathCheck;
    const expectedRaw = candidate["expected"];
    if (expectedRaw === null || typeof expectedRaw !== "object") {
      return rejected("INVALID_REQUEST", "expected preimage failed strict validation");
    }
    const expectedRecord = expectedRaw as Record<string, unknown>;
    if (typeof expectedRecord["exists"] !== "boolean") {
      return rejected("INVALID_REQUEST", "expected preimage failed strict validation");
    }
    const expected: ExpectedPreimage = {
      exists: expectedRecord["exists"] as boolean,
      digest: (expectedRecord["digest"] as string | null) ?? null,
    };
    if (!expected.exists && expected.digest !== null) {
      return rejected("INVALID_REQUEST", "an absent preimage must carry a null digest");
    }
    if (expected.exists && (typeof expected.digest !== "string" || expected.digest.length !== 64)) {
      return rejected("INVALID_REQUEST", "a present preimage must carry its digest");
    }
    if (mode === "create" && expected.exists) {
      return rejected("INVALID_REQUEST", "creation expects an absent preimage");
    }
    const encoded = encodeStrictUtf8(candidate["content"] as string);
    if (!encoded.ok) return encoded;
    const intended = new Uint8Array(encoded.bytes);
    const intendedDigest = sha256HexBytes(intended);

    const provenance = await revalidateProvenance(recorded);
    if (provenance !== null) return { ok: false, rejection: provenance };
    const resolved = await resolveConfinedTarget(recorded, pathCheck.path);
    if (!resolved.ok) return resolved;
    const target = resolved.target;

    const before = await observeLiveTarget(recorded, target);
    if (!before.ok) return before;
    const actual = before.observed;
    if (mode === "create") {
      if (actual.exists) {
        return { ok: false, rejection: { code: "FILE_EXISTS", message: "the file already exists: creation never overwrites" } };
      }
    } else {
      if (!actual.exists || actual.bytes === null || actual.digest === null) {
        if (expected.exists) {
          return { ok: false, rejection: { code: "EXTERNAL_MODIFICATION_CONFLICT", message: "the file was removed after the observed preimage" } };
        }
        return { ok: false, rejection: { code: "FILE_NOT_FOUND", message: "the file does not exist" } };
      }
      if (!expected.exists) {
        return { ok: false, rejection: { code: "EXTERNAL_MODIFICATION_CONFLICT", message: "the file appeared after the observed preimage" } };
      }
      if (expected.digest !== actual.digest) {
        return { ok: false, rejection: { code: "EXTERNAL_MODIFICATION_CONFLICT", message: "the file changed after the observed preimage" } };
      }
    }
    if (mode === "replace" && expected.exists && actual.exists && expected.digest !== actual.digest) {
      return { ok: false, rejection: { code: "EXTERNAL_MODIFICATION_CONFLICT", message: "the file changed after the observed preimage" } };
    }

    // Private staging on the same volume, never inside the leaf, never at a
    // caller-chosen name. CREATE_NEW exclusively: no silent overwrite.
    const stageName = `${STAGING_FILE_PREFIX}${randomBytes(16).toString("hex")}.tmp`;
    const stagePath = nodePath.join(recorded.stagingHost, stageName);
    if (!insideRoot(recorded.stagingHost, stagePath)) {
      return rejected("WORKSPACE_VIOLATION", "staging escaped its owned directory");
    }
    let stageHandle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      stageHandle = await open(stagePath, "wx", 0o600);
      await stageHandle.writeFile(intended);
      await stageHandle.sync();
    } catch {
      if (stageHandle !== null) {
        try {
          await stageHandle.close();
        } catch {
          // Staging cleanup is best-effort.
        }
      }
      await bestEffortUnlink(stagePath);
      return { ok: false, rejection: { code: "SAVE_FAILED", message: "staging the complete bytes failed; the destination is unchanged" } };
    }
    try {
      await stageHandle.close();
    } catch {
      await bestEffortUnlink(stagePath);
      return { ok: false, rejection: { code: "SAVE_FAILED", message: "staging the complete bytes failed; the destination is unchanged" } };
    }
    stageHandle = null;
    try {
      const staged = new Uint8Array(await readFile(stagePath));
      if (staged.length !== intended.length || sha256HexBytes(staged) !== intendedDigest) {
        await bestEffortUnlink(stagePath);
        return { ok: false, rejection: { code: "SAVE_FAILED", message: "staging verification failed; the destination is unchanged" } };
      }
    } catch {
      await bestEffortUnlink(stagePath);
      return { ok: false, rejection: { code: "SAVE_FAILED", message: "staging verification failed; the destination is unchanged" } };
    }

    // Revalidate under the same serialization before the commit point: a
    // reset, close, revocation or ownership change that landed during staging
    // aborts with staging removed and the destination untouched. The target
    // preimage is read a second time so an external change during staging
    // also fails closed instead of overwriting.
    let liveAuthority = authorityCheck.value;
    if (typeof candidate["revalidate"] === "function") {
      try {
        liveAuthority = (candidate["revalidate"] as () => AdapterAuthority)();
      } catch {
        await bestEffortUnlink(stagePath);
        return { ok: false, rejection: { code: "WORKSPACE_REVOKED", message: "publication fence could not be revalidated; staging was discarded" } };
      }
    }
    const fenceCheck = checkAuthority(liveAuthority, bindingFacts);
    if (!fenceCheck.ok) {
      await bestEffortUnlink(stagePath);
      return fenceCheck;
    }
    const fenceOwnership = checkOwnershipForFileAccess(fenceCheck.value.ownership);
    if (fenceOwnership !== null) {
      await bestEffortUnlink(stagePath);
      return { ok: false, rejection: fenceOwnership };
    }
    const fenceProvenance = await revalidateProvenance(recorded);
    if (fenceProvenance !== null) {
      await bestEffortUnlink(stagePath);
      return { ok: false, rejection: fenceProvenance };
    }
    const again = await observeLiveTarget(recorded, target);
    if (!again.ok) {
      await bestEffortUnlink(stagePath);
      return again;
    }
    if (mode === "create" && again.observed.exists) {
      await bestEffortUnlink(stagePath);
      return { ok: false, rejection: { code: "FILE_EXISTS", message: "the file appeared before publication: creation never overwrites" } };
    }
    if (mode === "replace") {
      if (!again.observed.exists || again.observed.digest === null) {
        await bestEffortUnlink(stagePath);
        return { ok: false, rejection: { code: "EXTERNAL_MODIFICATION_CONFLICT", message: "the file changed during staging" } };
      }
      if (again.observed.digest !== expected.digest || again.observed.digest !== actual.digest) {
        await bestEffortUnlink(stagePath);
        return { ok: false, rejection: { code: "EXTERNAL_MODIFICATION_CONFLICT", message: "the file changed during staging" } };
      }
    }

    // The commit point: one same-volume rename of the complete file. Never a
    // copy/delete fallback and never a direct chunked write to the target, so
    // observers see either the old complete file or the new complete file.
    try {
      await rename(stagePath, target.hostPath);
    } catch {
      await bestEffortUnlink(stagePath);
      return { ok: false, rejection: { code: "SAVE_FAILED", message: "publication failed before the commit point; the destination is unchanged" } };
    }

    // Byte verification after the commit point: reopen through the confined
    // provider and compare exact bytes. Uncertainty here freezes (the new
    // file may already be observable); it is never silently rolled back.
    // The diagnostics seam below corrupts one committed byte first so tests
    // can prove the detector; production never sets it.
    if (candidate["diagnosticsCorruptAfterRename"] === true) {
      try {
        const current = new Uint8Array(await readFile(target.hostPath));
        const mutated = Uint8Array.from(current.length > 0 ? current : new Uint8Array([0x00]));
        mutated[0] = mutated[0] === 0x41 ? 0x42 : 0x41;
        await writeFile(target.hostPath, mutated);
        // FlushFileBuffers requires write access on Windows, so the drain
        // handle opens read/write (the file is adapter-owned at this point).
        const drain = await open(target.hostPath, "r+");
        try {
          await drain.sync();
        } finally {
          await drain.close();
        }
      } catch {
        return { ok: false, rejection: { code: "COMMIT_UNCERTAIN", message: "publication succeeded but verification is uncertain; session freezes with evidence retained" } };
      }
    }
    let publishedHandle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      const committed = await observeLiveTarget(recorded, target);
      if (!committed.ok || !committed.observed.exists || committed.observed.bytes === null) {
        return { ok: false, rejection: { code: "COMMIT_UNCERTAIN", message: "publication succeeded but the committed file could not be verified; session freezes with evidence retained" } };
      }
      if (committed.observed.bytes.length !== intended.length || committed.observed.digest !== intendedDigest) {
        return { ok: false, rejection: { code: "COMMIT_UNCERTAIN", message: "publication succeeded but the committed bytes differ; session freezes with evidence retained" } };
      }
      // Durability flush of the published file. Windows FlushFileBuffers
      // requires a write-capable handle, so this opens read/write without
      // truncation (the file already exists; "r+" never creates).
      publishedHandle = await open(target.hostPath, "r+");
      await publishedHandle.sync();
      await publishedHandle.close();
      publishedHandle = null;
      return {
        ok: true,
        value: {
          portable_path: target.portablePath,
          byte_length: intended.length,
          digest: intendedDigest,
          file_identity: committed.observed.identity ?? opaqueFileIdentity("unknown", `${intended.length}`),
          mode,
        },
      };
    } catch {
      return { ok: false, rejection: { code: "COMMIT_UNCERTAIN", message: "publication succeeded but verification is uncertain; session freezes with evidence retained" } };
    } finally {
      if (publishedHandle !== null) {
        try {
          await publishedHandle.close();
        } catch {
          // Verification-handle cleanup is best-effort.
        }
      }
    }
  }

  return { ok: true, value: { adapterVersion: 1, sessionId: recorded.sessionId, generation: recorded.generation, workspaceId: recorded.workspaceId, readDocument, publishDocument } };
}
