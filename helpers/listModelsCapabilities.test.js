// @vitest-environment jsdom
/**
 * helpers/listModelsCapabilities.test.js — coverage for per-provider
 * capability population in `listModels`.
 *
 * Plan 002 Unit 1: extends the existing listModels function so each
 * model entry's `capabilities` array is accurately populated for OpenAI
 * (name-pattern check) and Ollama (reads /api/show.capabilities directly,
 * an authoritative API field verified against llama3.2:latest 2026-05-04).
 *
 * Anthropic branch is unchanged (already populates capabilities); custom
 * branch is unchanged (no signal available, treated as unknown by the
 * engine resolver).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listModels, openAiSupportsTools } from "./index.js";

describe("openAiSupportsTools (name-pattern check)", () => {
  it("matches current chat-completion families", () => {
    expect(openAiSupportsTools("gpt-3.5-turbo")).toBe(true);
    expect(openAiSupportsTools("gpt-4o")).toBe(true);
    expect(openAiSupportsTools("gpt-4o-mini")).toBe(true);
    expect(openAiSupportsTools("gpt-4-turbo")).toBe(true);
    expect(openAiSupportsTools("gpt-5")).toBe(true);
    expect(openAiSupportsTools("o1-preview")).toBe(true);
    expect(openAiSupportsTools("o3-mini")).toBe(true);
    expect(openAiSupportsTools("chatgpt-4o-latest")).toBe(true);
  });

  it("matches fine-tunes by inheriting base model capability", () => {
    expect(openAiSupportsTools("ft:gpt-4o-mini-2024-07-18:my-org::abc123")).toBe(true);
    expect(openAiSupportsTools("ft:gpt-3.5-turbo:org::xyz")).toBe(true);
    // Fine-tune of an embedding model — base doesn't match → still false.
    expect(openAiSupportsTools("ft:text-embedding-3-large:org::xyz")).toBe(false);
  });

  it("rejects non-chat models", () => {
    expect(openAiSupportsTools("text-embedding-3-large")).toBe(false);
    expect(openAiSupportsTools("text-davinci-003")).toBe(false);
    expect(openAiSupportsTools("dall-e-3")).toBe(false);
    expect(openAiSupportsTools("whisper-1")).toBe(false);
    expect(openAiSupportsTools("tts-1")).toBe(false);
  });

  it("rejects empty / non-string input", () => {
    expect(openAiSupportsTools("")).toBe(false);
    expect(openAiSupportsTools(null)).toBe(false);
    expect(openAiSupportsTools(undefined)).toBe(false);
  });
});

describe("listModels — Ollama capability discovery via /api/show", () => {
  beforeEach(() => {
    if (typeof localStorage !== "undefined") localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockOllamaFetch({ tags, showByModel }) {
    return vi.fn(async (url, init) => {
      if (url.includes("/api/tags")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ models: tags }),
        };
      }
      if (url.includes("/api/show")) {
        const body = JSON.parse(init?.body ?? "{}");
        const showResponse = showByModel[body.name];
        if (!showResponse) {
          return { ok: false, status: 404, json: async () => ({}) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => showResponse,
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
  }

  it("populates capabilities=['tools'] when /api/show returns capabilities including 'tools'", async () => {
    global.fetch = mockOllamaFetch({
      tags: [{ name: "llama3.2:latest", modified_at: "2026-05-04T00:00:00Z" }],
      showByModel: {
        "llama3.2:latest": { capabilities: ["completion", "tools"] },
      },
    });

    const result = await listModels({ provider: "ollama" });
    expect(result).toEqual([
      {
        name: "llama3.2:latest",
        contextLength: 8192,
        capabilities: ["tools"],
        thinkingTypes: null,
      },
    ]);
  });

  it("populates thinkingTypes when /api/show returns capabilities including 'thinking'", async () => {
    global.fetch = mockOllamaFetch({
      tags: [{ name: "qwen3:8b", modified_at: "2026-05-04T00:00:00Z" }],
      showByModel: {
        "qwen3:8b": { capabilities: ["completion", "tools", "thinking"] },
      },
    });

    const result = await listModels({ provider: "ollama" });
    expect(result[0].capabilities).toEqual(["tools"]);
    expect(result[0].thinkingTypes).toEqual({ enabled: { supported: true } });
  });

  it("returns empty capabilities when /api/show capabilities lacks 'tools'", async () => {
    global.fetch = mockOllamaFetch({
      tags: [{ name: "all-minilm:latest", modified_at: "2026-05-04T00:00:00Z" }],
      showByModel: {
        "all-minilm:latest": { capabilities: ["embedding"] },
      },
    });

    const result = await listModels({ provider: "ollama" });
    expect(result[0].capabilities).toEqual([]);
    expect(result[0].thinkingTypes).toBeNull();
  });

  it("treats missing capabilities field (older Ollama) as no tools", async () => {
    global.fetch = mockOllamaFetch({
      tags: [{ name: "ancient-model:latest", modified_at: "2024-01-01T00:00:00Z" }],
      showByModel: {
        "ancient-model:latest": { template: "{{.Prompt}}" },
      },
    });

    const result = await listModels({ provider: "ollama" });
    expect(result[0].capabilities).toEqual([]);
  });

  it("does not fail listModels when /api/show fails for a single model", async () => {
    global.fetch = mockOllamaFetch({
      tags: [
        { name: "good:latest", modified_at: "2026-05-04T00:00:00Z" },
        { name: "broken:latest", modified_at: "2026-05-04T00:00:00Z" },
      ],
      showByModel: {
        "good:latest": { capabilities: ["completion", "tools"] },
        // broken:latest is omitted → /api/show returns 404
      },
    });

    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await listModels({ provider: "ollama" });

    expect(result).toHaveLength(2);
    expect(result.find((m) => m.name === "good:latest").capabilities).toEqual(["tools"]);
    expect(result.find((m) => m.name === "broken:latest").capabilities).toEqual([]);
    expect(consoleWarn).toHaveBeenCalled();
  });

  it("caches /api/show results across calls keyed by (host, name, modifiedAt)", async () => {
    const fetchMock = mockOllamaFetch({
      tags: [{ name: "llama3.2:latest", modified_at: "2026-05-04T00:00:00Z" }],
      showByModel: {
        "llama3.2:latest": { capabilities: ["completion", "tools"] },
      },
    });
    global.fetch = fetchMock;

    await listModels({ provider: "ollama" });
    const firstCallCount = fetchMock.mock.calls.filter((c) => c[0].includes("/api/show")).length;
    expect(firstCallCount).toBe(1);

    // Second call with same modified_at — should hit cache.
    await listModels({ provider: "ollama" });
    const secondCallCount = fetchMock.mock.calls.filter((c) => c[0].includes("/api/show")).length;
    expect(secondCallCount).toBe(1); // unchanged — cache hit
  });

  it("invalidates cache when modified_at changes (model rebuilt)", async () => {
    // First call
    global.fetch = mockOllamaFetch({
      tags: [{ name: "llama3.2:latest", modified_at: "2026-05-04T00:00:00Z" }],
      showByModel: {
        "llama3.2:latest": { capabilities: ["completion"] },
      },
    });
    let result = await listModels({ provider: "ollama" });
    expect(result[0].capabilities).toEqual([]);

    // Second call with bumped modified_at + tools added.
    global.fetch = mockOllamaFetch({
      tags: [{ name: "llama3.2:latest", modified_at: "2026-06-01T00:00:00Z" }],
      showByModel: {
        "llama3.2:latest": { capabilities: ["completion", "tools"] },
      },
    });
    result = await listModels({ provider: "ollama" });
    expect(result[0].capabilities).toEqual(["tools"]);
  });

  it("bounds concurrency for /api/show fan-out", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchMock = vi.fn(async (url) => {
      if (url.includes("/api/tags")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            models: Array.from({ length: 12 }, (_, i) => ({
              name: `model-${i}:latest`,
              modified_at: "2026-05-04T00:00:00Z",
            })),
          }),
        };
      }
      // /api/show
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ capabilities: ["completion", "tools"] }),
      };
    });
    global.fetch = fetchMock;

    await listModels({ provider: "ollama" });
    expect(maxInFlight).toBeLessThanOrEqual(4);
  });
});

describe("listModels — OpenAI capability population", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("populates capabilities=['tools'] for matched chat models, empty for embeddings", async () => {
    // Mock the openai module via doMock so the dynamic import inside listModels picks it up.
    vi.doMock("openai", () => {
      class FakeOpenAI {
        constructor() {
          this.models = {
            list: async () => ({
              [Symbol.asyncIterator]: async function* () {
                yield { id: "gpt-4o" };
                yield { id: "gpt-3.5-turbo" };
                yield { id: "text-embedding-3-large" };
                yield { id: "ft:gpt-4o-mini-2024-07-18:my-org::abc" };
              },
            }),
          };
        }
      }
      return { default: FakeOpenAI };
    });

    // Re-import after mock.
    const { listModels: listModelsFresh } = await import("./index.js");
    const result = await listModelsFresh({ provider: "openai", apiKey: "sk-test" });

    expect(result.find((m) => m.name === "gpt-4o").capabilities).toEqual(["tools"]);
    expect(result.find((m) => m.name === "gpt-3.5-turbo").capabilities).toEqual(["tools"]);
    expect(result.find((m) => m.name === "text-embedding-3-large").capabilities).toEqual([]);
    expect(
      result.find((m) => m.name === "ft:gpt-4o-mini-2024-07-18:my-org::abc").capabilities,
    ).toEqual(["tools"]);
  });
});

// ---------------------------------------------------------------------------
// Ollama Cloud model-listing policy filter — integration with listModels
// ---------------------------------------------------------------------------

describe("listModels — Ollama Cloud model-listing policy filter", () => {
  beforeEach(() => {
    if (typeof localStorage !== "undefined") localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockMixedOllama() {
    const tags = [
      { name: "llama3.1:8b", modified_at: "2026-05-04T00:00:00Z" },
      { name: "qwen2.5:7b", modified_at: "2026-05-04T00:00:00Z" },
      { name: "mistral:7b", modified_at: "2026-05-04T00:00:00Z" },
      { name: "deepseek-r1:32b", modified_at: "2026-05-04T00:00:00Z" },
    ];
    const showByModel = {
      "llama3.1:8b": { capabilities: ["completion", "tools"] },
      "qwen2.5:7b": { capabilities: ["completion", "tools"] },
      "mistral:7b": { capabilities: ["completion", "tools"] },
      "deepseek-r1:32b": { capabilities: ["completion", "tools"] },
    };
    return vi.fn(async (url, init) => {
      if (url.includes("/api/tags")) {
        return { ok: true, status: 200, json: async () => ({ models: tags }) };
      }
      if (url.includes("/api/show")) {
        const body = JSON.parse(init?.body ?? "{}");
        return {
          ok: true,
          status: 200,
          json: async () => showByModel[body.name] ?? {},
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
  }

  it("filters blocked models when baseUrl points at Ollama Cloud", async () => {
    global.fetch = mockMixedOllama();
    const result = await listModels({
      provider: "ollama",
      baseUrl: "https://ollama.com",
    });
    const names = result.map((m) => m.name);
    expect(names).toEqual(["llama3.1:8b", "mistral:7b"]);
  });

  it("does NOT filter when baseUrl is a local / self-hosted Ollama", async () => {
    global.fetch = mockMixedOllama();
    const result = await listModels({
      provider: "ollama",
      baseUrl: "http://localhost:11434",
    });
    const names = result.map((m) => m.name);
    expect(names).toEqual([
      "llama3.1:8b",
      "qwen2.5:7b",
      "mistral:7b",
      "deepseek-r1:32b",
    ]);
  });

  it("does NOT filter when baseUrl is empty (treat as local default)", async () => {
    global.fetch = mockMixedOllama();
    const result = await listModels({ provider: "ollama" });
    expect(result).toHaveLength(4);
  });

  it("returns an empty array when Cloud catalog is all-blocked", async () => {
    global.fetch = vi.fn(async (url, init) => {
      if (url.includes("/api/tags")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            models: [
              { name: "qwen2.5:7b", modified_at: "2026-05-04T00:00:00Z" },
              { name: "deepseek-r1:32b", modified_at: "2026-05-04T00:00:00Z" },
            ],
          }),
        };
      }
      if (url.includes("/api/show")) {
        const body = JSON.parse(init?.body ?? "{}");
        const map = {
          "qwen2.5:7b": { capabilities: ["tools"] },
          "deepseek-r1:32b": { capabilities: ["tools"] },
        };
        return { ok: true, status: 200, json: async () => map[body.name] ?? {} };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const result = await listModels({
      provider: "ollama",
      baseUrl: "https://ollama.com",
    });
    expect(result).toEqual([]);
  });

  it("returns the full list unchanged when Cloud catalog is all-allowed", async () => {
    global.fetch = vi.fn(async (url, init) => {
      if (url.includes("/api/tags")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            models: [
              { name: "llama3.1:8b", modified_at: "2026-05-04T00:00:00Z" },
              { name: "gpt-oss:20b", modified_at: "2026-05-04T00:00:00Z" },
            ],
          }),
        };
      }
      if (url.includes("/api/show")) {
        const body = JSON.parse(init?.body ?? "{}");
        const map = {
          "llama3.1:8b": { capabilities: ["tools"] },
          "gpt-oss:20b": { capabilities: ["tools"] },
        };
        return { ok: true, status: 200, json: async () => map[body.name] ?? {} };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const result = await listModels({
      provider: "ollama",
      baseUrl: "https://ollama.com",
    });
    expect(result.map((m) => m.name)).toEqual(["llama3.1:8b", "gpt-oss:20b"]);
  });
});
