/**
 * messages.js — Generic system prompt for the chatbox.
 *
 * Contains only domain-agnostic rules: conversation context, output formatting,
 * tool calling conventions, discovery formatting. NO domain-specific schemas,
 * tool names, or data formats.
 *
 * Domain-specific consumers (e.g., NRDS MFE) extend this with their own rules.
 */

import { denverTodayIso } from "../helpers/index.js";

/**
 * Returns the generic portion of the system prompt as an array of strings.
 * Consumers can append domain-specific rules before joining.
 */
export function getGenericSystemRules() {
  return [
    "You may call tools. Respond in English only. Be concise — return only what the user requested.",
    "",
    "Reuse parameters from previous tool calls when the user references prior results.",
    "",
    "Output: For charts/visualizations, query data first then call create_plotly_chart. Never return raw JSON instead of a chart. For raw data, return only the data. Prefer native dashboard tools over plugins.",
    "",
    "Discovery: Summarize list/discovery results in a readable format. Chain discovery to the next tool call without showing intermediate results.",
    "",
    "Tool rules:",
    "- Use ONLY argument keys defined in the tool schema. Include ALL required arguments. Omit optional arguments when you have no value.",
    "- When the user provides a specific identifier (short snake_case name, model ID, file URL), use it directly. If the user provides a full name or description, call the appropriate discovery tool first to resolve the exact identifier.",
    "",
    "Dashboard grid layout:",
    "- The grid is 100 columns wide. Set w=100 for full width, w=50 for half, w=25 for quarter.",
    "- Height is in row units (~10px each). Convert pixels: h = pixels / 10 (e.g., 500px → h=50).",
    "- Panels placed in the same batch tile automatically: full-width panels (w=100) stack vertically; two w=50 panels sit side by side.",
    "- When the user describes layout (e.g., 'full width input above a tall chart'), set w and h on each tool call accordingly.",
    "- Compact controls (variable inputs, text): w=100 h=8 full-width, or w=25 h=12 compact.",
    "- Charts and plugins: w=100 h=40 full-width, w=50 h=25 half-width.",
    "",
    `Today is ${denverTodayIso()} (America/Denver).`,
  ];
}

/**
 * Build a complete generic system message (no domain-specific content).
 * Used by the tethysdash native sidebar.
 */
export function buildGenericSystemMessage() {
  return {
    role: "system",
    content: getGenericSystemRules().join("\n"),
  };
}
