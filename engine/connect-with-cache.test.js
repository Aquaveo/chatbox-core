/**
 * engine/connect-with-cache.test.js — integration coverage for plan
 * 2026-05-19-002 Unit 2: connectMcpServers + executeTool wired to the
 * connection cache.
 *
 * Drives the real engine functions against a real cache instance with
 * mocked transport helpers. Verifies multi-turn cache reuse, transport-
 * error retry, and backward compatibility for callers without a cache.
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
import { connectMcpServers, executeTool } from "./index.js";

function makeConn({ tools = [], onCallTool } = {}) {
  return {
    client: {
      listTools: vi.fn(() => Promise.resolve({ tools })),
      callTool: vi.fn(
        onCallTool ||
          (() => Promise.resolve({ content: [{ text: '{"ok":true}' }] })),
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

describe("connectMcpServers with cache — reuse + miss paths", () => {
  it("opens via the cache on first call and caches the entry", async () => {
    const conn = makeConn({ tools: [{ name: "tool_a" }] });
    pickTransportWithRetry.mockResolvedValueOnce(conn);

    const cache = createConnectionCache();
    const result = await connectMcpServers(
      [{ url: "https://a", name: "A" }],
      { cache },
    );

    expect(pickTransportWithRetry).toHaveBeenCalledTimes(1);
    expect(conn.client.listTools).toHaveBeenCalledTimes(1);
    expect(result.connections).toEqual([conn]);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].function.name).toBe("tool_a");
    expect(result.perServer[0].state).toBe("connected");
  });

  it("reuses the cached entry on a second connectMcpServers call (no new open, no new listTools)", async () => {
    const conn = makeConn({ tools: [{ name: "tool_a" }] });
    pickTransportWithRetry.mockResolvedValueOnce(conn);

    const cache = createConnectionCache();
    await connectMcpServers([{ url: "https://a", name: "A" }], { cache });
    await connectMcpServers([{ url: "https://a", name: "A" }], { cache });

    expect(pickTransportWithRetry).toHaveBeenCalledTimes(1);
    expect(conn.client.listTools).toHaveBeenCalledTimes(1);
  });

  it("integration: 3 connectMcpServers calls against 2 servers → 1 open per server total", async () => {
    const cA = makeConn({ tools: [{ name: "ta" }] });
    const cB = makeConn({ tools: [{ name: "tb" }] });
    pickTransportWithRetry
      .mockResolvedValueOnce(cA)
      .mockResolvedValueOnce(cB);

    const cache = createConnectionCache();
    const servers = [
      { url: "https://a", name: "A" },
      { url: "https://b", name: "B" },
    ];
    await connectMcpServers(servers, { cache });
    await connectMcpServers(servers, { cache });
    await connectMcpServers(servers, { cache });

    expect(pickTransportWithRetry).toHaveBeenCalledTimes(2);
    expect(cA.client.listTools).toHaveBeenCalledTimes(1);
    expect(cB.client.listTools).toHaveBeenCalledTimes(1);
  });

  it("preserves notMcpServer errorKey when listTools fails on cache path", async () => {
    const conn = makeConn();
    conn.client.listTools = vi.fn(() =>
      Promise.reject(new Error("not an MCP server")),
    );
    pickTransportWithRetry.mockResolvedValueOnce(conn);

    const cache = createConnectionCache();
    const result = await connectMcpServers(
      [{ url: "https://a", name: "A" }],
      { cache },
    );

    expect(result.perServer[0].state).toBe("failed");
    expect(result.perServer[0].errorKey).toBe("not-mcp-server");
  });

  it("preserves connectionFailed errorKey when pickTransport fails on cache path", async () => {
    const err = new Error("connect failed");
    err.errorKey = "connection-failed";
    pickTransportWithRetry.mockRejectedValueOnce(err);

    const cache = createConnectionCache();
    const result = await connectMcpServers(
      [{ url: "https://a", name: "A" }],
      { cache },
    );

    expect(result.perServer[0].state).toBe("failed");
    expect(result.perServer[0].errorKey).toBe("connection-failed");
  });

  it("backward compat: no cache passed → transient open/listTools behavior preserved", async () => {
    const conn = makeConn({ tools: [{ name: "tool_a" }] });
    pickTransportWithRetry.mockResolvedValueOnce(conn);

    const result = await connectMcpServers([{ url: "https://a", name: "A" }]);

    // Single open happens and tools are populated, exactly as today.
    expect(pickTransportWithRetry).toHaveBeenCalledTimes(1);
    expect(result.connections).toEqual([conn]);
    expect(result.perServer[0].state).toBe("connected");
  });
});

describe("executeTool with cache — retry on transport error", () => {
  it("happy path: cached client.callTool succeeds → result returned, no retry", async () => {
    const conn = makeConn({ tools: [{ name: "tool_a" }] });
    pickTransportWithRetry.mockResolvedValueOnce(conn);
    const cache = createConnectionCache();
    const servers = [{ url: "https://a", name: "A" }];

    const { connections, toolServerMap } = await connectMcpServers(servers, {
      cache,
    });
    const result = await executeTool("tool_a", {}, connections, toolServerMap, {
      cache,
      servers,
    });

    expect(conn.client.callTool).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true });
  });

  it("transport error → invalidate, reopen, retry once, succeeds", async () => {
    const callError = new Error("transport closed");
    const failingConn = makeConn({
      tools: [{ name: "tool_a" }],
      onCallTool: vi.fn(() => Promise.reject(callError)),
    });
    const freshConn = makeConn({
      tools: [{ name: "tool_a" }],
      onCallTool: vi.fn(() =>
        Promise.resolve({ content: [{ text: '{"retried":true}' }] }),
      ),
    });
    pickTransportWithRetry
      .mockResolvedValueOnce(failingConn)
      .mockResolvedValueOnce(freshConn);

    const cache = createConnectionCache();
    const servers = [{ url: "https://a", name: "A" }];
    const { connections, toolServerMap } = await connectMcpServers(servers, {
      cache,
    });
    const result = await executeTool("tool_a", {}, connections, toolServerMap, {
      cache,
      servers,
    });

    // Failing conn closed via invalidate; fresh conn opened + retry call.
    expect(closeMcpConnection).toHaveBeenCalledWith(failingConn);
    expect(pickTransportWithRetry).toHaveBeenCalledTimes(2);
    expect(failingConn.client.callTool).toHaveBeenCalledTimes(1);
    expect(freshConn.client.callTool).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ retried: true });

    // connections array updated with the fresh conn so subsequent calls
    // this turn use the new transport.
    expect(connections[0]).toBe(freshConn);
  });

  it("transport error → retry also throws → return retry's error envelope", async () => {
    const firstErr = new Error("first transport closed");
    const retryErr = new Error("retry also closed");
    const c1 = makeConn({
      tools: [{ name: "tool_a" }],
      onCallTool: vi.fn(() => Promise.reject(firstErr)),
    });
    const c2 = makeConn({
      tools: [{ name: "tool_a" }],
      onCallTool: vi.fn(() => Promise.reject(retryErr)),
    });
    pickTransportWithRetry.mockResolvedValueOnce(c1).mockResolvedValueOnce(c2);

    const cache = createConnectionCache();
    const servers = [{ url: "https://a", name: "A" }];
    const { connections, toolServerMap } = await connectMcpServers(servers, {
      cache,
    });
    const result = await executeTool("tool_a", {}, connections, toolServerMap, {
      cache,
      servers,
    });

    expect(result).toEqual({ error: "retry also closed" });
  });

  it("tool-body error envelope (not a throw) → no retry, no invalidation", async () => {
    const conn = makeConn({
      tools: [{ name: "tool_a" }],
      onCallTool: vi.fn(() =>
        Promise.resolve({
          content: [{ text: '{"error":"validation failed"}' }],
        }),
      ),
    });
    pickTransportWithRetry.mockResolvedValueOnce(conn);

    const cache = createConnectionCache();
    const servers = [{ url: "https://a", name: "A" }];
    const { connections, toolServerMap } = await connectMcpServers(servers, {
      cache,
    });
    const result = await executeTool("tool_a", {}, connections, toolServerMap, {
      cache,
      servers,
    });

    expect(conn.client.callTool).toHaveBeenCalledTimes(1);
    // No retry — only one open occurred (the original connect).
    expect(pickTransportWithRetry).toHaveBeenCalledTimes(1);
    // Tool-body error envelope passed through.
    expect(result).toEqual({ error: "validation failed" });
  });

  it("backward compat: no cache + no servers → transport error returns error envelope (today's behavior)", async () => {
    const callError = new Error("transport closed");
    const conn = makeConn({
      tools: [{ name: "tool_a" }],
      onCallTool: vi.fn(() => Promise.reject(callError)),
    });
    pickTransportWithRetry.mockResolvedValueOnce(conn);

    const { connections, toolServerMap } = await connectMcpServers([
      { url: "https://a", name: "A" },
    ]);
    const result = await executeTool("tool_a", {}, connections, toolServerMap);

    expect(result).toEqual({ error: "transport closed" });
    // Single open + single failing call — no retry.
    expect(pickTransportWithRetry).toHaveBeenCalledTimes(1);
    expect(conn.client.callTool).toHaveBeenCalledTimes(1);
  });
});
