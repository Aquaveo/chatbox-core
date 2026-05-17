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

// Streaming-success mock: returns a ReadableStream of one NDJSON chunk
// with `done: true`. Captures the request body via fetchMock.mock.calls
// so num_ctx assertions can inspect it.
function mockStreamSuccess() {
  return vi.fn(async () => {
    const encoder = new TextEncoder();
    return {
      ok: true,
      status: 200,
      body: {
        getReader() {
          let sent = false;
          return {
            async read() {
              if (sent) return { done: true, value: undefined };
              sent = true;
              return {
                done: false,
                value: encoder.encode(
                  JSON.stringify({
                    message: { role: "assistant", content: "ok" },
                    done: true,
                  }) + "\n",
                ),
              };
            },
          };
        },
      },
    };
  });
}

describe("ollama streamChat — num_ctx derivation from modelMetadata", () => {
  function bodyFromFetchMock(fetchMock) {
    const call = fetchMock.mock.calls[0];
    return JSON.parse(call[1].body);
  }

  it("sends num_ctx equal to modelMetadata.contextLength when it's a positive number", async () => {
    const fetchMock = mockStreamSuccess();
    global.fetch = fetchMock;
    await streamChat({
      model: "gpt-oss:120b",
      modelMetadata: { contextLength: 131072 },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(bodyFromFetchMock(fetchMock).options.num_ctx).toBe(131072);
  });

  it("sends num_ctx 8192 when modelMetadata.contextLength is 8192", async () => {
    const fetchMock = mockStreamSuccess();
    global.fetch = fetchMock;
    await streamChat({
      model: "llama3.2:latest",
      modelMetadata: { contextLength: 8192 },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(bodyFromFetchMock(fetchMock).options.num_ctx).toBe(8192);
  });

  it("falls back to 16384 when modelMetadata is undefined", async () => {
    const fetchMock = mockStreamSuccess();
    global.fetch = fetchMock;
    await streamChat({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(bodyFromFetchMock(fetchMock).options.num_ctx).toBe(16384);
  });

  it("falls back to 16384 when modelMetadata is empty", async () => {
    const fetchMock = mockStreamSuccess();
    global.fetch = fetchMock;
    await streamChat({
      model: "llama3.2:latest",
      modelMetadata: {},
      messages: [{ role: "user", content: "hi" }],
    });
    expect(bodyFromFetchMock(fetchMock).options.num_ctx).toBe(16384);
  });

  it("falls back to 16384 when modelMetadata.contextLength is 0 (proves pickNumCtx catches falsy values that `??` would not)", async () => {
    const fetchMock = mockStreamSuccess();
    global.fetch = fetchMock;
    await streamChat({
      model: "llama3.2:latest",
      modelMetadata: { contextLength: 0 },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(bodyFromFetchMock(fetchMock).options.num_ctx).toBe(16384);
  });

  it("falls back to 16384 when modelMetadata.contextLength is NaN", async () => {
    const fetchMock = mockStreamSuccess();
    global.fetch = fetchMock;
    await streamChat({
      model: "llama3.2:latest",
      modelMetadata: { contextLength: NaN },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(bodyFromFetchMock(fetchMock).options.num_ctx).toBe(16384);
  });
});
