/**
 * OpenAI-compatible streaming adapter using the official OpenAI JS SDK.
 * Calls the provider API directly from the browser (no proxy).
 * Handles: OpenAI, Local/Custom (Ollama, LM Studio, llama.cpp, vLLM).
 */
import OpenAI from "openai";
import { mergeToolCalls } from "../../helpers/index.js";

export async function streamChat({
  provider, baseUrl, apiKey, model,
  messages, tools, signal,
  onThinkingChunk, onContentChunk,
}) {
  const client = new OpenAI({
    baseURL: baseUrl || "https://api.openai.com/v1",
    apiKey: apiKey || "not-needed",
    dangerouslyAllowBrowser: true,
  });

  const mergedMessage = { role: "assistant", content: "", thinking: "", tool_calls: null };

  const stream = await client.chat.completions.create(
    {
      model,
      messages,
      tools: tools?.length ? tools : undefined,
      stream: true,
      temperature: 0,
      max_tokens: 16384,
    },
    { signal },
  );

  for await (const chunk of stream) {
    if (signal?.aborted) break;

    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;

    if (typeof delta.content === "string" && delta.content) {
      mergedMessage.content += delta.content;
      onContentChunk?.(delta.content);
    }

    if (typeof delta.reasoning === "string" && delta.reasoning) {
      mergedMessage.thinking += delta.reasoning;
      onThinkingChunk?.(delta.reasoning);
    }

    if (Array.isArray(delta.tool_calls)) {
      mergedMessage.tool_calls = mergeToolCalls(mergedMessage.tool_calls ?? [], delta.tool_calls);
    }
  }

  if (mergedMessage.tool_calls === null) delete mergedMessage.tool_calls;
  return { message: mergedMessage };
}
