/**
 * engine.js — Generic chatbox engine with strategy pattern extension points.
 *
 * Handles MCP connection, streaming, tool execution, and conversation loop.
 * Classifies each MCP server as "search-facade" (BM25) or "full-catalog"
 * and groups tools by server for per-server selection.
 *
 * NO domain-specific logic — consumers inject behavior via extension points:
 *   - systemPromptBuilder: provides the system message
 *   - toolCategories: maps tool names to state keys
 *   - earlyReturnCheck: decides if a result should end the session
 *   - beforeToolExecution: preprocesses tool args (e.g., S3 URL validation)
 */

import {
  detectAndStripToolShapedJson,
  extractInlineToolCallsWithResidual,
  getMessage,
  maybeParseJson,
  omitEmptyArgs,
  mergeToolCalls,
  stripThinkTags,
} from "../helpers/index.js";
import {
  pickTransportWithRetry,
  closeMcpConnection,
  withTimeout,
  LIST_TOOLS_BUDGET_MS,
} from "./transports.js";
import { ERROR_KEYS } from "./mcpErrors.js";
import { cacheToolResult } from "./cache.js";
import { substituteCacheUris } from "./uri-substitution.js";
import { trimConversation } from "../conversation/index.js";
import { buildGenericSystemMessage } from "../messages/index.js";
import {
  DEFAULT_MCP_SERVER_URL,
  MAX_TOOL_REPAIR_ATTEMPTS,
  MAX_TOOL_RESULT_CHARS,
  ALWAYS_ON_TOOLS,
} from "../config/index.js";

import { streamChat as openaiStreamChat } from "./adapters/openai.js";
import { streamChat as anthropicStreamChat } from "./adapters/anthropic.js";
import { streamChat as ollamaStreamChat } from "./adapters/ollama.js";

const PROVIDER_ADAPTERS = {
  openai: openaiStreamChat,
  anthropic: anthropicStreamChat,
  ollama: ollamaStreamChat,
  custom: openaiStreamChat,
};

// ---------------------------------------------------------------------------
// Server Classification
// ---------------------------------------------------------------------------

const SMALL_CATALOG_THRESHOLD = 8;

/**
 * Classify an MCP server as "search-facade" or "full-catalog" based on its
 * exposed tool list. A search-facade server has BM25SearchTransform enabled
 * and exposes search_tools + call_tool alongside a small set of pinned tools.
 */
function classifyServerTools(serverTools) {
  const names = new Set(serverTools.map((t) => t.function.name));
  const hasSearchFacade =
    names.has("search_tools") &&
    names.has("call_tool") &&
    serverTools.length < SMALL_CATALOG_THRESHOLD;

  return hasSearchFacade ? "search-facade" : "full-catalog";
}

// ---------------------------------------------------------------------------
// Tool Budget & Per-Server Selection
// ---------------------------------------------------------------------------

// 2026-05-10 raise 25 → 50. The previous cap exactly matched single-server
// catalog sizes that themselves grew over time (tethysdash post-Phase-3c
// shipped 25 tools); zero margin meant any mixed-server configuration
// (tethysdash + nrds-mcps, + external MCP servers) forced the embedding
// ranker to drop slash-prompt-target tools per chat message, re-creating
// the silent-misroute failure mode that prompted Phase 3b's pin-fix.
//
// 50 covers a realistic mixed setup (tethysdash 25 + nrds ~11 + one
// external ~10 ≈ 46) with headroom. At ~150 tokens per tool definition,
// 50 tools ≈ 7.5k tokens — workable inside the num_ctx=16384 default for
// Ollama-backed flows, leaving ~8k for conversation. The embedding ranker
// still earns its keep when total catalog > 50; the cap only moves.
const TOOL_BUDGET = 50;

/**
 * Select tools for the LLM based on per-server classification and a global budget.
 *
 * Called once per user message — the returned tool set remains stable across
 * the entire chat loop (continuations, repairs).
 *
 * @param {string} prompt - Original user prompt (used for future semantic matching)
 * @param {Object} toolsByServer - Map of serverId -> tool definitions
 * @param {Object} classificationByServer - Map of serverId -> "search-facade"|"full-catalog"
 * @param {Object} embeddingsByServer - Map of serverId -> embeddings (null until Unit 5)
 * @returns {Array} Selected tools to send to the LLM
 */
async function selectToolsForPrompt(prompt, toolsByServer, classificationByServer, embeddingsByServer = {}) {
  const selected = [];
  let budgetRemaining = TOOL_BUDGET;
  const largeCatalogServers = [];

  // Phase 1: Fixed-cost servers (search-facade + small full-catalog)
  for (const [serverId, serverTools] of Object.entries(toolsByServer)) {
    const kind = classificationByServer[serverId] || "full-catalog";

    if (kind === "search-facade") {
      selected.push(...serverTools);
      budgetRemaining -= serverTools.length;
      continue;
    }

    // Full-catalog: small vs large
    if (serverTools.length < SMALL_CATALOG_THRESHOLD) {
      selected.push(...serverTools);
      budgetRemaining -= serverTools.length;
      continue;
    }

    largeCatalogServers.push({ serverId, serverTools });
  }

  // Phase 2: Large full-catalog servers share remaining budget
  if (largeCatalogServers.length > 0 && budgetRemaining > 0) {
    const perServer = Math.max(3, Math.floor(budgetRemaining / largeCatalogServers.length));

    for (const { serverId, serverTools } of largeCatalogServers) {
      const embeddings = embeddingsByServer[serverId];

      if (embeddings) {
        try {
          const { selectTopTools } = await import("./embeddings.js");
          const topTools = await selectTopTools(prompt, serverTools, embeddings, perServer);
          selected.push(...topTools);
          continue;
        } catch { /* fall through to keyword matching */ }
      }

      // Keyword-based tool selection (fallback when no embeddings)
      const alwaysOn = new Set(ALWAYS_ON_TOOLS);
      const promptWords = new Set(
        prompt.toLowerCase().split(/[\s,.:;!?()]+/).filter((w) => w.length > 2),
      );

      const scored = serverTools.map((tool) => {
        const fn = tool.function || {};
        const nameWords = (fn.name || "").toLowerCase().split("_");
        const descWords = (fn.description || "").toLowerCase().split(/\s+/);
        let score = 0;
        for (const w of promptWords) {
          if (nameWords.some((nw) => nw.includes(w) || w.includes(nw))) score += 3;
          if (descWords.some((dw) => dw.includes(w) || w.includes(dw))) score += 1;
        }
        // Always-on tools get max score
        if (alwaysOn.has(fn.name)) score = Infinity;
        return { tool, score };
      });

      scored.sort((a, b) => b.score - a.score);

      // Take top N per budget, but at least 5 tools as a safety net
      const limit = Math.max(5, perServer);
      const picked = scored.slice(0, limit).map((s) => s.tool);
      selected.push(...picked);
    }
  } else if (largeCatalogServers.length > 0) {
    // Budget exhausted by fixed-cost servers — send always-on tools only
    const alwaysOn = new Set(ALWAYS_ON_TOOLS);
    for (const { serverTools } of largeCatalogServers) {
      selected.push(...serverTools.filter((t) => alwaysOn.has(t.function?.name)));
    }
  }

  return selected;
}

// ---------------------------------------------------------------------------
// MCP Connection Infrastructure
// ---------------------------------------------------------------------------
// URL normalization, transport selection, and connection lifecycle live in
// `./transports.js`. Credential-inheritance audit documented there too.

/**
 * Apply a `beforeFirstMessage` extension return value to the message array.
 *
 * If the extension returns a `role: "system"` message AND the trailing
 * message is already a user turn, merge the system content into the user
 * message instead of appending separately. This preserves strict
 * user/assistant alternation required by some providers (Ollama Cloud
 * rejects mid-conversation system messages with "Conversation roles must
 * alternate user/assistant/...").
 *
 * Other return shapes (non-system role, no trailing user message, or null)
 * fall through to the original append-or-skip behavior.
 *
 * Returns a new messages array; does not mutate the input.
 */
export function applyExtensionMessage(messages, extra) {
  if (!extra) return messages;

  const last = messages[messages.length - 1];
  if (extra.role === "system" && last?.role === "user") {
    const merged = {
      ...last,
      content: `${extra.content ?? ""}\n\n${last.content ?? ""}`,
    };
    return [...messages.slice(0, -1), merged];
  }

  return [...messages, extra];
}

export async function connectMcpServers(mcpServers) {
  const connections = [];
  const tools = [];
  const toolServerMap = new Map();
  // Plan 003 / Unit A1 — tag capture for the host UI's renderable-tool
  // banner trigger. Map<toolName, string[]>; first-wins on tool-name
  // collision across servers (mirrors `toolServerMap` semantics — a
  // server author whose tool name shadows an earlier server's tool
  // also has its tags shadowed).
  const toolTagsByName = new Map();
  const toolsByServer = {};
  const classificationByServer = {};
  const perServer = [];

  for (let i = 0; i < mcpServers.length; i++) {
    const server = mcpServers[i];
    const serverId = String(i);
    toolsByServer[serverId] = [];

    // Track which phase threw so we can distinguish transport failures from
    // list_tools RPC failures (the latter means the URL speaks *something*
    // but not MCP, which is a different user-facing error).
    let phase = "transport";

    try {
      const conn = await pickTransportWithRetry(server.url);
      connections.push(conn);

      phase = "list_tools";
      const response = await withTimeout(conn.client.listTools(), LIST_TOOLS_BUDGET_MS);
      const toolsList = Array.isArray(response?.tools) ? response.tools : [];

      for (const tool of toolsList) {
        const parameters =
          tool?.inputSchema && typeof tool.inputSchema === "object"
            ? tool.inputSchema
            : { type: "object", properties: {}, additionalProperties: false };

        const toolDef = {
          type: "function",
          function: { name: tool.name, description: tool.description ?? "", parameters },
        };
        tools.push(toolDef);
        toolsByServer[serverId].push(toolDef);

        if (toolServerMap.has(tool.name)) {
          console.warn(
            `Tool name collision: "${tool.name}" exists on server ${toolServerMap.get(tool.name)} and server ${i}. ` +
            `Keeping first server's mapping. Consider using unique tool names across servers.`
          );
        } else {
          toolServerMap.set(tool.name, i);
        }

        // Unit A1 — first-wins tag capture. Same guard as toolServerMap
        // so the two maps stay in lockstep on collision. No second
        // console.warn — the toolServerMap warning above already names
        // the offending tool; emitting a duplicate would just be noise.
        if (!toolTagsByName.has(tool.name)) {
          const tags = Array.isArray(tool?.tags) ? [...tool.tags] : [];
          toolTagsByName.set(tool.name, tags);
        }
      }

      classificationByServer[serverId] = classifyServerTools(toolsByServer[serverId]);
      perServer.push({
        url: server.url,
        name: server.name,
        state: toolsList.length === 0 ? "no-tools" : "connected",
      });
    } catch (error) {
      console.error(`Failed to connect to MCP server ${server.name || server.url}:`, error);
      connections.push(null);
      classificationByServer[serverId] = "full-catalog";
      // Map the thrown error to a user-facing enum key. pickTransport tags
      // transport failures with `errorKey`; list_tools RPC errors fall through
      // to `notMcpServer`; timeouts win over phase-mapping so a slow server
      // doesn't get misreported as "not an MCP server".
      let errorKey;
      if (error?.isTimeout) {
        errorKey = ERROR_KEYS.timeout;
      } else if (phase === "list_tools") {
        errorKey = ERROR_KEYS.notMcpServer;
      } else {
        errorKey = error?.errorKey ?? ERROR_KEYS.connectionFailed;
      }
      perServer.push({
        url: server.url,
        name: server.name,
        state: "failed",
        errorKey,
      });
    }
  }

  return { connections, tools, toolServerMap, toolTagsByName, toolsByServer, classificationByServer, perServer };
}

async function closeAllMcpConnections(connections) {
  for (const conn of connections) {
    await closeMcpConnection(conn);
  }
}

// ---------------------------------------------------------------------------
// Plan 2026-05-08-005 Unit 2 — MCP prompt-template discovery + rendering.
//
// `discoverPrompts` and `getPrompt` are MODULE-PRIVATE helpers. They are
// exported here only so that `engine/__test_internals__.js` can re-export
// them for the test suite. They are intentionally NOT added to the
// curated barrel exports in `lib/chatbox-core/index.js`, and consumers
// are not expected to import them. A future `onPromptsLoaded` host hook
// (deferred) would pre-commit them to the public surface.
//
// Lifecycle differs from `connectMcpServers`: prompts are fetched at
// `<Chatbox>` mount time (and on `mcpServers` prop reference change) so
// the slash-command popover can be available before any send.
// `discoverPrompts` opens its own transient transport per server, just
// like `connectMcpServers`, and closes it in `finally`.
// ---------------------------------------------------------------------------

/**
 * Error class thrown by `getPrompt` when the resolved prompt text is empty
 * (no messages, all messages dropped by the text-only filter, or all
 * `.text` values empty). Distinguishable from network/transport errors so
 * the host can route a tailored user-facing message.
 */
export class EmptyPromptError extends Error {
  constructor(message = "Prompt resolved to empty text") {
    super(message);
    this.name = "EmptyPromptError";
  }
}

/**
 * JSON-RPC -32601 (method-not-found) detector. Some transports surface it
 * as a structured `{code: -32601}` error, others as a stringified message
 * containing "Method not found" or "-32601". Treat both as the same R10a
 * silent-fallback class.
 */
function _isMethodNotFound(err) {
  if (!err) return false;
  if (err.code === -32601) return true;
  const data = err.data;
  if (data && (data.code === -32601 || data?.error?.code === -32601)) return true;
  const msg = String(err?.message ?? err);
  return /-32601|method not found/i.test(msg);
}

/**
 * Discover prompts from each configured MCP server.
 *
 * Module-private. Called from `<Chatbox>` mount-effect (see Plan
 * 2026-05-08-005 Unit 4). Per-server `listPrompts()` failures (method-
 * not-found, network errors, timeouts) degrade silently to an empty
 * list for that server — the popover simply has nothing to show from
 * that source. Other servers' results are unaffected.
 *
 * Nil/empty input contract: returns the empty envelope SYNCHRONOUSLY
 * without opening any transport when `mcpServers` is `null`, `undefined`,
 * or `[]`. Matches the parent `useEffect`'s mount-time call shape before
 * any server is configured.
 *
 * @param {Array<{id?: string, url: string, name?: string}>} mcpServers
 * @returns {Promise<{
 *   promptsByServer: Object<string, Array>,
 *   promptServerMap: Map<string, number>,
 *   perServer: Array<{serverId: string, promptCount: number, errorKey: ?string}>
 * }>}
 */
export async function discoverPrompts(mcpServers) {
  // Nil/empty contract — return synchronously, no transport opened.
  if (!Array.isArray(mcpServers) || mcpServers.length === 0) {
    return {
      promptsByServer: {},
      promptServerMap: new Map(),
      perServer: [],
    };
  }

  const promptsByServer = {};
  const promptServerMap = new Map();
  const perServer = [];

  for (let i = 0; i < mcpServers.length; i++) {
    const server = mcpServers[i];
    const serverId = String(i);
    promptsByServer[serverId] = [];

    let conn = null;
    let phase = "transport";
    let errorKey = null;

    try {
      conn = await pickTransportWithRetry(server.url);
      phase = "list_prompts";
      const response = await withTimeout(
        conn.client.listPrompts(),
        LIST_TOOLS_BUDGET_MS,
      );
      const promptList = Array.isArray(response?.prompts) ? response.prompts : [];

      for (const prompt of promptList) {
        promptsByServer[serverId].push(prompt);

        if (promptServerMap.has(prompt.name)) {
          // Mirrors the toolServerMap collision-warn precedent at
          // engine/index.js:252-256. First server wins.
          console.warn(
            `Prompt name collision: "${prompt.name}" exists on server ${promptServerMap.get(prompt.name)} and server ${i}. ` +
            `Keeping first server's mapping. Consider using unique prompt names across servers.`
          );
        } else {
          promptServerMap.set(prompt.name, i);
        }
      }
    } catch (error) {
      // R10a method-not-found OR R10c generic network/RPC error — both
      // collapse to an empty prompt list for this server. The errorKey
      // lets observability tooling distinguish them; the user-facing
      // surface (popover) doesn't render anything either way per R10.
      if (_isMethodNotFound(error)) {
        errorKey = ERROR_KEYS.notMcpServer;
      } else if (error?.isTimeout) {
        errorKey = ERROR_KEYS.timeout;
      } else if (phase === "list_prompts") {
        errorKey = ERROR_KEYS.notMcpServer;
      } else {
        errorKey = error?.errorKey ?? ERROR_KEYS.connectionFailed;
      }
    } finally {
      if (conn) {
        await closeMcpConnection(conn);
      }
    }

    perServer.push({
      serverId,
      promptCount: promptsByServer[serverId].length,
      errorKey,
    });
  }

  return { promptsByServer, promptServerMap, perServer };
}

/**
 * Fetch and render a single prompt template from the specified server.
 *
 * Module-private. Opens a transient transport via `pickTransport`, calls
 * `client.getPrompt({name, arguments})`, filters response messages to
 * text-only content per R7a, and returns the concatenated `.text` values.
 *
 * Throws `EmptyPromptError` if the concatenated string is empty (no
 * messages, all dropped, or all `.text` empty). Other errors (transport,
 * timeout, server) propagate as-is so callers can branch on error class.
 *
 * @param {number} serverIdx
 * @param {string} promptName
 * @param {Object} args
 * @param {Array} mcpServers
 * @returns {Promise<string>}
 */
export async function getPrompt(serverIdx, promptName, args, mcpServers) {
  const server = mcpServers?.[serverIdx];
  if (!server) {
    throw new Error(`No MCP server at index ${serverIdx}`);
  }

  let conn = null;
  try {
    conn = await pickTransportWithRetry(server.url);
    const result = await conn.client.getPrompt({
      name: promptName,
      arguments: args ?? {},
    });

    const messages = Array.isArray(result?.messages) ? result.messages : [];
    const parts = [];
    for (const msg of messages) {
      const content = msg?.content;
      if (!content) continue;
      // Content can be a single content object or an array of them.
      const contentArr = Array.isArray(content) ? content : [content];
      for (const c of contentArr) {
        if (c && c.type === "text" && typeof c.text === "string" && c.text.length > 0) {
          parts.push(c.text);
        }
      }
    }

    const text = parts.join("");
    if (text.length === 0) {
      throw new EmptyPromptError(
        `Prompt "${promptName}" resolved to empty text`,
      );
    }
    return text;
  } finally {
    if (conn) {
      await closeMcpConnection(conn);
    }
  }
}

export async function executeTool(toolName, args, connections, toolServerMap) {
  const serverIdx = toolServerMap.get(toolName);
  const conn = serverIdx != null ? connections[serverIdx] : null;
  const mcpClient = conn?.client;

  if (!mcpClient) {
    return { error: `No MCP server found for tool: ${toolName}` };
  }

  try {
    const result = await mcpClient.callTool({
      name: toolName,
      arguments: omitEmptyArgs(args),
      raiseOnError: false,
    });

    const data = result?.data;
    if (data !== undefined && data !== null) return maybeParseJson(data);

    try {
      return maybeParseJson(result?.content?.[0]?.text ?? result);
    } catch {
      return result;
    }
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}

// ---------------------------------------------------------------------------
// Provider-Agnostic Streaming (via adapters)
// ---------------------------------------------------------------------------

/**
 * Empty-content guard for end-of-turn assistant text (bug 2026-05-08).
 *
 * When the LLM emits a final response with no tool calls AND no content,
 * the engine must not push an empty assistant message into history — the
 * chatbox renders that as an empty bubble, hiding whether the turn
 * completed normally, aborted mid-task, or errored silently.
 *
 * Differentiates "did some work, ran dry of words" from "did nothing":
 *   - Produced something this turn → "The model finished without further
 *     explanation." Hints to the user that work happened but the model
 *     went silent — they may want to ask for the rest if items are
 *     missing.
 *   - Produced nothing → "The model returned no response. Could you
 *     rephrase?" Matches the existing tool-shape placeholder's tone.
 *
 * Pure helper — exported for direct testing.
 */
export function resolveEmptyAssistantText(rawText, state) {
  if (typeof rawText === "string" && rawText.trim().length > 0) return rawText;
  const producedSomething =
    (state?.pendingVisualizations?.length ?? 0) > 0 ||
    (state?.pendingLayerUpdates?.length ?? 0) > 0 ||
    (state?.pendingPatches?.length ?? 0) > 0;
  return producedSomething
    ? "The model finished without further explanation."
    : "The model returned no response. Could you rephrase?";
}


async function streamWithAdapter({
  messages, tools, model, modelMetadata, thinkingEnabled,
  onThinkingChunk, onContentChunk, providerConfig, csrfToken, signal,
}) {
  const { provider } = providerConfig;
  const adapter = PROVIDER_ADAPTERS[provider] || openaiStreamChat;

  return adapter({
    ...providerConfig,
    model,
    modelMetadata,
    messages,
    tools,
    csrfToken,
    signal,
    onThinkingChunk: thinkingEnabled ? onThinkingChunk : undefined,
    onContentChunk,
  });
}

// ---------------------------------------------------------------------------
// Plan 2026-05-07-002 Unit B: closed-vocabulary `{{last_<type>_uuid}}`
// substitution.
//
// Some LLMs (observed: gemma4:31b) emit Mustache-style placeholders for
// chained tool args, expecting the host framework to substitute the prior
// tool's return value. MCP doesn't do this. This module-private helper
// substitutes a small enumerated vocabulary against the engine's own
// `state.lastReturnedUuids` map (populated when create_* tools return a
// visualization with a recognized source). Anything outside the enumerated
// vocabulary is left unchanged so the server-side `_validate_uuid_arg`
// (Unit A) rejects it with a structured `invalid_uuid:` error envelope.
//
// Bright-line discipline:
//   - Closed vocabulary only — 5 enumerated tokens. No regex-derived,
//     no open-ended placeholder shapes.
//   - Whole-string equality only — no partial substitution inside larger
//     strings.
//   - Authoritative source — the substituted value is a UUID the engine
//     itself emitted on a prior tool result, never inferred from LLM intent.
//   - No INFO logging — match the server-side `_coerce_known_values`
//     silent-transformation precedent.
// ---------------------------------------------------------------------------

const _SOURCE_TO_TYPE_KEY = {
  Map: "map",
  "Inline Plotly": "plot",
  "Inline Table": "table",
  "Inline Card": "card",
  "Variable Input": "variable_input",
};

const _PLACEHOLDER_TO_TYPE_KEY = {
  "{{last_map_uuid}}": "map",
  "{{last_plot_uuid}}": "plot",
  "{{last_table_uuid}}": "table",
  "{{last_card_uuid}}": "card",
  "{{last_variable_input_uuid}}": "variable_input",
};

function _typeKeyFromSource(source) {
  if (typeof source !== "string") return null;
  return _SOURCE_TO_TYPE_KEY[source] ?? null;
}

/**
 * Recursively walk `value`, replacing whole-string placeholder values with
 * their tracked UUIDs from `lastReturnedUuids`. Mutates plain objects and
 * arrays in place; leaves primitives, keys, and embedded substrings alone.
 * Unknown placeholder forms pass through unchanged.
 */
function _substituteLastUuidPlaceholders(value, lastReturnedUuids) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const elem = value[i];
      if (typeof elem === "string") {
        const typeKey = _PLACEHOLDER_TO_TYPE_KEY[elem];
        if (typeKey && lastReturnedUuids?.[typeKey]) {
          value[i] = lastReturnedUuids[typeKey];
        }
      } else if (elem !== null && typeof elem === "object") {
        _substituteLastUuidPlaceholders(elem, lastReturnedUuids);
      }
    }
    return value;
  }
  for (const key of Object.keys(value)) {
    const child = value[key];
    if (typeof child === "string") {
      const typeKey = _PLACEHOLDER_TO_TYPE_KEY[child];
      if (typeKey && lastReturnedUuids?.[typeKey]) {
        value[key] = lastReturnedUuids[typeKey];
      }
    } else if (child !== null && typeof child === "object") {
      _substituteLastUuidPlaceholders(child, lastReturnedUuids);
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// Generic Tool Processing
// ---------------------------------------------------------------------------

export async function processToolCalls(
  toolCalls, messages, connections, toolServerMap, state, originalUserText,
  {
    toolCategories, beforeToolExecution, toolErrorCheck, afterToolExecution, onToolStatus,
    // MCP result-by-reference protocol (plan 2026-05-18-002). Disabled by
    // default so npm consumers of @aquaveo/chatbox-core that don't opt in
    // see no behavior change. tethysapp-tethys_dash sets enabled=true on
    // its <ChatSidebar> mount via Unit 4's host prop.
    cacheOptions = { enabled: false, conversationId: "default" },
  },
) {
  let hadError = false;
  let lastErr = null;
  const failedSignatures = [];

  // Plan 2026-05-08-003 — per-tool status events for the chatbox progress
  // indicator. Wrapped to swallow host callback errors so a bug in the host
  // can't abort the engine loop.
  const fireStatus = (payload) => {
    if (!onToolStatus) return;
    try {
      onToolStatus(payload);
    } catch (err) {
      // Host bug — log and continue.
      // eslint-disable-next-line no-console
      console.warn("[chatbox-core] onToolStatus callback threw:", err);
    }
  };

  for (const toolCall of toolCalls) {
    let toolName = toolCall?.function?.name;
    let args = toolCall?.function?.arguments ?? {};

    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { args = { _raw: args }; }
    }

    // Extension point: domain-specific preprocessing (S3 validation, arg normalization)
    if (beforeToolExecution) {
      const preResult = beforeToolExecution(toolName, args, messages);
      if (preResult?.skip) {
        // Domain hook wants to skip this tool (e.g., invalid S3 URL)
        if (preResult.message) {
          messages.push({ role: "tool", tool_name: toolName, content: JSON.stringify(preResult.message) });
        }
        if (preResult.error) {
          hadError = true;
          lastErr = preResult.error;
          if (preResult.signature) failedSignatures.push(preResult.signature);
        }
        continue;
      }
      if (preResult?.args) args = preResult.args;
      if (preResult?.toolName) toolName = preResult.toolName;
    }

    // Plan 2026-05-18-002 Unit 3 — substitute `*_uri` args against the
    // IndexedDB cache BEFORE the existing UUID-placeholder walk. The two
    // layers cover different patterns: this one is open-vocabulary
    // (any arg ending in `_uri`); the next one is closed-vocabulary
    // (the 5 enumerated `{{last_<type>_uuid}}` tokens). Ordering is
    // explicit so a future tool whose URI value happens to match a
    // placeholder shape gets resolved as URI first.
    if (cacheOptions?.enabled && args && typeof args === "object") {
      const subResult = await substituteCacheUris(args);
      if (!subResult.ok) {
        // Cache miss — short-circuit dispatch and push the envelope as
        // the tool result. The LLM gets an `invalid_args`-shaped error
        // with `_missing_uris` + a fix_hint directing it to re-call the
        // source tool. Mirrors the input-validation middleware recovery
        // pattern; LLMs already know how to interpret these envelopes.
        const missEnvelope = subResult.envelope;
        fireStatus({ type: "tool_start", toolName });
        fireStatus({ type: "tool_complete", toolName, success: false });
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id || toolName,
          tool_name: toolName,
          content: JSON.stringify({
            ...missEnvelope,
            _engine_dispatched: [],
          }),
        });
        hadError = true;
        lastErr = new Error(missEnvelope.error);
        failedSignatures.push(`${toolName}|cache-miss|${JSON.stringify(missEnvelope._missing_uris)}`);
        continue;
      }
      args = subResult.args;
    }

    // Plan 2026-05-07-002 Unit B: substitute `{{last_<type>_uuid}}`
    // placeholders against engine-tracked UUIDs *before* dispatching.
    // Runs after `beforeToolExecution` so any domain-specific arg
    // normalization the host injected has the canonical UUID to work with.
    if (args && typeof args === "object" && state?.lastReturnedUuids) {
      _substituteLastUuidPlaceholders(args, state.lastReturnedUuids);
    }

    fireStatus({ type: "tool_start", toolName });
    let toolResult;
    try {
      toolResult = await executeTool(toolName, args, connections, toolServerMap);
    } catch (err) {
      // Fire a failure status so the indicator flashes "Failed: ..."
      // before the exception propagates and the turn aborts.
      fireStatus({ type: "tool_complete", toolName, success: false });
      throw err;
    }
    // Domain-error envelopes (`{error: "..."}`) count as failures for the
    // status indicator; the user wants to know the tool didn't do what it
    // was supposed to. Other shapes are treated as success.
    const isDomainError =
      toolResult !== null &&
      typeof toolResult === "object" &&
      typeof toolResult.error === "string";
    fireStatus({ type: "tool_complete", toolName, success: !isDomainError });

    // Unit A1 / K14 — append per-turn tool-call entry. Used by the host
    // UI to evaluate the dispatch-feedback banner trigger (was a
    // renderable-tagged tool called this turn? did at least one such
    // call return something other than a domain-error envelope?).
    // Caller (runChatSession) resets `state.toolCallsThisTurn = []` at
    // the top of every turn iteration; this site only appends.
    if (Array.isArray(state?.toolCallsThisTurn)) {
      const hadDomainError =
        toolResult !== null &&
        typeof toolResult === "object" &&
        typeof toolResult.error === "string";
      state.toolCallsThisTurn.push({ toolName, hadDomainError });
    }

    // Categorize tool result via injected categories
    if (toolResult && typeof toolResult === "object" && toolCategories) {
      const errText = toolErrorCheck ? toolErrorCheck(toolResult) : null;
      if (!errText) {
        for (const category of Object.values(toolCategories)) {
          if (category.tools.has(toolName)) {
            state[category.stateKey] = toolResult;
            category.onSuccess?.(state, toolResult, args);
            break;
          }
        }
      }
    }

    // Unit A2 / K2 — capture per-call envelope counts BEFORE the
    // recognition block so the slice afterward yields exactly the UUIDs
    // dispatched by THIS tool call (not cumulative across the turn).
    // If the recognition block is reordered or split, this delta breaks
    // silently — keep these reads adjacent to the pushes below.
    const visBefore = state.pendingVisualizations.length;
    const layerBefore = state.pendingLayerUpdates.length;
    const patchBefore = state.pendingPatches.length;

    // Collect visualization specs from the ORIGINAL result (before truncation)
    if (toolResult && typeof toolResult === "object" && toolResult.visualization) {
      state.pendingVisualizations.push(toolResult.visualization);
      // Plan 2026-05-07-002 Unit B: track the returned UUID by type so
      // subsequent tool calls in this session can reference it via the
      // `{{last_<type>_uuid}}` placeholder vocabulary.
      const viz = toolResult.visualization;
      const typeKey = _typeKeyFromSource(viz?.source);
      if (typeKey && typeof viz?.uuid === "string" && viz.uuid) {
        if (!state.lastReturnedUuids) state.lastReturnedUuids = {};
        state.lastReturnedUuids[typeKey] = viz.uuid;
      }
    }

    // Collect layer updates (from add_map_service_layer) before truncation
    if (toolResult && typeof toolResult === "object" && toolResult.layer_update) {
      state.pendingLayerUpdates.push(toolResult.layer_update);
    }

    // Collect patch envelopes (from patch_visualization) before truncation
    if (toolResult && typeof toolResult === "object" && toolResult.patch_update) {
      state.pendingPatches.push(toolResult.patch_update);
    }

    // R16 — record patch_visualization rejections so the host chatbox can
    // categorize them into user-facing copy. These would otherwise be
    // invisible to the user: the engine's repair loop consumes the error
    // and the LLM may or may not mention it in its final response.
    if (
      toolName === "patch_visualization" &&
      toolResult &&
      typeof toolResult === "object" &&
      typeof toolResult.error === "string"
    ) {
      state.rejectedPatches.push({
        error: toolResult.error,
        args: args ?? {},
      });
    }

    // Unit A2 / K2 — compute the per-call delta. Each envelope kind
    // contributes the UUIDs of envelopes added between visBefore↔now.
    const dispatchedUuids = [
      ...state.pendingVisualizations
        .slice(visBefore)
        .map((v) => v?.uuid)
        .filter((u) => typeof u === "string"),
      ...state.pendingLayerUpdates
        .slice(layerBefore)
        .map((l) => l?.uuid)
        .filter((u) => typeof u === "string"),
      ...state.pendingPatches
        .slice(patchBefore)
        .map((p) => p?.uuid)
        .filter((u) => typeof u === "string"),
    ];

    // Unit A2 / K1 + K5 + K15 — inject `_engine_dispatched` only on
    // object-shaped results; skip silently for null/scalar. K5: if the
    // tool result already carries the reserved key, log a warning and
    // overwrite with the engine's authoritative value (collision check
    // fires before the truncation pass).
    //
    // Build a forwarded wrapper rather than mutating `toolResult` so
    // downstream consumers that observe the original shape — notably
    // `afterToolExecution` hooks and any extension that reads the
    // tool result post-execution — see the unmodified server response.
    const isObjResult = toolResult !== null && typeof toolResult === "object";
    let resultForLlm = toolResult;
    if (isObjResult) {
      if (Object.prototype.hasOwnProperty.call(toolResult, "_engine_dispatched")) {
        console.warn(
          `[chatbox-core] Tool ${toolName} returned a reserved key ` +
            `'_engine_dispatched' in its result. Overwriting with engine value.`,
        );
      }
      // Spread + reassign drops the adversarial value if any, then sets
      // the engine's authoritative value last (object-key insertion order
      // makes the engine's value win even on engines that surface dupes).
      resultForLlm = { ...toolResult, _engine_dispatched: dispatchedUuids };

      // Plan 2026-05-18-002 Unit 2 — MCP result-by-reference protocol.
      // When enabled by the host (Chatbox.jsx's `enableResultCache` prop,
      // threaded through Unit 4), oversized tool results are auto-cached
      // in IndexedDB and a `_cache_uri` marker is injected into the
      // LLM-visible envelope. Unit 3's substitution layer (in this same
      // function above the dispatch call) resolves the URI back to inline
      // data when the LLM passes it forward as `data_uri` or any other
      // `*_uri` arg. The cache write happens BEFORE the truncation pass
      // below so the cached payload is always the ORIGINAL, not the
      // truncated summary the LLM ends up seeing for oversized results.
      if (cacheOptions?.enabled) {
        const cacheUri = await cacheToolResult({
          payload: toolResult,
          convId: cacheOptions.conversationId || "default",
          sourceToolName: toolName,
        });
        if (cacheUri) {
          resultForLlm._cache_uri = cacheUri;
        }
      }
    }

    // Truncate large results before storing in conversation history.
    // Unit A2 / K3 — when the result exceeds MAX_TOOL_RESULT_CHARS,
    // produce a structured compact summary that preserves
    // `_engine_dispatched` regardless of envelope kind. This also fixes
    // a pre-existing latent bug where `layer_update` and `patch_update`
    // truncation fell through to a naive string-slice that destroyed
    // their structure in the LLM-visible message.
    let resultContent = isObjResult
      ? JSON.stringify(resultForLlm)
      : String(toolResult ?? "");

    if (resultContent.length > MAX_TOOL_RESULT_CHARS) {
      const originalLen = resultContent.length;
      if (isObjResult) {
        // Build summary from the original toolResult so we can read
        // envelope shapes; `_engine_dispatched` carries the engine's
        // authoritative dispatchedUuids regardless of any adversarial
        // value the source might have included.
        let summary;
        if (toolResult.visualization) {
          summary = {
            visualization: {
              source: toolResult.visualization.source,
              vizType: toolResult.visualization.vizType,
              uuid: toolResult.visualization.uuid,
            },
          };
        } else if (toolResult.layer_update) {
          summary = {
            layer_update: {
              uuid: toolResult.layer_update.uuid,
              action: toolResult.layer_update.action,
            },
          };
        } else if (toolResult.patch_update) {
          summary = {
            patch_update: { uuid: toolResult.patch_update.uuid },
          };
        } else {
          // Data-only oversized — preserve metadata so the LLM can either
          // consume the result or rationalize a retry. Drop only the bulk
          // payload fields (`data`, `files`, etc.). The earlier behavior
          // ({} plus stringy `error`) left the LLM blind on success
          // envelopes whose `data` array overflowed the cap: it saw only
          // `_truncated: true` with no rows, columns, or row count, and
          // would retry the same query in a loop expecting different
          // results. Observed 2026-05-18 against a 240-row time-series
          // query that legitimately blew the 4000-char cap. Now the LLM
          // sees the shape metadata + a `_truncation_hint` describing
          // what was dropped and how to recover.
          summary = {};
          if (toolResult.ok !== undefined) {
            summary.ok = toolResult.ok;
          }
          if (toolResult.rows !== undefined) {
            summary.rows = toolResult.rows;
          }
          if (toolResult.file_count !== undefined) {
            summary.file_count = toolResult.file_count;
          }
          if (Array.isArray(toolResult.columns)) {
            summary.columns = toolResult.columns;
          }
          // Structured error envelope (object with code/message) — preserve
          // intact so the LLM gets full recovery context. String `error`
          // (legacy shape) was already preserved; now both shapes survive.
          if (toolResult.error && typeof toolResult.error === "object") {
            summary.error = toolResult.error;
          } else if (typeof toolResult.error === "string") {
            summary.error = toolResult.error;
          }
          if (toolResult.fix_hint) {
            summary.fix_hint = toolResult.fix_hint;
          }
          summary._truncation_hint =
            "Result body dropped — response exceeded the per-tool size cap. " +
            "Retry with WHERE filters, a smaller LIMIT, or an aggregate " +
            "(COUNT, SUM, AVG) to fit. The `rows` / `columns` / `file_count` " +
            "fields above describe what was returned before truncation.";
        }
        summary._engine_dispatched = dispatchedUuids;
        summary._truncated = true;
        summary._originalChars = originalLen;
        // Plan 2026-05-18-002 Unit 2 — preserve `_cache_uri` into the
        // truncation summary so the LLM still receives the reference
        // even when the bulk payload was dropped. This is exactly the
        // case where the LLM most needs the cache URI (data was too
        // large to fit in the per-tool-result cap; ref-by-URI is the
        // only viable way to pass it forward).
        if (resultForLlm._cache_uri) {
          summary._cache_uri = resultForLlm._cache_uri;
        }
        resultContent = JSON.stringify(summary);
      } else {
        // K1 — non-object results never gain `_engine_dispatched`; keep
        // the legacy string-slice fallback for scalar/null oversized.
        resultContent =
          resultContent.slice(0, MAX_TOOL_RESULT_CHARS) +
          `\n...[truncated, full result was ${originalLen} chars]`;
      }
    }

    messages.push({
      role: "tool",
      tool_call_id: toolCall.id || toolName,
      tool_name: toolName,
      content: resultContent,
    });

    // Extension point: domain-specific decoration after the tool result is
    // pushed. Consumers may append an in-turn delta / state summary to the
    // tool-result message so the LLM sees evolving dashboard state across
    // rounds without waiting for the next turn's state-injection (R6).
    //
    // MUST NOT signal an early return from the main while loop (R12): the
    // LLM is the sole completion authority. Hook receives the raw result
    // and the pushed message for read or decoration only.
    if (afterToolExecution) {
      try {
        await afterToolExecution(toolName, args, toolResult, state, messages);
      } catch (hookErr) {
        // Hook errors must not break the tool-use loop — log and proceed.
        // The underlying tool already executed successfully to this point.
        if (typeof console !== "undefined" && console.warn) {
          console.warn("afterToolExecution hook threw:", hookErr);
        }
      }
    }

    const errText = toolErrorCheck ? toolErrorCheck(toolResult) : null;
    if (errText) {
      hadError = true;
      lastErr = errText;
      // Use domain-provided signature or fallback
      failedSignatures.push(`${toolName}|${JSON.stringify(args)}`);
    }
  }

  return { hadError, lastErr, failedSignatures };
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

export async function runChatSession({
  prompt,
  model,
  modelMetadata = null,
  thinkingEnabled,
  onThinkingChunk,
  onContentChunk,
  onToolStatus,
  signal,
  providerConfig = { provider: "custom", baseUrl: "", apiKey: "" },
  csrfToken = "",
  mcpServerUrl = DEFAULT_MCP_SERVER_URL,
  mcpServers,
  history,
  maxContextTokens,

  // Extension points (all optional — defaults produce a generic chatbox)
  systemPromptBuilder = buildGenericSystemMessage,
  toolCategories = null,
  earlyReturnCheck = null,
  beforeToolExecution = null,
  toolErrorCheck = null,
  repairMessageBuilder = null,
  beforeFirstMessage = null,
  afterToolExecution = null,

  // MCP result-by-reference protocol (plan 2026-05-18-002). Default off
  // so npm consumers of @aquaveo/chatbox-core that don't opt in inherit
  // no behavior change. tethysapp-tethys_dash's <ChatSidebar> sets these
  // explicitly via Unit 4's host prop.
  enableResultCache = false,
  conversationId = "default",
}) {
  const cacheOptions = { enabled: !!enableResultCache, conversationId };

  const state = {
    lastChartResult: null,
    lastQueryResult: null,
    lastQuerySQL: null,
    lastListResult: null,
    lastMapResult: null,
    lastHydrofabricResult: null,
    pendingVisualizations: [],
    pendingLayerUpdates: [],
    pendingPatches: [],
    // Plan 2026-05-07-002 Unit B: closed-vocabulary symbol dereference.
    // Tracks the most recent UUID emitted by each create_* tool family,
    // keyed by the type derived from `visualization.source`. Substituted
    // into outgoing tool args before dispatch when the LLM emits a
    // `{{last_<type>_uuid}}` placeholder for chained-UUID arguments.
    // Per-session lifetime (lives for the whole runChatSession call).
    lastReturnedUuids: {},
    // R16 — rejections the engine observed during this turn. Populated
    // from every patch_visualization tool call that returned an {error}
    // instead of a {patch_update}. Surfaced in the runChatSession return
    // so the host chatbox can categorize into user-facing copy buckets.
    rejectedPatches: [],
    // Plan 003 / Unit A1 (K14) — per-turn tool-call history surfaced to
    // the host UI for the dispatch-feedback banner trigger. Appended by
    // `processToolCalls`; reset at the top of every turn iteration in
    // the loop below. Each entry: {toolName: string, hadDomainError: boolean}
    // where hadDomainError === (typeof toolResult.error === "string").
    toolCallsThisTurn: [],
  };

  let messages =
    Array.isArray(history) && history.length > 0
      ? [...history]
      : [systemPromptBuilder({ toolsAvailable: true })];

  const text = typeof prompt === "string" ? prompt : "";

  const servers = Array.isArray(mcpServers) && mcpServers.length > 0
    ? mcpServers
    : mcpServerUrl
      ? [{ url: mcpServerUrl, name: "Default" }]
      : [];

  const { connections, tools, toolServerMap, toolTagsByName, toolsByServer, classificationByServer, perServer } =
    await connectMcpServers(servers);

  // Build embeddings for large full-catalog servers (lazy, cached across messages).
  const embeddingsByServer = {};
  for (const [serverId, serverTools] of Object.entries(toolsByServer)) {
    const kind = classificationByServer[serverId];
    if (kind === "full-catalog" && serverTools.length >= SMALL_CATALOG_THRESHOLD) {
      try {
        const { buildEmbeddingsForServer } = await import("./embeddings.js");
        const serverUrl = servers[Number(serverId)]?.url || serverId;
        embeddingsByServer[serverId] = await buildEmbeddingsForServer(serverUrl, serverTools);
      } catch {
        // Embedding module unavailable — selection will fall back to all tools
      }
    }
  }

  // Select tools once per user message — stable across the entire chat loop.
  // Always offer MCP tools when servers expose them. Tool-capability metadata
  // is advisory only; do not suppress tools based on model registry signals or
  // previously auto-learned localStorage classifications.
  const selectedTools = await selectToolsForPrompt(
    typeof prompt === "string" ? prompt : "",
    toolsByServer,
    classificationByServer,
    embeddingsByServer,
  );

  try {
    messages.push({ role: "user", content: text });

    if (maxContextTokens && maxContextTokens > 0) {
      messages = trimConversation(messages, maxContextTokens);
    }

    // Extension point: inject additional context before each LLM call.
    // (e.g., dashboard state injection from ChatSidebar.)
    if (beforeFirstMessage) {
      const extra = beforeFirstMessage(text, messages);
      messages = applyExtensionMessage(messages, extra);
    }

    const failedSigCounts = {};

    while (true) {
      if (signal?.aborted) {
        return {
          assistantText: "",
          messages,
          aborted: true,
          perServer,
          toolTagsByName,
          toolCallsThisTurn: state.toolCallsThisTurn,
        };
      }

      // Plan 003 / Unit A1 (K14) — reset per-turn tool-call history at
      // the top of every loop iteration. processToolCalls appends; the
      // host UI consumes the array as a snapshot of "what happened this
      // turn" for banner-trigger evaluation.
      state.toolCallsThisTurn = [];

      const response = await streamWithAdapter({
        messages, tools: selectedTools, model, modelMetadata, thinkingEnabled,
        onThinkingChunk, onContentChunk, providerConfig, csrfToken, signal,
      });

      const message = getMessage(response);
      let toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      // When tool calls came from the provider's structured field, the
      // assistant content is already prose-only. When we extract inline
      // tool calls from the text below, we capture the residual prose so
      // the JSON doesn't leak into the user-visible message bubble or the
      // conversation history.
      let inlineResidualContent = null;

      if (!toolCalls.length) {
        const assistantContent = typeof message.content === "string" ? message.content : "";
        const { calls, residualContent } = extractInlineToolCallsWithResidual(assistantContent);
        if (calls.length) {
          toolCalls = calls;
          inlineResidualContent = residualContent;
        }
      }

      // No tool calls → return final text response
      if (!toolCalls.length) {
        let assistantText = stripThinkTags(
          typeof message.content === "string" ? message.content : "",
        );
        // Defensive: even after stripThinkTags, the model may have emitted
        // tool-call-shaped JSON (e.g., {"tool": "x", "action": "y"}) with
        // a key combination that didn't structurally match a real tool call.
        const toolShape = detectAndStripToolShapedJson(assistantText);
        // If a model produces malformed tool-shaped JSON that the inline
        // extractor could not convert into a real tool call, strip it from
        // the user-visible answer. Do not retry without tools or persist a
        // local "unsupported" classification; TethysDash workflows are
        // tool-driven and should keep tools available on the next turn.
        if (toolShape.hadToolShapedJson) {
          assistantText = toolShape.stripped.trim()
            || "I tried to use a tool but couldn't complete the request. Could you rephrase?";
        }
        // Empty-content guard (2026-05-08): some models (observed:
        // gpt-oss:120b on multi-item prompts) end a turn with no tool
        // calls AND empty content — silent abort mid-task. Without this
        // guard, the chatbox renders an empty assistant bubble and the
        // user can't tell whether the system completed normally or
        // dropped the rest of the work.
        assistantText = resolveEmptyAssistantText(assistantText, state);
        messages.push({ role: "assistant", content: assistantText });
        return {
          assistantText,
          queryResult: state.lastQueryResult
            ? { data: state.lastQueryResult, sql: state.lastQuerySQL }
            : undefined,
          visualizations: state.pendingVisualizations.length > 0
            ? state.pendingVisualizations
            : undefined,
          layerUpdates: state.pendingLayerUpdates.length > 0
            ? state.pendingLayerUpdates
            : undefined,
          patches: state.pendingPatches.length > 0
            ? state.pendingPatches
            : undefined,
          rejectedPatches: state.rejectedPatches.length > 0
            ? state.rejectedPatches
            : undefined,
          // Plan 003 / Unit A1 — host-UI banner inputs. Always returned
          // (even empty) so consumers can rely on shape stability.
          toolTagsByName,
          toolCallsThisTurn: state.toolCallsThisTurn,
          messages,
          perServer,
        };
      }

      messages.push({
        role: "assistant",
        content: stripThinkTags(
          inlineResidualContent !== null
            ? inlineResidualContent
            : (typeof message.content === "string" ? message.content : ""),
        ),
        tool_calls: toolCalls,
      });

      // All tool calls go directly to MCP servers — no discover_tools interception.
      // Plan 2026-05-08-003: per-round "calling_tools"/null toggle replaced
      // with per-tool start/complete events fired from inside processToolCalls.
      let { hadError, lastErr, failedSignatures } = await processToolCalls(
        toolCalls, messages, connections, toolServerMap, state, text,
        {
          toolCategories, beforeToolExecution, toolErrorCheck, afterToolExecution, onToolStatus,
          cacheOptions,
        },
      );

      // Extension point: early return for terminal results
      if (!hadError && earlyReturnCheck) {
        const earlyResult = earlyReturnCheck(state, messages);
        if (earlyResult) return {
          ...earlyResult,
          perServer,
          toolTagsByName,
          toolCallsThisTurn: state.toolCallsThisTurn,
        };
      }

      // Visualizations are accumulated in state.pendingVisualizations but do NOT
      // trigger an early return. The LLM may need additional rounds (e.g., create
      // a variable input in round 1, then render a plugin in round 2). The normal
      // "no tool calls" exit at the top of the loop includes pendingVisualizations.

      if (!hadError) {
        continue;
      }

      // Error handling + repair loop
      // Guard uses `hadError` alone — lastErr can be falsy (empty string) when
      // toolErrorCheck returns "". Both cases must enter this block.
      if (hadError) {
        const errorMsg = lastErr || "Tool call failed with unknown error.";
        let repeatedSignature = null;
        for (const sig of failedSignatures) {
          failedSigCounts[sig] = (failedSigCounts[sig] ?? 0) + 1;
          if (failedSigCounts[sig] >= 2) repeatedSignature = sig;
        }

        // When repair attempts are disabled (MAX_TOOL_REPAIR_ATTEMPTS=0),
        // inject a repair message for context and let the LLM retry naturally
        // on the next loop iteration. Do NOT continue unconditionally here —
        // the LLM gets one chance to self-correct via the normal loop.
        if (MAX_TOOL_REPAIR_ATTEMPTS <= 0) {
          if (repeatedSignature && repairMessageBuilder) {
            // Defensive: if a caller's builder returns a role: "system"
            // message it would break strict alternation on providers like
            // Ollama Cloud. Route through applyExtensionMessage so the
            // content is merged into a trailing user turn instead.
            messages = applyExtensionMessage(
              messages,
              repairMessageBuilder(errorMsg, text, repeatedSignature),
            );
          } else {
            // _internal: true marks this as a protocol message the LLM
            // needs to see for retry context, but the UI must hide. Without
            // the flag, ChatLog renders this as a fake user-typed bubble
            // saying "Tool error: ...", which looks like the user did
            // something they didn't.
            messages.push({
              role: "user",
              content: `Tool error: ${errorMsg}. Please try a different approach.`,
              _internal: true,
            });
          }
          continue;
        }

        for (let attempt = 1; attempt <= MAX_TOOL_REPAIR_ATTEMPTS; attempt += 1) {
          if (repairMessageBuilder) {
            messages = applyExtensionMessage(
              messages,
              repairMessageBuilder(errorMsg, text, repeatedSignature),
            );
          } else {
            messages.push({
              role: "user",
              content: `Tool error: ${errorMsg}. Please fix and try again.`,
              _internal: true,
            });
          }

          let repairResponse;
          try {
            repairResponse = await streamWithAdapter({
              messages, tools: selectedTools, model, modelMetadata, thinkingEnabled,
              onThinkingChunk, onContentChunk, providerConfig, csrfToken, signal,
            });
          } catch (error) {
            lastErr = `LLM error during repair attempt ${attempt}: ${String(error?.message ?? error)}`;
            continue;
          }

          const repairMessage = getMessage(repairResponse);
          let repairCalls = Array.isArray(repairMessage.tool_calls) ? repairMessage.tool_calls : [];
          let repairInlineResidual = null;
          if (!repairCalls.length) {
            const { calls, residualContent } = extractInlineToolCallsWithResidual(
              typeof repairMessage.content === "string" ? repairMessage.content : "",
            );
            if (calls.length) {
              repairCalls = calls;
              repairInlineResidual = residualContent;
            }
          }
          if (!repairCalls.length) {
            lastErr = "Model did not return tool_calls; it responded with text instead.";
            continue;
          }

          messages.push({
            role: "assistant",
            content: stripThinkTags(
              repairInlineResidual !== null
                ? repairInlineResidual
                : (typeof repairMessage.content === "string" ? repairMessage.content : ""),
            ),
            tool_calls: repairCalls,
          });

          // Plan 2026-05-08-003: per-tool events fire from inside
          // processToolCalls; no per-round toggle needed here.
          ({ hadError, lastErr, failedSignatures } = await processToolCalls(
            repairCalls, messages, connections, toolServerMap, state, text,
            {
              toolCategories, beforeToolExecution, toolErrorCheck, afterToolExecution, onToolStatus,
              cacheOptions,
            },
          ));

          for (const sig of failedSignatures) {
            failedSigCounts[sig] = (failedSigCounts[sig] ?? 0) + 1;
            if (failedSigCounts[sig] >= 2) repeatedSignature = sig;
          }

          if (!hadError && earlyReturnCheck) {
            const repairEarlyResult = earlyReturnCheck(state, messages);
            if (repairEarlyResult) return {
              ...repairEarlyResult,
              perServer,
              toolTagsByName,
              toolCallsThisTurn: state.toolCallsThisTurn,
            };
          }

          if (!hadError) {
            break;
          }
        }
        continue;
      }
    }
  } finally {
    await closeAllMcpConnections(connections);
  }
}
