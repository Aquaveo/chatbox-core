/**
 * engine/connection-cache.js — per-Chatbox-mount MCP connection cache.
 *
 * Plan: docs/plans/2026-05-19-002-feat-mcp-connection-cache-plan.md
 *
 * Solves: each operation against an MCP server (`listTools`, `callTool`,
 * `listPrompts`, `getPrompt`) currently opens its own transient transport
 * and closes it when done. Across a multi-turn conversation against
 * multiple servers, this produces O(turns × servers) redundant
 * `listTools` requests and connection handshakes.
 *
 * The cache holds one `{ conn, tools }` entry per server URL for the
 * lifetime of a single `<Chatbox>` mount. Engine functions opt in by
 * accepting a cache instance via an optional `{ cache }` parameter.
 * Without a cache the existing transient pattern is preserved (backward
 * compatible for npm consumers that don't construct one).
 *
 * Invalidation:
 *   - `invalidate(url)` — drop a single entry. Called by `executeTool`
 *     after a transport-level error so the next operation reopens fresh.
 *   - `invalidateUrlsNotIn(activeUrls)` — drop entries for URLs no longer
 *     in the active server set. Called by Chatbox.jsx on
 *     `allMcpServers` change.
 *   - `closeAll()` — drop everything. Called by Chatbox.jsx on unmount.
 *
 * Concurrency:
 *   Two simultaneous `getOrOpen(url)` calls for the same URL share a
 *   single in-flight open via a `pendingOpens` map. The second caller
 *   awaits the first's promise. No parallel handshakes for the same URL.
 *
 * Error handling:
 *   - `pickTransportWithRetry` failures propagate; no entry is stored
 *     and the next call retries fresh (no cached-failure state).
 *   - `listTools` failures after a successful open close the transport
 *     before propagating, so no socket leaks.
 *
 * Scope:
 *   - In-memory only. Lost on Chatbox unmount (intentional — matches
 *     React component lifecycle).
 *   - Per-instance. Two Chatboxes mounted simultaneously have independent
 *     caches.
 *   - No TTL, no probe collision detection, no observability hooks.
 *     Out of scope per the plan's non-goals.
 */

import {
  pickTransportWithRetry,
  closeMcpConnection,
  withTimeout,
  LIST_TOOLS_BUDGET_MS,
} from "./transports.js";

/**
 * Create a fresh connection cache.
 *
 * Each Chatbox mount holds one instance via `useRef`. The factory exists
 * so tests can construct an isolated cache without module-level state.
 */
export function createConnectionCache() {
  /** @type {Map<string, { conn: object, tools: Array }>} */
  const entries = new Map();

  /**
   * In-flight open promises per URL. When a second caller asks for the
   * same URL while the first is still opening, they share this promise.
   * Removed once the open settles (resolved or rejected).
   * @type {Map<string, Promise>}
   */
  const pendingOpens = new Map();

  /**
   * Resolve the cache entry for `url`, opening the transport + fetching
   * the tool list if no entry exists. Concurrent callers for the same
   * URL share a single open.
   *
   * Returns `{ conn, tools }`:
   *   - `conn`: the `{ client, transport }` from `pickTransportWithRetry`
   *   - `tools`: the array from `client.listTools()` (per the MCP spec,
   *     each element has `name`, `description`, `inputSchema`, etc.)
   *
   * Errors during open propagate; nothing is cached on failure.
   */
  async function getOrOpen(url) {
    const existing = entries.get(url);
    if (existing) return existing;

    const pending = pendingOpens.get(url);
    if (pending) return pending;

    const openPromise = openAndStore(url).finally(() => {
      pendingOpens.delete(url);
    });
    pendingOpens.set(url, openPromise);
    return openPromise;
  }

  async function openAndStore(url) {
    let conn;
    try {
      conn = await pickTransportWithRetry(url);
    } catch (err) {
      // Mark phase so connectMcpServers can preserve its existing
      // errorKey mapping (connectionFailed vs notMcpServer). pickTransport
      // already attaches `errorKey`; we just add the phase marker.
      if (err && typeof err === "object" && !err._cachePhase) {
        err._cachePhase = "transport";
      }
      throw err;
    }
    let tools;
    try {
      const response = await withTimeout(
        conn.client.listTools(),
        LIST_TOOLS_BUDGET_MS,
      );
      tools = Array.isArray(response?.tools) ? response.tools : [];
    } catch (err) {
      // The transport is open but listTools failed. Close to avoid a
      // socket leak before propagating.
      await closeMcpConnection(conn);
      if (err && typeof err === "object" && !err._cachePhase) {
        err._cachePhase = "list_tools";
      }
      throw err;
    }
    const entry = { conn, tools };
    entries.set(url, entry);
    return entry;
  }

  /**
   * Close + remove the cached entry for `url`. No-op if not cached.
   *
   * Called by `executeTool` after a transport-level error, so the next
   * operation against this URL opens a fresh transport.
   */
  async function invalidate(url) {
    const entry = entries.get(url);
    if (!entry) return;
    entries.delete(url);
    await closeMcpConnection(entry.conn);
  }

  /**
   * Close + remove every cached entry whose URL is not in `activeUrls`.
   * Entries for URLs in the active set are preserved.
   *
   * Called by Chatbox.jsx when `allMcpServers` URLs change — e.g., user
   * disables a server in the MCP panel.
   */
  async function invalidateUrlsNotIn(activeUrls) {
    const activeSet = new Set(activeUrls);
    const toClose = [];
    for (const [url, entry] of entries) {
      if (activeSet.has(url)) continue;
      toClose.push({ url, entry });
    }
    for (const { url, entry } of toClose) {
      entries.delete(url);
      await closeMcpConnection(entry.conn);
    }
  }

  /**
   * Close every cached entry and clear the map. Called by Chatbox.jsx on
   * unmount. Idempotent — safe to call on an empty cache.
   */
  async function closeAll() {
    const all = Array.from(entries.values());
    entries.clear();
    for (const entry of all) {
      await closeMcpConnection(entry.conn);
    }
  }

  return {
    getOrOpen,
    invalidate,
    invalidateUrlsNotIn,
    closeAll,
    // Non-public; tests inspect cache state via this reference. Not part
    // of the consumer contract.
    _entries: entries,
  };
}
