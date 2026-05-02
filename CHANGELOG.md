# Changelog

All notable changes to `@aquaveo/chatbox-core` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(pre-1.0: minor bumps may carry breaking changes during stabilization).

## [Unreleased]

## [0.2.0-beta.0] — 2026-05-02

First prerelease publish to npm under `@aquaveo/chatbox-core`. Promoted
from a private workspace package (`@chatbox/core`) consumed by tethysdash
via a `file:` link.

### Features

- **Engine** — generic MCP tool-use conversation loop with provider
  adapters (Anthropic, OpenAI, Ollama). Streaming, thinking-mode,
  context-usage tracking. Multi-server MCP support with per-server
  outcome reporting.
- **Transports** — SSE and StreamableHTTP transport selection with
  HTTP-first fallback for ambiguous URLs. Split timeout budget (2s/3s).
  Catch-path `transport.close()` on every connect failure.
- **Probe scheduler** — 4-slot concurrency-capped scheduler with
  generation-counter cancellation, post-unmount race protection
  (`destroyed` flag), and yellow-min-display timing for status dot
  flicker prevention.
- **URL safety** — `validateServerUrl` SSRF guard with literal-IP
  rejection (private/loopback/link-local), credential redaction in
  logs, `allowLocal` toggle keyed off NODE_ENV.
- **Name safety** — HTML-entity-safe `sanitizeServerName` with
  double-encoding defense (decode-then-strip loop).
- **Components** — `<Chatbox>`, `<ChatLog>`, `<ChatMessage>`,
  `<ChatInputBar>`, `<MCPServerPanel>`, `<LLMProviderPanel>`,
  `<McpStatusDot>`, `<ContextUsageIndicator>`, markdown content
  renderer.
- **Storage** — localStorage-backed MCP server + LLM provider
  persistence helpers.
- **Helpers** — URL normalization (`sanitizeMcpUrl`), error key
  registry (`ERROR_KEYS`/`ERROR_COPY`), embeddings utilities.
- **Pendings protocol** — visualization + layer update accumulation
  with patch protocol (`afterToolExecution` hook,
  `pendingPatches`).

### Tests

- 105 vitest unit tests covering URL safety (39), transport
  selection + fallback (48), probe scheduler (18). Runs in
  ~830 ms with vitest 3.2.4 + jsdom 25.

### Build

- Vite 6.x ESM-only output to `dist/`. Code-split bundles for
  components, engine, helpers, transports.

### Notes

- Self-contained — only `react`, `react-dom`, and `styled-components`
  required as peerDependencies.
- For dev-mode consumption via `file:` link, see the linked
  package's `.npmrc` (`legacy-peer-deps=true`) — required to avoid
  duplicate React instances under symlink resolution.

[Unreleased]: https://github.com/Aquaveo/chatbox-core/compare/v0.2.0-beta.0...HEAD
[0.2.0-beta.0]: https://github.com/Aquaveo/chatbox-core/releases/tag/v0.2.0-beta.0
