// P9.2 native WGC capture core — window-scoped frame acquisition.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 4-6 and ADR-0014.
// Windows Graphics Capture, window item only (CreateForWindow), D3D11 frame
// pool, pull model (TryGetNextFrame drained by the owner at 30 Hz).
//
// This core intentionally depends on NEITHER Node-API NOR the proof console:
// the N-API addon (addon.cc) and the standalone proof (proof.cc) are thin
// frontends over this class. No window discovery, no monitor capture, no
// desktop duplication, no disk writes, no encoder.

#pragma once

#include <atomic>
#include <cstdint>
#include <string>

namespace cfrec {

// Bounded machine codes reported to the managed seam. Messages are short
// static strings (never COM text, never paths).
enum class WgcStatus {
  Ok = 0,
  InvalidSource = 1,
  SourceDestroyed = 2,
  WrongOwner = 3,
  GeometryMismatch = 4,
  WgcUnsupported = 5,
  DeviceLost = 6,
  CaptureFailed = 7,
  AlreadyStarted = 8,
  NotStarted = 9,
  AlreadyClosed = 10,
};

struct WgcResult {
  WgcStatus status = WgcStatus::Ok;
  const char* message = "ok";
};

// Acquire outcomes for the pull model.
enum class WgcAcquire {
  Frame = 0,
  Empty = 1,
  SourceLost = 2,
  GeometryChanged = 3,
  Ended = 4,
  Failed = 5,
};

struct WgcCapability {
  bool wgcSupported = false;
  bool createForWindowSupported = false;
  bool d3d11Available = false;
  // 0 = hardware, 1 = warp (explicit degraded), 2 = unavailable.
  int d3dAdapter = 2;
  bool cursorDisableSupported = false;
  bool borderDisableSupported = false;
  uint32_t osBuild = 0;
};

struct WgcFrameInfo {
  uint64_t timestampUs = 0;
  int width = 0;
  int height = 0;
  int strideBytes = 0;
  int byteLength = 0;
  uint64_t digestFnv1a64 = 0;
  bool hasDigest = false;
  // Fraction of sampled bytes that are nonzero (content evidence).
  double nonzeroSampleRatio = 0.0;
  uint32_t centerPixelBgra = 0;
};

// FNV-1a 64-bit over a byte range (dependency-free content digest).
uint64_t WgcFnv1a64(const uint8_t* data, size_t size);

const char* WgcStatusMessage(WgcStatus status);

class WgcCapture {
 public:
  WgcCapture();
  ~WgcCapture();

  WgcCapture(const WgcCapture&) = delete;
  WgcCapture& operator=(const WgcCapture&) = delete;

  // Capability probe. Safe to call at any time, including twice.
  WgcCapability Probe();

  // Opens the trusted window item. Validates: non-null, exists, top-level,
  // owned by ownerPid. Never searches for windows.
  WgcResult Open(uint64_t hwndValue, uint32_t ownerPid, int* outWidth,
                 int* outHeight);

  // Starts acquisition after verifying the item size matches expectedW/H
  // exactly (canonical 1920x1080 enforced by the managed owner).
  WgcResult Start(int expectedWidth, int expectedHeight, int poolSize,
                  bool* cursorHiddenOut, bool* borderSuppressedOut);

  // Pulls one frame. Returns Ended after stop/close, SourceLost once the
  // item reports Closed (latched), GeometryChanged on content-size drift.
  WgcAcquire Acquire(bool wantDigest, WgcFrameInfo* outFrame,
                     WgcResult* outError, int* outObservedWidth,
                     int* outObservedHeight);

  // P9.3 additive byte-retention seam (Main-side encoder readback bridge).
  // Disabled by default: P9.2 flows never arm it and observe zero behavior
  // change (no extra copies, no retained memory). When armed, a
  // digest-mapped acquire additionally retains one tightly packed copy of
  // the mapped frame in a bounded 16-slot ring keyed by capture timestamp,
  // so burst drains keep exact per-frame provenance. Retention is cleared
  // on Stop/Close. Never exposes device pointers or handles.
  WgcResult ArmByteRetention();
  bool RetainedInfoFor(uint64_t timestampUs, size_t* outSize, int* outWidth,
                       int* outHeight);
  bool CopyRetainedBytesFor(uint64_t timestampUs, uint8_t* dst,
                            size_t dstBytes);

  // Stops the session; further Acquire calls return Ended. Idempotent.
  WgcResult Stop();

  // Releases every owned handle. Idempotent. No resurrection afterwards.
  WgcResult Close();

  // Safe counters for observability (no handles, no paths).
  int generation() const { return generation_.load(); }
  uint64_t framesCaptured() const { return framesCaptured_.load(); }
  bool cursorHidden() const { return cursorHidden_; }
  bool borderSuppressed() const { return borderSuppressed_; }
  int d3dAdapter() const { return d3dAdapter_; }
  const char* stateName() const;

 private:
  struct Impl;
  Impl* impl_;
  std::atomic<int> generation_{0};
  std::atomic<uint64_t> framesCaptured_{0};
  bool cursorHidden_ = false;
  bool borderSuppressed_ = false;
  int d3dAdapter_ = 2;
};

}  // namespace cfrec
