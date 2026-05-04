/**
 * engine/adapters/anthropicThinkingParams.js — capability-aware mapping
 * from {model, thinkingBudget, wantThinking} to the Anthropic streamChat
 * `streamParams` keys this branching controls (`thinking`, `temperature`).
 *
 * Closes Plan 13 Unit 5's adaptive-mode gap. Claude 4.6+ models support
 * `thinking: { type: "adaptive" }` (the model decides budget on each turn);
 * older models use `thinking: { type: "enabled", budget_tokens }`.
 *
 * The Anthropic Models API does not expose per-model thinking-mode
 * capability metadata, so a model-id regex is the only correct choice.
 *
 * Returns an object suitable to `Object.assign(streamParams, ...)` —
 * always sets `temperature`; sets `thinking` only when wantThinking is true.
 */

const ADAPTIVE_THINKING_MODELS = /^claude-(sonnet|opus|haiku)-4-[6-9]/;

export function anthropicThinkingParams({ model, thinkingBudget, wantThinking }) {
  if (!wantThinking) return { temperature: 0 };
  if (ADAPTIVE_THINKING_MODELS.test(model || "")) {
    return { thinking: { type: "adaptive" }, temperature: 1 };
  }
  const budget = Number(thinkingBudget) || 4096;
  return { thinking: { type: "enabled", budget_tokens: budget }, temperature: 1 };
}
