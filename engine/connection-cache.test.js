/**
 * engine/connection-cache.test.js — coverage for the per-Chatbox-mount MCP
 * connection cache (plan 2026-05-19-002 Unit 1).
 *
 * The module is a stateless factory; tests mock `pickTransportWithRetry`
 * and `closeMcpConnection` from `./transports.js` so cache behavior can
 * be exercised without a live MCP server. The mocked client's `listTools`
 * returns a configurable tool list per call so cache-hit vs. cache-miss
 * is observable via call counts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./transports.js", async () => {
  const actual = await vi.importActual("./transports.js");
  return {
    ...actual,
    pickTransportWithRetry: vi.fn(),
    closeMcpConnection: vi.fn(() => Promise.resolve()),
  };
});

import { pickTransportWithRetry, closeMcpConnection } from "./transports.js";
import { createConnectionCache } from "./connection-cache.js";

// Build a minimal fake { client, transport } connection. Tests configure
// the tools list per server URL via a Map; default = empty list.
function makeFakeConnection(toolsByUrl = new Map(), urlForId) {
  const tools = toolsByUrl.get(urlForId) ?? [];
  return {
    client: {
      listTools: vi.fn(() => Promise.resolve({ tools })),
    },
    transport: {
      close: vi.fn(() => Promise.resolve()),
    },
    _urlForId: urlForId, // diagnostic-only, not part of the contract
  };
}

beforeEach(() => {
  pickTransportWithRetry.mockReset();
  closeMcpConnection.mockReset();
  closeMcpConnection.mockImplementation(async (conn) => {
    if (conn?.transport?.close) await conn.transport.close();
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("createConnectionCache — getOrOpen", () => {
  it("opens a transport on first call and stores the entry", async () => {
    const conn = makeFakeConnection(new Map([["urlA", [{ name: "t1" }]]]), "urlA");
    pickTransportWithRetry.mockResolvedValueOnce(conn);

    const cache = createConnectionCache();
    const entry = await cache.getOrOpen("urlA");

    expect(pickTransportWithRetry).toHaveBeenCalledTimes(1);
    expect(pickTransportWithRetry).toHaveBeenCalledWith("urlA");
    expect(conn.client.listTools).toHaveBeenCalledTimes(1);
    expect(entry.conn).toBe(conn);
    expect(entry.tools).toEqual([{ name: "t1" }]);
  });

  it("returns the cached entry on second call without re-opening", async () => {
    const conn = makeFakeConnection(new Map([["urlA", [{ name: "t1" }]]]), "urlA");
    pickTransportWithRetry.mockResolvedValueOnce(conn);

    const cache = createConnectionCache();
    const first = await cache.getOrOpen("urlA");
    const second = await cache.getOrOpen("urlA");

    expect(pickTransportWithRetry).toHaveBeenCalledTimes(1);
    expect(conn.client.listTools).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("deduplicates concurrent calls for the same URL (single open)", async () => {
    let resolve;
    const pending = new Promise((r) => { resolve = r; });
    pickTransportWithRetry.mockReturnValueOnce(pending);

    const cache = createConnectionCache();
    const p1 = cache.getOrOpen("urlA");
    const p2 = cache.getOrOpen("urlA");

    // pickTransportWithRetry should have been called exactly once even though
    // two callers are now waiting.
    expect(pickTransportWithRetry).toHaveBeenCalledTimes(1);

    const conn = makeFakeConnection(new Map([["urlA", []]]), "urlA");
    resolve(conn);

    const [e1, e2] = await Promise.all([p1, p2]);
    expect(e1).toBe(e2);
    expect(conn.client.listTools).toHaveBeenCalledTimes(1);
  });

  it("opens separate transports for separate URLs", async () => {
    const connA = makeFakeConnection(new Map([["urlA", [{ name: "ta" }]]]), "urlA");
    const connB = makeFakeConnection(new Map([["urlB", [{ name: "tb" }]]]), "urlB");
    pickTransportWithRetry
      .mockResolvedValueOnce(connA)
      .mockResolvedValueOnce(connB);

    const cache = createConnectionCache();
    const a = await cache.getOrOpen("urlA");
    const b = await cache.getOrOpen("urlB");

    expect(pickTransportWithRetry).toHaveBeenCalledTimes(2);
    expect(a.tools).toEqual([{ name: "ta" }]);
    expect(b.tools).toEqual([{ name: "tb" }]);
  });

  it("propagates pickTransportWithRetry errors and does not cache failures", async () => {
    const err = new Error("connect failed");
    pickTransportWithRetry.mockRejectedValueOnce(err);

    const cache = createConnectionCache();
    await expect(cache.getOrOpen("urlA")).rejects.toThrow("connect failed");

    // A subsequent call retries the open (no cached failure state).
    const conn = makeFakeConnection(new Map([["urlA", []]]), "urlA");
    pickTransportWithRetry.mockResolvedValueOnce(conn);
    const entry = await cache.getOrOpen("urlA");

    expect(pickTransportWithRetry).toHaveBeenCalledTimes(2);
    expect(entry.conn).toBe(conn);
  });

  it("closes the opened transport and does not cache when listTools throws", async () => {
    const conn = makeFakeConnection();
    conn.client.listTools = vi.fn(() =>
      Promise.reject(new Error("listTools failed")),
    );
    pickTransportWithRetry.mockResolvedValueOnce(conn);

    const cache = createConnectionCache();
    await expect(cache.getOrOpen("urlA")).rejects.toThrow("listTools failed");

    // Opened transport must be closed to avoid socket leak.
    expect(closeMcpConnection).toHaveBeenCalledWith(conn);

    // Next call retries the full open + listTools sequence.
    const conn2 = makeFakeConnection(new Map([["urlA", []]]), "urlA");
    pickTransportWithRetry.mockResolvedValueOnce(conn2);
    const entry = await cache.getOrOpen("urlA");
    expect(entry.conn).toBe(conn2);
  });
});

describe("createConnectionCache — invalidate", () => {
  it("closes the cached connection and removes the entry", async () => {
    const conn = makeFakeConnection(new Map([["urlA", []]]), "urlA");
    pickTransportWithRetry.mockResolvedValueOnce(conn);

    const cache = createConnectionCache();
    await cache.getOrOpen("urlA");

    await cache.invalidate("urlA");

    expect(closeMcpConnection).toHaveBeenCalledWith(conn);

    // Subsequent getOrOpen opens a fresh transport.
    const conn2 = makeFakeConnection(new Map([["urlA", []]]), "urlA");
    pickTransportWithRetry.mockResolvedValueOnce(conn2);
    const entry = await cache.getOrOpen("urlA");
    expect(entry.conn).toBe(conn2);
    expect(pickTransportWithRetry).toHaveBeenCalledTimes(2);
  });

  it("is a no-op when the URL is not cached", async () => {
    const cache = createConnectionCache();
    await expect(cache.invalidate("not-cached")).resolves.toBeUndefined();
    expect(closeMcpConnection).not.toHaveBeenCalled();
  });
});

describe("createConnectionCache — invalidateUrlsNotIn", () => {
  it("closes entries for URLs absent from the active set, preserves the rest", async () => {
    const cA = makeFakeConnection(new Map([["a", []]]), "a");
    const cB = makeFakeConnection(new Map([["b", []]]), "b");
    const cC = makeFakeConnection(new Map([["c", []]]), "c");
    pickTransportWithRetry
      .mockResolvedValueOnce(cA)
      .mockResolvedValueOnce(cB)
      .mockResolvedValueOnce(cC);

    const cache = createConnectionCache();
    await cache.getOrOpen("a");
    await cache.getOrOpen("b");
    await cache.getOrOpen("c");

    await cache.invalidateUrlsNotIn(["a", "c"]);

    expect(closeMcpConnection).toHaveBeenCalledTimes(1);
    expect(closeMcpConnection).toHaveBeenCalledWith(cB);

    // "a" and "c" still cached — no fresh open.
    const aEntry = await cache.getOrOpen("a");
    const cEntry = await cache.getOrOpen("c");
    expect(aEntry.conn).toBe(cA);
    expect(cEntry.conn).toBe(cC);
    expect(pickTransportWithRetry).toHaveBeenCalledTimes(3);
  });

  it("empty active set closes everything", async () => {
    const cA = makeFakeConnection(new Map([["a", []]]), "a");
    const cB = makeFakeConnection(new Map([["b", []]]), "b");
    pickTransportWithRetry
      .mockResolvedValueOnce(cA)
      .mockResolvedValueOnce(cB);

    const cache = createConnectionCache();
    await cache.getOrOpen("a");
    await cache.getOrOpen("b");

    await cache.invalidateUrlsNotIn([]);

    expect(closeMcpConnection).toHaveBeenCalledTimes(2);
  });

  it("no-op when active set matches every cached URL", async () => {
    const cA = makeFakeConnection(new Map([["a", []]]), "a");
    pickTransportWithRetry.mockResolvedValueOnce(cA);

    const cache = createConnectionCache();
    await cache.getOrOpen("a");

    await cache.invalidateUrlsNotIn(["a", "b"]); // "b" not cached anyway

    expect(closeMcpConnection).not.toHaveBeenCalled();
  });
});

describe("createConnectionCache — closeAll", () => {
  it("closes every cached connection and clears the map", async () => {
    const cA = makeFakeConnection(new Map([["a", []]]), "a");
    const cB = makeFakeConnection(new Map([["b", []]]), "b");
    pickTransportWithRetry
      .mockResolvedValueOnce(cA)
      .mockResolvedValueOnce(cB);

    const cache = createConnectionCache();
    await cache.getOrOpen("a");
    await cache.getOrOpen("b");

    await cache.closeAll();

    expect(closeMcpConnection).toHaveBeenCalledTimes(2);
    expect(closeMcpConnection).toHaveBeenCalledWith(cA);
    expect(closeMcpConnection).toHaveBeenCalledWith(cB);

    // Map cleared — a fresh getOrOpen("a") reopens.
    const cA2 = makeFakeConnection(new Map([["a", []]]), "a");
    pickTransportWithRetry.mockResolvedValueOnce(cA2);
    const entry = await cache.getOrOpen("a");
    expect(entry.conn).toBe(cA2);
  });

  it("is idempotent — closeAll on empty cache is a no-op", async () => {
    const cache = createConnectionCache();
    await expect(cache.closeAll()).resolves.toBeUndefined();
    await expect(cache.closeAll()).resolves.toBeUndefined();
    expect(closeMcpConnection).not.toHaveBeenCalled();
  });
});

describe("createConnectionCache — integration: open → invalidate → re-open", () => {
  it("supports a full lifecycle round-trip on the same URL", async () => {
    const cA1 = makeFakeConnection(new Map([["a", [{ name: "v1" }]]]), "a");
    const cA2 = makeFakeConnection(new Map([["a", [{ name: "v2" }]]]), "a");
    pickTransportWithRetry
      .mockResolvedValueOnce(cA1)
      .mockResolvedValueOnce(cA2);

    const cache = createConnectionCache();
    const first = await cache.getOrOpen("a");
    expect(first.tools).toEqual([{ name: "v1" }]);

    await cache.invalidate("a");
    expect(closeMcpConnection).toHaveBeenCalledWith(cA1);

    const second = await cache.getOrOpen("a");
    expect(second.tools).toEqual([{ name: "v2" }]);
    expect(pickTransportWithRetry).toHaveBeenCalledTimes(2);
  });
});
