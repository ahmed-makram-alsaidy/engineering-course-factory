# @course-factory/terminal-engine (P5)

Real Terminal Engine for Course Factory: executes explicit validated compiled
operations inside **DockerSandboxProvider** — one ephemeral Linux container per
lesson runtime/session on Docker Desktop's WSL2 backend. Canonical
architecture: `docs/P5-DESIGN-SPEC.md` (P5 DESIGN VERDICT: READY).

**P5.15 status — Gate/review PASS: the authoritative final gate
(`scripts/validate-p5.mjs`, via `scripts/validate-p5.sh` /
`scripts/validate-p5-15.sh`) is green with 153 checks / 0 failures on the
final tree (prerequisites 9/9, 649 repository tests green, every per-phase
REAL Docker integration green, Testing-Plan row-proof map, fixture
regeneration byte-identical, both typechecks + production build green, three
visual smokes correlated with PNG evidence, security/boundary audits green,
0 owned containers). One authorized minimum repair (close-lifecycle defect
in the owned Electron harness + 8-test regression proof; see
docs/P5-IMPLEMENTATION.md defect record). P5 Real Terminal Engine is
COMPLETE. P6 Typing Engine NOT started.**
The workspace contains the
P5.1 contracts and image identity, the trusted admission layer (P5.2,
extended by P5.10 with trusted `WaitAdmission` for `wait
until=process_output`; duration/port waits stay `UNSUPPORTED_PHASE`), the
trusted workspace/environment resolution (P5.3), the DockerSandboxProvider
lifecycle/transport (P5.4, plus the P5.11 main-only `registerAdmittedGrants`
seam), the P5.5 process ownership layer (guest process groups, registry,
lease/heartbeat, stop semantics), the P5.6 trusted main-owned runtime journal
(strictly increasing journal `seq` + host `monotonic_ms` stamping,
chunk-spanning redaction BEFORE storage, trace-coherence invariants,
per-process per-stream transcripts, journal bounds and bounded replay pages),
the P5.7 canonical FOREGROUND completion semantics (`src/foreground.ts` +
supervisor-owned foreground groups), the P5.8 canonical BACKGROUND lifetime
semantics (`src/background.ts`), the P5.9 crash/teardown surface
(group-escape gate, reconciliation + new-session barrier, main/helper loss)
and the P5.10 waiter (`src/output-wait.ts`: register at spawn so early
markers are never lost; no execution/network machinery). The engine host
(`src/providers/terminal-host.ts`: idempotency, 10/sec rate limiting with
cancel bypass, bounded receipts/subscriptions, generation fencing, journaled
completions, reset/close/shutdown) is connected to the Teaching IDE main
 process (five identifier-only channels + preload-local `onEvent`, sender
 validation, reviewed execution catalog); the passive UI is delivered in the
 IDE (P5.12: `src/model/terminal-runtime.ts` + `TerminalPane`/`App`/CSS/tests,
 real output with navigation inert) and wait scheduling stays P8.

## Layout

| Path | Role |
|---|---|
| `src/protocol.ts` | Runtime protocol (`runtime_event_version = 1`): identity, states, events, error model, renderer request contracts. Zod-validated, pure. |
| `src/admission.ts` | Trusted admission: immutable lesson catalog (cross-checked, frozen IR indexes — P5.10 adds process_output wait reference + inventory agreement), session/generation lifecycle, `ExecutionGrant` / stop / cancel / **wait** admissions. The renderer never supplies the command — or the readiness literal. |
| `src/policy.ts` | Design policy constants (timeout default/max, background cap, command/IR size limits, journal bounds, P5.7 foreground startup-ack/drain timing, P5.8 session ceiling, P5.10 wait literal/deadline bounds). |
| `src/workspace.ts` | P5.3 trusted workspace resolution: configured root admission, exclusive fresh session leaves, authored-cwd confinement, the single-mount plan and the frozen `ResolvedExecutionContext`. |
| `src/environment.ts` | P5.3 deterministic environment policy: fixed base + 3-name explicit host allowlist, secret-shaped requests rejected, redacted descriptions. |
| `src/runtime-config.ts` | P5.3 machine-local config: git-ignored `config/paths.json` workspace root + the pinned image identity from the committed base lock. |
| `src/providers/execution-provider.ts` | The abstract `ExecutionProvider` contract, types only. No implementation in this module. |
| `src/providers/docker.ts` | P5.4/P5.5/P5.7 `DockerSandboxProvider`: trusted-context validation → create → inspect-verify (fail-closed) → attach + supervisor handshake → supervisor-owned FOREGROUND execution through the pure foreground state machine (P5.7) + supervisor-owned background execution (process groups, ack-gated STARTED/RUNNING, lease renewal, group stops) → confirmed cleanup. |
| `src/registry.ts` | P5.5 trusted runtime process registry: atomic reservations (including hidden runtime-internal foreground keys), tombstones, canonical lifecycle transitions, duplicate-start prevention, cleanup targeting. Snapshot shapes never expose PID/PGID or hidden reservations. |
| `src/foreground.ts` | P5.7 pure foreground completion state machine (injected clock/timers, no I/O): actual/expected exit matrix, host-owned deadline state machine (exit-before-deadline wins; late exit cannot undo a latched timeout), bounded drain window before the terminal event + one immutable final result, descendant/output-limit/cancel/spawn-failure classifications, teardown requests. |
| `src/background.ts` | P5.8 pure background lifetime state machine (no I/O, no timers): the immutable STARTED fact latched at the authoritative ack (lifetime events never rewrite the start outcome), confirmed-stop finalization (authored stop PASS with the true forced flag; operator stop SKIPPED/CANCELLED), early-exit FAIL/BACKGROUND_EXITED_EARLY with the true code + session fail/close, guest failure classifications, exactly-one `operation.completed` per lifetime, session-closing/ceiling abort. |
| `src/output-wait.ts` | P5.10 pure process-output wait primitive (no I/O, injected timers/subscriptions): observes one background process's journaled text for the trusted `WaitAdmission` literal — pre-indexed case-sensitive match (4096-char bound), per-stream independent buffers (never cross-concatenated), either stream satisfies, incremental ANSI/OSC stripping + CRLF normalization, chunk-spanning tails carried across the history/live boundary, subscribe-before-history registration (early markers never lost), immediate match on live history / immediate `PROCESS_EXITED` when already dead, trusted-deadline `TIMEOUT`, abort `CANCELLED`, exactly-once settlement with listener removal. No TCP workflow exists. |
| `src/journal.ts` | P5.6 trusted main-owned `SessionJournal` (one per session+generation): validates provider events, assigns the strictly increasing journal `seq` + host `monotonic_ms`, applies chunk-spanning redaction BEFORE storage, enforces the trace-coherence invariants and the journal bounds (1 MiB/process output, 16 MiB/session with a protected lifecycle/error reserve, sealing), keeps per-process per-stream transcripts and serves bounded replay pages (256 events / 256 KiB, explicit snapshot-reset). Pure state; injected clock. |
| `src/events.ts` | P5.6 replay synchronization feed: subscribe BEFORE snapshot, buffer (bounded) arrivals during page fetches, apply pages at the snapshot cursor, then newer events; duplicates ignored, replay gaps reported (never silently healed), explicit snapshot-reset for cursors outside retained history. |
| `src/providers/docker-cli.ts` | P5.4 Docker CLI transport: the ONLY HOST module importing `node:child_process`. Direct `spawn(dockerExe, argv, {shell:false, windowsHide:true})` with the `--config <privateDir> --context desktop-linux` prefix; bounded capture/timeout/abort. |
| `src/providers/docker-policy.ts` | P5.4 sandbox policy (single module of truth): container security options, runtime-only labels/names, digest-pinned reference rules. |
| `src/providers/docker-inspect.ts` | P5.4 effective-config verifier: turns a real `docker inspect` document into concrete policy violations (fail-closed BEFORE start). |
| `src/providers/docker-ledger.ts` | P5.4 container ownership ledger: intent + reconcile only the provider's own containers (no global prune). |
| `src/providers/terminal-host.ts` | P5.11 trusted main-side Safe IPC orchestrator (no execution/network/Electron machinery): session lifecycle (admission + leaf + journal + lazy prepare), request-id idempotency, 10/sec rate limiting with cancel/snapshot bypass, bounded receipts/subscriptions, generation fencing, journaled completion bookkeeping, reset/close/shutdown barrier. |
| `tests/terminal-host.test.ts` | P5.11 deterministic units (20 tests, fake provider/clock, no Docker). |
| `tests/p511-docker.test.ts` | P5.11 REAL Docker safe-IPC integration (canonical compile → host → provider → guest → journal, `cf-p511-` resources). |
| `src/index.ts` | Public surface (protocol + admission + workspace/environment + journal/feed + provider CONTRACT types; the concrete Docker provider and guest code deliberately not exported). |
| `container/protocol.ts` | Guest supervisor frame DTOs (`supervisor_protocol_version = 1`), frame/size limits, timing constants. Pure, shared. |
| `container/supervisor-core.ts` | Pure supervisor state machine: hello/init/lease + P5.5 control dispatch (start/stop/heartbeat/shutdown). Testable without any I/O. |
| `container/process-groups.ts` | P5.5/P5.7 guest process table: one controlled POSIX process group per logical process; graceful stop (SIGINT → 2 s grace → SIGKILL → 3 s death/drain verification with residual-group cleanup); P5.7 foreground completion policy (direct-exit fact + whole-group verification before any report; residual owned descendants → force-kill → verified → `process_exit` + `process_failed UNEXPECTED_DESCENDANTS`); 1 MiB per-process output bound; UTF-8 chunk-spanning decode. The spawn seam is injected (pure). |
| `container/supervisor.ts` | Guest-only build entry: wires the core + process table to stdin/stdout JSONL frames; the ONE guest process-creation site (`/bin/sh -c`, detached, group leader). Never imported by Windows host code. |
| `image/Dockerfile` | Supervisor runtime image recipe. `FROM` is digest-pinned to `image/base-image.lock.json`; zero RUN steps; `USER 1000:1000`; JSON entrypoint. |
| `image/base-image.lock.json` | Canonical immutable base-image identity (`node:24-bookworm-slim@sha256:…`, linux/amd64). Single source of truth; the built runtime image's content address is recorded in phase evidence, never here. |
| `scripts/build-guest.mjs` | esbuild bundle of the guest supervisor to plain JS for Node 24 (`container/dist/supervisor.mjs`, git-ignored). |
| `scripts/check-admission.mjs` | P5.2 gate helper: exercises admission end-to-end through the canonical compile pipeline; performs no execution. |
| `scripts/check-workspace.mjs` | P5.3 gate helper: exercises workspace/environment/image/context resolution from a canonical grant; performs no execution. |
| `tests/foreground.test.ts` | P5.7 deterministic units (24 tests, fake clock/timers, no Docker): expected/actual matrix, deadline state machine, result exactly once, drain ordering, no output after the final result, descendant/output-limit/cancel/spawn-failure classifications, stale/duplicate terminal reports, cancel-vs-exit race, close abort, unconfirmed stop cleanup. |
| `tests/foreground-guest.test.ts` | P5.7 deterministic guest units (7 tests, fake spawn/clock): clean foreground exit reported only after whole-group death + pipe drain; residual descendants force-killed and verified before the `UNEXPECTED_DESCENDANTS` report; uncertain group fails the session; racing stop never double-signals; output bound on foreground groups. |
| `tests/p57-docker.test.ts` | P5.7 REAL Docker foreground integration (canonical admission → live session container → guest supervisor group → journal): actual/expected exit matrix with true values in the final result AND the journal, true deadline timeout with bounded group termination and no fake exit code, bounded output drain before the terminal event/result, descendant survival → `UNEXPECTED_DESCENDANTS` + full teardown, `OUTPUT_LIMIT`, cancellation, session-close race. |
| `tests/background.test.ts` | P5.8 deterministic units (18 tests, no Docker, no timers): start/lifetime distinction, authored-stop PASS/forced matrix, operator stop SKIPPED/CANCELLED, early-exit true codes, guest failure classifications, one immutable result under duplicate/late frames, session-closing/ceiling aborts, outcome mapping, journal-shape parity. |
| `tests/p58-docker.test.ts` | P5.8 REAL Docker background integration (canonical admission → live session container → guest supervisor groups → background lifetime machines): four concurrent lifetimes with exclusive per-ID streams and prompt result-free receipts, authored stop PASS (graceful + forced), operator stop SKIPPED/CANCELLED, early exit → FAIL/BACKGROUND_EXITED_EARLY + session fail/close with STARTED facts retained, real session ceiling (`session_expiry`, no per-operation result), idempotent close. |
| `tests/output-wait.test.ts` | P5.10 deterministic units (35 tests, no Docker): trusted wait admission (exact literal/timeout/target, early registration while defined-but-unstarted, duration/port `UNSUPPORTED_PHASE`, oversized/NUL/over-ceiling rejections, forged-reference/inventory `IR_RUNTIME_INCONSISTENT`, duplicate/stale/inspection-only/reset/slotless semantics, schema shape) + waiter early/spanning per-stream/ANSI/OSC/CRLF/case/deadline/abort/exit/settle-once/subscribe-before-history + waiter source safety. |
| `tests/p510-docker.test.ts` | P5.10 REAL Docker output-wait integration (canonical admission → live session container → guest supervisor groups → `SessionJournal` → `waitForProcessOutput`): early READY at spawn, chunk-spanning, stderr stream, ANSI, CRLF, deadline `TIMEOUT` (session alive), exit `PROCESS_EXITED` (session fail/close), already-dead immediacy, abort `CANCELLED` (session alive). |
| `tests/p54-docker.test.ts` | P5.4 tests: 13 REAL Docker integration tests (skipped, never silent, when the daemon/runtime image is unavailable) + 4 daemon-free provider-policy tests. |
| `tests/p55-docker.test.ts` | P5.5 tests: 14 REAL Docker background-ownership integration tests (background output/registry/group probes, graceful + forced group stops, process-tree cleanup, natural exit, duplicate start, session close, lease health + lease loss, stale generation, authored stop) + 2 daemon-free guarantees. |
| `tests/p56-docker.test.ts` | P5.6 tests: REAL Docker journal integration (bounded coherent trace + chunk-spanning redaction before storage over real guest pipes, replay feed exactly-once over a live session with real reset pages, close/no-late-output/confirmed cleanup) + a daemon-free journal/feed source-safety check. |
| `tests/journal.test.ts`, `tests/events.test.ts` | P5.6 deterministic units (26 tests, injected clock): seq/monotonic stamping, identity fencing, trace coherence, chunk-spanning redaction (no raw duplicate anywhere), per-stream transcripts/offsets, bounds/sealing, snapshot-page caps, subscribe-before-snapshot buffering, gap/reset handling. |
| `tests/registry.test.ts`, `tests/supervisor-processes.test.ts` | P5.5 deterministic race units (29 tests): concurrent starts, stop during STARTING, exit during STOPPING, duplicate exit frames, late output, dispose, guest group semantics — fake spawn/clock, no Docker. |
| `tests/` | Protocol, lock, request-shape, error-model, provider-contract, supervisor, source-safety, admission/admission-security, workspace, environment-policy, context-resolution suites (node:test, offline, deterministic). |

## Ownership boundaries (design-mandated)

- The renderer is passive: requests carry **identifiers only** (`session_id`,
  `operation_id`, `process_id`, `request_id`). No command string, cwd, env,
  image, mount, stdin or resize field exists anywhere in this protocol.
- Authored commands live in validated compiled IR owned by trusted runtime
  state (Electron main). They never cross the renderer protocol.
- Runtime session identity (`session_id` + `generation`) is generated by the
  engine at runtime, is separate from canonical course/lesson/scene/beat
  identity, and is never written into compiled IR.
- `container/*` is guest-only. `src/*` is host-side and Electron-free; the
  engine has no Electron/xterm/native dependency.
- The Docker executable, fixed context, private config dir and the
  content-addressed runtime image reference are TRUSTED MACHINE CONFIGURATION
  (`DockerProviderConfig`); renderer/lesson/IR/grant input can never select
  them. Every image reference must be digest-pinned (moving tags rejected).

## Execution boundary (P5.4 + P5.5)

`node:child_process` is imported by exactly TWO product modules with disjoint
responsibilities: `src/providers/docker-cli.ts` (the HOST Docker argv
transport) and `container/supervisor.ts` (the GUEST supervisor, which is the
one sanctioned guest process-creation site inside the container). Both spawn
directly with argv arrays (`shell:false`, no host shell, no `exec()`
strings). The authored command travels as ONE argv element to `/bin/sh -c`
INSIDE the container; guest interpretation only. The sandbox policy (user
1000:1000, network none, cap-drop ALL, no-new-privileges, read-only rootfs,
resource limits, single writable `/workspace` bind, no docker socket) is
provider-owned, verified against a real `docker inspect` BEFORE the container
starts (fail-closed), and re-verified live by the integration suite. The
provider cleans up only its own containers (ledger + labels; no prune).

P5.4's docker-exec argv probe was superseded in P5.7: foreground execution is
supervisor-owned (one controlled guest process group), and the P5.4
foreground integration tests prove the same canonical outcomes through the
P5.7 path.

## P5.7 foreground completion model

- **Supervisor-owned foreground.** A foreground grant runs in its own
  controlled guest process group (the same mechanism as background, keyed by
  a runtime-internal hidden registry key; the canonical event identity stays
  `process_id: null`). The docker-exec probe of P5.4 is gone.
- **Actual vs expected exit.** The ACTUAL exit code is the guest's true
  `process_exit` code, preserved as-is; the EXPECTED exit code comes only
  from the trusted `ExecutionGrant`. PASS is exactly
  `actual === expected` — actual 7 / expected 7 PASSes, actual 7 /
  expected 0 FAILs with the TRUE code (`EXIT_CODE_MISMATCH`). No exit code is
  ever invented for signal/deadline terminations (`exit_code: null`; the real
  kill signal is preserved separately).
- **Host-owned deadline.** The deadline is armed only after the authoritative
  guest start acknowledgment (startup bounded: max 10 s, bounded by the
  deadline). "Exit observed before deadline wins; at/after TIMEOUT" — a late
  matching exit can never undo a latched timeout. Canonical trace:
  accepted → started → output* → timeout → stopping → final output →
  stopped → completed (`FAIL/TIMEOUT`, null exit code, teardown).
- **Bounded drain.** After the guest's terminal frame the run waits the
  canonical bounded drain window (`FOREGROUND_POLICY.drain_window_ms`),
  letting in-flight output land BEFORE the terminal event and the final
  result. Order: process output → drain complete → terminal event → final
  result — never a normal output event after the final result. The journal
  flushes the foreground redaction hold at the terminal event (P5.7 fix).
- **Descendants.** A foreground operation completes only when the WHOLE
  guest group is gone. The direct command's OS exit is recorded separately
  from the pipe drain (descendants may inherit the stdio pipes); if owned
  descendants survive the direct exit, the guest force-kills the group,
  verifies its death, and reports `process_exit` (the true code) followed by
  `process_failed UNEXPECTED_DESCENDANTS` → host: FAIL/UNEXPECTED_DESCENDANTS
  + full teardown. An operation never PASSes while owned descendants remain.
  A group that resists past the verification bound fails the session
  (`STOP_VERIFY_FAILED`); container teardown is the authority.
- **One immutable final result.** Every terminal path finalizes exactly once
  (guarded state machine); duplicate/late terminal frames cannot produce a
  second `operation.completed`. The result carries the design's Foreground
  DTO (actual/expected exit, reason, guest-monotonic duration labels with
  the process start as the label origin, timeout, forced, cleanup status,
  opaque output refs, output bytes, truncated flag) and is delivered on the
  foreground receipt.
- **Failure distinctions.** Lesson exit mismatch (`EXIT_CODE_MISMATCH`) is
  distinct from transport failure (`TRANSPORT_FAILED`), supervisor/protocol
  failure, deadline expiry (`TIMEOUT`), sandbox teardown and
  `UNEXPECTED_DESCENDANTS`/`OUTPUT_LIMIT` — never flattened to "command
  failed". Spawn failure (`SPAWN_FAILED`) produces accepted → failed →
  completed with no invented start/exit.
- **Cancellation.** Targets the trusted operation identity only (no
  arbitrary PID, no renderer signal selection); the guest group is stopped
  through the canonical bounded path and the run finalizes
  SKIPPED/CANCELLED with a null exit code. A cancel racing the start
  dispatches at the authoritative ack; a late exit cannot undo a latched
  cancel.
- **Session close/reset race.** A foreground run interrupted by session
  close/failure never publishes a final result (the awaiting start rejects;
  no event may follow `runtime.closed`), and `close()` barriers on any
  in-flight teardown (idempotent close).

## P5.5 process ownership model

- **Logical identity only.** The authored logical `process_id` is the sole
  lesson/renderer-visible identity. OS PID/PGID exist only inside the guest
  supervisor frames and the trusted registry; no event, result, snapshot or
  DTO carries them.
- **STARTED vs RUNNING.** A background start returns a receipt only after the
  authoritative guest `process_started` acknowledgment; the registry claims
  RUNNING at that same acknowledgment and never earlier. A Docker/supervisor
  frame being sent is never success.
- **Duplicate prevention.** The admitted grant map (admission reservation)
  plus the atomic registry reserve ("reserve before awaits") make a duplicate
  `process_id` race impossible: the second start rejects `DUPLICATE_START`
  with zero spawn, no second registry entry, no second guest process.
- **Process groups.** Every managed background command is spawned detached
  inside the container, making it a POSIX process-group leader; descendants
  (npm → node → workers) inherit the group. Stops signal the whole group.
- **Stop semantics (design "Stop / Cleanup").** SIGINT to the guest group;
  2000 ms grace; SIGKILL fallback; 3000 ms death/drain verification —
  applied by the guest supervisor, which confirms a stop only when the WHOLE
  group is dead (a shell wrapper dying on the graceful signal never orphans
  descendants). The host awaits a bounded confirmation; an unconfirmable
  group fails the session and container teardown is the authority.
- **Lease/heartbeat.** The host renews the guest 15 s lease (from
  `SUPERVISOR_TIMING`, no duplicated literals) with 2 s heartbeat frames; an
  independent watchdog fails the session after 15 s of guest silence. Loss
  of the control channel (EOF) or lease expiry makes the supervisor
  SIGKILL its groups and exit within the 5 s deadline; container teardown
  remains the final cleanup authority.
- **Natural exit.** An unstopped background exit (including 0) is canonical
  `BACKGROUND_EXITED_EARLY`: the true code is captured on `process.exited`,
  the session fails and closes, the STARTED fact stays in the registry
  tombstone, and the definition can only run again in a new generation.
  There is no restart policy in P5.
- **Output.** `process_output` frames carry per-stream byte offsets; stdout
  and stderr order is preserved independently (no global-order claim).
  Output is bounded: 16 KiB per frame, 1 MiB decoded per process
  (OUTPUT_LIMIT → kill + session failure), 64 KiB per control frame, and a
  bounded guest writer queue (sustained > 2 s blockage initiates cleanup).

## P5.6 output journal model

- **Main owns the journal.** Providers emit translated events WITHOUT `seq`
  or `monotonic_ms`; the per-session `SessionJournal` is the only component
  that assigns the strictly increasing journal `seq` and the host receipt
  `monotonic_ms` (never compared against guest monotonic durations), then
  stores immutable (deep-frozen) events and re-emits them to subscribers.
- **Redaction before disk/IPC.** Registered secret literals (trusted machine
  configuration or synthetic test secrets — no renderer/lesson/IR/grant path
  can ever register one) are removed from `process.output` text BEFORE the
  event is stored, snapshotted or re-emitted; a raw duplicate is never written
  anywhere. Chunk-spanning secrets are safe: the holdback retains exactly the
  longest suffix that is a proper prefix of a secret (streaming-match rule),
  so a secret split across consecutive output frames can never leak its raw
  bytes through an earlier chunk, while ordinary output is never delayed. The
  held tail is flushed (redacted) before the process's terminal event.
  `stream_offset` values stay raw-stream byte offsets (monotonic per stream).
- **Coherent trace invariants.** "Started precedes buffered output" (output
  for a never-started process is rejected); one immutable final result per
  operation/attempt; `runtime.*` session events carry null operation
  provenance and can never become lesson output (diagnostic separation);
  cross-session/generation events reject `STALE_SESSION`.
- **Bounds, no silent drops.** 1 MiB decoded output per process (belt-and-
  braces mirror of the guest bound, `OUTPUT_LIMIT`); 16 MiB journal per
  session with a protected 64 KiB lifecycle/error reserve: output is refused
  (`LOG_BACKPRESSURE`) before the reserve is touched, and if even the reserve
  cannot fit an event the journal seals itself and every later ingest is
  loudly rejected.
- **Bounded replay.** `snapshot(after_seq)` returns at most 256 events /
  256 KiB; a cursor beyond the high-water mark is an explicit `reset` page
  (never served from a gap). The replay feed subscribes before the snapshot,
  buffers (bounded) arrivals during page fetches, applies pages at the
  snapshot cursor, ignores duplicates, reports replay gaps (never silently
  healed) and honors the reset re-anchor.
- **Per-process transcripts** are derived from the stored journal per stream —
  stdout and stderr are never blended, and Docker/provider diagnostics (their
  own `runtime.*` event types) can never enter a process transcript.

## P5.8 background lifetime model

- **Start/lifetime distinction.** A background start completes early at the
  authoritative guest `process_started` acknowledgment: the receipt is the
  immutable STARTED fact (result-free; "background receipts unchanged") and
  a lifetime state machine (`src/background.ts`) is registered for the
  logical process id. Lifetime terminal events arrive later and can NEVER
  rewrite the start outcome; nothing finalizes before the STARTED fact.
- **Confirmed stop finalization.** When the guest confirms the WHOLE group's
  death (P5.5 policy: SIGINT → 2 s grace → SIGKILL → 3 s death/drain
  verification), the lifetime emits `process.stopped` and the one immutable
  `operation.completed`: an authored stop PASSes with `forced` reporting
  whether the SIGKILL fallback was required ("Authored stop can PASS
  forced=true after confirmed death"); an operator stop / cancellation ends
  SKIPPED/CANCELLED. A confirmed stop leaves the session and its container
  alive for further operations.
- **Early exit.** An unstopped background exit — including exit 0 — is
  canonical FAIL/BACKGROUND_EXITED_EARLY with the TRUE exit code
  (`process.exited` true death fact from the provider, then
  `process.failed` → `operation.completed`), and the session fails and
  closes. The historical STARTED fact stays in the registry tombstone; a
  same-generation restart rejects DUPLICATE_START (only reset reuses a
  definition). A late exit can never rewrite a latched stop outcome.
- **Guest failure classifications.** `process_failed` frames for a
  background id (OUTPUT_LIMIT / UNEXPECTED_DESCENDANTS) and the host-side
  output bound finalize FAIL/<code> + teardown through the same
  exactly-once path.
- **One immutable final result.** Every terminal path finalizes exactly
  once (guarded state machine); duplicate/late terminal frames cannot emit
  a second `operation.completed`. Results are EVENT-DRIVEN for background
  operations; the protocol needed no changes.
- **Session ceiling.** The 30-minute session ceiling
  (`EXECUTION_POLICY.session_ceiling_ms`, host/runtime-owned) closes the
  session with cause `session_expiry` (runtime.closing → bounded guest
  shutdown → container removal → runtime.closed); active lifetimes publish
  no final result. A diagnostics-only config override (trusted machine
  configuration, never renderer-facing) exists solely for the real
  integration suite. Close is idempotent after the session's own close
  (the real cleanup status is returned, nothing further is emitted).
- **Independent stable mappings/streams.** Up to four concurrent
  background lifetimes share ONE session container with exclusive stable
  per-ID mappings (registry + lifetime machines) and independent per-stream
  output ordering — proven by real Docker integration with zero
  cross-contamination.

## P5.10 process-output wait model

- **Admitted waits only.** A `wait until=process_output` operation admits to
  a trusted `WaitAdmission` (literal + target + deadline from validated IR,
  nothing renderer-supplied); duration/port waits stay `UNSUPPORTED_PHASE`
  (no TCP probe exists). Admission checks definition (not started-ness), so
  waits register at background spawn with no lost early markers.
- **Per-stream observation.** The waiter keeps independent stdout/stderr
  matchers over journaled output (incremental ANSI/OSC stripping, CRLF
  normalization, chunk-spanning tails); either stream can satisfy, and the
  match retains its journal `seq` + `stream`. History is checked after
  subscribing (subscribe-before-history), so spawn-to-waiter gaps lose
  nothing.
- **Settle once.** Live match, trusted-deadline `TIMEOUT`, abort
  `CANCELLED`, or target death `PROCESS_EXITED` (already-dead targets reject
  immediately) settle exactly once with full listener removal. A later
  lifetime death after a match is the session's separate failure, and
  deadline/abort never tear the session down.

## Stop / crash / teardown (P5.9)

- **Group-escape gate.** Every confirmed stop passes a guest-side
  inventory (`ProcessTableDeps.inventoryGroups`, one bounded `/proc`
  probe): a setsid/daemonized descendant surviving outside the managed
  groups is never accepted as a clean stop — the classification is
  `process_failed UNEXPECTED_DESCENDANTS` (host:
  FAIL/UNEXPECTED_DESCENDANTS + full container teardown, the final
  authority over any escapee, plus explicit peer cancellation). A failed
  inventory is ambiguity and fails closed the same way; a clean inventory
  keeps the canonical `process_stopped` trace.
- **Reconciliation.** `removeContainer` is authoritative in the design's
  exact sense: stop → `rm --force` → on any non-clean answer the daemon's
  listing (`docker inspect` → exact not-found, polled with a bound) is
  the removal proof; only a real transport failure leaves cleanup
  unconfirmed (ledger entry KEPT as `HOLD_CLEANUP`,
  `CLEANUP_UNCONFIRMED` blocks new sessions). `prepare` runs the launch
  reconciliation and `reconcileRecordedSessions()` removes ONLY
  containers carrying the exact owner/phase/installation label triple
  (no global prune); a daemon outage reports "unavailable" (ledger
  preserved, no false block).
- **Main/helper loss.** The attached CLI dying (helper loss) is
  TRANSPORT_FAILED with bounded removal; the host→guest pipe closing
  with renewal suspended (dead main, surviving helper) is covered by the
  guest EOF/lease fail-safe (groups stopped, supervisor out within the
  5 s deadline). The attach control streams never crash the host (no-op
  error listeners; the CLI exit promise is the death detector).
- **Tests.** 14 deterministic units (`tests/teardown.test.ts`) + 5 REAL
  Docker integration tests (`tests/p59-docker.test.ts`) through the
  canonical admission pipeline. Suite total: 320 tests, 0 failing.

## Commands

```sh
npm test --workspace @course-factory/terminal-engine   # unit + real Docker integration suites
npm run typecheck --workspace @course-factory/terminal-engine
npm run build:guest --workspace @course-factory/terminal-engine
node scripts/validate-p5.mjs                           # authoritative P5 final gate (repository root; real Docker + real Electron required)
```
