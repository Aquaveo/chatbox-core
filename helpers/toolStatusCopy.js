/**
 * toolStatusCopy.js — friendly UI text for MCP tool names.
 *
 * Used by the chatbox progress indicator (LiveActivity) to translate raw
 * MCP tool names into human-readable status messages:
 *
 *   tool_start     → start phrase  ("Creating map...")
 *   tool_complete  → complete phrase ("Map created")
 *
 * Plan: docs/plans/2026-05-08-003-feat-streaming-chatbox-progress-status-plan.md
 *
 * Mapping seeds cover the 10 always-visible TethysDash tools and the 11
 * BM25-searchable per-source-type layer tools (T3, plan 2026-05-07-007).
 * Unknown tools fall back to a humanized form of the tool name so we
 * degrade gracefully when a tool is added without updating this file.
 */

// Source of truth: { toolName: { start: "…", done: "…" } }
//
// `start` and `done` are full sentences (no trailing ellipsis on `start` —
// the renderer adds "..." as part of the activity-strip styling). `done`
// is past-tense to match how the user reads it ("Map created").
const COPY = {
  // Always-visible TethysDash tools (per BM25SearchTransform.always_visible)
  create_plotly_chart:           { start: "Creating chart",         done: "Chart created" },
  create_data_table:             { start: "Creating table",         done: "Table created" },
  create_variable_input:         { start: "Creating input",         done: "Input created" },
  create_map_visualization:      { start: "Creating map",           done: "Map created" },
  add_dynamic_map_layer:         { start: "Adding layer",           done: "Layer added" },
  patch_visualization:           { start: "Updating visualization", done: "Visualization updated" },
  render_plugin:                 { start: "Rendering plugin",       done: "Plugin rendered" },
  render_custom_visualization:   { start: "Rendering plugin",       done: "Plugin rendered" },
  list_available_visualizations: { start: "Looking up types",       done: null },
  list_intake_plugins:           { start: "Looking up plugins",     done: null },

  // BM25 indirection — internal tool calls; show start phrase but suppress
  // the "done" message because the user-meaningful work is whatever tool
  // gets called next.
  search_tools:                  { start: "Looking up tools",       done: null },
  call_tool:                     { start: null,                     done: null },

  // Per-source-type layer tools (plan 2026-05-07-007, T3 split)
  add_wms_layer:                 { start: "Adding WMS layer",        done: "WMS layer added" },
  add_esri_image_layer:          { start: "Adding ESRI image layer", done: "ESRI image layer added" },
  add_esri_feature_layer:        { start: "Adding ESRI feature layer", done: "ESRI feature layer added" },
  add_geojson_layer:             { start: "Adding GeoJSON layer",    done: "GeoJSON layer added" },
  add_kml_layer:                 { start: "Adding KML layer",        done: "KML layer added" },
  add_image_tile_layer:          { start: "Adding image tile layer", done: "Image tile layer added" },
  add_vector_tile_layer:         { start: "Adding vector tile layer", done: "Vector tile layer added" },
  add_pmtiles_vector_layer:      { start: "Adding PMTiles vector layer", done: "PMTiles vector layer added" },
  add_pmtiles_raster_layer:      { start: "Adding PMTiles raster layer", done: "PMTiles raster layer added" },
  add_geotiff_layer:             { start: "Adding GeoTIFF layer",    done: "GeoTIFF layer added" },
  add_static_image_layer:        { start: "Adding static image layer", done: "Static image layer added" },
};

/**
 * Humanize an unknown tool name as a graceful fallback.
 *
 *   "add_some_unknown_layer"  →  "Adding some unknown layer"
 *   "create_widget"           →  "Creating widget"
 *   "frob_quux"               →  "Frob quux"
 *   "deleteThing"             →  "Delete thing"  (camelCase tolerated)
 *
 * Pattern: if the first underscore-separated word starts with a known verb
 * prefix (create/add/delete/etc.), inflect to gerund. Otherwise leave as
 * a sentence with the first letter capitalized.
 */
const VERB_INFLECTIONS = {
  create: "Creating",
  add:    "Adding",
  delete: "Deleting",
  remove: "Removing",
  update: "Updating",
  list:   "Listing",
  search: "Searching",
  render: "Rendering",
  patch:  "Updating",
  call:   "Calling",
  fetch:  "Fetching",
  get:    "Getting",
};

export function humanizeToolName(toolName) {
  if (typeof toolName !== "string" || !toolName) return "Working";
  // Split on _ and camelCase boundaries.
  const parts = toolName
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/_+/)
    .filter(Boolean);
  if (parts.length === 0) return "Working";
  const [verb, ...rest] = parts;
  const inflected = VERB_INFLECTIONS[verb];
  if (inflected) {
    if (rest.length === 0) return inflected;
    return `${inflected} ${rest.join(" ")}`;
  }
  // No known verb — capitalize the first word.
  const first = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  return [first, ...parts.slice(1)].join(" ");
}

/**
 * Build a UI status label from a tool-status event payload.
 *
 *   statusToLabel({type: "tool_start",    toolName: "create_map_visualization"})
 *     → "Creating map..."
 *
 *   statusToLabel({type: "tool_complete", toolName: "create_map_visualization", success: true})
 *     → "Map created"
 *
 *   statusToLabel({type: "tool_complete", toolName: "create_map_visualization", success: false})
 *     → "Failed: creating map"
 *
 * Returns `null` when no human-meaningful label applies (e.g., `call_tool`
 * tool_start, or any tool whose `done` entry is suppressed). Caller should
 * treat null as "no status update — keep showing the previous label."
 */
export function statusToLabel(status) {
  if (!status || typeof status !== "object") return null;
  const { type, toolName, success } = status;
  const entry = COPY[toolName];

  if (type === "tool_start") {
    if (entry && entry.start === null) return null; // explicitly suppressed
    const start = entry?.start ?? humanizeToolName(toolName);
    return `${start}...`;
  }

  if (type === "tool_complete") {
    if (success === false) {
      const start = entry?.start ?? humanizeToolName(toolName);
      return `Failed: ${start.toLowerCase()}`;
    }
    if (entry && entry.done === null) return null; // explicitly suppressed
    return entry?.done ?? `${humanizeToolName(toolName)} done`;
  }

  return null;
}
