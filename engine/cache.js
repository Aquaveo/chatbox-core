/**
 * engine/cache.js — IndexedDB-backed result cache for the MCP
 * result-by-reference protocol.
 *
 * Plan: docs/plans/2026-05-18-002-feat-mcp-result-by-reference-protocol-plan.md
 * Unit 1.
 *
 * Solves: cross-server MCP tool composition bottleneck where the LLM
 * regenerates large data arrays (e.g., 240-row time-series) token-by-token
 * between tool calls. By caching oversized tool results in IndexedDB and
 * minting an `mcp+cache://` URI the LLM can pass forward, the substitution
 * layer in `processToolCalls` (Unit 3) can swap the URI for inline data
 * before dispatch — eliminating the regeneration cost.
 *
 * Storage choice rationale (per plan refinement 2026-05-18):
 *   - IndexedDB (not in-memory Map): persists across page reload, browser-
 *     managed eviction, gigabyte-scale quota. Survives the "user refreshed
 *     mid-conversation and lost everything" failure mode.
 *   - One DB per chatbox-core installation. One object store keyed by URI.
 *   - URI format: mcp+cache://<conv-id>/<8-byte-base64url>. Conv-id scopes
 *     URIs to a conversation; clearConversation() drops all entries for a
 *     given conv-id.
 *
 * Heuristic auto-cache (per plan refinement):
 *   - Caches only payloads whose JSON-serialized size exceeds the threshold
 *     (default 4 KB to match v0.6.4's MAX_TOOL_RESULT_CHARS). Smaller
 *     payloads aren't worth the cache write — the LLM can inline them
 *     cheaply.
 *
 * Browser-only:
 *   - This module uses `globalThis.indexedDB`. In Node test environments
 *     without an IndexedDB shim, the module's exported functions are
 *     no-ops (return null / resolve to undefined) so the engine's
 *     code paths can compile + run without crashing during tests.
 */

const DB_NAME = "chatbox-core-result-cache";
const DB_VERSION = 1;
const STORE_NAME = "results";

/** Default threshold below which we don't bother caching (bytes of JSON). */
export const DEFAULT_CACHE_THRESHOLD_BYTES = 4096;

/** Scheme prefix for every URI this module mints. */
export const CACHE_URI_SCHEME = "mcp+cache://";

/**
 * True when the current runtime has a usable IndexedDB. Test environments
 * (vitest default node) don't, so callers can short-circuit gracefully.
 */
export function hasIndexedDB() {
  return typeof globalThis !== "undefined" && !!globalThis.indexedDB;
}

let _dbPromise = null;

function openDb() {
  if (!hasIndexedDB()) {
    return Promise.resolve(null);
  }
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "uri" });
        // Secondary index on convId so clearConversation() can scan
        // efficiently without iterating every entry.
        store.createIndex("convId", "convId", { unique: false });
        store.createIndex("addedAt", "addedAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return _dbPromise;
}

/**
 * Mint a fresh cache URI for the given conversation.
 *
 * Format: mcp+cache://<conv-id>/<11-char-base64url>.
 * 8 bytes of randomness ≈ 64 bits — practically unguessable inside a
 * conversation that hosts at most thousands of entries.
 */
export function mintCacheUri(convId) {
  const safeConvId = sanitizeConvId(convId);
  const tokenBytes = new Uint8Array(8);
  cryptoSource().getRandomValues(tokenBytes);
  const token = bytesToBase64Url(tokenBytes);
  return `${CACHE_URI_SCHEME}${safeConvId}/${token}`;
}

/**
 * Estimate the byte-size of a JSON-serializable payload. Used by the
 * auto-cache heuristic — payloads under threshold don't earn a cache entry.
 */
export function estimateSize(payload) {
  try {
    return new Blob([JSON.stringify(payload)]).size;
  } catch {
    // Non-serializable payloads (circular refs, etc.) bypass the cache.
    return 0;
  }
}

/**
 * Cache a tool result payload if its serialized size exceeds the threshold.
 *
 * Returns the minted cache URI on success, or `null` when:
 *   - the payload was below the threshold (don't bother caching);
 *   - IndexedDB is unavailable in this runtime (Node test env without shim);
 *   - the write failed (logged, swallowed — the engine continues without
 *     the cache benefit).
 *
 * Caller is responsible for surfacing the returned URI to the LLM (Unit 2
 * does this at the tool-result write site).
 */
export async function cacheToolResult({
  payload,
  convId,
  sourceToolName,
  threshold = DEFAULT_CACHE_THRESHOLD_BYTES,
}) {
  if (!hasIndexedDB()) return null;
  const size = estimateSize(payload);
  if (size < threshold) return null;

  const uri = mintCacheUri(convId);
  const entry = {
    uri,
    payload,
    convId: sanitizeConvId(convId),
    sourceToolName: sourceToolName || "<unknown>",
    addedAt: Date.now(),
    sizeBytes: size,
  };

  try {
    const db = await openDb();
    if (!db) return null;
    await runTx(db, "readwrite", (store) => store.put(entry));
    return uri;
  } catch (err) {
    console.warn("[chatbox-core cache] write failed:", err);
    return null;
  }
}

/**
 * Read a cached payload by URI. Returns the payload value, or `null` if
 * the URI is missing / IndexedDB is unavailable / the read fails.
 *
 * Used by Unit 3's substitution layer.
 */
export async function readCachedPayload(uri) {
  if (!hasIndexedDB()) return null;
  if (typeof uri !== "string" || !uri.startsWith(CACHE_URI_SCHEME)) return null;

  try {
    const db = await openDb();
    if (!db) return null;
    const entry = await runTx(db, "readonly", (store) => store.get(uri));
    return entry?.payload ?? null;
  } catch (err) {
    console.warn("[chatbox-core cache] read failed:", err);
    return null;
  }
}

/**
 * Drop all cache entries belonging to a conversation. Called by the host
 * on dashboard switch / chat reset to free browser quota.
 */
export async function clearConversation(convId) {
  if (!hasIndexedDB()) return;
  const safeConvId = sanitizeConvId(convId);
  try {
    const db = await openDb();
    if (!db) return;
    await runTx(db, "readwrite", (store) => {
      return new Promise((resolve, reject) => {
        const index = store.index("convId");
        const request = index.openCursor(IDBKeyRange.only(safeConvId));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve();
            return;
          }
          cursor.delete();
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
    });
  } catch (err) {
    console.warn("[chatbox-core cache] clearConversation failed:", err);
  }
}

/**
 * Best-effort eviction: drop entries older than `maxAgeMs` until the
 * total cache size is under `maxBytes`. Host-callable for quota management;
 * the engine doesn't call this automatically (browser-managed eviction
 * handles the hard quota).
 */
export async function evictOlderThan({ maxAgeMs }) {
  if (!hasIndexedDB()) return;
  const cutoff = Date.now() - maxAgeMs;
  try {
    const db = await openDb();
    if (!db) return;
    await runTx(db, "readwrite", (store) => {
      return new Promise((resolve, reject) => {
        const index = store.index("addedAt");
        const request = index.openCursor(IDBKeyRange.upperBound(cutoff));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve();
            return;
          }
          cursor.delete();
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
    });
  } catch (err) {
    console.warn("[chatbox-core cache] evictOlderThan failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function runTx(db, mode, work) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);

    // IndexedDB auto-commits a transaction as soon as no more requests are
    // pending. `tx.oncomplete` / `tx.onerror` / `tx.onabort` MUST be
    // attached synchronously, before `work(store)` schedules any
    // requests — otherwise the events can fire and dispatch with no
    // handlers attached, and the outer Promise hangs forever. Observed in
    // real Chrome 2026-05-19 against the cursor-walk path in
    // clearConversation (fake-indexeddb's looser timing masked the race
    // in unit tests).
    let workResult;
    tx.oncomplete = () => resolve(workResult);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("IDB transaction aborted"));

    const result = work(store);

    // Result may be:
    //   - a Promise (cursor walks resolve when cursor === null)
    //   - an IDBRequest (e.g., store.get / store.put — has `.onsuccess`)
    //   - a scalar (rare; the work fn did all its bookkeeping internally)
    // In all three cases we attach handlers that capture work's value
    // into `workResult`, so the tx.oncomplete handler above resolves
    // with it when the transaction commits.
    if (result && typeof result.then === "function") {
      result.then(
        (value) => {
          workResult = value;
        },
        (err) => {
          // Inner Promise rejected → abort the transaction so its
          // oncomplete doesn't masquerade as success. The tx.onabort
          // handler above will surface the original error via reject.
          try {
            tx.abort();
          } catch (_e) {
            /* tx may already be finishing — ignore */
          }
          reject(err);
        },
      );
    } else if (result && typeof result.onsuccess !== "undefined") {
      result.onsuccess = () => {
        workResult = result.result;
      };
      result.onerror = () => reject(result.error);
    } else {
      workResult = result;
    }
  });
}

function bytesToBase64Url(bytes) {
  // Browser-safe base64url (no padding, URL-safe alphabet).
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 = (globalThis.btoa || nodeBtoa)(binary);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function nodeBtoa(str) {
  // Test-env fallback when running under Node without `btoa` (older Node
  // versions). globalThis.btoa exists in Node 16+ and all browsers.
  return Buffer.from(str, "binary").toString("base64");
}

function cryptoSource() {
  if (globalThis.crypto?.getRandomValues) return globalThis.crypto;
  // Node test-env fallback — same surface as web crypto.
  return {
    getRandomValues(arr) {
      for (let i = 0; i < arr.length; i++) {
        arr[i] = Math.floor(Math.random() * 256);
      }
      return arr;
    },
  };
}

/**
 * Replace path-traversal / authority-injection characters with `_`. The
 * conv-id ends up inside a URI we mint and pass through messages[]; this
 * keeps it shaped like an identifier no matter what the host passes in.
 */
function sanitizeConvId(convId) {
  const raw = String(convId ?? "default");
  return raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "default";
}

/**
 * Test-only: reset the cached DB connection so tests can re-open with a
 * fresh fake-indexeddb instance between cases.
 *
 * NOT exported from the engine's public surface — only consumed by the
 * cache.test.js fixture.
 */
export function __resetDbForTests() {
  _dbPromise = null;
}
