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

function parseFirstJsonObject(text, startIndex) {
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
        try { return JSON.parse(raw); } catch { return null; }
      }
    }
  }
  return null;
}

export function extractInlineToolCalls(text) {
  if (typeof text !== "string" || !text.trim()) return [];

  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "{") continue;
    const obj = parseFirstJsonObject(text, i);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;

    const name = obj.name ?? obj.tool ?? obj.tool_name;
    const args = obj.parameters ?? obj.arguments ?? obj.params ?? obj.args;

    if (
      typeof name === "string" &&
      name &&
      (typeof args === "string" || (args && typeof args === "object" && !Array.isArray(args)))
    ) {
      return [{ function: { name, arguments: args } }];
    }
  }
  return [];
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
    const response = await fetch("/apps/tethysdash/ollama-proxy/api/tags/", {
      headers: {
        ...(csrf ? { "x-csrftoken": csrf } : {}),
        ...(baseUrl ? { "x-ollama-host": baseUrl } : {}),
        ...(apiKey ? { "x-ollama-key": apiKey } : {}),
      },
    });
    if (!response.ok) throw new Error(`Failed to load Ollama models (${response.status})`);
    const data = await response.json();
    return (data?.models || []).map((m) => ({
      name: m.name || m.model,
      contextLength: 8192,
      capabilities: [],
    }));
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
        capabilities: [],
      });
    }
    return models;
  } catch (err) {
    throw new Error(`Failed to load models: ${err.message}`);
  }
}
