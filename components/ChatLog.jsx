import { forwardRef, useEffect, useState } from "react";
import styled, { keyframes } from "styled-components";
import ChatMessage from "./ChatMessage";
import MarkdownContent from "./markdownContent";
import { Avatar, Bubble, ThinkingDropdown, BotIcon } from "./ChatMessage";

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

function LiveActivity({ toolStatus, hasThinking, hasContent }) {
  const elapsed = useElapsedSeconds(true);
  let label;
  if (toolStatus === "calling_tools") label = "Running tools";
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
