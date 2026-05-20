/**
 * engine/uri-substitution.test.js — coverage for Unit 3 of the MCP
 * result-by-reference protocol (plan 2026-05-18-002).
 *
 * Two test surfaces:
 *
 * 1. `substituteCacheUris(args)` direct unit tests — happy path
 *    (scalar URI, array of URIs), conflict resolution, cache miss
 *    envelope shape, ignored-shape pass-through.
 *
 * 2. Integration through `processToolCalls` — end-to-end exercise that
 *    a tool call with `data_uri: <cached>` dispatches with `data:
 *    [...resolved...]` and that a cache miss short-circuits dispatch
 *    with the LLM-visible `invalid_args` envelope.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import "fake-indexeddb/auto";

import { processToolCalls } from "./index.js";
import {
  __resetDbForTests,
  cacheToolResult,
  CACHE_URI_SCHEME,
} from "./cache.js";
import {
  substituteCacheUris,
  checkInlineListCap,
  INLINE_LIST_MAX_RECORDS,
} from "./uri-substitution.js";
import { makeFakeClient } from "../test-helpers/fakeConn.js";

// ---------------------------------------------------------------------------
// Per-test DB reset (same fixture as cache-instrumentation.test.js)
// ---------------------------------------------------------------------------

beforeEach(async () => {
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
// substituteCacheUris — direct unit tests
// ---------------------------------------------------------------------------

describe("substituteCacheUris(args)", () => {
  // Test fixture: pre-cache a known payload and return its URI.
  async function seedCache(payload, convId = "test-conv") {
    return cacheToolResult({
      payload,
      convId,
      sourceToolName: "seed",
      threshold: 1, // force write even for tiny payloads in tests
    });
  }

  it("passes args through unchanged when no `_uri` keys are present", async () => {
    const args = { data: [{ x: 1 }], layout: { title: "t" } };
    const result = await substituteCacheUris(args);
    expect(result.ok).toBe(true);
    expect(result.args).toBe(args); // identity — no copy needed
  });

  it("resolves a scalar `data_uri` and populates `data` with the payload", async () => {
    const payload = { rows: [{ time: "t0", flow: 1.5 }] };
    const uri = await seedCache(payload);
    expect(uri).not.toBeNull();

    const result = await substituteCacheUris({
      data_uri: uri,
      layout: { title: "Flow" },
    });

    expect(result.ok).toBe(true);
    expect(result.args.data).toEqual(payload);
    expect(result.args.data_uri).toBeUndefined();
    expect(result.args.layout).toEqual({ title: "Flow" });
  });

  it("resolves an array of URIs", async () => {
    const p1 = { layer: "a" };
    const p2 = { layer: "b" };
    const u1 = await seedCache(p1);
    const u2 = await seedCache(p2);

    const result = await substituteCacheUris({
      layers_uri: [u1, u2],
      map_uuid: "abc",
    });

    expect(result.ok).toBe(true);
    expect(result.args.layers).toEqual([p1, p2]);
    expect(result.args.layers_uri).toBeUndefined();
  });

  it("conflict: both inline and _uri set → URI wins, inline dropped, console.info fires", async () => {
    const payload = { rows: [{ x: 1 }] };
    const uri = await seedCache(payload);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const result = await substituteCacheUris({
      data: [{ x: "stale-inline" }],
      data_uri: uri,
    });

    expect(result.ok).toBe(true);
    expect(result.args.data).toEqual(payload); // URI's payload won
    expect(result.args.data_uri).toBeUndefined();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("conflict: both 'data' and 'data_uri' set"),
    );
    infoSpy.mockRestore();
  });

  it("cache miss (scalar URI not in store) → invalid_args envelope", async () => {
    const result = await substituteCacheUris({
      data_uri: "mcp+cache://nope/aaaaaaaaaaa",
    });
    expect(result.ok).toBe(false);
    expect(result.envelope.error).toMatch(/cache URI .* could not be resolved/);
    expect(result.envelope._missing_uris).toEqual([
      "mcp+cache://nope/aaaaaaaaaaa",
    ]);
    expect(result.envelope.fix_hint).toMatch(/Re-call the source tool/i);
  });

  it("cache miss (array URI: one missing) → envelope names the missing URI", async () => {
    const p1 = { layer: "a" };
    const u1 = await seedCache(p1);
    const missingUri = "mcp+cache://nope/bbbbbbbbbbb";

    const result = await substituteCacheUris({
      layers_uri: [u1, missingUri],
    });

    expect(result.ok).toBe(false);
    expect(result.envelope._missing_uris).toContain(missingUri);
  });

  it("ignores `*_uri` arg with non-cache URI scheme (e.g., https://...)", async () => {
    const result = await substituteCacheUris({
      image_uri: "https://example.com/x.png",
      title: "t",
    });
    // Not a cache URI — substitution leaves it alone. Caller's downstream
    // validation will accept or reject the URL on its own.
    expect(result.ok).toBe(true);
    expect(result.args.image_uri).toBe("https://example.com/x.png");
  });

  it("handles non-object args gracefully (string / null / array)", async () => {
    expect((await substituteCacheUris(null)).ok).toBe(true);
    expect((await substituteCacheUris("hello")).ok).toBe(true);
    expect((await substituteCacheUris([1, 2, 3])).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration: processToolCalls end-to-end with URI substitution
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

describe("processToolCalls — Unit 3 substitution integration", () => {
  it("URI in tool-call args → dispatched call sees resolved inline data", async () => {
    const cachedData = [{ time: "2026-05-18T00:00:00Z", flow: 18.5 }];
    const uri = await cacheToolResult({
      payload: cachedData,
      convId: "conv-3",
      sourceToolName: "query_data",
      threshold: 1,
    });
    expect(uri).not.toBeNull();

    // Capture what the chart tool receives as args.
    const receivedArgs = { value: null };
    const callTool = vi.fn(async ({ name, arguments: args }) => {
      receivedArgs.value = args;
      return { data: { visualization: { uuid: "viz-1", source: "Inline Plotly", vizType: "plotly" } } };
    });
    const client = makeFakeClient({ callToolImpl: callTool });
    const connections = [{ client, transport: null, protocolUsed: "http" }];
    const toolServerMap = new Map([["create_chart", 0]]);
    const messages = [];

    await processToolCalls(
      [makeToolCall("create_chart", { data_uri: uri, layout: { title: "X" } })],
      messages,
      connections,
      toolServerMap,
      makeFreshState(),
      "",
      {
        cacheOptions: { enabled: true, conversationId: "conv-3" },
      },
    );

    // The chart tool received inline data, NOT the URI.
    expect(receivedArgs.value.data).toEqual(cachedData);
    expect(receivedArgs.value.data_uri).toBeUndefined();
    expect(receivedArgs.value.layout).toEqual({ title: "X" });
  });

  it("URI cache miss → tool dispatch short-circuits with invalid_args envelope", async () => {
    const callTool = vi.fn(); // should NEVER be called
    const client = makeFakeClient({ callToolImpl: callTool });
    const connections = [{ client, transport: null, protocolUsed: "http" }];
    const toolServerMap = new Map([["create_chart", 0]]);
    const messages = [];

    await processToolCalls(
      [makeToolCall("create_chart", { data_uri: "mcp+cache://nope/aaaaaaaaaaa" })],
      messages,
      connections,
      toolServerMap,
      makeFreshState(),
      "",
      {
        cacheOptions: { enabled: true, conversationId: "conv-3" },
      },
    );

    // Tool was NOT dispatched.
    expect(callTool).not.toHaveBeenCalled();

    // The LLM-visible message carries the invalid_args envelope.
    const toolMsg = messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    const parsed = JSON.parse(toolMsg.content);
    expect(parsed.error).toMatch(/cache URI .* could not be resolved/);
    expect(parsed._missing_uris).toEqual(["mcp+cache://nope/aaaaaaaaaaa"]);
    expect(parsed.fix_hint).toMatch(/Re-call the source tool/i);
  });

  it("cacheOptions.enabled=false: URI passes through unchanged to the tool", async () => {
    // When the cache is disabled at the host level, the URI substitution
    // layer also doesn't run — the LLM-emitted URI string flows through
    // verbatim. The receiving tool's own validation will reject it
    // (e.g., the Pydantic regex on data_uri). This pins the gate's
    // effect: no half-resolved state when the feature is off.
    const receivedArgs = { value: null };
    const callTool = vi.fn(async ({ arguments: args }) => {
      receivedArgs.value = args;
      return { data: { ok: true } };
    });
    const client = makeFakeClient({ callToolImpl: callTool });
    const connections = [{ client, transport: null, protocolUsed: "http" }];
    const toolServerMap = new Map([["create_chart", 0]]);
    const messages = [];

    await processToolCalls(
      [makeToolCall("create_chart", { data_uri: "mcp+cache://x/y" })],
      messages,
      connections,
      toolServerMap,
      makeFreshState(),
      "",
      {
        // cacheOptions omitted → defaults { enabled: false, ... }
      },
    );

    // Tool received the URI verbatim — no substitution.
    expect(receivedArgs.value).toEqual({ data_uri: "mcp+cache://x/y" });
  });
});

// ---------------------------------------------------------------------------
// checkInlineListCap — direct unit tests
// ---------------------------------------------------------------------------

describe("checkInlineListCap(toolName, args)", () => {
  function makeRecords(n) {
    return Array.from({ length: n }, (_, i) => ({
      time: `2026-05-18T${String(i).padStart(2, "0")}:00:00Z`,
      flow: i * 1.1,
    }));
  }

  it("returns null when no capped arg is present", () => {
    expect(checkInlineListCap("create_plotly_chart", {})).toBeNull();
    expect(
      checkInlineListCap("create_plotly_chart", { layout: { title: "x" } }),
    ).toBeNull();
  });

  it("returns null when `data` is a list at or under the cap", () => {
    expect(
      checkInlineListCap("create_plotly_chart", {
        data: makeRecords(INLINE_LIST_MAX_RECORDS),
      }),
    ).toBeNull();
    expect(
      checkInlineListCap("create_plotly_chart", { data: makeRecords(1) }),
    ).toBeNull();
  });

  it("returns null when `data` is not a list (e.g., a string for json-decode coercion)", () => {
    // Strings flow through to the server's json.loads path; the cap
    // here targets LLM-emitted structured arrays, not pre-stringified
    // payloads. Server-side validation handles malformed strings.
    expect(
      checkInlineListCap("create_plotly_chart", {
        data: JSON.stringify(makeRecords(50)),
      }),
    ).toBeNull();
  });

  it("returns an envelope when `data` exceeds the cap AND `data_uri` is not set", () => {
    const env = checkInlineListCap("create_plotly_chart", {
      data: makeRecords(24),
    });
    expect(env).not.toBeNull();
    expect(env.error).toMatch(/24 records/);
    expect(env.error).toMatch(/cap: 20/);
    expect(env.error).toMatch(/data_uri/);
    expect(env.fix_hint).toMatch(/create_plotly_chart/);
    expect(env.fix_hint).toMatch(/data_uri=/);
    expect(env._capped_arg).toBe("data");
  });

  it("skips the cap when the LLM also set `data_uri` (URI path wins via conflict resolution)", () => {
    expect(
      checkInlineListCap("create_plotly_chart", {
        data: makeRecords(50),
        data_uri: "mcp+cache://x/y",
      }),
    ).toBeNull();
  });

  it("honors a custom cap argument (tunable threshold)", () => {
    const env = checkInlineListCap(
      "create_data_table",
      { data: makeRecords(10) },
      5,
    );
    expect(env).not.toBeNull();
    expect(env.error).toMatch(/10 records/);
    expect(env.error).toMatch(/cap: 5/);
  });

  it("returns null for non-object / array args defensively", () => {
    expect(checkInlineListCap("foo", null)).toBeNull();
    expect(checkInlineListCap("foo", undefined)).toBeNull();
    expect(checkInlineListCap("foo", "string")).toBeNull();
    expect(checkInlineListCap("foo", [1, 2, 3])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration: processToolCalls end-to-end with inline-list cap
// ---------------------------------------------------------------------------

describe("processToolCalls — inline-list cap integration", () => {
  function makeRecords(n) {
    return Array.from({ length: n }, (_, i) => ({
      time: `2026-05-18T${String(i).padStart(2, "0")}:00:00Z`,
      flow: i * 1.1,
    }));
  }

  it("over-cap inline data short-circuits dispatch with an actionable envelope", async () => {
    const callTool = vi.fn(); // must NOT be called
    const client = makeFakeClient({ callToolImpl: callTool });
    const connections = [{ client, transport: null, protocolUsed: "http" }];
    const toolServerMap = new Map([["create_plotly_chart", 0]]);
    const messages = [];

    await processToolCalls(
      [makeToolCall("create_plotly_chart", { data: makeRecords(24) })],
      messages,
      connections,
      toolServerMap,
      makeFreshState(),
      "",
      {
        cacheOptions: { enabled: true, conversationId: "conv-cap" },
      },
    );

    // Tool body was NOT dispatched — the cap short-circuited locally.
    expect(callTool).not.toHaveBeenCalled();

    // The LLM-visible tool message carries the actionable envelope.
    const toolMsg = messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    const parsed = JSON.parse(toolMsg.content);
    expect(parsed.error).toMatch(/data.*24 records/);
    expect(parsed.error).toMatch(/data_uri/);
    expect(parsed.fix_hint).toMatch(/data_uri=/);
    expect(parsed._capped_arg).toBe("data");
    expect(parsed._engine_dispatched).toEqual([]);
  });

  it("under-cap inline data dispatches normally", async () => {
    const receivedArgs = { value: null };
    const callTool = vi.fn(async ({ arguments: args }) => {
      receivedArgs.value = args;
      return {
        data: {
          visualization: {
            uuid: "viz-1",
            source: "Inline Plotly",
            vizType: "plotly",
          },
        },
      };
    });
    const client = makeFakeClient({ callToolImpl: callTool });
    const connections = [{ client, transport: null, protocolUsed: "http" }];
    const toolServerMap = new Map([["create_plotly_chart", 0]]);
    const messages = [];

    await processToolCalls(
      [makeToolCall("create_plotly_chart", { data: makeRecords(15) })],
      messages,
      connections,
      toolServerMap,
      makeFreshState(),
      "",
      {
        cacheOptions: { enabled: true, conversationId: "conv-cap" },
      },
    );

    // Tool was dispatched; cap did not interfere.
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(receivedArgs.value.data).toHaveLength(15);
  });

  it("over-cap inline data with data_uri set skips the cap (substitution wins)", async () => {
    // LLM sent both inline `data` (oversized) AND `data_uri`. The cap
    // defers to the URI path; substituteCacheUris resolves the URI and
    // the conflict resolver drops the inline value. Tool sees resolved
    // inline data of whatever size the cached payload was.
    const cachedData = makeRecords(50); // any size — cache path is uncapped
    const uri = await cacheToolResult({
      payload: cachedData,
      convId: "conv-cap-conflict",
      sourceToolName: "query_data",
      threshold: 1,
    });

    const receivedArgs = { value: null };
    const callTool = vi.fn(async ({ arguments: args }) => {
      receivedArgs.value = args;
      return {
        data: {
          visualization: {
            uuid: "viz-1",
            source: "Inline Plotly",
            vizType: "plotly",
          },
        },
      };
    });
    const client = makeFakeClient({ callToolImpl: callTool });
    const connections = [{ client, transport: null, protocolUsed: "http" }];
    const toolServerMap = new Map([["create_plotly_chart", 0]]);
    const messages = [];

    await processToolCalls(
      [
        makeToolCall("create_plotly_chart", {
          data: makeRecords(99), // inline value gets dropped by conflict resolver
          data_uri: uri,
        }),
      ],
      messages,
      connections,
      toolServerMap,
      makeFreshState(),
      "",
      {
        cacheOptions: { enabled: true, conversationId: "conv-cap-conflict" },
      },
    );

    // Tool dispatched with the RESOLVED data (50 records, cap bypassed
    // because data_uri was present).
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(receivedArgs.value.data).toHaveLength(50);
    expect(receivedArgs.value.data_uri).toBeUndefined();
  });

  it("cache disabled: cap is not enforced (LLM has no way to produce _cache_uri without the cache)", async () => {
    const receivedArgs = { value: null };
    const callTool = vi.fn(async ({ arguments: args }) => {
      receivedArgs.value = args;
      return { data: { ok: true } };
    });
    const client = makeFakeClient({ callToolImpl: callTool });
    const connections = [{ client, transport: null, protocolUsed: "http" }];
    const toolServerMap = new Map([["create_plotly_chart", 0]]);
    const messages = [];

    await processToolCalls(
      [makeToolCall("create_plotly_chart", { data: makeRecords(24) })],
      messages,
      connections,
      toolServerMap,
      makeFreshState(),
      "",
      {
        // cacheOptions omitted → defaults { enabled: false, ... }
      },
    );

    // Cap is gated by cacheOptions.enabled — when off, dispatch proceeds.
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(receivedArgs.value.data).toHaveLength(24);
  });
});
