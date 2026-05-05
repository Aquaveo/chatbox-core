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
  looksLikeToolRefusal,
  maybeParseJson,
  omitEmptyArgs,
  mergeToolCalls,
  stripThinkTags,
} from "../helpers/index.js";
import {
  getOverride as getCapabilityOverride,
  recordFailure,
  resetFailureCounter,
} from "../storage/capabilityStorage.js";
import {
  pickTransport,
  closeMcpConnection,
  withTimeout,
  LIST_TOOLS_BUDGET_MS,
} from "./transports.js";
import { ERROR_KEYS } from "./mcpErrors.js";
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

const TOOL_BUDGET = 25;

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
 * Resolve a model's tool-use capability from a populated model list and
 * provider context.
 *
 * Lookup order:
 *   1. modelList entry — if found, use its `capabilities` array.
 *   2. Per-provider fallback default:
 *        anthropic, openai → "supported" (these providers either return
 *          the capability via API or are name-pattern-matched in
 *          listModels; if a model isn't on the list at all, we still
 *          trust the provider since these are well-known tool-capable
 *          ecosystems and any genuine outlier gets caught by auto-learn).
 *        ollama → "unknown" — Ollama models without a populated
 *          capabilities entry are signal-less and default to safe-off.
 *        custom → "unknown" — no signal available; engine treats unknown
 *          for custom as tools-ON per Plan 002 R5 (tethysdash value loop
 *          is tool-driven; loud refusal is preferable to silent failure).
 *
 * Returns: `"supported"` | `"unsupported"` | `"unknown"`.
 *
 * Pure function — no I/O, exported for unit testing.
 */
export function resolveModelCapability(modelName, modelList, providerName) {
  // Override store wins (auto-learned + future user overrides). Lookup is
  // a localStorage read with TTL + schema-version check; expired or
  // invalid entries are ignored automatically.
  const override = getCapabilityOverride(providerName, modelName);
  if (override) return override.toolUse;

  if (Array.isArray(modelList)) {
    const entry = modelList.find((m) => m?.name === modelName);
    if (entry && Array.isArray(entry.capabilities)) {
      return entry.capabilities.includes("tools") ? "supported" : "unsupported";
    }
  }
  if (providerName === "anthropic" || providerName === "openai") return "supported";
  return "unknown";
}

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
      const conn = await pickTransport(server.url);
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

  return { connections, tools, toolServerMap, toolsByServer, classificationByServer, perServer };
}

async function closeAllMcpConnections(connections) {
  for (const conn of connections) {
    await closeMcpConnection(conn);
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

async function streamWithAdapter({
  messages, tools, model, thinkingEnabled,
  onThinkingChunk, onContentChunk, providerConfig, csrfToken, signal,
}) {
  const { provider } = providerConfig;
  const adapter = PROVIDER_ADAPTERS[provider] || openaiStreamChat;

  return adapter({
    ...providerConfig,
    model,
    messages,
    tools,
    csrfToken,
    signal,
    onThinkingChunk: thinkingEnabled ? onThinkingChunk : undefined,
    onContentChunk,
  });
}

// ---------------------------------------------------------------------------
// Generic Tool Processing
// ---------------------------------------------------------------------------

export async function processToolCalls(
  toolCalls, messages, connections, toolServerMap, state, originalUserText,
  { toolCategories, beforeToolExecution, toolErrorCheck, afterToolExecution },
) {
  let hadError = false;
  let lastErr = null;
  const failedSignatures = [];

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

    const toolResult = await executeTool(toolName, args, connections, toolServerMap);

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

    // Collect visualization specs from the ORIGINAL result (before truncation)
    if (toolResult && typeof toolResult === "object" && toolResult.visualization) {
      state.pendingVisualizations.push(toolResult.visualization);
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

    // Truncate large results before storing in conversation history
    let resultContent = toolResult && typeof toolResult === "object"
      ? JSON.stringify(toolResult)
      : String(toolResult ?? "");

    if (resultContent.length > MAX_TOOL_RESULT_CHARS) {
      if (toolResult?.visualization) {
        // Preserve visualization reference in a compact summary
        resultContent = JSON.stringify({
          visualization: { source: toolResult.visualization.source, vizType: toolResult.visualization.vizType },
          _truncated: true,
          _originalChars: resultContent.length,
        });
      } else {
        const originalLen = resultContent.length;
        resultContent = resultContent.slice(0, MAX_TOOL_RESULT_CHARS)
          + `\n...[truncated, full result was ${originalLen} chars]`;
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
  thinkingEnabled,
  onThinkingChunk,
  onContentChunk,
  onContentReset,
  onToolStatus,
  // Plan 002: fired once per (session × model × source) when the engine
  // gates tools off for the active model. The consumer renders a UI-only
  // notice; the event content never enters `messages` (avoids self-
  // reference pathology where small models fixate on their disabled state).
  onSessionNotice,
  signal,
  providerConfig = { provider: "custom", baseUrl: "", apiKey: "" },
  csrfToken = "",
  mcpServerUrl = DEFAULT_MCP_SERVER_URL,
  mcpServers,
  history,
  maxContextTokens,
  // Plan 002: populated model list from listModels() so the engine can
  // resolve the active model's capability without re-fetching. The
  // consumer (Chatbox.jsx) already maintains this list for the dropdown.
  modelList = [],

  // Extension points (all optional — defaults produce a generic chatbox)
  systemPromptBuilder = buildGenericSystemMessage,
  toolCategories = null,
  earlyReturnCheck = null,
  beforeToolExecution = null,
  toolErrorCheck = null,
  repairMessageBuilder = null,
  beforeFirstMessage = null,
  afterToolExecution = null,
}) {
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
    // R16 — rejections the engine observed during this turn. Populated
    // from every patch_visualization tool call that returned an {error}
    // instead of a {patch_update}. Surfaced in the runChatSession return
    // so the host chatbox can categorize into user-facing copy buckets.
    rejectedPatches: [],
  };

  // Plan 002: resolve model tool-capability before building the system
  // prompt. Determines whether to pass tools to the adapter, which system-
  // prompt variant to use, and whether to fire a session notice.
  const capability = resolveModelCapability(model, modelList, providerConfig?.provider);
  // Engine treats tools as gated when the model is unsupported, OR when
  // the model is unknown for ollama (signal-less but worth being safe).
  // Custom-unknown stays tools-on per R5.
  const toolsGated =
    capability === "unsupported" ||
    (capability === "unknown" && providerConfig?.provider === "ollama");

  let messages =
    Array.isArray(history) && history.length > 0
      ? [...history]
      : [systemPromptBuilder({ toolsAvailable: !toolsGated })];

  // Fire the session notice once per turn when gated. Consumer dedups
  // across turns within the same browser session.
  if (toolsGated && typeof onSessionNotice === "function") {
    // Look up the display name from the model list when available.
    const modelEntry = Array.isArray(modelList)
      ? modelList.find((m) => m?.name === model)
      : null;
    const displayName = modelEntry?.displayName || model;
    onSessionNotice({
      type: "tools_disabled",
      model,
      displayName,
      provider: providerConfig?.provider,
      // `source` distinguishes registry-based gating from auto-learned
      // overrides. For now (Unit 2 scope), the source is always the
      // provider signal; Unit 3 will introduce the "auto-learned" source.
      source: "provider-signal",
    });
  }

  const text = typeof prompt === "string" ? prompt : "";

  const servers = Array.isArray(mcpServers) && mcpServers.length > 0
    ? mcpServers
    : mcpServerUrl
      ? [{ url: mcpServerUrl, name: "Default" }]
      : [];

  const { connections, tools, toolServerMap, toolsByServer, classificationByServer, perServer } =
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
  // When tools are gated off (Plan 002), pass an empty array to the adapter
  // regardless of MCP discovery. Discovery still runs so MCP-related UI
  // surfaces (server status, tool counts) stay accurate.
  const selectedTools = toolsGated
    ? []
    : await selectToolsForPrompt(
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
        return { assistantText: "", messages, aborted: true, perServer };
      }

      const response = await streamWithAdapter({
        messages, tools: selectedTools, model, thinkingEnabled,
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
        const isRefusal = looksLikeToolRefusal(assistantText);

        // Tool-incapable model recovery path: when a model can't reliably
        // use the tools we offered (it either emits raw tool-call-shaped
        // JSON OR refuses with "I am a tool-using AI assistant..."), retry
        // the same request without the tools list so it answers from its
        // own knowledge. Surface a non-blocking UI notice so the user knows
        // the model couldn't use tools.
        const offeredTools = Array.isArray(selectedTools) && selectedTools.length > 0;
        if (offeredTools && (toolShape.hadToolShapedJson || isRefusal)) {
          // Clear streaming buffers so the misleading first-attempt text
          // doesn't flash before the retry's stream replaces it.
          onContentReset?.();

          // Plan 002: record a failure observation. After N=2 consecutive
          // observations for this (provider, model), the override is
          // persisted and future calls skip the wasted refusal turn.
          recordFailure(providerConfig?.provider, model);

          // Plan 002: surface the notice via onSessionNotice (UI-only) —
          // do NOT push a system message into `messages`. Pushing it
          // would (a) violate strict-alternation on Ollama Cloud and
          // (b) cause smaller models to fixate on their own disabled
          // state in subsequent turns. Plan 001's earlier draft pushed
          // the notice into messages; Plan 002 supersedes that.
          if (typeof onSessionNotice === "function") {
            const modelEntry = Array.isArray(modelList)
              ? modelList.find((m) => m?.name === model)
              : null;
            const displayName = modelEntry?.displayName || model;
            onSessionNotice({
              type: "tools_disabled",
              model,
              displayName,
              provider: providerConfig?.provider,
              source: "auto-learned",
            });
          }

          let retryResponse;
          try {
            retryResponse = await streamWithAdapter({
              messages,
              tools: [], // retry without tools
              model,
              thinkingEnabled,
              onThinkingChunk,
              onContentChunk,
              providerConfig,
              csrfToken,
              signal,
            });
          } catch (retryErr) {
            // If the retry itself fails, fall through to surfacing the
            // sanitized first attempt with a fallback message rather than
            // crashing the turn.
            retryResponse = null;
          }

          if (retryResponse) {
            const retryMessage = getMessage(retryResponse);
            assistantText = stripThinkTags(
              typeof retryMessage.content === "string" ? retryMessage.content : "",
            );
            // Belt-and-suspenders: if the retry ALSO emits tool-shaped
            // JSON (model is fundamentally confused), strip and fall back.
            const retryShape = detectAndStripToolShapedJson(assistantText);
            if (retryShape.hadToolShapedJson) {
              assistantText = retryShape.stripped.trim()
                || "I couldn't produce a useful answer for this request. Could you rephrase?";
            }
          } else {
            assistantText = "I couldn't reach the model to answer without tools. Try again, or switch to a tool-capable model.";
          }

          messages.push({ role: "assistant", content: assistantText, ...(toolsGated ? { _toolsGated: true } : {}) });
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
            messages,
            perServer,
          };
        }

        // No retry needed (no tools were offered, OR the model gave a
        // legitimate non-tool answer). If tool-shaped JSON snuck through,
        // strip it and use the residual / fallback.
        if (toolShape.hadToolShapedJson) {
          assistantText = toolShape.stripped.trim()
            || "I tried to use a tool but couldn't complete the request. Could you rephrase?";
        }
        messages.push({ role: "assistant", content: assistantText, ...(toolsGated ? { _toolsGated: true } : {}) });
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
      onToolStatus?.("calling_tools");
      let { hadError, lastErr, failedSignatures } = await processToolCalls(
        toolCalls, messages, connections, toolServerMap, state, text,
        { toolCategories, beforeToolExecution, toolErrorCheck, afterToolExecution },
      );
      onToolStatus?.(null);

      // Plan 002 — auto-learn signal: a turn that successfully called
      // tools (even tools that returned domain {error} envelopes — those
      // count as success because the model used the tool correctly)
      // resets the in-session consecutive-failure counter for this
      // (provider, model). Hard adapter/transport errors leave the
      // counter intact; the next reactive-detection observation will
      // increment it normally.
      if (!hadError) {
        resetFailureCounter(providerConfig?.provider, model);
      }

      // Extension point: early return for terminal results
      if (!hadError && earlyReturnCheck) {
        const earlyResult = earlyReturnCheck(state, messages);
        if (earlyResult) return { ...earlyResult, perServer };
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
              messages, tools: selectedTools, model, thinkingEnabled,
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

          onToolStatus?.("calling_tools");
          ({ hadError, lastErr, failedSignatures } = await processToolCalls(
            repairCalls, messages, connections, toolServerMap, state, text,
            { toolCategories, beforeToolExecution, toolErrorCheck, afterToolExecution },
          ));
          onToolStatus?.(null);

          for (const sig of failedSignatures) {
            failedSigCounts[sig] = (failedSigCounts[sig] ?? 0) + 1;
            if (failedSigCounts[sig] >= 2) repeatedSignature = sig;
          }

          if (!hadError && earlyReturnCheck) {
            const repairEarlyResult = earlyReturnCheck(state, messages);
            if (repairEarlyResult) return { ...repairEarlyResult, perServer };
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
