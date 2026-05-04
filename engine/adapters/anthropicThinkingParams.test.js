/**
 * engine/adapters/anthropicThinkingParams.test.js — unit coverage for the
 * model-capability-aware thinking-param branching used by the Anthropic
 * streaming adapter.
 *
 * Closes Plan 13 Unit 5's adaptive-mode gap: Claude 4.6+ models support
 * `thinking: { type: "adaptive" }` (no budget cap); older models use
 * `thinking: { type: "enabled", budget_tokens }`. The Anthropic Models API
 * does not expose per-model thinking-mode capability, so a regex on the
 * model id is the only correct choice.
 */

import { describe, expect, it } from "vitest";

import { anthropicThinkingParams } from "./anthropicThinkingParams.js";

describe("anthropicThinkingParams — wantThinking false", () => {
  it("returns temperature 0 with no thinking key", () => {
    expect(
      anthropicThinkingParams({ model: "claude-3-5-sonnet", wantThinking: false }),
    ).toEqual({ temperature: 0 });
  });

  it("returns temperature 0 even for adaptive-capable models when thinking is off", () => {
    expect(
      anthropicThinkingParams({ model: "claude-sonnet-4-6", wantThinking: false }),
    ).toEqual({ temperature: 0 });
  });
});

describe("anthropicThinkingParams — adaptive (Claude 4.6+)", () => {
  it.each([
    "claude-sonnet-4-6",
    "claude-opus-4-7",
    "claude-haiku-4-9",
    "claude-sonnet-4-6-20251201",
  ])("uses adaptive thinking for %s", (model) => {
    expect(
      anthropicThinkingParams({ model, wantThinking: true, thinkingBudget: 8192 }),
    ).toEqual({
      thinking: { type: "adaptive" },
      temperature: 1,
    });
  });

  it("ignores thinkingBudget on adaptive (no budget_tokens emitted)", () => {
    const params = anthropicThinkingParams({
      model: "claude-opus-4-7",
      wantThinking: true,
      thinkingBudget: 100000,
    });
    expect(params.thinking).not.toHaveProperty("budget_tokens");
  });
});

describe("anthropicThinkingParams — enabled fallback (older models)", () => {
  it("uses enabled-budget for claude-3-5-sonnet", () => {
    expect(
      anthropicThinkingParams({
        model: "claude-3-5-sonnet",
        wantThinking: true,
      }),
    ).toEqual({
      thinking: { type: "enabled", budget_tokens: 4096 },
      temperature: 1,
    });
  });

  it("uses enabled-budget for claude-haiku-4-5 (4.5 < 4.6 — does NOT match adaptive)", () => {
    expect(
      anthropicThinkingParams({
        model: "claude-haiku-4-5",
        wantThinking: true,
      }),
    ).toEqual({
      thinking: { type: "enabled", budget_tokens: 4096 },
      temperature: 1,
    });
  });

  it("uses enabled-budget for claude-sonnet-4-5", () => {
    expect(
      anthropicThinkingParams({
        model: "claude-sonnet-4-5",
        wantThinking: true,
      }),
    ).toEqual({
      thinking: { type: "enabled", budget_tokens: 4096 },
      temperature: 1,
    });
  });

  it("honors a custom thinkingBudget", () => {
    expect(
      anthropicThinkingParams({
        model: "claude-3-5-sonnet",
        wantThinking: true,
        thinkingBudget: 8192,
      }),
    ).toEqual({
      thinking: { type: "enabled", budget_tokens: 8192 },
      temperature: 1,
    });
  });

  it("falls back to default budget on NaN", () => {
    expect(
      anthropicThinkingParams({
        model: "claude-3-5-sonnet",
        wantThinking: true,
        thinkingBudget: NaN,
      }),
    ).toEqual({
      thinking: { type: "enabled", budget_tokens: 4096 },
      temperature: 1,
    });
  });

  it("falls back to default budget on undefined", () => {
    expect(
      anthropicThinkingParams({
        model: "claude-3-5-sonnet",
        wantThinking: true,
      }).thinking.budget_tokens,
    ).toBe(4096);
  });
});

describe("anthropicThinkingParams — defensive paths", () => {
  it("does not throw when model is empty string (falls into enabled-budget)", () => {
    const params = anthropicThinkingParams({ model: "", wantThinking: true });
    expect(params.thinking.type).toBe("enabled");
  });

  it("does not throw when model is undefined (falls into enabled-budget)", () => {
    const params = anthropicThinkingParams({ wantThinking: true });
    expect(params.thinking.type).toBe("enabled");
  });
});
