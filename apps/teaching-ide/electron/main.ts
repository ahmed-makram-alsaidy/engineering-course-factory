// Electron main process — Teaching IDE (P4 baseline, P5.11 Safe IPC wiring,
// P6.12 Safe IPC wiring).
//
// P4 responsibilities (preserved): window lifecycle, the ONLY filesystem
// access (reading the app's own bundled fixture directory), validation of
// compiled-lesson fixtures through the canonical P3 IR authority, and a
// machine-readable --smoke mode used by the validation gate. It never executes
// lesson content: authored commands, URLs, and code are passed through as
// inert data.
//
// P5.11 Safe IPC addition (design task "Safe IPC"): the main process owns the
// TerminalHost (identifier-only IPC to the DockerSandboxProvider), validates
// every terminal sender (stored webContents + top-level frame + exact bundled
// URL), denies navigation/window opening, serializes lesson switches
// (revoke + clean before the new session), and awaits the shutdown barrier
// on before-quit/window-close (no app.exit bypass). reportReady stays
// diagnostics-only and can never authorize execution or PASS.
//
// P6.12 Safe IPC addition (design section 15, cfApi.editor): the main process
// owns one EditorIpcHost beside the terminal host (four identifier-only
// editor invokes, two bounded main-to-renderer pushes, same sender binding
// and lifecycle-safe push). Editor sessions are main-owned P6 lifecycles
// over private session leaves (no container ever mounts them in P6.12, so
// the file adapter is the sole writer); the shared coordinator leaf arrives
// with P6.13 terminal interoperability. lesson:load opens (or switches) the
// editor session additively and can never break lesson loading or the
// terminal session. There is no editor reset channel: reset routes through
// the shared lifecycle owner (P6.13+).
//
// Security baseline (preserved + extended): contextIsolation on,
// nodeIntegration off, sandbox on, and a preload bridge exposing exactly the
// three P4 functions plus the five identifier-only terminal methods, the four
// identifier-only editor methods and the preload-local subscriptions. No
// fs/child_process/shell/process, no Docker/PTY, no generic
// invoke/send/execute/stdin/resize/env/cwd/image/mount IPC exists anywhere.

import { app, BrowserWindow, ipcMain } from "electron";
import { readFileSync, mkdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadCompiledLessonData } from "../src/model/ir-loader.ts";
import { TerminalHost, canonicalCompiledDigest } from "@course-factory/terminal-engine/terminal-host";
import { DockerSandboxProvider } from "@course-factory/terminal-engine/docker";
import { DockerAccessEpochProvider } from "@course-factory/terminal-engine/docker-epochs";
import {
  loadRuntimeImageIdentity,
  loadTerminalRuntimePaths,
  resolveConfiguredWorkspaceRoot,
  buildBridgeNetworkName,
} from "@course-factory/terminal-engine";
import { createEditorCatalog } from "@course-factory/workspace/editor-admission";
import { createSeedManifest, computeSeedManifestDigest, createReviewedWorkspacePolicy, verifyReviewedWorkspacePolicy, sha256Hex } from "@course-factory/workspace/policy";
import type { ReviewedWorkspacePolicy, SeedManifest } from "@course-factory/workspace/policy";
import { openWindowsFileAdapter } from "@course-factory/workspace/file-adapter";
import { createEditorLifecycle } from "@course-factory/workspace/editor-lifecycle";
import { createEditorIpcDriver } from "@course-factory/workspace/editor-ipc";
import type { EditorIpcDriver } from "@course-factory/workspace/editor-ipc";
import {
  BrowserRuntimeHost,
  BrowserFrameProducer,
  BrowserAdmissionSession,
  createReviewedBrowserPolicy,
  createReviewedBrowserCatalog,
  waitForPortReadiness,
  allocateEphemeralLoopbackPort,
  LocalhostBridgeCoordinator,
  type ReviewedPortCapabilityV1,
} from "@course-factory/browser-engine";
import {
  LessonRuntime,
  EngineAdapterRegistry,
  EditorRuntimeAdapter,
  TerminalRuntimeAdapter,
  BrowserRuntimeAdapter,
  WaitRuntimeAdapter,
  SimulatedNarrationAdapter,
  VisualRuntimeAdapter,
  SystemMonotonicClock,
  type EditorAdapterAdmission,
} from "@course-factory/runtime-orchestrator";
import { TerminalIpcHost, TERMINAL_INVOKE_CHANNELS } from "./terminal-host.ts";
import { EditorIpcHost, EDITOR_INVOKE_CHANNELS } from "./editor-host.ts";
import { BrowserIpcHost, BROWSER_INVOKE_CHANNELS, sanitizeBrowserHostMessage } from "./browser-host.ts";
import {
  RuntimeHost,
  RUNTIME_INVOKE_CHANNELS,
  BundledLessonResolver,
  DefaultRuntimeFactory,
  type HostAdapterProviders,
  type RuntimeHostOptions,
  type RuntimeFactory,
  type RuntimeFactoryParams,
  type EditorDomainSession,
  type TerminalDomainSession,
  type BrowserDomainSession,
} from "./runtime-host.ts";
import {
  attachWindowClosedTeardown,
  captureWebContentsId,
  createFinishOnce,
  findWindowByWebContentsId,
  safeCloseWindow,
  safeGetWindowBounds,
  safeSendToWindow,
} from "./window-lifecycle.ts";
import {
  SMOKE_TERMINAL_EXPECTED_EXIT_CODE,
  SMOKE_TERMINAL_EXPECTED_MARKER,
  SMOKE_TERMINAL_FIXTURE_ID,
  SMOKE_TERMINAL_OPERATION_ID,
  isSmokeTerminalArgv,
} from "./smoke-terminal.ts";
import {
  P615_OBSERVATION_CHANNEL,
  SMOKE_P615_B1_TEXT,
  SMOKE_P615_CONTAINER_PREFIX,
  SMOKE_P615_COURSE_ID,
  SMOKE_P615_DIRTY_OPERATION_ID,
  SMOKE_P615_FIXTURE_ID,
  SMOKE_P615_INSTALLATION_ID,
  SMOKE_P615_LESSON_ID,
  SMOKE_P615_OPEN_OPERATION_ID,
  SMOKE_P615_REVIEWED_BY,
  SMOKE_P615_REVIEW_NOTE,
  SMOKE_P615_RUN_STDOUT,
  SMOKE_P615_SANDBOX_LABEL,
  SMOKE_P615_SAVE_OPERATION_ID,
  SMOKE_P615_SEED_PATH,
  SMOKE_P615_SEED_TEXT,
  SMOKE_P615_TERMINAL_OPERATION_ID,
  SMOKE_P615_TEST_RUN_ID,
  SMOKE_P615_TYPE_OPERATION_ID,
  isSmokeP615Argv,
  readSmokeP615FixtureFile,
  readSmokeP615SeedFile,
  smokeP615TerminalIdsOf,
} from "./smoke-p615.ts";
import {
  SMOKE_P7_FIXTURE_ID,
  SMOKE_P7_LESSON_ID,
  SMOKE_P7_COURSE_ID,
  SMOKE_P7_FIXTURE_PORT,
  SMOKE_P7_REVIEW_NOTE,
  isSmokeP7Argv,
} from "./smoke-p7.ts";
import {
  SMOKE_P8_FIXTURE_ID,
  SMOKE_P8_LESSON_ID,
  SMOKE_P8_COURSE_ID,
  SMOKE_P8_FIXTURE_PORT,
  SMOKE_P8_REVIEW_NOTE,
  isSmokeP8Argv,
} from "./smoke-p8.ts";
import { startFixtureServer, type FixtureServerInstance } from "@course-factory/browser-engine";
import { registerReviewedLesson } from "./execution-catalog.ts";
import { isExecutionAuthorized } from "./execution-catalog.ts";

// Ensure process.stdout flushes synchronously when redirected to a log file
// so visual-smoke checkpoint signals appear on disk immediately.
if (
  process.stdout &&
  typeof (process.stdout as unknown as { _handle?: { setBlocking?: (b: boolean) => void } })._handle?.setBlocking === "function"
) {
  (process.stdout as unknown as { _handle: { setBlocking: (b: boolean) => void } })._handle.setBlocking(true);
}

const APP_ROOT = join(__dirname, "..", "..");
const LESSON_FIXTURES_DIR = join(APP_ROOT, "fixtures", "compiled-lessons");
const FIXTURE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  const repoCandidate = resolve(APP_ROOT, "..", "..", "bin", "browsers");
  if (existsSync(repoCandidate)) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = repoCandidate;
  }
}

const isSmoke =
  process.argv.includes("--smoke") &&
  !isSmokeTerminalArgv(process.argv) &&
  !isSmokeP615Argv(process.argv) &&
  !isSmokeP7Argv(process.argv) &&
  !isSmokeP8Argv(process.argv);
const isSmokeTerminal = isSmokeTerminalArgv(process.argv);
const isSmokeTerminalRecordSafe = isSmokeTerminal && process.argv.includes("--record-safe");
const isSmokeP615 = isSmokeP615Argv(process.argv);
const isSmokeP615RecordSafe = isSmokeP615 && process.argv.includes("--record-safe");
const isSmokeP7 = isSmokeP7Argv(process.argv);
const isSmokeP7RecordSafe = isSmokeP7 && process.argv.includes("--record-safe");
const isSmokeP8 = isSmokeP8Argv(process.argv);
const isSmokeP8RecordSafe = isSmokeP8 && process.argv.includes("--record-safe");
const windowSize = readWindowSize(process.argv);

// P6.15/P7.9/P8.9 visual proof: deterministic software rasterization for the smoke
// runs (never production behavior). The evidence screenshots must show the
// same pixels on any machine/GPU state; SwiftShader removes the GPU-process
// init/compositor flake class and its memory footprint on loaded hosts.
// Real Electron, real Monaco, real pixels — only the rasterizer differs.
if (isSmokeP615 || isSmokeP7 || isSmokeP8) {
  app.commandLine.appendSwitch("disable-gpu");
}

interface ReadyReport {
  [key: string]: unknown;
}
let latestReadyReport: ReadyReport | null = null;
let rendererLoaded = false;

// -- P5.11 terminal host (single main-owned instance) -------------------------

let terminalIpcHost: TerminalIpcHost | null = null;
let terminalUnavailable: { code: string; message: string } | null = null;
let shutdownBarrierDone = false;
// P6.12 safe editor IPC: the main-owned editor bridge beside the terminal
// host (identifier-only invokes, bounded pushes, same sender binding).
let editorIpcHost: EditorIpcHost | null = null;
let editorUnavailable: { code: string; message: string } | null = null;
// P7.6 safe browser IPC: the main-owned browser bridge beside terminal and
// editor (identifier-only invokes, bounded pushes, structural sender validation).
let browserIpcHost: BrowserIpcHost | null = null;
let browserUnavailable: { code: string; message: string } | null = null;
// P8.7 safe runtime IPC: the main-owned lesson runtime orchestrator host
// (six identifier-only invokes, bounded journal event push, sender validation).
let runtimeHost: RuntimeHost | null = null;
let runtimeUnavailable: { code: string; message: string } | null = null;
// P5.14 visual smoke: retained main-owned facts for correlated verification
// (engine host + runtime image reference; never renderer input).
let engineHostForSmoke: TerminalHost | null = null;
let runtimeImageForSmoke = "";
let smokeTerminalDigest = "";
// P6.15 visual proof: main-owned reviewed bundle + per-session leaves for
// the trusted fixture (reviewed IR/digest/seed/policy; never renderer input).
interface SmokeP615Reviewed {
  compiledLesson: unknown;
  lessonCompiledDigest: string;
  seedText: string;
  seedManifest: SeedManifest;
  seedManifestDigest: string;
  seedSha256: string;
  seedByteLength: number;
  policy: ReviewedWorkspacePolicy;
  policyDigest: string;
}
let smokeP615Reviewed: SmokeP615Reviewed | null = null;
interface SmokeP615SessionRecord {
  sessionId: string;
  generation: number;
  leaf: string;
  staging: string;
  driver: EditorIpcDriver;
}
const smokeP615Sessions = new Map<string, SmokeP615SessionRecord>();

function resolveDockerExe(): string {
  const localApp = process.env["LOCALAPPDATA"];
  if (localApp) {
    const userDocker = join(localApp, "Programs", "DockerDesktop", "resources", "bin", "docker.exe");
    if (existsSync(userDocker)) return userDocker;
  }
  const programFiles = process.env["ProgramFiles"];
  if (programFiles) {
    const sysDocker = join(programFiles, "Docker", "Docker", "resources", "bin", "docker.exe");
    if (existsSync(sysDocker)) return sysDocker;
  }
  const probe = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["docker"], { encoding: "utf8" });
  if (probe.status === 0 && probe.stdout) {
    const lines = probe.stdout.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const withExe = lines.find((l) => l.toLowerCase().endsWith(".exe"));
    if (withExe && existsSync(withExe)) return withExe;
    if (lines[0] && existsSync(lines[0])) return lines[0];
  }
  const pathSep = process.env["PATH"]?.includes(";") ? ";" : ":";
  const pathEntries = (process.env["PATH"] ?? "").split(pathSep);
  for (const dir of pathEntries) {
    if (dir.trim().length === 0) continue;
    const c = join(dir.trim(), "docker.exe");
    if (existsSync(c)) return c;
  }
  return "docker.exe";
}

function ensureInstallationId(userDataDir: string): string {
  const file = join(userDataDir, "course-factory-installation-id");
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(existing)) return existing;
  } catch {
    // fall through to creation
  }
  const fresh = `cf-ide-${randomBytes(8).toString("hex")}`;
  try {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(file, fresh, "utf8");
  } catch {
    // ephemeral fallback (still owner-scoped for this run)
  }
  return fresh;
}

function createTerminalHost(): void {
  try {
    // P5.14 fix (found by the first real visual-smoke run, not by mocks):
    // __dirname is dist/main, so the repository root is four levels up
    // (main -> dist -> teaching-ide -> apps -> repo). Three levels resolved
    // to apps/ and could never find config/paths.json or the image lock.
    const repoRoot = join(__dirname, "..", "..", "..", "..");
    const pathsOutcome = loadTerminalRuntimePaths(repoRoot);
    if (!pathsOutcome.ok) {
      terminalUnavailable = { code: pathsOutcome.error.code, message: pathsOutcome.error.message };
      return;
    }
    const rootOutcome = resolveConfiguredWorkspaceRoot(pathsOutcome.value.runtimeWorkspaceRoot, { repositoryRoot: repoRoot });
    if (!rootOutcome.ok) {
      terminalUnavailable = { code: rootOutcome.error.code, message: rootOutcome.error.message };
      return;
    }
    const imageOutcome = loadRuntimeImageIdentity(repoRoot);
    if (!imageOutcome.ok) {
      terminalUnavailable = { code: imageOutcome.error.code, message: imageOutcome.error.message };
      return;
    }
    let runtimeImage = (process.env["CF_TERMINAL_RUNTIME_IMAGE"] ?? "").trim();
    if (runtimeImage.length === 0 && isSmokeP8) {
      try {
        const exe = process.env["CF_TERMINAL_DOCKER_EXE"] ?? resolveDockerExe();
        const probe = spawnSync(exe, ["image", "inspect", "cf-terminal-engine-runtime:p5.14", "--format", "{{.Id}}"], { encoding: "utf8" });
        const id = (probe.stdout ?? "").trim();
        if (probe.status === 0 && /^sha256:[0-9a-f]{64}$/.test(id)) {
          runtimeImage = id;
        }
      } catch {}
    }
    if (runtimeImage.length === 0) {
      // No implicit pull and no moving tag: without an operator-built offline
      // runtime image reference the host stays unavailable (prerequisite HOLD).
      terminalUnavailable = { code: "IMAGE_UNAVAILABLE", message: "terminal runtime image is not configured (CF_TERMINAL_RUNTIME_IMAGE)" };
      return;
    }
    const userDataDir = app.getPath("userData");
    const privateConfigDir = join(userDataDir, "terminal-docker-config");
    try {
      mkdirSync(privateConfigDir, { recursive: true });
    } catch {
      terminalUnavailable = { code: "WORKSPACE_UNAVAILABLE", message: "terminal private Docker config directory is unavailable" };
      return;
    }
    const dockerExe = process.env["CF_TERMINAL_DOCKER_EXE"] ?? resolveDockerExe();
    // P5.14 fix (found by the second real visual-smoke run): the private
    // Docker config directory was created but the fixed desktop-linux context
    // inside it was never created, so every provider call failed SPAWN_FAILED.
    // Bootstrap the minimal host-only context here (trusted main config, never
    // renderer input; same endpoint the P5.12 integration helper uses).
    try {
      const listed = spawnSync(dockerExe, ["--config", privateConfigDir, "context", "ls"], { encoding: "utf8", windowsHide: true });
      const hasContext = typeof listed.stdout === "string" && listed.stdout.includes("desktop-linux");
      if (!hasContext) {
        spawnSync(
          dockerExe,
          [
            "--config",
            privateConfigDir,
            "context",
            "create",
            "desktop-linux",
            "--docker",
            "host=npipe:////./pipe/dockerDesktopLinuxEngine",
            "--description",
            "course-factory terminal runtime context",
          ],
          { encoding: "utf8", windowsHide: true },
        );
      }
    } catch {
      // Fail closed downstream: the provider surfaces the authoritative error.
    }
    // P5.14 phase-owned scoping: an explicit trusted machine-config override
    // lets the visual-smoke gate label its containers cf-p514-installation for
    // ownership-scoped cleanup. Never renderer/lesson/IR input.
    const configuredInstallation = process.env["CF_TERMINAL_INSTALLATION_ID"] ?? "";
    const installationId =
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(configuredInstallation) && configuredInstallation.length > 0
        ? configuredInstallation
        : ensureInstallationId(userDataDir);
    const engineHost = new TerminalHost({
      workspaceRoot: rootOutcome.value.host_root,
      imageIdentity: imageOutcome.value,
      hostEnv: { TZ: process.env["TZ"] },
      forwardEnvNames: [],
      createProvider: () =>
        new DockerSandboxProvider({
          cli: { dockerExe, context: "desktop-linux", configDir: privateConfigDir, clientEnv: {} },
          imageReference: runtimeImage,
          installationId,
        }),
    });
    terminalIpcHost = new TerminalIpcHost({
      host: engineHost,
      pushToRenderer: (webContentsId, channel, dto) => {
        // P5.15 lifecycle repair: never dereference .webContents on a
        // destroyed window (it throws "Object has been destroyed", which
        // surfaced as Electron's Error dialog and stalled quit). Destroyed
        // candidates are skipped structurally; the send itself is guarded.
        const window = findWindowByWebContentsId(BrowserWindow.getAllWindows(), webContentsId);
        safeSendToWindow(window, channel, dto);
      },
    });
    // P5.14: retain for correlated smoke-terminal verification (main-owned).
    engineHostForSmoke = engineHost;
    runtimeImageForSmoke = runtimeImage;
  } catch (error) {
    terminalUnavailable = {
      code: "WORKSPACE_UNAVAILABLE",
      message: error instanceof Error ? error.message : "terminal host is unavailable",
    };
  }
}

// -- P6.12 editor host (single main-owned instance) ---------------------------

function sanitizeEditorHostMessage(message: string): string {
  // Record Safe Mode by construction: renderer-visible editor errors carry
  // stable codes plus bounded messages with host paths redacted.
  let out = message.replace(/[A-Za-z]:[\\/][^\s"'`]*/g, "[path]").replace(/\\\\[^\s"'`]*/g, "[path]");
  if (out.length > 512) out = out.slice(0, 512);
  return out;
}

function createEditorHost(): void {
  try {
    // Same repository-root resolution as the terminal host (dist/main is
    // four levels below the root).
    const repoRoot = join(__dirname, "..", "..", "..", "..");
    const pathsOutcome = loadTerminalRuntimePaths(repoRoot);
    if (!pathsOutcome.ok) {
      editorUnavailable = { code: pathsOutcome.error.code, message: pathsOutcome.error.message };
      return;
    }
    const rootOutcome = resolveConfiguredWorkspaceRoot(pathsOutcome.value.runtimeWorkspaceRoot, { repositoryRoot: repoRoot });
    if (!rootOutcome.ok) {
      editorUnavailable = { code: rootOutcome.error.code, message: rootOutcome.error.message };
      return;
    }
    const workspaceRoot: string = rootOutcome.value.host_root;
    editorIpcHost = new EditorIpcHost({
      openSession: async (input) => {
        // Main-owned editor session over a private session leaf. No
        // container ever mounts these leaves in P6.12, so the file adapter
        // is the sole writer; the shared coordinator leaf arrives with
        // P6.13. Every value below is main-held (reviewed IR, fresh
        // identities, owned directories) — never renderer input.
        const catalogOutcome = createEditorCatalog(input.compiledLesson);
        if (!catalogOutcome.ok) {
          return { ok: false as const, code: catalogOutcome.rejection.code, message: sanitizeEditorHostMessage(catalogOutcome.rejection.message) };
        }
        // Empty reviewed seed manifest (explicit): P6.12 carries no reviewed
        // seed pipeline; file_create stages pending bytes and file_open
        // reads what the session itself committed. Seeded curriculum
        // arrives with later tasks.
        // P6.15 visual proof: the reviewed smoke fixture carries bound seed
        // bytes. When this main-owned reviewed bundle matches the opening
        // lesson, the leaf is seeded with the exact reviewed bytes (verified
        // readback) and the lifecycle binds the reviewed manifest — the ONLY
        // seeded path; every other lesson keeps the explicit empty manifest.
        const smokeSeeded =
          isSmokeP615 &&
          smokeP615Reviewed !== null &&
          (input.compiledLesson as { lesson?: { lesson_id?: unknown } }).lesson?.lesson_id === SMOKE_P615_LESSON_ID;
        const seedOutcome = smokeSeeded
          ? ({ ok: true as const, value: (smokeP615Reviewed as SmokeP615Reviewed).seedManifest })
          : createSeedManifest([]);
        if (!seedOutcome.ok) {
          return { ok: false as const, code: "WORKSPACE_UNAVAILABLE", message: "editor seed manifest is unavailable" };
        }
        const sessionId = `ed-sess-${randomBytes(8).toString("hex")}`;
        const workspaceId = `ed-ws-${randomBytes(8).toString("hex")}`;
        const leaf = join(workspaceRoot, "editor-workspaces", sessionId);
        const staging = join(workspaceRoot, "editor-staging", sessionId);
        try {
          mkdirSync(leaf, { recursive: true });
          mkdirSync(staging, { recursive: true });
        } catch {
          return { ok: false as const, code: "WORKSPACE_UNAVAILABLE", message: "editor workspace leaf is unavailable" };
        }
        if (smokeSeeded && smokeP615Reviewed !== null) {
          // Seed the private leaf with the exact reviewed bytes and verify
          // the readback before any admission can observe them. Any drift
          // fails the session open with zero admission.
          try {
            writeFileSync(join(leaf, SMOKE_P615_SEED_PATH), smokeP615Reviewed.seedText, "utf8");
            const readback = readFileSync(join(leaf, SMOKE_P615_SEED_PATH), "utf8");
            if (readback !== smokeP615Reviewed.seedText) {
              throw new Error("seed readback mismatch");
            }
          } catch {
            try {
              rmSync(leaf, { recursive: true, force: true });
              rmSync(staging, { recursive: true, force: true });
            } catch {
              // Best-effort ownership-scoped cleanup.
            }
            return { ok: false as const, code: "WORKSPACE_UNAVAILABLE", message: "editor seed verification failed" };
          }
        }
        const bound = openWindowsFileAdapter({ sessionId, generation: 1, workspaceId, leafHostPath: leaf, stagingHostPath: staging });
        if (!bound.ok) {
          try {
            rmSync(leaf, { recursive: true, force: true });
            rmSync(staging, { recursive: true, force: true });
          } catch {
            // Best-effort ownership-scoped cleanup.
          }
          return { ok: false as const, code: bound.rejection.code, message: sanitizeEditorHostMessage(bound.rejection.message) };
        }
        const lifecycle = createEditorLifecycle({
          catalog: catalogOutcome.value,
          seedManifest: seedOutcome.value,
          sessionId,
          generation: 1,
          reviewed: input.reviewed,
          wiring: {
            getOwnership: () => "EDITOR_OWNED",
            retireContainer: async () => "confirmed" as const,
            reseed: async () => {
              rmSync(leaf, { recursive: true, force: true });
              rmSync(staging, { recursive: true, force: true });
              mkdirSync(leaf, { recursive: true });
              mkdirSync(staging, { recursive: true });
            },
          },
        });
        const driver = createEditorIpcDriver({ lifecycle });
        if (smokeSeeded) {
          // P6.15 visual proof: retain the main-held session record so the
          // smoke coordinator can observe the trusted journal/snapshots and
          // bind the verified read_only epoch to this exact leaf. The map
          // holds main-owned facts only (session/leaf/driver handles).
          smokeP615Sessions.set(sessionId, { sessionId, generation: 1, leaf, staging, driver });
        }
        const leaseId = `ed-lease-${randomBytes(8).toString("hex")}`;
        const execDeps = {
          adapter: bound.value,
          authority: {
            lease: {
              kind: "editor_lease",
              leaseId,
              sessionId,
              generation: 1,
              workspaceId,
              epoch: 1,
              operationId: "editor-ipc-open",
              requestId: `ed-open-${randomBytes(4).toString("hex")}`,
            },
            ownership: "EDITOR_OWNED",
            liveEpoch: 1,
            revokedLeaseIds: [],
          },
        };
        return {
          ok: true as const,
          opened: {
            driver,
            execDeps,
            session: { session_id: sessionId, generation: 1 },
            cleanup: async () => {
              try {
                await lifecycle.close({ session_id: sessionId, generation: 1, request_id: `ed-close-${randomBytes(4).toString("hex")}` });
              } catch {
                // Settlement is best-effort; directory removal still runs.
              }
              // Ownership-scoped removal of exactly this session's leaf and
              // staging (never a shared root, never another session).
              try {
                rmSync(leaf, { recursive: true, force: true });
              } catch {
                // Retained for operator diagnostics; never reused.
              }
              try {
                rmSync(staging, { recursive: true, force: true });
              } catch {
                // Retained for operator diagnostics; never reused.
              }
            },
          },
        };
      },
      pushToRenderer: (webContentsId, channel, dto) => {
        // Same P5.15 lifecycle repair as the terminal push: destroyed
        // candidates are skipped structurally; the send itself is guarded.
        const window = findWindowByWebContentsId(BrowserWindow.getAllWindows(), webContentsId);
        safeSendToWindow(window, channel, dto);
      },
    });
  } catch {
    editorUnavailable = { code: "WORKSPACE_UNAVAILABLE", message: "editor runtime is unavailable" };
  }
}

function createBrowserHost(): void {
  try {
    browserIpcHost = new BrowserIpcHost({
      pushToRenderer: (webContentsId, channel, dto) => {
        const window = findWindowByWebContentsId(BrowserWindow.getAllWindows(), webContentsId);
        safeSendToWindow(window, channel, dto);
      },
    });
  } catch (error) {
    browserUnavailable = {
      code: "BROWSER_UNAVAILABLE",
      message: error instanceof Error ? error.message : "browser runtime is unavailable",
    };
  }
}

function createRuntimeHost(options?: Partial<RuntimeHostOptions>): void {
  try {
    runtimeHost = new RuntimeHost({
      pushToRenderer: (webContentsId, channel, dto) => {
        const window = findWindowByWebContentsId(BrowserWindow.getAllWindows(), webContentsId);
        safeSendToWindow(window, channel, dto);
      },
      lessonResolver: new BundledLessonResolver(LESSON_FIXTURES_DIR),
      ...options,
    });
  } catch (error) {
    runtimeUnavailable = {
      code: "ENGINE_UNAVAILABLE",
      message: error instanceof Error ? error.message : "lesson runtime is unavailable",
    };
  }
}

function readWindowSize(argv: string[]): { width: number; height: number } {
  // Development/validation aid: --window-size=1280x720 (default 1600x900).
  const flag = argv.find((arg) => arg.startsWith("--window-size="));
  const match = flag?.match(/^--window-size=(\d{3,5})x(\d{3,5})$/);
  if (match) {
    return { width: Number(match[1]), height: Number(match[2]) };
  }
  return { width: 1600, height: 900 };
}

function rendererFileUrl(): string {
  return pathToFileURL(join(__dirname, "..", "renderer", "index.html")).href;
}

// P5.14 fix (found by the first real visual-smoke run): the sender frame URL
// carries the smoke query (?smoke=1 / ?smoke-terminal=1 / ?smoke-p615=1),
// while the binding used the bare file URL — every smoke-terminal invoke
// failed WRONG_OWNER. The bound URL must be the exact URL the window loads
// (base + mode query). Navigation stays denied, so the query cannot change
// after load.
function rendererUrlForCurrentMode(): string {
  const base = rendererFileUrl();
  if (isSmokeP8) {
    return isSmokeP8RecordSafe ? `${base}?smoke-p8=1&record-safe=1` : `${base}?smoke-p8=1`;
  }
  if (isSmokeP7) {
    return isSmokeP7RecordSafe ? `${base}?smoke-p7=1&record-safe=1` : `${base}?smoke-p7=1`;
  }
  if (isSmokeP615) {
    return isSmokeP615RecordSafe ? `${base}?smoke-p615=1&record-safe=1` : `${base}?smoke-p615=1`;
  }
  if (isSmokeTerminal) {
    return isSmokeTerminalRecordSafe ? `${base}?smoke-terminal=1&record-safe=1` : `${base}?smoke-terminal=1`;
  }
  if (isSmoke) return `${base}?smoke=1`;
  return base;
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: windowSize.width,
    height: windowSize.height,
    minWidth: 1280,
    minHeight: 720,
    title: "Course Factory — Teaching IDE",
    backgroundColor: "#10151b",
    show: true,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  window.setMenuBarVisibility(false);
  // P5.11: deny navigation and window opening (sender/frame trust).
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  if (isSmokeP7 || isSmokeP8) {
    window.webContents.on("console-message", (_event, _level, message) => {
      console.log(`[RENDERER] ${message}`);
    });
  }
  // P5.14: smoke-terminal uses its own query (distinct from ?smoke=1, which
  // stays navigation-only). Record-safe forwards as a renderer query so the
  // gate can prove the privacy layout end to end. P6.15 smoke-p615 uses its
  // own query on the same convention.
  const rendererQuery: Record<string, string> = {};
  if (isSmokeP8) {
    rendererQuery["smoke-p8"] = "1";
    if (isSmokeP8RecordSafe) rendererQuery["record-safe"] = "1";
  } else if (isSmokeP7) {
    rendererQuery["smoke-p7"] = "1";
    if (isSmokeP7RecordSafe) rendererQuery["record-safe"] = "1";
  } else if (isSmokeP615) {
    rendererQuery["smoke-p615"] = "1";
    if (isSmokeP615RecordSafe) rendererQuery["record-safe"] = "1";
  } else if (isSmokeTerminal) {
    rendererQuery["smoke-terminal"] = "1";
    if (isSmokeTerminalRecordSafe) rendererQuery["record-safe"] = "1";
  } else if (isSmoke) {
    rendererQuery["smoke"] = "1";
  }
  void window.loadFile(join(__dirname, "..", "renderer", "index.html"), { query: rendererQuery });
  window.webContents.on("did-finish-load", () => {
    rendererLoaded = true;
  });
  // P5.15 lifecycle repair: capture the id while alive (creation time).
  const webContentsId = captureWebContentsId(window);
  if (terminalIpcHost !== null) {
    terminalIpcHost.bindRenderer({ webContentsId, rendererUrl: rendererUrlForCurrentMode() });
  }
  if (editorIpcHost !== null) {
    editorIpcHost.bindRenderer({ webContentsId, rendererUrl: rendererUrlForCurrentMode() });
  }
  if (browserIpcHost !== null) {
    browserIpcHost.bindRenderer({ webContentsId, rendererUrl: rendererUrlForCurrentMode() });
  }
  if (runtimeHost !== null) {
    runtimeHost.bindRenderer({ webContentsId, rendererUrl: rendererUrlForCurrentMode() });
  }
  // The "closed" listener closes over the creation-time id only and never
  // touches window.webContents (which throws "Object has been destroyed"
  // once the native object is gone — the exact uncaught main-process error
  // this repair removes).
  const ownedOrNull = terminalIpcHost;
  const editorOwnedOrNull = editorIpcHost;
  const browserOwnedOrNull = browserIpcHost;
  const runtimeOwnedOrNull = runtimeHost;
  attachWindowClosedTeardown(window, webContentsId, (id) => {
    // Renderer loss: revoke and clean the owned sessions (bounded, best-effort).
    if (ownedOrNull === null && editorOwnedOrNull === null && browserOwnedOrNull === null && runtimeOwnedOrNull === null) return;
    const runtimeClose = runtimeOwnedOrNull === null ? Promise.resolve() : runtimeOwnedOrNull.closeSessionForRenderer(id, "renderer_loss").finally(() => {
      runtimeOwnedOrNull.unbindRenderer(id);
    });
    const terminalClose = ownedOrNull === null ? Promise.resolve() : ownedOrNull.closeSessionForRenderer(id, "renderer_loss").finally(() => {
      ownedOrNull.unbindRenderer(id);
    });
    const editorClose = editorOwnedOrNull === null ? Promise.resolve() : editorOwnedOrNull.closeSessionForRenderer(id, "renderer_loss").finally(() => {
      editorOwnedOrNull.unbindRenderer(id);
    });
    const browserClose = browserOwnedOrNull === null ? Promise.resolve() : browserOwnedOrNull.closeSessionForRenderer(id, "renderer_loss").finally(() => {
      void browserOwnedOrNull.unbindRenderer(id);
    });
    // P8.7: runtime coordinated close settles first, followed by domain fallback cleanups
    void runtimeClose.then(() => Promise.all([terminalClose, editorClose, browserClose]));
  });
  return window;
}

// ---------------------------------------------------------------------------
// IPC — P4 surface (preserved) plus the five P5.11 identifier-only terminal
// channels. No generic channel exists.
// ---------------------------------------------------------------------------

ipcMain.handle("app:getMeta", () => ({
  name: "course-factory-teaching-ide",
  version: app.getVersion(),
  irLoadedFrom: "fixtures/compiled-lessons (bundled fixtures only)",
}));

ipcMain.handle("lesson:load", async (event, fixtureId: unknown) => {
  if (typeof fixtureId !== "string" || !FIXTURE_ID_PATTERN.test(fixtureId)) {
    return { ok: false, issues: [{ path: "(fixture)", code: "INVALID_FIXTURE_ID", message: "fixture id must be a short identifier" }] };
  }
  const path = join(LESSON_FIXTURES_DIR, `${fixtureId}.json`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {
      ok: false,
      issues: [{ path: "(fixture)", code: "FIXTURE_NOT_FOUND", message: `no bundled fixture named '${fixtureId}'` }],
    };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      issues: [{ path: "(fixture)", code: "IR_JSON_PARSE_ERROR", message: error instanceof Error ? error.message : String(error) }],
    };
  }
  // The canonical P3 IR authority is the single validation point. The renderer
  // only ever receives contract-valid IR plus a rendered-issue list.
    const result = loadCompiledLessonData(data);
    if (!result.ok) {
      return { ok: false, issues: result.issues };
    }
  // P5.11: open (or switch) the runtime session for the loading renderer.
  // Switches serialize: the previous owned session is revoked and cleaned
  // before the new one opens. The renderer receives the SAFE descriptor only
  // (session_id + generation; no private IDs/paths/container IDs). P4
  // fixtures stay inspection-only via the execution catalog (NOT_AUTHORIZED
  // on run, zero spawn); reportReady can never authorize.
  // P6.12: the editor session opens additively beside the terminal session
  // (same reviewed binding, private session leaf, no container). An editor
  // failure is reported as editorError and can never break lesson loading
  // or the terminal session.
  let terminalDescriptor: { session_id: string; generation: number } | null = null;
  let terminalError: { code: string; message: string } | null = null;
  let editorDescriptor: { session_id: string; generation: number } | null = null;
  let editorError: { code: string; message: string } | null = null;
  let browserDescriptor: { session_id: string; generation: number } | null = null;
  let browserError: { code: string; message: string } | null = null;
  let lessonDigest = "";
  if (result.ir !== undefined) {
    try {
      lessonDigest = canonicalCompiledDigest(result.ir);
    } catch {
      lessonDigest = "";
    }
  }
  if (terminalIpcHost !== null && result.ir !== undefined && lessonDigest !== "") {
    try {
      const opened = await terminalIpcHost.openSessionForRenderer({
        webContentsId: event.sender.id,
        rendererUrl: rendererUrlForCurrentMode(),
        compiledLesson: result.ir,
        lessonCompiledDigest: lessonDigest,
        lessonId: result.ir.lesson.lesson_id,
      });
      if (opened.ok) {
        terminalDescriptor = opened.session;
      } else {
        terminalError = { code: opened.code, message: opened.message };
      }
    } catch {
      terminalDescriptor = null;
    }
  }
  if (editorIpcHost !== null && result.ir !== undefined && lessonDigest !== "") {
    try {
      const reviewed = isExecutionAuthorized(result.ir.lesson.lesson_id, lessonDigest);
      const opened = await editorIpcHost.openSessionForRenderer({
        webContentsId: event.sender.id,
        rendererUrl: rendererUrlForCurrentMode(),
        compiledLesson: result.ir,
        lessonCompiledDigest: lessonDigest,
        lessonId: result.ir.lesson.lesson_id,
        reviewed,
      });
      if (opened.ok) {
        editorDescriptor = opened.session;
      } else {
        editorError = { code: opened.code, message: sanitizeEditorHostMessage(opened.message) };
      }
    } catch {
      editorDescriptor = null;
    }
  }
  if (browserIpcHost !== null && result.ir !== undefined && lessonDigest !== "") {
    try {
      const reviewed = isExecutionAuthorized(result.ir.lesson.lesson_id, lessonDigest);
      const opened = await browserIpcHost.openSessionForRenderer({
        webContentsId: event.sender.id,
        rendererUrl: rendererUrlForCurrentMode(),
        compiledLesson: result.ir,
        lessonCompiledDigest: lessonDigest,
        lessonId: result.ir.lesson.lesson_id,
        reviewed,
      });
      if (opened.ok) {
        browserDescriptor = opened.session;
      } else {
        browserError = { code: opened.code, message: sanitizeBrowserHostMessage(opened.message) };
      }
    } catch {
      browserDescriptor = null;
    }
  }
  let runtimeDescriptor: { session_id: string; generation: number } | null = null;
  let runtimeError: { code: string; message: string } | null = null;
  if (runtimeHost !== null && result.ir !== undefined) {
    try {
      const opened = await runtimeHost.prepareSessionForRenderer({
        webContentsId: event.sender.id,
        rendererUrl: rendererUrlForCurrentMode(),
        compiledLesson: result.ir,
        lessonId: result.ir.lesson.lesson_id,
      });
      if (opened.ok) {
        runtimeDescriptor = opened.session;
      } else {
        runtimeError = { code: opened.code, message: opened.message };
      }
    } catch {
      runtimeDescriptor = null;
    }
  }
  if (
    terminalDescriptor !== null ||
    terminalError !== null ||
    editorDescriptor !== null ||
    editorError !== null ||
    browserDescriptor !== null ||
    browserError !== null ||
    runtimeDescriptor !== null ||
    runtimeError !== null
  ) {
    return {
      ok: true,
      issues: [],
      ir: result.ir,
      ...(terminalDescriptor !== null ? { terminal: terminalDescriptor } : {}),
      ...(terminalError !== null ? { terminalError } : {}),
      ...(editorDescriptor !== null ? { editor: editorDescriptor } : {}),
      ...(editorError !== null ? { editorError } : {}),
      ...(browserDescriptor !== null ? { browser: browserDescriptor } : {}),
      ...(browserError !== null ? { browserError } : {}),
      ...(runtimeDescriptor !== null ? { runtime: runtimeDescriptor } : {}),
      ...(runtimeError !== null ? { runtimeError } : {}),
    };
  }
  return { ok: true, issues: [], ir: result.ir };
});

// P5.11: the five identifier-only terminal channels (sender-validated).
for (const channel of TERMINAL_INVOKE_CHANNELS) {
  ipcMain.handle(channel, async (event, payload: unknown) => {
    if (terminalIpcHost === null) {
      const unavailable = terminalUnavailable ?? { code: "WORKSPACE_UNAVAILABLE", message: "terminal runtime is unavailable" };
      return { ok: false, code: unavailable.code, message: unavailable.message };
    }
    const frameUrl: string | null = typeof event.senderFrame?.url === "string" ? event.senderFrame.url : null;
    let frameIsTop = false;
    try {
      frameIsTop = event.senderFrame?.top === event.senderFrame;
    } catch {
      frameIsTop = false;
    }
    return terminalIpcHost.handleInvoke(channel, {
      webContentsId: event.sender.id,
      frameUrl,
      frameIsTop,
      senderDestroyed: event.sender.isDestroyed(),
    }, payload);
  });
}

// P6.12: the four identifier-only editor channels (sender-validated). No
// editor reset channel exists: reset routes through the shared lifecycle
// owner (P6.13+), never an independent editor reset beside P5.
for (const channel of EDITOR_INVOKE_CHANNELS) {
  ipcMain.handle(channel, async (event, payload: unknown) => {
    if (editorIpcHost === null) {
      const unavailable = editorUnavailable ?? { code: "WORKSPACE_UNAVAILABLE", message: "editor runtime is unavailable" };
      return { ok: false, code: unavailable.code, message: unavailable.message };
    }
    const frameUrl: string | null = typeof event.senderFrame?.url === "string" ? event.senderFrame.url : null;
    let frameIsTop = false;
    try {
      frameIsTop = event.senderFrame?.top === event.senderFrame;
    } catch {
      frameIsTop = false;
    }
    return editorIpcHost.handleInvoke(channel, {
      webContentsId: event.sender.id,
      frameUrl,
      frameIsTop,
      senderDestroyed: event.sender.isDestroyed(),
    }, payload);
  });
}

// P7.6: the four identifier-only browser channels (sender-validated).
for (const channel of BROWSER_INVOKE_CHANNELS) {
  ipcMain.handle(channel, async (event, payload: unknown) => {
    if (browserIpcHost === null) {
      const unavailable = browserUnavailable ?? { code: "BROWSER_UNAVAILABLE", message: "browser runtime is unavailable" };
      return { ok: false, code: unavailable.code, message: unavailable.message };
    }
    const frameUrl: string | null = typeof event.senderFrame?.url === "string" ? event.senderFrame.url : null;
    let frameIsTop = false;
    try {
      frameIsTop = event.senderFrame?.top === event.senderFrame;
    } catch {
      frameIsTop = false;
    }
    return browserIpcHost.handleInvoke(channel, {
      webContentsId: event.sender.id,
      frameUrl,
      frameIsTop,
      senderDestroyed: event.sender.isDestroyed(),
    }, payload);
  });
}

// P8.7: the six identifier-only runtime channels (sender-validated).
for (const channel of RUNTIME_INVOKE_CHANNELS) {
  ipcMain.handle(channel, async (event, payload: unknown) => {
    console.log(`[MAIN IPC] ${channel} invoked:`, JSON.stringify(payload));
    if (runtimeHost === null) {
      const unavailable = runtimeUnavailable ?? { code: "ENGINE_UNAVAILABLE", message: "lesson runtime is unavailable" };
      return {
        ok: false,
        code: unavailable.code,
        message: unavailable.message,
        error: {
          code: "ENGINE_UNAVAILABLE",
          message: unavailable.message,
          retry: "NOT_RETRYABLE",
          request_id: null,
        },
      };
    }
    const frameUrl: string | null = typeof event.senderFrame?.url === "string" ? event.senderFrame.url : null;
    let frameIsTop = false;
    try {
      frameIsTop = event.senderFrame?.top === event.senderFrame;
    } catch {
      frameIsTop = false;
    }
    const res = await runtimeHost.handleInvoke(channel, {
      webContentsId: event.sender.id,
      frameUrl,
      frameIsTop,
      senderDestroyed: event.sender.isDestroyed(),
    }, payload);
    console.log(`[MAIN IPC] ${channel} response:`, JSON.stringify(res));
    return res;
  });
}

ipcMain.on("app:ready", (_event, report: unknown) => {
  // Diagnostics only: reportReady can never authorize execution or PASS.
  if (report && typeof report === "object") {
    latestReadyReport = report as ReadyReport;
    // P6.15 visual proof: renderer checkpoint signals are diagnostics-only
    // markers. Echo them to stdout so the gate can capture a PNG while the
    // checkpoint frame is visible. They carry no authority.
    const checkpoint = (report as Record<string, unknown>)["smokeP615Checkpoint"];
    if (typeof checkpoint === "string" && isSmokeP615) {
      console.log(`P615_CHECKPOINT ${checkpoint}`);
    }
    const checkpointP7 = (report as Record<string, unknown>)["smokeP7Checkpoint"];
    if (typeof checkpointP7 === "string" && isSmokeP7) {
      console.log(`P7_CHECKPOINT ${checkpointP7}`);
    }
    const checkpointP8 = (report as Record<string, unknown>)["smokeP8Checkpoint"];
    if (typeof checkpointP8 === "string" && isSmokeP8) {
      console.log(`P8_CHECKPOINT ${checkpointP8}`);
    }
  }
});

// ---------------------------------------------------------------------------
// App lifecycle + smoke mode + shutdown barrier
// ---------------------------------------------------------------------------

function finishSmoke(window: BrowserWindow): void {
  // P5.15 lifecycle repair: bounds are read guarded (a close racing the
  // delayed finish must not throw "Object has been destroyed").
  const report = {
    windowCreated: true,
    windowSize: safeGetWindowBounds(window),
    rendererLoaded,
    readyReport: latestReadyReport,
  };
  console.log("SMOKE_RESULT " + JSON.stringify(report));
  app.exit(0);
}

function startSmoke(): void {
  const window = createWindow();
  // P5.15 lifecycle repair: exactly one finish; pending timers die with the
  // window or the timeout so no delayed callback can touch a destroyed
  // BrowserWindow.
  const finishOnce = createFinishOnce();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  const cancelPending = (): void => {
    if (timeout !== undefined) clearTimeout(timeout);
    if (poll !== undefined) clearInterval(poll);
  };
  // The renderer reports when its self-check finished; allow generous time for
  // first-run bundling, then fail loudly instead of hanging.
  timeout = setTimeout(() => {
    if (!finishOnce()) return;
    if (poll !== undefined) clearInterval(poll);
    console.log("SMOKE_RESULT " + JSON.stringify({ windowCreated: true, rendererLoaded, readyReport: null, timedOut: true }));
    app.exit(1);
  }, 45000);
  poll = setInterval(() => {
    if (latestReadyReport !== null && rendererLoaded) {
      if (!finishOnce()) return;
      cancelPending();
      setTimeout(() => finishSmoke(window), 250);
    }
  }, 100);
  window.once("closed", cancelPending);
}

// -- P5.14 visual smoke ------------------------------------------------------

function loadAndRegisterSmokeTerminal(): boolean {
  try {
    const raw = readFileSync(join(APP_ROOT, "fixtures", "compiled-lessons", `${SMOKE_TERMINAL_FIXTURE_ID}.json`), "utf8");
    const data: unknown = JSON.parse(raw);
    const result = loadCompiledLessonData(data);
    if (!result.ok || result.ir === undefined) return false;
    const digest = canonicalCompiledDigest(result.ir);
    smokeTerminalDigest = digest;
    registerReviewedLesson({
      lesson_id: result.ir.lesson.lesson_id,
      course_id: result.ir.lesson.course_id,
      lesson_compiled_digest: digest,
      reviewed_note: "P5.14 visual smoke: synthetic single-foreground P5_OK fixture, reviewed main-only",
    });
    return true;
  } catch {
    return false;
  }
}

function verifySmokeTerminalReport(report: ReadyReport): { ok: boolean; details: string; snapshotOk: boolean } {
  try {
    if (report["smokeTerminal"] !== true) return { ok: false, details: "missing smokeTerminal flag", snapshotOk: false };
    const sessionId = report["session_id"];
    const operationId = report["operation_id"];
    const attemptId = report["attempt_id"];
    const outcome = report["completedOutcome"];
    const exitCode = report["completedExitCode"];
    const p5OkSeq = report["p5OkSeq"];
    if (typeof sessionId !== "string" || typeof attemptId !== "string") {
      return { ok: false, details: "missing session/attempt identity", snapshotOk: false };
    }
    if (operationId !== SMOKE_TERMINAL_OPERATION_ID) {
      return { ok: false, details: `unexpected operation ${String(operationId)}`, snapshotOk: false };
    }
    if (outcome !== "PASS" || exitCode !== SMOKE_TERMINAL_EXPECTED_EXIT_CODE) {
      return { ok: false, details: `unexpected outcome/exit ${String(outcome)}/${String(exitCode)}`, snapshotOk: false };
    }
    if (report["p5OkInTranscript"] !== true || report["xtermCallbackMatched"] !== true) {
      return { ok: false, details: "renderer did not prove P5_OK xterm write-callback", snapshotOk: false };
    }
    if (typeof p5OkSeq !== "number" || p5OkSeq <= 0) {
      return { ok: false, details: "missing P5_OK journal seq", snapshotOk: false };
    }
    const host = engineHostForSmoke;
    if (host === null) return { ok: false, details: "terminal host unavailable", snapshotOk: false };
    const snapshot = host.handleGetSnapshot({ session_id: sessionId, after_seq: 0 });
    if (!snapshot.ok) return { ok: false, details: "main snapshot failed", snapshotOk: false };
    const page = snapshot.value;
    const events = page.events as unknown as Array<Record<string, unknown>>;
    // Strictly increasing seq + correlated P5_OK output + PASS completion.
    let lastSeq = 0;
    let sawP5OkAtSeq = false;
    let sawCompletedPass = false;
    for (const event of events) {
      const seq = event["seq"];
      if (typeof seq !== "number" || seq <= lastSeq) {
        return { ok: false, details: "journal seq not strictly increasing", snapshotOk: false };
      }
      lastSeq = seq;
      if (seq === p5OkSeq) {
        const text = JSON.stringify(event);
        if (text.includes(SMOKE_TERMINAL_EXPECTED_MARKER)) sawP5OkAtSeq = true;
      }
      if (event["type"] === "operation.completed") {
        const payload = event["payload"] as Record<string, unknown> | undefined;
        if (
          event["operation_id"] === SMOKE_TERMINAL_OPERATION_ID &&
          event["attempt_id"] === attemptId &&
          payload !== undefined &&
          payload["outcome"] === "PASS" &&
          payload["exit_code"] === SMOKE_TERMINAL_EXPECTED_EXIT_CODE
        ) {
          sawCompletedPass = true;
        }
      }
    }
    if (!sawP5OkAtSeq) return { ok: false, details: "main journal has no P5_OK at the renderer seq", snapshotOk: false };
    if (!sawCompletedPass) return { ok: false, details: "main journal has no correlated PASS completion", snapshotOk: false };
    // Log-flush proof: the closing snapshot is readable and the digest binds.
    const described = host.describeSession(sessionId);
    if (described === null || described.lesson_compiled_digest !== smokeTerminalDigest) {
      return { ok: false, details: "session digest mismatch", snapshotOk: true };
    }
    return { ok: true, details: "correlated main/renderer proof", snapshotOk: true };
  } catch (error) {
    return { ok: false, details: error instanceof Error ? error.message : "verification threw", snapshotOk: false };
  }
}

function finishSmokeTerminal(window: BrowserWindow, result: Record<string, unknown>, exitCode: number): void {
  console.log("SMOKE_TERMINAL_RESULT " + JSON.stringify(result));
  // Hold the window open so capture-window.ps1 can bound-capture the live
  // PASS badge + P5_OK output. The shutdown barrier (before-quit) still owns
  // container teardown — never app.exit bypass for visual smoke.
  process.exitCode = exitCode;
  setTimeout(() => {
    // P5.15 lifecycle repair: a close racing destruction must never throw
    // "Object has been destroyed" (the exact uncaught main-process error
    // this repair removes).
    safeCloseWindow(window);
    // If the window is already gone, quit explicitly (barrier still applies).
    setTimeout(() => {
      if (BrowserWindow.getAllWindows().length === 0) app.quit();
    }, 2000);
  }, 10000);
}

function startSmokeTerminal(): void {
  // Main-authorized safe fixture first: without it the run is a HOLD, never
  // an execution of unreviewed content.
  createTerminalHost();
  createEditorHost();
  createBrowserHost();
  createRuntimeHost();
  if (terminalIpcHost === null || engineHostForSmoke === null) {
    console.log(
      "SMOKE_TERMINAL_RESULT " +
        JSON.stringify({ smokeTerminal: true, ok: false, code: terminalUnavailable?.code ?? "WORKSPACE_UNAVAILABLE", message: terminalUnavailable?.message ?? "terminal unavailable" }),
    );
    app.exit(2);
    return;
  }
  if (!loadAndRegisterSmokeTerminal()) {
    console.log("SMOKE_TERMINAL_RESULT " + JSON.stringify({ smokeTerminal: true, ok: false, code: "IR_INVALID", message: "smoke-terminal fixture failed validation" }));
    app.exit(2);
    return;
  }
  const window = createWindow();
  // P5.15 lifecycle repair: exactly one finish across the timeout path, the
  // report poller and window close. A late renderer report arriving after a
  // TIMEOUT finish (or after close) is a no-op — it must never re-verify,
  // re-print, or touch a destroyed BrowserWindow ("Object has been
  // destroyed" repair). Pending timers die with the window.
  const finishOnce = createFinishOnce();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  const cancelPending = (): void => {
    if (timeout !== undefined) clearTimeout(timeout);
    if (poll !== undefined) clearInterval(poll);
  };
  timeout = setTimeout(() => {
    if (!finishOnce()) return;
    if (poll !== undefined) clearInterval(poll);
    const result = { smokeTerminal: true, ok: false, code: "TIMEOUT", message: "smoke-terminal renderer report timed out", windowCreated: true, rendererLoaded };
    finishSmokeTerminal(window, result, 1);
  }, 120000);
  poll = setInterval(() => {
    const report = latestReadyReport;
    if (report !== null && report["smokeTerminal"] === true && rendererLoaded) {
      if (!finishOnce()) return;
      cancelPending();
      const verification = verifySmokeTerminalReport(report);
      const result = {
        smokeTerminal: true,
        ok: verification.ok,
        details: verification.details,
        windowCreated: true,
        windowSize: safeGetWindowBounds(window),
        rendererLoaded,
        session_id: report["session_id"] ?? null,
        generation: report["generation"] ?? null,
        operation_id: report["operation_id"] ?? null,
        attempt_id: report["attempt_id"] ?? null,
        outcome: report["completedOutcome"] ?? null,
        exit_code: report["completedExitCode"] ?? null,
        p5OkSeq: report["p5OkSeq"] ?? null,
        xtermCallbackMatched: report["xtermCallbackMatched"] ?? false,
        lesson_compiled_digest: smokeTerminalDigest,
        runtime_image: runtimeImageForSmoke,
        recordSafe: report["recordSafe"] ?? false,
        rendererReport: report,
      };
      setTimeout(() => finishSmokeTerminal(window, result, verification.ok ? 0 : 1), 250);
    }
  }, 100);
  window.once("closed", cancelPending);
}

// -- P6.15 Electron visual proof ---------------------------------------------

function sha256HexText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Main-authorized safe fixture first: without it the run is a HOLD, never
 * an execution of unreviewed content. Validates through the canonical P3
 * authority, binds the reviewed seed manifest + workspace policy digests,
 * and registers the reviewed lesson for both engines. Every value below is
 * main-held (reviewed IR, fixture-owned seed bytes, computed digests).
 */
function loadAndRegisterSmokeP615(): boolean {
  try {
    const appRoot = join(__dirname, "..", "..");
    const raw = readSmokeP615FixtureFile(appRoot);
    const result = loadCompiledLessonData(raw);
    if (!result.ok || result.ir === undefined) return false;
    if (result.ir.lesson.lesson_id !== SMOKE_P615_LESSON_ID) return false;
    if (result.ir.lesson.course_id !== SMOKE_P615_COURSE_ID) return false;
    const digest = canonicalCompiledDigest(result.ir);
    // Terminal coverage must be exactly the one reviewed read_only op:
    // missing/extra coverage fails closed with zero registration.
    const terminalIds = smokeP615TerminalIdsOf(result.ir);
    if (terminalIds.length !== 1 || terminalIds[0] !== SMOKE_P615_TERMINAL_OPERATION_ID) return false;
    // Seed bytes must equal the reviewed constant AND the bundled seed file.
    const seedFileText = readSmokeP615SeedFile(appRoot);
    if (seedFileText !== SMOKE_P615_SEED_TEXT) return false;
    const seedBytes = Buffer.byteLength(seedFileText, "utf8");
    const seedSha = sha256HexText(seedFileText);
    const seedOutcome = createSeedManifest([
      { portable_path: SMOKE_P615_SEED_PATH, kind: "regular_file" as const, byte_length: seedBytes, sha256: seedSha },
    ]);
    if (!seedOutcome.ok) return false;
    const seedDigest = computeSeedManifestDigest(seedOutcome.value);
    const policyOutcome = createReviewedWorkspacePolicy(
      {
        course_id: SMOKE_P615_COURSE_ID,
        lesson_id: SMOKE_P615_LESSON_ID,
        lesson_compiled_digest: digest,
        seed_manifest_digest: seedDigest,
        sandbox_policy_digest: sha256Hex(SMOKE_P615_SANDBOX_LABEL),
        terminal_access: { [SMOKE_P615_TERMINAL_OPERATION_ID]: "read_only" as const },
        reviewed_by: SMOKE_P615_REVIEWED_BY,
        review_note: SMOKE_P615_REVIEW_NOTE,
      },
      terminalIds,
    );
    if (!policyOutcome.ok) return false;
    const verified = verifyReviewedWorkspacePolicy(policyOutcome.value, {
      expectedTerminalOperationIds: terminalIds,
      expectedCompiledDigest: digest,
      expectedSeedManifestDigest: seedDigest,
      expectedCourseId: SMOKE_P615_COURSE_ID,
      expectedLessonId: SMOKE_P615_LESSON_ID,
    });
    if (!verified.ok) return false;
    registerReviewedLesson({
      lesson_id: SMOKE_P615_LESSON_ID,
      course_id: SMOKE_P615_COURSE_ID,
      lesson_compiled_digest: digest,
      reviewed_note: "P6.15 visual proof: synthetic tiny fixture, reviewed main-only",
    });
    smokeP615Reviewed = {
      compiledLesson: result.ir,
      lessonCompiledDigest: digest,
      seedText: seedFileText,
      seedManifest: seedOutcome.value,
      seedManifestDigest: seedDigest,
      seedSha256: seedSha,
      seedByteLength: seedBytes,
      policy: verified.value,
      policyDigest: verified.value.policy_digest,
    };
    return true;
  } catch {
    return false;
  }
}

/** Main-side visual-proof facts (digests/flags/seqs only — never host paths or container identity). */
interface SmokeP615Facts {
  sessionId: string | null;
  documentId: string | null;
  openSeq: number | null;
  typeSeq: number | null;
  saveSeq: number | null;
  saveDigest: string | null;
  saveRevision: number | null;
  dirtySeq: number | null;
  beforeStdout: string | null;
  beforeExit: number | null;
  deniedExit: number | null;
  afterStdout: string | null;
  afterExit: number | null;
  runStdout: string | null;
  runExit: number | null;
  roVerified: boolean;
  distinctEpochs: boolean;
  retiredConfirmed: boolean;
  saveReadbackDigest: string | null;
  reseedSessionId: string | null;
  reseedReadbackDigest: string | null;
  oldLeafRemoved: boolean;
}

function smokeP615Sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function smokeP615PollFor<T>(fn: () => Promise<T | null> | T | null, timeoutMs: number, intervalMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) return null;
    await smokeP615Sleep(intervalMs);
  }
}

interface SmokeP615PageView {
  documents: Array<{ document_id: string; portable_path: string; content: string; dirty: boolean; disk_revision: number; buffer_revision: number }>;
  events: Array<{ kind: string; seq: number; operation_id: string; new_digest?: unknown; new_disk_revision?: unknown }>;
}

async function smokeP615ReadPage(driver: EditorIpcDriver, sessionId: string, generation: number): Promise<SmokeP615PageView | null> {
  try {
    const response = await driver.getSnapshot({ session_id: sessionId, generation, after_seq: 0 });
    if (!response.ok || !("page" in response)) return null;
    const page = response.page;
    return {
      documents: page.documents.map((document) => ({
        document_id: document.document_id,
        portable_path: document.portable_path,
        content: document.content,
        dirty: document.dirty,
        disk_revision: document.disk_revision,
        buffer_revision: document.buffer_revision,
      })),
      events: page.events.map((event) => ({
        kind: event.kind,
        seq: event.seq,
        operation_id: event.operation_id,
        new_digest: (event as { new_digest?: unknown }).new_digest,
        new_disk_revision: (event as { new_disk_revision?: unknown }).new_disk_revision,
      })),
    };
  } catch {
    return null;
  }
}

function smokeP615CompletedSeq(page: SmokeP615PageView, operationId: string): number | null {
  for (const event of page.events) {
    if (event.kind === "editor.operation.completed" && event.operation_id === operationId) return event.seq;
  }
  return null;
}

/**
 * Prepare one verified read_only epoch. Verification is the provider's own
 * pre-start inspection (exact one-bind RO mount, user, network, read-only
 * rootfs, labels, scratch env — the same gate the P6.3/P6.13 Docker matrices
 * prove): preparation success IS the sandbox proof, and any mismatch rolls
 * the container back with zero live epoch. No raw docker CLI surface exists
 * here beyond the provider transport (the P5.14 context bootstrap stays the
 * only main.ts spawnSync site).
 *
 * One bounded retry covers the documented transient class (Docker Desktop
 * HCS/pipe hiccups under parallel load): the SAME args are prepared again
 * after 5 s. Fencing failures (stale/foreign/revoked/live-epoch/HOLD) never
 * retry — they fail closed immediately.
 */
async function smokeP615PrepareRoEpoch(
  provider: DockerAccessEpochProvider,
  args: { sessionId: string; epoch: number; leaf: string; leaseId: string; policyDigest: string; containerName: string },
): Promise<{ ok: true; containerName: string } | { ok: false; code: string; message: string }> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const handle = await provider.prepareEpoch({
        sessionId: args.sessionId,
        generation: 1,
        epoch: args.epoch,
        access: "read_only",
        leafHostPath: args.leaf,
        leaseId: args.leaseId,
        policyDigest: args.policyDigest,
        containerName: args.containerName,
        testRunId: SMOKE_P615_TEST_RUN_ID,
      });
      if (attempt > 1) console.log(`P615_MAIN epoch-prepared-after-retry attempt=${attempt}`);
      return { ok: true, containerName: handle.containerName };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      const transient = code === "SPAWN_FAILED" || code === "TRANSPORT_FAILED";
      if (transient && attempt === 1) {
        console.log(`P615_MAIN epoch-prepare-transient code=${String(code)} (bounded retry in 5 s)`);
        await smokeP615Sleep(5000);
        continue;
      }
      return { ok: false, code: "EPOCH_PREPARE_FAILED", message: error instanceof Error ? error.message : "read-only epoch preparation failed" };
    }
  }
  return { ok: false, code: "EPOCH_PREPARE_FAILED", message: "read-only epoch preparation failed twice" };
}

/**
 * The main-side visual scenario: observe the trusted editor journal the
 * renderer drives through real IPC, and interleave REAL read_only epoch
 * observations on the SAME session leaf (verified RO inspect, before-save
 * seed read, denied guest write, after-save B1 read, real node run, daemon-
 * confirmed retirement). All terminal bytes originate from actual Docker
 * execution, never fixture text. Pushes to the renderer are display data
 * only and carry no authority.
 */
async function runSmokeP615Scenario(
  window: BrowserWindow,
  runtimeImage: string,
  dockerExe: string,
  privateConfigDir: string,
  facts: SmokeP615Facts,
  pushObservation: (phase: "before-save" | "denied-write" | "after-save" | "run", target: string, exitCode: number | null, stdout: string) => void,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const reviewed = smokeP615Reviewed;
  if (reviewed === null) return { ok: false, code: "NOT_AUTHORIZED", message: "smoke-p615 reviewed bundle is missing" };
  // Per-run container lineage (never renderer input): epoch container names
  // carry the gate-provided run label so concurrent or retried runs cannot
  // collide on names (a stale same-name container would fail the prepare
  // closed instead of observing a foreign epoch).
  const rawLabel = process.env["CF_P615_RUN_LABEL"] ?? "manual";
  const runLabel = rawLabel.toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 32) || "manual";
  // (1) The renderer-driven editor session appears after lesson:load.
  const first = await smokeP615PollFor(() => {
    const record = [...smokeP615Sessions.values()][0] ?? null;
    return record;
  }, 60000, 250);
  if (first === null) return { ok: false, code: "TIMEOUT", message: "smoke-p615 editor session never opened" };
  facts.sessionId = first.sessionId;
  // Open completion with the exact seed buffer (zero disk mutation).
  const opened = await smokeP615PollFor(async () => {
    const page = await smokeP615ReadPage(first.driver, first.sessionId, 1);
    if (page === null) return null;
    const seq = smokeP615CompletedSeq(page, SMOKE_P615_OPEN_OPERATION_ID);
    if (seq === null) return null;
    const document = page.documents[0] ?? null;
    if (document === null || document.content !== SMOKE_P615_SEED_TEXT) return null;
    return { seq, page };
  }, 60000, 250);
  if (opened === null) return { ok: false, code: "OPEN_MISMATCH", message: "seeded open never completed exact" };
  facts.openSeq = opened.seq;
  facts.documentId = opened.page.documents[0]?.document_id ?? null;
  console.log(`P615_MAIN open-observed seq=${opened.seq}`);
  // Epoch observations run in TWO short-lived verified read_only epochs on
  // the SAME session leaf. One epoch cannot span the paced visual typing:
  // the runtime image's guest supervisor enforces its 15 s guest lease
  // without the P5 handshake (the P5 provider maintains it; the epoch
  // provider intentionally performs observation-only exec transport), so an
  // epoch prepared before typing self-exits before the save. Each visual
  // epoch prepares, observes and retires inside ~10 s; same-container RO
  // continuity stays proven by the P6.5/P6.13 Docker matrices.
  let epochProvider: DockerAccessEpochProvider;
  try {
    epochProvider = new DockerAccessEpochProvider({
      cli: { dockerExe, context: "desktop-linux", configDir: privateConfigDir, clientEnv: {} },
      imageReference: runtimeImage,
      installationId: SMOKE_P615_INSTALLATION_ID,
    });
  } catch (error) {
    return { ok: false, code: "IMAGE_UNAVAILABLE", message: error instanceof Error ? error.message : "epoch provider unavailable" };
  }
  // Phase A (before-save): the terminal sees the committed seed bytes
  // (typing only touches main-owned buffers; nothing leaks unsaved
  // presentation). Retired promptly, long before the save.
  const beforeEpoch = await smokeP615PrepareRoEpoch(epochProvider, {
    sessionId: first.sessionId,
    epoch: 1,
    leaf: first.leaf,
    leaseId: "p615-lease-ro-before",
    policyDigest: reviewed.policyDigest,
    containerName: `${SMOKE_P615_CONTAINER_PREFIX}ro-before-${runLabel}`,
  });
  if (!beforeEpoch.ok) return beforeEpoch;
  facts.roVerified = true;
  const beforeContainer = beforeEpoch.containerName;
  try {
    const live = epochProvider.liveEpoch();
    if (live === null || live.containerName !== beforeContainer) {
      return { ok: false, code: "STALE_EPOCH", message: "read-only epoch lost before observation" };
    }
    const before = await epochProvider.readEpochFile(live, SMOKE_P615_SEED_PATH);
    facts.beforeExit = before.exitCode;
    facts.beforeStdout = before.stdout;
    if (before.exitCode !== 0 || before.stdout !== SMOKE_P615_SEED_TEXT) {
      await epochProvider.retireEpoch(live, "p615-before-mismatch").catch(() => undefined);
      return { ok: false, code: "BEFORE_SAVE_MISMATCH", message: "before-save terminal read differs from seed" };
    }
    pushObservation("before-save", SMOKE_P615_SEED_PATH, before.exitCode, before.stdout);
    // Guest writes are denied inside the read_only epoch (EROFS-class).
    const denied = await epochProvider.attemptEpochWrite(live, SMOKE_P615_SEED_PATH, "P6_HOSTILE");
    facts.deniedExit = denied.exitCode;
    if (denied.exitCode === 0) {
      await epochProvider.retireEpoch(live, "p615-write-not-denied").catch(() => undefined);
      return { ok: false, code: "WRITE_NOT_DENIED", message: "guest write succeeded inside a read_only epoch" };
    }
    pushObservation("denied-write", SMOKE_P615_SEED_PATH, denied.exitCode, "");
    const retiredBefore = await epochProvider.retireEpoch(live, "p615-before-complete");
    if (retiredBefore.cleanup !== "confirmed") {
      return { ok: false, code: "CLEANUP_UNCONFIRMED", message: "before-save epoch retirement is unconfirmed" };
    }
    console.log("P615_MAIN before-done");
  } catch (error) {
    await epochProvider.retireEpoch(epochProvider.liveEpoch() as never, "p615-before-error").catch(() => undefined);
    return { ok: false, code: "TRANSPORT_FAILED", message: error instanceof Error ? error.message : "before-save observation failed" };
  }
  // Verified save completion, then the byte-exact readback barrier.
  const saved = await smokeP615PollFor(async () => {
    const page = await smokeP615ReadPage(first.driver, first.sessionId, 1);
    if (page === null) return null;
    const seq = smokeP615CompletedSeq(page, SMOKE_P615_SAVE_OPERATION_ID);
    if (seq === null) return null;
    return { seq, page };
  }, 240000, 250);
  if (saved === null) return { ok: false, code: "SAVE_TIMEOUT", message: "verified save never completed" };
  facts.saveSeq = saved.seq;
  const typeSeq = smokeP615CompletedSeq(saved.page, SMOKE_P615_TYPE_OPERATION_ID);
  facts.typeSeq = typeSeq;
  if (typeSeq === null || typeSeq > saved.seq) {
    return { ok: false, code: "ORDER_MISMATCH", message: "type completion does not precede save completion" };
  }
  let saveReadback = "";
  try {
    saveReadback = readFileSync(join(first.leaf, SMOKE_P615_SEED_PATH), "utf8");
  } catch {
    return { ok: false, code: "READBACK_FAILED", message: "saved readback unreadable" };
  }
  if (saveReadback !== SMOKE_P615_B1_TEXT) {
    return { ok: false, code: "SAVE_MISMATCH", message: "saved readback differs from trusted B1" };
  }
  facts.saveReadbackDigest = sha256HexText(saveReadback);
  facts.saveDigest = facts.saveReadbackDigest;
  console.log(`P615_MAIN save-observed seq=${saved.seq} type_seq=${typeSeq}`);
  // Phase B (after-save): a FRESH verified epoch observes the new complete
  // bytes and runs them (distinct container by construction — no stale
  // epoch is ever reused across phases).
  const afterEpoch = await smokeP615PrepareRoEpoch(epochProvider, {
    sessionId: first.sessionId,
    epoch: 2,
    leaf: first.leaf,
    leaseId: "p615-lease-ro-after",
    policyDigest: reviewed.policyDigest,
    containerName: `${SMOKE_P615_CONTAINER_PREFIX}ro-after-${runLabel}`,
  });
  if (!afterEpoch.ok) return afterEpoch;
  facts.distinctEpochs = afterEpoch.containerName !== beforeContainer;
  if (!facts.distinctEpochs) {
    return { ok: false, code: "EPOCH_REUSE", message: "after-save epoch reused the before-save container" };
  }
  // After-save through the fresh live epoch.
  try {
    const live = epochProvider.liveEpoch();
    if (live === null || live.containerName !== afterEpoch.containerName) {
      return { ok: false, code: "STALE_EPOCH", message: "read-only epoch lost before after-save observation" };
    }
    // NTFS→Docker bind propagation is eventual (design 26.7/26.12): the
    // guest reopens the path and must see the new COMPLETE file once the
    // bind propagates it (atomic rename: old-complete or new-complete,
    // never partial). Poll bounded like the canonical watcher profile.
    let after: { exitCode: number | null; stdout: string; stderr: string } | null = null;
    const afterDeadline = Date.now() + 10000;
    for (;;) {
      const probe = await epochProvider.readEpochFile(live, SMOKE_P615_SEED_PATH);
      if (probe.exitCode === 0 && probe.stdout === SMOKE_P615_B1_TEXT) {
        after = probe;
        break;
      }
      if (Date.now() > afterDeadline) {
        after = probe;
        break;
      }
      await smokeP615Sleep(250);
    }
    if (after === null) {
      return { ok: false, code: "AFTER_SAVE_MISMATCH", message: "after-save terminal read failed" };
    }
    facts.afterExit = after.exitCode;
    facts.afterStdout = after.stdout;
    if (after.exitCode !== 0 || after.stdout !== SMOKE_P615_B1_TEXT) {
      const head = JSON.stringify(after.stdout.slice(0, 60));
      const errHead = JSON.stringify(after.stderr.slice(0, 200));
      await epochProvider.retireEpoch(live, "p615-after-mismatch").catch(() => undefined);
      return { ok: false, code: "AFTER_SAVE_MISMATCH", message: `after-save terminal read differs from B1 (exit=${String(after.exitCode)} got_len=${after.stdout.length} want_len=${SMOKE_P615_B1_TEXT.length} got_head=${head} err=${errHead})` };
    }
    pushObservation("after-save", SMOKE_P615_SEED_PATH, after.exitCode, after.stdout);
    const run = await epochProvider.runEpochScript(live, SMOKE_P615_SEED_PATH);
    facts.runExit = run.exitCode;
    facts.runStdout = run.stdout;
    if (run.exitCode !== 0 || run.stdout !== SMOKE_P615_RUN_STDOUT) {
      return { ok: false, code: "RUN_MISMATCH", message: "terminal run output differs from saved execution" };
    }
    pushObservation("run", SMOKE_P615_SEED_PATH, run.exitCode, run.stdout);
    const retired = await epochProvider.retireEpoch(live, "p615-after-complete");
    facts.retiredConfirmed = retired.cleanup === "confirmed";
    if (!facts.retiredConfirmed) {
      return { ok: false, code: "CLEANUP_UNCONFIRMED", message: "after-save epoch retirement is unconfirmed" };
    }
    console.log("P615_MAIN after-done");
  } catch (error) {
    await epochProvider.retireEpoch(epochProvider.liveEpoch() as never, "p615-after-error").catch(() => undefined);
    return { ok: false, code: "TRANSPORT_FAILED", message: error instanceof Error ? error.message : "after-save observation failed" };
  }
  // The intentionally-unsaved second type installs (reset must clear it).
  const dirtied = await smokeP615PollFor(async () => {
    const page = await smokeP615ReadPage(first.driver, first.sessionId, 1);
    if (page === null) return null;
    const seq = smokeP615CompletedSeq(page, SMOKE_P615_DIRTY_OPERATION_ID);
    if (seq === null) return null;
    return { seq };
  }, 240000, 250);
  if (dirtied === null) return { ok: false, code: "DIRTY_TIMEOUT", message: "unsaved second type never completed" };
  facts.dirtySeq = dirtied.seq;
  console.log(`P615_MAIN dirty-observed seq=${dirtied.seq}`);
  // Reset reseed: the reload opens a fresh session on a reseeded leaf; the
  // retired leaf must be gone (ownership-scoped removal, never reuse).
  const reseeded = await smokeP615PollFor(() => {
    const records = [...smokeP615Sessions.values()];
    return records.find((record) => record.sessionId !== first.sessionId) ?? null;
  }, 240000, 250);
  if (reseeded === null) return { ok: false, code: "RESEED_TIMEOUT", message: "no fresh session after reload" };
  facts.reseedSessionId = reseeded.sessionId;
  if (BrowserWindow.getAllWindows().length === 0) return { ok: false, code: "WINDOW_CLOSED", message: "window closed before reseed verification" };
  try {
    const reseedBytes = readFileSync(join(reseeded.leaf, SMOKE_P615_SEED_PATH), "utf8");
    if (reseedBytes !== SMOKE_P615_SEED_TEXT) {
      return { ok: false, code: "RESEED_MISMATCH", message: "reseeded leaf differs from seed" };
    }
    facts.reseedReadbackDigest = sha256HexText(reseedBytes);
  } catch {
    return { ok: false, code: "RESEED_MISMATCH", message: "reseeded leaf unreadable" };
  }
  facts.oldLeafRemoved = !existsSync(first.leaf);
  if (!facts.oldLeafRemoved) {
    return { ok: false, code: "LEAF_RETAINED", message: "retired session leaf was not removed" };
  }
  console.log("P615_MAIN reseed-verified");
  void window;
  return { ok: true };
}

function verifySmokeP615Report(report: ReadyReport, facts: SmokeP615Facts): { ok: boolean; details: string } {
  try {
    if (report["smokeP615"] !== true) return { ok: false, details: "missing smokeP615 flag" };
    if (report["ok"] !== true) return { ok: false, details: `renderer flow failed: ${String(report["code"] ?? "unknown")} ${String(report["message"] ?? "")}` };
    const reviewed = smokeP615Reviewed;
    if (reviewed === null) return { ok: false, details: "reviewed bundle missing at verify" };
    // Session correlation (first generation + reseed generation).
    if (report["session_id"] !== facts.sessionId) return { ok: false, details: "renderer session does not match the observed leaf session" };
    if (report["new_session_id"] !== facts.reseedSessionId) return { ok: false, details: "renderer reseed session mismatch" };
    if (report["generation"] !== 1 || report["new_generation"] !== 1) return { ok: false, details: "unexpected generation" };
    // Monaco visual correlation against main-owned buffers.
    const monaco = report["monaco"] as Record<string, unknown> | undefined;
    if (!monaco) return { ok: false, details: "renderer sent no Monaco diagnostics" };
    if (monaco["opened"] !== SMOKE_P615_SEED_TEXT) return { ok: false, details: "opened Monaco text differs from seed" };
    const midType = monaco["midType"];
    if (typeof midType !== "string" || midType === SMOKE_P615_SEED_TEXT || midType === SMOKE_P615_B1_TEXT) {
      return { ok: false, details: "no strict intermediate prefix was projected" };
    }
    if (!SMOKE_P615_B1_TEXT.startsWith(midType)) return { ok: false, details: "intermediate prefix is not a strict B1 prefix" };
    if (monaco["typedFinal"] !== SMOKE_P615_B1_TEXT) return { ok: false, details: "typed-final Monaco text differs from B1" };
    if (monaco["dirtyPending"] !== SMOKE_P615_B1_TEXT + 'console.log("P6_DIRTY");\n') {
      return { ok: false, details: "dirty-pending Monaco text differs from B1+DIRTY" };
    }
    if (monaco["reseeded"] !== SMOKE_P615_SEED_TEXT) return { ok: false, details: "reseeded Monaco text differs from seed" };
    // ACK correlation: every trusted frame acked exactly once.
    const frameCount = report["frameCount"];
    const ackCount = report["ackCount"];
    if (typeof frameCount !== "number" || frameCount < 8) return { ok: false, details: `too few trusted frames (${String(frameCount)})` };
    if (ackCount !== frameCount) return { ok: false, details: `ack/frame mismatch (acks=${String(ackCount)} frames=${String(frameCount)})` };
    // Terminal correlation: real bytes, real exit, rendered through xterm.
    if (facts.beforeStdout !== SMOKE_P615_SEED_TEXT || facts.beforeExit !== 0) return { ok: false, details: "before-save facts mismatch" };
    if (typeof facts.deniedExit !== "number" || facts.deniedExit === 0) return { ok: false, details: "guest write was not denied" };
    if (facts.afterStdout !== SMOKE_P615_B1_TEXT || facts.afterExit !== 0) return { ok: false, details: "after-save facts mismatch" };
    if (facts.runStdout !== SMOKE_P615_RUN_STDOUT || facts.runExit !== 0) return { ok: false, details: "run facts mismatch" };
    if (!facts.roVerified || !facts.distinctEpochs || !facts.retiredConfirmed) {
      return { ok: false, details: "epoch facts incomplete (RO/distinct-epochs/retired)" };
    }
    const rendered = (report["xtermRenderedSeqs"] as unknown[] | undefined) ?? [];
    for (const seq of [1, 2, 3, 4]) {
      if (!rendered.includes(seq)) return { ok: false, details: `observation seq ${seq} was not rendered through xterm` };
    }
    if (report["xtermCallbackMatched"] !== true) return { ok: false, details: "xterm callback proof missing" };
    // Journal correlation: monotonic completions in authored order, save digest exact.
    const seqs = [facts.openSeq, facts.typeSeq, facts.saveSeq, facts.dirtySeq];
    if (seqs.some((seq) => typeof seq !== "number")) return { ok: false, details: "journal completions incomplete" };
    for (let index = 1; index < seqs.length; index += 1) {
      if ((seqs[index] as number) <= (seqs[index - 1] as number)) return { ok: false, details: "journal completions out of order" };
    }
    if (facts.saveDigest !== sha256HexText(SMOKE_P615_B1_TEXT)) return { ok: false, details: "save digest mismatch" };
    if (facts.saveReadbackDigest !== facts.saveDigest) return { ok: false, details: "save readback digest mismatch" };
    // Reset correlation: reseed digest exact, old leaf gone, stale work fenced.
    if (facts.reseedReadbackDigest !== reviewed.seedSha256) return { ok: false, details: "reseed digest mismatch" };
    if (!facts.oldLeafRemoved) return { ok: false, details: "retired leaf retained" };
    if (report["staleAckFenced"] !== true) return { ok: false, details: "stale acknowledgement was not fenced" };
    if (report["recordSafe"] !== isSmokeP615RecordSafe) return { ok: false, details: "record-safe flag mismatch" };
    return { ok: true, details: "correlated main/renderer proof" };
  } catch (error) {
    return { ok: false, details: error instanceof Error ? error.message : "verification threw" };
  }
}

function finishSmokeP615(window: BrowserWindow, result: Record<string, unknown>, exitCode: number): void {
  console.log("SMOKE_P615_RESULT " + JSON.stringify(result));
  // Hold the window open so capture-window.ps1 can bound-capture the live
  // visual checkpoints. The shutdown barrier (before-quit) still owns leaf
  // teardown — never app.exit bypass for visual proof.
  process.exitCode = exitCode;
  setTimeout(() => {
    // P5.15 lifecycle repair: a close racing destruction must never throw
    // "Object has been destroyed".
    safeCloseWindow(window);
    setTimeout(() => {
      if (BrowserWindow.getAllWindows().length === 0) app.quit();
    }, 2000);
  }, 10000);
}

function startSmokeP615(): void {
  // Main-authorized safe fixture first: without it the run is a HOLD, never
  // an execution of unreviewed content.
  createTerminalHost();
  createEditorHost();
  createBrowserHost();
  createRuntimeHost();
  if (terminalIpcHost === null || editorIpcHost === null || engineHostForSmoke === null) {
    console.log(
      "SMOKE_P615_RESULT " +
        JSON.stringify({ smokeP615: true, ok: false, code: terminalUnavailable?.code ?? editorUnavailable?.code ?? "WORKSPACE_UNAVAILABLE", message: "p615 hosts unavailable" }),
    );
    app.exit(2);
    return;
  }
  if (!loadAndRegisterSmokeP615()) {
    console.log("SMOKE_P615_RESULT " + JSON.stringify({ smokeP615: true, ok: false, code: "IR_INVALID", message: "smoke-p615 fixture failed validation" }));
    app.exit(2);
    return;
  }
  const runtimeImage = process.env["CF_TERMINAL_RUNTIME_IMAGE"] ?? "";
  if (runtimeImage.length === 0) {
    console.log("SMOKE_P615_RESULT " + JSON.stringify({ smokeP615: true, ok: false, code: "IMAGE_UNAVAILABLE", message: "terminal runtime image is not configured (CF_TERMINAL_RUNTIME_IMAGE)" }));
    app.exit(2);
    return;
  }
  const userDataDir = app.getPath("userData");
  const privateConfigDir = join(userDataDir, "terminal-docker-config");
  const dockerExe = process.env["CF_TERMINAL_DOCKER_EXE"] ?? resolveDockerExe();
  const reviewed = smokeP615Reviewed;
  const window = createWindow();
  // Smoke-only window management (never production behavior): restore and
  // keep the visual-proof window topmost so checkpoint captures always read
  // its own pixels. The capture harness launches backgrounded and the OS may
  // refuse its foreground switch; without topmost the captures could archive
  // whatever occludes the app instead of failing loudly. The brightness
  // gate still arbitrates every capture. Restoration is best-effort: a
  // locked/disconnected desktop session cannot paint regardless (HOLD).
  try {
    window.restore();
    window.setAlwaysOnTop(true);
    window.focus();
  } catch {
    // Window management is best-effort; the capture brightness gate decides.
  }
  const facts: SmokeP615Facts = {
    sessionId: null,
    documentId: null,
    openSeq: null,
    typeSeq: null,
    saveSeq: null,
    saveDigest: null,
    saveRevision: null,
    dirtySeq: null,
    beforeStdout: null,
    beforeExit: null,
    deniedExit: null,
    afterStdout: null,
    afterExit: null,
    runStdout: null,
    runExit: null,
    roVerified: false,
    distinctEpochs: false,
    retiredConfirmed: false,
    saveReadbackDigest: null,
    reseedSessionId: null,
    reseedReadbackDigest: null,
    oldLeafRemoved: false,
  };
  // P5.15 lifecycle repair: exactly one finish across the timeout path, the
  // scenario path, the report poller and window close.
  const finishOnce = createFinishOnce();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  const cancelPending = (): void => {
    if (timeout !== undefined) clearTimeout(timeout);
    if (poll !== undefined) clearInterval(poll);
  };
  let observationSeq = 0;
  const pushObservation = (phase: "before-save" | "denied-write" | "after-save" | "run", target: string, exitCode: number | null, stdout: string): void => {
    observationSeq += 1;
    safeSendToWindow(window, P615_OBSERVATION_CHANNEL, {
      smokeP615: true,
      seq: observationSeq,
      phase,
      target,
      exit_code: exitCode,
      stdout: stdout.slice(0, 65536),
    });
  };
  const finishWith = (result: Record<string, unknown>, exitCode: number): void => {
    if (!finishOnce()) return;
    cancelPending();
    setTimeout(() => finishSmokeP615(window, result, exitCode), 250);
  };
  timeout = setTimeout(() => {
    const result = { smokeP615: true, ok: false, code: "TIMEOUT", message: "smoke-p615 visual proof timed out", windowCreated: true, rendererLoaded };
    finishWith(result, 1);
  }, 420000);
  // Main-side scenario runs beside the renderer flow (both observe the same
  // trusted journal; neither can forge the other's facts).
  void runSmokeP615Scenario(window, runtimeImage, dockerExe, privateConfigDir, facts, pushObservation).then((outcome) => {
    if (!outcome.ok) {
      const result = { smokeP615: true, ok: false, code: outcome.code, message: outcome.message, windowCreated: true, rendererLoaded };
      finishWith(result, outcome.code === "TIMEOUT" || outcome.code === "WINDOW_CLOSED" ? 1 : 2);
    }
  });
  poll = setInterval(() => {
    const report = latestReadyReport;
    if (report !== null && report["smokeP615"] === true && report["ok"] !== undefined && rendererLoaded) {
      const verification = verifySmokeP615Report(report, facts);
      const result = {
        smokeP615: true,
        ok: verification.ok,
        details: verification.details,
        windowCreated: true,
        windowSize: safeGetWindowBounds(window),
        rendererLoaded,
        session_id: facts.sessionId,
        reseed_session_id: facts.reseedSessionId,
        open_seq: facts.openSeq,
        type_seq: facts.typeSeq,
        save_seq: facts.saveSeq,
        dirty_seq: facts.dirtySeq,
        save_digest: facts.saveDigest,
        before_exit: facts.beforeExit,
        denied_exit: facts.deniedExit,
        after_exit: facts.afterExit,
        run_exit: facts.runExit,
        ro_verified: facts.roVerified,
        distinct_epochs: facts.distinctEpochs,
        retired_confirmed: facts.retiredConfirmed,
        old_leaf_removed: facts.oldLeafRemoved,
        lesson_compiled_digest: reviewed?.lessonCompiledDigest ?? null,
        seed_manifest_digest: reviewed?.seedManifestDigest ?? null,
        policy_digest: reviewed?.policyDigest ?? null,
        runtime_image: runtimeImageForSmoke,
        recordSafe: report["recordSafe"] ?? false,
        rendererReport: report,
      };
      finishWith(result, verification.ok ? 0 : 1);
    }
  }, 100);
  window.once("closed", cancelPending);
}

// -- P7.9 visual smoke -------------------------------------------------------

let smokeP7Digest = "";

function loadAndRegisterSmokeP7(): boolean {
  try {
    const raw = readFileSync(join(APP_ROOT, "fixtures", "compiled-lessons", `${SMOKE_P7_FIXTURE_ID}.json`), "utf8");
    const data: unknown = JSON.parse(raw);
    const result = loadCompiledLessonData(data);
    if (!result.ok || result.ir === undefined) return false;
    const digest = canonicalCompiledDigest(result.ir);
    smokeP7Digest = digest;
    registerReviewedLesson({
      lesson_id: result.ir.lesson.lesson_id,
      course_id: result.ir.lesson.course_id,
      lesson_compiled_digest: digest,
      reviewed_note: SMOKE_P7_REVIEW_NOTE,
    });
    return true;
  } catch {
    return false;
  }
}

function finishSmokeP7(window: BrowserWindow, result: Record<string, unknown>, exitCode: number): void {
  console.log("SMOKE_P7_RESULT " + JSON.stringify(result));
  process.exitCode = exitCode;
  setTimeout(() => {
    safeCloseWindow(window);
    setTimeout(() => {
      if (BrowserWindow.getAllWindows().length === 0) app.quit();
    }, 2000);
  }, 10000);
}

function startSmokeP7(): void {
  createTerminalHost();
  createEditorHost();
  createBrowserHost();
  createRuntimeHost();

  if (browserIpcHost === null) {
    console.log(
      "SMOKE_P7_RESULT " +
        JSON.stringify({ smokeP7: true, ok: false, code: "BROWSER_UNAVAILABLE", message: "browser host unavailable" }),
    );
    app.exit(2);
    return;
  }

  if (!loadAndRegisterSmokeP7()) {
    console.log("SMOKE_P7_RESULT " + JSON.stringify({ smokeP7: true, ok: false, code: "IR_INVALID", message: "smoke-p7 fixture failed validation" }));
    app.exit(2);
    return;
  }

  async function startFixtureServerWithRetry(attempts = 5): Promise<FixtureServerInstance> {
    for (let i = 0; i < attempts; i++) {
      try {
        return await startFixtureServer({ host: "127.0.0.1", port: SMOKE_P7_FIXTURE_PORT });
      } catch (err) {
        if (i === attempts - 1) throw err;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    throw new Error("startFixtureServer timed out");
  }

  let fixtureServer: FixtureServerInstance | null = null;
  void startFixtureServerWithRetry().then(
    (server) => {
      fixtureServer = server;
      runSmokeP7WithServer(server);
    },
    (err) => {
      console.log("SMOKE_P7_RESULT " + JSON.stringify({ smokeP7: true, ok: false, code: "FIXTURE_SERVER_FAILED", message: String(err) }));
      app.exit(2);
    },
  );

  function runSmokeP7WithServer(server: FixtureServerInstance): void {
    const window = createWindow();
    try {
      window.restore();
      window.setAlwaysOnTop(true);
      window.focus();
    } catch {}

    const finishOnce = createFinishOnce();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;

    const cancelPending = (): void => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (poll !== undefined) clearInterval(poll);
    };

    const finishWith = async (result: Record<string, unknown>, exitCode: number): Promise<void> => {
      if (!finishOnce()) return;
      cancelPending();
      if (fixtureServer !== null) {
        try {
          await fixtureServer.close();
        } catch {}
        fixtureServer = null;
      }
      setTimeout(() => finishSmokeP7(window, result, exitCode), 250);
    };

    timeout = setTimeout(() => {
      const result = { smokeP7: true, ok: false, code: "TIMEOUT", message: "smoke-p7 visual proof timed out", windowCreated: true, rendererLoaded };
      void finishWith(result, 1);
    }, 180000);

    poll = setInterval(() => {
      const report = latestReadyReport;
      if (report !== null && report["smokeP7"] === true && report["ok"] !== undefined && rendererLoaded) {
        const ok = report["ok"] === true;
        const result = {
          smokeP7: true,
          ok,
          details: ok ? "correlated main/renderer proof" : String(report["details"] ?? "renderer error"),
          windowCreated: true,
          windowSize: safeGetWindowBounds(window),
          rendererLoaded,
          session_id: report["session_id"] ?? null,
          reset_session_id: report["reset_session_id"] ?? null,
          generation: report["generation"] ?? 1,
          reset_generation: report["reset_generation"] ?? 2,
          lesson_id: SMOKE_P7_LESSON_ID,
          course_id: SMOKE_P7_COURSE_ID,
          lesson_compiled_digest: smokeP7Digest,
          frame_count: report["frameCount"] ?? 0,
          recordSafe: report["recordSafe"] ?? false,
          checkpoints: report["checkpoints"] ?? [],
          rendererReport: report,
        };
        void finishWith(result, ok ? 0 : 1);
      }
    }, 100);

    window.once("closed", cancelPending);
  }
}

// -- P8.9 real Electron visual proof -----------------------------------------

let smokeP8Digest = "";

function loadAndRegisterSmokeP8(): boolean {
  try {
    const raw = readFileSync(join(APP_ROOT, "fixtures", "compiled-lessons", `${SMOKE_P8_FIXTURE_ID}.json`), "utf8");
    const data: unknown = JSON.parse(raw);
    const result = loadCompiledLessonData(data);
    if (!result.ok || result.ir === undefined) return false;
    const digest = canonicalCompiledDigest(result.ir);
    smokeP8Digest = digest;
    registerReviewedLesson({
      lesson_id: result.ir.lesson.lesson_id,
      course_id: result.ir.lesson.course_id,
      lesson_compiled_digest: digest,
      reviewed_note: SMOKE_P8_REVIEW_NOTE,
    });
    return true;
  } catch {
    return false;
  }
}

function finishSmokeP8(window: BrowserWindow, result: Record<string, unknown>, exitCode: number): void {
  console.log("SMOKE_P8_RESULT " + JSON.stringify(result));
  process.exitCode = exitCode;
  setTimeout(() => {
    safeCloseWindow(window);
    setTimeout(() => {
      if (BrowserWindow.getAllWindows().length === 0) app.quit();
    }, 1000);
  }, 2000);
}

async function startSmokeP8(): Promise<void> {
  createTerminalHost();
  createEditorHost();
  createBrowserHost();

  if (!loadAndRegisterSmokeP8()) {
    console.log(
      "SMOKE_P8_RESULT " +
        JSON.stringify({ smokeP8: true, ok: false, code: "IR_INVALID", message: "smoke-p8 fixture failed validation" }),
    );
    app.exit(2);
    return;
  }

  const rawLesson = JSON.parse(
    readFileSync(join(APP_ROOT, "fixtures", "compiled-lessons", `${SMOKE_P8_FIXTURE_ID}.json`), "utf8"),
  );
  const loadedLesson = loadCompiledLessonData(rawLesson);
  if (!loadedLesson.ok || !loadedLesson.ir) {
    console.log(
      "SMOKE_P8_RESULT " +
        JSON.stringify({ smokeP8: true, ok: false, code: "IR_INVALID", message: "smoke-p8 fixture failed loading" }),
    );
    app.exit(2);
    return;
  }
  const compiledLesson = loadedLesson.ir;

  if (!engineHostForSmoke || !runtimeImageForSmoke) {
    console.log(
      "SMOKE_P8_RESULT " +
        JSON.stringify({ smokeP8: true, ok: false, code: "TERMINAL_UNAVAILABLE", message: `terminal engine host or image unavailable: ${JSON.stringify(terminalUnavailable)}` }),
    );
    app.exit(2);
    return;
  }

  // 1. Ephemeral loopback port for container dev server bridge
  let allocatedContainerPort = 0;
  try {
    allocatedContainerPort = await allocateEphemeralLoopbackPort();
  } catch (portErr) {
    console.log(
      "SMOKE_P8_RESULT " +
        JSON.stringify({ smokeP8: true, ok: false, code: "PORT_UNAVAILABLE", message: "failed to allocate loopback port" }),
    );
    app.exit(2);
    return;
  }

  const SMOKE_SESSION_ID = `sess-${compiledLesson.lesson.lesson_id}`;
  const networkName = buildBridgeNetworkName(SMOKE_SESSION_ID);

  const leafPath = join(engineHostForSmoke.getWorkspaceRoot(), "workspaces", compiledLesson.lesson.lesson_id, SMOKE_SESSION_ID);
  const stagingPath = join(engineHostForSmoke.getWorkspaceRoot(), "staging", compiledLesson.lesson.lesson_id, SMOKE_SESSION_ID);
  try { rmSync(leafPath, { recursive: true, force: true }); } catch {}
  try { rmSync(stagingPath, { recursive: true, force: true }); } catch {}

  // 2. Open real terminal session on engineHostForSmoke
  const termOpened = engineHostForSmoke.openSession(compiledLesson, {
    executionAuthorized: true,
    session_id: SMOKE_SESSION_ID,
    bridge: {
      networkName,
      hostPort: allocatedContainerPort,
      guestPort: 3000,
    },
  });
  if (!termOpened.ok) {
    console.log(
      "SMOKE_P8_RESULT " +
        JSON.stringify({ smokeP8: true, ok: false, code: termOpened.rejection.code, message: termOpened.rejection.message }),
    );
    app.exit(2);
    return;
  }

  mkdirSync(join(leafPath, "src"), { recursive: true });
  mkdirSync(stagingPath, { recursive: true });

  // 3. Open WindowsFileAdapter on the exact same leaf
  const boundEditor = openWindowsFileAdapter({
    sessionId: SMOKE_SESSION_ID,
    generation: 1,
    workspaceId: "smoke-p8-ws",
    leafHostPath: leafPath,
    stagingHostPath: stagingPath,
  });
  const fileAdapter = boundEditor.ok ? boundEditor.value : null;

  let currentGen = 1;
  let inMemoryContent = "";

  const editorSession: EditorDomainSession = {
    get sessionId() {
      return SMOKE_SESSION_ID;
    },
    get generation() {
      return currentGen;
    },
    admit: () => ({ ok: true, domain_seq: 1 }),
    execute: async (admission: EditorAdapterAdmission) => {
      if (admission.actionType === "file_create") {
        const filePath = join(leafPath, "src", "app.js");
        writeFileSync(filePath, "", "utf8");
        return { ok: true, domain_seq: 2 };
      }
      if (admission.actionType === "type_code") {
        const step = compiledLesson.scenes[0]!.steps.find((s) => s.step_id === admission.operationId);
        inMemoryContent =
          step?.kind === "operation" && "content" in step.operation.parameters
            ? (step.operation.parameters as { content: string }).content
            : "";
        return { ok: true, domain_seq: 3 };
      }
      if (admission.actionType === "file_save") {
        const filePath = join(leafPath, "src", "app.js");
        writeFileSync(filePath, inMemoryContent, "utf8");
        await new Promise((r) => setTimeout(r, 1500));
        return { ok: true, domain_seq: 4 };
      }
      return { ok: true, domain_seq: 5 };
    },
    cancel: () => {},
    reset: (gen: number) => {
      currentGen = gen;
      inMemoryContent = "";
    },
    close: () => {},
  };

  const terminalSession: TerminalDomainSession = {
    get sessionId() {
      return SMOKE_SESSION_ID;
    },
    get generation() {
      return currentGen;
    },
    runOperation: async (req: { session_id: string; operation_id: string; request_id: string }) => {
      const step = compiledLesson.scenes[0]!.steps.find((s) => s.step_id === req.operation_id);
      const mode = step?.kind === "operation" ? (step.operation.parameters as any)?.mode : undefined;
      const res = await engineHostForSmoke!.handleRunOperation({
        session_id: SMOKE_SESSION_ID,
        operation_id: req.operation_id,
        request_id: req.request_id,
      });
      if (!res.ok) {
        return { ok: false, error: { code: res.rejection.code, message: res.rejection.message } };
      }
      if (mode === "foreground") {
        const exitCode = res.value.result?.exit_code ?? 0;
        return { ok: exitCode === 0, exit_code: exitCode, domain_seq: 10 };
      }
      if (mode === "background") {
        return { ok: true, isBackground: true, domain_seq: 11 };
      }
      return { ok: true, domain_seq: 12 };
    },
    stopProcess: async (req: { session_id: string; process_id: string; request_id: string }) => {
      const res = await engineHostForSmoke!.handleStopProcess({
        session_id: SMOKE_SESSION_ID,
        process_id: req.process_id,
        request_id: req.request_id,
      });
      return { ok: res.ok, domain_seq: 13 };
    },
    cancelOperation: () => {},
    reset: async (gen: number) => {
      currentGen = gen;
      await engineHostForSmoke!.handleResetRuntime({ session_id: SMOKE_SESSION_ID, request_id: `req-reset-${gen}` });
    },
    close: async () => {
      await engineHostForSmoke!.closeSession(SMOKE_SESSION_ID, "lesson_end");
    },
  };

  let bridgeCoordinator: LocalhostBridgeCoordinator | null = null;
  let browserRuntimeHost: BrowserRuntimeHost | null = null;
  let frameProducer: BrowserFrameProducer | null = null;
  let browserAdmission: BrowserAdmissionSession | null = null;

  const initBrowserHost = async () => {
    if (browserRuntimeHost) return browserRuntimeHost;
    bridgeCoordinator = new LocalhostBridgeCoordinator(SMOKE_SESSION_ID, currentGen);
    const cap: ReviewedPortCapabilityV1 = {
      kind: "reviewed_port_capability",
      capability_version: 1,
      capability_id: "cap-demo-server",
      lesson_id: compiledLesson.lesson.lesson_id,
      session_id: SMOKE_SESSION_ID,
      generation: currentGen,
      background_process_id: "demo_server",
      guest_port: 3000,
      reviewed_origin: "http://localhost:3000",
      policy_version: 1,
      policy_digest: sha256Hex("smoke-p8-browser-policy"),
    };
    const binding = await bridgeCoordinator.activateBridge(cap, allocatedContainerPort);

    browserRuntimeHost = new BrowserRuntimeHost({ bridgeCoordinator });
    await browserRuntimeHost.prepareSession({
      sessionId: SMOKE_SESSION_ID,
      generation: currentGen,
      headless: true,
      allowedOrigins: [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        binding.bridge_origin,
      ],
    });

    const browserCatalog = createReviewedBrowserCatalog(compiledLesson);
    const reviewedOps: Record<string, any> = {};
    for (const [opId, entry] of browserCatalog.browser_operations.entries()) {
      reviewedOps[opId] = {
        operation_id: entry.operation_id,
        action_type: entry.action_type,
        ...(entry.target_origin ? { target_origin: entry.target_origin } : {}),
      };
    }
    const browserPolicy = createReviewedBrowserPolicy({
      course_id: compiledLesson.lesson.course_id,
      lesson_id: compiledLesson.lesson.lesson_id,
      compiled_ir_digest: smokeP8Digest,
      allowed_origins: ["http://localhost:3000", "http://127.0.0.1:3000", binding.bridge_origin],
      reviewed_operations: reviewedOps,
      port_capabilities: [cap],
    });
    browserAdmission = new BrowserAdmissionSession({
      session_id: SMOKE_SESSION_ID,
      generation: currentGen,
      catalog: browserCatalog,
      policy: browserPolicy,
    });

    const page = browserRuntimeHost.getActiveSession()?.getPrimaryPageHandle();
    if (page && page.isAlive()) {
      frameProducer = new BrowserFrameProducer({
        sessionId: SMOKE_SESSION_ID,
        generation: currentGen,
        pageHandle: page,
        onFrame: (frame) => {
          const win = BrowserWindow.getAllWindows()[0];
          if (win) safeSendToWindow(win, "browser:frame", frame);
        },
      });
      void frameProducer.start();
    }

    return browserRuntimeHost;
  };

  const browserSession: BrowserDomainSession = {
    get sessionId() {
      return SMOKE_SESSION_ID;
    },
    get generation() {
      return currentGen;
    },
    runOperation: async (req: { session_id: string; operation_id: string; request_id: string }) => {
      const host = await initBrowserHost();
      if (!browserAdmission) return { ok: false, error: { code: "NOT_AUTHORIZED", message: "no admission" } };
      const outcome = await host.runOperation(browserAdmission, {
        session_id: SMOKE_SESSION_ID,
        operation_id: req.operation_id,
        request_id: req.request_id,
      });
      if (!outcome.ok) {
        return { ok: false, error: { code: outcome.rejection.code, message: outcome.rejection.message } };
      }
      return { ok: true, domain_seq: 30 };
    },
    cancelOperation: () => true,
    reset: async (gen: number) => {
      currentGen = gen;
      if (frameProducer) {
        frameProducer.stop();
        frameProducer = null;
      }
      if (browserRuntimeHost) {
        await browserRuntimeHost.close().catch(() => undefined);
        browserRuntimeHost = null;
      }
      if (bridgeCoordinator) {
        await bridgeCoordinator.close().catch(() => undefined);
        bridgeCoordinator = null;
      }
    },
    close: async () => {
      if (frameProducer) {
        frameProducer.stop();
        frameProducer = null;
      }
      if (browserRuntimeHost) {
        await browserRuntimeHost.close().catch(() => undefined);
        browserRuntimeHost = null;
      }
      if (bridgeCoordinator) {
        await bridgeCoordinator.close().catch(() => undefined);
        bridgeCoordinator = null;
      }
    },
  };

  const providers: HostAdapterProviders = {
    getEditorSession: () => editorSession,
    getTerminalSession: () => terminalSession,
    getBrowserSession: () => browserSession,
    getWaitPortReadinessProvider: () => async (_port, timeoutMs) => {
      return await waitForPortReadiness(allocatedContainerPort, timeoutMs ?? 15000, 100, "127.0.0.1");
    },
  };

  createRuntimeHost({ runtimeFactory: new DefaultRuntimeFactory(providers) });

  const window = createWindow();
  try {
    window.restore();
    window.setAlwaysOnTop(true);
    window.focus();
  } catch {}

  const finishOnce = createFinishOnce();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;

  const cancelPending = (): void => {
    if (timeout !== undefined) clearTimeout(timeout);
    if (poll !== undefined) clearInterval(poll);
  };

  const finishWith = async (result: Record<string, unknown>, exitCode: number): Promise<void> => {
    if (!finishOnce()) return;
    cancelPending();
    if (frameProducer) {
      frameProducer.stop();
      frameProducer = null;
    }
    if (browserRuntimeHost) {
      try {
        await browserRuntimeHost.close();
      } catch {}
      browserRuntimeHost = null;
    }
    if (bridgeCoordinator) {
      try {
        await bridgeCoordinator.close();
      } catch {}
      bridgeCoordinator = null;
    }
    try {
      await engineHostForSmoke?.closeSession(SMOKE_SESSION_ID, "lesson_end");
    } catch {}
    try {
      rmSync(stagingPath, { recursive: true, force: true });
    } catch {}
    setTimeout(() => finishSmokeP8(window, result, exitCode), 250);
  };

  timeout = setTimeout(() => {
    const result = {
      smokeP8: true,
      ok: false,
      code: "TIMEOUT",
      message: "smoke-p8 visual proof timed out",
      windowCreated: true,
      rendererLoaded,
    };
    void finishWith(result, 1);
  }, 180000);

  poll = setInterval(() => {
    const report = latestReadyReport;
    if (report !== null && report["smokeP8"] === true && report["ok"] !== undefined && rendererLoaded) {
      const ok = report["ok"] === true;
      const result = {
        smokeP8: true,
        ok,
        details: ok ? "canonical P8 reference lesson visual proof complete" : String(report["details"] ?? "renderer error"),
        windowCreated: true,
        windowSize: safeGetWindowBounds(window),
        rendererLoaded,
        session_id: report["session_id"] ?? null,
        reset_session_id: report["reset_session_id"] ?? null,
        generation: report["generation"] ?? 1,
        reset_generation: report["reset_generation"] ?? 2,
        lesson_id: SMOKE_P8_LESSON_ID,
        course_id: SMOKE_P8_COURSE_ID,
        lesson_compiled_digest: smokeP8Digest,
        recordSafe: report["recordSafe"] ?? false,
        checkpoints: report["checkpoints"] ?? [],
        rendererReport: report,
      };
      void finishWith(result, ok ? 0 : 1);
    }
  }, 100);

  window.once("closed", cancelPending);
}

app.whenReady().then(() => {
  // Keep the renderer accessibility tree alive for assistive technology and
  // UI automation (the IDE should be operable without pixel targeting).
  app.accessibilitySupportEnabled = true;
  if (isSmokeP8) {
    startSmokeP8();
    return;
  }
  if (isSmokeP7) {
    startSmokeP7();
    return;
  }
  if (isSmokeP615) {
    startSmokeP615();
    return;
  }
  if (isSmokeTerminal) {
    startSmokeTerminal();
    return;
  }
  createTerminalHost();
  createEditorHost();
  createBrowserHost();
  createRuntimeHost();
  if (isSmoke) {
    startSmoke();
  } else {
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }
});

// P5.11 shutdown barrier: before-quit awaits the same terminal teardown
// (bounded, 10 s); no app.exit bypass — quit proceeds only after the barrier.
// P6.12: the editor teardown joins the same barrier (owned leaves removed,
// container-free sessions settled).
// P7.6: the browser teardown joins the same barrier (Chromium terminated,
// profiles purged).
// P8.7: the runtime orchestrator teardown joins the same barrier and runs
// first (P8.6 coordinated close: Browser -> Terminal -> Workspace -> Seal Journal -> CLOSED).
app.on("before-quit", (event) => {
  if (shutdownBarrierDone || (terminalIpcHost === null && editorIpcHost === null && browserIpcHost === null && runtimeHost === null)) return;
  event.preventDefault();
  const hostRuntime = runtimeHost;
  const ipcHost = terminalIpcHost;
  const editorHost = editorIpcHost;
  const browserHost = browserIpcHost;
  void (async () => {
    try {
      await Promise.race([
        (async () => {
          if (hostRuntime !== null) await hostRuntime.shutdownAll("app_close");
          if (ipcHost !== null) await ipcHost.shutdownAll("app_close");
          if (editorHost !== null) await editorHost.shutdownAll("app_close");
          if (browserHost !== null) await browserHost.shutdownAll("app_close");
        })(),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
    } finally {
      shutdownBarrierDone = true;
      app.quit();
    }
  })();
});

app.on("window-all-closed", () => {
  app.quit();
});
