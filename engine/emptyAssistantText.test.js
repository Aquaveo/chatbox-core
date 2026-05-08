/**
 * engine/emptyAssistantText.test.js — coverage for the end-of-turn
 * empty-content guard.
 *
 * Bug context (2026-05-08): `runChatSession` ends the turn when the LLM
 * emits a response with no tool calls and no content. Without the guard,
 * the engine pushes an empty assistant message into history and returns
 * `assistantText: ""`. The chatbox renders an empty bubble — silent
 * failure. Specifically observed against `gpt-oss:120b` on a 4-item
 * dashboard prompt where 2 items were created, then the model returned
 * an empty round.
 *
 * The guard distinguishes two cases:
 *   - Produced something this turn → "The model finished without
 *     further explanation." (signals to the user that something
 *     completed but the model didn't comment)
 *   - Produced nothing this turn → "The model returned no response.
 *     Could you rephrase?" (matches the existing tool-shape placeholder
 *     pattern)
 */

import { describe, it, expect } from "vitest";

import { resolveEmptyAssistantText } from "./index.js";

function makeState({ visualizations = 0, layerUpdates = 0, patches = 0 } = {}) {
  return {
    pendingVisualizations: Array(visualizations).fill({}),
    pendingLayerUpdates: Array(layerUpdates).fill({}),
    pendingPatches: Array(patches).fill({}),
  };
}

describe("resolveEmptyAssistantText — non-empty input passes through", () => {
  it("returns the input unchanged when it has content", () => {
    expect(resolveEmptyAssistantText("Real answer here.", makeState())).toBe(
      "Real answer here.",
    );
  });

  it("returns the input unchanged even when state is full", () => {
    expect(
      resolveEmptyAssistantText("I made a chart.", makeState({ visualizations: 1 })),
    ).toBe("I made a chart.");
  });

  it("does not strip leading/trailing whitespace from real content", () => {
    expect(resolveEmptyAssistantText("  hello  ", makeState())).toBe("  hello  ");
  });
});

describe("resolveEmptyAssistantText — empty input, produced something", () => {
  it("substitutes the 'finished without explanation' placeholder when visualizations were produced", () => {
    expect(resolveEmptyAssistantText("", makeState({ visualizations: 2 }))).toBe(
      "The model finished without further explanation.",
    );
  });

  it("fires the produced-something placeholder for layer updates only", () => {
    expect(resolveEmptyAssistantText("", makeState({ layerUpdates: 1 }))).toBe(
      "The model finished without further explanation.",
    );
  });

  it("fires the produced-something placeholder for patches only", () => {
    expect(resolveEmptyAssistantText("", makeState({ patches: 1 }))).toBe(
      "The model finished without further explanation.",
    );
  });

  it("fires for whitespace-only input, not just literal empty string", () => {
    expect(
      resolveEmptyAssistantText("   \n  \t ", makeState({ visualizations: 1 })),
    ).toBe("The model finished without further explanation.");
  });
});

describe("resolveEmptyAssistantText — empty input, produced nothing", () => {
  it("substitutes the 'no response' placeholder when state is empty", () => {
    expect(resolveEmptyAssistantText("", makeState())).toBe(
      "The model returned no response. Could you rephrase?",
    );
  });

  it("fires for whitespace-only input with empty state", () => {
    expect(resolveEmptyAssistantText("   \n  ", makeState())).toBe(
      "The model returned no response. Could you rephrase?",
    );
  });
});
