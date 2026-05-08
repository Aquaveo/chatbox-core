import { describe, it, expect } from "vitest";
import { humanizeToolName, statusToLabel } from "./toolStatusCopy.js";

describe("humanizeToolName", () => {
  it("inflects known verbs to gerund", () => {
    expect(humanizeToolName("add_wms_layer")).toBe("Adding wms layer");
    expect(humanizeToolName("create_widget")).toBe("Creating widget");
    expect(humanizeToolName("delete_thing")).toBe("Deleting thing");
    expect(humanizeToolName("update_record")).toBe("Updating record");
  });

  it("capitalizes first word when verb is unknown", () => {
    expect(humanizeToolName("frob_quux")).toBe("Frob quux");
    expect(humanizeToolName("foo")).toBe("Foo");
  });

  it("tolerates camelCase tool names", () => {
    expect(humanizeToolName("createWidget")).toBe("Creating widget");
    expect(humanizeToolName("deleteThing")).toBe("Deleting thing");
  });

  it("falls back to 'Working' on empty / non-string input", () => {
    expect(humanizeToolName("")).toBe("Working");
    expect(humanizeToolName(null)).toBe("Working");
    expect(humanizeToolName(undefined)).toBe("Working");
    expect(humanizeToolName(42)).toBe("Working");
  });
});

describe("statusToLabel — known TethysDash tools", () => {
  it("renders create_* start phrases", () => {
    expect(statusToLabel({ type: "tool_start", toolName: "create_plotly_chart" }))
      .toBe("Creating chart...");
    expect(statusToLabel({ type: "tool_start", toolName: "create_map_visualization" }))
      .toBe("Creating map...");
    expect(statusToLabel({ type: "tool_start", toolName: "create_data_table" }))
      .toBe("Creating table...");
  });

  it("renders create_* completion phrases", () => {
    expect(statusToLabel({ type: "tool_complete", toolName: "create_plotly_chart", success: true }))
      .toBe("Chart created");
    expect(statusToLabel({ type: "tool_complete", toolName: "create_map_visualization", success: true }))
      .toBe("Map created");
  });

  it("renders add_*_layer phrases for the per-source-type layer tools", () => {
    expect(statusToLabel({ type: "tool_start", toolName: "add_wms_layer" }))
      .toBe("Adding WMS layer...");
    expect(statusToLabel({ type: "tool_complete", toolName: "add_wms_layer", success: true }))
      .toBe("WMS layer added");
    expect(statusToLabel({ type: "tool_start", toolName: "add_geotiff_layer" }))
      .toBe("Adding GeoTIFF layer...");
    expect(statusToLabel({ type: "tool_complete", toolName: "add_geotiff_layer", success: true }))
      .toBe("GeoTIFF layer added");
  });

  it("renders patch_visualization phrases", () => {
    expect(statusToLabel({ type: "tool_start", toolName: "patch_visualization" }))
      .toBe("Updating visualization...");
    expect(statusToLabel({ type: "tool_complete", toolName: "patch_visualization", success: true }))
      .toBe("Visualization updated");
  });
});

describe("statusToLabel — failure path", () => {
  it("prefixes 'Failed:' on tool_complete with success: false", () => {
    expect(statusToLabel({ type: "tool_complete", toolName: "create_plotly_chart", success: false }))
      .toBe("Failed: creating chart");
    expect(statusToLabel({ type: "tool_complete", toolName: "add_wms_layer", success: false }))
      .toBe("Failed: adding wms layer");
  });

  it("'Failed:' uses humanized fallback for unknown tools", () => {
    expect(statusToLabel({ type: "tool_complete", toolName: "create_widget", success: false }))
      .toBe("Failed: creating widget");
  });
});

describe("statusToLabel — suppressed entries", () => {
  it("returns null for tools with start: null", () => {
    expect(statusToLabel({ type: "tool_start", toolName: "call_tool" })).toBeNull();
  });

  it("returns null for tools with done: null on success", () => {
    expect(statusToLabel({ type: "tool_complete", toolName: "list_intake_plugins", success: true }))
      .toBeNull();
    expect(statusToLabel({ type: "tool_complete", toolName: "search_tools", success: true }))
      .toBeNull();
    expect(statusToLabel({ type: "tool_complete", toolName: "call_tool", success: true }))
      .toBeNull();
  });

  it("BUT renders a Failed message even when 'done' is suppressed", () => {
    // Failures are user-meaningful even for indirection tools.
    expect(statusToLabel({ type: "tool_complete", toolName: "search_tools", success: false }))
      .toBe("Failed: looking up tools");
  });
});

describe("statusToLabel — unknown tools (humanized fallback)", () => {
  it("renders unknown tool start with humanized phrase", () => {
    expect(statusToLabel({ type: "tool_start", toolName: "create_widget" }))
      .toBe("Creating widget...");
    expect(statusToLabel({ type: "tool_start", toolName: "frob_quux" }))
      .toBe("Frob quux...");
  });

  it("renders unknown tool complete with humanized + ' done' suffix", () => {
    expect(statusToLabel({ type: "tool_complete", toolName: "create_widget", success: true }))
      .toBe("Creating widget done");
  });
});

describe("statusToLabel — input validation", () => {
  it("returns null for invalid / empty status", () => {
    expect(statusToLabel(null)).toBeNull();
    expect(statusToLabel(undefined)).toBeNull();
    expect(statusToLabel("calling_tools")).toBeNull(); // legacy string shape
    expect(statusToLabel({})).toBeNull();
    expect(statusToLabel({ type: "unknown_type", toolName: "foo" })).toBeNull();
  });
});
