import { useState } from "react";
import styled from "styled-components";
import { getProviderConfig, saveProviderConfig, PROVIDER_PRESETS } from "../storage/llmProviderStorage.js";

const Panel = styled.div`
  padding: 12px;
  border-top: 1px solid ${({ theme }) => theme.colors?.border || "#e0e0e0"};
  font-size: 0.85rem;
`;

const Label = styled.label`
  display: block;
  font-weight: 600;
  margin: 8px 0 4px;
  color: ${({ theme }) => theme.colors?.textSecondary || "#555"};
  font-size: 0.8rem;
`;

const Select = styled.select`
  width: 100%;
  padding: 6px 8px;
  border: 1px solid #ccc;
  border-radius: 4px;
  font-size: 0.85rem;
`;

const Input = styled.input`
  width: 100%;
  padding: 6px 8px;
  border: 1px solid #ccc;
  border-radius: 4px;
  font-size: 0.85rem;
  box-sizing: border-box;
`;

const SaveButton = styled.button`
  margin-top: 10px;
  padding: 6px 16px;
  background: #198754;
  color: #fff;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.8rem;
  &:hover { background: #157347; }
`;

const Header = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
`;

const Title = styled.span`
  font-weight: 700;
  font-size: 0.9rem;
`;

export default function LLMProviderPanel({ onSave }) {
  const [config, setConfig] = useState(() => getProviderConfig());

  const handleProviderChange = (e) => {
    const provider = e.target.value;
    const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;
    setConfig((prev) => ({
      ...prev,
      provider,
      baseUrl: preset.baseUrl || prev.baseUrl,
      thinkingBudget: preset.thinkingBudget ?? prev.thinkingBudget,
      reasoningEffort: preset.reasoningEffort ?? prev.reasoningEffort,
    }));
  };

  const handleSave = () => {
    saveProviderConfig(config);
    onSave?.(config);
  };

  const isCustom = config.provider === "custom";
  const showUrlField = isCustom || config.provider === "ollama";

  return (
    <Panel>
      <Header>
        <Title>LLM Provider</Title>
      </Header>

      <Label>Provider</Label>
      <Select value={config.provider} onChange={handleProviderChange}>
        {Object.entries(PROVIDER_PRESETS).map(([key, { label }]) => (
          <option key={key} value={key}>{label}</option>
        ))}
      </Select>

      {showUrlField && (
        <>
          <Label>Base URL</Label>
          <Input
            type="text"
            placeholder={config.provider === "ollama" ? "https://ollama.com" : "http://localhost:11434/v1"}
            value={config.baseUrl}
            onChange={(e) => setConfig((prev) => ({ ...prev, baseUrl: e.target.value }))}
          />
        </>
      )}

      <Label>API Key {isCustom ? "(optional)" : ""}</Label>
      <Input
        type="password"
        placeholder={isCustom ? "Optional" : "Required"}
        value={config.apiKey}
        onChange={(e) => setConfig((prev) => ({ ...prev, apiKey: e.target.value }))}
      />

      {config.provider === "anthropic" && (
        <>
          <Label>Thinking Budget (tokens)</Label>
          <Input
            type="number"
            min="1024"
            max="128000"
            step="1024"
            placeholder="4096"
            value={config.thinkingBudget ?? 4096}
            onChange={(e) => setConfig((prev) => ({ ...prev, thinkingBudget: Number(e.target.value) || 4096 }))}
          />
        </>
      )}

      {config.provider === "openai" && (
        <>
          <Label>Reasoning Effort</Label>
          <Select
            value={config.reasoningEffort || "medium"}
            onChange={(e) => setConfig((prev) => ({ ...prev, reasoningEffort: e.target.value }))}
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </Select>
        </>
      )}

      <SaveButton onClick={handleSave}>Save</SaveButton>
    </Panel>
  );
}
