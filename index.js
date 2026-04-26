/**
 * @chatbox/core — Generic chatbox engine, UI components, and helpers.
 * Barrel export for convenience. Prefer subpath imports for tree-shaking.
 */

export { runChatSession, connectMcpServers, executeTool } from "./engine/index.js";
export { estimateTokens, trimConversation } from "./conversation/index.js";
export {
  listModels,
  denverTodayIso,
  omitEmptyArgs,
  stripThinkTags,
  mergeToolCalls,
  maybeParseJson,
  extractInlineToolCalls,
  getMessage,
} from "./helpers/index.js";
export {
  DEFAULT_MCP_SERVER_URL,
  MAX_TOOL_REPAIR_ATTEMPTS,
  CONTEXT_BUDGET_RATIO,
} from "./config/index.js";
export { buildGenericSystemMessage, getGenericSystemRules } from "./messages/index.js";
