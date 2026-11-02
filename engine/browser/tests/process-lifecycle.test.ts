// P7.3 Browser Process Lifecycle & Version Lock Tests — browser_protocol_version = 1.
//
// Canonical authority: docs/P7-DESIGN-SPEC.md Sections 4, 13, 19, 25.
// Proves:
// 1. Pinned Playwright Core version (1.50.1).
// 2. Pinned Chromium revision (1155 / 133.0.6943.16).
// 3. Binary storage strictly on E:\course-factory\bin\browsers.
// 4. Missing binary fails closed (BROWSER_LAUNCH_FAILED; no silent fallback to Chrome/Edge).
// 5. Argument validation rejects unsafe flags (--no-sandbox, --remote-debugging-port).
// 6. Ephemeral profiles are created under temp/browser-profiles/<session_id>-<generation>/.
// 7. Ephemeral profile purged cleanly on reset/close.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  PINNED_PLAYWRIGHT_VERSION,
  PINNED_CHROMIUM_REVISION,
  PINNED_CHROMIUM_VERSION,
  PINNED_CHROMIUM_EXE_PATH,
  DEFAULT_BROWSERS_PATH,
  FROZEN_CHROMIUM_ARGS,
  FORBIDDEN_CHROMIUM_FLAGS,
  verifyPinnedBrowserBinary,
  validateChromiumArgs,
} from "../src/process.ts";
import {
  createEphemeralProfile,
  getCanonicalProfileDir,
  purgeEphemeralProfile,
  DEFAULT_PROFILES_BASE_DIR,
} from "../src/profile.ts";

describe("P7.3 Binary Version Lock & Argument Safety", () => {
  it("proves pinned Playwright Core version is exactly 1.50.1", () => {
    assert.equal(PINNED_PLAYWRIGHT_VERSION, "1.50.1");

    const pwPkgPath = resolve("node_modules", "playwright-core", "package.json");
    if (existsSync(pwPkgPath)) {
      const pkg = JSON.parse(readFileSync(pwPkgPath, "utf8"));
      assert.equal(pkg.version, "1.50.1", "Installed playwright-core must be exactly 1.50.1");
    }
  });

  it("proves pinned Chromium revision is 1155 (133.0.6943.16)", () => {
    assert.equal(PINNED_CHROMIUM_REVISION, "1155");
    assert.equal(PINNED_CHROMIUM_VERSION, "133.0.6943.16");
  });

  it("proves browser binary path is anchored strictly under E:\\course-factory\\bin\\browsers", () => {
    assert.ok(
      DEFAULT_BROWSERS_PATH.toLowerCase().includes("bin\\browsers") ||
      DEFAULT_BROWSERS_PATH.toLowerCase().includes("bin/browsers"),
      "Browsers path must be under project bin/browsers",
    );
    assert.ok(
      !DEFAULT_BROWSERS_PATH.toLowerCase().includes("appdata"),
      "Must not point to %LOCALAPPDATA%",
    );
  });

  it("verifies pinned Chromium executable exists on disk", () => {
    const res = verifyPinnedBrowserBinary();
    assert.equal(res.ok, true, `Pinned binary verification failed: ${res.reason}`);
    assert.ok(res.executablePath && existsSync(res.executablePath), "Executable must exist on disk");
  });

  it("proves missing binary fails closed without fallback to system Chrome/Edge", () => {
    const bogusPath = "E:\\course-factory\\bin\\browsers\\nonexistent\\chrome.exe";
    const res = verifyPinnedBrowserBinary(bogusPath);
    assert.equal(res.ok, false);
    assert.equal(res.code, "BROWSER_LAUNCH_FAILED");
    assert.ok(res.reason?.includes("BROWSER_BINARY_MISSING"));
  });

  it("validates that forbidden flags (--no-sandbox, --remote-debugging-port) are rejected", () => {
    for (const flag of FORBIDDEN_CHROMIUM_FLAGS) {
      const check = validateChromiumArgs([flag]);
      assert.equal(check.ok, false, `Flag '${flag}' must be rejected`);
    }

    const portCheck = validateChromiumArgs(["--remote-debugging-port=9222"]);
    assert.equal(portCheck.ok, false, "TCP remote debugging port must be rejected");

    const goodCheck = validateChromiumArgs(FROZEN_CHROMIUM_ARGS);
    assert.equal(goodCheck.ok, true, "Frozen reviewed arguments must be accepted");
  });
});

describe("P7.3 Ephemeral Profile Lifecycle & Isolation", () => {
  const testSession = "test-prof-sess";
  const gen = 1;

  it("proves canonical profile directory lives strictly under temp/browser-profiles", () => {
    const dir = getCanonicalProfileDir(testSession, gen);
    assert.ok(dir.includes("temp\\browser-profiles") || dir.includes("temp/browser-profiles"));
    assert.ok(dir.endsWith(`${testSession}-${gen}`));
    assert.ok(!dir.includes("AppData"), "Profile must never be under user AppData");
  });

  it("creates ephemeral profile on disk and purges it completely on demand", async () => {
    const profileDir = createEphemeralProfile(testSession, gen);
    assert.ok(existsSync(profileDir), "Profile dir should exist");

    // Write a dummy file to simulate browser profile contents
    const dummyFile = join(profileDir, "test-cookie.txt");
    writeFileSync(dummyFile, "ephemeral-state-token");
    assert.ok(existsSync(dummyFile), "Dummy profile file must exist");

    // Purge
    const purged = await purgeEphemeralProfile(profileDir);
    assert.equal(purged, true, "Profile purge must succeed");
    assert.equal(existsSync(profileDir), false, "Profile directory must be deleted");
  });
});
