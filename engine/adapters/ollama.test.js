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

import { afterEach, describe, expect, it, vi } from "vitest";

import { streamChat } from "./ollama.js";

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
