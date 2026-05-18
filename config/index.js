/**
 * config.js — Static defaults for @chatbox/core.
 *
 * This is a library — it must NOT read import.meta.env or process.env.
 * All runtime configuration flows through <Chatbox> props or localStorage.
 */

// MCP connection defaults (override via mcpServerUrl / mcpServers props).
// Default path is `/mcp` (Streamable HTTP) — the modern default for
// FastMCP servers, matching `nrds-mcps` (2026-05-02) and tethysdash
// (2026-05-08). The transport selector at engine/transports.js still
// supports legacy `/sse` URLs unchanged for backwards compatibility.
export const DEFAULT_MCP_SERVER_URL = "/mcp";
export const MAX_TOOL_REPAIR_ATTEMPTS = 0;

// Context window budget (reserve 20% for the model's response)
export const CONTEXT_BUDGET_RATIO = 0.8;

// Max characters for a single tool result stored in conversation history.
// Results exceeding this are truncated to prevent context bloat across rounds.
// 20000 chars ≈ 5000 tokens — fits a typical time-series query (240 rows of
// ~70 chars/row ≈ 17 KB) without losing the data array. Modern LLMs have
// 128K+ token contexts, so per-result generosity here is cheap; the earlier
// 4000-char cap silently truncated legitimate data-extraction responses and
// forced LLMs into retry loops. Truncation still kicks in for runaway results
// (the data-only branch preserves metadata + emits a recovery hint).
export const MAX_TOOL_RESULT_CHARS = 20000;

// Tool names that are always included in the selected tool set regardless of
// keyword relevance. These enable the LLM to discover and invoke any tool.
export const ALWAYS_ON_TOOLS = ["search_tools", "call_tool"];
