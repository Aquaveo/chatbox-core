/**
 * transports.js — MCP transport selection with HTTP-first fallback.
 *
 * Replaces the previous SSE-only, /sse-suffix-appending logic. Supports both
 * `SSEClientTransport` and `StreamableHTTPClientTransport` via URL-suffix
 * heuristic; ambiguous URLs attempt HTTP first (2s), then SSE (3s).
 *
 * CREDENTIAL AUDIT (D3 of 2026-04-22 brainstorm):
 *   Audited SDK version: @modelcontextprotocol/sdk@1.29.0 (2026-04-23).
 *     - `SSEClientTransport`        sdk/client/sse.js:50–85
 *     - `StreamableHTTPClientTransport` sdk/client/streamableHttp.js:55–95, 290–310
 *   Neither transport injects session cookies, CSRF tokens, or Authorization
 *   headers when connecting to cross-origin URLs. Native EventSource/fetch
 *   defaults apply (same-origin cookies only).
 *
 *   RE-AUDIT TRIGGER: any upgrade of @modelcontextprotocol/sdk — rerun the
 *   grep against the upgraded files and update the version above. Silent
 *   regressions here would send app credentials to user-pasted URLs.
 */

import { Client as MCPClient } from "@modelcontextprotocol/sdk/client";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp";

import { sanitizeMcpUrl } from "../helpers/url.js";

import { ERROR_KEYS } from "./mcpErrors.js";

const FULL_BUDGET_MS = 5000;
const FALLBACK_HTTP_BUDGET_MS = 2000;
const FALLBACK_SSE_BUDGET_MS = 3000;
/**
 * Default budget for listTools() after connect succeeds. Without this, a
 * server that accepts the handshake but hangs on list_tools would block a
 * probe scheduler slot indefinitely (review finding #9).
 */
export const LIST_TOOLS_BUDGET_MS = 3000;

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/**
 * Coerce bare hosts and relative paths to absolute URLs, preserving the
 * 0.0.0.0 → localhost rewrite so browsers can actually connect.
 */
function normalizeBaseUrl(serverUrl) {
  const raw = String(serverUrl ?? "").trim();
  if (!raw) throw new Error("MCP server URL is empty.");

  const hasProtocol = /^https?:\/\//i.test(raw);
  const isRelativePath = raw.startsWith("/");

  let normalized;
  if (hasProtocol) {
    normalized = raw;
  } else if (isRelativePath) {
    const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost";
    normalized = `${origin}${raw}`;
  } else {
    normalized = `http://${raw}`;
  }

  normalized = normalized.replace(/\/\/0\.0\.0\.0([:/])/g, "//localhost$1");
  return normalized.replace(/\/+$/, "");
}

/**
 * Scheme-allowlist + mixed-content pre-check. Runs before any transport is
 * constructed so probe (panel) and connectMcpServers (send) share one
 * errorKey taxonomy — review finding #6.
 *
 * Throws with `err.errorKey` set so callers can route without re-mapping.
 */
function preCheckUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    const err = new Error("Invalid URL");
    err.errorKey = ERROR_KEYS.invalidScheme;
    throw err;
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    const err = new Error(`Unsupported URL scheme: ${parsed.protocol}`);
    err.errorKey = ERROR_KEYS.invalidScheme;
    throw err;
  }
  if (
    typeof window !== "undefined"
    && window.location?.protocol === "https:"
    && parsed.protocol === "http:"
  ) {
    const err = new Error("Mixed content: https page cannot connect to http URL");
    err.errorKey = ERROR_KEYS.mixedContent;
    throw err;
  }
}

/**
 * Literal-IP rejection patterns. Matches hostnames that resolve directly to
 * private/loopback/link-local addresses without any DNS round-trip. Does NOT
 * defend against DNS rebinding (a public hostname that resolves to a private
 * IP at fetch time) — that requires a server-side relay and is documented as
 * residual in the plan.
 */
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,                            // 127.0.0.0/8 loopback
  /^10\./,                             // 10.0.0.0/8 private
  /^172\.(1[6-9]|2\d|3[01])\./,        // 172.16.0.0/12 private
  /^192\.168\./,                       // 192.168.0.0/16 private
  /^169\.254\./,                       // 169.254.0.0/16 link-local (incl. AWS IMDS)
  /^0\.0\.0\.0$/,                      // wildcard bind address
  /^::1$/,                             // IPv6 loopback
  /^fe[89ab][0-9a-f]:/i,               // IPv6 link-local fe80::/10
];

/** Test whether a `URL.hostname` is a literal private/loopback/link-local address. */
function isLocalHost(hostname) {
  if (!hostname) return false;
  // URL.hostname strips IPv6 brackets, but be defensive in case the input
  // arrived as "[::1]" from a manual parse.
  const h =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  return PRIVATE_HOST_PATTERNS.some((re) => re.test(h));
}

/**
 * Non-throwing validator for an MCP server URL, used by both the user-typed
 * add path (storage/mcpStorage.js::addMcpServer) and the prop-init path
 * (Chatbox.jsx default-server filter).
 *
 * Pipeline:
 *   1. `sanitizeMcpUrl` — strip credentials, reject non-http(s) schemes.
 *   2. `preCheckUrl` — mixed-content guard for HTTPS-served pages.
 *
 * Loopback / private-IP rejection was removed (2026-05-06) because it
 * blocked the legitimate Aquaveo deployment pattern of running an MCP
 * server alongside a Tethys app on the same host. The literal-IP guard
 * was a defense-in-depth layer against accidental misconfiguration; the
 * primary defense (server-side relay against DNS rebinding) remains the
 * deployment's responsibility. `PRIVATE_HOST_PATTERNS` and `isLocalHost`
 * are still exported in case any caller wants to apply the gate
 * themselves.
 *
 * Returns `{ ok, errorKey?, normalizedUrl?, sanitize? }`. Callers branch
 * on `ok`; on rejection, `errorKey` matches an `ERROR_KEYS` value so the
 * same copy table (`copyFor`) can be reused. `sanitize` is the original
 * `sanitizeMcpUrl` result so callers (like `addMcpServer`) can preserve
 * downstream UI signals such as the credential-stripped alert.
 *
 * @param {string} rawUrl
 * @param {object} [opts] reserved for future options; currently unused.
 */
// eslint-disable-next-line no-unused-vars
export function validateServerUrl(rawUrl, _opts = {}) {
  const sanitize = sanitizeMcpUrl(rawUrl);
  if (sanitize.invalidScheme || !sanitize.url) {
    return { ok: false, errorKey: ERROR_KEYS.invalidScheme, sanitize };
  }

  try {
    preCheckUrl(sanitize.url);
  } catch (err) {
    return {
      ok: false,
      errorKey: err.errorKey ?? ERROR_KEYS.connectionFailed,
      normalizedUrl: sanitize.url,
      sanitize,
    };
  }

  return { ok: true, normalizedUrl: sanitize.url, sanitize };
}

/** Returns "sse" | "http" | "ambiguous" based on the URL path suffix. */
function detectProtocol(normalizedUrl) {
  if (/\/sse$/i.test(normalizedUrl)) return "sse";
  if (/\/(mcp|messages)$/i.test(normalizedUrl)) return "http";
  return "ambiguous";
}

/**
 * Race a promise against a timeout. Rejects with an error tagged so callers
 * can map it to ERROR_KEYS.timeout. Exported for use by probe/send paths
 * that also need to timebox listTools() calls (review finding #9).
 */
export function withTimeout(promise, ms) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const err = new Error(`Operation timed out after ${ms}ms`);
      err.isTimeout = true;
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

/**
 * Attempt a single transport. On any failure the client is treated as
 * unreusable — the SDK's Client.connect() closes itself on initialize
 * failure (sdk/client/index.js:285–328), so callers MUST create a fresh
 * MCPClient per attempt when falling back.
 *
 * On timeout or any connect error, the transport is explicitly close()'d
 * before rethrowing — without this, the underlying fetch/EventSource leaks
 * and can starve the browser's 6-per-origin connection pool (review #2).
 */
async function attemptConnect({ url, kind, budgetMs }) {
  const client = new MCPClient({ name: "chatbox-core", version: "0.1.0" });
  const transport =
    kind === "sse"
      ? new SSEClientTransport(new URL(url))
      : new StreamableHTTPClientTransport(new URL(url));

  try {
    await withTimeout(client.connect(transport), budgetMs);
    return { client, transport, protocolUsed: kind };
  } catch (err) {
    // Best-effort release of the abandoned transport so its underlying
    // fetch/EventSource doesn't outlive this attempt.
    try { await transport.close(); } catch { /* swallow */ }
    throw err;
  }
}

/**
 * Pick a transport for the given URL and return a connected { client, transport,
 * protocolUsed } tuple. Throws on failure with `.errorKey` set to one of
 * ERROR_KEYS so callers can surface the right enum value without re-mapping.
 *
 * Pre-checks scheme + mixed-content BEFORE constructing any transport, so
 * the probe path and the send path share one taxonomy (finding #6).
 *
 * For most callers, prefer `pickTransportWithRetry` — it wraps this function
 * with a bounded retry that recovers from transient cold-start failures
 * common on free-tier hosting (e.g., Cloud Run cold-start; first CORS
 * preflight race; TCP handshake jitter).
 */
export async function pickTransport(serverUrl) {
  const url = normalizeBaseUrl(serverUrl);
  preCheckUrl(url); // throws with errorKey on invalid scheme / mixed-content
  const protocol = detectProtocol(url);

  try {
    if (protocol === "sse") {
      return await attemptConnect({ url, kind: "sse", budgetMs: FULL_BUDGET_MS });
    }
    if (protocol === "http") {
      return await attemptConnect({ url, kind: "http", budgetMs: FULL_BUDGET_MS });
    }
    // Ambiguous: HTTP first, then SSE with the remaining budget.
    try {
      return await attemptConnect({ url, kind: "http", budgetMs: FALLBACK_HTTP_BUDGET_MS });
    } catch {
      return await attemptConnect({ url, kind: "sse", budgetMs: FALLBACK_SSE_BUDGET_MS });
    }
  } catch (err) {
    // Preserve any errorKey set upstream (preCheckUrl) or attach the default.
    if (!err.errorKey) {
      err.errorKey = err.isTimeout ? ERROR_KEYS.timeout : ERROR_KEYS.connectionFailed;
    }
    throw err;
  }
}

export async function closeMcpConnection(connection) {
  if (!connection?.transport) return;
  try { await connection.transport.close(); } catch { /* best effort */ }
}

/**
 * Wrap `pickTransport` with a bounded retry for transient transport-level
 * failures. Without this, freshly-added MCP servers on cold-starting hosts
 * (e.g., nrds-mcps on Cloud Run free tier) fail the first connection
 * attempt and surface as red status dots / empty prompt lists, while the
 * second attempt — triggered by a user toggling the server or reloading
 * the page — succeeds against the now-warm host.
 *
 * Retries only on connection-level errors (`connection-failed`, `timeout`,
 * and unkeyed throws). Precondition failures (`mixed-content`,
 * `invalid-scheme`) are deterministic and fail fast.
 *
 * Default policy: 2 total attempts (1 initial + 1 retry), 1500ms backoff.
 * Worst-case added latency for a permanently-broken URL is the backoff
 * (~1.5s) — the first attempt's timeout dominates either way.
 *
 * See debug session 2026-05-18 — both the probe-red-on-first-add and the
 * "need to reload to see prompts/tools" symptoms trace to single-shot
 * `pickTransport` calls in `engine/probe.js`, `discoverPrompts`, and
 * `connectMcpServers`.
 */
export async function pickTransportWithRetry(
  serverUrl,
  { maxAttempts = 2, backoffMs = 1500 } = {},
) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await pickTransport(serverUrl);
    } catch (err) {
      lastErr = err;
      const isPrecondition =
        err?.errorKey === ERROR_KEYS.mixedContent ||
        err?.errorKey === ERROR_KEYS.invalidScheme;
      if (isPrecondition) throw err;
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }
  throw lastErr;
}
