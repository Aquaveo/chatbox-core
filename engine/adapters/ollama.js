/**
 * Ollama Cloud streaming adapter.
 * Routes through Django Ollama proxy (/ollama-proxy/) to avoid CORS.
 * Parses Ollama's NDJSON streaming format.
 * For local Ollama, use the OpenAI adapter with baseUrl="http://localhost:11434/v1".
 */
import { mergeToolCalls } from "../../helpers/index.js";

/**
 * Walk `messages` and stringify any `tool_calls[i].function.arguments` that
 * is currently an object. Recent Ollama versions reject object-typed
 * arguments on /api/chat with
 *
 *   400 json: cannot unmarshal object into Go struct field
 *   .messages.tool_calls.function.arguments of type string
 *
 * because the native API now follows OpenAI's stringified-JSON wire format.
 * Observed 2026-05-10 on qwen3:latest. Strings pass through unchanged
 * (no double-encoding). The caller's array is NOT mutated — we build a
 * shallow-then-deep clone of just the message rows that need rewriting.
 *
 * Mirrors the same discipline anthropic.js applies on the receive side
 * (engine/adapters/anthropic.js:150 stores args as a string).
 */
function normalizeToolCallArgsForWire(messages) {
  if (!Array.isArray(messages)) return messages;
  let touched = false;
  const out = messages.map((msg) => {
    if (!msg || typeof msg !== "object") return msg;
    const toolCalls = msg.tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return msg;

    let toolCallsTouched = false;
    const rewritten = toolCalls.map((tc) => {
      const fn = tc?.function;
      if (!fn || typeof fn !== "object") return tc;
      const args = fn.arguments;
      if (typeof args === "string" || args === undefined || args === null) {
        return tc;
      }
      // Object / array — stringify for the wire.
      toolCallsTouched = true;
      return { ...tc, function: { ...fn, arguments: JSON.stringify(args) } };
    });

    if (!toolCallsTouched) return msg;
    touched = true;
    return { ...msg, tool_calls: rewritten };
  });
  return touched ? out : messages;
}

export async function streamChat({
  provider, baseUrl, apiKey, model,
  messages, tools, csrfToken, signal,
  onThinkingChunk, onContentChunk,
}) {
  const proxyBase = "/apps/tethysdash/ollama-proxy";

  const body = {
    model,
    messages: normalizeToolCallArgsForWire(messages),
    tools: tools?.length ? tools : undefined,
    stream: true,
    options: { temperature: 0, num_ctx: 16384 },
  };

  const response = await fetch(`${proxyBase}/api/chat/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(csrfToken ? { "x-csrftoken": csrfToken } : {}),
      ...(baseUrl ? { "x-ollama-host": baseUrl } : {}),
      ...(apiKey ? { "x-ollama-key": apiKey } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "Unknown error");
    let upstreamMessage = null;
    try {
      const parsed = JSON.parse(errText);
      if (parsed && typeof parsed.error === "string" && parsed.error) {
        upstreamMessage = parsed.error;
      }
    } catch { /* not JSON — fall through to legacy wrapping */ }
    if (upstreamMessage) {
      const refMatch = upstreamMessage.match(/\s*\(ref:\s*([^)]+)\)\s*$/);
      let displayMessage = upstreamMessage;
      if (refMatch) {
        displayMessage = upstreamMessage.slice(0, refMatch.index).trimEnd();
        console.info(`[Ollama error ref] ${refMatch[1].trim()} — model=${model}`);
      }
      throw new Error(`Ollama (${model}): ${displayMessage}`);
    }
    throw new Error(`Ollama proxy returned ${response.status}: ${errText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const mergedMessage = { role: "assistant", content: "", thinking: "", tool_calls: null };
  let thinkingBuffer = "";
  let lastFlushMs = Date.now();

  const flushThinking = async (force = false) => {
    if (!thinkingBuffer) return;
    const shouldFlush = force || thinkingBuffer.length >= 80 ||
      /[.!?\n:]$/.test(thinkingBuffer) || Date.now() - lastFlushMs >= 400;
    if (!shouldFlush) return;
    onThinkingChunk?.(thinkingBuffer);
    thinkingBuffer = "";
    lastFlushMs = Date.now();
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (signal?.aborted) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let chunk;
      try { chunk = JSON.parse(trimmed); } catch { continue; }

      const msg = chunk?.message;
      if (msg && typeof msg === "object") {
        if (typeof msg.thinking === "string" && msg.thinking) {
          mergedMessage.thinking += msg.thinking;
          thinkingBuffer += msg.thinking;
          await flushThinking(false);
        }
        if (typeof msg.content === "string" && msg.content) {
          mergedMessage.content += msg.content;
          onContentChunk?.(msg.content);
        }
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
          mergedMessage.tool_calls = mergeToolCalls(mergedMessage.tool_calls ?? [], msg.tool_calls);
        }
      }
    }
  }

  await flushThinking(true);
  if (mergedMessage.tool_calls === null) {
    delete mergedMessage.tool_calls;
  } else {
    // Normalize on the receive side too: Ollama's native /api/chat streams
    // tool_calls.function.arguments as an object, but the rest of the
    // engine (engine/index.js:746-748, helpers/anthropic.js:150) treats
    // `arguments` as a JSON string. Stringify here so the assistant
    // message pushed into history matches that contract — defense in
    // depth against any code path that reads tool_calls before the
    // send-side normalization runs.
    for (const tc of mergedMessage.tool_calls) {
      const fn = tc?.function;
      if (!fn) continue;
      if (fn.arguments !== undefined && fn.arguments !== null && typeof fn.arguments !== "string") {
        fn.arguments = JSON.stringify(fn.arguments);
      }
    }
  }
  return { message: mergedMessage };
}
