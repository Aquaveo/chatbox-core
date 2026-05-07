import { useRef, useCallback, useEffect } from "react";
import styled from "styled-components";
import ContextUsageIndicator from "./ContextUsageIndicator";

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
}) {
  const textareaRef = useRef(null);

  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onSend();
      }
    },
    [onSend],
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
        placeholder="Send a message…"
        rows={1}
        value={input}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        disabled={loading}
        aria-label="Chat message input"
      />
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
