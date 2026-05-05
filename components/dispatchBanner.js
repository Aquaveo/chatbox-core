/**
 * components/dispatchBanner.js — Plan 003 D4 structural dispatch-feedback
 * banner. Pure logic, no React dependency, so it can be exercised in
 * vitest without the consumer's React peer dep installed.
 *
 * Returns a prepended warning string when (a) the just-completed turn
 * called at least one tool whose tags overlap the renderable trigger
 * set, (b) zero envelopes were dispatched, (c) at least one renderable
 * call did not return a domain-error envelope (those are already
 * surfaced by the rejected-patches path), and (d) the assistant emitted
 * final text. Empty string in every other case. The trigger is
 * structural inference from engine state — no regex on natural-language
 * final text.
 *
 * The banner is the structural defense in depth that catches the
 * "successful tool call, silent UI, hallucinated success" failure when
 * the LLM ignores the system-prompt instruction to use the tool result's
 * `_engine_dispatched` field. See Plan 003 origin requirements doc.
 */

const RENDERABLE_TRIGGER_TAGS = new Set(["visualization", "map", "layer"]);

export function _buildDispatchBanner({
  toolCallsThisTurn,
  toolTagsByName,
  visualizations,
  layerUpdates,
  patches,
  assistantText,
}) {
  // K6 — only banner when the LLM emitted final text. Aborted turns and
  // empty-content turns naturally fail this check and stay silent.
  if (typeof assistantText !== "string" || assistantText.trim() === "") {
    return "";
  }

  // Anything dispatched? Empty arrays / undefined both count as zero.
  const dispatchedCount =
    (Array.isArray(visualizations) ? visualizations.length : 0) +
    (Array.isArray(layerUpdates) ? layerUpdates.length : 0) +
    (Array.isArray(patches) ? patches.length : 0);
  if (dispatchedCount > 0) {
    return "";
  }

  // No tool-call history → can't have called a renderable tool. Bail.
  if (!Array.isArray(toolCallsThisTurn) || toolCallsThisTurn.length === 0) {
    return "";
  }

  // Tags map missing → can't classify, fail closed (no banner).
  // toolTagsByName arrives as a Map, but tolerate plain objects too.
  const getTags = (name) => {
    if (toolTagsByName instanceof Map) return toolTagsByName.get(name) || [];
    if (toolTagsByName && typeof toolTagsByName === "object") {
      return toolTagsByName[name] || [];
    }
    return [];
  };

  // Did at least one renderable-tagged tool fire this turn AND not
  // return a domain-error envelope (K5)? If every renderable call
  // errored, the rejected-patches surface already handles the UX.
  let sawNonErrorRenderable = false;
  for (const entry of toolCallsThisTurn) {
    const tags = getTags(entry?.toolName);
    const isRenderable = tags.some((t) => RENDERABLE_TRIGGER_TAGS.has(t));
    if (!isRenderable) continue;
    if (entry?.hadDomainError) continue;
    sawNonErrorRenderable = true;
    break;
  }
  if (!sawNonErrorRenderable) return "";

  return (
    "⚠ The model attempted to render a visualization but the dashboard " +
    "received nothing. Try rephrasing your request.\n\n"
  );
}
