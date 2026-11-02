// P9.3 Deterministic Text Fixture — synthetic high-frequency frame source.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 11, 22 (text-bias,
// non-blank/progression evidence). Generates deterministic in-memory BGRA8
// frames carrying high-frequency text-like edges, thin rules, contrast
// blocks, and a per-frame counter glyph row. Used by unit tests and by the
// scoped real-encode proofs (NVENC + libx264). No disk, no clock, no random:
// output is a pure function of (frameIndex, width, height).

import {
  CAPTURE_BYTES_PER_PIXEL,
  CAPTURE_HEIGHT,
  CAPTURE_WIDTH,
} from "../capture/capture-format.ts";

/** Fixture canvas: canonical 1080p unless a smaller multiple is requested. */
export const FIXTURE_WIDTH = CAPTURE_WIDTH;
export const FIXTURE_HEIGHT = CAPTURE_HEIGHT;

/** 32-bit mix step (deterministic, no Math.random anywhere). */
function hash32(a: number, b: number, c: number): number {
  let h = (0x9e3779b9 + a * 0x85ebca6b + b * 0xc2b2ae35 + c * 0x27d4eb2f) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

const BG = { b: 0x1e, g: 0x1e, b2: 0x1e };
const FG = { b: 0xd4, g: 0xd4, r: 0xd4 };
const ACCENT = { b: 0x86, g: 0xc5, r: 0x61 };
const GUTTER = { b: 0x2d, g: 0x2d, r: 0x2d };
const RULE = { b: 0x3e, g: 0x3e, r: 0x3e };

function putPixel(
  bytes: Uint8Array,
  width: number,
  x: number,
  y: number,
  b: number,
  g: number,
  r: number,
): void {
  const at = (y * width + x) * CAPTURE_BYTES_PER_PIXEL;
  bytes[at] = b;
  bytes[at + 1] = g;
  bytes[at + 2] = r;
  bytes[at + 3] = 0xff;
}

/**
 * Generates one deterministic text-heavy BGRA frame. Layout: dark editor
 * canvas, line-number gutter, ~45 glyph rows of hash-driven pseudo-glyphs
 * (8x16 cells, high edge density), thin horizontal rules, one accent line,
 * a moving block cursor, and a bottom-right binary counter encoding the
 * frame index (guarantees consecutive frames differ).
 */
export function generateFixtureFrame(
  frameIndex: number,
  width: number = FIXTURE_WIDTH,
  height: number = FIXTURE_HEIGHT,
): Uint8Array {
  if (!Number.isInteger(frameIndex) || frameIndex < 0) {
    throw new Error("[FIXTURE_INVALID] frame index must be an integer >= 0");
  }
  if (width <= 0 || height <= 0 || !Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error("[FIXTURE_INVALID] dimensions must be positive integers");
  }
  const bytes = new Uint8Array(width * height * CAPTURE_BYTES_PER_PIXEL);
  // Background.
  for (let i = 0; i < width * height; i += 1) {
    const at = i * 4;
    bytes[at] = BG.b;
    bytes[at + 1] = BG.g;
    bytes[at + 2] = BG.b2;
    bytes[at + 3] = 0xff;
  }
  const cellW = 9;
  const cellH = 20;
  const gutterW = 72;
  const topPad = 24;
  const cols = Math.floor((width - gutterW - 24) / cellW);
  const rows = Math.min(45, Math.floor((height - topPad - 48) / cellH));
  // Gutter.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < gutterW; x += 1) {
      putPixel(bytes, width, x, y, GUTTER.b, GUTTER.g, GUTTER.r);
    }
  }
  // Glyph rows.
  for (let row = 0; row < rows; row += 1) {
    const y0 = topPad + row * cellH;
    const accentRow = row === frameIndex % Math.max(rows, 1);
    for (let col = 0; col < cols; col += 1) {
      const h = hash32(frameIndex >>> 2, row, col);
      const x0 = gutterW + 16 + col * cellW;
      // Glyph density varies per cell (space vs stem vs full block).
      const kind = h % 5;
      for (let gy = 2; gy < cellH - 3; gy += 1) {
        for (let gx = 1; gx < cellW - 2; gx += 1) {
          const on =
            kind === 4 ||
            (kind === 3 && gx < 3) ||
            (kind === 2 && ((gx + gy + (h & 7)) & 3) !== 0) ||
            (kind === 1 && gx === 1);
          if (on) {
            const c = accentRow ? ACCENT : FG;
            putPixel(bytes, width, x0 + gx, y0 + gy, c.b, c.g, c.r);
          }
        }
      }
    }
    // Thin rule under every 6th row.
    if (row % 6 === 5) {
      for (let x = gutterW + 16; x < width - 24; x += 1) {
        putPixel(bytes, width, x, y0 + cellH - 1, RULE.b, RULE.g, RULE.r);
      }
    }
  }
  // Moving block cursor (column advances with the frame index).
  const cursorCol = (frameIndex * 7) % Math.max(cols, 1);
  const cursorRow = (frameIndex * 3) % Math.max(rows, 1);
  const cx0 = gutterW + 16 + cursorCol * cellW;
  const cy0 = topPad + cursorRow * cellH;
  for (let gy = 2; gy < cellH - 3; gy += 1) {
    for (let gx = 1; gx < cellW - 2; gx += 1) {
      putPixel(bytes, width, cx0 + gx, cy0 + gy, 0xdc, 0xdc, 0xaa);
    }
  }
  // Binary frame counter, bottom-right 64x16 cells (8 px cells, 32 bits).
  const counterBits = 32;
  const cell = 8;
  const cw0 = width - 24 - counterBits * cell;
  const ch0 = height - 24 - 2 * cell;
  for (let bit = 0; bit < counterBits; bit += 1) {
    const on = ((frameIndex >>> bit) & 1) === 1;
    for (let py = 0; py < cell; py += 1) {
      for (let px = 0; px < cell; px += 1) {
        putPixel(
          bytes,
          width,
          cw0 + bit * cell + px,
          ch0 + py,
          on ? 0xff : 0x11,
          on ? 0xff : 0x11,
          on ? 0xff : 0x11,
        );
      }
    }
  }
  return bytes;
}

/** True when two frames differ in at least one byte. */
export function framesDiffer(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return true;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return true;
    }
  }
  return false;
}

/** Fraction of bytes that are nonzero (non-blank evidence, 0..1). */
export function nonzeroByteRatio(bytes: Uint8Array): number {
  if (bytes.length === 0) {
    return 0;
  }
  let nonzero = 0;
  const step = 997;
  let sampled = 0;
  for (let i = 0; i < bytes.length; i += step) {
    sampled += 1;
    if (bytes[i] !== 0) {
      nonzero += 1;
    }
  }
  return sampled === 0 ? 0 : nonzero / sampled;
}
