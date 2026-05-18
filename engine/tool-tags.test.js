/**
 * engine/tool-tags.test.js — coverage for tool-tag capture + per-turn
 * tool-call history (Plan 003 Unit A1).
 *
 * Two related concerns sharing one fixture surface:
 *
 *   1. `toolTagsByName` (built during `connectMcpServers`): a session-
 *      scoped `Map<toolName, string[]>` populated from each MCP tool's
 *      `tags` field on `tools/list`. First-wins on tool-name collision
 *      across servers (mirrors the existing `toolServerMap` semantics).
 *
 *   2. `state.toolCallsThisTurn` (built inside `processToolCalls`): a
 *      per-turn `Array<{toolName, hadDomainError}>` populated as each
 *      tool runs. `hadDomainError` is true iff the tool result is an
 *      object with `typeof result.error === "string"`. Used by the host
 *      UI banner-trigger evaluation (Plan 003 K14).
 *
 * Both surfaces are additive — no engine behavior changes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectMcpServers, processToolCalls } from "./index.js";
import { makeFakeClient } from "../test-helpers/fakeConn.js";

// ---------------------------------------------------------------------------
// Stub the MCP transport so connectMcpServers doesn't try to talk to a
// real server. The transport module is dynamically import-cached inside
// engine/transports.js, so a vi.mock at the top intercepts it cleanly.
// ---------------------------------------------------------------------------

vi.mock("./transports.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    pickTransportWithRetry: vi.fn(),
    closeMcpConnection: vi.fn().mockResolvedValue(undefined),
  };
});

import { pickTransportWithRetry } from "./transports.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    toolCallsThisTurn: [],
  };
}

function makeToolCall(name, args = {}, id = `call-${name}`) {
  return { id, function: { name, arguments: args } };
}

function makeFakeServerWithTools(tools) {
  const client = makeFakeClient({ tools });
  return { client, transport: { close: vi.fn() }, protocolUsed: "http" };
}

// ---------------------------------------------------------------------------
// Suppress the engine's `console.warn(...)` in collision tests — assertions
// inspect the spy directly.
// ---------------------------------------------------------------------------

let warnSpy;
beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  pickTransportWithRetry.mockReset();
});
afterEach(() => {
  warnSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Unit A1.1 — toolTagsByName: tool-tag capture during projection
// ---------------------------------------------------------------------------

describe("toolTagsByName — tag capture during connectMcpServers", () => {
  it("captures tags from a single tool with a populated tags array", async () => {
    pickTransportWithRetry.mockResolvedValueOnce(
      makeFakeServerWithTools([
        {
          name: "create_plotly_chart",
          description: "Render a chart.",
          inputSchema: { type: "object" },
          tags: ["visualization", "chart"],
        },
      ]),
    );

    const result = await connectMcpServers([{ url: "http://x", name: "S" }]);

    expect(result.toolTagsByName).toBeInstanceOf(Map);
    expect(result.toolTagsByName.get("create_plotly_chart")).toEqual([
      "visualization",
      "chart",
    ]);
  });

  it("stores [] for a tool registered without a tags field", async () => {
    pickTransportWithRetry.mockResolvedValueOnce(
      makeFakeServerWithTools([
        {
          name: "data_only_tool",
          description: "Returns rows.",
          inputSchema: { type: "object" },
          // no `tags`
        },
      ]),
    );

    const result = await connectMcpServers([{ url: "http://x", name: "S" }]);

    expect(result.toolTagsByName.get("data_only_tool")).toEqual([]);
  });

  it("first-wins when two servers expose the same tool name with different tags", async () => {
    pickTransportWithRetry
      .mockResolvedValueOnce(
        makeFakeServerWithTools([
          {
            name: "duplicate_tool",
            description: "First server.",
            inputSchema: { type: "object" },
            tags: ["visualization"],
          },
        ]),
      )
      .mockResolvedValueOnce(
        makeFakeServerWithTools([
          {
            name: "duplicate_tool",
            description: "Second server.",
            inputSchema: { type: "object" },
            tags: ["map", "layer"],
          },
        ]),
      );

    const result = await connectMcpServers([
      { url: "http://a", name: "A" },
      { url: "http://b", name: "B" },
    ]);

    // First server wins — second server's tags discarded.
    expect(result.toolTagsByName.get("duplicate_tool")).toEqual([
      "visualization",
    ]);
    // Existing duplicate-name console.warn still fires (one for the
    // toolServerMap collision; the toolTagsByName guard does not emit a
    // separate warn so the user-facing surface stays single-voiced).
    expect(warnSpy).toHaveBeenCalled();
  });

  it("returns an empty Map when no servers expose any tools", async () => {
    pickTransportWithRetry.mockResolvedValueOnce(makeFakeServerWithTools([]));

    const result = await connectMcpServers([{ url: "http://x", name: "S" }]);

    expect(result.toolTagsByName).toBeInstanceOf(Map);
    expect(result.toolTagsByName.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unit A1.2 — state.toolCallsThisTurn: per-turn tool-call history
// ---------------------------------------------------------------------------

describe("state.toolCallsThisTurn — per-turn tool-call history (K14)", () => {
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

  it("appends one entry per tool call in tool-call order, hadDomainError=false on success", async () => {
    const { connections, toolServerMap } = makeConnections({
      create_plotly_chart: { visualization: { uuid: "abc", source: "s", vizType: "chart" } },
      query_output_file_from_output_selector: { rows: [{ a: 1 }] },
    });
    const state = makeFreshState();

    await processToolCalls(
      [
        makeToolCall("create_plotly_chart"),
        makeToolCall("query_output_file_from_output_selector"),
      ],
      [],
      connections,
      toolServerMap,
      state,
      "",
      {},
    );

    expect(state.toolCallsThisTurn).toEqual([
      { toolName: "create_plotly_chart", hadDomainError: false },
      { toolName: "query_output_file_from_output_selector", hadDomainError: false },
    ]);
  });

  it("flags hadDomainError=true when result is {error: <string>}", async () => {
    const { connections, toolServerMap } = makeConnections({
      patch_visualization: { error: "rejected" },
    });
    const state = makeFreshState();

    await processToolCalls(
      [makeToolCall("patch_visualization")],
      [],
      connections,
      toolServerMap,
      state,
      "",
      {},
    );

    expect(state.toolCallsThisTurn).toEqual([
      { toolName: "patch_visualization", hadDomainError: true },
    ]);
  });

  it("leaves toolCallsThisTurn empty when no tools are called", async () => {
    const state = makeFreshState();
    const { connections, toolServerMap } = makeConnections({});

    await processToolCalls([], [], connections, toolServerMap, state, "", {});

    expect(state.toolCallsThisTurn).toEqual([]);
  });

  it("does not leak entries across consecutive turns when caller resets between turns", async () => {
    // Engine spec: caller (runChatSession) resets state.toolCallsThisTurn
    // at the start of every turn iteration. This test pins the contract
    // that processToolCalls *only appends* — it never reads or relies on
    // pre-existing entries — so reset-to-[] before each call is the
    // correct mental model.
    const { connections, toolServerMap } = makeConnections({
      tool_a: { ok: true },
      tool_b: { ok: true },
    });
    const state = makeFreshState();

    // Turn 1
    await processToolCalls(
      [makeToolCall("tool_a")],
      [],
      connections,
      toolServerMap,
      state,
      "",
      {},
    );
    expect(state.toolCallsThisTurn).toEqual([
      { toolName: "tool_a", hadDomainError: false },
    ]);

    // Turn 2: caller resets, then dispatches the next batch.
    state.toolCallsThisTurn = [];
    await processToolCalls(
      [makeToolCall("tool_b")],
      [],
      connections,
      toolServerMap,
      state,
      "",
      {},
    );
    expect(state.toolCallsThisTurn).toEqual([
      { toolName: "tool_b", hadDomainError: false },
    ]);
  });
});
