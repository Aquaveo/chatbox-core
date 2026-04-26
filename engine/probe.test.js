// @vitest-environment jsdom
/**
 * engine/probe.test.js — unit coverage for the MCP health-probe and
 * scheduler. Locks down timing-sensitive behavior (yellow-min-display
 * timer, generation-counter staleness, destroyed-flag race window) that
 * the Playwright suite exercises but cannot assert deterministically.
 *
 * Mocking strategy
 * ----------------
 * `pickTransport` and `closeMcpConnection` are mocked at the file level
 * (vi.mock partial-shape passthrough) so the scheduler tests don't need
 * SDK setup. `withTimeout` and `LIST_TOOLS_BUDGET_MS` use the real
 * implementations from transports.js — they're pure helpers.
 *
 * Microtask discipline
 * --------------------
 * `vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]})` fakes
 * setTimeout but leaves Promise/microtask scheduling on real time.
 * Between schedule-time and flush-time, tests use:
 *   - `await Promise.resolve()` or `await vi.advanceTimersByTimeAsync(0)`
 *     to drain microtasks (let pickTransport's promise settle)
 *   - `await vi.advanceTimersByTimeAsync(N)` to flush setTimeout-queued
 *     callbacks past N ms
 * This combination makes the resolution-vs-cancel ordering deterministic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ERROR_KEYS } from "./mcpErrors.js";
import { makeFakeConn } from "../test-helpers/fakeConn.js";

// ---- Mocks (hoisted) ----------------------------------------------------

vi.mock("./transports.js", async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    pickTransport: vi.fn(),
    closeMcpConnection: vi.fn().mockResolvedValue(undefined),
  };
});

import { closeMcpConnection, pickTransport } from "./transports.js";
import { createProbeScheduler, probeMcpServer } from "./probe.js";

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// probeMcpServer — phase mapping
// ---------------------------------------------------------------------------

describe("probeMcpServer", () => {
  it("maps tools-array result to state:connected", async () => {
    pickTransport.mockResolvedValueOnce(makeFakeConn({ tools: [{ name: "echo" }] }));
    const result = await probeMcpServer("https://example.com/mcp");
    expect(result).toEqual({ state: "connected" });
  });

  it("maps empty tools array to state:no-tools", async () => {
    pickTransport.mockResolvedValueOnce(makeFakeConn({ tools: [] }));
    const result = await probeMcpServer("https://example.com/mcp");
    expect(result).toEqual({ state: "no-tools" });
  });

  it("maps missing tools key to state:no-tools", async () => {
    const conn = makeFakeConn();
    conn.client.listTools = vi.fn().mockResolvedValue({});
    pickTransport.mockResolvedValueOnce(conn);
    const result = await probeMcpServer("https://example.com/mcp");
    expect(result).toEqual({ state: "no-tools" });
  });

  it("maps pickTransport rejection with errorKey to failed/<errorKey>", async () => {
    const err = new Error("scheme bad");
    err.errorKey = ERROR_KEYS.invalidScheme;
    pickTransport.mockRejectedValueOnce(err);
    const result = await probeMcpServer("file:///etc/passwd");
    expect(result).toEqual({ state: "failed", errorKey: ERROR_KEYS.invalidScheme });
  });

  it("maps pickTransport rejection without errorKey to failed/connection-failed", async () => {
    pickTransport.mockRejectedValueOnce(new Error("network down"));
    const result = await probeMcpServer("https://example.com/mcp");
    expect(result).toEqual({ state: "failed", errorKey: ERROR_KEYS.connectionFailed });
  });

  it("maps listTools rejection to failed/not-mcp-server (phase=list_tools)", async () => {
    const conn = makeFakeConn();
    conn.client.listTools = vi.fn().mockRejectedValue(new Error("RPC method not found"));
    pickTransport.mockResolvedValueOnce(conn);
    const result = await probeMcpServer("https://example.com/mcp");
    expect(result).toEqual({ state: "failed", errorKey: ERROR_KEYS.notMcpServer });
  });

  it("calls closeMcpConnection in finally regardless of outcome", async () => {
    closeMcpConnection.mockClear();

    // Happy path
    pickTransport.mockResolvedValueOnce(makeFakeConn({ tools: [{ name: "x" }] }));
    await probeMcpServer("https://example.com/mcp");
    expect(closeMcpConnection).toHaveBeenCalledTimes(1);

    // listTools rejection
    const conn = makeFakeConn();
    conn.client.listTools = vi.fn().mockRejectedValue(new Error("nope"));
    pickTransport.mockResolvedValueOnce(conn);
    await probeMcpServer("https://example.com/mcp");
    expect(closeMcpConnection).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// createProbeScheduler — basic schedule + onUpdate flow
// ---------------------------------------------------------------------------

describe("createProbeScheduler — basic flow", () => {
  it("schedule announces yellow synchronously, then writes connected after the 400ms min-display window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onUpdate = vi.fn();
    const scheduler = createProbeScheduler({ onUpdate });

    pickTransport.mockResolvedValueOnce(makeFakeConn({ tools: [{ name: "x" }] }));

    scheduler.schedule("https://a.test/mcp");

    // Yellow announce is synchronous.
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0][1]).toMatchObject({ state: "yellow" });

    // Drain microtasks so pickTransport resolves; not yet 400ms past
    // schedule, so the result is queued via setTimeout.
    await vi.advanceTimersByTimeAsync(0);

    // Advance past the min-display window. The deferred write fires.
    await vi.advanceTimersByTimeAsync(401);

    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate.mock.calls[1][1]).toEqual({ state: "connected" });
  });

  it("slow probe (>400ms) writes connected immediately on resolution (no setTimeout flush)", async () => {
    // Include "Date" in toFake so runProbe's `elapsed = Date.now() -
    // startedAt` advances with the fake clock — otherwise elapsed is
    // real-time (a few ms) and the probe always hits the setTimeout
    // deferral path.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const onUpdate = vi.fn();
    const scheduler = createProbeScheduler({ onUpdate });

    let resolvePick;
    pickTransport.mockReturnValueOnce(
      new Promise((res) => { resolvePick = res; }),
    );

    scheduler.schedule("https://a.test/mcp");
    expect(onUpdate).toHaveBeenCalledTimes(1); // yellow

    // Advance past 400ms — probe still in-flight; fake Date.now() advances too.
    await vi.advanceTimersByTimeAsync(401);
    expect(onUpdate).toHaveBeenCalledTimes(1); // still only yellow

    // Resolve pickTransport — onUpdate fires immediately because elapsed > 400.
    resolvePick(makeFakeConn({ tools: [{ name: "x" }] }));
    await vi.advanceTimersByTimeAsync(0); // drain microtasks
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate.mock.calls[1][1]).toEqual({ state: "connected" });
  });
});

// ---------------------------------------------------------------------------
// createProbeScheduler — cancellation & generation counter
// ---------------------------------------------------------------------------

describe("createProbeScheduler — cancellation", () => {
  it("schedule then cancel before resolve: only yellow fires", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onUpdate = vi.fn();
    const scheduler = createProbeScheduler({ onUpdate });

    let resolvePick;
    pickTransport.mockReturnValueOnce(
      new Promise((res) => { resolvePick = res; }),
    );

    scheduler.schedule("https://a.test/mcp");
    expect(onUpdate).toHaveBeenCalledTimes(1); // yellow

    scheduler.cancel("https://a.test/mcp");

    // Resolve the in-flight probe — its result must be discarded by the
    // gen check.
    resolvePick(makeFakeConn({ tools: [{ name: "x" }] }));
    await vi.advanceTimersByTimeAsync(401);

    expect(onUpdate).toHaveBeenCalledTimes(1); // still only the original yellow
  });

  it("schedule then schedule again: first probe's late resolution is discarded", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onUpdate = vi.fn();
    const scheduler = createProbeScheduler({ onUpdate });

    let resolveFirst;
    pickTransport.mockReturnValueOnce(
      new Promise((res) => { resolveFirst = res; }),
    );

    scheduler.schedule("https://a.test/mcp");
    expect(onUpdate).toHaveBeenCalledTimes(1); // yellow #1

    // Second schedule bumps gen.
    pickTransport.mockResolvedValueOnce(makeFakeConn({ tools: [{ name: "x" }] }));
    scheduler.schedule("https://a.test/mcp");
    expect(onUpdate).toHaveBeenCalledTimes(2); // yellow #2

    // Resolve the first (now-stale) probe.
    resolveFirst(makeFakeConn({ tools: [{ name: "y" }] }));
    await vi.advanceTimersByTimeAsync(401);

    // Only yellow + the SECOND probe's connected result should land.
    // Three total: yellow #1, yellow #2, connected (from probe #2).
    // The first probe's connected result is silently dropped.
    expect(onUpdate.mock.calls.filter((c) => c[1].state === "connected")).toHaveLength(1);
  });

  it("cancelAll cancels both running and queued URLs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onUpdate = vi.fn();
    const scheduler = createProbeScheduler({ onUpdate, concurrency: 2 });

    // Set up 4 hanging promises so all 4 schedules are running/queued.
    pickTransport.mockImplementation(() => new Promise(() => {}));

    scheduler.schedule("https://a.test/mcp");
    scheduler.schedule("https://b.test/mcp");
    scheduler.schedule("https://c.test/mcp");
    scheduler.schedule("https://d.test/mcp");

    expect(onUpdate).toHaveBeenCalledTimes(4); // 4 yellows

    scheduler.cancelAll();

    // No further onUpdate calls — all probes' resolutions (if any happened)
    // observe destroyed=true.
    await vi.advanceTimersByTimeAsync(1000);
    expect(onUpdate).toHaveBeenCalledTimes(4); // unchanged
  });
});

// ---------------------------------------------------------------------------
// createProbeScheduler — concurrency cap
// ---------------------------------------------------------------------------

describe("createProbeScheduler — concurrency cap", () => {
  it("schedule N>cap URLs: only `cap` enter running, the rest queue", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onUpdate = vi.fn();
    const scheduler = createProbeScheduler({ onUpdate, concurrency: 2 });

    pickTransport.mockImplementation(() => new Promise(() => {})); // all hang

    scheduler.schedule("https://a.test/mcp");
    scheduler.schedule("https://b.test/mcp");
    scheduler.schedule("https://c.test/mcp");
    scheduler.schedule("https://d.test/mcp");

    // pickTransport called only for the 2 that entered `running`.
    expect(pickTransport).toHaveBeenCalledTimes(2);
  });

  it("when a running probe resolves, the next queued URL starts (drain)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onUpdate = vi.fn();
    const scheduler = createProbeScheduler({ onUpdate, concurrency: 2 });

    // Make all 4 probes hang so each one's drain doesn't cascade into the
    // next. Only A resolves (manually), and only C starts (one drain step).
    let resolveA;
    pickTransport
      .mockReturnValueOnce(new Promise((res) => { resolveA = res; })) // a — manually resolved
      .mockReturnValueOnce(new Promise(() => {}))                      // b hangs
      .mockReturnValueOnce(new Promise(() => {}))                      // c hangs (when started)
      .mockReturnValueOnce(new Promise(() => {}));                     // d hangs

    scheduler.schedule("https://a.test/mcp");
    scheduler.schedule("https://b.test/mcp");
    scheduler.schedule("https://c.test/mcp"); // queued
    scheduler.schedule("https://d.test/mcp"); // queued

    expect(pickTransport).toHaveBeenCalledTimes(2);

    // Resolve probe A; the drain should start probe C (not D — D stays queued
    // because C is now hanging in `running` and there's still no slot).
    resolveA(makeFakeConn({ tools: [{ name: "x" }] }));
    await vi.advanceTimersByTimeAsync(401); // settle probe A's flush + drain

    expect(pickTransport).toHaveBeenCalledTimes(3); // A, B, C started; D still queued
  });
});

// ---------------------------------------------------------------------------
// createProbeScheduler — destroyed flag (the load-bearing race-window check)
// ---------------------------------------------------------------------------

describe("createProbeScheduler — destroyed flag", () => {
  it("cancelAll, then schedule: schedule short-circuits (no yellow, no probe)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onUpdate = vi.fn();
    const scheduler = createProbeScheduler({ onUpdate });

    scheduler.cancelAll();
    scheduler.schedule("https://a.test/mcp");

    expect(onUpdate).not.toHaveBeenCalled();
    expect(pickTransport).not.toHaveBeenCalled();
  });

  it("schedule, drain microtasks (probe resolves), cancelAll BEFORE 400ms flush: deferred flush no-ops", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onUpdate = vi.fn();
    const scheduler = createProbeScheduler({ onUpdate });

    pickTransport.mockResolvedValueOnce(makeFakeConn({ tools: [{ name: "x" }] }));

    scheduler.schedule("https://a.test/mcp");
    expect(onUpdate).toHaveBeenCalledTimes(1); // yellow

    // Drain microtasks — probe resolves, sets up the 400ms setTimeout
    // for the deferred write.
    await vi.advanceTimersByTimeAsync(0);

    // Cancel BEFORE the 400ms flush fires.
    scheduler.cancelAll();

    // Now flush the timer.
    await vi.advanceTimersByTimeAsync(401);

    // Only the original yellow was written; the deferred connected write
    // observed destroyed=true and short-circuited.
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("schedule, slow-probe resolves AFTER cancelAll: resolution-time write also no-ops", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onUpdate = vi.fn();
    const scheduler = createProbeScheduler({ onUpdate });

    let resolvePick;
    pickTransport.mockReturnValueOnce(
      new Promise((res) => { resolvePick = res; }),
    );

    scheduler.schedule("https://a.test/mcp");
    expect(onUpdate).toHaveBeenCalledTimes(1); // yellow

    // Advance past 400ms so slow-path applies (no setTimeout deferral).
    await vi.advanceTimersByTimeAsync(401);

    // Cancel everything.
    scheduler.cancelAll();

    // Resolve the in-flight probe AFTER cancelAll.
    resolvePick(makeFakeConn({ tools: [{ name: "x" }] }));
    await vi.advanceTimersByTimeAsync(0);

    // Resolution-time write observed destroyed=true; no second onUpdate.
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("cancelAll is idempotent (calling twice does not throw)", () => {
    const scheduler = createProbeScheduler({ onUpdate: vi.fn() });
    expect(() => {
      scheduler.cancelAll();
      scheduler.cancelAll();
    }).not.toThrow();
  });
});
