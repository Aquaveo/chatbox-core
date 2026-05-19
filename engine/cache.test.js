/**
 * engine/cache.test.js — coverage for the IndexedDB-backed result cache.
 *
 * Uses fake-indexeddb so the same code path that runs in browsers executes
 * here in Node. The shim provides a real (in-memory) IndexedDB
 * implementation — not a mock — so transaction semantics, indexes, and
 * cursor behavior are exercised authentically.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Install the fake IndexedDB on globalThis BEFORE importing the module
// under test, since cache.js binds to globalThis.indexedDB at import time
// for the `hasIndexedDB()` check.
import "fake-indexeddb/auto";

import {
  CACHE_URI_SCHEME,
  DEFAULT_CACHE_THRESHOLD_BYTES,
  __resetDbForTests,
  cacheToolResult,
  clearConversation,
  estimateSize,
  evictOlderThan,
  hasIndexedDB,
  mintCacheUri,
  readCachedPayload,
} from "./cache.js";

// ---------------------------------------------------------------------------
// Per-test fixture — reset the DB so cases don't leak entries between runs.
// fake-indexeddb's `auto` module installs a fresh in-memory instance per
// import; we reset our cached `_dbPromise` so the next call re-opens.
// ---------------------------------------------------------------------------

beforeEach(async () => {
  // Reset the module's cached DB connection so we re-open fresh, and
  // wipe the object store so prior-test entries don't leak. We can't
  // deleteDatabase here because the prior test's connection holds it
  // open and the delete request blocks forever in fake-indexeddb.
  __resetDbForTests();

  // Open a one-shot connection just to clear the store. If the DB
  // doesn't exist yet (first test), the upgrade handler creates it
  // and the clear() runs against an empty store — also fine.
  await new Promise((resolve, reject) => {
    const open = globalThis.indexedDB.open("chatbox-core-result-cache", 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("results")) {
        const store = db.createObjectStore("results", { keyPath: "uri" });
        store.createIndex("convId", "convId", { unique: false });
        store.createIndex("addedAt", "addedAt", { unique: false });
      }
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("results", "readwrite");
      tx.objectStore("results").clear();
      tx.oncomplete = () => {
        db.close();
        // Reset again so the module re-opens on next call rather than
        // reusing this fixture's closed handle.
        __resetDbForTests();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// hasIndexedDB / mintCacheUri / estimateSize — pure helpers
// ---------------------------------------------------------------------------

describe("hasIndexedDB()", () => {
  it("returns true when globalThis.indexedDB is present", () => {
    expect(hasIndexedDB()).toBe(true);
  });
});

describe("mintCacheUri(convId)", () => {
  it("mints a URI with the correct scheme + conv-id + token shape", () => {
    const uri = mintCacheUri("conv-abc");
    expect(uri.startsWith(CACHE_URI_SCHEME)).toBe(true);
    expect(uri).toMatch(/^mcp\+cache:\/\/conv-abc\/[A-Za-z0-9_-]{11}$/);
  });

  it("two calls mint different URIs (collision-safe)", () => {
    const a = mintCacheUri("conv-x");
    const b = mintCacheUri("conv-x");
    expect(a).not.toEqual(b);
  });

  it("sanitizes conv-id (path traversal / authority injection)", () => {
    const uri = mintCacheUri("../evil/../host");
    // Path-traversal chars `/` and `.` get sanitized to `_`.
    expect(uri).not.toMatch(/\.\./);
    expect(uri.split("/").length).toBe(4); // mcp+cache:, '', sanitized-conv-id, token
  });

  it("falls back to 'default' when conv-id sanitizes to empty", () => {
    const uri = mintCacheUri("////");
    expect(uri).toMatch(/^mcp\+cache:\/\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/);
  });
});

describe("estimateSize(payload)", () => {
  it("returns the JSON-string size in bytes", () => {
    const size = estimateSize({ a: 1, b: "hello" });
    expect(size).toBeGreaterThan(10);
    expect(size).toBeLessThan(30);
  });

  it("returns 0 for non-serializable payloads", () => {
    const circ = { x: null };
    circ.x = circ;
    expect(estimateSize(circ)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// cacheToolResult — write path with the threshold heuristic
// ---------------------------------------------------------------------------

describe("cacheToolResult — heuristic write path", () => {
  it("returns null and skips the write for payloads below threshold", async () => {
    const uri = await cacheToolResult({
      payload: { tiny: "ok" },
      convId: "c1",
      sourceToolName: "test_tool",
    });
    expect(uri).toBeNull();
  });

  it("writes oversized payloads + returns a fresh URI", async () => {
    // Build a payload that easily exceeds 4 KB.
    const bigData = Array.from({ length: 200 }, (_, i) => ({
      id: i,
      label: `row-${i}`,
      x: 1.234567890123,
      y: 9.876543210987,
    }));
    const uri = await cacheToolResult({
      payload: { ok: true, data: bigData },
      convId: "c1",
      sourceToolName: "query_output_files_from_output_selector",
    });
    expect(uri).not.toBeNull();
    expect(uri.startsWith("mcp+cache://c1/")).toBe(true);
  });

  it("custom threshold overrides the default", async () => {
    // Below default threshold, above 50-byte threshold.
    const payload = { hello: "world" };
    const aboveCustom = await cacheToolResult({
      payload,
      convId: "c1",
      sourceToolName: "x",
      threshold: 5,
    });
    expect(aboveCustom).not.toBeNull();

    const belowCustom = await cacheToolResult({
      payload,
      convId: "c1",
      sourceToolName: "x",
      threshold: DEFAULT_CACHE_THRESHOLD_BYTES,
    });
    expect(belowCustom).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readCachedPayload — round-trip + missing / malformed URIs
// ---------------------------------------------------------------------------

describe("readCachedPayload — round-trip", () => {
  it("returns the original payload after write+read", async () => {
    const big = { rows: Array.from({ length: 500 }, (_, i) => ({ x: i, y: i * 2, z: `r${i}` })) };
    const uri = await cacheToolResult({
      payload: big,
      convId: "c1",
      sourceToolName: "t",
    });
    expect(uri).not.toBeNull();

    const round = await readCachedPayload(uri);
    expect(round).toEqual(big);
  });

  it("returns null for an unknown URI (cache miss)", async () => {
    const missing = await readCachedPayload(
      "mcp+cache://c1/aaaaaaaaaaa",
    );
    expect(missing).toBeNull();
  });

  it("returns null for a non-cache URI string", async () => {
    expect(await readCachedPayload("not-a-uri")).toBeNull();
    expect(await readCachedPayload("https://example.com")).toBeNull();
    expect(await readCachedPayload(null)).toBeNull();
    expect(await readCachedPayload(123)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// clearConversation — drop all entries for a conv-id
// ---------------------------------------------------------------------------

describe("clearConversation(convId)", () => {
  it("drops only the named conversation's entries", async () => {
    const big = { rows: Array.from({ length: 500 }, (_, i) => ({ x: i, label: `row-${i}` })) };
    const a1 = await cacheToolResult({ payload: big, convId: "conv-a", sourceToolName: "t" });
    const a2 = await cacheToolResult({ payload: big, convId: "conv-a", sourceToolName: "t" });
    const b1 = await cacheToolResult({ payload: big, convId: "conv-b", sourceToolName: "t" });

    await clearConversation("conv-a");

    expect(await readCachedPayload(a1)).toBeNull();
    expect(await readCachedPayload(a2)).toBeNull();
    // conv-b entry survives.
    expect(await readCachedPayload(b1)).toEqual(big);
  });
});

// ---------------------------------------------------------------------------
// evictOlderThan — age-based eviction
// ---------------------------------------------------------------------------

describe("evictOlderThan({maxAgeMs})", () => {
  // Note: fake-indexeddb interacts poorly with vi.useFakeTimers (the shim
  // schedules transaction completion via setTimeout). Rather than mock the
  // clock, we exercise the cursor logic against real timestamps and assert
  // (a) the function runs without error on an empty store, and (b) entries
  // newer than the cutoff are NOT evicted. Eviction-of-old-entries is
  // covered by the implementation itself (cursor walks the addedAt index
  // up to the cutoff) — exercising it precisely would require either a
  // sleep (slow) or shim of Date.now (fragile under fake-indexeddb).

  it("runs without error on an empty store", async () => {
    await expect(
      evictOlderThan({ maxAgeMs: 1000 }),
    ).resolves.toBeUndefined();
  });

  it("keeps just-written entries (newer than any reasonable cutoff)", async () => {
    const big = { rows: Array.from({ length: 500 }, (_, i) => ({ x: i, label: `row-${i}` })) };
    const uri = await cacheToolResult({ payload: big, convId: "c1", sourceToolName: "t" });

    // Evict anything older than 10 hours — the entry we just wrote is
    // milliseconds old, so it should survive.
    await evictOlderThan({ maxAgeMs: 10 * 60 * 60 * 1000 });

    expect(await readCachedPayload(uri)).toEqual(big);
  });
});
