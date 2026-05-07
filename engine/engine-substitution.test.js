/**
 * engine/engine-substitution.test.js — coverage for the closed-vocabulary
 * `{{last_<type>_uuid}}` substitution layer (plan 2026-05-07-002 Unit B).
 *
 * Tracking: when a tool result includes `{visualization: {uuid, source}}`,
 * the engine derives a small type key from `source` (Map -> "map", Inline
 * Plotly -> "plot", etc.) and records `state.lastReturnedUuids[type] = uuid`.
 *
 * Substitution: before dispatching each tool call, the engine recursively
 * walks the parsed args object. Whole-string values exactly equal to one of
 * the 5 known placeholder forms — `{{last_map_uuid}}`, `{{last_plot_uuid}}`,
 * `{{last_table_uuid}}`, `{{last_card_uuid}}`, `{{last_variable_input_uuid}}`
 * — are replaced with the corresponding tracked UUID. Anything else (no
 * track, unknown placeholder, partial match, different syntax) passes
 * through unchanged so the server-side `_validate_uuid_arg` (Unit A) can
 * reject it with a structured error envelope.
 *
 * Tests drive `processToolCalls` directly and inspect the fake MCP client's
 * recorded call args to assert what the server actually received.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { processToolCalls } from "./index.js";
import { makeFakeClient } from "../test-helpers/fakeConn.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFreshState(overrides = {}) {
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
    lastReturnedUuids: {},
    ...overrides,
  };
}

function makeToolCall(name, args = {}, id = `call-${name}`) {
  return { id, function: { name, arguments: args } };
}

/**
 * Build a fake transport that captures every callTool invocation so tests
 * can assert what args were forwarded to the MCP server.
 */
function makeRecordingConnections(toolResultsByName) {
  const recorded = [];
  const callTool = vi.fn(async ({ name, arguments: args }) => {
    recorded.push({ name, args });
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
  return { connections, toolServerMap, recorded };
}

async function runOne(toolName, toolResult, args, state = null) {
  const { connections, toolServerMap, recorded } = makeRecordingConnections({
    [toolName]: toolResult,
  });
  const messages = [];
  await processToolCalls(
    [makeToolCall(toolName, args)],
    messages,
    connections,
    toolServerMap,
    state ?? makeFreshState(),
    "",
    {},
  );
  return { recorded, messages };
}

const MAP_UUID = "11111111-1111-4111-8111-111111111111";
const PLOT_UUID = "22222222-2222-4222-8222-222222222222";

// ---------------------------------------------------------------------------
// Tracking — state.lastReturnedUuids gets populated from tool results
// ---------------------------------------------------------------------------

describe("lastReturnedUuids tracking", () => {
  it("tracks a Map source by the 'map' key when create_map_visualization returns", async () => {
    const state = makeFreshState();
    const { recorded } = await runOne(
      "create_map_visualization",
      { visualization: { uuid: MAP_UUID, source: "Map" } },
      {},
      state,
    );
    expect(recorded.length).toBe(1);
    expect(state.lastReturnedUuids.map).toBe(MAP_UUID);
  });

  it("tracks an Inline Plotly source by the 'plot' key", async () => {
    const state = makeFreshState();
    await runOne(
      "create_plotly_chart",
      {
        visualization: {
          uuid: PLOT_UUID,
          source: "Inline Plotly",
          vizType: "plotly",
        },
      },
      {},
      state,
    );
    expect(state.lastReturnedUuids.plot).toBe(PLOT_UUID);
  });

  it("tracks an Inline Table source by the 'table' key", async () => {
    const state = makeFreshState();
    await runOne(
      "create_data_table",
      { visualization: { uuid: PLOT_UUID, source: "Inline Table" } },
      {},
      state,
    );
    expect(state.lastReturnedUuids.table).toBe(PLOT_UUID);
  });

  it("tracks an Inline Card source by the 'card' key", async () => {
    const state = makeFreshState();
    await runOne(
      "create_card",
      { visualization: { uuid: PLOT_UUID, source: "Inline Card" } },
      {},
      state,
    );
    expect(state.lastReturnedUuids.card).toBe(PLOT_UUID);
  });

  it("tracks a Variable Input source by the 'variable_input' key", async () => {
    const state = makeFreshState();
    await runOne(
      "create_variable_input",
      { visualization: { uuid: PLOT_UUID, source: "Variable Input" } },
      {},
      state,
    );
    expect(state.lastReturnedUuids.variable_input).toBe(PLOT_UUID);
  });

  it("does not track a visualization with no source", async () => {
    const state = makeFreshState();
    await runOne(
      "some_tool",
      { visualization: { uuid: MAP_UUID } },
      {},
      state,
    );
    expect(state.lastReturnedUuids).toEqual({});
  });

  it("does not track an unknown source string", async () => {
    const state = makeFreshState();
    await runOne(
      "some_tool",
      { visualization: { uuid: MAP_UUID, source: "Some Future Source" } },
      {},
      state,
    );
    expect(state.lastReturnedUuids).toEqual({});
  });

  it("does not track when uuid is missing", async () => {
    const state = makeFreshState();
    await runOne(
      "create_map_visualization",
      { visualization: { source: "Map" } },
      {},
      state,
    );
    expect(state.lastReturnedUuids.map).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Substitution — pre-dispatch placeholder rewriting
// ---------------------------------------------------------------------------

describe("{{last_<type>_uuid}} substitution", () => {
  it("substitutes the placeholder at a top-level string arg when the type is tracked", async () => {
    const state = makeFreshState({ lastReturnedUuids: { map: MAP_UUID } });
    const { recorded } = await runOne(
      "add_map_service_layer",
      { layer_update: { map_uuid: MAP_UUID, layer: {} } },
      { map_uuid: "{{last_map_uuid}}", name: "Layer A" },
      state,
    );
    expect(recorded[0].args.map_uuid).toBe(MAP_UUID);
    expect(recorded[0].args.name).toBe("Layer A"); // unchanged
  });

  it("substitutes inside a nested object", async () => {
    const state = makeFreshState({ lastReturnedUuids: { map: MAP_UUID } });
    const { recorded } = await runOne(
      "add_map_service_layer",
      { layer_update: { map_uuid: MAP_UUID, layer: {} } },
      { outer: { inner: { map_uuid: "{{last_map_uuid}}" } } },
      state,
    );
    expect(recorded[0].args.outer.inner.map_uuid).toBe(MAP_UUID);
  });

  it("substitutes inside an array element", async () => {
    const state = makeFreshState({ lastReturnedUuids: { map: MAP_UUID } });
    const { recorded } = await runOne(
      "some_tool",
      {},
      { ids: ["{{last_map_uuid}}", "static-id", "{{last_map_uuid}}"] },
      state,
    );
    expect(recorded[0].args.ids).toEqual([MAP_UUID, "static-id", MAP_UUID]);
  });

  it("leaves the placeholder unchanged when the type is not tracked", async () => {
    const state = makeFreshState({ lastReturnedUuids: {} }); // nothing tracked
    const { recorded } = await runOne(
      "add_map_service_layer",
      {},
      { map_uuid: "{{last_map_uuid}}" },
      state,
    );
    expect(recorded[0].args.map_uuid).toBe("{{last_map_uuid}}");
  });

  it("leaves an unknown placeholder shape unchanged", async () => {
    const state = makeFreshState({ lastReturnedUuids: { map: MAP_UUID } });
    const { recorded } = await runOne(
      "some_tool",
      {},
      { x: "{{previous_uuid}}", y: "{{step_2.uuid}}" },
      state,
    );
    expect(recorded[0].args.x).toBe("{{previous_uuid}}");
    expect(recorded[0].args.y).toBe("{{step_2.uuid}}");
  });

  it("leaves a different placeholder syntax unchanged", async () => {
    const state = makeFreshState({ lastReturnedUuids: { map: MAP_UUID } });
    const { recorded } = await runOne(
      "some_tool",
      {},
      { x: "${last_map_uuid}" },
      state,
    );
    expect(recorded[0].args.x).toBe("${last_map_uuid}");
  });

  it("does not substitute placeholders embedded inside larger strings", async () => {
    const state = makeFreshState({ lastReturnedUuids: { map: MAP_UUID } });
    const { recorded } = await runOne(
      "some_tool",
      {},
      { description: "Created from {{last_map_uuid}} earlier" },
      state,
    );
    expect(recorded[0].args.description).toBe(
      "Created from {{last_map_uuid}} earlier",
    );
  });

  it("leaves an explicit UUID unchanged", async () => {
    const state = makeFreshState({ lastReturnedUuids: { map: MAP_UUID } });
    const explicit = "33333333-3333-4333-8333-333333333333";
    const { recorded } = await runOne(
      "some_tool",
      {},
      { map_uuid: explicit },
      state,
    );
    expect(recorded[0].args.map_uuid).toBe(explicit);
  });

  it("substitutes per-type independently — {{last_plot_uuid}} uses the plot track", async () => {
    const state = makeFreshState({
      lastReturnedUuids: { map: MAP_UUID, plot: PLOT_UUID },
    });
    const { recorded } = await runOne(
      "some_tool",
      {},
      {
        map_uuid: "{{last_map_uuid}}",
        plot_uuid: "{{last_plot_uuid}}",
      },
      state,
    );
    expect(recorded[0].args.map_uuid).toBe(MAP_UUID);
    expect(recorded[0].args.plot_uuid).toBe(PLOT_UUID);
  });

  it("does not rewrite object keys that look like placeholders", async () => {
    const state = makeFreshState({ lastReturnedUuids: { map: MAP_UUID } });
    const { recorded } = await runOne(
      "some_tool",
      {},
      { "{{last_map_uuid}}": "value" },
      state,
    );
    expect(Object.keys(recorded[0].args)).toContain("{{last_map_uuid}}");
    expect(recorded[0].args["{{last_map_uuid}}"]).toBe("value");
  });

  it("does not modify non-string values that happen to coincide", async () => {
    // Sanity check: numbers, booleans, and zero pass through. (Note: the
    // MCP client's `omitEmptyArgs` strips `null` values pre-dispatch
    // independent of substitution, so `null` is intentionally not asserted
    // here.)
    const state = makeFreshState({ lastReturnedUuids: { map: MAP_UUID } });
    const { recorded } = await runOne(
      "some_tool",
      {},
      { count: 42, flag: true, zero: 0 },
      state,
    );
    expect(recorded[0].args.count).toBe(42);
    expect(recorded[0].args.flag).toBe(true);
    expect(recorded[0].args.zero).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Track-then-substitute integration — single processToolCalls call covers
// only one tool, but the tracking state carries forward to the next call
// in the same session via the shared state object.
// ---------------------------------------------------------------------------

describe("track-then-substitute integration", () => {
  it("a Map created in one call is referenced by {{last_map_uuid}} in the next", async () => {
    // Single state shared across two processToolCalls — the production
    // invariant that lastReturnedUuids has session lifetime, not per-turn.
    const state = makeFreshState();
    // First call: create_map_visualization.
    const create = makeRecordingConnections({
      create_map_visualization: {
        visualization: { uuid: MAP_UUID, source: "Map" },
      },
    });
    await processToolCalls(
      [makeToolCall("create_map_visualization", {})],
      [],
      create.connections,
      create.toolServerMap,
      state,
      "",
      {},
    );
    expect(state.lastReturnedUuids.map).toBe(MAP_UUID);
    // Second call: add_map_service_layer with a placeholder.
    const add = makeRecordingConnections({
      add_map_service_layer: {
        layer_update: { map_uuid: MAP_UUID, layer: {} },
      },
    });
    await processToolCalls(
      [
        makeToolCall("add_map_service_layer", {
          map_uuid: "{{last_map_uuid}}",
        }),
      ],
      [],
      add.connections,
      add.toolServerMap,
      state,
      "",
      {},
    );
    expect(add.recorded[0].args.map_uuid).toBe(MAP_UUID);
  });
});
