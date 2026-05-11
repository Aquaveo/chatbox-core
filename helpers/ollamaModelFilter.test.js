/**
 * helpers/ollamaModelFilter.test.js — unit coverage for the Ollama
 * Cloud origin-policy filter helpers.
 *
 * Pure functions — no fetch, no mocks. Cloud-host gating + name-prefix
 * denylist for Chinese-origin model families.
 */

import { describe, expect, it } from "vitest";

import {
  CHINESE_MODEL_PREFIXES,
  isBlockedChineseModel,
  isOllamaCloudHost,
} from "./index.js";

describe("CHINESE_MODEL_PREFIXES (policy constant)", () => {
  it("is frozen so callers can't accidentally mutate the policy at runtime", () => {
    expect(Object.isFrozen(CHINESE_MODEL_PREFIXES)).toBe(true);
  });

  it("contains the families we expect to ship blocked", () => {
    for (const family of ["qwen", "deepseek", "glm", "yi", "baichuan"]) {
      expect(CHINESE_MODEL_PREFIXES).toContain(family);
    }
  });
});

describe("isBlockedChineseModel", () => {
  it("matches known Chinese-origin families by name prefix", () => {
    expect(isBlockedChineseModel("qwen2.5:7b")).toBe(true);
    expect(isBlockedChineseModel("deepseek-r1:32b")).toBe(true);
    expect(isBlockedChineseModel("glm-4:9b")).toBe(true);
    expect(isBlockedChineseModel("yi:34b")).toBe(true);
    expect(isBlockedChineseModel("baichuan2:13b")).toBe(true);
    expect(isBlockedChineseModel("hunyuan-large:latest")).toBe(true);
    expect(isBlockedChineseModel("internlm2:7b")).toBe(true);
  });

  it("allows American / European families", () => {
    expect(isBlockedChineseModel("llama3.1:8b")).toBe(false);
    expect(isBlockedChineseModel("gpt-oss:20b")).toBe(false);
    expect(isBlockedChineseModel("mistral:7b")).toBe(false);
    expect(isBlockedChineseModel("mixtral:8x7b")).toBe(false);
    expect(isBlockedChineseModel("gemma2:9b")).toBe(false);
    expect(isBlockedChineseModel("phi3:14b")).toBe(false);
    expect(isBlockedChineseModel("codellama:13b")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isBlockedChineseModel("QWEN2.5:7B")).toBe(true);
    expect(isBlockedChineseModel("DeepSeek-R1:32b")).toBe(true);
    expect(isBlockedChineseModel("Yi-Coder:9B")).toBe(true);
  });

  it("strips registry path prefix before matching", () => {
    expect(isBlockedChineseModel("ollama.com/library/qwen2.5:7b")).toBe(true);
    expect(isBlockedChineseModel("library/deepseek-r1:32b")).toBe(true);
    expect(isBlockedChineseModel("ollama.com/library/llama3.1:8b")).toBe(false);
  });

  it("returns false for falsy or non-string input without throwing", () => {
    expect(isBlockedChineseModel("")).toBe(false);
    expect(isBlockedChineseModel(null)).toBe(false);
    expect(isBlockedChineseModel(undefined)).toBe(false);
    expect(isBlockedChineseModel(123)).toBe(false);
    expect(isBlockedChineseModel({})).toBe(false);
    expect(isBlockedChineseModel([])).toBe(false);
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
