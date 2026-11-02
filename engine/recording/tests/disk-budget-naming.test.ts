// Tests for P9.1 disk budget (preflight math + abort policy) and
// deterministic artifact naming (traversal-proof, Main-computed).
//
// Canonical authority: P9-DESIGN-SPEC.md Sections 20-21.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CEILING_BYTES_PER_SECOND,
  DISK_POLL_INTERVAL_MS,
  ENCODER_FLUSH_TIMEOUT_MS,
  LOW_SPACE_ABORT_BYTES,
  MAX_BILLABLE_LESSON_S,
  PREFLIGHT_ESTIMATE_MULTIPLIER,
  PREFLIGHT_MIN_FREE_BYTES,
  RECORDER_SHUTDOWN_BARRIER_MS,
  checkDiskPreflight,
  estimateFinalBytes,
  requiredFreeBytes,
  shouldAbortOnLowSpace,
} from "../src/disk-budget.ts";
import {
  buildTakeArtifactBaseName,
  formatTakeId,
  parseTakeArtifactBaseName,
  takeAnchorsFileName,
  takeDiagnosticPartialFileName,
  takeManifestFileName,
  takePartialFileName,
  takeVideoFileName,
} from "../src/naming.ts";

describe("P9.1: disk budget estimator", () => {
  it("ceiling rate is 2.0 MB/s capped at the 30 min session ceiling", () => {
    assert.equal(CEILING_BYTES_PER_SECOND, 2_000_000);
    assert.equal(MAX_BILLABLE_LESSON_S, 1_800);
    assert.equal(estimateFinalBytes(600), 600 * 2_000_000);
    assert.equal(estimateFinalBytes(1_800), 3_600_000_000);
    assert.equal(estimateFinalBytes(3_600), 3_600_000_000);
    assert.equal(estimateFinalBytes(0), 0);
  });

  it("rejects negative or non-finite lesson durations", () => {
    assert.throws(() => estimateFinalBytes(-1), /INVALID/);
    assert.throws(() => estimateFinalBytes(NaN), /INVALID/);
    assert.throws(() => estimateFinalBytes(Infinity), /INVALID/);
  });

  it("preflight requires max(2 GiB, estimate x 3)", () => {
    assert.equal(PREFLIGHT_MIN_FREE_BYTES, 2_147_483_648);
    assert.equal(PREFLIGHT_ESTIMATE_MULTIPLIER, 3);
    assert.equal(requiredFreeBytes(60), PREFLIGHT_MIN_FREE_BYTES);
    assert.equal(requiredFreeBytes(600), 600 * 2_000_000 * 3);
  });

  it("preflight gate passes on healthy disk", () => {
    const verdict = checkDiskPreflight({
      free_bytes: 20_000_000_000,
      expected_lesson_s: 600,
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.reason, "SUFFICIENT");
  });

  it("preflight gate refuses below the 2 GiB floor", () => {
    const verdict = checkDiskPreflight({ free_bytes: 1_000_000_000, expected_lesson_s: 60 });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "BELOW_FLOOR");
  });

  it("preflight gate refuses below the scaled estimate", () => {
    const verdict = checkDiskPreflight({
      free_bytes: 3_000_000_000,
      expected_lesson_s: 600,
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "BELOW_ESTIMATE");
  });

  it("low-space abort fires below 1 GiB", () => {
    assert.equal(LOW_SPACE_ABORT_BYTES, 1_073_741_824);
    assert.equal(shouldAbortOnLowSpace(1_073_741_824), false);
    assert.equal(shouldAbortOnLowSpace(1_073_741_823), true);
    assert.equal(shouldAbortOnLowSpace(0), true);
    assert.throws(() => shouldAbortOnLowSpace(-1), /INVALID/);
  });

  it("bounded lifecycle timeouts are frozen", () => {
    assert.equal(DISK_POLL_INTERVAL_MS, 5_000);
    assert.equal(RECORDER_SHUTDOWN_BARRIER_MS, 10_000);
    assert.equal(ENCODER_FLUSH_TIMEOUT_MS, 30_000);
  });
});

describe("P9.1: deterministic artifact naming", () => {
  it("builds the canonical base name", () => {
    assert.equal(
      buildTakeArtifactBaseName({
        lesson_id: "C01-L003",
        generation: 1,
        take_id: "t01",
      }),
      "C01-L003--gen1--taket01",
    );
  });

  it("formats take ids with minimum two digits", () => {
    assert.equal(formatTakeId(1), "t01");
    assert.equal(formatTakeId(12), "t12");
    assert.equal(formatTakeId(120), "t120");
    assert.throws(() => formatTakeId(0), /INVALID/);
    assert.throws(() => formatTakeId(1.5), /INVALID/);
  });

  it("round-trips base names", () => {
    const base = buildTakeArtifactBaseName({
      lesson_id: "C01-L003",
      generation: 2,
      take_id: "t07",
    });
    assert.deepEqual(parseTakeArtifactBaseName(base), {
      lesson_id: "C01-L003",
      generation: 2,
      take_id: "t07",
    });
  });

  it("derives artifact file names without directories", () => {
    const base = "C01-L003--gen1--taket01";
    assert.equal(takeVideoFileName(base), "C01-L003--gen1--taket01.mp4");
    assert.equal(takeManifestFileName(base), "C01-L003--gen1--taket01.manifest.json");
    assert.equal(takeAnchorsFileName(base), "C01-L003--gen1--taket01.anchors.jsonl");
    assert.equal(takePartialFileName(base), "C01-L003--gen1--taket01.partial.mp4");
    assert.equal(
      takeDiagnosticPartialFileName(base),
      "C01-L003--gen1--taket01.diagnostic.partial.mp4",
    );
    for (const name of [
      takeVideoFileName(base),
      takeManifestFileName(base),
      takeAnchorsFileName(base),
    ]) {
      assert.ok(!name.includes("/") && !name.includes("\\") && !name.includes(".."));
    }
  });

  it("rejects traversal and hostile base names", () => {
    for (const bad of [
      "../../evil",
      "C01-L003--gen1--taket01.mp4",
      "..\\windows\\x",
      "C01-L003--gen0--taket01",
      "C01-L003--gen1--take1",
      "/abs/path",
      "E:\\abs",
      "",
    ]) {
      assert.throws(() => parseTakeArtifactBaseName(bad), /NAMING_INVALID/, bad);
    }
  });
});
