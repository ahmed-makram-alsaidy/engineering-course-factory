// P9.2 capture test helpers: deterministic session construction.
// The fake owner PID (4242) is the only identity the fake driver accepts;
// the trusted registry + session enforce everything else.

import { FakeCaptureDriver, type FakeDriverOptions } from "../src/capture/fake-driver.ts";
import { TrustedCaptureSourceRegistry } from "../src/capture/trusted-source.ts";
import { WgcCaptureSession } from "../src/capture/wgc-session.ts";

export const FAKE_OWNER_PID = 4242;

export interface TestClock {
  now: number;
  nowMs: () => number;
  advance: (ms: number) => void;
}

export function makeTestClock(start = 1000): TestClock {
  const clock: TestClock = {
    now: start,
    nowMs: () => clock.now,
    advance: (ms: number) => {
      clock.now += ms;
    },
  };
  return clock;
}

export interface TestSession {
  registry: TrustedCaptureSourceRegistry;
  driver: FakeCaptureDriver;
  session: WgcCaptureSession;
  token: string;
  clock: TestClock;
}

export function makeTestSession(
  driverOptions: FakeDriverOptions = {},
  clockStart = 1000,
): TestSession {
  const registry = new TrustedCaptureSourceRegistry();
  const driver = new FakeCaptureDriver(driverOptions);
  const clock = makeTestClock(clockStart);
  const issued = registry.issue({
    windowHandle: 0x1000n,
    ownerPid: FAKE_OWNER_PID,
  });
  const session = new WgcCaptureSession({
    fence: {
      recording_session_id: "rec-p92-test-001",
      runtime_session_id: "sess-runtime-001",
      generation: 1,
    },
    takeId: "t01",
    driver,
    registry,
    token: issued.token,
    nowMs: clock.nowMs,
  });
  return { registry, driver, session, token: issued.token, clock };
}

/** Opens + starts a session with default canonical geometry. */
export function openAndStart(test: TestSession): void {
  test.session.open();
  test.session.start();
}
