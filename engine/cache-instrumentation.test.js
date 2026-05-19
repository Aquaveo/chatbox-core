/**
 * engine/cache-instrumentation.test.js — coverage for Unit 2 of the MCP
 * result-by-reference protocol (plan 2026-05-18-002).
 *
 * Verifies that when `cacheOptions.enabled === true` is threaded into
 * `processToolCalls`, oversized tool results are written to IndexedDB
 * and the LLM-visible envelope gains a `_cache_uri` field. Smaller
 * results are passed through unchanged. The cache write is gated on
 * the opt-in flag — disabled by default so existing consumers see no
 * behavior change.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Install fake IndexedDB BEFORE importing the engine so cache.js binds
// to a usable globalThis.indexedDB at module load.
import "fake-indexeddb/auto";

import { processToolCalls } from "./index.js";
import { __resetDbForTests } from "./cache.js";
import { makeFakeClient } from "../test-helpers/fakeConn.js";
import { MAX_TOOL_RESULT_CHARS } from "../config/index.js";

// ---------------------------------------------------------------------------
// Helpers (mirror engine-dispatched.test.js shape)
// ---------------------------------------------------------------------------

function makeFreshState() {
  return {
    lastChartResult: null,
    lastQueryResult: null,
    lastQuerySQL: null,
    lastListResult: null,
    lastMapResult: null,
    lastHydrofabricResult: null,
    pendingVisualizations: [],
    pendingLayerUpdates: [],
    pendingPatches: [],
    rejectedPatches: [],
    toolCallsThisTurn: [],
  };
}

function makeToolCall(name, args = {}, id = `call-${name}`) {
  return { id, function: { name, arguments: args } };
}

function makeConnections(toolResultsByName) {
  const callTool = vi.fn(async ({ name }) => {
    const result = toolResultsByName[name];
    if (result === undefined) {
      throw new Error(`Test fixture missing result for tool: ${name}`);
    }
    return { data: result };
  });
  const client = makeFakeClient({ callToolImpl: callTool });
  const connections = [{ client, transport: null, protocolUsed: "http" }];
  const toolServerMap = new Map(
    Object.keys(toolResultsByName).map((name) => [name, 0]),
  );
  return { connections, toolServerMap };
}

/** Pull the tool-result message the engine pushed for the call. */
function getToolMessage(messages, toolName) {
  return messages.find((m) => m.role === "tool" && m.tool_name === toolName);
}

beforeEach(async () => {
  // Per-test DB clear (same pattern as cache.test.js).
  __resetDbForTests();
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
        __resetDbForTests();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
});

// ---------------------------------------------------------------------------
// Behavior
// ---------------------------------------------------------------------------

describe("processToolCalls — Unit 2 cache instrumentation", () => {
  it("default-off: no `_cache_uri` injected when cacheOptions is absent", async () => {
    const big = { rows: Array.from({ length: 500 }, (_, i) => ({ x: i, label: `r${i}` })) };
    const { connections, toolServerMap } = makeConnections({ big_tool: big });
    const messages = [];
    const state = makeFreshState();

    await processToolCalls(
      [makeToolCall("big_tool")],
      messages,
      connections,
      toolServerMap,
      state,
      "",
      {},
    );

    const toolMsg = getToolMessage(messages, "big_tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg.content).not.toMatch(/_cache_uri/);
  });

  it("enabled + oversized payload: `_cache_uri` injected into LLM-visible envelope", async () => {
    const big = { rows: Array.from({ length: 500 }, (_, i) => ({ x: i, label: `r${i}` })) };
    const { connections, toolServerMap } = makeConnections({ big_tool: big });
    const messages = [];
    const state = makeFreshState();

    await processToolCalls(
      [makeToolCall("big_tool")],
      messages,
      connections,
      toolServerMap,
      state,
      "",
      {
        cacheOptions: { enabled: true, conversationId: "test-conv-1" },
      },
    );

    const toolMsg = getToolMessage(messages, "big_tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg.content).toMatch(/_cache_uri/);
    const parsed = JSON.parse(toolMsg.content);
    expect(parsed._cache_uri).toMatch(/^mcp\+cache:\/\/test-conv-1\/[A-Za-z0-9_-]+$/);
  });

  it("enabled + small payload: no `_cache_uri` (threshold heuristic skips)", async () => {
    const small = { ok: true, value: 42 };
    const { connections, toolServerMap } = makeConnections({ small_tool: small });
    const messages = [];
    const state = makeFreshState();

    await processToolCalls(
      [makeToolCall("small_tool")],
      messages,
      connections,
      toolServerMap,
      state,
      "",
      {
        cacheOptions: { enabled: true, conversationId: "test-conv-2" },
      },
    );

    const toolMsg = getToolMessage(messages, "small_tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg.content).not.toMatch(/_cache_uri/);
  });

  it("enabled + truncated oversized result: `_cache_uri` preserved in truncation summary", async () => {
    // Build a payload that exceeds MAX_TOOL_RESULT_CHARS (20000) so the
    // truncation pass fires. The cache write happens BEFORE truncation,
    // so the LLM sees the truncation summary + `_cache_uri` — which is
    // exactly the case where the URI is most valuable (data dropped).
    const huge = {
      ok: true,
      rows: 5000,
      columns: ["time", "flow"],
      data: Array.from({ length: 5000 }, (_, i) => ({
        time: `2026-05-18T${String(i % 24).padStart(2, "0")}:00:00.000000Z`,
        flow: Math.random() * 100,
      })),
    };
    const { connections, toolServerMap } = makeConnections({ huge_tool: huge });
    const messages = [];
    const state = makeFreshState();

    await processToolCalls(
      [makeToolCall("huge_tool")],
      messages,
      connections,
      toolServerMap,
      state,
      "",
      {
        cacheOptions: { enabled: true, conversationId: "huge-conv" },
      },
    );

    const toolMsg = getToolMessage(messages, "huge_tool");
    expect(toolMsg).toBeDefined();
    const parsed = JSON.parse(toolMsg.content);

    // Truncation fired — confirm the summary shape...
    expect(parsed._truncated).toBe(true);
    expect(parsed.rows).toBe(5000);
    expect(parsed.columns).toEqual(["time", "flow"]);
    // ...AND the cache URI survived into the summary.
    expect(parsed._cache_uri).toMatch(/^mcp\+cache:\/\/huge-conv\/[A-Za-z0-9_-]+$/);
    // Bulk payload dropped — `data` is not in the summary.
    expect(parsed.data).toBeUndefined();
  });

  it("disabled: oversized result truncates with metadata, no `_cache_uri`", async () => {
    const huge = {
      ok: true,
      rows: 5000,
      columns: ["time", "flow"],
      data: Array.from({ length: 5000 }, (_, i) => ({
        time: `t${i}`,
        flow: Math.random() * 100,
      })),
    };
    const { connections, toolServerMap } = makeConnections({ huge_tool: huge });
    const messages = [];
    const state = makeFreshState();

    await processToolCalls(
      [makeToolCall("huge_tool")],
      messages,
      connections,
      toolServerMap,
      state,
      "",
      {
        // No cacheOptions passed — default-off.
      },
    );

    const toolMsg = getToolMessage(messages, "huge_tool");
    const parsed = JSON.parse(toolMsg.content);
    expect(parsed._truncated).toBe(true);
    expect(parsed._cache_uri).toBeUndefined();
  });
});
