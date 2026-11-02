// P9.3 media validation tests: ffprobe JSON verdicts, digest helpers,
// faststart placement (unit matrix 45-53). Deterministic, zero disk: the
// faststart reader is injected over in-memory bytes.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  StreamingDigest,
  parseFrameRate,
  sha256HexOfBytes,
  verifyFaststartMoovFirst,
  verifyMediaJson,
  verifyPacketsMonotonic,
} from "../src/encoder/media-validation.ts";

function goodDoc(): Record<string, unknown> {
  return {
    format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "3.000000", size: "900000" },
    streams: [
      {
        codec_type: "video",
        codec_name: "h264",
        width: 1920,
        height: 1080,
        avg_frame_rate: "30/1",
        pix_fmt: "yuv420p",
        nb_frames: "90",
      },
    ],
    packets: [
      { pts: 0, dts: 0, stream_index: 0 },
      { pts: 1024, dts: 1024, stream_index: 0 },
      { pts: 2048, dts: 2048, stream_index: 0 },
    ],
  };
}

const EXPECTATION = {
  width: 1920 as const,
  height: 1080 as const,
  fps: 30 as const,
  expectedDurationS: 3,
  sizeCeilingBytes: 100_000_000,
  actualSizeBytes: 900_000,
};

describe("P9.3: ffprobe JSON validation good", () => {
  it("canonical doc validates PASS with all eight checks", () => {
    const outcome = verifyMediaJson(goodDoc(), EXPECTATION);
    assert.equal(outcome.verdict, "PASS");
    assert.equal(outcome.checks.length, 8);
    assert.ok(outcome.checks.every((c) => c.passed));
  });

  it("frame rate parser handles rationals and rejects garbage", () => {
    assert.equal(parseFrameRate("30/1"), 30);
    assert.equal(parseFrameRate("30000/1001"), 29.97002997002997);
    assert.equal(parseFrameRate("0/0"), null);
    assert.equal(parseFrameRate(""), null);
    assert.equal(parseFrameRate(undefined), null);
  });
});

describe("P9.3: wrong codec rejected", () => {
  it("hevc fails the codec verdict", () => {
    const doc = goodDoc();
    (doc.streams as Array<Record<string, unknown>>)[0]!["codec_name"] = "hevc";
    assert.equal(verifyMediaJson(doc, EXPECTATION).verdict, "FAIL");
  });
});

describe("P9.3: wrong geometry rejected", () => {
  it("1280x720 fails the resolution verdict", () => {
    const doc = goodDoc();
    const stream = (doc.streams as Array<Record<string, unknown>>)[0]!;
    stream["width"] = 1280;
    stream["height"] = 720;
    const outcome = verifyMediaJson(doc, EXPECTATION);
    assert.equal(outcome.verdict, "FAIL");
    assert.equal(
      outcome.checks.find((c) => c.check === "resolution_1920x1080")?.passed,
      false,
    );
  });
});

describe("P9.3: wrong FPS rejected", () => {
  it("25 fps fails the fps verdict", () => {
    const doc = goodDoc();
    (doc.streams as Array<Record<string, unknown>>)[0]!["avg_frame_rate"] = "25/1";
    const outcome = verifyMediaJson(doc, EXPECTATION);
    assert.equal(outcome.verdict, "FAIL");
  });

  it("wrong pixel format fails the codec verdict", () => {
    const doc = goodDoc();
    (doc.streams as Array<Record<string, unknown>>)[0]!["pix_fmt"] = "yuv444p";
    assert.equal(verifyMediaJson(doc, EXPECTATION).verdict, "FAIL");
  });
});

describe("P9.3: audio stream rejected", () => {
  it("any audio stream fails the silent-video invariant", () => {
    const doc = goodDoc();
    (doc.streams as Array<unknown>).push({ codec_type: "audio", codec_name: "aac" });
    assert.equal(verifyMediaJson(doc, EXPECTATION).verdict, "FAIL");
  });
});

describe("P9.3: unreadable media rejected", () => {
  it("empty doc fails container and duration verdicts", () => {
    const outcome = verifyMediaJson({}, EXPECTATION);
    assert.equal(outcome.verdict, "FAIL");
  });

  it("duration drift beyond 2 s fails", () => {
    const doc = goodDoc();
    (doc.format as Record<string, unknown>)["duration"] = "30.000000";
    assert.equal(verifyMediaJson(doc, EXPECTATION).verdict, "FAIL");
  });
});

describe("P9.3: zero-frame media rejected", () => {
  it("explicit zero nb_frames fails even with duration", () => {
    const doc = goodDoc();
    (doc.streams as Array<Record<string, unknown>>)[0]!["nb_frames"] = "0";
    const outcome = verifyMediaJson(doc, EXPECTATION);
    assert.equal(outcome.verdict, "FAIL");
    assert.equal(
      outcome.checks.find((c) => c.check === "nonzero_frames")?.passed,
      false,
    );
  });
});

describe("P9.3: pts monotonic", () => {
  it("decreasing packet dts fails", () => {
    assert.equal(
      verifyPacketsMonotonic([
        { pts: 2048, dts: 2048 },
        { pts: 1024, dts: 1024 },
      ]),
      false,
    );
    assert.equal(
      verifyPacketsMonotonic([{ pts: 0, dts: 0 }, { pts: 1024, dts: 1024 }, { pts: 2048, dts: 2048 }]),
      true,
    );
    assert.equal(verifyPacketsMonotonic(undefined), true);
  });

  it("B-frame pts reorder passes when dts is monotonic", () => {
    assert.equal(
      verifyPacketsMonotonic([
        { pts: 0, dts: -3072 },
        { pts: 4096, dts: -2048 },
        { pts: 2048, dts: -1024 },
        { pts: 1024, dts: 0 },
        { pts: 3072, dts: 1024 },
      ]),
      true,
    );
  });
});

describe("P9.3: faststart placement", () => {
  function box(type: string, size: number): Uint8Array {
    const out = new Uint8Array(size);
    out[0] = (size >>> 24) & 0xff;
    out[1] = (size >>> 16) & 0xff;
    out[2] = (size >>> 8) & 0xff;
    out[3] = size & 0xff;
    out[4] = type.charCodeAt(0);
    out[5] = type.charCodeAt(1);
    out[6] = type.charCodeAt(2);
    out[7] = type.charCodeAt(3);
    return out;
  }

  function readerFor(bytes: Uint8Array): (offset: number, length: number) => Promise<Uint8Array> {
    return async (offset, length) => bytes.slice(offset, offset + length);
  }

  it("moov before mdat passes", async () => {
    const ftyp = box("ftyp", 24);
    const moov = box("moov", 64);
    const mdat = box("mdat", 128);
    const bytes = new Uint8Array(216);
    bytes.set(ftyp, 0);
    bytes.set(moov, 24);
    bytes.set(mdat, 88);
    assert.equal(await verifyFaststartMoovFirst(readerFor(bytes)), true);
  });

  it("mdat before moov fails", async () => {
    const ftyp = box("ftyp", 24);
    const mdat = box("mdat", 128);
    const moov = box("moov", 64);
    const bytes = new Uint8Array(216);
    bytes.set(ftyp, 0);
    bytes.set(mdat, 24);
    bytes.set(moov, 152);
    assert.equal(await verifyFaststartMoovFirst(readerFor(bytes)), false);
  });

  it("truncated header fails closed", async () => {
    assert.equal(await verifyFaststartMoovFirst(readerFor(new Uint8Array(4))), false);
  });
});

describe("P9.3: digest exact", () => {
  it("streaming digest matches the known SHA-256 vector", () => {
    assert.equal(
      sha256HexOfBytes(Buffer.from("abc", "utf8")),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("chunked updates equal one-shot hashing", () => {
    const one = new StreamingDigest();
    one.update(Buffer.from("hello ", "utf8"));
    one.update(Buffer.from("world", "utf8"));
    const two = new StreamingDigest();
    two.update(Buffer.from("hello world", "utf8"));
    assert.equal(one.digest().hex, two.digest().hex);
    assert.equal(one.digest().bytes, 11);
  });
});

describe("P9.3: no full-file buffering for digest", () => {
  it("1 MiB chunks hash a 64 MiB logical stream identically", () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0xab);
    const streamed = new StreamingDigest();
    for (let i = 0; i < 64; i += 1) {
      streamed.update(chunk);
    }
    const whole = new StreamingDigest();
    const big = new Uint8Array(64 * 1024 * 1024).fill(0xab);
    whole.update(big);
    assert.equal(streamed.digest().hex, whole.digest().hex);
    assert.equal(streamed.digest().bytes, 64 * 1024 * 1024);
  });
});
