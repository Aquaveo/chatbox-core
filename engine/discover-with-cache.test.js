/**
 * engine/discover-with-cache.test.js — integration coverage for plan
 * 2026-05-19-002 Unit 3: discoverPrompts memoization + getPrompt cache.
 *
 * Drives the real engine functions against a real cache instance with
 * mocked transport helpers. Verifies memo hits skip transport opens
 * entirely, and getPrompt reuses cached connections.
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

import {
  pickTransportWithRetry,
  closeMcpConnection,
} from "./transports.js";
import { createConnectionCache } from "./connection-cache.js";
import { discoverPrompts, getPrompt } from "./index.js";

function makeConn({ tools = [], prompts = [], promptText = "rendered text" } = {}) {
  return {
    client: {
      listTools: vi.fn(() => Promise.resolve({ tools })),
      listPrompts: vi.fn(() => Promise.resolve({ prompts })),
      getPrompt: vi.fn(() =>
        Promise.resolve({
          messages: [{ content: { type: "text", text: promptText } }],
        }),
      ),
    },
    transport: { close: vi.fn(() => Promise.resolve()) },
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

describe("discoverPrompts with cache — shared transport + memoization", () => {
  it("uses the cached transport on first call; transport stays open after", async () => {
    const conn = makeConn({
      tools: [{ name: "tool_a" }],
      prompts: [{ name: "prompt_a" }],
    });
    pickTransportWithRetry.mockResolvedValueOnce(conn);

    const cache = createConnectionCache();
    const memo = {};
    const result = await discoverPrompts(
      [{ url: "https://a", name: "A" }],
      { cache, memo },
    );

    expect(pickTransportWithRetry).toHaveBeenCalledTimes(1);
    expect(conn.client.listPrompts).toHaveBeenCalledTimes(1);
    // Cache-owned transport is NOT closed by discoverPrompts.
    expect(closeMcpConnection).not.toHaveBeenCalled();
    expect(result.promptsByServer["0"]).toEqual([{ name: "prompt_a" }]);
  });

  it("returns memoized result on second call with same URL set (no transport touch)", async () => {
    const conn = makeConn({ prompts: [{ name: "prompt_a" }] });
    pickTransportWithRetry.mockResolvedValueOnce(conn);

    const cache = createConnectionCache();
    const memo = {};
    const first = await discoverPrompts(
      [{ url: "https://a", name: "A" }],
      { cache, memo },
    );
    const second = await discoverPrompts(
      [{ url: "https://a", name: "A" }],
      { cache, memo },
    );

    expect(second).toBe(first);
    // listPrompts only called for the first invocation.
    expect(conn.client.listPrompts).toHaveBeenCalledTimes(1);
  });

  it("URL-order independence — memo key is sorted", async () => {
    const cA = makeConn({ prompts: [{ name: "pa" }] });
    const cB = makeConn({ prompts: [{ name: "pb" }] });
    pickTransportWithRetry
      .mockResolvedValueOnce(cA)
      .mockResolvedValueOnce(cB);

    const cache = createConnectionCache();
    const memo = {};
    const first = await discoverPrompts(
      [
        { url: "https://a", name: "A" },
        { url: "https://b", name: "B" },
      ],
      { cache, memo },
    );
    const second = await discoverPrompts(
      [
        { url: "https://b", name: "B" },
        { url: "https://a", name: "A" },
      ],
      { cache, memo },
    );

    expect(second).toBe(first);
    expect(cA.client.listPrompts).toHaveBeenCalledTimes(1);
    expect(cB.client.listPrompts).toHaveBeenCalledTimes(1);
  });

  it("memo miss when URL set differs; reuses cached transports for surviving URLs", async () => {
    const cA = makeConn({ prompts: [{ name: "pa" }] });
    const cB = makeConn({ prompts: [{ name: "pb" }] });
    pickTransportWithRetry
      .mockResolvedValueOnce(cA)
      .mockResolvedValueOnce(cB);

    const cache = createConnectionCache();
    const memo = {};
    await discoverPrompts([{ url: "https://a", name: "A" }], { cache, memo });
    await discoverPrompts(
      [
        { url: "https://a", name: "A" },
        { url: "https://b", name: "B" },
      ],
      { cache, memo },
    );

    // Total opens: 2 (one per unique URL). "a" was reused via the cache;
    // only "b" required a new open.
    expect(pickTransportWithRetry).toHaveBeenCalledTimes(2);
    expect(cA.client.listPrompts).toHaveBeenCalledTimes(2);
    expect(cB.client.listPrompts).toHaveBeenCalledTimes(1);
  });

  it("backward compat: no cache + no memo → today's transient open/close behavior", async () => {
    const conn = makeConn({ prompts: [{ name: "p" }] });
    pickTransportWithRetry.mockResolvedValueOnce(conn);

    const result = await discoverPrompts([{ url: "https://a", name: "A" }]);

    expect(pickTransportWithRetry).toHaveBeenCalledTimes(1);
    // No cache → transport IS closed after the call.
    expect(closeMcpConnection).toHaveBeenCalledWith(conn);
    expect(result.promptsByServer["0"]).toEqual([{ name: "p" }]);
  });
});

describe("getPrompt with cache — shared transport", () => {
  it("uses the cached transport instead of opening a fresh one", async () => {
    const conn = makeConn({ promptText: "rendered" });
    pickTransportWithRetry.mockResolvedValueOnce(conn);

    const cache = createConnectionCache();
    const servers = [{ url: "https://a", name: "A" }];
    // Warm the cache via discoverPrompts.
    await discoverPrompts(servers, { cache, memo: {} });
    expect(pickTransportWithRetry).toHaveBeenCalledTimes(1);

    const text = await getPrompt(0, "prompt_name", {}, servers, { cache });

    // No new open — cached transport reused.
    expect(pickTransportWithRetry).toHaveBeenCalledTimes(1);
    expect(conn.client.getPrompt).toHaveBeenCalledTimes(1);
    expect(text).toBe("rendered");
    // Cache-owned conn NOT closed.
    expect(closeMcpConnection).not.toHaveBeenCalled();
  });

  it("invalidates the cache entry when getPrompt's underlying call throws", async () => {
    const conn = makeConn();
    conn.client.getPrompt = vi.fn(() =>
      Promise.reject(new Error("transport closed")),
    );
    pickTransportWithRetry.mockResolvedValueOnce(conn);

    const cache = createConnectionCache();
    const servers = [{ url: "https://a", name: "A" }];
    // Manually seed the cache (skipping discoverPrompts to keep the
    // sequence terse — what matters is that an entry exists before
    // getPrompt fires).
    await cache.getOrOpen("https://a");

    await expect(
      getPrompt(0, "prompt_name", {}, servers, { cache }),
    ).rejects.toThrow("transport closed");

    // Wait a microtask for the fire-and-forget invalidate().catch chain.
    await Promise.resolve();
    await Promise.resolve();

    // Cache should no longer hold an entry for that URL.
    expect(cache._entries.has("https://a")).toBe(false);
    expect(closeMcpConnection).toHaveBeenCalledWith(conn);
  });

  it("backward compat: no cache → opens + closes a fresh transport per call", async () => {
    const conn = makeConn({ promptText: "rendered" });
    pickTransportWithRetry.mockResolvedValueOnce(conn);

    const text = await getPrompt(
      0,
      "prompt_name",
      {},
      [{ url: "https://a", name: "A" }],
    );

    expect(text).toBe("rendered");
    expect(closeMcpConnection).toHaveBeenCalledWith(conn);
  });
});

describe("Unit 3 integration — discover + getPrompt + connectMcpServers share one transport", () => {
  it("one pickTransportWithRetry call per server across the full mount sequence", async () => {
    const conn = makeConn({
      tools: [{ name: "tool_a" }],
      prompts: [{ name: "prompt_a" }],
      promptText: "rendered",
    });
    pickTransportWithRetry.mockResolvedValueOnce(conn);

    // Re-import connectMcpServers + the live cache.
    const { connectMcpServers } = await import("./index.js");

    const cache = createConnectionCache();
    const memo = {};
    const servers = [{ url: "https://a", name: "A" }];

    // Sequence: discoverPrompts (mount) → connectMcpServers (first turn)
    // → getPrompt (slash selection) → connectMcpServers (second turn).
    await discoverPrompts(servers, { cache, memo });
    await connectMcpServers(servers, { cache });
    await getPrompt(0, "prompt_name", {}, servers, { cache });
    await connectMcpServers(servers, { cache });

    // Four operations against the server, ONE transport open total.
    expect(pickTransportWithRetry).toHaveBeenCalledTimes(1);
    expect(conn.client.listTools).toHaveBeenCalledTimes(1);
    expect(conn.client.listPrompts).toHaveBeenCalledTimes(1);
    expect(conn.client.getPrompt).toHaveBeenCalledTimes(1);
    // No closes — cache owns the transport.
    expect(closeMcpConnection).not.toHaveBeenCalled();
  });
});
