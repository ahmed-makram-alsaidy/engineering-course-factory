// P9.5 recording Main-side glue — production dependency assembly for
// RecordingHost (Electron Main only, never the renderer).
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 4, 7, 12, 20 and
// docs/adr/ADR-0014-screen-recording-boundary.md.
//
// OWNERSHIP (design-exact, no phase creep):
//   - NodeTakeFileSink: trusted temp take storage under
//     <tempRoot>/recording/<recording_session_id>/<take_id>/ (temp class).
//     Anchors sidecar lines are appended UTF-8 with LF and no BOM, one
//     write per line; the P9.4 writer bounds (4 KiB/line, 5 MiB total) stay
//     enforced by the coordinator before every append. Never the final
//     delivery root, never committed media.
//   - Bundled-addon loader: the P9.2 N-API module must load under the real
//     production Electron Main bundle (esbuild CJS), where import.meta is
//     unavailable. Falls back to __dirname-anchored candidate paths and
//     validates the fixed narrow surface before handing the driver over.
//     Renderer code can never reach this module.
//   - Production assembly: registry + native driver + real capture session
//     + real encoder owner + real timeline + probed descriptor + native
//     readback bytes. No fake capture, no fake encoder, no synthetic bytes.

import { mkdirSync, appendFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { assertConfinedTempTarget } from "../../../engine/recording/src/encoder/encoder-interface.ts";
import {
  loadNativeWgcAddon,
  NativeWgcDriver,
} from "../../../engine/recording/src/capture/native-loader.ts";
import { TrustedCaptureSourceRegistry } from "../../../engine/recording/src/capture/trusted-source.ts";
import { WgcCaptureSession } from "../../../engine/recording/src/capture/wgc-session.ts";
import { RecordingTimelineCoordinator } from "../../../engine/recording/src/timeline-coordinator.ts";
import { NativeReadbackAdapter } from "../../../engine/recording/src/encoder/frame-bytes.ts";
import { EncoderHostSession } from "../../../engine/recording/host/encoder-host.ts";
import { SystemMonotonicClock } from "@course-factory/runtime-orchestrator";
import {
  realRecordingScheduler,
  type RecordingHostDeps,
  type ResolvedRecordingWindow,
  type TakeFileSink,
} from "./recording-host.ts";
import type { EncoderDescriptor } from "../../../engine/recording/src/encoder-profile.ts";

// ---------------------------------------------------------------------------
// Trusted temp take storage (node:fs, Main-side only)
// ---------------------------------------------------------------------------

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TAKE_ID_RE = /^t\d{2,}$/;

/** Sidecar file name for the physical anchors JSONL (relative only). */
export const ANCHORS_FILE_NAME = "anchors.jsonl";

export class NodeTakeFileSink implements TakeFileSink {
  private readonly tempRoot: string;

  constructor(tempRoot: string) {
    if (typeof tempRoot !== "string" || tempRoot.length === 0) {
      throw new Error("[INVALID_REQUEST] temp root must be non-empty");
    }
    this.tempRoot = tempRoot;
  }

  createTakeDir(recordingSessionId: string, takeId: string): string {
    if (!SESSION_ID_RE.test(recordingSessionId) || !TAKE_ID_RE.test(takeId)) {
      throw new Error("[INVALID_REQUEST] take identity is not trusted");
    }
    assertConfinedTempTarget(this.tempRoot, recordingSessionId, takeId);
    const rootResolved = resolve(this.tempRoot);
    const dir = resolve(rootResolved, "recording", recordingSessionId, takeId);
    if (dir !== join(rootResolved, "recording", recordingSessionId, takeId)) {
      throw new Error("[INVALID_REQUEST] temp target failed containment");
    }
    if (!dir.startsWith(rootResolved + sep)) {
      throw new Error("[INVALID_REQUEST] temp target escapes trusted root");
    }
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  appendAnchorLine(takeDir: string, lineWithLf: string): void {
    const rootResolved = resolve(this.tempRoot);
    const dirResolved = resolve(takeDir);
    if (dirResolved !== takeDir && dirResolved !== resolve(takeDir)) {
      throw new Error("[INVALID_REQUEST] take dir failed containment");
    }
    if (!dirResolved.startsWith(rootResolved + sep)) {
      throw new Error("[INVALID_REQUEST] take dir escapes trusted root");
    }
    if (typeof lineWithLf !== "string" || !lineWithLf.endsWith("\n")) {
      throw new Error("[INVALID_REQUEST] anchor line must be LF-terminated");
    }
    appendFileSync(join(dirResolved, ANCHORS_FILE_NAME), lineWithLf, "utf8");
  }

  removeTakeDir(takeDir: string): void {
    const rootResolved = resolve(this.tempRoot);
    const dirResolved = resolve(takeDir);
    if (!dirResolved.startsWith(rootResolved + sep)) {
      throw new Error("[INVALID_REQUEST] take dir escapes trusted root");
    }
    rmSync(dirResolved, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Native addon loading under the production Electron Main bundle
// ---------------------------------------------------------------------------

export type WgcDriverLoad =
  | { readonly loaded: true; readonly driver: NativeWgcDriver; readonly via: "standard" | "bundled" }
  | { readonly loaded: false; readonly reason: string };

/**
 * Candidate addon paths for a bundled Electron Main entry (dist/main).
 * Pure: unit-tested without touching the filesystem or native code.
 */
export function resolveBundledAddonCandidates(mainDir: string): string[] {
  // Production bundle base: <repo>/apps/teaching-ide/dist/main, so the
  // repository root is FOUR levels up (main -> dist -> teaching-ide ->
  // apps -> repo). Three levels reached <repo>/apps and constructed the
  // nonexistent <repo>/apps/engine/... (P9.5 corrective repair: the
  // terminal/editor hosts in main.ts already use four levels).
  const repoAnchored = resolve(
    mainDir,
    "..",
    "..",
    "..",
    "..",
    "engine",
    "recording",
    "native",
    "wgc",
    "build",
    "Release",
    "wgc_capture.node",
  );
  return [repoAnchored];
}

/** Validates one loaded module against the fixed narrow driver surface. */
export function driverFromModule(candidate: unknown): NativeWgcDriver | null {
  try {
    return new NativeWgcDriver(candidate);
  } catch {
    return null;
  }
}

export interface MainRequireFn {
  (path: string): unknown;
}

/**
 * Loads the P9.2 N-API driver for Electron Main use. Tries the standard
 * node loader first (plain node, unit harnesses), then __dirname-anchored
 * candidates for the bundled production entry where import.meta is
 * unavailable. Never throws for a missing/invalid binary: callers receive
 * a closed { loaded:false } fact. Main-side only.
 */
export function loadWgcDriverForMain(
  mainDir: string,
  requireFn?: MainRequireFn,
): WgcDriverLoad {
  try {
    const standard = loadNativeWgcAddon();
    if (standard.loaded) {
      return { loaded: true, driver: standard.driver, via: "standard" };
    }
  } catch {
    // Fall through to the bundled candidates below.
  }
  let requireImpl: MainRequireFn;
  if (requireFn !== undefined) {
    requireImpl = requireFn;
  } else {
    try {
      requireImpl = createRequire(join(mainDir, "main.js"));
    } catch {
      return { loaded: false, reason: "module require is unavailable" };
    }
  }
  for (const full of resolveBundledAddonCandidates(mainDir)) {
    let candidate: unknown;
    try {
      candidate = requireImpl(full);
    } catch (failure) {
      const code =
        failure !== null && typeof failure === "object" && "code" in failure
          ? String((failure as { code: unknown }).code)
          : "";
      if (code === "MODULE_NOT_FOUND") continue;
      return { loaded: false, reason: "native addon failed to load" };
    }
    const driver = driverFromModule(candidate);
    if (driver !== null) {
      return { loaded: true, driver, via: "bundled" };
    }
    return { loaded: false, reason: "native addon surface failed validation" };
  }
  return { loaded: false, reason: "native addon not built" };
}

// ---------------------------------------------------------------------------
// Trusted window adaptation (structural BrowserWindow, Main-side only)
// ---------------------------------------------------------------------------

export interface StructuralRecordingWindow {
  getNativeWindowHandle(): Buffer;
  getBounds(): { width: number; height: number };
  isDestroyed(): boolean;
  readonly webContents: { readonly id: number };
}

/** Resolves raw Main-owned window facts; null when unusable (fail closed). */
export function resolveWindowForRecording(
  window: StructuralRecordingWindow | null | undefined,
): ResolvedRecordingWindow | null {
  try {
    if (window === null || window === undefined || window.isDestroyed()) {
      return null;
    }
    const handleBytes = window.getNativeWindowHandle();
    if (handleBytes === null || handleBytes === undefined || handleBytes.length < 8) {
      return null;
    }
    const handle = (handleBytes as Buffer).readBigUInt64LE(0);
    if (handle <= 0n) return null;
    const bounds = window.getBounds();
    if (
      bounds === null || bounds === undefined ||
      !Number.isInteger(bounds.width) || !Number.isInteger(bounds.height)
    ) {
      return null;
    }
    return {
      windowHandle: handle,
      ownerPid: process.pid,
      width: bounds.width,
      height: bounds.height,
      webContentsId: window.webContents?.id ?? null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Production dependency assembly (real components only)
// ---------------------------------------------------------------------------

export interface ProductionRecordingAssembly {
  readonly deps: RecordingHostDeps;
  readonly registry: TrustedCaptureSourceRegistry;
  readonly clock: SystemMonotonicClock;
}

export function createProductionRecordingDeps(input: {
  window: StructuralRecordingWindow;
  recordSafe: boolean;
  tempRoot: string;
  tools: { readonly ffmpeg: string; readonly ffprobe: string };
  driver: NativeWgcDriver;
  descriptor: EncoderDescriptor;
}): ProductionRecordingAssembly {
  if (typeof input.driver.supportsReadback !== "function" || !input.driver.supportsReadback()) {
    throw new Error("[ENCODER_START_FAILED] capture backend lacks the byte readback seam");
  }
  const registry = new TrustedCaptureSourceRegistry();
  const clock = new SystemMonotonicClock();
  const sink = new NodeTakeFileSink(input.tempRoot);
  const byteSource = new NativeReadbackAdapter(input.driver);
  const win = input.window;
  const recordSafe = input.recordSafe === true;
  let takeCounter = 0;
  const deps: RecordingHostDeps = {
    source: {
      // The proof/embedding wiring replaces this source with a
      // LessonRuntime-bound source; the idle shell below never starts takes.
      getBinding: () => null,
      subscribe: () => () => undefined,
      resolveOrdinal: () => null,
    },
    window: {
      resolveWindow: () => resolveWindowForRecording(win),
      isRecordSafe: () => recordSafe,
    },
    allocateIds: () => {
      takeCounter += 1;
      const n = Math.min(takeCounter, 99);
      return {
        recordingSessionId: `rec-${randomBytes(8).toString("hex")}`,
        takeId: `t${String(n).padStart(2, "0")}`,
      };
    },
    tempRoot: input.tempRoot,
    files: sink,
    createCaptureSession: ({ fence, takeId }) => {
      const ref = {
        windowHandle: resolveWindowForRecording(win)?.windowHandle ?? 0n,
        ownerPid: process.pid,
      };
      const issued = registry.issue(ref);
      return new WgcCaptureSession({
        fence: { ...fence },
        takeId,
        driver: input.driver,
        registry,
        token: issued.token,
      });
    },
    createEncoderSession: ({ fence, takeId }) =>
      new EncoderHostSession({ fence: { ...fence }, takeId, tools: { ...input.tools } }),
    createTimeline: ({ fence, epoch }) =>
      new RecordingTimelineCoordinator({ fence: { ...fence }, epoch: { ...epoch } }),
    resolveEncoderDescriptor: () => ({ ...input.descriptor }),
    bytesSource: byteSource,
    armByteRetention: () => {
      input.driver.armByteRetention();
    },
    clock: {
      nowRuntimeMs: () => clock.now(),
    },
    scheduler: realRecordingScheduler,
  };
  return { deps, registry, clock };
}
