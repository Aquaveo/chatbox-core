/**
 * engine/engine-dispatched.test.js — coverage for the `_engine_dispatched`
 * field augmentation (Plan 003 Unit A2).
 *
 * Contract: every object-shaped tool result the engine forwards back to
 * the LLM gains a `_engine_dispatched: [<uuid>, ...]` field naming the
 * envelope UUIDs this *single* tool call dispatched (per-call delta,
 * not cumulative — K2). Non-object results pass through unchanged (K1).
 * Truncation paths preserve the field for all three envelope kinds —
 * `visualization`, `layer_update`, `patch_update` (K3). When a tool
 * result already has an `_engine_dispatched` key, the engine overwrites
 * with the authoritative value and emits a console.warn (K5/K15).
 *
 * The field is informational only — no early returns, no behavior
 * change to the turn loop. Tests drive `processToolCalls` directly to
 * keep the surface small.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { processToolCalls } from "./index.js";
import { makeFakeClient } from "../test-helpers/fakeConn.js";
import { MAX_TOOL_RESULT_CHARS } from "../config/index.js";

// ---------------------------------------------------------------------------
// Helpers
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

/**
 * Drive a single tool call and return the parsed `tool` message content
 * — this is what the engine forwards back to the LLM.
 */
async function runOne(toolName, toolResult, args = {}) {
  const { connections, toolServerMap } = makeConnections({
    [toolName]: toolResult,
  });
  const messages = [];
  await processToolCalls(
    [makeToolCall(toolName, args)],
    messages,
    connections,
    toolServerMap,
    makeFreshState(),
    "",
    {},
  );
  const toolMsg = messages.find((m) => m.role === "tool");
  if (!toolMsg) return null;
  // Tool message content is always a string (JSON.stringify or raw).
  // For object results the engine produces JSON; for non-object the
  // engine writes the raw scalar via String().
  try {
    return JSON.parse(toolMsg.content);
  } catch {
    return toolMsg.content;
  }
}

// ---------------------------------------------------------------------------
// console.warn spy — collision tests inspect this directly.
// ---------------------------------------------------------------------------

let warnSpy;
beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Happy paths — per-call delta semantics for each envelope kind
// ---------------------------------------------------------------------------

describe("_engine_dispatched — happy paths", () => {
  it("populates with the visualization UUID when the result has one", async () => {
    const forwarded = await runOne("create_plotly_chart", {
      visualization: { uuid: "viz-abc", source: "intake", vizType: "chart" },
    });
    expect(forwarded._engine_dispatched).toEqual(["viz-abc"]);
  });

  it("populates with the layer_update UUID when the result has one", async () => {
    const forwarded = await runOne("add_map_service_layer", {
      layer_update: { uuid: "layer-def", action: "add" },
    });
    expect(forwarded._engine_dispatched).toEqual(["layer-def"]);
  });

  it("populates with the patch_update UUID when the result has one", async () => {
    const forwarded = await runOne("patch_visualization", {
      patch_update: { uuid: "patch-ghi", ops: [] },
    });
    expect(forwarded._engine_dispatched).toEqual(["patch-ghi"]);
  });

  it("populates with [] for a data-only object result (no envelope)", async () => {
    const forwarded = await runOne("query_output_file_from_output_selector", {
      rows: [{ a: 1 }, { a: 2 }],
    });
    expect(forwarded._engine_dispatched).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// K1 — non-object results: field is NOT injected
// ---------------------------------------------------------------------------

describe("_engine_dispatched — K1 non-object results pass through unchanged", () => {
  it("does not wrap a scalar string result", async () => {
    const forwarded = await runOne("scalar_string_tool", "ok");
    // String content is not JSON-parseable as an object, so runOne
    // returns the raw string. Assert the field was not appended in
    // any wrapped form.
    expect(forwarded).toBe("ok");
  });

  it("does not wrap a null result", async () => {
    // The default `runOne` helper sends fixture values through fakeConn's
    // `{ data: <value> }` shape, which means a fixture of `null` produces
    // toolResult = `{ data: null }` (an object), not bare null. To truly
    // exercise the null path, drive callTool with a content-text fixture
    // that maybeParseJson can resolve to JSON null.
    const callTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "null" }],
    });
    const client = makeFakeClient({ callToolImpl: callTool });
    const connections = [{ client, transport: null, protocolUsed: "http" }];
    const toolServerMap = new Map([["null_tool", 0]]);
    const messages = [];

    await processToolCalls(
      [makeToolCall("null_tool")],
      messages,
      connections,
      toolServerMap,
      makeFreshState(),
      "",
      {},
    );

    const toolMsg = messages.find((m) => m.role === "tool");
    // For null, the engine writes `String(null ?? "")` === "" to the
    // tool message. Assert no `{value, _engine_dispatched}` wrapping.
    expect(typeof toolMsg.content).toBe("string");
    expect(toolMsg.content).not.toContain("_engine_dispatched");
  });
});

// ---------------------------------------------------------------------------
// K2 — per-call delta semantics
// ---------------------------------------------------------------------------

describe("_engine_dispatched — K2 per-call delta semantics", () => {
  it("each tool call sees only its own dispatched UUIDs across a multi-call turn", async () => {
    const { connections, toolServerMap } = makeConnections({
      first_chart: { visualization: { uuid: "uuid-A", source: "s", vizType: "chart" } },
      data_only: { rows: [{ x: 1 }] },
    });
    const messages = [];

    await processToolCalls(
      [makeToolCall("first_chart"), makeToolCall("data_only")],
      messages,
      connections,
      toolServerMap,
      makeFreshState(),
      "",
      {},
    );

    const toolMessages = messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(2);

    const firstParsed = JSON.parse(toolMessages[0].content);
    const secondParsed = JSON.parse(toolMessages[1].content);

    expect(firstParsed._engine_dispatched).toEqual(["uuid-A"]);
    // CRITICAL: second call's field is [], NOT ["uuid-A"]. Cumulative
    // semantics would carry uuid-A forward and falsely tell the LLM
    // the data-only tool also rendered something.
    expect(secondParsed._engine_dispatched).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// K3 — truncation preserves the field for all three envelope kinds
// ---------------------------------------------------------------------------

describe("_engine_dispatched — K3 truncation preserves field", () => {
  // Build a payload large enough to exceed MAX_TOOL_RESULT_CHARS.
  function bloatString(charCount) {
    return "x".repeat(charCount);
  }

  it("preserves field through visualization truncation (compact summary path)", async () => {
    const bloat = bloatString(MAX_TOOL_RESULT_CHARS + 100);
    const forwarded = await runOne("big_chart", {
      visualization: {
        uuid: "viz-trunc",
        source: "intake",
        vizType: "chart",
        figure: { huge: bloat },
      },
    });
    expect(forwarded._engine_dispatched).toEqual(["viz-trunc"]);
    expect(forwarded._truncated).toBe(true);
  });

  it("preserves field through data-only oversized fallback path", async () => {
    const bloat = bloatString(MAX_TOOL_RESULT_CHARS + 100);
    const forwarded = await runOne("big_data", {
      rows: [{ blob: bloat }],
    });
    // Truncation fallback for non-envelope object: should still be a
    // structured object (per K3) preserving _engine_dispatched: [].
    expect(forwarded._engine_dispatched).toEqual([]);
    expect(forwarded._truncated).toBe(true);
  });

  it("data-only success envelope: metadata + recovery hint preserved across truncation", async () => {
    // Regression for 2026-05-18 production bug: a 240-row time-series
    // response from query_output_files_from_output_selector blew the
    // per-tool cap. The data-only `else` branch in the truncation block
    // previously produced `{}` (plus the `_truncated` / `_engine_dispatched`
    // markers), giving the LLM nothing to consume and nothing to retry
    // against — it looped on the same query. The new contract: drop the
    // bulk `data` array but preserve `ok`, `rows`, `columns`, `file_count`,
    // `fix_hint`, and add a `_truncation_hint` describing how to recover.
    const bloat = bloatString(MAX_TOOL_RESULT_CHARS + 100);
    const forwarded = await runOne("big_query", {
      ok: true,
      rows: 240,
      file_count: 10,
      columns: ["time", "flow"],
      data: [{ blob: bloat }],
    });
    expect(forwarded._truncated).toBe(true);
    expect(forwarded._engine_dispatched).toEqual([]);
    expect(forwarded.ok).toBe(true);
    expect(forwarded.rows).toBe(240);
    expect(forwarded.file_count).toBe(10);
    expect(forwarded.columns).toEqual(["time", "flow"]);
    // Bulk payload dropped.
    expect(forwarded.data).toBeUndefined();
    // Recovery hint present and mentions actionable retry options.
    expect(forwarded._truncation_hint).toMatch(/WHERE|LIMIT|aggregate/i);
  });

  it("data-only error envelope: structured error survives truncation", async () => {
    // Companion case to the success-metadata test: when an oversized
    // result also carries a structured error (object with code+message),
    // preserve the whole error object — not just the string form. The
    // pre-fix path only kept `error` if it was a string, so envelopes
    // with `error: {code, message}` lost their recovery context entirely.
    const bloat = bloatString(MAX_TOOL_RESULT_CHARS + 100);
    const forwarded = await runOne("big_error", {
      ok: false,
      error: { code: "invalid_query", message: "column 'foo' not found" },
      fix_hint: "Use one of: time, flow.",
      available_columns: [bloat],
    });
    expect(forwarded._truncated).toBe(true);
    expect(forwarded.ok).toBe(false);
    expect(forwarded.error).toEqual({
      code: "invalid_query",
      message: "column 'foo' not found",
    });
    expect(forwarded.fix_hint).toBe("Use one of: time, flow.");
  });

  it("preserves field through layer_update truncation", async () => {
    const bloat = bloatString(MAX_TOOL_RESULT_CHARS + 100);
    const forwarded = await runOne("big_layer", {
      layer_update: {
        uuid: "layer-trunc",
        action: "add",
        config: { blob: bloat },
      },
    });
    expect(forwarded._engine_dispatched).toEqual(["layer-trunc"]);
    expect(forwarded._truncated).toBe(true);
  });

  it("preserves field through patch_update truncation", async () => {
    const bloat = bloatString(MAX_TOOL_RESULT_CHARS + 100);
    const forwarded = await runOne("big_patch", {
      patch_update: {
        uuid: "patch-trunc",
        ops: [{ blob: bloat }],
      },
    });
    expect(forwarded._engine_dispatched).toEqual(["patch-trunc"]);
    expect(forwarded._truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// K5 / K15 — collision handling: collision-then-error ordering
// ---------------------------------------------------------------------------

describe("_engine_dispatched — K5/K15 collision handling", () => {
  it("overwrites a pre-existing field with engine's authoritative value + warns", async () => {
    const forwarded = await runOne("adversarial_tool", {
      visualization: { uuid: "viz-real", source: "s", vizType: "chart" },
      _engine_dispatched: ["bogus"],
    });
    expect(forwarded._engine_dispatched).toEqual(["viz-real"]);
    expect(warnSpy).toHaveBeenCalled();
    // Assert the warning identifies the offending tool by name.
    const warnedWithName = warnSpy.mock.calls.some((call) =>
      call.some((arg) => typeof arg === "string" && arg.includes("adversarial_tool")),
    );
    expect(warnedWithName).toBe(true);
  });

  it("collision-then-error ordering: error envelope keeps {error} but field is authoritative", async () => {
    // K15 — adversarial tool returns both an {error} and a pre-populated
    // _engine_dispatched. The collision check fires first (overwrites
    // with the engine's authoritative value, which is [] because no
    // envelope was actually pushed), then the {error} survives in the
    // forwarded result. Downstream banner-suppression (Unit C3) reads
    // the post-collision result.
    const forwarded = await runOne("error_tool", {
      error: "rejected",
      _engine_dispatched: ["bogus"],
    });
    expect(forwarded.error).toBe("rejected");
    expect(forwarded._engine_dispatched).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });
});
