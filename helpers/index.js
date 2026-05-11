/**
 * helpers.js — Generic utility functions for the chatbox.
 *
 * Model loading, URL normalization, JSON parsing, tool call extraction.
 * NO domain-specific logic (no NRDS, S3, hydrofabric, parquet).
 */

// ---------------------------------------------------------------------------
// Date
// ---------------------------------------------------------------------------

export function denverTodayIso() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const map = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return `${map.year}-${map.month}-${map.day}`;
}

// ---------------------------------------------------------------------------
// Text processing
// ---------------------------------------------------------------------------

export function stripThinkTags(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^submitButton\s*/i, "")
    .trim();
}

// ---------------------------------------------------------------------------
// Tool call merging
// ---------------------------------------------------------------------------

export function mergeToolCalls(existing = [], incoming = []) {
  const merged = existing.map((call) => ({
    ...call,
    function: { ...(call?.function ?? {}) },
  }));

  for (const call of incoming) {
    if (!call || typeof call !== "object") continue;

    // Use the tool call's index field to identify which call this chunk belongs to.
    // OpenAI streaming sends index: 0, 1, etc. for each tool call in a response.
    // If no index, append as a new tool call.
    const idx = typeof call.index === "number" ? call.index : merged.length;

    if (idx >= merged.length) {
      // New tool call — initialize it
      merged[idx] = {
        ...call,
        function: { ...(call.function ?? {}) },
      };
      continue;
    }

    // Existing tool call — merge streaming chunks
    const current = merged[idx];
    const currentFn = current.function ?? {};
    const nextFn = call.function ?? {};

    const currArgs = currentFn.arguments;
    const nextArgs = nextFn.arguments;

    let mergedArgs = currArgs;

    if (typeof currArgs === "string" && typeof nextArgs === "string") {
      // String + string: concatenate (OpenAI streams JSON fragments as strings)
      mergedArgs = currArgs + nextArgs;
    } else if (nextArgs !== undefined) {
      // Object or first value: replace (complete argument set, not a fragment)
      mergedArgs = nextArgs;
    }

    merged[idx] = {
      ...current,
      ...call,
      function: {
        name: nextFn.name || currentFn.name,
        arguments: mergedArgs,
      },
    };
  }

  return merged;
}

// ---------------------------------------------------------------------------
// JSON parsing
// ---------------------------------------------------------------------------

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object") {
    const sorted = {};
    Object.keys(value)
      .sort()
      .forEach((key) => {
        sorted[key] = sortObject(value[key]);
      });
    return sorted;
  }
  return value;
}

export function maybeParseJson(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// Inline tool call extraction
// ---------------------------------------------------------------------------

// Returns { obj, end } where end is the index of the closing brace, or null if
// the text starting at startIndex is not a balanced JSON object.
function parseJsonObjectAtIndex(text, startIndex) {
  if (text[startIndex] !== "{") return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIndex; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') { inString = true; continue; }
    if (ch === "{") { depth += 1; continue; }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const raw = text.slice(startIndex, i + 1);
        try { return { obj: JSON.parse(raw), end: i }; } catch { return null; }
      }
    }
  }
  return null;
}

// Names a JSON object can use to identify itself as a tool call. Includes the
// usual provider conventions (`name`, `tool_name`) plus the `tool` and
// `function.name` shapes models occasionally emit when imitating tool-call
// JSON they've seen in training data.
function readToolCallName(obj) {
  if (typeof obj.name === "string" && obj.name) return obj.name;
  if (typeof obj.tool === "string" && obj.tool) return obj.tool;
  if (typeof obj.tool_name === "string" && obj.tool_name) return obj.tool_name;
  if (
    obj.function && typeof obj.function === "object" &&
    typeof obj.function.name === "string" && obj.function.name
  ) {
    return obj.function.name;
  }
  return null;
}

// Args-field aliases. The first four are the structured-output conventions
// across providers; the rest are added because non-tool-calling-native
// models (Ollama gemma3 variants observed 2026-05-04) emit tool-call-shaped
// JSON using whatever key the model invented — `query`, `action`, `input`,
// `request`. Detecting them lets the engine attempt the call (and fail
// loudly through the existing tool-error path) rather than rendering raw
// JSON to the user as if it were an answer.
function readToolCallArgs(obj) {
  for (const key of [
    "parameters", "arguments", "params", "args",
    "query", "input", "message", "action", "request", "payload",
  ]) {
    if (key in obj) {
      const value = obj[key];
      if (typeof value === "string") return value;
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    }
  }
  // function.arguments / function.parameters shape
  if (obj.function && typeof obj.function === "object") {
    for (const key of ["arguments", "parameters", "args"]) {
      const value = obj.function[key];
      if (typeof value === "string") return value;
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    }
  }
  return null;
}

// Strip the matched JSON spans (and surrounding markdown fence markers, if
// present) from `text`, then collapse the resulting whitespace. The goal is
// that `residualContent` reads as the model's prose with the tool-call JSON
// removed — what a user should see in a chat bubble.
function stripMatchedSpans(text, matches) {
  if (!matches.length) return text;

  // Sort by start index so we can walk the text in order.
  const ordered = matches.slice().sort((a, b) => a.start - b.start);
  const pieces = [];
  let cursor = 0;

  for (const { start, end } of ordered) {
    pieces.push(text.slice(cursor, start));
    cursor = end + 1;
  }
  pieces.push(text.slice(cursor));

  let residual = pieces.join("");

  // Remove orphan markdown fence markers (```json, ```javascript, ```, etc.)
  // that surrounded a JSON block we just stripped out.
  residual = residual.replace(/```[a-zA-Z0-9]*\s*\n?\s*\n?```/g, "");
  residual = residual.replace(/```[a-zA-Z0-9]*\s*$/gm, "");
  residual = residual.replace(/^```\s*$/gm, "");

  // Collapse 3+ consecutive blank lines down to 2 (paragraph break).
  residual = residual.replace(/\n{3,}/g, "\n\n");

  return residual.trim();
}

// Detect refusal text from models that have been told they're "tool-using
// AI assistants" but lack reliable tool-calling support (gemma3 variants,
// some smaller Ollama models). When a tool-incapable model receives a
// system prompt containing tool definitions, it sometimes locks up and
// emits a refusal like "I am a tool-using AI assistant and cannot provide
// directions." instead of answering from its own knowledge — even when the
// question doesn't actually need tools.
//
// Legacy detector retained for downstream callers and tests. The engine no
// longer uses this to retry without tools or disable tools; TethysDash
// workflows keep MCP tools available. False positives are minimized by
// requiring BOTH a tool-framing phrase AND a refusal phrase, and by capping
// the matching window so a long legitimate answer that mentions tool-using AI
// in passing doesn't match.
export function looksLikeToolRefusal(text) {
  if (typeof text !== "string" || !text.trim()) return false;
  if (text.length > 400) return false;

  const hasToolFraming =
    /\btool[-\s]?using\b/i.test(text) ||
    /\btool[-\s]?calling\b/i.test(text) ||
    /\bfunction[-\s]?calling\b/i.test(text) ||
    /\bperform tool calls?\b/i.test(text) ||
    /\b(?:i\s+(?:am|'m)\s+)?(?:an?\s+)?ai\s+assistant\b[\s\S]{0,80}\btool/i.test(text);

  // Direct refusal phrasings naming tools as the obstacle. These match
  // independently of tool-using/tool-calling framing because "I cannot
  // use any tools" is an unambiguous tool refusal on its own.
  const directToolRefusal =
    /\b(?:cannot|can'?t|unable to|don'?t|do not)\s+(?:use|call|invoke|access|reach)\s+(?:any\s+|the\s+|these\s+|those\s+|the\s+available\s+)?tools?\b/i.test(text);

  const hasRefusal =
    /\bcannot\b/i.test(text) ||
    /\bcan'?t\b/i.test(text) ||
    /\bunable to\b/i.test(text) ||
    /\bdo(?:es)?\s+not\b/i.test(text) ||
    /\bdon'?t\b/i.test(text);

  return directToolRefusal || (hasToolFraming && hasRefusal);
}

// Detect JSON objects that look like tool-call attempts but couldn't be
// parsed into structured calls (e.g., the model invented an unknown args
// key). These should still be stripped from user-visible content because
// rendering raw tool-call JSON as a chat answer is always worse than a
// short fallback message. Returns the same shape as the main extractor
// but with `unrecognizedToolAttempt: true` flag and zero calls.
export function detectAndStripToolShapedJson(text) {
  if (typeof text !== "string" || !text.trim()) {
    return { stripped: typeof text === "string" ? text : "", hadToolShapedJson: false };
  }

  const matches = [];
  let i = 0;

  while (i < text.length) {
    if (text[i] !== "{") { i += 1; continue; }
    const parsed = parseJsonObjectAtIndex(text, i);
    if (!parsed) { i += 1; continue; }

    const { obj, end } = parsed;
    if (obj && typeof obj === "object" && !Array.isArray(obj) && readToolCallName(obj)) {
      // This JSON has a tool/name/function field — it's a tool-call attempt
      // even if we can't recognize its args shape. Strip it.
      matches.push({ start: i, end });
    }
    i = end + 1;
  }

  if (!matches.length) return { stripped: text, hadToolShapedJson: false };
  return { stripped: stripMatchedSpans(text, matches), hadToolShapedJson: true };
}

// Walk `text` looking for tool-call-shaped JSON objects. Returns the array of
// extracted calls AND the residual text with those JSON blocks removed.
//
// Use this from inside the engine so the assistant message pushed to history
// contains only the prose (and the tool_calls field carries the structured
// invocation). Without residual stripping, the raw JSON renders as an
// assistant-bubble code block in the UI (observed bug: gemma3:12b emitting
// `{"tool": "discovery", "query": "..."}` directly into chat 2026-05-04).
export function extractInlineToolCallsWithResidual(text) {
  if (typeof text !== "string" || !text.trim()) {
    return { calls: [], residualContent: typeof text === "string" ? text : "" };
  }

  const calls = [];
  const matches = [];
  let i = 0;

  while (i < text.length) {
    if (text[i] !== "{") { i += 1; continue; }

    const parsed = parseJsonObjectAtIndex(text, i);
    if (!parsed) { i += 1; continue; }

    const { obj, end } = parsed;

    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const name = readToolCallName(obj);
      const args = readToolCallArgs(obj);

      if (name && args !== null) {
        calls.push({ function: { name, arguments: args } });
        matches.push({ start: i, end });
      }
    }

    i = end + 1;
  }

  const residualContent = stripMatchedSpans(text, matches);
  return { calls, residualContent };
}

// Public API: returns just the calls array. Existing consumers continue to
// work; the engine prefers `extractInlineToolCallsWithResidual` because it
// also needs the cleaned content.
export function extractInlineToolCalls(text) {
  return extractInlineToolCallsWithResidual(text).calls;
}

// ---------------------------------------------------------------------------
// Response / args utilities
// ---------------------------------------------------------------------------

export function getMessage(resp) {
  if (!resp || typeof resp !== "object") return {};
  const message = resp.message;
  if (!message || typeof message !== "object") return {};
  return message;
}

export function omitEmptyArgs(args) {
  const cleaned = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (value === null || value === undefined || value === "") continue;
    cleaned[key] = value;
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// Ollama Cloud model-origin policy filter
// ---------------------------------------------------------------------------
// Policy: when the Ollama provider is pointed at Ollama Cloud
// (https://ollama.com), drop entries whose name starts with a known
// Chinese-origin model family prefix. Local / self-hosted Ollama is
// not filtered. This is a *policy* filter on a finite catalog — it is
// deliberately a name-prefix denylist, distinct from the capability /
// routing layer (which stays model-agnostic).
//
// To add a new family, append a lowercase prefix below.
export const CHINESE_MODEL_PREFIXES = Object.freeze([
  "qwen",
  "deepseek",
  "glm",
  "chatglm",
  "yi",
  "baichuan",
  "ernie",
  "hunyuan",
  "minicpm",
  "xverse",
  "internlm",
  "skywork",
]);

export function isBlockedChineseModel(name) {
  if (typeof name !== "string" || !name) return false;
  // Tolerate registry prefixes like "ollama.com/library/qwen2.5:7b".
  const lastSegment = name.toLowerCase().split("/").pop();
  return CHINESE_MODEL_PREFIXES.some((prefix) => lastSegment.startsWith(prefix));
}

export function isOllamaCloudHost(baseUrl) {
  if (typeof baseUrl !== "string" || !baseUrl) return false;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(baseUrl)
      ? baseUrl
      : `https://${baseUrl}`;
    const host = new URL(withScheme).hostname.toLowerCase();
    return host === "ollama.com" || host === "www.ollama.com";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Model loading (generic, proxy-based)
// ---------------------------------------------------------------------------

export async function listModels(providerConfig = {}, options = {}) {
  const { provider = "custom", baseUrl = "", apiKey = "" } = providerConfig;

  if (provider === "anthropic") {
    try {
      const resp = await fetch("https://api.anthropic.com/v1/models?limit=50", {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
      });
      if (!resp.ok) throw new Error(`${resp.status}`);
      const json = await resp.json();
      return (json?.data || []).map((m) => ({
        name: m.id,
        displayName: m.display_name || m.id,
        contextLength: m.max_input_tokens || 200000,
        maxTokens: m.max_tokens,
        capabilities: ["tools"],
        thinkingTypes: m.capabilities?.thinking?.types || null,
      }));
    } catch (err) {
      console.warn("Anthropic models API failed, using fallback list:", err.message);
      return [
        { name: "claude-sonnet-4-20250514", contextLength: 200000, capabilities: ["tools"], thinkingTypes: { enabled: { supported: true }, adaptive: { supported: false } } },
        { name: "claude-haiku-4-20250414", contextLength: 200000, capabilities: ["tools"], thinkingTypes: { enabled: { supported: true }, adaptive: { supported: false } } },
        { name: "claude-opus-4-20250514", contextLength: 200000, capabilities: ["tools"], thinkingTypes: { enabled: { supported: true }, adaptive: { supported: false } } },
      ];
    }
  }

  if (provider === "ollama") {
    const csrf = typeof options?.csrfToken === "string" ? options.csrfToken : "";
    const headers = {
      ...(csrf ? { "x-csrftoken": csrf } : {}),
      ...(baseUrl ? { "x-ollama-host": baseUrl } : {}),
      ...(apiKey ? { "x-ollama-key": apiKey } : {}),
    };
    const response = await fetch("/apps/tethysdash/ollama-proxy/api/tags/", { headers });
    if (!response.ok) throw new Error(`Failed to load Ollama models (${response.status})`);
    const data = await response.json();
    const models = data?.models || [];

    // Per-model capability discovery via /api/show. Ollama returns a
    // top-level `capabilities` array (e.g., ["completion", "tools",
    // "thinking"]) — authoritative metadata Ollama populates during
    // model-card processing. We read it directly rather than parsing
    // template strings (the previous heuristic approach was brittle).
    const showCache = readOllamaShowCache();
    const showHeaders = { ...headers, "Content-Type": "application/json" };

    const showOne = async (m) => {
      const name = m.name || m.model;
      const modifiedAt = m.modified_at || "";
      const cacheKey = `${baseUrl || "default"}|${name}|${modifiedAt}`;
      if (showCache[cacheKey]) return { name, ...showCache[cacheKey] };

      try {
        const showResp = await fetch("/apps/tethysdash/ollama-proxy/api/show/", {
          method: "POST",
          headers: showHeaders,
          body: JSON.stringify({ name }),
        });
        if (!showResp.ok) {
          // eslint-disable-next-line no-console
          console.warn(`Ollama /api/show failed for ${name}: ${showResp.status}`);
          return { name, capabilities: [], thinkingTypes: null };
        }
        const showJson = await showResp.json();
        const caps = Array.isArray(showJson?.capabilities) ? showJson.capabilities : [];
        const result = {
          capabilities: caps.includes("tools") ? ["tools"] : [],
          thinkingTypes: caps.includes("thinking") ? { enabled: { supported: true } } : null,
        };
        showCache[cacheKey] = result;
        return { name, ...result };
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`Ollama /api/show errored for ${name}:`, err?.message ?? err);
        return { name, capabilities: [], thinkingTypes: null };
      }
    };

    const enriched = await mapWithConcurrency(models, 4, showOne);
    writeOllamaShowCache(showCache);

    const result = models.map((m, i) => ({
      name: m.name || m.model,
      contextLength: 8192,
      capabilities: enriched[i]?.capabilities ?? [],
      thinkingTypes: enriched[i]?.thinkingTypes ?? null,
    }));

    if (isOllamaCloudHost(baseUrl)) {
      return result.filter((m) => !isBlockedChineseModel(m.name));
    }
    return result;
  }

  const OpenAI = (await import("openai")).default;
  const client = new OpenAI({
    baseURL: baseUrl || "https://api.openai.com/v1",
    apiKey: apiKey || "not-needed",
    dangerouslyAllowBrowser: true,
  });

  try {
    const response = await client.models.list();
    const models = [];
    for await (const model of response) {
      models.push({
        name: model.id,
        contextLength: 8192,
        capabilities: openAiSupportsTools(model.id) ? ["tools"] : [],
      });
    }
    return models;
  } catch (err) {
    throw new Error(`Failed to load models: ${err.message}`);
  }
}

// Lightweight name-pattern check for OpenAI tool-capable models. All current
// chat-completion families (gpt-3.5+, gpt-4*, gpt-5*, o-series, chatgpt-*)
// support tools. Fine-tunes (`ft:gpt-4o-mini-...`) inherit base-model
// capability: strip the `ft:` prefix and re-test against the same patterns.
// Embedding/legacy models (text-embedding-*, text-davinci-*) won't match
// and stay with empty capabilities.
const OPENAI_TOOLS_PATTERN = /^(gpt-3\.5|gpt-4|gpt-5|o[1-9]|chatgpt-)/i;
export function openAiSupportsTools(modelName) {
  if (typeof modelName !== "string" || !modelName) return false;
  if (modelName.startsWith("ft:")) {
    // Fine-tune format: `ft:<base-model>:<org>::<id>`. Test the base name.
    const baseName = modelName.slice(3).split(":")[0];
    return OPENAI_TOOLS_PATTERN.test(baseName);
  }
  return OPENAI_TOOLS_PATTERN.test(modelName);
}

// Bound concurrent fan-out (e.g., parallel /api/show calls). Without this,
// a user with N Ollama models triggers N simultaneous proxy POSTs, which
// exhausts Django sync workers and bursts the upstream Ollama host. Inline
// implementation avoids adding p-limit as a dependency.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// Cache /api/show capability lookups in localStorage keyed by
// (host, modelName, modifiedAt). Capabilities only change when the model
// itself is rebuilt (which bumps modified_at), so the cache is stable
// across sessions. Fail-open if storage is unavailable (private mode,
// SSR) — the lookups still work, they just don't cache.
const OLLAMA_SHOW_CACHE_KEY = "@chatbox/core:ollamaShowCache:v1";
function readOllamaShowCache() {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(OLLAMA_SHOW_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function writeOllamaShowCache(cache) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(OLLAMA_SHOW_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Quota / private-mode — silently skip persistence.
  }
}
