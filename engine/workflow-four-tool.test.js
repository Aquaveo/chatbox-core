/**
 * engine/workflow-four-tool.test.js — engine multi-tool ordering test for
 * the canonical TethysDash dashboard-creation workflow.
 *
 * Plan: docs/plans/2026-05-05-001-fix-esri-layers-directive-parsing-plan.md
 * (Unit 6).
 *
 * Workflow being exercised: a chatbox prompt that produces four tool calls in
 * sequence — `create_variable_input` → `create_map_visualization` →
 * `add_map_service_layer` → `render_plugin`. Three calls produce visualization
 * envelopes, one produces a layer update.
 *
 * Workflow-unique assertions only — single-tool properties (canonicalization
 * correctness, args passthrough) are owned by the per-tool unit tests
 * (test_layer_contracts.py and engine-dispatched.test.js). This file pins:
 *
 *  - Envelope partition: 3 entries in pendingVisualizations + 1 in
 *    pendingLayerUpdates (the engine's 3+1 split for this turn shape).
 *  - Envelope ordering: pendingVisualizations preserves the order the LLM
 *    emitted (variable_input first, render_plugin last). Order matters
 *    downstream because `${gaugeID}` substitution in the rendered tile
 *    depends on the variable_input being initialized before the dependent
 *    plugin's first fetch.
 *  - Orphan layer update behavior: a layer_update envelope whose map_uuid
 *    does not match any pendingVisualizations entry within the same turn
 *    still lands in pendingLayerUpdates (today's behavior; downstream merge
 *    in Chatbox.jsx is responsible for handling the orphan).
 *
 * Tests drive `processToolCalls` directly with `makeFakeClient` from
 * `test-helpers/fakeConn.js` — same precedent as `engine-dispatched.test.js`
 * and `afterToolExecution.test.js:11-15`. No `runChatSession`, no LLM stub,
 * no Playwright harness.
 */

import { describe, expect, it, vi } from "vitest";

import { processToolCalls } from "./index.js";
import { makeFakeClient } from "../test-helpers/fakeConn.js";

const MAP_UUID = "map-uuid-A";
const VAR_UUID = "var-uuid-A";
const PLUGIN_UUID = "plugin-uuid-A";

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

// Canonical four-tool sequence the workflow produces. Envelope shapes mirror
// what `tethysapp/tethysdash/mcp/tethysdash_mcp_server.py` emits for each tool
// — variable_input/map_visualization/render_plugin are visualization envelopes;
// add_map_service_layer is a layer_update envelope.
function makeFourToolFixtures() {
  return {
    create_variable_input: {
      visualization: {
        source: "Variable Input",
        vizType: "variable_input",
        uuid: VAR_UUID,
        args: {
          variable_name: "gaugeID",
          initial_value: "OWGI3",
          variable_type: "text",
        },
        w: 100,
        h: 8,
      },
    },
    create_map_visualization: {
      visualization: {
        source: "Map",
        vizType: "map",
        uuid: MAP_UUID,
        args: {
          baseMap: "satellite",
          viewConfig: { center: [-119.4179, 36.7783], zoom: 6 },
          layers: [],
        },
        w: 50,
        h: 25,
      },
    },
    add_map_service_layer: {
      layer_update: {
        map_uuid: MAP_UUID,
        layer: {
          configuration: {
            type: "ImageLayer",
            props: {
              name: "NOAA river gauges",
              source: {
                type: "ESRI Image and Map Service",
                props: {
                  // Matches what the MCP server emits for layer_id="0" after
                  // post-overlay canonicalization (plan Unit 5). The fixture is
                  // canned — this engine test does NOT exercise the Python
                  // canonicalization path, it just consumes the envelope shape.
                  // Canonicalization correctness is owned by Unit 5's pytest
                  // (test_layer_contracts.py).
                  url: "https://mapservices.weather.noaa.gov/eventdriven/rest/services/water/riv_gauges/MapServer",
                  params: { LAYERS: "show:0" },
                },
              },
            },
          },
          queryable: true,
          attributeVariables: { "NOAA river gauges": { gaugelid: "gaugeID" } },
        },
      },
    },
    render_plugin: {
      visualization: {
        source: "nwmp_gauges_series",
        vizType: "intake_plugin",
        uuid: PLUGIN_UUID,
        // The render_plugin's args.id is the variable-substitution string the
        // LLM emitted. The engine must preserve this verbatim — no
        // transformation, no stripping. Asserted below.
        args: { id: "${gaugeID}" },
        w: 50,
        h: 25,
      },
    },
  };
}

describe("workflow four-tool sequence — engine ordering", () => {
  it("partitions envelopes 3:1 across pendingVisualizations and pendingLayerUpdates", async () => {
    const fixtures = makeFourToolFixtures();
    const { connections, toolServerMap } = makeConnections(fixtures);
    const state = makeFreshState();
    const messages = [];

    await processToolCalls(
      [
        makeToolCall("create_variable_input"),
        makeToolCall("create_map_visualization"),
        makeToolCall("add_map_service_layer"),
        makeToolCall("render_plugin"),
      ],
      messages,
      connections,
      toolServerMap,
      state,
      "",
      {},
    );

    expect(state.pendingVisualizations).toHaveLength(3);
    expect(state.pendingLayerUpdates).toHaveLength(1);
    expect(state.pendingPatches).toHaveLength(0);
  });

  it("preserves the order of pendingVisualizations to match the LLM tool-call order", async () => {
    // Order matters downstream: `${gaugeID}` substitution in the rendered
    // plugin tile depends on the variable_input being initialized first.
    const fixtures = makeFourToolFixtures();
    const { connections, toolServerMap } = makeConnections(fixtures);
    const state = makeFreshState();
    const messages = [];

    await processToolCalls(
      [
        makeToolCall("create_variable_input"),
        makeToolCall("create_map_visualization"),
        makeToolCall("add_map_service_layer"),
        makeToolCall("render_plugin"),
      ],
      messages,
      connections,
      toolServerMap,
      state,
      "",
      {},
    );

    expect(state.pendingVisualizations[0].uuid).toBe(VAR_UUID);
    expect(state.pendingVisualizations[1].uuid).toBe(MAP_UUID);
    expect(state.pendingVisualizations[2].uuid).toBe(PLUGIN_UUID);

    // Engine pass-through: render_plugin's args.id is preserved verbatim from
    // the fake-tool-call input. No engine-level transformation of the
    // variable-substitution string. If a future engine refactor transforms or
    // strips args contents (e.g., a regex-based "corruption repair" pass),
    // this assertion catches it.
    expect(state.pendingVisualizations[2].args.id).toBe("${gaugeID}");
  });

  it("captures the layer-update envelope's map_uuid pointing at the just-created map", async () => {
    const fixtures = makeFourToolFixtures();
    const { connections, toolServerMap } = makeConnections(fixtures);
    const state = makeFreshState();
    const messages = [];

    await processToolCalls(
      [
        makeToolCall("create_variable_input"),
        makeToolCall("create_map_visualization"),
        makeToolCall("add_map_service_layer"),
        makeToolCall("render_plugin"),
      ],
      messages,
      connections,
      toolServerMap,
      state,
      "",
      {},
    );

    expect(state.pendingLayerUpdates[0].map_uuid).toBe(MAP_UUID);
  });
});

describe("workflow four-tool sequence — orphan layer-update behavior", () => {
  it("preserves orphan layer-update in pendingLayerUpdates when no matching map_uuid in this turn", async () => {
    // Orphan scenario: only add_map_service_layer fires (perhaps from a
    // patch-style turn referencing a pre-existing dashboard map). The
    // engine still appends to pendingLayerUpdates regardless of whether
    // any sibling pendingVisualizations entry has the same uuid. Downstream
    // merge in Chatbox.jsx is responsible for handling the orphan case
    // — this test pins today's engine-layer behavior so a refactor that
    // tries to filter orphans out doesn't silently break that handoff.
    const fixtures = makeFourToolFixtures();
    const { connections, toolServerMap } = makeConnections({
      add_map_service_layer: fixtures.add_map_service_layer,
    });
    const state = makeFreshState();
    const messages = [];

    await processToolCalls(
      [makeToolCall("add_map_service_layer")],
      messages,
      connections,
      toolServerMap,
      state,
      "",
      {},
    );

    expect(state.pendingVisualizations).toHaveLength(0);
    expect(state.pendingLayerUpdates).toHaveLength(1);
    expect(state.pendingLayerUpdates[0].map_uuid).toBe(MAP_UUID);
  });
});
