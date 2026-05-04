/**
 * helpers/scheduleDispatch.js — schedule a dispatch on the next animation
 * frame, but bail at fire time if the captured turn-id is stale.
 *
 * Closes Plan 20 parked follow-up #16. Centralizes the
 * closure-capture-then-compare discipline so both rAF sites in Chatbox.jsx
 * use the same primitive and so the freshness check is unit-testable.
 *
 * Usage:
 *   const turnIdRef = useRef(0);
 *   // on user send:
 *   turnIdRef.current += 1;
 *   const capturedTurnId = turnIdRef.current; // capture OUTSIDE the dispatch closure
 *
 *   scheduleDispatchIfFresh({
 *     getCurrentTurnId: () => turnIdRef.current,
 *     capturedTurnId,
 *     dispatch: () => window.dispatchEvent(new CustomEvent(...)),
 *   });
 *
 * If a new turn starts (i.e. `turnIdRef.current` advances) before the rAF
 * callback fires, the dispatch is skipped. One wasted rAF tick costs ~1
 * frame (~16ms) of doing nothing — cheaper than tracking handles to call
 * cancelAnimationFrame.
 */

export function scheduleDispatchIfFresh({
  getCurrentTurnId,
  capturedTurnId,
  dispatch,
}) {
  requestAnimationFrame(() => {
    if (getCurrentTurnId() !== capturedTurnId) return;
    dispatch();
  });
}
