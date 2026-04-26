/**
 * ChatMessage — Generic message bubble with avatar and content.
 *
 * Renders text only (via MarkdownContent). No domain-specific panel indicators.
 * Visualization results come via the pendingVisualizations path (DOM events),
 * not as message properties.
 */

import styled from "styled-components";
import MarkdownContent from "./markdownContent";

const ChatRow = styled.div`
  display: flex;
  align-items: flex-start;
  gap: ${({ theme }) => theme.spacing.md};
  flex-direction: ${(props) => (props.$isUser ? "row-reverse" : "row")};
`;

const Avatar = styled.div`
  flex-shrink: 0;
  width: ${({ theme }) => theme.sizes.avatar};
  height: ${({ theme }) => theme.sizes.avatar};
  border-radius: ${({ theme }) => theme.radius.circle};
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 2px;
  background: ${(props) => (props.$isUser ? props.theme.colors.avatarUser : props.theme.colors.avatarBot)};
  color: ${({ theme }) => theme.colors.surface};
`;

const Bubble = styled.article`
  border-radius: ${({ theme }) => theme.radius.md};
  padding: ${({ theme }) => `${theme.spacing.lg} 0.9rem`};
  text-align: left;
  min-width: 0;
  overflow: hidden;
  background: ${(props) => (props.$isUser ? props.theme.colors.userBubble : props.theme.colors.assistantBubble)};
  max-width: ${(props) => (props.$isUser ? "80%" : "100%")};
  flex: ${(props) => (props.$isUser ? "unset" : "1")};

  p { margin: 0; white-space: pre-wrap; }
  pre, code, .max-w-none, .max-w-none > div, .max-w-none span {
    white-space: pre-wrap; word-break: break-all; overflow-wrap: break-word;
  }
`;

const ThinkingDropdown = styled.details`
  margin: ${({ theme }) => `${theme.spacing.sm} 0 ${theme.spacing.md}`};
  border: 1px solid ${({ theme }) => theme.colors.thinkingBorder};
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.thinking};
  font-size: ${({ theme }) => theme.fontSize.base};
  width: 100%;
  box-sizing: border-box;

  summary {
    cursor: pointer;
    padding: ${({ theme }) => `${theme.spacing.sm} 0.7rem`};
    font-weight: 600;
    color: ${({ theme }) => theme.colors.thinkingText};
    user-select: none;
    &:hover { color: ${({ theme }) => theme.colors.thinkingTextHover}; }
  }

  pre {
    margin: 0;
    padding: ${({ theme }) => `${theme.spacing.md} 0.7rem`};
    white-space: pre-wrap;
    font-family: "JetBrains Mono", "SFMono-Regular", Menlo, Consolas, monospace;
    font-size: ${({ theme }) => theme.fontSize.sm};
    line-height: 1.4;
    max-height: 300px;
    overflow-y: auto;
    border-top: 1px solid ${({ theme }) => theme.colors.thinkingBorderInner};
  }
`;

const UserIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 12c2.7 0 5-2.3 5-5s-2.3-5-5-5-5 2.3-5 5 2.3 5 5 5zm0 2c-3.3 0-10 1.7-10 5v2h20v-2c0-3.3-6.7-5-10-5z" />
  </svg>
);

const BotIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M20 9V7c0-1.1-.9-2-2-2h-3c0-1.7-1.3-3-3-3S9 3.3 9 5H6c-1.1 0-2 .9-2 2v2c-1.7 0-3 1.3-3 3s1.3 3 3 3v4c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-4c1.7 0 3-1.3 3-3s-1.3-3-3-3zM9 14c-.8 0-1.5-.7-1.5-1.5S8.2 11 9 11s1.5.7 1.5 1.5S9.8 14 9 14zm6 0c-.8 0-1.5-.7-1.5-1.5s.7-1.5 1.5-1.5 1.5.7 1.5 1.5S15.8 14 15 14z" />
  </svg>
);

export default function ChatMessage({ message, isEmbedded, MessageRenderer }) {
  const isUser = message.role === "user";

  return (
    <ChatRow $isUser={isUser}>
      <Avatar $isUser={isUser}>
        {isUser ? <UserIcon /> : <BotIcon />}
      </Avatar>
      <Bubble $isUser={isUser}>
        {!isUser && message.thinking && (
          <ThinkingDropdown>
            <summary>Thinking</summary>
            <pre>{message.thinking}</pre>
          </ThinkingDropdown>
        )}
        {isUser ? (
          message.content && <MarkdownContent content={message.content} />
        ) : MessageRenderer ? (
          <MessageRenderer message={message} isEmbedded={isEmbedded} />
        ) : (
          message.content && <MarkdownContent content={message.content} />
        )}
      </Bubble>
    </ChatRow>
  );
}

export { Avatar, Bubble, ThinkingDropdown, BotIcon };
