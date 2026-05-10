import { useRef, useCallback, useEffect, useState, useLayoutEffect, useId } from "react";
import ReactDOM from "react-dom";
import styled, { keyframes } from "styled-components";
import ContextUsageIndicator from "./ContextUsageIndicator";

// Slash-trigger regex (R5): empty input or `/<token>` only — `[A-Za-z0-9_-]`
// after the leading `/`. Mid-input slashes (e.g., URLs) and a `/` followed
// by any non-token char (space, second `/` in `/etc/passwd`, etc.) all fall
// through to the closed branch. See plan 2026-05-08-005, R5 + Risks table.
const SLASH_TRIGGER_RE = /^\/[A-Za-z0-9_-]*$/;

// Cap the auto-resizing textarea at ~10 lines. Without this cap, a long
// prompt grows the textarea unbounded, eats the chatbox Shell's
// remaining height, and pushes the toolbar (send button, provider /
// MCP / Thinking pills) below Shell's overflow:hidden boundary —
// they get clipped out of view and the user can't send. Pixels (not
// vh) because chatbox-core is embedded in narrow sidebars where vh
// is dominated by the host viewport rather than the chatbox.
export const TEXTAREA_MAX_PX = 240;

const InputSection = styled.section`
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.lg};
  background: ${({ theme }) => theme.colors.surfaceInput};
  padding: ${({ theme }) => theme.spacing.md};
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.spacing.sm};
`;

const ModelRow = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.spacing.sm};
  padding: 0 ${({ theme }) => theme.spacing.xs};
`;

const Textarea = styled.textarea`
  width: 100%;
  box-sizing: border-box;
  resize: none;
  min-height: 44px;
  max-height: ${TEXTAREA_MAX_PX}px;
  overflow-y: auto;
  border: none;
  background: transparent;
  padding: ${({ theme }) => `${theme.spacing.md} 0.6rem`};
  font-size: ${({ theme }) => theme.fontSize.md};
  line-height: 1.45;
  outline: none;
`;

const Toolbar = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.spacing.sm};
  padding: 0 ${({ theme }) => theme.spacing.xs};
`;

const Toggles = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: ${({ theme }) => theme.spacing.sm};
  min-width: 0;
  flex: 1;
`;

const PillButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  border: 1px solid ${(props) => (props.$active ? props.theme.colors.primary : props.theme.colors.border)};
  border-radius: ${({ theme }) => theme.radius.full};
  padding: 0.3rem 0.7rem;
  font-size: ${({ theme }) => theme.fontSize.sm};
  font-weight: 600;
  color: ${(props) => (props.$active ? props.theme.colors.primary : props.theme.colors.textMuted)};
  background: ${(props) => (props.$active ? props.theme.colors.primaryLight : "transparent")};
  cursor: pointer;
  flex-shrink: 0;
  white-space: nowrap;
  transition: all 0.15s;
  user-select: none;

  &:hover:not(:disabled) {
    background: ${(props) => (props.$active ? "rgba(31, 125, 184, 0.12)" : props.theme.colors.borderHover)};
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

const ModelSelectWrap = styled.label`
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.full};
  padding: 0.15rem 0.5rem 0.15rem 0.55rem;
  flex: 1 1 auto;
  min-width: 0;
  background: transparent;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;

  &:hover {
    border-color: ${({ theme }) => theme.colors.borderHover || theme.colors.primary};
  }

  &:focus-within {
    border-color: ${({ theme }) => theme.colors.primary};
  }
`;

const ProviderIconBadge = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: ${({ theme }) => theme.colors.textMuted};
`;

const ModelSelect = styled.select`
  border: none;
  background: transparent;
  padding: 0.2rem 0;
  font-size: ${({ theme }) => theme.fontSize.sm};
  font-weight: 600;
  color: ${({ theme }) => theme.colors.textMuted};
  cursor: pointer;
  outline: none;
  flex: 1 1 auto;
  min-width: 0;
  text-overflow: ellipsis;

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

const IconPillButton = styled(PillButton)`
  /* Same pill as Thinking, but sized for icon-only + optional badge. */
  padding: 0.3rem 0.55rem;
  gap: 0.2rem;
  font-size: 0.72rem;
`;

const Badge = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1rem;
  height: 1rem;
  padding: 0 0.3rem;
  border-radius: ${({ theme }) => theme.radius.full};
  background: ${({ theme }) => theme.colors.primary};
  color: #fff;
  font-size: 0.65rem;
  font-weight: 700;
  line-height: 1;
`;

const ProviderLabels = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  ollama: "Ollama",
  custom: "Custom",
};
function providerLabel(provider) {
  return ProviderLabels[provider] ?? "Local";
}

const OllamaIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 4v3" />
    <path d="M16 4v3" />
    <path d="M7 13c0-3 2.2-5 5-5s5 2 5 5v4c0 2-1.5 3.5-3.5 3.5h-3C8.5 20.5 7 19 7 17v-4z" />
    <circle cx="10" cy="14" r="0.6" fill="currentColor" />
    <circle cx="14" cy="14" r="0.6" fill="currentColor" />
  </svg>
);

const OpenAIIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2l1.6 6.4L20 10l-6.4 1.6L12 18l-1.6-6.4L4 10l6.4-1.6L12 2z" />
  </svg>
);

const AnthropicIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 3L3 21h3.6l1.5-3.6h7.8L17.4 21H21L12 3zm-2.6 11.5L12 8.6l2.6 5.9H9.4z" />
  </svg>
);

const CustomIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
    <line x1="9" y1="2" x2="9" y2="5" />
    <line x1="15" y1="2" x2="15" y2="5" />
    <line x1="9" y1="19" x2="9" y2="22" />
    <line x1="15" y1="19" x2="15" y2="22" />
    <line x1="2" y1="9" x2="5" y2="9" />
    <line x1="2" y1="15" x2="5" y2="15" />
    <line x1="19" y1="9" x2="22" y2="9" />
    <line x1="19" y1="15" x2="22" y2="15" />
  </svg>
);

function ProviderIcon({ provider }) {
  switch (provider) {
    case "ollama":
      return <OllamaIcon />;
    case "openai":
      return <OpenAIIcon />;
    case "anthropic":
      return <AnthropicIcon />;
    case "custom":
    default:
      return <CustomIcon />;
  }
}

const SendButton = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  width: ${({ theme }) => theme.sizes.sendButton};
  height: ${({ theme }) => theme.sizes.sendButton};
  border: 0;
  border-radius: ${({ theme }) => theme.radius.circle};
  color: ${({ theme }) => theme.colors.surface};
  background: ${(props) => (props.$stop ? props.theme.colors.error : props.theme.colors.primary)};
  cursor: pointer;
  transition: background 0.15s;
  flex-shrink: 0;

  &:hover:not(:disabled) {
    background: ${(props) => (props.$stop ? props.theme.colors.errorHover : props.theme.colors.primaryHover)};
  }

  &:disabled {
    background: ${({ theme }) => theme.colors.sendDisabled};
    cursor: not-allowed;
  }
`;

const McpIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M20 13H4c-.55 0-1 .45-1 1v6c0 .55.45 1 1 1h16c.55 0 1-.45 1-1v-6c0-.55-.45-1-1-1zM7 19c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zM20 3H4c-.55 0-1 .45-1 1v6c0 .55.45 1 1 1h16c.55 0 1-.45 1-1V4c0-.55-.45-1-1-1zM7 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z" />
  </svg>
);

const ThinkingIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 2a7 7 0 0 1 7 7c0 2.4-1.2 4.5-3 5.7V17a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.3C6.2 13.5 5 11.4 5 9a7 7 0 0 1 7-7z" />
    <line x1="10" y1="22" x2="14" y2="22" />
  </svg>
);

const SendIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M12 3L4 11h5v8h6v-8h5L12 3z" fill="#ffffff" />
  </svg>
);

const StopIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="#ffffff" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect x="4" y="4" width="16" height="16" rx="2" />
  </svg>
);

const SettingsIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

/* --- Slash-command popover --- */

// Inline-popover JSX rendered via React portal to escape the chatbox
// Shell's `overflow: hidden` clipping (precedent: the textarea-clipping
// bug in Plan 26-002). Anchored above the textarea via a fixed-position
// wrapper sized from `getBoundingClientRect()`. v1 closes on any reflow
// (resize / scroll / visualViewport change) — does not re-anchor.

const PopoverWrap = styled.div.attrs((props) => ({
  style: {
    left: `${props.$left}px`,
    top: `${props.$top}px`,
    width: `${props.$width}px`,
  },
}))`
  position: fixed;
  z-index: 9999;
  background: ${({ theme }) => theme.colors.surface};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  box-shadow: 0 4px 16px rgba(20, 35, 60, 0.18);
  max-height: 240px;
  overflow-y: auto;
  padding: ${({ theme }) => theme.spacing.xs} 0;
  /* Translate Y -100% so the popover hovers above the textarea anchor
     point (top of textarea) — mirrors the visual position of typical
     command-palette popovers. The 6px gap is intentional. */
  transform: translateY(calc(-100% - 6px));
`;

const PopoverRow = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: ${({ theme }) => `${theme.spacing.sm} ${theme.spacing.md}`};
  cursor: pointer;
  background: ${(props) => (props.$highlighted ? props.theme.colors.primaryLight : "transparent")};
  &:hover {
    background: ${({ theme }) => theme.colors.primaryLight};
  }
`;

const PopoverRowName = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.spacing.sm};
  font-weight: 600;
  font-size: ${({ theme }) => theme.fontSize.base};
  color: ${(props) => (props.$highlighted ? props.theme.colors.primary : props.theme.colors.text)};
`;

const PopoverRowDesc = styled.div`
  font-size: ${({ theme }) => theme.fontSize.sm};
  color: ${({ theme }) => theme.colors.textMuted};
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const popoverSpin = keyframes`
  to { transform: rotate(360deg); }
`;

const RowSpinner = styled.span`
  display: inline-block;
  width: 10px;
  height: 10px;
  border: 1.5px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: ${popoverSpin} 0.8s linear infinite;
  flex-shrink: 0;
`;

export default function ChatInputBar({
  input,
  setInput,
  onSend,
  onStop,
  loading,
  loadingModels,
  selectedModel,
  onModelChange,
  availableModels,
  isThinkingEnabled,
  onThinkingToggle,
  contextUsage,
  onOpenMcpPanel,
  mcpServerCount = 0,
  showProviderPanel,
  onToggleProviderPanel,
  providerConfig,
  prompts = [],
  onPromptSelected = () => Promise.resolve(),
}) {
  const textareaRef = useRef(null);

  // Slash-command popover state. `popoverOpen` and `triggerToken` are
  // derived from the controlled `input` value via the regex below.
  // `highlightedIndex` is reset whenever the filtered list changes shape.
  // `loadingPromptName` shows a spinner on a row while the host's
  // `onPromptSelected` is in flight.
  // `selectionGen` is incremented on every selection; the async resolver
  // captures the gen at click time and drops the result if it's stale
  // (Esc'd, typed-over, double-clicked, or another row picked).
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [triggerToken, setTriggerToken] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [loadingPromptName, setLoadingPromptName] = useState(null);
  const [anchor, setAnchor] = useState({ left: 0, top: 0, width: 0 });
  const selectionGen = useRef(0);
  // Sticky-Esc marker: captures the triggerToken at the moment Esc fires
  // so the detection effect doesn't immediately re-open the popover for
  // the same input. Cleared when the input no longer matches the slash
  // regex OR the user types a different token (token diverges).
  const dismissedTokenRef = useRef(null);

  const popoverId = useId();
  const rowId = useCallback((idx) => `${popoverId}-row-${idx}`, [popoverId]);
  // Ref on the popover wrapper so the document-level capture-phase scroll
  // listener (R6 reflow handling, below) can distinguish scroll events
  // INSIDE the popover (its own overflow-y:auto scroll, plus Chromium's
  // auto-scroll-to-aria-activedescendant on arrow-key navigation) from
  // outer-page scrolls that should dismiss it.
  const popoverWrapRef = useRef(null);

  const promptsAvailable = prompts.length > 0;

  // Case-insensitive prefix-match against prompt.name.
  const filteredPrompts = (() => {
    if (!popoverOpen) return [];
    const tok = triggerToken.toLowerCase();
    if (!tok) return prompts;
    return prompts.filter((p) =>
      typeof p?.name === "string" && p.name.toLowerCase().startsWith(tok),
    );
  })();

  // R5 — initial render & live edits. Evaluating the regex on every
  // render of the controlled `input` covers Plan-004's per-dashboard
  // remount-with-persisted-draft case (mounting with `/plot` already
  // in the textarea opens the popover automatically).
  useEffect(() => {
    if (!promptsAvailable) {
      // Defensive: even if a stale popover-open flag exists, no prompts
      // means no popover. Match the R10 silent-fallback contract.
      if (popoverOpen) setPopoverOpen(false);
      // Without prompts there is no slash flow at all — clear the marker.
      dismissedTokenRef.current = null;
      return;
    }
    const match = SLASH_TRIGGER_RE.test(input);
    if (match) {
      const token = input.slice(1);
      // If the user diverged from the dismissed token (typed a different
      // character after Esc), clear the marker so the popover re-opens.
      if (
        dismissedTokenRef.current !== null &&
        dismissedTokenRef.current !== token
      ) {
        dismissedTokenRef.current = null;
      }
      // Reset highlight when the candidate list might have shifted.
      setTriggerToken((prev) => (prev === token ? prev : token));
      // Sticky-Esc: if the user dismissed this exact token with Esc,
      // do NOT re-open the popover until the input changes shape.
      if (dismissedTokenRef.current === token) {
        return;
      }
      if (!popoverOpen) {
        setPopoverOpen(true);
        setHighlightedIndex(0);
      }
    } else {
      // Input no longer matches the slash regex — clear the dismissal
      // marker so a future `/<token>` re-opens cleanly.
      dismissedTokenRef.current = null;
      if (popoverOpen) setPopoverOpen(false);
    }
  }, [input, promptsAvailable, popoverOpen]);

  // Close popover when filtered list becomes empty (zero-match KTD —
  // no "No matches" text in v1). Sticky-dismiss the current token so
  // the detection effect doesn't immediately reopen against the same
  // input — it only re-opens after the user changes the token shape.
  useEffect(() => {
    if (popoverOpen && filteredPrompts.length === 0 && triggerToken !== "") {
      dismissedTokenRef.current = triggerToken;
      setPopoverOpen(false);
    } else if (popoverOpen && highlightedIndex >= filteredPrompts.length) {
      // Clamp highlight if list shrank under it.
      setHighlightedIndex(Math.max(0, filteredPrompts.length - 1));
    }
  }, [popoverOpen, filteredPrompts.length, triggerToken, highlightedIndex]);

  // R6 anchor coords — read textarea bounds when the popover opens.
  useLayoutEffect(() => {
    if (!popoverOpen) return;
    const el = textareaRef.current;
    if (!el || typeof el.getBoundingClientRect !== "function") return;
    const rect = el.getBoundingClientRect();
    setAnchor({ left: rect.left, top: rect.top, width: rect.width });
  }, [popoverOpen]);

  // R6 reflow handling — any resize / scroll / visualViewport change
  // closes the popover. v1 does not re-anchor. Sticky-dismiss the
  // current token so the detection effect doesn't immediately reopen
  // for the same input.
  //
  // Scroll listener is registered in the capture phase so it sees scroll
  // events on any descendant — but that includes the popover's OWN
  // overflow-y:auto scroll (when the user wheels/trackpad-scrolls inside
  // it) and Chromium's auto-scroll-to-aria-activedescendant when the
  // user navigates rows with ArrowUp/ArrowDown. Both of those should
  // NOT dismiss the popover. Filter by event target: if the scroll
  // originated inside the popover wrapper, ignore it. Outer-page scrolls
  // (whose target is not inside the popover) still dismiss as intended.
  useEffect(() => {
    if (!popoverOpen) return undefined;
    const dismiss = () => {
      dismissedTokenRef.current = triggerToken;
      setPopoverOpen(false);
    };
    const onScroll = (e) => {
      const wrap = popoverWrapRef.current;
      const target = e.target;
      if (
        wrap &&
        target instanceof Node &&
        (target === wrap || wrap.contains(target))
      ) {
        return;
      }
      dismiss();
    };
    window.addEventListener("resize", dismiss);
    document.addEventListener("scroll", onScroll, true);
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (vv) {
      vv.addEventListener("resize", dismiss);
      vv.addEventListener("scroll", dismiss);
    }
    return () => {
      window.removeEventListener("resize", dismiss);
      document.removeEventListener("scroll", onScroll, true);
      if (vv) {
        vv.removeEventListener("resize", dismiss);
        vv.removeEventListener("scroll", dismiss);
      }
    };
  }, [popoverOpen, triggerToken]);

  const selectPrompt = useCallback(
    (prompt) => {
      if (!prompt) return;
      const gen = ++selectionGen.current;
      const tokenAtSelect = triggerToken;
      setLoadingPromptName(prompt.name);
      // Call onPromptSelected synchronously so the host's pending
      // resolver is captured immediately (matters for tests that hold a
      // resolveFn ref + drives behavior on the parent setInput call).
      // Use new Promise to route synchronous throws to the reject branch.
      new Promise((resolve, reject) => {
        try {
          resolve(onPromptSelected(prompt));
        } catch (err) {
          reject(err);
        }
      }).then(
          () => {
            // Late-arrival guard: bail if the user has Esc'd, typed-over,
            // or selected a different row in the meantime.
            const stillCurrent =
              gen === selectionGen.current &&
              popoverOpen &&
              triggerToken === tokenAtSelect;
            setLoadingPromptName((curr) => (curr === prompt.name ? null : curr));
            if (!stillCurrent) {
              // Drop the result; do NOT call any host success path here
              // — the host's success path runs inside onPromptSelected
              // itself, which is bypassed by the host's own race guard
              // OR this guard's stillCurrent check on the parent side.
              return;
            }
            // Close popover on success. If the host replaced `input`
            // via setInput inside onPromptSelected, the regex no longer
            // matches and the detection effect won't re-open. If the
            // host didn't replace the input (e.g., custom flow), mark
            // the current token as dismissed so the detection effect
            // doesn't immediately re-open against the same `/`<token>.
            dismissedTokenRef.current = tokenAtSelect;
            setPopoverOpen(false);
          },
          () => {
            // Reject path: clear loading; close popover so the host's
            // error message is visible above the input bar. Sticky-mark
            // the token so the detection effect doesn't reopen.
            setLoadingPromptName((curr) => (curr === prompt.name ? null : curr));
            dismissedTokenRef.current = tokenAtSelect;
            setPopoverOpen(false);
          },
        );
    },
    [onPromptSelected, popoverOpen, triggerToken],
  );

  const handleKeyDown = useCallback(
    (e) => {
      if (popoverOpen && filteredPrompts.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setHighlightedIndex((idx) => Math.min(idx + 1, filteredPrompts.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setHighlightedIndex((idx) => Math.max(idx - 1, 0));
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          // Tab also stops native focus traversal (preventDefault above).
          const prompt = filteredPrompts[highlightedIndex];
          selectPrompt(prompt);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          // Sticky-Esc: capture the current triggerToken so the detection
          // effect doesn't immediately re-open the popover. Cleared when
          // the user backspaces to an empty/non-matching input or types
          // a different token.
          dismissedTokenRef.current = triggerToken;
          setPopoverOpen(false);
          return;
        }
      }
      // Default behavior when popover is closed (or no matches).
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onSend();
      }
    },
    [onSend, popoverOpen, filteredPrompts, highlightedIndex, selectPrompt, triggerToken],
  );

  const handleInput = useCallback(
    (e) => {
      setInput(e.target.value);
    },
    [setInput],
  );

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_PX)}px`;
  }, [input]);

  const placeholder = promptsAvailable
    ? "Send a message… or / for templates"
    : "Send a message…";

  return (
    <InputSection>
      <ModelRow>
        <ModelSelectWrap title={`${providerLabel(providerConfig?.provider)} · ${selectedModel || "no model"}`}>
          <ProviderIconBadge>
            <ProviderIcon provider={providerConfig?.provider} />
          </ProviderIconBadge>
          <ModelSelect
            value={selectedModel}
            onChange={(e) => onModelChange(e.target.value)}
            disabled={loading || loadingModels || !availableModels.length}
            aria-label={`Model — current provider: ${providerLabel(providerConfig?.provider)}`}
          >
            {availableModels.length ? (
              availableModels.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.capabilities?.includes("thinking") ? "💡 " : ""}{m.name}
                </option>
              ))
            ) : (
              <option value="">{loadingModels ? "Loading..." : "No models"}</option>
            )}
          </ModelSelect>
        </ModelSelectWrap>
        <ContextUsageIndicator used={contextUsage.used} total={contextUsage.total} />
      </ModelRow>
      <Textarea
        ref={textareaRef}
        placeholder={placeholder}
        rows={1}
        value={input}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        disabled={loading}
        aria-label="Chat message input"
        role="combobox"
        aria-expanded={popoverOpen}
        aria-controls={popoverId}
        aria-autocomplete="list"
        aria-activedescendant={
          popoverOpen && filteredPrompts.length > 0
            ? rowId(highlightedIndex)
            : undefined
        }
      />
      {popoverOpen && filteredPrompts.length > 0 &&
        typeof document !== "undefined" &&
        ReactDOM.createPortal(
          <PopoverWrap
            ref={popoverWrapRef}
            id={popoverId}
            role="listbox"
            $left={anchor.left}
            $top={anchor.top}
            $width={anchor.width}
          >
            {filteredPrompts.map((prompt, idx) => {
              const isHighlighted = idx === highlightedIndex;
              const isRowLoading = loadingPromptName === prompt.name;
              return (
                <PopoverRow
                  key={prompt.name}
                  id={rowId(idx)}
                  role="option"
                  tabIndex={-1}
                  aria-selected={isHighlighted}
                  $highlighted={isHighlighted}
                  onMouseDown={(e) => {
                    // Prevent the textarea from losing focus on click —
                    // otherwise the parent's selection handler would
                    // race against blur side-effects.
                    e.preventDefault();
                  }}
                  onMouseEnter={() => setHighlightedIndex(idx)}
                  onClick={() => selectPrompt(prompt)}
                >
                  <PopoverRowName $highlighted={isHighlighted}>
                    <span>{prompt.name}</span>
                    {isRowLoading && <RowSpinner aria-label="Loading" />}
                  </PopoverRowName>
                  {prompt.description && (
                    <PopoverRowDesc>{prompt.description}</PopoverRowDesc>
                  )}
                </PopoverRow>
              );
            })}
          </PopoverWrap>,
          document.body,
        )}
      <Toolbar>
        <Toggles>
          <PillButton
            type="button"
            $active={isThinkingEnabled}
            onClick={onThinkingToggle}
            disabled={loading}
          >
            <ThinkingIcon />
            Thinking
          </PillButton>
          <IconPillButton
            type="button"
            $active={showProviderPanel}
            onClick={onToggleProviderPanel}
            title={`LLM provider: ${providerLabel(providerConfig?.provider)}`}
            aria-label={`LLM provider settings — current: ${providerLabel(providerConfig?.provider)}`}
          >
            <SettingsIcon />
          </IconPillButton>
          {onOpenMcpPanel && (
            <IconPillButton
              type="button"
              onClick={onOpenMcpPanel}
              title="Manage MCP servers"
              aria-label={`Manage MCP servers${mcpServerCount > 0 ? ` (${mcpServerCount} configured)` : ""}`}
            >
              <McpIcon />
              {mcpServerCount > 0 && <Badge>{mcpServerCount}</Badge>}
            </IconPillButton>
          )}
        </Toggles>
        {loading ? (
          <SendButton type="button" $stop onClick={onStop} aria-label="Stop generation">
            <StopIcon />
          </SendButton>
        ) : (
          <SendButton
            type="button"
            onClick={onSend}
            disabled={!input.trim() || loading}
            aria-label="Send message"
          >
            <SendIcon />
          </SendButton>
        )}
      </Toolbar>
    </InputSection>
  );
}
