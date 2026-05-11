/**
 * helpers/ollamaModelFilter.test.js — unit coverage for the Ollama
 * Cloud model-listing policy filter helpers.
 *
 * Pure functions — no fetch, no mocks. Cloud-host gating + name-prefix
 * denylist for the configured blocked-model families.
 */

import { describe, expect, it } from "vitest";

import {
  BLOCKED_MODEL_PREFIXES,
  isBlockedModel,
  isOllamaCloudHost,
} from "./index.js";

describe("BLOCKED_MODEL_PREFIXES (policy constant)", () => {
  it("is frozen so callers can't accidentally mutate the policy at runtime", () => {
    expect(Object.isFrozen(BLOCKED_MODEL_PREFIXES)).toBe(true);
  });

  it("contains the families we expect to ship blocked", () => {
    for (const family of [
      "qwen",
      "deepseek",
      "glm",
      "yi",
      "baichuan",
      "kimi",
      "minimax",
    ]) {
      expect(BLOCKED_MODEL_PREFIXES).toContain(family);
    }
  });
});

describe("isBlockedModel", () => {
  it("matches blocked families by name prefix", () => {
    expect(isBlockedModel("qwen2.5:7b")).toBe(true);
    expect(isBlockedModel("deepseek-r1:32b")).toBe(true);
    expect(isBlockedModel("glm-4:9b")).toBe(true);
    expect(isBlockedModel("yi:34b")).toBe(true);
    expect(isBlockedModel("baichuan2:13b")).toBe(true);
    expect(isBlockedModel("hunyuan-large:latest")).toBe(true);
    expect(isBlockedModel("internlm2:7b")).toBe(true);
    expect(isBlockedModel("kimi-k2:latest")).toBe(true);
    expect(isBlockedModel("minimax-text-01:latest")).toBe(true);
  });

  it("allows non-blocked families", () => {
    expect(isBlockedModel("llama3.1:8b")).toBe(false);
    expect(isBlockedModel("gpt-oss:20b")).toBe(false);
    expect(isBlockedModel("mistral:7b")).toBe(false);
    expect(isBlockedModel("mixtral:8x7b")).toBe(false);
    expect(isBlockedModel("gemma2:9b")).toBe(false);
    expect(isBlockedModel("phi3:14b")).toBe(false);
    expect(isBlockedModel("codellama:13b")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isBlockedModel("QWEN2.5:7B")).toBe(true);
    expect(isBlockedModel("DeepSeek-R1:32b")).toBe(true);
    expect(isBlockedModel("Yi-Coder:9B")).toBe(true);
    expect(isBlockedModel("Kimi-K2:latest")).toBe(true);
    expect(isBlockedModel("MiniMax-Text-01:latest")).toBe(true);
  });

  it("strips registry path prefix before matching", () => {
    expect(isBlockedModel("ollama.com/library/qwen2.5:7b")).toBe(true);
    expect(isBlockedModel("library/deepseek-r1:32b")).toBe(true);
    expect(isBlockedModel("ollama.com/library/kimi-k2:latest")).toBe(true);
    expect(isBlockedModel("ollama.com/library/llama3.1:8b")).toBe(false);
  });

  it("returns false for falsy or non-string input without throwing", () => {
    expect(isBlockedModel("")).toBe(false);
    expect(isBlockedModel(null)).toBe(false);
    expect(isBlockedModel(undefined)).toBe(false);
    expect(isBlockedModel(123)).toBe(false);
    expect(isBlockedModel({})).toBe(false);
    expect(isBlockedModel([])).toBe(false);
  });
});

describe("isOllamaCloudHost", () => {
  it("recognizes the canonical Ollama Cloud URLs", () => {
    expect(isOllamaCloudHost("https://ollama.com")).toBe(true);
    expect(isOllamaCloudHost("https://ollama.com/")).toBe(true);
    expect(isOllamaCloudHost("http://ollama.com")).toBe(true);
    expect(isOllamaCloudHost("https://www.ollama.com")).toBe(true);
    expect(isOllamaCloudHost("https://ollama.com/api/tags")).toBe(true);
  });

  it("accepts bare hostname (no scheme)", () => {
    expect(isOllamaCloudHost("ollama.com")).toBe(true);
    expect(isOllamaCloudHost("www.ollama.com")).toBe(true);
  });

  it("rejects local / private hosts", () => {
    expect(isOllamaCloudHost("http://localhost:11434")).toBe(false);
    expect(isOllamaCloudHost("http://127.0.0.1:11434")).toBe(false);
    expect(isOllamaCloudHost("http://my-internal-host:11434")).toBe(false);
    expect(isOllamaCloudHost("https://ollama.internal.example")).toBe(false);
  });

  it("rejects suffix-attack hostnames where ollama.com is not the actual host", () => {
    expect(isOllamaCloudHost("https://ollama.com.evil.example")).toBe(false);
    expect(isOllamaCloudHost("https://notollama.com")).toBe(false);
    expect(isOllamaCloudHost("https://fakeollama.com")).toBe(false);
  });

  it("returns false for empty / falsy / non-string input", () => {
    expect(isOllamaCloudHost("")).toBe(false);
    expect(isOllamaCloudHost(null)).toBe(false);
    expect(isOllamaCloudHost(undefined)).toBe(false);
    expect(isOllamaCloudHost(123)).toBe(false);
  });

  it("returns false for unparseable garbage without throwing", () => {
    expect(isOllamaCloudHost("not a url")).toBe(false);
    expect(isOllamaCloudHost("://")).toBe(false);
  });
});
