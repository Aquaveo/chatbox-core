/**
 * llmProviderStorage.js
 *
 * Persists LLM provider configuration to localStorage.
 * Provider config: { provider, baseUrl, apiKey }
 */

const STORAGE_KEY = "chatbox_llm_provider";

const PROVIDER_PRESETS = {
  openai: { baseUrl: "https://api.openai.com/v1", label: "OpenAI", reasoningEffort: "medium" },
  anthropic: { baseUrl: "https://api.anthropic.com/v1", label: "Anthropic", thinkingBudget: 4096 },
  ollama: { baseUrl: "", label: "Ollama Cloud" },
  custom: { baseUrl: "", label: "Local / Custom" },
};

export function getProviderConfig() {
  const fallback = { provider: "custom", baseUrl: "", apiKey: "" };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const config = JSON.parse(raw);
    // Backfill thinking settings from presets for configs saved before this feature
    const preset = PROVIDER_PRESETS[config.provider] || {};
    if (preset.thinkingBudget != null && config.thinkingBudget == null) {
      config.thinkingBudget = preset.thinkingBudget;
    }
    if (preset.reasoningEffort && !config.reasoningEffort) {
      config.reasoningEffort = preset.reasoningEffort;
    }
    return config;
  } catch {
    return fallback;
  }
}

export function saveProviderConfig(config) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // localStorage full or unavailable
  }
}

export function getPreset(provider) {
  return PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;
}

export { PROVIDER_PRESETS };
