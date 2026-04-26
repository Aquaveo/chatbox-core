/**
 * config.js — Static defaults for @chatbox/core.
 *
 * This is a library — it must NOT read import.meta.env or process.env.
 * All runtime configuration flows through <Chatbox> props or localStorage.
 */

// MCP connection defaults (override via mcpServerUrl / mcpServers props)
export const DEFAULT_MCP_SERVER_URL = "/sse";
export const MAX_TOOL_REPAIR_ATTEMPTS = 0;

// Context window budget (reserve 20% for the model's response)
export const CONTEXT_BUDGET_RATIO = 0.8;

// Max characters for a single tool result stored in conversation history.
// Results exceeding this are truncated to prevent context bloat across rounds.
// 4000 chars ≈ 1000 tokens — enough for the LLM to see structure + first results.
export const MAX_TOOL_RESULT_CHARS = 4000;

// Tool names that are always included in the selected tool set regardless of
// keyword relevance. These enable the LLM to discover and invoke any tool.
export const ALWAYS_ON_TOOLS = ["search_tools", "call_tool"];
