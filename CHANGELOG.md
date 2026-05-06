# Changelog

All notable changes to `@aquaveo/chatbox-core` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(pre-1.0: minor bumps may carry breaking changes during stabilization).

## [Unreleased]

## [0.4.0] — 2026-05-06

Two reversals of recently-shipped gates that turned out to block
legitimate use more than they prevented the threats they targeted:

1. The literal-IP / loopback rejection in `validateServerUrl()`
   (originally landed alongside the April 26 probe-scheduler hardening).
2. The capability-based tool gating from Plan 002 (shipped one day
   ago in 0.3.0 / PR #5).

Both followed the same pattern: a defense-in-depth check applied
inside the chatbox-core library that didn't have access to enough
deployment context to distinguish "real attacker" from "the
documented Aquaveo flow." Removed; the deployment is responsible for
its own auth / CORS / model selection, and chatbox-core trusts what
its host tells it.

### Breaking changes

- **`ERROR_KEYS.privateIp` removed.** Downstream code branching on
  this key must delete the branch on upgrade. The matching
  `ERROR_COPY` entry ("Private or loopback addresses are not
  allowed in production") is gone too.
- **`validateServerUrl` no longer accepts an `allowLocal` option.**
  All `http(s)://` URLs that pass scheme sanitization +
  credential-stripping + mixed-content checks are accepted,
  regardless of host.
- **`runChatSession` parameters removed**: `onSessionNotice`,
  `onContentReset`, `modelList`. Hosts that wired these up should
  delete the wiring; tools are now always offered when MCP servers
  expose them, so the "tools-disabled" UI surface they powered is
  obsolete.

### Loopback / private-IP rejection — removed

The `validateServerUrl()` literal-IP guard was a partial defense for
a threat (DNS rebinding) it could not actually prevent — its own
docstring conceded as much — and it blocked the legitimate Aquaveo
deployment pattern of co-locating an MCP server with the host
application on the same machine. CORS on the MCP server is now the
load-bearing browser-side defense for cross-origin abuse of localhost
MCP servers.

`PRIVATE_HOST_PATTERNS` and `isLocalHost` remain exported so consumers
that have an authoritative reason to gate (e.g. multi-tenant relays,
browser extensions) can apply the check at their own layer.

Loopback / private / link-local hostnames are now accepted by default,
including `localhost`, `127.0.0.1`, `[::1]`, RFC1918 ranges,
`169.254.0.0/16`, and `fe80::/10`. Matches the original brainstorm
decision (D2 of the April 22 MCP server health-probe requirements)
before the April 26 hardening plan partially reversed it.

### Capability-based tool gating — removed

Plan 002 (shipped in 0.3.0) gated MCP tools off when the active
model's capability resolved to `unsupported`, or to `unknown` for the
ollama provider. The intent was to spare small/incompatible models
from refusal classes ("I don't have access to tools"). In practice,
TethysDash workflows are tool-driven on every meaningful turn — the
gate withheld the tools the user actually wanted — and the
auto-learn fallback that was supposed to soften the failure mode
introduced its own surprise (silent locking based on per-browser
localStorage classifications that the user couldn't see).

`runChatSession` no longer derives `toolsGated` from capability +
provider. Tools are always selected from the live tool list when MCP
servers expose them. Capability metadata is still resolved (via
`resolveModelCapability`) so hosts can render display / diagnostic
hints, but the engine no longer acts on it.

UI surface removed: `ChatMessage.jsx`'s `$toolsGated` styled-component
prop and the faint left-border marker on assistant turns produced
under tool-gating. The `_toolsGated` message field is no longer set
or read.

`looksLikeToolRefusal()` in `helpers/index.js` is retained for
downstream callers and tests but is no longer used by the engine
loop. Its docstring now reflects the legacy status.

### Internal

- `engine/transports.test.js`: "literal-IP rejection" and
  "allowLocal toggle" describe blocks replaced by a single
  "loopback / private IPs are accepted" suite (12 host shapes +
  an explicit `NODE_ENV=production` acceptance check).
- `engine/capabilityGating.test.js`: gating decision table reversed
  — `isGated()` now returns `false` for every input. The
  `resolveModelCapability` resolution table is kept (still used for
  diagnostics).

### Solution doc

`docs/solutions/best-practices/chatbox-core-loopback-validation-removed-2026-05-06.md`
in the firoh workspace captures the threat-model framing for the
loopback-gate removal, including the decision-boundary table and the
post-removal CORS-as-load-bearing-defense expectation for downstream
consumers.

## [0.3.0] — 2026-05-04

Adds the dispatch-feedback contract: hosts get authoritative ground
truth about what the engine actually dispatched per tool call, and a
new state surface for tag-based UI affordances. Additive on the
public API — consumers that ignore unknown keys are unaffected.

### Features

- **Engine — `_engine_dispatched` field on tool results.** Every
  object-shaped tool result the engine forwards to the LLM gains a
  `_engine_dispatched: [<uuid>, ...]` field naming the envelope UUIDs
  *this* tool call dispatched (per-call delta, not cumulative). The
  LLM uses this as in-band ground truth to decide whether a tile was
  actually rendered. Empty array means the call returned data only.
  Skipped silently for non-object/null results. Pre-existing key in
  the source result is overwritten with the engine's authoritative
  value, with a `console.warn`.
- **Engine — `toolTagsByName` state surface.** During
  `connectMcpServers`, the engine now captures the `tags` field from
  each MCP tool's `tools/list` entry into a `Map<toolName, string[]>`
  exposed on returned engine state. Hosts can use this to evaluate
  per-turn tag-based UI rules without re-reading the server response.
  First-wins on tool-name collision across servers, matching the
  existing `toolServerMap` collision behavior.
- **Engine — `state.toolCallsThisTurn` per-turn list.**
  `processToolCalls` now appends one entry per tool call —
  `{toolName, hadDomainError}` — into a turn-scoped list on engine
  state. Callers reset the array at the top of each turn iteration.
  Enables hosts to render per-turn affordances (such as the
  dispatch-feedback banner) keyed off whether a tagged tool was
  called and whether its result carried a domain error.
- **Engine — structured truncation across all envelope kinds.** The
  oversized-result compact summary now preserves
  `_engine_dispatched` for `visualization`, `layer_update`, and
  `patch_update` envelopes. Fixes a pre-existing latent bug where
  `layer_update` and `patch_update` truncation fell through to a
  naive string-slice that destroyed their structure in the
  LLM-visible message.

### Engine-reserved tool-result keys

Tool authors should treat the following top-level keys as
engine-reserved on tool results. The engine may inject, mutate, or
overwrite them at result-forwarding time. Choose different names
when designing your own tool surfaces.

- `_engine_dispatched` — UUIDs dispatched by the call (added 0.3.0)
- `_truncated` — boolean, set when the result was compact-summarized
- `_originalChars` — char count of the pre-truncation JSON
- `_toolsGated` — used by capability-gating extensions
- `_raw` — used by extension messages

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
