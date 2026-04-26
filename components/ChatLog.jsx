import { forwardRef } from "react";
import styled from "styled-components";
import ChatMessage from "./ChatMessage";
import MarkdownContent from "./markdownContent";
import { Avatar, Bubble, ThinkingDropdown, BotIcon } from "./ChatMessage";

const LogSection = styled.section`
  display: grid;
  gap: ${({ theme }) => theme.spacing.lg};
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: ${({ theme }) => theme.spacing.xl};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.lg};
  background: ${({ theme }) => theme.colors.chatLogBg};
`;

const StatusText = styled.p`
  margin: 0;
  color: ${({ theme }) => theme.colors.textStatus};
`;

const LoadingRow = styled.div`
  display: flex;
  align-items: flex-start;
  gap: ${({ theme }) => theme.spacing.md};
  flex-direction: row;
`;

const ToolStatusText = styled(StatusText)`
  margin-top: ${({ theme }) => theme.spacing.sm};
  font-style: italic;
`;

const ChatLog = forwardRef(function ChatLog(
  { messages, isEmbedded, loading, isThinkingEnabled, thinkingBuffer, contentBuffer, toolStatus, MessageRenderer },
  ref,
) {
  return (
    <LogSection ref={ref} role="log" aria-live="polite">
      {messages.map((message, index) =>
        // System messages (Unit 6 C1/C2 MCP health signals) render as a
        // muted italic line with no avatar or bubble — visually distinct
        // from user/assistant turns. Content is plain text only; React's
        // default text-child escaping is sufficient (Unit 3 sanitized the
        // name field at persistence, so interpolation is XSS-safe).
        message.role === "system" ? (
          <ToolStatusText key={`system-${index}`}>{message.content}</ToolStatusText>
        ) : (
          <ChatMessage
            key={`${message.role}-${index}`}
            message={message}
            isEmbedded={isEmbedded}
            MessageRenderer={MessageRenderer}
          />
        ),
      )}

      {loading && (
        <LoadingRow>
          <Avatar $isUser={false}>
            <BotIcon />
          </Avatar>
          <Bubble $isUser={false}>
            {isThinkingEnabled && thinkingBuffer && (
              <ThinkingDropdown open={!contentBuffer}>
                <summary>Thinking...</summary>
                <pre>{thinkingBuffer}</pre>
              </ThinkingDropdown>
            )}
            {contentBuffer ? (
              <MarkdownContent content={contentBuffer} />
            ) : (
              !thinkingBuffer && <StatusText>Running...</StatusText>
            )}
            {toolStatus && <ToolStatusText>Calling tools...</ToolStatusText>}
          </Bubble>
        </LoadingRow>
      )}
    </LogSection>
  );
});

export default ChatLog;
