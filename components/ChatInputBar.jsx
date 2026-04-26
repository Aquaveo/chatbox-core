import { useRef, useCallback } from "react";
import styled from "styled-components";
import ContextUsageIndicator from "./ContextUsageIndicator";

const InputSection = styled.section`
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.xl};
  background: ${({ theme }) => theme.colors.surfaceInput};
  padding: ${({ theme }) => theme.spacing.md};
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.spacing.sm};
`;

const Textarea = styled.textarea`
  width: 100%;
  box-sizing: border-box;
  resize: none;
  min-height: 44px;
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

const ModelSelect = styled.select`
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.full};
  padding: 0.3rem 0.6rem;
  font-size: ${({ theme }) => theme.fontSize.sm};
  font-weight: 600;
  color: ${({ theme }) => theme.colors.textMuted};
  background: transparent;
  cursor: pointer;
  outline: none;
  min-width: 140px;
  flex: 1 1 auto;
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

const ProviderGlyphs = {
  openai: "AI",
  anthropic: "An",
  ollama: "Ll",
  custom: "Cu",
};
const ProviderLabels = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  ollama: "Ollama",
  custom: "Custom",
};
function providerGlyph(provider) {
  return ProviderGlyphs[provider] ?? "Lo";
}
function providerLabel(provider) {
  return ProviderLabels[provider] ?? "Local";
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
      const el = e.target;
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    },
    [setInput],
  );

  return (
    <InputSection>
      <Textarea
        ref={textareaRef}
        placeholder={`Message ${selectedModel || "assistant"}...`}
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
          <ModelSelect
            value={selectedModel}
            onChange={(e) => onModelChange(e.target.value)}
            disabled={loading || loadingModels || !availableModels.length}
          >
            {availableModels.length ? (
              availableModels.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.capabilities?.includes("thinking") ? "\uD83D\uDCA1 " : ""}{m.name}
                </option>
              ))
            ) : (
              <option value="">{loadingModels ? "Loading..." : "No models"}</option>
            )}
          </ModelSelect>
          <ContextUsageIndicator used={contextUsage.used} total={contextUsage.total} />
          <IconPillButton
            type="button"
            $active={showProviderPanel}
            onClick={onToggleProviderPanel}
            title={`LLM provider: ${providerLabel(providerConfig?.provider)}`}
            aria-label={`LLM provider settings — current: ${providerLabel(providerConfig?.provider)}`}
          >
            {providerGlyph(providerConfig?.provider)}
          </IconPillButton>
        </Toggles>
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
