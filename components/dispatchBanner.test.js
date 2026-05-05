/**
 * components/dispatchBanner.test.js — coverage for the structural
 * dispatch-feedback banner from Plan 003 Unit C3 / D4.
 *
 * The banner triggers structurally — never via regex on natural-language
 * final text. Conditions (all four required for trigger):
 *   1. At least one tool call this turn was to a tool whose declared tags
 *      overlap {visualization, map, layer}.
 *   2. Engine envelope counts (visualizations + layerUpdates + patches)
 *      sum to zero.
 *   3. K5 — at least one renderable call did NOT return a domain-error
 *      envelope (those are surfaced by the rejected-patches path).
 *   4. K6 — the assistant emitted final text. Aborted / empty turns stay
 *      silent.
 */

import { describe, expect, it } from "vitest";

import { _buildDispatchBanner } from "./dispatchBanner.js";

const TAG_VIZ = ["visualization", "chart"];
const TAG_MAP = ["map", "layer", "geographic"];
const TAG_DATA_ONLY = ["discovery"];

function viz(toolName, hadDomainError = false) {
  return { toolName, hadDomainError };
}

const ASSISTANT_TEXT = "Here is the chart you requested.";

describe("_buildDispatchBanner — fires when renderable call dispatched nothing", () => {
  it("triggers when a 'visualization'-tagged call dispatched no envelope", () => {
    const banner = _buildDispatchBanner({
      toolCallsThisTurn: [viz("create_plotly_chart")],
      toolTagsByName: new Map([["create_plotly_chart", TAG_VIZ]]),
      visualizations: undefined,
      layerUpdates: undefined,
      patches: undefined,
      assistantText: ASSISTANT_TEXT,
    });
    expect(banner).toMatch(/dashboard received nothing/i);
  });

  it("triggers when a 'map'-tagged call dispatched no envelope", () => {
    const banner = _buildDispatchBanner({
      toolCallsThisTurn: [viz("create_map_visualization")],
      toolTagsByName: new Map([["create_map_visualization", TAG_MAP]]),
      visualizations: undefined,
      layerUpdates: undefined,
      patches: undefined,
      assistantText: ASSISTANT_TEXT,
    });
    expect(banner).toMatch(/dashboard received nothing/i);
  });

  it("triggers when at least one renderable call succeeded silently among mixed calls", () => {
    const banner = _buildDispatchBanner({
      toolCallsThisTurn: [
        viz("query_output_file"), // data-only, no renderable tag
        viz("create_plotly_chart"), // renderable, but envelope arrays empty
      ],
      toolTagsByName: new Map([
        ["query_output_file", TAG_DATA_ONLY],
        ["create_plotly_chart", TAG_VIZ],
      ]),
      visualizations: undefined,
      layerUpdates: undefined,
      patches: undefined,
      assistantText: ASSISTANT_TEXT,
    });
    expect(banner).toMatch(/dashboard received nothing/i);
  });
});

describe("_buildDispatchBanner — silent when work actually dispatched", () => {
  it("stays silent when a visualization envelope landed", () => {
    const banner = _buildDispatchBanner({
      toolCallsThisTurn: [viz("create_plotly_chart")],
      toolTagsByName: new Map([["create_plotly_chart", TAG_VIZ]]),
      visualizations: [{ uuid: "viz-A" }],
      layerUpdates: undefined,
      patches: undefined,
      assistantText: ASSISTANT_TEXT,
    });
    expect(banner).toBe("");
  });

  it("stays silent when a layer_update envelope landed (no 'visualization' tag needed)", () => {
    const banner = _buildDispatchBanner({
      toolCallsThisTurn: [viz("add_map_service_layer")],
      toolTagsByName: new Map([["add_map_service_layer", TAG_MAP]]),
      visualizations: undefined,
      layerUpdates: [{ uuid: "layer-A" }],
      patches: undefined,
      assistantText: ASSISTANT_TEXT,
    });
    expect(banner).toBe("");
  });

  it("stays silent when a patch_update envelope landed", () => {
    const banner = _buildDispatchBanner({
      toolCallsThisTurn: [viz("patch_visualization")],
      toolTagsByName: new Map([
        ["patch_visualization", ["visualization", "patch"]],
      ]),
      visualizations: undefined,
      layerUpdates: undefined,
      patches: [{ uuid: "patch-A" }],
      assistantText: ASSISTANT_TEXT,
    });
    expect(banner).toBe("");
  });
});

describe("_buildDispatchBanner — silent when no renderable tool was called", () => {
  it("stays silent when only data-only tools were called", () => {
    const banner = _buildDispatchBanner({
      toolCallsThisTurn: [
        viz("query_output_file"),
        viz("list_available_models"),
      ],
      toolTagsByName: new Map([
        ["query_output_file", TAG_DATA_ONLY],
        ["list_available_models", TAG_DATA_ONLY],
      ]),
      visualizations: undefined,
      layerUpdates: undefined,
      patches: undefined,
      assistantText: ASSISTANT_TEXT,
    });
    expect(banner).toBe("");
  });

  it("stays silent when no tools were called at all", () => {
    const banner = _buildDispatchBanner({
      toolCallsThisTurn: [],
      toolTagsByName: new Map(),
      visualizations: undefined,
      layerUpdates: undefined,
      patches: undefined,
      assistantText: ASSISTANT_TEXT,
    });
    expect(banner).toBe("");
  });
});

describe("_buildDispatchBanner — K5 domain-error suppression", () => {
  it("stays silent when the only renderable call returned a domain error", () => {
    // patch_visualization legitimately rejects patches with {error: ...};
    // the existing rejected-patches surface handles that UX. Banner must
    // not duplicate the warning.
    const banner = _buildDispatchBanner({
      toolCallsThisTurn: [viz("patch_visualization", true)],
      toolTagsByName: new Map([
        ["patch_visualization", ["visualization", "patch"]],
      ]),
      visualizations: undefined,
      layerUpdates: undefined,
      patches: undefined,
      assistantText: "I couldn't apply that patch.",
    });
    expect(banner).toBe("");
  });

  it("triggers when a renderable call errored AND another renderable call succeeded silently", () => {
    // K5 trigger: at least one non-error renderable call still warrants
    // the banner even when a sibling renderable call errored.
    const banner = _buildDispatchBanner({
      toolCallsThisTurn: [
        viz("patch_visualization", true), // domain error — handled elsewhere
        viz("create_plotly_chart", false), // silent failure — needs banner
      ],
      toolTagsByName: new Map([
        ["patch_visualization", ["visualization", "patch"]],
        ["create_plotly_chart", TAG_VIZ],
      ]),
      visualizations: undefined,
      layerUpdates: undefined,
      patches: undefined,
      assistantText: ASSISTANT_TEXT,
    });
    expect(banner).toMatch(/dashboard received nothing/i);
  });
});

describe("_buildDispatchBanner — K6 final-text gating", () => {
  it("stays silent on aborted turn (assistantText is empty)", () => {
    const banner = _buildDispatchBanner({
      toolCallsThisTurn: [viz("create_plotly_chart")],
      toolTagsByName: new Map([["create_plotly_chart", TAG_VIZ]]),
      visualizations: undefined,
      layerUpdates: undefined,
      patches: undefined,
      assistantText: "",
    });
    expect(banner).toBe("");
  });

  it("stays silent when assistantText is whitespace only", () => {
    const banner = _buildDispatchBanner({
      toolCallsThisTurn: [viz("create_plotly_chart")],
      toolTagsByName: new Map([["create_plotly_chart", TAG_VIZ]]),
      visualizations: undefined,
      layerUpdates: undefined,
      patches: undefined,
      assistantText: "   \n  ",
    });
    expect(banner).toBe("");
  });

  it("stays silent when assistantText is missing entirely (undefined)", () => {
    const banner = _buildDispatchBanner({
      toolCallsThisTurn: [viz("create_plotly_chart")],
      toolTagsByName: new Map([["create_plotly_chart", TAG_VIZ]]),
      visualizations: undefined,
      layerUpdates: undefined,
      patches: undefined,
      assistantText: undefined,
    });
    expect(banner).toBe("");
  });
});

describe("_buildDispatchBanner — defensive paths", () => {
  it("tolerates plain-object toolTagsByName instead of Map", () => {
    const banner = _buildDispatchBanner({
      toolCallsThisTurn: [viz("create_plotly_chart")],
      toolTagsByName: { create_plotly_chart: TAG_VIZ }, // plain object
      visualizations: undefined,
      layerUpdates: undefined,
      patches: undefined,
      assistantText: ASSISTANT_TEXT,
    });
    expect(banner).toMatch(/dashboard received nothing/i);
  });

  it("stays silent when toolTagsByName is missing (cannot classify)", () => {
    const banner = _buildDispatchBanner({
      toolCallsThisTurn: [viz("create_plotly_chart")],
      toolTagsByName: null,
      visualizations: undefined,
      layerUpdates: undefined,
      patches: undefined,
      assistantText: ASSISTANT_TEXT,
    });
    // Tags map missing → fail closed (no false-positive banners on
    // shape errors).
    expect(banner).toBe("");
  });

  it("stays silent when toolCallsThisTurn is missing (no history)", () => {
    const banner = _buildDispatchBanner({
      toolCallsThisTurn: undefined,
      toolTagsByName: new Map([["create_plotly_chart", TAG_VIZ]]),
      visualizations: undefined,
      layerUpdates: undefined,
      patches: undefined,
      assistantText: ASSISTANT_TEXT,
    });
    expect(banner).toBe("");
  });
});
