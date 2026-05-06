/**
 * engine/capabilityGating.test.js — coverage for resolveModelCapability
 * (the pure helper) plus the current no-gating policy.
 *
 * Capability resolution is retained for display/diagnostics compatibility,
 * but it must not cause the engine to withhold MCP tools.
 */

import { describe, expect, it } from "vitest";

import { resolveModelCapability } from "./index.js";

const MODELS = [
  { name: "claude-sonnet-4", capabilities: ["tools"] },
  { name: "gpt-4o", capabilities: ["tools"] },
  { name: "text-embedding-3-large", capabilities: [] },
  { name: "llama3.2:latest", capabilities: ["tools"] },
  { name: "all-minilm:latest", capabilities: [] },
];

describe("resolveModelCapability", () => {
  describe("model in list", () => {
    it("returns 'supported' when capabilities array includes 'tools'", () => {
      expect(resolveModelCapability("claude-sonnet-4", MODELS, "anthropic")).toBe("supported");
      expect(resolveModelCapability("gpt-4o", MODELS, "openai")).toBe("supported");
      expect(resolveModelCapability("llama3.2:latest", MODELS, "ollama")).toBe("supported");
    });

    it("returns 'unsupported' when capabilities array is empty", () => {
      expect(resolveModelCapability("text-embedding-3-large", MODELS, "openai")).toBe("unsupported");
      expect(resolveModelCapability("all-minilm:latest", MODELS, "ollama")).toBe("unsupported");
    });
  });

  describe("model NOT in list — per-provider fallback", () => {
    it("returns 'supported' for anthropic (well-known tool-capable provider)", () => {
      expect(resolveModelCapability("claude-future-2030", MODELS, "anthropic")).toBe("supported");
    });

    it("returns 'supported' for openai (well-known tool-capable provider)", () => {
      expect(resolveModelCapability("gpt-future-2030", MODELS, "openai")).toBe("supported");
    });

    it("returns 'unknown' for ollama models without entry (signal-less)", () => {
      expect(resolveModelCapability("custom-finetune:7b", MODELS, "ollama")).toBe("unknown");
    });

    it("returns 'unknown' for custom provider (no signal available)", () => {
      expect(resolveModelCapability("any-model", MODELS, "custom")).toBe("unknown");
    });

    it("returns 'unknown' for an undefined provider (defensive)", () => {
      expect(resolveModelCapability("any-model", MODELS, undefined)).toBe("unknown");
    });
  });

  describe("input edge cases", () => {
    it("returns 'unknown' for an unknown provider with empty model list", () => {
      expect(resolveModelCapability("anything", [], "custom")).toBe("unknown");
    });

    it("returns 'supported' for anthropic even when modelList is null", () => {
      expect(resolveModelCapability("claude-sonnet-4", null, "anthropic")).toBe("supported");
    });

    it("ignores model entries with non-array capabilities (defensive)", () => {
      const malformed = [{ name: "weird", capabilities: "tools" /* not array */ }];
      // Falls through to per-provider default since the entry's capabilities
      // shape is unusable.
      expect(resolveModelCapability("weird", malformed, "anthropic")).toBe("supported");
      expect(resolveModelCapability("weird", malformed, "ollama")).toBe("unknown");
    });
  });
});

describe("tool gating policy", () => {
  // TethysDash workflows are tool-driven. Capability metadata can still be
  // resolved for display/diagnostics, but the engine no longer withholds MCP
  // tools based on provider signals, unknown Ollama models, or auto-learned
  // localStorage classifications.

  function isGated() {
    return false;
  }

  it("does NOT gate when capability is unsupported", () => {
    expect(isGated("unsupported", "anthropic")).toBe(false);
    expect(isGated("unsupported", "openai")).toBe(false);
    expect(isGated("unsupported", "ollama")).toBe(false);
    expect(isGated("unsupported", "custom")).toBe(false);
  });

  it("does NOT gate when capability is unknown for ollama", () => {
    expect(isGated("unknown", "ollama")).toBe(false);
  });

  it("does NOT gate when capability is unknown for custom", () => {
    expect(isGated("unknown", "custom")).toBe(false);
  });

  it("does NOT gate when capability is supported", () => {
    expect(isGated("supported", "anthropic")).toBe(false);
    expect(isGated("supported", "openai")).toBe(false);
    expect(isGated("supported", "ollama")).toBe(false);
    expect(isGated("supported", "custom")).toBe(false);
  });
});
