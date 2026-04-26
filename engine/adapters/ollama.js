/**
 * Ollama Cloud streaming adapter.
 * Routes through Django Ollama proxy (/ollama-proxy/) to avoid CORS.
 * Parses Ollama's NDJSON streaming format.
 * For local Ollama, use the OpenAI adapter with baseUrl="http://localhost:11434/v1".
 */
import { mergeToolCalls } from "../../helpers/index.js";

export async function streamChat({
  provider, baseUrl, apiKey, model,
  messages, tools, csrfToken, signal,
  onThinkingChunk, onContentChunk,
}) {
  const proxyBase = "/apps/tethysdash/ollama-proxy";

  const body = {
    model,
    messages,
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
  if (mergedMessage.tool_calls === null) delete mergedMessage.tool_calls;
  return { message: mergedMessage };
}
