/**
 * engine/afterToolExecution.test.js — call-site wiring coverage for the
 * `afterToolExecution` hook in `processToolCalls`.
 *
 * Plan 20 parked follow-up #11 / Plan 26-001 follow-up. The pure
 * `buildDeltaSummary` helper is covered separately; this file proves
 * the hook itself fires once per tool call, in tool-call order, with
 * the right (toolName, args, toolResult, state, messages) — and that
 * hook errors are caught at the call site without breaking the loop.
 *
 * Tests drive `processToolCalls` directly (exported from engine/index.js
 * for this purpose) rather than the full `runChatSession`. This keeps
 * the test surface small and fixture-free — the wiring under test
 * lives entirely inside `processToolCalls`, so an end-to-end LLM stub
 * would be expensive without buying additional coverage.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { processToolCalls } from "./index.js";
import { makeFakeClient } from "../test-helpers/fakeConn.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeToolCall(name, args = {}, id = `call-${name}`) {
  return { id, function: { name, arguments: args } };
}

function makeFreshState() {
  return {
    lastChartResult: null,
    lastQueryResult: null,
    lastQuerySQL: null,
    lastListResult: null,
    lastMapResult: null,
    lastHydrofabricResult: null,
    pendingVisualizations: [],
    pendingLayerUpdates: [],
    pendingPatches: [],
    rejectedPatches: [],
  };
}

function makeConnections(toolResultsByName) {
  const callTool = vi.fn(async ({ name }) => {
    const result = toolResultsByName[name];
    if (result === undefined) {
      throw new Error(`Test fixture missing result for tool: ${name}`);
    }
    return { data: result };
  });
  const client = makeFakeClient({ callToolImpl: callTool });
  const connections = [{ client, transport: null, protocolUsed: "http" }];
  const toolServerMap = new Map(
    Object.keys(toolResultsByName).map((name) => [name, 0]),
  );
  return { connections, toolServerMap };
}

// ---------------------------------------------------------------------------
// Suppress the engine's `console.warn("afterToolExecution hook threw:", ...)`
// in error-path tests — assertions inspect the spy directly.
// ---------------------------------------------------------------------------

let warnSpy;
beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe("afterToolExecution wiring — happy paths", () => {
  it("fires once per single tool call with (name, args, result, state, messages)", async () => {
    const afterToolExecution = vi.fn();
    const { connections, toolServerMap } = makeConnections({
      foo: { ok: true, value: 42 },
    });
    const messages = [{ role: "user", content: "hi" }];
    const state = makeFreshState();

    await processToolCalls(
      [makeToolCall("foo", { a: 1 })],
      messages,
      connections,
      toolServerMap,
      state,
      "hi",
      { afterToolExecution },
    );

    expect(afterToolExecution).toHaveBeenCalledTimes(1);
    const [name, args, result, passedState, passedMessages] =
      afterToolExecution.mock.calls[0];
    expect(name).toBe("foo");
    expect(args).toEqual({ a: 1 });
    expect(result).toEqual({ ok: true, value: 42 });
    expect(passedState).toBe(state);
    expect(passedMessages).toBe(messages);
  });

  it("fires once per tool call in tool-call order on multi-tool turns", async () => {
    const afterToolExecution = vi.fn();
    const { connections, toolServerMap } = makeConnections({
      first: { v: 1 },
      second: { v: 2 },
      third: { v: 3 },
    });

    await processToolCalls(
      [
        makeToolCall("first", { i: 0 }),
        makeToolCall("second", { i: 1 }),
        makeToolCall("third", { i: 2 }),
      ],
      [],
      connections,
      toolServerMap,
      makeFreshState(),
      "",
      { afterToolExecution },
    );

    expect(afterToolExecution).toHaveBeenCalledTimes(3);
    expect(afterToolExecution.mock.calls.map((c) => c[0])).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("does not fire when toolCalls is empty (zero tool turn)", async () => {
    const afterToolExecution = vi.fn();
    const { connections, toolServerMap } = makeConnections({});

    await processToolCalls(
      [],
      [],
      connections,
      toolServerMap,
      makeFreshState(),
      "",
      { afterToolExecution },
    );

    expect(afterToolExecution).not.toHaveBeenCalled();
  });

  it("receives the post-result message array (the tool_result is already pushed)", async () => {
    const afterToolExecution = vi.fn(async (_name, _args, _result, _state, messages) => {
      // Snapshot at hook time — engine pushes `role: "tool"` *before*
      // invoking the hook. Assertion lives inside the hook so the array
      // mutation can be observed directly.
      expect(messages.at(-1)).toMatchObject({
        role: "tool",
        tool_name: "foo",
      });
    });
    const { connections, toolServerMap } = makeConnections({
      foo: { greeting: "hello" },
    });

    await processToolCalls(
      [makeToolCall("foo")],
      [],
      connections,
      toolServerMap,
      makeFreshState(),
      "",
      { afterToolExecution },
    );

    expect(afterToolExecution).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe("afterToolExecution wiring — error paths", () => {
  it("swallows synchronous hook throws and continues to subsequent tool calls", async () => {
    const afterToolExecution = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("boom (sync)");
      })
      .mockImplementationOnce(() => {});
    const { connections, toolServerMap } = makeConnections({
      first: { v: 1 },
      second: { v: 2 },
    });

    await expect(
      processToolCalls(
        [makeToolCall("first"), makeToolCall("second")],
        [],
        connections,
        toolServerMap,
        makeFreshState(),
        "",
        { afterToolExecution },
      ),
    ).resolves.toBeDefined();

    expect(afterToolExecution).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      "afterToolExecution hook threw:",
      expect.any(Error),
    );
  });

  it("swallows asynchronous hook rejections and continues", async () => {
    const afterToolExecution = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error("boom (async)");
      })
      .mockImplementationOnce(async () => {});
    const { connections, toolServerMap } = makeConnections({
      first: { v: 1 },
      second: { v: 2 },
    });

    await processToolCalls(
      [makeToolCall("first"), makeToolCall("second")],
      [],
      connections,
      toolServerMap,
      makeFreshState(),
      "",
      { afterToolExecution },
    );

    expect(afterToolExecution).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Defensive paths
// ---------------------------------------------------------------------------

describe("afterToolExecution wiring — defensive paths", () => {
  it("does not throw when afterToolExecution is null", async () => {
    const { connections, toolServerMap } = makeConnections({ foo: { v: 1 } });

    await expect(
      processToolCalls(
        [makeToolCall("foo")],
        [],
        connections,
        toolServerMap,
        makeFreshState(),
        "",
        { afterToolExecution: null },
      ),
    ).resolves.toBeDefined();
  });

  it("does not throw when afterToolExecution is undefined (key absent)", async () => {
    const { connections, toolServerMap } = makeConnections({ foo: { v: 1 } });

    await expect(
      processToolCalls(
        [makeToolCall("foo")],
        [],
        connections,
        toolServerMap,
        makeFreshState(),
        "",
        {},
      ),
    ).resolves.toBeDefined();
  });
});
