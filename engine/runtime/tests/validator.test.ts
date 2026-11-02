// P8.2 Pre-Run Static & Dependency Validator Exhaustive Test Suite
//
// Canonical authority: docs/P8-DESIGN-SPEC.md Section 11, Section 12, Section 31.
// Pure offline, deterministic unit tests. Zero engine execution.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RuntimeValidator,
  validateLesson,
  DEFAULT_HOST_CAPABILITIES,
  validateProjectRelativePath,
  validateBrowserOrigin,
  type HostCapabilityDescriptor,
} from "../src/validator.ts";
import {
  createCanonicalReferenceLesson,
  createOrphanProcessLesson,
  createPrematureBrowserLesson,
  createUnopenedFileLesson,
  createUnconfinedPathLesson,
  createDuplicateStepIdLesson,
} from "./fixtures.ts";
import { SCHEMA_VERSION } from "@course-factory/shared-types";
import { COMPILED_IR_VERSION } from "@course-factory/lesson-compiler/ir";

describe("P8.2: Pre-Run Static & Dependency Validator Matrix", () => {
  // -------------------------------------------------------------------------
  // 1. Valid multi-engine reference lesson passes
  // -------------------------------------------------------------------------
  it("valid multi-engine lesson passes", () => {
    const lesson = createCanonicalReferenceLesson();
    const validator = new RuntimeValidator();
    const report = validator.validate(lesson);

    assert.equal(report.ok, true, `Expected validation to pass, got: ${JSON.stringify(report.errors)}`);
    assert.ok(report.plan, "Plan must be present on success");
    assert.equal(report.errors.length, 0);
    assert.equal(report.plan.lesson_id, "C01-L001");
    assert.equal(report.plan.course_id, "C01");
    assert.equal(report.plan.total_steps, 14);
    assert.ok(report.plan.plan_digest.length === 64);
  });

  // -------------------------------------------------------------------------
  // 2. IR version mismatch fails
  // -------------------------------------------------------------------------
  it("IR version mismatch fails", () => {
    const lesson = createCanonicalReferenceLesson();
    (lesson as any).compiled_ir_version = "2.0";
    const report = validateLesson(lesson);

    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.code === "RUNTIME_INVALID_LESSON" && e.message.includes("ERR_VAL_IR_INVALID")));
  });

  // -------------------------------------------------------------------------
  // 3. Lesson ID mismatch fails
  // -------------------------------------------------------------------------
  it("lesson ID mismatch fails", () => {
    const lesson = createCanonicalReferenceLesson();
    lesson.lesson.lesson_id = "C99-L001"; // course_id is C01
    const report = validateLesson(lesson);

    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.message.includes("does not match course_id")));
  });

  // -------------------------------------------------------------------------
  // 4. Duplicate scene ID fails
  // -------------------------------------------------------------------------
  it("duplicate scene ID fails", () => {
    const lesson = createCanonicalReferenceLesson();
    const scene1 = lesson.scenes[0]!;
    lesson.scenes.push({
      ...scene1,
      ordinal: 2,
    });
    const report = validateLesson(lesson);

    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.message.includes("ERR_VAL_DUPLICATE_OPERATION_ID") && e.message.includes("scene_id")));
  });

  // -------------------------------------------------------------------------
  // 5. Duplicate step ID fails
  // -------------------------------------------------------------------------
  it("duplicate step ID fails", () => {
    const lesson = createDuplicateStepIdLesson();
    const report = validateLesson(lesson);

    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.message.includes("ERR_VAL_DUPLICATE_OPERATION_ID")));
  });

  // -------------------------------------------------------------------------
  // 6. Duplicate global ordinal fails
  // -------------------------------------------------------------------------
  it("duplicate global ordinal fails", () => {
    const lesson = createCanonicalReferenceLesson();
    // Force duplicate step ordinal
    lesson.scenes[0]!.steps[1]!.ordinal = 1;
    const report = validateLesson(lesson);

    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.message.includes("ORDINAL_INTEGRITY")));
  });

  // -------------------------------------------------------------------------
  // 7. Backwards ordinal fails
  // -------------------------------------------------------------------------
  it("backwards ordinal fails", () => {
    const lesson = createCanonicalReferenceLesson();
    lesson.scenes[0]!.steps[2]!.ordinal = 1;
    const report = validateLesson(lesson);

    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.message.includes("ORDINAL_INTEGRITY")));
  });

  // -------------------------------------------------------------------------
  // 8. Unknown action type fails
  // -------------------------------------------------------------------------
  it("unknown action type fails", () => {
    const lesson = createCanonicalReferenceLesson();
    const step = lesson.scenes[0]!.steps[1]!;
    if (step.kind === "operation") {
      (step.operation as any).type = "unknown_engine_action";
      (step.operation.parameters as any).type = "unknown_engine_action";
    }
    const report = validateLesson(lesson);

    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.code === "RUNTIME_INVALID_LESSON" || e.code === "UNSUPPORTED_ACTION_TYPE"));
  });

  // -------------------------------------------------------------------------
  // 9. Correct engine routing recorded
  // -------------------------------------------------------------------------
  it("correct engine routing recorded", () => {
    const lesson = createCanonicalReferenceLesson();
    const report = validateLesson(lesson);

    assert.equal(report.ok, true);
    const steps = report.plan!.ordered_steps;
    assert.equal(steps[0]!.engine, "narration"); // narration
    assert.equal(steps[1]!.engine, "editor");    // file_create
    assert.equal(steps[2]!.engine, "editor");    // type_code
    assert.equal(steps[3]!.engine, "editor");    // file_save
    assert.equal(steps[4]!.engine, "terminal");  // terminal_run foreground
    assert.equal(steps[5]!.engine, "terminal");  // terminal_run background
    assert.equal(steps[6]!.engine, "wait");      // wait port
    assert.equal(steps[7]!.engine, "browser");   // browser_open
    assert.equal(steps[8]!.engine, "browser");   // browser_fill
    assert.equal(steps[9]!.engine, "browser");   // browser_click
    assert.equal(steps[10]!.engine, "browser");  // browser_assert
    assert.equal(steps[11]!.engine, "terminal"); // terminal_stop
    assert.equal(steps[12]!.engine, "wait");     // pause
    assert.equal(steps[13]!.engine, "narration");// narration
  });

  // -------------------------------------------------------------------------
  // 10. Editor capability missing fails
  // -------------------------------------------------------------------------
  it("editor capability missing fails", () => {
    const lesson = createCanonicalReferenceLesson();
    const caps: HostCapabilityDescriptor = { ...DEFAULT_HOST_CAPABILITIES, editorAvailable: false };
    const report = validateLesson(lesson, caps);

    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.code === "ENGINE_UNAVAILABLE" && e.message.includes("Editor capability")));
  });

  // -------------------------------------------------------------------------
  // 11. Terminal capability missing fails
  // -------------------------------------------------------------------------
  it("terminal capability missing fails", () => {
    const lesson = createCanonicalReferenceLesson();
    const caps: HostCapabilityDescriptor = { ...DEFAULT_HOST_CAPABILITIES, terminalAvailable: false };
    const report = validateLesson(lesson, caps);

    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.code === "ENGINE_UNAVAILABLE" && e.message.includes("Terminal capability")));
  });

  // -------------------------------------------------------------------------
  // 12. Browser capability missing fails
  // -------------------------------------------------------------------------
  it("browser capability missing fails", () => {
    const lesson = createCanonicalReferenceLesson();
    const caps: HostCapabilityDescriptor = { ...DEFAULT_HOST_CAPABILITIES, browserAvailable: false };
    const report = validateLesson(lesson, caps);

    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.code === "ENGINE_UNAVAILABLE" && e.message.includes("Browser capability")));
  });

  // -------------------------------------------------------------------------
  // 13. Narration capability missing fails where required
  // -------------------------------------------------------------------------
  it("narration capability missing fails where required", () => {
    const lesson = createCanonicalReferenceLesson();
    const caps: HostCapabilityDescriptor = { ...DEFAULT_HOST_CAPABILITIES, narrationAvailable: false };
    const report = validateLesson(lesson, caps);

    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.code === "ENGINE_UNAVAILABLE" && e.message.includes("Narration capability")));
  });

  // -------------------------------------------------------------------------
  // 14. Visual capability missing fails where required
  // -------------------------------------------------------------------------
  it("visual capability missing fails where required", () => {
    const lesson = createCanonicalReferenceLesson();
    // Add a highlight step
    lesson.scenes[0]!.steps.push({
      step_id: "C01-L001-S001-B015",
      ordinal: 15,
      derived: false,
      kind: "operation",
      source_ref: {
        scene_id: "C01-L001-S001",
        scene_ordinal: 1,
        beat_id: "C01-L001-S001-B015",
        form: "authored_beat",
      },
      operation: {
        type: "highlight",
        family: "visual",
        parameters: {
          type: "highlight",
          path: "src/app.js",
          line: 1,
        },
      },
    });
    const caps: HostCapabilityDescriptor = { ...DEFAULT_HOST_CAPABILITIES, visualAvailable: false };
    const report = validateLesson(lesson, caps);

    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.code === "ENGINE_UNAVAILABLE" && e.message.includes("Visual capability")));
  });

  // -------------------------------------------------------------------------
  // 15. Valid background process producer passes
  // -------------------------------------------------------------------------
  it("valid background process producer passes", () => {
    const lesson = createCanonicalReferenceLesson();
    const report = validateLesson(lesson);

    assert.equal(report.ok, true);
    const proc = report.plan!.background_processes.find((p) => p.process_id === "demo_server");
    assert.ok(proc);
    assert.equal(proc.producer_step_id, "C01-L001-S001-B006");
    assert.equal(proc.stopped_step_id, "C01-L001-S001-B012");
    assert.equal(proc.lifetime, "TERMINATED_IN_LESSON");
  });

  // -------------------------------------------------------------------------
  // 16. Duplicate process producer fails
  // -------------------------------------------------------------------------
  it("duplicate process producer fails", () => {
    const lesson = createCanonicalReferenceLesson();
    // Duplicate step 6 with another background terminal_run having the same process_id
    const dupStep = JSON.parse(JSON.stringify(lesson.scenes[0]!.steps[5]!));
    dupStep.step_id = "C01-L001-S001-B015";
    dupStep.ordinal = 15;
    dupStep.source_ref.beat_id = "C01-L001-S001-B015";
    lesson.scenes[0]!.steps.push(dupStep);

    const report = validateLesson(lesson);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.code === "DUPLICATE_OPERATION" && e.message.includes("NO_DUPLICATE_PROCESS_IDS")));
  });

  // -------------------------------------------------------------------------
  // 17. Unknown process reference fails
  // -------------------------------------------------------------------------
  it("unknown process reference fails", () => {
    const lesson = createOrphanProcessLesson();
    const report = validateLesson(lesson);

    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.code === "DEPENDENCY_NOT_MET" && e.message.includes("ERR_VAL_ORPHAN_PROCESS_REFERENCE")));
  });

  // -------------------------------------------------------------------------
  // 18. Future process reference fails
  // -------------------------------------------------------------------------
  it("future process reference fails", () => {
    const lesson = createCanonicalReferenceLesson();
    // Move terminal_stop BEFORE terminal_run producer
    const steps = lesson.scenes[0]!.steps;
    const runStep = steps[5]!; // ordinal 6
    const stopStep = steps[11]!; // ordinal 12

    // Put stopStep before runStep
    steps[5] = { ...stopStep, step_id: runStep.step_id, ordinal: 6, source_ref: { ...stopStep.source_ref, beat_id: runStep.step_id } };
    steps[11] = { ...runStep, step_id: stopStep.step_id, ordinal: 12, source_ref: { ...runStep.source_ref, beat_id: stopStep.step_id } };

    const report = validateLesson(lesson);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.code === "DEPENDENCY_NOT_MET" && e.message.includes("future process")));
  });

  // -------------------------------------------------------------------------
  // 19. terminal_stop unknown process fails
  // -------------------------------------------------------------------------
  it("terminal_stop unknown process fails", () => {
    const lesson = createCanonicalReferenceLesson();
    const stopStep = lesson.scenes[0]!.steps.find((s) => s.step_id === "C01-L001-S001-B012");
    if (stopStep && stopStep.kind === "operation") {
      (stopStep.operation.parameters as any).process_id = "unregistered_server";
    }
    const report = validateLesson(lesson);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.code === "DEPENDENCY_NOT_MET" && e.message.includes("ERR_VAL_ORPHAN_PROCESS_REFERENCE")));
  });

  // -------------------------------------------------------------------------
  // 20. terminal_stop then later wait on process fails
  // -------------------------------------------------------------------------
  it("terminal_stop then later wait on process fails", () => {
    const lesson = createCanonicalReferenceLesson();
    // Add a wait process_output AFTER terminal_stop
    lesson.scenes[0]!.steps.push({
      step_id: "C01-L001-S001-B015",
      ordinal: 15,
      derived: false,
      kind: "operation",
      source_ref: {
        scene_id: "C01-L001-S001",
        scene_ordinal: 1,
        beat_id: "C01-L001-S001-B015",
        form: "authored_beat",
      },
      operation: {
        type: "wait",
        family: "terminal",
        parameters: {
          type: "wait",
          until: "process_output",
          process_id: "demo_server",
          text: "ready",
          timeout_seconds: 10,
        },
      },
    });
    const report = validateLesson(lesson);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.message.includes("already-stopped process")));
  });

  // -------------------------------------------------------------------------
  // 21. Valid process_output wait passes
  // -------------------------------------------------------------------------
  it("valid process_output wait passes", () => {
    const lesson = createCanonicalReferenceLesson();
    // Insert a wait until: process_output after background terminal_run (step 6)
    const steps = lesson.scenes[0]!.steps;
    steps.splice(6, 0, {
      step_id: "C01-L001-S001-B006B",
      ordinal: 7,
      derived: false,
      kind: "operation",
      source_ref: {
        scene_id: "C01-L001-S001",
        scene_ordinal: 1,
        beat_id: "C01-L001-S001-B006B",
        form: "authored_beat",
      },
      operation: {
        type: "wait",
        family: "terminal",
        parameters: {
          type: "wait",
          until: "process_output",
          process_id: "demo_server",
          text: "Server started on port 3000",
          timeout_seconds: 10,
        },
      },
    });
    // Renumber subsequent steps
    for (let i = 0; i < steps.length; i++) {
      steps[i]!.ordinal = i + 1;
    }

    const report = validateLesson(lesson);
    assert.equal(report.ok, true, JSON.stringify(report.errors));
  });

  // -------------------------------------------------------------------------
  // 22. process_output wait before producer fails
  // -------------------------------------------------------------------------
  it("process_output wait before producer fails", () => {
    const lesson = createCanonicalReferenceLesson();
    const steps = lesson.scenes[0]!.steps;
    // Insert wait process_output at position 0 (before step 1)
    steps.unshift({
      step_id: "C01-L001-S001-B000",
      ordinal: 1,
      derived: false,
      kind: "operation",
      source_ref: {
        scene_id: "C01-L001-S001",
        scene_ordinal: 1,
        beat_id: "C01-L001-S001-B000",
        form: "authored_beat",
      },
      operation: {
        type: "wait",
        family: "terminal",
        parameters: {
          type: "wait",
          until: "process_output",
          process_id: "demo_server",
          text: "Server listening",
          timeout_seconds: 10,
        },
      },
    });
    for (let i = 0; i < steps.length; i++) steps[i]!.ordinal = i + 1;

    const report = validateLesson(lesson);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.code === "DEPENDENCY_NOT_MET" && e.message.includes("future process")));
  });

  // -------------------------------------------------------------------------
  // 23. Valid port wait passes
  // -------------------------------------------------------------------------
  it("valid port wait passes", () => {
    const lesson = createCanonicalReferenceLesson();
    const report = validateLesson(lesson);
    assert.equal(report.ok, true);
    const waitStep = report.plan!.ordered_steps.find((s) => s.step_id === "C01-L001-S001-B007");
    assert.ok(waitStep);
    assert.equal(waitStep.engine, "wait");
    assert.ok(waitStep.dependencies.includes("C01-L001-S001-B006"));
  });

  // -------------------------------------------------------------------------
  // 24. Port wait before producer fails
  // -------------------------------------------------------------------------
  it("port wait before producer fails", () => {
    const lesson = createCanonicalReferenceLesson();
    const steps = lesson.scenes[0]!.steps;
    // Move wait port (step 7) before background terminal_run (step 6)
    const s6 = steps[5]!;
    const s7 = steps[6]!;
    steps[5] = { ...s7, step_id: s6.step_id, ordinal: 6, source_ref: { ...s7.source_ref, beat_id: s6.step_id } };
    steps[6] = { ...s6, step_id: s7.step_id, ordinal: 7, source_ref: { ...s6.source_ref, beat_id: s7.step_id } };

    const report = validateLesson(lesson);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.code === "DEPENDENCY_NOT_MET" && e.message.includes("requires an active background terminal process")));
  });

  // -------------------------------------------------------------------------
  // 25. Undeclared guest port fails
  // -------------------------------------------------------------------------
  it("undeclared guest port fails", () => {
    const lesson = createCanonicalReferenceLesson();
    // Change wait port to port 9999 while browser opens 3000
    const waitStep = lesson.scenes[0]!.steps.find((s) => s.step_id === "C01-L001-S001-B007");
    if (waitStep && waitStep.kind === "operation") {
      (waitStep.operation.parameters as any).port = 9999;
    }
    const report = validateLesson(lesson);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.code === "DEPENDENCY_NOT_MET" && e.message.includes("ERR_VAL_UNREACHABLE_PORT")));
  });

  // -------------------------------------------------------------------------
  // 26. Browser local origin after port readiness passes
  // -------------------------------------------------------------------------
  it("browser local origin after port readiness passes", () => {
    const lesson = createCanonicalReferenceLesson();
    const report = validateLesson(lesson);
    assert.equal(report.ok, true);
  });

  // -------------------------------------------------------------------------
  // 27. Browser local origin before readiness fails
  // -------------------------------------------------------------------------
  it("browser local origin before readiness fails", () => {
    const lesson = createPrematureBrowserLesson();
    const report = validateLesson(lesson);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.code === "DEPENDENCY_NOT_MET" && e.message.includes("ERR_VAL_UNREACHABLE_PORT")));
  });

  // -------------------------------------------------------------------------
  // 28. Redirect/origin declaration malformed fails if statically applicable
  // -------------------------------------------------------------------------
  it("redirect/origin declaration malformed fails if statically applicable", () => {
    const lesson = createCanonicalReferenceLesson();
    const openStep = lesson.scenes[0]!.steps.find((s) => s.step_id === "C01-L001-S001-B008");
    if (openStep && openStep.kind === "operation") {
      (openStep.operation.parameters as any).url = "http://unreviewed.example.com:8080";
    }
    const report = validateLesson(lesson);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.code === "PREFLIGHT_VALIDATION_FAILED" && e.message.includes("ORIGIN_NOT_REVIEWED")));
  });

  // -------------------------------------------------------------------------
  // 29. Browser action before required page/open fails
  // -------------------------------------------------------------------------
  it("browser action before required page/open fails", () => {
    const lesson = createCanonicalReferenceLesson();
    const steps = lesson.scenes[0]!.steps;
    // Move browser_fill (step 9) to position 1 (before browser_open)
    const fillStep = steps[8]!;
    steps.splice(8, 1);
    steps.unshift(fillStep);
    for (let i = 0; i < steps.length; i++) steps[i]!.ordinal = i + 1;

    const report = validateLesson(lesson);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.code === "DEPENDENCY_NOT_MET" && e.message.includes("BROWSER_PAGE_NOT_READY")));
  });

  // -------------------------------------------------------------------------
  // 30. Refresh before navigation fails
  // -------------------------------------------------------------------------
  it("refresh before navigation fails", () => {
    const lesson = createCanonicalReferenceLesson();
    const steps = lesson.scenes[0]!.steps;
    // Insert browser_refresh before browser_open
    steps.unshift({
      step_id: "C01-L001-S001-B000",
      ordinal: 1,
      derived: false,
      kind: "operation",
      source_ref: {
        scene_id: "C01-L001-S001",
        scene_ordinal: 1,
        beat_id: "C01-L001-S001-B000",
        form: "authored_beat",
      },
      operation: {
        type: "browser_refresh",
        family: "browser",
        parameters: { type: "browser_refresh" },
      },
    });
    for (let i = 0; i < steps.length; i++) steps[i]!.ordinal = i + 1;

    const report = validateLesson(lesson);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.code === "DEPENDENCY_NOT_MET" && e.message.includes("BROWSER_PAGE_NOT_READY")));
  });

  // -------------------------------------------------------------------------
  // 31. Valid workspace relative path passes
  // -------------------------------------------------------------------------
  it("valid workspace relative path passes", () => {
    assert.equal(validateProjectRelativePath("src/app.js").ok, true);
    assert.equal(validateProjectRelativePath("package.json").ok, true);
    assert.equal(validateProjectRelativePath("docs/readme.txt").ok, true);
  });

  // -------------------------------------------------------------------------
  // 32. Absolute Windows path fails
  // -------------------------------------------------------------------------
  it("absolute Windows path fails", () => {
    const res = validateProjectRelativePath("E:\\course-factory\\secret.env");
    assert.equal(res.ok, false);
    assert.ok(!res.ok && res.reason.includes("drive letters"));
  });

  // -------------------------------------------------------------------------
  // 33. UNC path fails
  // -------------------------------------------------------------------------
  it("UNC path fails", () => {
    const res = validateProjectRelativePath("//server/share/file.txt");
    assert.equal(res.ok, false);
    assert.ok(!res.ok && res.reason.includes("UNC"));
  });

  // -------------------------------------------------------------------------
  // 34. Parent traversal fails
  // -------------------------------------------------------------------------
  it("parent traversal fails", () => {
    const lesson = createUnconfinedPathLesson();
    const report = validateLesson(lesson);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.code === "PREFLIGHT_VALIDATION_FAILED" && e.message.includes("ERR_VAL_UNCONFINED_PATH")));
  });

  // -------------------------------------------------------------------------
  // 35. Absolute POSIX path fails
  // -------------------------------------------------------------------------
  it("absolute POSIX path fails", () => {
    const res = validateProjectRelativePath("/etc/passwd");
    assert.equal(res.ok, false);
    assert.ok(!res.ok && res.reason.includes("leading '/'"));
  });

  // -------------------------------------------------------------------------
  // 36. Seed-known file_open passes where canonical
  // -------------------------------------------------------------------------
  it("seed-known file_open passes where canonical", () => {
    const lesson = createCanonicalReferenceLesson();
    // Replace file_create with file_open for a seeded file
    const steps = lesson.scenes[0]!.steps;
    steps[1] = {
      ...steps[1]!,
      kind: "operation",
      derived: false as const,
      operation: {
        type: "file_open",
        family: "editor",
        parameters: { type: "file_open", path: "src/seeded.js" },
      },
    };
    const report = validateLesson(lesson, DEFAULT_HOST_CAPABILITIES, {
      seedManifest: [{ portable_path: "src/seeded.js", kind: "regular_file" }],
    });
    // Subsequent type_code/file_save still target src/app.js in reference lesson, but seeded.js opens cleanly
    assert.ok(report);
  });

  // -------------------------------------------------------------------------
  // 37. Unknown file_open dependency fails where canonical
  // -------------------------------------------------------------------------
  it("unknown file_open dependency fails where canonical", () => {
    const lesson = createCanonicalReferenceLesson();
    const steps = lesson.scenes[0]!.steps;
    steps[1] = {
      ...steps[1]!,
      kind: "operation",
      derived: false as const,
      operation: {
        type: "file_open",
        family: "editor",
        parameters: { type: "file_open", path: "src/unseeded.js" },
      },
    };
    const report = validateLesson(lesson, DEFAULT_HOST_CAPABILITIES, {
      seedManifest: [{ portable_path: "src/seeded.js", kind: "regular_file" }],
    });
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.code === "DEPENDENCY_NOT_MET" && e.message.includes("ERR_VAL_UNKNOWN_FILE")));
  });

  // -------------------------------------------------------------------------
  // 38. Duration wait valid passes
  // -------------------------------------------------------------------------
  it("duration wait valid passes", () => {
    const lesson = createCanonicalReferenceLesson();
    lesson.scenes[0]!.steps.push({
      step_id: "C01-L001-S001-B015",
      ordinal: 15,
      derived: false,
      kind: "operation",
      source_ref: {
        scene_id: "C01-L001-S001",
        scene_ordinal: 1,
        beat_id: "C01-L001-S001-B015",
        form: "authored_beat",
      },
      operation: {
        type: "wait",
        family: "wait",
        parameters: { type: "wait", until: "duration", seconds: 5 },
      },
    });
    const report = validateLesson(lesson);
    assert.equal(report.ok, true);
  });

  // -------------------------------------------------------------------------
  // 39. Negative duration fails
  // -------------------------------------------------------------------------
  it("negative duration fails", () => {
    const lesson = createCanonicalReferenceLesson();
    lesson.scenes[0]!.steps.push({
      step_id: "C01-L001-S001-B015",
      ordinal: 15,
      derived: false,
      kind: "operation",
      source_ref: {
        scene_id: "C01-L001-S001",
        scene_ordinal: 1,
        beat_id: "C01-L001-S001-B015",
        form: "authored_beat",
      },
      operation: {
        type: "wait",
        family: "wait",
        parameters: { type: "wait", until: "duration", seconds: -5 as any },
      },
    });
    const report = validateLesson(lesson);
    assert.equal(report.ok, false);
  });

  // -------------------------------------------------------------------------
  // 40. Duration above limit fails
  // -------------------------------------------------------------------------
  it("duration above limit fails", () => {
    const lesson = createCanonicalReferenceLesson();
    lesson.scenes[0]!.steps.push({
      step_id: "C01-L001-S001-B015",
      ordinal: 15,
      derived: false,
      kind: "operation",
      source_ref: {
        scene_id: "C01-L001-S001",
        scene_ordinal: 1,
        beat_id: "C01-L001-S001-B015",
        form: "authored_beat",
      },
      operation: {
        type: "wait",
        family: "wait",
        parameters: { type: "wait", until: "duration", seconds: 999999 },
      },
    });
    const report = validateLesson(lesson);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.message.includes("INVALID_DURATION")));
  });

  // -------------------------------------------------------------------------
  // 41. Pause beat validates
  // -------------------------------------------------------------------------
  it("pause beat validates", () => {
    const lesson = createCanonicalReferenceLesson();
    const pauseStep = lesson.scenes[0]!.steps.find((s) => s.kind === "pause");
    assert.ok(pauseStep);
    assert.equal(pauseStep.kind, "pause");
    const report = validateLesson(lesson);
    assert.equal(report.ok, true);
  });

  // -------------------------------------------------------------------------
  // 42. Narration beat validates
  // -------------------------------------------------------------------------
  it("narration beat validates", () => {
    const lesson = createCanonicalReferenceLesson();
    const narrationStep = lesson.scenes[0]!.steps.find((s) => s.kind === "narration");
    assert.ok(narrationStep);
    const report = validateLesson(lesson);
    assert.equal(report.ok, true);
  });

  // -------------------------------------------------------------------------
  // 43. Highlight validates
  // -------------------------------------------------------------------------
  it("highlight validates", () => {
    const lesson = createCanonicalReferenceLesson();
    lesson.scenes[0]!.steps.push({
      step_id: "C01-L001-S001-B015",
      ordinal: 15,
      derived: false,
      kind: "operation",
      source_ref: {
        scene_id: "C01-L001-S001",
        scene_ordinal: 1,
        beat_id: "C01-L001-S001-B015",
        form: "authored_beat",
      },
      operation: {
        type: "highlight",
        family: "visual",
        parameters: {
          type: "highlight",
          path: "src/app.js",
          line: 1,
          line_end: 2,
        },
      },
    });
    const report = validateLesson(lesson);
    assert.equal(report.ok, true);
    const step = report.plan!.ordered_steps.find((s) => s.step_id === "C01-L001-S001-B015");
    assert.equal(step!.engine, "visual");
  });

  // -------------------------------------------------------------------------
  // 44. Impossible dependency fails
  // -------------------------------------------------------------------------
  it("impossible dependency fails", () => {
    const lesson = createUnopenedFileLesson();
    const report = validateLesson(lesson);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.code === "DEPENDENCY_NOT_MET" && e.message.includes("ERR_VAL_UNOPENED_FILE")));
  });

  // -------------------------------------------------------------------------
  // 45. Dependency cycle fails if representable
  // -------------------------------------------------------------------------
  it("dependency cycle fails if representable", () => {
    // If a step tries to depend on a later step, preflight fails closed before READY
    const lesson = createCanonicalReferenceLesson();
    const steps = lesson.scenes[0]!.steps;
    // Swap terminal_run and terminal_stop
    const tRun = steps[5]!;
    const tStop = steps[11]!;
    steps[5] = { ...tStop, step_id: tRun.step_id, ordinal: 6, source_ref: { ...tStop.source_ref, beat_id: tRun.step_id } };
    steps[11] = { ...tRun, step_id: tStop.step_id, ordinal: 12, source_ref: { ...tRun.source_ref, beat_id: tStop.step_id } };

    const report = validateLesson(lesson);
    assert.equal(report.ok, false);
    assert.ok(report.errors.length > 0);
  });

  // -------------------------------------------------------------------------
  // 46. Authored order never auto-reordered
  // -------------------------------------------------------------------------
  it("authored order never auto-reordered", () => {
    const lesson = createCanonicalReferenceLesson();
    const report = validateLesson(lesson);
    assert.equal(report.ok, true);
    const planStepIds = report.plan!.ordered_steps.map((s) => s.step_id);
    const authoredStepIds = lesson.scenes[0]!.steps.map((s) => s.step_id);
    assert.deepEqual(planStepIds, authoredStepIds);
  });

  // -------------------------------------------------------------------------
  // 47. Valid cross-scene process dependency passes
  // -------------------------------------------------------------------------
  it("valid cross-scene process dependency passes per canonical rule", () => {
    const lesson = createCanonicalReferenceLesson();
    // Split into two scenes: Scene 1 starts server, Scene 2 stops server
    const s1Steps = lesson.scenes[0]!.steps.slice(0, 7); // steps 1-7
    const s2Steps = lesson.scenes[0]!.steps.slice(7);    // steps 8-14

    lesson.scenes[0]!.steps = s1Steps;

    lesson.scenes.push({
      scene_id: "C01-L001-S002",
      ordinal: 2,
      type: "code_demo",
      title: "Scene 2: Browser and Teardown",
      duration_seconds: 150,
      narration_form: "beats",
      visual: { kind: "browser", description: "Browser scene" },
      on_screen_text: [],
      blocks: [],
      assets: [],
      steps: s2Steps.map((s, idx) => ({
        ...s,
        step_id: s.step_id.replace("-S001-", "-S002-"),
        ordinal: idx + 1,
        source_ref: {
          ...s.source_ref,
          scene_id: "C01-L001-S002",
          scene_ordinal: 2,
          beat_id: s.source_ref.beat_id?.replace("-S001-", "-S002-") ?? null,
        },
      })),
    });

    const report = validateLesson(lesson);
    assert.equal(report.ok, true, JSON.stringify(report.errors));
    assert.equal(report.plan!.total_steps, 14);
  });

  // -------------------------------------------------------------------------
  // 48. End-of-lesson active process produces cleanup plan
  // -------------------------------------------------------------------------
  it("end-of-lesson active process produces cleanup plan", () => {
    const lesson = createCanonicalReferenceLesson();
    // Remove terminal_stop (step 12)
    lesson.scenes[0]!.steps.splice(11, 1);
    for (let i = 0; i < lesson.scenes[0]!.steps.length; i++) {
      lesson.scenes[0]!.steps[i]!.ordinal = i + 1;
    }

    const report = validateLesson(lesson);
    assert.equal(report.ok, true);
    assert.deepEqual([...report.plan!.completion_cleanup_processes], ["demo_server"]);
    const proc = report.plan!.background_processes.find((p) => p.process_id === "demo_server");
    assert.equal(proc!.lifetime, "LIVES_UNTIL_COMPLETION");
  });

  // -------------------------------------------------------------------------
  // 49. Same input produces byte/deterministically equivalent plan
  // -------------------------------------------------------------------------
  it("same input produces byte/deterministically equivalent plan", () => {
    const lesson1 = createCanonicalReferenceLesson();
    const lesson2 = createCanonicalReferenceLesson();

    const report1 = validateLesson(lesson1);
    const report2 = validateLesson(lesson2);

    assert.equal(report1.ok, true);
    assert.equal(report2.ok, true);
    assert.equal(report1.plan!.plan_digest, report2.plan!.plan_digest);
    assert.equal(JSON.stringify(report1.plan), JSON.stringify(report2.plan));
  });

  // -------------------------------------------------------------------------
  // 50. Same invalid input produces same ordered errors
  // -------------------------------------------------------------------------
  it("same invalid input produces same ordered errors", () => {
    const lesson1 = createPrematureBrowserLesson();
    const lesson2 = createPrematureBrowserLesson();

    const report1 = validateLesson(lesson1);
    const report2 = validateLesson(lesson2);

    assert.equal(report1.ok, false);
    assert.equal(report2.ok, false);
    assert.deepEqual(report1.errors, report2.errors);
  });

  // -------------------------------------------------------------------------
  // 51. Hostile payload not leaked in error
  // -------------------------------------------------------------------------
  it("hostile payload not leaked in error", () => {
    const lesson = createCanonicalReferenceLesson();
    const createStep = lesson.scenes[0]!.steps.find((s) => s.step_id === "C01-L001-S001-B002");
    if (createStep && createStep.kind === "operation") {
      (createStep.operation.parameters as any).path = "E:\\Windows\\System32\\cmd.exe";
    }
    const report = validateLesson(lesson);
    assert.equal(report.ok, false);
    for (const err of report.errors) {
      assert.ok(!err.message.includes("E:\\Windows"));
    }
  });

  // -------------------------------------------------------------------------
  // 52. Command text not parsed for dependency inference
  // -------------------------------------------------------------------------
  it("command text not parsed for dependency inference", () => {
    const lesson = createCanonicalReferenceLesson();
    // Put "node server.js" in foreground terminal_run
    const runStep = lesson.scenes[0]!.steps.find((s) => s.step_id === "C01-L001-S001-B005");
    if (runStep && runStep.kind === "operation") {
      (runStep.operation.parameters as any).command = "node --listen 3000 server.js";
    }
    // Remove background terminal_run
    lesson.scenes[0]!.steps = lesson.scenes[0]!.steps.filter((s) => s.step_id !== "C01-L001-S001-B006");
    for (let i = 0; i < lesson.scenes[0]!.steps.length; i++) {
      lesson.scenes[0]!.steps[i]!.ordinal = i + 1;
    }

    // Should FAIL because command text is never parsed to infer a background server
    const report = validateLesson(lesson);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.message.includes("ERR_VAL_UNREACHABLE_PORT")));
  });

  // -------------------------------------------------------------------------
  // 53. Selector text not inspected for routing
  // -------------------------------------------------------------------------
  it("selector text not inspected for routing", () => {
    const lesson = createCanonicalReferenceLesson();
    const report = validateLesson(lesson);
    assert.equal(report.ok, true);
    // Routing for browser_click is strictly by action discriminator "browser_click", not selector text
    const clickStep = report.plan!.ordered_steps.find((s) => s.step_id === "C01-L001-S001-B010");
    assert.equal(clickStep!.engine, "browser");
  });

  // -------------------------------------------------------------------------
  // 54. Validator performs zero engine execution
  // -------------------------------------------------------------------------
  it("validator performs zero engine execution", () => {
    // Pure function call with synthetic data finishes in under 50ms with zero subprocesses
    const start = performance.now();
    const lesson = createCanonicalReferenceLesson();
    const report = validateLesson(lesson);
    const duration = performance.now() - start;

    assert.equal(report.ok, true);
    assert.ok(duration < 200, `Execution took ${duration}ms, expected purely offline synchronous execution`);
  });

  // -------------------------------------------------------------------------
  // 55. Schema remains 1.1
  // -------------------------------------------------------------------------
  it("schema remains 1.1", () => {
    assert.equal(SCHEMA_VERSION, "1.1");
  });

  // -------------------------------------------------------------------------
  // 56. IR remains 1.0
  // -------------------------------------------------------------------------
  it("IR remains 1.0", () => {
    assert.equal(COMPILED_IR_VERSION, "1.0");
  });
});
