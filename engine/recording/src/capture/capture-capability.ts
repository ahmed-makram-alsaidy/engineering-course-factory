// P9.2 Capture Capability Probe — structured WGC support contract.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 6, 13 and
// docs/adr/ADR-0014-screen-recording-boundary.md. Defines the bounded
// capability record returned by the native probe and the frozen policy that
// decides whether capture may proceed. Safe fields only: no paths, no PIDs,
// no handles, no native pointers.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Native Capability Record (bounded, structured, privacy-safe)
// ---------------------------------------------------------------------------

/**
 * Capability record produced by the native backend probe. Every boolean is
 * an explicit host fact; nothing is inferred silently.
 */
export const NativeCapabilitySchema = z.strictObject({
  backend: z.literal("wgc-window"),
  wgc_supported: z.boolean(),
  create_for_window_supported: z.boolean(),
  d3d11_available: z.boolean(),
  d3d_adapter: z.enum(["hardware", "warp", "unavailable"]),
  cursor_disable_supported: z.boolean(),
  border_disable_supported: z.boolean(),
  os_build: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});

export type NativeCapability = z.infer<typeof NativeCapabilitySchema>;

/** Canonical cursor policy: hidden cursor (P9-DESIGN-SPEC Section 6.2). */
export const CAPTURE_CURSOR_REQUIRED_HIDDEN = true;

/** Canonical border policy: suppress the capture border where supported. */
export const CAPTURE_BORDER_SUPPRESS_WHEN_SUPPORTED = true;

// ---------------------------------------------------------------------------
// Capability Policy (frozen: what HOLDs vs what is recorded)
// ---------------------------------------------------------------------------

export interface CapabilityVerdict {
  usable: boolean;
  holdReasons: string[];
  cursorHidden: boolean;
  borderSuppressed: boolean;
  degradedAdapter: boolean;
}

/**
 * Frozen capability policy:
 * - WGC + CreateForWindow + D3D11 are mandatory (else HOLD).
 * - Cursor disable is mandatory: a host that cannot hide the cursor cannot
 *   take the canonical take (HOLD; never silently capture the cursor).
 * - Border suppression is best-effort: recorded, never fatal by itself.
 * - WARP adapter is an explicit degraded fact (never silent); capture may
 *   proceed but the take is permanently marked degraded by the future owner.
 */
export function evaluateCaptureCapability(
  capability: NativeCapability,
): CapabilityVerdict {
  const parsed = NativeCapabilitySchema.parse(capability);
  const holdReasons: string[] = [];
  if (!parsed.wgc_supported) {
    holdReasons.push("wgc unsupported on this host");
  }
  if (!parsed.create_for_window_supported) {
    holdReasons.push("window item creation unsupported on this host");
  }
  if (!parsed.d3d11_available || parsed.d3d_adapter === "unavailable") {
    holdReasons.push("no D3D11 device available on this host");
  }
  if (!parsed.cursor_disable_supported) {
    holdReasons.push("cursor capture cannot be disabled on this host");
  }
  return {
    usable: holdReasons.length === 0,
    holdReasons,
    cursorHidden: true,
    borderSuppressed: parsed.border_disable_supported,
    degradedAdapter: parsed.d3d_adapter === "warp",
  };
}
