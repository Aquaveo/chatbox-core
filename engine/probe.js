/**
 * probe.js — One-shot MCP health probe + scheduler.
 *
 * `probeMcpServer` runs a single connect → listTools cycle and returns a
 * {state, errorKey?} result. It mirrors the phase-tracking pattern from
 * `connectMcpServers` in ./index.js so list_tools RPC failures map to
 * `notMcpServer` while transport-layer failures keep the errorKey tagged
 * by pickTransport.
 *
 * `createProbeScheduler` owns the 4-slot concurrency cap, per-URL
 * generation counter, yellow-min-display delay, and cancellation. The
 * scheduler is transport-agnostic: it drives probe lifecycles but never
 * touches the status Map directly — callers pass an `onUpdate(url, result)`
 * callback that writes status in whatever shape the UI expects.
 *
 * URL pre-checks (scheme allowlist + mixed-content) live in `transports.js`
 * `pickTransport` so probe and send-time paths share one errorKey taxonomy.
 */

import { ERROR_KEYS } from "./mcpErrors.js";
import {
  pickTransportWithRetry,
  closeMcpConnection,
  withTimeout,
  LIST_TOOLS_BUDGET_MS,
} from "./transports.js";

const YELLOW_MIN_DISPLAY_MS = 400;
const DEFAULT_CONCURRENCY = 4;

/**
 * Map a caught error to a user-facing ERROR_KEYS value. list_tools RPC
 * failures → notMcpServer; timeouts → timeout; everything else falls back
 * to any errorKey tagged by pickTransport, or connectionFailed.
 */
function mapProbeError(err, phase) {
  if (phase === "list_tools") return ERROR_KEYS.notMcpServer;
  if (err?.isTimeout) return ERROR_KEYS.timeout;
  return err?.errorKey ?? ERROR_KEYS.connectionFailed;
}

/**
 * Probe a single MCP server URL. Returns a plain result object — never
 * throws. Pre-checks (scheme + mixed-content) are handled inside
 * `pickTransport` and surface as thrown errors with `errorKey` already set.
 */
export async function probeMcpServer(url) {
  let conn = null;
  let phase = "transport";
  try {
    conn = await pickTransportWithRetry(url);
    phase = "list_tools";
    const response = await withTimeout(conn.client.listTools(), LIST_TOOLS_BUDGET_MS);
    const tools = Array.isArray(response?.tools) ? response.tools : [];
    return tools.length === 0 ? { state: "no-tools" } : { state: "connected" };
  } catch (err) {
    return { state: "failed", errorKey: mapProbeError(err, phase) };
  } finally {
    if (conn) await closeMcpConnection(conn);
  }
}

/**
 * Create a probe scheduler with bounded concurrency, per-URL generation
 * counters, and yellow-state min-display smoothing. Returns
 * `{ schedule, cancel, cancelAll }`.
 *
 * The scheduler does not render anything — it pushes status transitions
 * through the `onUpdate(url, result)` callback. Typical shapes:
 *   - `{ state: "yellow", startedAt, gen }` on schedule
 *   - `{ state: "connected" | "no-tools" }` on success
 *   - `{ state: "failed", errorKey }` on error
 */
export function createProbeScheduler({ onUpdate, concurrency = DEFAULT_CONCURRENCY } = {}) {
  const queue = [];                 // Array<{url, gen}>
  const running = new Map();        // url -> { gen, startedAt, conn? }
  const pendingWrites = new Map();  // url -> setTimeout handle
  const generations = new Map();    // url -> number

  // Once `cancelAll()` runs, the scheduler is dead — every onUpdate call
  // site short-circuits. Monotonic (false → true, never reset) so there is
  // no race window between bump and check. Set synchronously inside
  // cancelAll() so any in-flight or pending-write callback that lands on a
  // later microtask sees `destroyed === true` before it can call onUpdate.
  // Without this, an unmounted React component receives a setState that
  // produces a "Can't perform a state update on an unmounted component"
  // warning.
  let destroyed = false;

  function bumpGen(url) {
    const next = (generations.get(url) ?? 0) + 1;
    generations.set(url, next);
    return next;
  }

  async function runProbe(url, gen) {
    const startedAt = Date.now();
    // Insert a running entry before awaiting so cancel() can see it. The
    // conn handle is attached as soon as pickTransport resolves so cancel
    // can close the socket on an in-flight abort.
    const entry = { gen, startedAt, conn: null };
    running.set(url, entry);

    let result;
    let phase = "transport";
    try {
      entry.conn = await pickTransportWithRetry(url);
      phase = "list_tools";
      const response = await withTimeout(
        entry.conn.client.listTools(),
        LIST_TOOLS_BUDGET_MS,
      );
      const tools = Array.isArray(response?.tools) ? response.tools : [];
      result = tools.length === 0 ? { state: "no-tools" } : { state: "connected" };
    } catch (err) {
      result = { state: "failed", errorKey: mapProbeError(err, phase) };
    }

    // Close the transport regardless of outcome.
    if (entry.conn) {
      await closeMcpConnection(entry.conn);
      entry.conn = null;
    }

    // Stale generation → caller cancelled or re-scheduled; discard silently.
    if (generations.get(url) !== gen) {
      running.delete(url);
      drainQueue();
      return;
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed < YELLOW_MIN_DISPLAY_MS) {
      const handle = setTimeout(() => {
        pendingWrites.delete(url);
        // Re-check gen + destroyed at write time. A cancel between schedule
        // and flush, OR a teardown after the timer was queued, must both
        // suppress the write.
        if (!destroyed && generations.get(url) === gen) onUpdate(url, result);
      }, YELLOW_MIN_DISPLAY_MS - elapsed);
      pendingWrites.set(url, handle);
    } else if (!destroyed) {
      onUpdate(url, result);
    }

    running.delete(url);
    drainQueue();
  }

  function drainQueue() {
    while (running.size < concurrency && queue.length > 0) {
      const next = queue.shift();
      // Skip stale entries — their gen was bumped by a newer schedule/cancel.
      if (generations.get(next.url) !== next.gen) continue;
      // Fire-and-forget: runProbe handles its own cleanup. Any unexpected
      // throw is caught here so one bad URL can't poison the loop.
      runProbe(next.url, next.gen).catch(() => {
        running.delete(next.url);
      });
    }
  }

  function schedule(url) {
    if (destroyed) return;
    const gen = bumpGen(url);
    // Announce the yellow state immediately so the UI can flip before the
    // probe resolves. The delayed min-display logic only gates the *final*
    // write, not this initial one.
    onUpdate(url, { state: "yellow", startedAt: Date.now(), gen });

    if (running.size < concurrency) {
      runProbe(url, gen).catch(() => { running.delete(url); });
    } else {
      queue.push({ url, gen });
    }
  }

  function cancel(url) {
    // Bump gen so any in-flight probe or queued entry recognizes itself
    // as stale. This also supersedes any pending-write timer scheduled
    // before the cancel landed.
    bumpGen(url);

    const entry = running.get(url);
    if (entry) {
      if (entry.conn) {
        // Close the transport best-effort; runProbe's finally path will
        // observe the stale gen and silently drop its result.
        closeMcpConnection(entry.conn).catch(() => { /* best effort */ });
        entry.conn = null;
      }
      running.delete(url);
    }

    const handle = pendingWrites.get(url);
    if (handle != null) {
      clearTimeout(handle);
      pendingWrites.delete(url);
    }

    // Remove matching entries from the waiting queue. A URL may legally
    // appear more than once if schedule ran multiple times while the queue
    // was full; strip them all.
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].url === url) queue.splice(i, 1);
    }

    drainQueue();
  }

  function cancelAll() {
    // Mark the scheduler dead BEFORE cancelling individual probes so any
    // late-arriving onUpdate (resolution-time write, setTimeout flush) is
    // unconditionally short-circuited. Monotonic — once true, the
    // scheduler is unusable; the React unmount effect that calls cancelAll
    // also drops the consumer's reference, so a fresh scheduler is created
    // on the next mount.
    destroyed = true;
    // Snapshot keys first — cancel() mutates the maps and the queue.
    const urls = new Set();
    for (const url of running.keys()) urls.add(url);
    for (const url of pendingWrites.keys()) urls.add(url);
    for (const { url } of queue) urls.add(url);
    for (const url of urls) cancel(url);
    generations.clear();
  }

  return { schedule, cancel, cancelAll };
}
