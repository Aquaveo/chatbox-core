/**
 * engine/adapters/ollama.test.js — error-rendering coverage for streamChat.
 *
 * The proxy faithfully forwards Ollama Cloud's HTTP status, so subscription-
 * gated models surface as 403 with body
 *   {"error":"this model requires a subscription, upgrade for access: ..."}
 * The previous wrapping ("Ollama proxy returned 403: {...}") read like an
 * internal proxy fault. These tests pin the cleaned-up message format so the
 * upstream `error` text is surfaced and the model name is included, while
 * non-JSON failures keep the original wrapping.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { streamChat } from "./ollama.js";

let infoSpy;

beforeEach(() => {
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockErrorResponse({ status, body }) {
  return vi.fn(async () => ({
    ok: false,
    status,
    text: async () => body,
  }));
}

describe("ollama streamChat — error rendering", () => {
  it("surfaces upstream JSON error and model name on 403 subscription gate", async () => {
    global.fetch = mockErrorResponse({
      status: 403,
      body: JSON.stringify({
        error:
          "this model requires a subscription, upgrade for access: https://ollama.com/upgrade (ref: 0fdeafd6-1121-4681-aa7c-b7ce5cef6b31)",
      }),
    });

    await expect(
      streamChat({
        provider: "ollama",
        baseUrl: "https://ollama.com",
        apiKey: "test-key",
        model: "kimi-k2.6",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(
      /kimi-k2\.6.*this model requires a subscription.*https:\/\/ollama\.com\/upgrade/s,
    );
  });

  it("strips '(ref: <uuid>)' from the displayed message and emits it to console.info", async () => {
    global.fetch = mockErrorResponse({
      status: 403,
      body: JSON.stringify({
        error:
          "this model requires a subscription, upgrade for access: https://ollama.com/upgrade (ref: 0fdeafd6-1121-4681-aa7c-b7ce5cef6b31)",
      }),
    });

    let caught;
    try {
      await streamChat({
        provider: "ollama",
        baseUrl: "https://ollama.com",
        apiKey: "k",
        model: "kimi-k2.6",
        messages: [],
      });
    } catch (e) {
      caught = e;
    }

    expect(caught.message).not.toMatch(/\(ref:/);
    expect(caught.message).toMatch(/https:\/\/ollama\.com\/upgrade$/);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const logged = infoSpy.mock.calls[0].join(" ");
    expect(logged).toContain("0fdeafd6-1121-4681-aa7c-b7ce5cef6b31");
    expect(logged).toContain("kimi-k2.6");
  });

  it("does not emit a console.info when no ref token is present", async () => {
    global.fetch = mockErrorResponse({
      status: 403,
      body: JSON.stringify({ error: "model not found" }),
    });

    await expect(
      streamChat({
        provider: "ollama",
        baseUrl: "https://ollama.com",
        apiKey: "k",
        model: "llama3.2",
        messages: [],
      }),
    ).rejects.toThrow(/Ollama \(llama3\.2\): model not found/);
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("does not start with the legacy 'Ollama proxy returned' wrapping when upstream JSON is parseable", async () => {
    global.fetch = mockErrorResponse({
      status: 403,
      body: JSON.stringify({ error: "this model requires a subscription" }),
    });

    let caught;
    try {
      await streamChat({
        provider: "ollama",
        baseUrl: "https://ollama.com",
        apiKey: "k",
        model: "kimi-k2.6",
        messages: [],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.message.startsWith("Ollama proxy returned")).toBe(false);
  });

  it("falls back to the legacy wrapping when the body is not JSON", async () => {
    global.fetch = mockErrorResponse({
      status: 500,
      body: "<html>upstream blew up</html>",
    });

    await expect(
      streamChat({
        provider: "ollama",
        baseUrl: "https://ollama.com",
        apiKey: "k",
        model: "llama3.2",
        messages: [],
      }),
    ).rejects.toThrow(/Ollama proxy returned 500: <html>upstream blew up<\/html>/);
  });

  it("falls back to the legacy wrapping when JSON has no error field", async () => {
    global.fetch = mockErrorResponse({
      status: 502,
      body: JSON.stringify({ note: "nothing useful here" }),
    });

    await expect(
      streamChat({
        provider: "ollama",
        baseUrl: "https://ollama.com",
        apiKey: "k",
        model: "llama3.2",
        messages: [],
      }),
    ).rejects.toThrow(/Ollama proxy returned 502:/);
  });
});

// ---------------------------------------------------------------------------
// tool_calls round-trip — ensures arguments are sent as a JSON STRING
// regardless of whether the assistant message carries them as an object or
// a string. Newer Ollama versions reject object arguments on /api/chat with
//   400 json: cannot unmarshal object into Go struct field
//   .messages.tool_calls.function.arguments of type string
// because the API now follows OpenAI's stringified-JSON wire format.
// Observed 2026-05-10 on qwen3:latest. Same normalization pattern already
// exists in the Anthropic adapter (engine/adapters/anthropic.js:150).
// ---------------------------------------------------------------------------

function mockEmptyStreamResponse() {
  // Single empty NDJSON line. Lets streamChat finish without producing any
  // tool_calls of its own; the call returns immediately.
  const encoder = new TextEncoder();
  let returned = false;
  return vi.fn(async () => ({
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            if (returned) return { done: true };
            returned = true;
            return { done: false, value: encoder.encode("\n") };
          },
        };
      },
    },
  }));
}

describe("ollama streamChat — tool_calls argument normalization", () => {
  it("stringifies object-shaped tool_calls.function.arguments before sending", async () => {
    const fetchSpy = mockEmptyStreamResponse();
    global.fetch = fetchSpy;

    const messagesIn = [
      { role: "user", content: "show data" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            function: {
              name: "query_output_file",
              // Object — what Ollama native /api/chat historically returned
              // and what `mergeToolCalls` therefore stores. Newer Ollama
              // server rejects this on the inbound request.
              arguments: { model: "cfe_nom", date: "2026-05-10" },
            },
          },
        ],
      },
      { role: "tool", tool_name: "query_output_file", content: "{}" },
      { role: "user", content: "can you plot the time series?" },
    ];

    await streamChat({
      provider: "ollama",
      baseUrl: "http://localhost:11434",
      model: "qwen3:latest",
      messages: messagesIn,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, fetchOpts] = fetchSpy.mock.calls[0];
    const sentBody = JSON.parse(fetchOpts.body);
    const sentAssistant = sentBody.messages.find((m) => m.role === "assistant");
    const sentArgs = sentAssistant.tool_calls[0].function.arguments;

    expect(typeof sentArgs).toBe("string");
    // Round-trips back to the original object payload — no value lost.
    expect(JSON.parse(sentArgs)).toEqual({
      model: "cfe_nom",
      date: "2026-05-10",
    });
  });

  it("leaves already-string arguments unchanged (no double-encoding)", async () => {
    const fetchSpy = mockEmptyStreamResponse();
    global.fetch = fetchSpy;

    const argsString = JSON.stringify({ model: "cfe_nom" });
    await streamChat({
      provider: "ollama",
      baseUrl: "http://localhost:11434",
      model: "qwen3:latest",
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              function: { name: "query_output_file", arguments: argsString },
            },
          ],
        },
        { role: "user", content: "plot" },
      ],
    });

    const sentBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const sent = sentBody.messages[0].tool_calls[0].function.arguments;
    // Identity round-trip — must not be JSON.stringify-d into a double-
    // escaped string like '"{\\"model\\":\\"cfe_nom\\"}"'.
    expect(sent).toBe(argsString);
  });

  it("does not mutate the caller's messages array (cloned before normalization)", async () => {
    const fetchSpy = mockEmptyStreamResponse();
    global.fetch = fetchSpy;

    const originalArgs = { model: "cfe_nom" };
    const messagesIn = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            function: { name: "x", arguments: originalArgs },
          },
        ],
      },
      { role: "user", content: "p" },
    ];

    await streamChat({
      provider: "ollama",
      baseUrl: "http://localhost:11434",
      model: "qwen3:latest",
      messages: messagesIn,
    });

    // Caller's array MUST still see the object — otherwise UI or repair
    // paths that re-read messages after the fetch would observe mutation.
    expect(messagesIn[0].tool_calls[0].function.arguments).toBe(originalArgs);
  });

  it("stringifies object arguments returned from /api/chat (receive side)", async () => {
    // Ollama native /api/chat streams `tool_calls[i].function.arguments` as
    // a JSON object. The internal contract (matching anthropic.js:150 and
    // engine/index.js:746-748) is that `arguments` is always a STRING; the
    // engine `JSON.parse`s it before dispatch. This test pins that the
    // adapter normalizes the object-shaped response to a string before
    // returning, so any code path that reads tool_calls before the
    // send-side normalization sees the right shape.
    const encoder = new TextEncoder();
    const ndjsonLine = JSON.stringify({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            function: {
              name: "query_output_file",
              // Object — Ollama native shape.
              arguments: { model: "cfe_nom", date: "2026-05-10" },
            },
          },
        ],
      },
      done: true,
    }) + "\n";

    let returned = false;
    global.fetch = vi.fn(async () => ({
      ok: true,
      body: {
        getReader() {
          return {
            async read() {
              if (returned) return { done: true };
              returned = true;
              return { done: false, value: encoder.encode(ndjsonLine) };
            },
          };
        },
      },
    }));

    const { message } = await streamChat({
      provider: "ollama",
      baseUrl: "http://localhost:11434",
      model: "qwen3:latest",
      messages: [{ role: "user", content: "show data" }],
    });

    const args = message.tool_calls[0].function.arguments;
    expect(typeof args).toBe("string");
    expect(JSON.parse(args)).toEqual({ model: "cfe_nom", date: "2026-05-10" });
  });

  it("handles messages without tool_calls without error (no-op path)", async () => {
    const fetchSpy = mockEmptyStreamResponse();
    global.fetch = fetchSpy;

    await streamChat({
      provider: "ollama",
      baseUrl: "http://localhost:11434",
      model: "qwen3:latest",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    });

    const sentBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(sentBody.messages).toHaveLength(2);
    expect(sentBody.messages[0]).toEqual({ role: "user", content: "hi" });
  });
});
