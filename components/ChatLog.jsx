import { forwardRef, useEffect, useRef, useState } from "react";
import styled, { keyframes } from "styled-components";
import ChatMessage from "./ChatMessage";
import MarkdownContent from "./markdownContent";
import { Avatar, Bubble, ThinkingDropdown, BotIcon } from "./ChatMessage";
import { statusToLabel } from "../helpers/toolStatusCopy";

// Plan 2026-05-08-003 — how long a tool_complete label persists before
// reverting to "Thinking..." when no other event has landed. Long enough
// to read a glance, short enough to feel responsive.
const COMPLETION_GRACE_MS = 1500;

const LogSection = styled.section`
  display: grid;
  gap: ${({ theme }) => theme.spacing.lg};
  flex: 1;
  min-height: 0;
  min-width: 0;
  /* Lock horizontal axis to the sidebar width — a wide child should
     scroll within its own pre block, not push the chat region. */
  overflow-x: hidden;
  overflow-y: auto;
  padding: ${({ theme }) => theme.spacing.md} ${({ theme }) => theme.spacing.sm};
  background: transparent;
`;

const StatusText = styled.p`
  margin: 0;
  color: ${({ theme }) => theme.colors.textStatus};
`;

const ToolStatusText = styled(StatusText)`
  margin-top: ${({ theme }) => theme.spacing.sm};
  font-style: italic;
`;

const LoadingRow = styled.div`
  display: flex;
  align-items: flex-start;
  gap: ${({ theme }) => theme.spacing.md};
  flex-direction: row;
`;

/* --- LiveActivity strip: persistent "what the bot is doing right now"
       indicator. Replaces silent dead air during long thinking + tool calls. */

const bounce = keyframes`
  0%, 80%, 100% { transform: scale(0.55); opacity: 0.4; }
  40% { transform: scale(1); opacity: 1; }
`;

const ActivityStrip = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.15rem 0.1rem 0.25rem;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.fontSize.sm};
  font-weight: 500;
  margin-bottom: 0.35rem;
  user-select: none;
`;

const ElapsedSuffix = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
  margin-left: 0.25rem;
  font-weight: 400;
`;

const LivePreview = styled.div`
  margin-top: 0.15rem;
  font-size: ${({ theme }) => theme.fontSize.sm};
  line-height: 1.3;
  color: ${({ theme }) => theme.colors.textMuted};
  font-style: italic;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0.9;
  max-width: 100%;
`;

const Dots = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 3px;
`;

const Dot = styled.span`
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
  display: inline-block;
  animation: ${bounce} 1.3s ease-in-out infinite;
  &:nth-child(2) { animation-delay: 0.18s; }
  &:nth-child(3) { animation-delay: 0.36s; }
`;

function getLastThinkingLine(buffer) {
  if (!buffer) return "";
  const lines = String(buffer)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] || "";
}

function useElapsedSeconds(active) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active) {
      setElapsed(0);
      return undefined;
    }
    const start = Date.now();
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [active]);
  return elapsed;
}

/**
 * Hold a tool_complete label for COMPLETION_GRACE_MS so the user perceives
 * it as a discrete event, not a flash. If a new event lands within the
 * grace window, the new event wins (no queue — most-recent-event wins
 * semantics, plan K2).
 *
 * Returns the label string to display, or null when no specific label
 * should override the default (caller falls back to "Thinking" /
 * "Reasoning" / "Generating" based on engine state).
 */
function useStickyStatusLabel(toolStatus) {
  const [stickyLabel, setStickyLabel] = useState(null);
  const timerRef = useRef(null);

  useEffect(() => {
    // New event lands — cancel any pending grace-revert.
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    const label = statusToLabel(toolStatus);
    if (label === null) {
      // Suppressed / unknown — clear immediately.
      setStickyLabel(null);
      return undefined;
    }

    setStickyLabel(label);

    if (toolStatus?.type === "tool_complete") {
      // Grace window: revert to default after the timeout unless another
      // event arrives and resets us.
      timerRef.current = setTimeout(() => {
        setStickyLabel(null);
        timerRef.current = null;
      }, COMPLETION_GRACE_MS);
    }

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [toolStatus]);

  return stickyLabel;
}

function LiveActivity({ toolStatus, hasThinking, hasContent }) {
  const elapsed = useElapsedSeconds(true);
  const stickyLabel = useStickyStatusLabel(toolStatus);

  let label;
  if (stickyLabel) label = stickyLabel;
  else if (hasContent) label = "Generating";
  else if (hasThinking) label = "Reasoning";
  else label = "Thinking";

  return (
    <ActivityStrip role="status" aria-live="polite">
      <Dots aria-hidden="true">
        <Dot />
        <Dot />
        <Dot />
      </Dots>
      <span>{label}</span>
      {elapsed >= 3 && <ElapsedSuffix>{elapsed}s</ElapsedSuffix>}
    </ActivityStrip>
  );
}

const ChatLog = forwardRef(function ChatLog(
  { messages, isEmbedded, loading, isThinkingEnabled, thinkingBuffer, contentBuffer, toolStatus, MessageRenderer },
  ref,
) {
  // Streaming thinking dropdown opens by default so the user sees the
  // live stream, but respects a manual collapse mid-stream. Without the
  // user-collapsed state, every chunk re-render would re-assert the
  // `open` attribute and fight the user's click. Reset on turn boundary
  // (loading→false) so the next turn starts open again.
  const [userCollapsedThinking, setUserCollapsedThinking] = useState(false);
  useEffect(() => {
    if (!loading) setUserCollapsedThinking(false);
  }, [loading]);

  return (
    <LogSection ref={ref} role="log" aria-live="polite">
      {messages.map((message, index) => {
        // Render policy:
        //   _internal: true  → hidden (engine-protocol messages — tool-error
        //                      retry coaching, etc — that the LLM must see
        //                      but the user must not).
        //   role: "system"   → muted italic line (MCP health signals etc).
        //   role: "tool"     → hidden (tool-result protocol; not user-facing).
        //   role: user/assistant → ChatMessage bubble.
        if (message._internal) return null;
        if (message.role === "system") {
          return (
            <ToolStatusText key={`system-${index}`}>
              {message.content}
            </ToolStatusText>
          );
        }
        if (message.role === "tool") return null;
        return (
          <ChatMessage
            key={`${message.role}-${index}`}
            message={message}
            isEmbedded={isEmbedded}
            MessageRenderer={MessageRenderer}
          />
        );
      })}

      {loading && (
        <LoadingRow>
          <Avatar $isUser={false}>
            <BotIcon />
          </Avatar>
          <Bubble $isUser={false}>
            <LiveActivity
              toolStatus={toolStatus}
              hasThinking={Boolean(thinkingBuffer)}
              hasContent={Boolean(contentBuffer)}
            />
            {thinkingBuffer && !contentBuffer && (
              <LivePreview title={thinkingBuffer}>
                {getLastThinkingLine(thinkingBuffer)}
              </LivePreview>
            )}
            {isThinkingEnabled && thinkingBuffer && (
              <ThinkingDropdown
                open={!userCollapsedThinking}
                onToggle={(e) => setUserCollapsedThinking(!e.currentTarget.open)}
              >
                <summary>Thinking</summary>
                <pre>{thinkingBuffer}</pre>
              </ThinkingDropdown>
            )}
            {contentBuffer && <MarkdownContent content={contentBuffer} />}
          </Bubble>
        </LoadingRow>
      )}
    </LogSection>
  );
});

export default ChatLog;
