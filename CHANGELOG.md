# Changelog

All notable changes to `@aquaveo/chatbox-core` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(pre-1.0: minor bumps may carry breaking changes during stabilization).

## [Unreleased]

## [0.11.0] — 2026-05-19

### Added

- **Shell-style ArrowUp/ArrowDown prompt history navigation in `<ChatInputBar>`.** ArrowUp walks back through prior user messages; ArrowDown walks forward. Typed-but-unsent text is preserved in a draft slot — pressing ArrowUp saves the in-progress input, walking forward past the most-recent message restores it. Editing a recalled prompt forks history (the edited text is what gets sent; the original entry in `messages` is unchanged). Sending (Enter) resets the nav state so the next ArrowUp recalls the just-sent message.

  Slash-popover ArrowUp/ArrowDown semantics from v0.8.0 are preserved — history nav fires only when the popover is closed. Shift+ArrowUp/Down preserves the native textarea cursor behavior.

  New optional `messages` prop on `<ChatInputBar>` (default `[]`); `<Chatbox>` wires it automatically from its internal `messages` state. Npm consumers using `<ChatInputBar>` standalone can pass their own history array (or omit it; nav becomes a no-op with no history to recall). No new public `<Chatbox>` props.

## [0.10.0] — 2026-05-19

### Added

- **Probe scheduler reuses the v0.9.0 connection cache.** `createProbeScheduler({ ..., cache })` accepts an optional `cache` factory argument. When provided, `runProbe` calls `cache.getOrOpen(url)` instead of opening its own transient transport — sharing one session per server URL across probes, chat turns, discovery, and `getPrompt`. Eliminates the parallel probe-only MCP session per server at panel-open that was visible in v0.9.0.

  On cache hit (chat turn or earlier discovery already populated the URL), the probe resolves with zero new network calls. On cache miss, the resulting transport stays open for downstream operations to reuse (the cache's job).

  The probe scheduler's UX semantics are unchanged: `yellow` intermediate state with `YELLOW_MIN_DISPLAY_MS` min-display timing, bounded concurrency, and `cancel(url)` / `cancelAll()` external behavior all preserved. Probe failures continue to NOT be cached — each panel-open against an unreachable server is a fresh retry.

### Changed

- **`cancel(url)` and `cancelAll()` no longer close cache-owned transports.** When a probe is cancelled with the cache in use, the gen is bumped and the entry is dropped from the in-flight map, but the cache's transport is left intact. Cache owns transport lifetime across the Chatbox mount; cancelling a probe shouldn't destroy a session other operations may be using. Without a cache (npm consumers that don't construct one), `cancel`/`cancelAll` preserve the existing close-on-cancel behavior.

- **`mapProbeError(err, phase)` now reads `err?._cachePhase ?? phase`.** Cache-thrown errors carry a `_cachePhase` marker attached by the v0.9.0 cache module; the new precedence makes the existing errorKey mapping (`notMcpServer` vs `connectionFailed`) work uniformly for cache-path and transient-path failures. Symmetric with v0.9.0's `connectMcpServers` catch block.

### Internal

- `components/Chatbox.jsx`: one-line wire — `cache: getCache()` added to the existing `createProbeScheduler({...})` call. `getCache` declaration moved before `getScheduler` so the latter's useCallback can reference it in its deps array without TDZ violation.
- Backward compat: every code path is preserved when no `cache` is passed to `createProbeScheduler`. Npm consumers that don't construct a cache see zero behavior change.

## [0.9.0] — 2026-05-19

### Added

- **Per-Chatbox-mount MCP connection cache.** One transport per server URL is reused across `connectMcpServers`, `executeTool`, `discoverPrompts`, and `getPrompt` for the entire lifetime of a `<Chatbox>` mount. A 10-message conversation against 3 MCP servers now performs 3 `listTools` requests total (one per server, first turn only), not 30.

  New module `engine/connection-cache.js` exports `createConnectionCache()` — a factory returning an in-memory `Map<url, {conn, tools}>` with four lifecycle methods: `getOrOpen(url)`, `invalidate(url)`, `invalidateUrlsNotIn(activeUrls)`, `closeAll()`. Concurrent calls for the same URL share a single in-flight open via a `pendingOpens` dedup Map. The cache is internal to `<Chatbox>` (held via `useRef`); no new public props.

  Engine functions opt in via an optional `{cache}` (or `{cache, memo}` for `discoverPrompts`) parameter. Without a cache, the existing transient open-list-close pattern is preserved — npm consumers that don't construct a cache inherit zero behavior change.

- **Transparent reconnect-and-retry on `callTool` transport errors.** When a cached client's `callTool` throws a transport-level error (server restart, network blip), `executeTool` invalidates the cache entry, reopens the transport, and retries the same tool call once before propagating any failure. The LLM never sees the first transport error. Tool-body error envelopes (`{error: "..."}` returned, not thrown) do NOT trigger retry — only transport-level throws do.

- **`discoverPrompts` URL-set-hash memoization.** `discoverPrompts(servers, {cache, memo})` memoizes its result keyed by sorted-URL-set hash. Reference changes to the `allMcpServers` prop with equal URLs are zero-cost (no transport touch, no `listPrompts` request). URL order doesn't affect the memo key.

- **Allmcpservers URL-set-change cleanup.** When the user toggles, adds, or removes an MCP server, `<Chatbox>` calls `cache.invalidateUrlsNotIn(activeUrls)` to close transports for URLs no longer in the active set. Surviving URLs keep their cached entries.

- **Unmount cleanup.** `<Chatbox>` unmount fires `cache.closeAll()` so no MCP transports outlive the component.

### Internal

- `connectMcpServers` errors from the cache path carry a `_cachePhase` marker (`"transport"` or `"list_tools"`) so the existing errorKey mapping (`notMcpServer` vs `connectionFailed`) works unchanged.
- `runChatSession` skips its end-of-turn `closeAllMcpConnections` when a `connectionCache` is provided — the cache owns transport lifetime across turns.

### Scope notes

- The probe scheduler (status badge in the MCP server panel) is **NOT** cached. Probe path keeps its current transient-connect-and-close pattern; probe-burst is bounded to once-per-server-per-Chatbox-mount via the existing `hasProbedThisSessionRef`.
- No TTL-based expiry, no manual "Refresh tools" hook, no cross-mount persistence, no observability surface in v1. All out-of-scope by design and tracked in the brainstorm for follow-up if needed.

## [0.8.0] — 2026-05-19

### Added

- **`/clear` slash command + `clientCommands` extension point.** Built-in `/clear` wipes the conversation context end-to-end: aborts any in-flight LLM request via the existing AbortController plumbing, empties the in-memory `messages` array, clears the IndexedDB conversation cache via `clearConversation(conversationId)`, and fires the new `onClear` host callback so the host can wipe its own persistence layer (e.g., localStorage chat history). Each step is best-effort; non-fatal errors log without rolling back already-cleared state.

  New `<Chatbox>` props:
  - `clientCommands: Array<{ name: string, description: string, execute: () => void | Promise<void> }>` — host can register additional `/<name>` commands that fire local callbacks instead of LLM dispatch. Items appear in the slash popover alongside MCP prompts.
  - `onClear: () => void | Promise<void>` — fires after the engine wipe completes.

  Built-in `/clear` is always available regardless of the `clientCommands` prop. Host entries named `/clear` override the built-in. MCP prompts are listed first in the popover so existing "type `/` + Enter selects first MCP prompt" behavior is preserved.

  Direct-type intercept: typing `/clear` + Enter with the popover dismissed still fires execute (case-insensitive, trim-tolerant, exact match — `/clearfoo` falls through to LLM dispatch).

### Fixed

- **IndexedDB transaction auto-commit race in `engine/cache.js` `runTx`.** Previously `tx.oncomplete` was attached INSIDE the inner Promise's `.then(...)` callback, which can fire AFTER the IDB transaction has already auto-committed — leaving no handler attached and the outer Promise hanging forever. Observed in real Chrome 2026-05-19 against the cursor-walk path in `clearConversation`: `/clear` correctly wiped the in-memory messages but the IndexedDB entries persisted indefinitely. The same race existed silently on the write path (`store.put`); writes were small enough that the race window rarely opened, but the fix applies uniformly.

  Fix attaches `tx.oncomplete` / `tx.onerror` / `tx.onabort` synchronously when the transaction is created, captures work's value into a closure, and resolves at oncomplete with the captured value. Inner-Promise rejections explicitly abort the transaction so half-committed state cannot masquerade as success.

  Regression test added: `clearConversation` resolves within 500ms on a populated conversation (5 entries × 200 rows). Hung indefinitely under the old `runTx`.

## [0.7.0] — 2026-05-19

### Added

- **MCP result-by-reference protocol (Units 1-4).** New `<Chatbox
  enableResultCache>` opt-in adds an IndexedDB-backed cache for
  oversized tool results plus a substitution layer in `processToolCalls`
  that resolves `*_uri` args to inline data before dispatch. Eliminates
  the LLM transcription bottleneck observed in production 2026-05-18
  where a 240-row time-series array took ~127s of LLM output tokens to
  regenerate between two MCP servers.

  - **Auto-cache heuristic:** tool results whose serialized size
    exceeds `MAX_TOOL_RESULT_CHARS` (4 KB, matching v0.6.4's truncation
    cap) are written to IndexedDB keyed by an
    `mcp+cache://<conv-id>/<8-byte-base64url>` URI. The URI is surfaced
    to the LLM as `_cache_uri` on the tool result envelope.
  - **Substitution at dispatch:** when a subsequent tool call has any
    arg ending in `_uri` whose value matches the `mcp+cache://` scheme,
    chatbox-core looks up the cached payload and substitutes it into
    the corresponding non-`_uri` arg before dispatching. The receiving
    server tool sees inline data — no MCP wire-contract change needed.
  - **Array URIs supported:** `layers_uri: [u1, u2, u3]` resolves each
    URI and substitutes `layers: [p1, p2, p3]`.
  - **Conflict resolution:** if the LLM passes BOTH `data` and
    `data_uri`, URI wins, inline dropped, console.info logged.
  - **Cache miss:** returns `invalid_args` envelope with `_missing_uris`
    + `fix_hint`; tool dispatch short-circuits. No auto-retry in v1.
  - **Per-mount opt-in:** `<Chatbox enableResultCache={false}>` default
    so npm consumers that don't opt in inherit zero behavior change.
  - **Truncation-summary preservation:** when the bulk payload was
    dropped by v0.6.4's truncation pass, the `_cache_uri` is still
    surfaced in the summary so the LLM has the reference even when
    the data was too large to fit in the per-tool-result cap.

  New host props on `<Chatbox>`:
  - `enableResultCache: boolean` (default `false`)
  - `conversationId: string` (default `"default"`) — used as the conv-id
    segment of minted URIs and as the scope for `clearConversation`
    (host calls this on dashboard switch / chat reset).

  New engine surface in `engine/cache.js`:
  - `cacheToolResult({payload, convId, sourceToolName, threshold})`
  - `readCachedPayload(uri)`
  - `clearConversation(convId)`
  - `evictOlderThan({maxAgeMs})`
  - `mintCacheUri(convId)`, `estimateSize(payload)`, `hasIndexedDB()`

  Plan: `docs/plans/2026-05-18-002-feat-mcp-result-by-reference-protocol-plan.md`
  in the firoh workspace.

  Companion: receiving side ships in
  `Aquaveo/tethysdash_mcps` PR #7 — `data_uri` opt-in on
  `create_plotly_chart`, `create_data_table`, `create_card`.

  Suite: 463 → 495 passed (+32 new tests across `engine/cache.test.js`,
  `engine/cache-instrumentation.test.js`, `engine/uri-substitution.test.js`).

### Removed (BREAKING — pre-1.0 acceptable)

- **`resolveModelCapability` from `engine/index.js`** and the entire
  `storage/capabilityStorage.js` module (~450 lines including tests).
  This was the reactive auto-learn write-side of the per-model
  capability-gating subsystem, retired when the proactive
  capability-detection path (`/api/show.capabilities` for Ollama,
  name-pattern for OpenAI, constant for Anthropic — all in
  `helpers/index.js → listModels`) became authoritative.
  The reactive trigger (`recordFailure`) was never called in
  production after the proactive pivot, so the storage never received
  writes, `getOverride` always returned null, and `resolveModelCapability`
  itself was only consumed by its own test file (which explicitly
  documented "retained for display/diagnostics compatibility, but it
  must not cause the engine to withhold MCP tools").
  External consumers that imported any of `resolveModelCapability`,
  `recordFailure`, `clearOverride`, `clearExpired`, `getOverride`,
  `resetFailureCounter`, `CAPABILITY_SCHEMA_VERSION`, or `TTL_MS`
  should switch to consuming `listModels`-returned model entries'
  `capabilities` arrays directly. None of these symbols were
  re-exported from the package root (`index.js`), so consumers using
  only the public barrel are unaffected.

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
