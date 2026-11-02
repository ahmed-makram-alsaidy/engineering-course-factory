// Guest supervisor protocol — supervisor_protocol_version = 1.
//
// Frame DTOs for the single attached CLI connection between the Docker host
// and the in-container supervisor (docs/P5-DESIGN-SPEC.md, "Transport").
// Shared pure DTOs: the same schemas validate frames on both sides of the
// pipe, so host and guest can never drift. Frames are line-delimited JSON
// over the attached stdio; supervisor stdout is frames only, and Docker/
// supervisor stderr is diagnostics — never lesson output.
//
// Frame sequencing: frames carry a per-direction `seq` (each side numbers
// independently, strictly increasing from 1); the transport checks it before
// translating frames into runtime events (P5.4+).
//
// Version/session/generation discipline: the guest emits `hello` on boot
// (no session identity exists yet), the host sends exactly one `init`
// carrying session/generation and the pinned image digest; the supervisor
// validates/freezes/acknowledges the digest. P5.5 (canonical task
// "Registry/groups") extends the post-init host frame set additively under
// the SAME supervisor_protocol_version = 1, exactly as the design's transport
// section lists: start/stop/heartbeat/shutdown requests carry identifiers
// (and the already-validated command/cwd/env for starts) only; the guest
// answers with process_started/process_output/process_exit/process_stopped/
// process_failed/shutdown_ack frames. OS PIDs/PGIDs are runtime-internal:
// they appear ONLY in the guest->host process_started frame (host-private
// bookkeeping) and never in any renderer-facing contract.
//
// This module is pure: schemas and constants only, no I/O. Its only non-relative
// import is the shared protocol authority in ../src/protocol.ts (also pure).

import { z } from "zod";
import { DigestSchema, IdentifierSchema, OutputStreamSchema } from "../src/protocol.ts";

/** Guest supervisor protocol version, validated in the hello/init handshake. */
export const SUPERVISOR_PROTOCOL_VERSION = 1;

/**
 * Frame size limits (design: "Init max 1 MiB; other frames 64 KiB; output
 * payload 16 KiB"). The adapter enforces these on raw bytes before parsing;
 * oversized frames are a protocol failure (teardown), never truncation.
 */
export const SUPERVISOR_FRAME_LIMITS = Object.freeze({
  /** Maximum byte length of the init frame. */
  init_max_bytes: 1_048_576,
  /** Maximum byte length of every other frame. */
  frame_max_bytes: 65_536,
  /** Maximum byte length of a translated output payload (host-side check). */
  output_payload_max_bytes: 16_384,
} as const);

/**
 * Supervisor timing (design "Container Lifecycle"): heartbeat every 2 s;
 * guest monotonic 15 s lease starts at boot and is renewed only by valid
 * host traffic of the correct generation; on missing init/EOF/malformed
 * control/expiry the supervisor exits within 5 s.
 */
export const SUPERVISOR_TIMING = Object.freeze({
  heartbeat_interval_ms: 2_000,
  lease_ms: 15_000,
  shutdown_deadline_ms: 5_000,
} as const);

const FrameSeqSchema = z.number().int().min(1);

/**
 * Guest cwd rule (belt-and-braces; the host already resolves the authored cwd
 * through the trusted workspace layer): pure POSIX below /workspace, and no
 * dot segment of any kind. The container view of the session workspace is
 * always /workspace (P5.3).
 */
export const GUEST_CWD_PATTERN = /^\/workspace(\/[A-Za-z0-9_. -]+)*$/;
const GuestCwdSchema = z.string().regex(GUEST_CWD_PATTERN);

/** Environment names a start_process frame may forward (host allowlist values only). */
export const GUEST_ENV_FORWARDABLE = Object.freeze(["LC_ALL", "TZ", "NO_COLOR"] as const);

const HostSeqSchema = z.number().int().min(1);

// -- guest -> host -----------------------------------------------------------

/** First frame the guest emits on boot; proves the bundle and protocol version before init. */
export const HelloFrameSchema = z.strictObject({
  type: z.literal("hello"),
  seq: FrameSeqSchema,
  supervisor_protocol_version: z.literal(SUPERVISOR_PROTOCOL_VERSION),
  node_major: z.number().int().min(0),
  node_version: z.string().min(1),
});

/** Acknowledgement: the supervisor validated and froze the init configuration. */
export const InitAckFrameSchema = z.strictObject({
  type: z.literal("init_ack"),
  seq: FrameSeqSchema,
  session_id: IdentifierSchema,
  generation: z.number().int().min(1),
  image_digest: DigestSchema,
});

/** Guest liveness frame (every 2 s); carries the guest monotonic clock value. */
export const HeartbeatFrameSchema = z.strictObject({
  type: z.literal("heartbeat"),
  seq: FrameSeqSchema,
  session_id: IdentifierSchema,
  generation: z.number().int().min(1),
  monotonic_ms: z.number().int().min(0),
});

/** Guest diagnostic frame emitted before a protocol/lease failure exit. */
export const GuestErrorFrameSchema = z.strictObject({
  type: z.literal("error"),
  seq: FrameSeqSchema,
  session_id: IdentifierSchema.nullable(),
  generation: z.number().int().min(1).nullable(),
  code: z.string().min(1),
  message: z.string().min(1),
});

// -- P5.5 guest -> host process frames ----------------------------------------

/**
 * Authoritative guest acknowledgment that a managed process was created in a
 * controlled process group. The host registry must not claim RUNNING before
 * this frame (design: "The registry must not claim RUNNING until the guest
 * confirms process creation"). pid/pgid are RUNTIME-ONLY values: private
 * host/guest bookkeeping, never lesson/renderer identity.
 */
export const ProcessStartedFrameSchema = z.strictObject({
  type: z.literal("process_started"),
  seq: FrameSeqSchema,
  process_id: IdentifierSchema,
  attempt_id: IdentifierSchema,
  pid: z.number().int().min(1),
  pgid: z.number().int().min(1),
});

/** One decoded stdout/stderr chunk, bounded to output_payload_max_bytes. */
export const ProcessOutputFrameSchema = z.strictObject({
  type: z.literal("process_output"),
  seq: FrameSeqSchema,
  process_id: IdentifierSchema,
  stream: OutputStreamSchema,
  text: z.string(),
  /** Per-stream byte offset of this chunk (guest-side incremental UTF-8 decode). */
  stream_offset: z.number().int().min(0),
});

/**
 * Natural (unstopped) process exit: the actual code, or null + signal name.
 * No invented codes. Sent AFTER the pipes drained (design: "Actual exit plus
 * pipe close/drain before completion").
 */
export const ProcessExitFrameSchema = z.strictObject({
  type: z.literal("process_exit"),
  seq: FrameSeqSchema,
  process_id: IdentifierSchema,
  exit_code: z.number().int().min(0).max(255).nullable(),
  signal: z.string().min(1).nullable(),
  duration_ms: z.number().int().min(0),
});

/**
 * Confirmed death of a stopped process group (graceful or forced). `forced`
 * is true only when the group survived the graceful signal and was SIGKILLed.
 */
export const ProcessStoppedFrameSchema = z.strictObject({
  type: z.literal("process_stopped"),
  seq: FrameSeqSchema,
  process_id: IdentifierSchema,
  forced: z.boolean(),
  exit_code: z.number().int().min(0).max(255).nullable(),
  signal: z.string().min(1).nullable(),
  duration_ms: z.number().int().min(0),
});

/**
 * Guest-declared process failure with a canonical code. The guest always
 * kills the group before reporting. OUTPUT_LIMIT is the per-process decoded
 * output bound; UNEXPECTED_DESCENDANTS (P5.7) classifies a FOREGROUND group
 * whose direct command exited while owned descendants were still alive —
 * the supervisor force-kills the residual group and verifies its death
 * BEFORE reporting, so the host may treat the frame as terminal.
 */
export const ProcessFailedFrameSchema = z.strictObject({
  type: z.literal("process_failed"),
  seq: FrameSeqSchema,
  process_id: IdentifierSchema,
  code: z.enum(["OUTPUT_LIMIT", "UNEXPECTED_DESCENDANTS"]),
  message: z.string().min(1),
});

/** The supervisor stopped all managed groups in response to `shutdown`. */
export const ShutdownAckFrameSchema = z.strictObject({
  type: z.literal("shutdown_ack"),
  seq: FrameSeqSchema,
});

// -- host -> guest -----------------------------------------------------------

/**
 Bounded initialization: session identity plus the pinned runtime image
 digest the supervisor must acknowledge. Later P5 tasks (admission P5.2,
 transport P5.4) extend the init payload with the already-admitted operation
 map, relative cwd and policy — additive fields under the same version.
 */
export const InitFrameSchema = z.strictObject({
  type: z.literal("init"),
  seq: FrameSeqSchema,
  session_id: IdentifierSchema,
  generation: z.number().int().min(1),
  image_digest: DigestSchema,
});

// -- P5.5 host -> guest control frames (identifiers + validated content only) --

/**
 * P5.7 execution mode of one managed process group (additive under the SAME
 * supervisor_protocol_version = 1; absent = "background" so P5.5 frames keep
 * parsing). The mode selects the guest completion policy:
 *   - background: the group's lifetime is host-managed (start/stop frames);
 *   - foreground: the direct command's exit is only PART of completion — the
 *     supervisor verifies that the WHOLE group is gone before reporting, and
 *     classifies residual owned descendants (process_failed
 *     UNEXPECTED_DESCENDANTS). The deadline itself stays host-owned.
 */
export const ProcessModeSchema = z.enum(["background", "foreground"]);

/**
 * Start one managed background process in a controlled guest process group.
 * The command is the EXACT authored command (trusted host -> guest; the
 * renderer can never supply it). cwd is the resolved container-relative
 * workspace path (null = /workspace root). env carries ONLY the host
 * environment plan's allowlisted forwardable entries; the supervisor
 * reconstructs the fixed guest env itself (design "Environment Policy").
 */
export const StartProcessFrameSchema = z.strictObject({
  type: z.literal("start_process"),
  seq: HostSeqSchema,
  process_id: IdentifierSchema,
  attempt_id: IdentifierSchema,
  command: z.string().min(1).max(16_384),
  cwd: GuestCwdSchema.nullable(),
  env: z
    .array(
      z.strictObject({
        name: z.enum(GUEST_ENV_FORWARDABLE),
        value: z.string().max(1024),
      }),
    )
    .max(GUEST_ENV_FORWARDABLE.length),
  mode: ProcessModeSchema.optional(),
});

/** Gracefully stop one managed process group (guest applies grace + force). */
export const StopProcessFrameSchema = z.strictObject({
  type: z.literal("stop_process"),
  seq: HostSeqSchema,
  process_id: IdentifierSchema,
});

/**
 * Host lease renewal / liveness (every heartbeat_interval_ms). Any valid
 * host frame of the correct generation renews the guest lease; this frame is
 * the steady-state renewal the healthy host sends while the session lives.
 */
export const HostHeartbeatFrameSchema = z.strictObject({
  type: z.literal("heartbeat"),
  seq: HostSeqSchema,
  session_id: IdentifierSchema,
  generation: z.number().int().min(1),
});

/** Request bounded supervisor shutdown: stop all groups, ack, exit within 5 s. */
export const ShutdownFrameSchema = z.strictObject({
  type: z.literal("shutdown"),
  seq: HostSeqSchema,
});

export type HelloFrame = z.infer<typeof HelloFrameSchema>;
export type InitAckFrame = z.infer<typeof InitAckFrameSchema>;
export type HeartbeatFrame = z.infer<typeof HeartbeatFrameSchema>;
export type GuestErrorFrame = z.infer<typeof GuestErrorFrameSchema>;
export type ProcessStartedFrame = z.infer<typeof ProcessStartedFrameSchema>;
export type ProcessOutputFrame = z.infer<typeof ProcessOutputFrameSchema>;
export type ProcessExitFrame = z.infer<typeof ProcessExitFrameSchema>;
export type ProcessStoppedFrame = z.infer<typeof ProcessStoppedFrameSchema>;
export type ProcessFailedFrame = z.infer<typeof ProcessFailedFrameSchema>;
export type ShutdownAckFrame = z.infer<typeof ShutdownAckFrameSchema>;
export type InitFrame = z.infer<typeof InitFrameSchema>;
export type StartProcessFrame = z.infer<typeof StartProcessFrameSchema>;
export type StopProcessFrame = z.infer<typeof StopProcessFrameSchema>;
export type HostHeartbeatFrame = z.infer<typeof HostHeartbeatFrameSchema>;
export type ShutdownFrame = z.infer<typeof ShutdownFrameSchema>;

/**
 * Frames the guest sends to the host. The hello/init/lease scaffold frames
 * (P5.1) plus the P5.5 process frames.
 */
export type GuestFrame =
  | HelloFrame
  | InitAckFrame
  | HeartbeatFrame
  | GuestErrorFrame
  | ProcessStartedFrame
  | ProcessOutputFrame
  | ProcessExitFrame
  | ProcessStoppedFrame
  | ProcessFailedFrame
  | ShutdownAckFrame;

/**
 * Frames the host sends to the guest: the one init plus the P5.5 control set
 * (start/stop/heartbeat/shutdown — identifiers and already-validated content
 * only).
 */
export type HostFrame = InitFrame | HostHeartbeatFrame | StartProcessFrame | StopProcessFrame | ShutdownFrame;

/** Guest frame dispatch union (strict: unknown/malformed frames fail closed). */
export const GuestFrameSchema: z.ZodType<GuestFrame> = z.union([
  HelloFrameSchema,
  InitAckFrameSchema,
  HeartbeatFrameSchema,
  GuestErrorFrameSchema,
  ProcessStartedFrameSchema,
  ProcessOutputFrameSchema,
  ProcessExitFrameSchema,
  ProcessStoppedFrameSchema,
  ProcessFailedFrameSchema,
  ShutdownAckFrameSchema,
]);

/** Host frame dispatch union (strict keys; no arbitrary execution frame exists). */
export const HostFrameSchema: z.ZodType<HostFrame> = z.union([
  InitFrameSchema,
  HostHeartbeatFrameSchema,
  StartProcessFrameSchema,
  StopProcessFrameSchema,
  ShutdownFrameSchema,
]);

/** Frozen session configuration after a valid init. */
export interface FrozenSession {
  session_id: string;
  generation: number;
  image_digest: string;
}

/**
 * Byte-limit verdict for a raw inbound frame line, enforced by the adapter
 * before JSON parsing. Init is allowed up to init_max_bytes; every other
 * frame is limited to frame_max_bytes; anything beyond init_max_bytes is
 * rejected outright (fail/teardown, never truncation).
 */
export function checkFrameByteLimit(byteLength: number, type: string | null): "ok" | "oversized" {
  if (byteLength > SUPERVISOR_FRAME_LIMITS.init_max_bytes) return "oversized";
  if (type === "init") return "ok";
  if (byteLength > SUPERVISOR_FRAME_LIMITS.frame_max_bytes) return "oversized";
  return "ok";
}
