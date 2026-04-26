/**
 * Anthropic Messages API streaming adapter using the official Anthropic JS SDK.
 * Calls api.anthropic.com directly from the browser (no proxy).
 * Handles message format translation (OpenAI tool results → Anthropic format).
 */
import Anthropic from "@anthropic-ai/sdk";

/**
 * Translate engine messages (OpenAI format) to Anthropic format.
 */
function translateMessages(messages) {
  let system = "";
  const translated = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      system = typeof msg.content === "string" ? msg.content : "";
      continue;
    }

    if (msg.role === "tool") {
      translated.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id || "unknown",
            content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
          },
        ],
      });
      continue;
    }

    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      const content = [];
      if (msg.content) {
        content.push({ type: "text", text: msg.content });
      }
      for (const tc of msg.tool_calls) {
        const fn = tc.function || tc;
        let args = fn.arguments || "{}";
        if (typeof args === "string") {
          try { args = JSON.parse(args); } catch { args = {}; }
        }
        content.push({
          type: "tool_use",
          id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
          name: fn.name,
          input: args,
        });
      }
      translated.push({ role: "assistant", content });
      continue;
    }

    translated.push({
      role: msg.role,
      content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || ""),
    });
  }

  return { system, messages: translated };
}

/**
 * Translate OpenAI tool format to Anthropic tool format.
 */
function translateTools(tools) {
  if (!tools?.length) return undefined;
  return tools.map((t) => {
    const fn = t.function || t;
    return {
      name: fn.name,
      description: fn.description || "",
      input_schema: fn.parameters || { type: "object", properties: {} },
    };
  });
}

export async function streamChat({
  provider, baseUrl, apiKey, model,
  messages, tools, signal,
  thinkingBudget,
  onThinkingChunk, onContentChunk,
}) {
  const client = new Anthropic({
    apiKey: apiKey,
    maxRetries: 4,
    dangerouslyAllowBrowser: true,
  });

  const { system, messages: translatedMessages } = translateMessages(messages);
  const anthropicTools = translateTools(tools);

  const mergedMessage = { role: "assistant", content: "", thinking: "", tool_calls: null };
  const wantThinking = typeof onThinkingChunk === "function";

  const streamParams = {
    model,
    messages: translatedMessages,
    max_tokens: 8192,
  };
  if (wantThinking) {
    const budget = Number(thinkingBudget) || 4096;
    streamParams.thinking = { type: "enabled", budget_tokens: budget };
    streamParams.temperature = 1;
  } else {
    streamParams.temperature = 0;
  }
  if (system) streamParams.system = system;
  if (anthropicTools?.length) streamParams.tools = anthropicTools;

  const stream = client.messages.stream(streamParams, { signal });

  stream.on("text", (text) => {
    mergedMessage.content += text;
    onContentChunk?.(text);
  });

  // SDK 0.30.x has no high-level "thinking" event, but streamEvent fires for
  // all raw SSE events including content_block_delta with thinking_delta type.
  if (wantThinking) {
    stream.on("streamEvent", (event) => {
      if (
        event.type === "content_block_delta" &&
        event.delta?.type === "thinking_delta" &&
        event.delta.thinking
      ) {
        mergedMessage.thinking += event.delta.thinking;
        onThinkingChunk(event.delta.thinking);
      }
    });
  }

  const toolUseBlocks = [];

  stream.on("contentBlock", (block) => {
    if (block.type === "tool_use") {
      toolUseBlocks.push(block);
    }
  });

  await stream.finalMessage();

  if (toolUseBlocks.length > 0) {
    mergedMessage.tool_calls = toolUseBlocks.map((block) => ({
      id: block.id,
      function: {
        name: block.name,
        arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input || {}),
      },
    }));
  }

  if (mergedMessage.tool_calls === null) delete mergedMessage.tool_calls;
  return { message: mergedMessage };
}
