/**
 * helpers/scheduleDispatch.test.js — unit coverage for the rAF + freshness
 * check pattern used by Chatbox.jsx for `tethysdash:update-visualization`
 * dispatches.
 *
 * Closes Plan 20 parked follow-up #16 (rAF turn-id race). The freshness
 * check is centralized here so the closure-capture-then-compare discipline
 * is structurally enforced and unit-testable without mounting Chatbox.
 *
 * Tests stub global requestAnimationFrame so callbacks fire synchronously
 * under our control.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { scheduleDispatchIfFresh } from "./scheduleDispatch.js";

// rAF stub: vitest's default node environment has no requestAnimationFrame,
// so we install our own and queue callbacks for synchronous flushing in tests.
let rafFn;
const queuedCallbacks = [];

beforeEach(() => {
  queuedCallbacks.length = 0;
  rafFn = vi.fn((cb) => {
    queuedCallbacks.push(cb);
    return queuedCallbacks.length;
  });
  vi.stubGlobal("requestAnimationFrame", rafFn);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function flushRaf() {
  const callbacks = queuedCallbacks.splice(0);
  for (const cb of callbacks) cb(0);
}

describe("scheduleDispatchIfFresh", () => {
  it("invokes dispatch when the captured turn-id matches the current one", () => {
    const dispatch = vi.fn();
    scheduleDispatchIfFresh({
      getCurrentTurnId: () => 5,
      capturedTurnId: 5,
      dispatch,
    });
    flushRaf();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("skips dispatch when the captured turn-id is stale", () => {
    const dispatch = vi.fn();
    let current = 5;
    scheduleDispatchIfFresh({
      getCurrentTurnId: () => current,
      capturedTurnId: 5,
      dispatch,
    });
    current = 6; // turn-id advanced before rAF fires
    flushRaf();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("only the latest of multiple in-flight schedules fires its dispatch", () => {
    const d1 = vi.fn();
    const d2 = vi.fn();
    const d3 = vi.fn();
    let current = 1;
    scheduleDispatchIfFresh({
      getCurrentTurnId: () => current,
      capturedTurnId: 1,
      dispatch: d1,
    });
    current = 2;
    scheduleDispatchIfFresh({
      getCurrentTurnId: () => current,
      capturedTurnId: 2,
      dispatch: d2,
    });
    current = 3;
    scheduleDispatchIfFresh({
      getCurrentTurnId: () => current,
      capturedTurnId: 3,
      dispatch: d3,
    });
    // current = 3 now; flush all queued callbacks
    flushRaf();
    expect(d1).not.toHaveBeenCalled();
    expect(d2).not.toHaveBeenCalled();
    expect(d3).toHaveBeenCalledTimes(1);
  });

  it("calls requestAnimationFrame exactly once per scheduleDispatchIfFresh invocation", () => {
    const dispatch = vi.fn();
    scheduleDispatchIfFresh({
      getCurrentTurnId: () => 1,
      capturedTurnId: 1,
      dispatch,
    });
    expect(rafFn).toHaveBeenCalledTimes(1);

    scheduleDispatchIfFresh({
      getCurrentTurnId: () => 2,
      capturedTurnId: 2,
      dispatch,
    });
    expect(rafFn).toHaveBeenCalledTimes(2);
  });

  it("works with the initial-turn case (captured 1, current 1)", () => {
    const dispatch = vi.fn();
    scheduleDispatchIfFresh({
      getCurrentTurnId: () => 1,
      capturedTurnId: 1,
      dispatch,
    });
    flushRaf();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not invoke dispatch synchronously (always defers via rAF)", () => {
    const dispatch = vi.fn();
    scheduleDispatchIfFresh({
      getCurrentTurnId: () => 1,
      capturedTurnId: 1,
      dispatch,
    });
    // No flushRaf → dispatch must not have been called yet.
    expect(dispatch).not.toHaveBeenCalled();
    flushRaf();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
