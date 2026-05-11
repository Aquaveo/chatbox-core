/**
 * helpers/extractInlineToolCalls.test.js — coverage for inline tool-call
 * extraction and residual-content stripping.
 *
 * Bug context (2026-05-04): a model emitting tool-call-shaped JSON as
 * plain text (e.g., gemma3:12b producing `{"tool": "discovery", "query":
 * "..."}` directly into chat) caused two problems:
 *
 *   1. The raw JSON rendered as a code block in the user-visible
 *      assistant bubble.
 *   2. When the JSON was structured close enough to a tool call, the
 *      engine would call the (likely fabricated) tool — but the
 *      original JSON text still leaked into `messages[].content`,
 *      polluting both the UI and the next turn's conversation history.
 *
 * The fix is `extractInlineToolCallsWithResidual` — same extraction
 * logic, plus residual content with the matched JSON spans + their
 * markdown fence wrappers stripped. The engine pushes that residual
 * (often empty) into the assistant message instead of the original
 * content.
 */

import { describe, expect, it } from "vitest";

import {
  detectAndStripToolShapedJson,
  extractInlineToolCalls,
  extractInlineToolCallsWithResidual,
} from "./index.js";

describe("extractInlineToolCallsWithResidual", () => {
  it("returns empty calls + original text when input has no JSON", () => {
    const text = "Hello, how can I help?";
    expect(extractInlineToolCallsWithResidual(text)).toEqual({
      calls: [],
      residualContent: text,
    });
  });

  it("returns empty calls + empty string for empty input", () => {
    expect(extractInlineToolCallsWithResidual("")).toEqual({
      calls: [],
      residualContent: "",
    });
    expect(extractInlineToolCallsWithResidual(null)).toEqual({
      calls: [],
      residualContent: "",
    });
    expect(extractInlineToolCallsWithResidual(undefined)).toEqual({
      calls: [],
      residualContent: "",
    });
  });

  it("extracts a single tool call and strips it from residual", () => {
    const text = 'I will look this up. {"name": "search", "arguments": {"q": "apples"}} Let me know.';
    const result = extractInlineToolCallsWithResidual(text);

    expect(result.calls).toEqual([
      { function: { name: "search", arguments: { q: "apples" } } },
    ]);
    expect(result.residualContent).toBe("I will look this up.  Let me know.");
  });

  it("handles the observed gemma3 shape: tool + query keys", () => {
    // The exact shape from the 2026-05-04 screenshot bug.
    const text =
      '```json\n{\n  "tool": "discovery",\n  "query": "restaurants in Chinatown"\n}\n```';
    const result = extractInlineToolCallsWithResidual(text);

    expect(result.calls).toEqual([
      {
        function: { name: "discovery", arguments: "restaurants in Chinatown" },
      },
    ]);
    expect(result.residualContent).toBe("");
  });

  it("strips multiple inline tool calls in one response", () => {
    const text =
      'Plan:\n```json\n{"tool": "search", "query": "italian restaurants"}\n```\nThen:\n```json\n{"tool": "search", "query": "transportation"}\n```\nDone.';
    const result = extractInlineToolCallsWithResidual(text);

    expect(result.calls).toHaveLength(2);
    expect(result.calls[0].function.name).toBe("search");
    expect(result.calls[1].function.name).toBe("search");
    expect(result.residualContent).toBe("Plan:\n\nThen:\n\nDone.");
  });

  it("preserves prose around the JSON, removes only the JSON span", () => {
    const text = "Before. {\"name\": \"x\", \"arguments\": {\"y\": 1}} After.";
    const result = extractInlineToolCallsWithResidual(text);

    expect(result.calls).toHaveLength(1);
    expect(result.residualContent).toBe("Before.  After.");
  });

  it("does not match plain JSON examples that lack tool-call shape", () => {
    // A model writing "the response shape is {data: [...]}" must not be
    // mistaken for a tool call.
    const text = 'The response shape is {"data": [1, 2, 3]}.';
    const result = extractInlineToolCallsWithResidual(text);

    expect(result.calls).toEqual([]);
    expect(result.residualContent).toBe(text);
  });

  it("does not match JSON missing args field", () => {
    const text = '{"name": "search"}';
    const result = extractInlineToolCallsWithResidual(text);

    expect(result.calls).toEqual([]);
    expect(result.residualContent).toBe(text);
  });

  it("does not match JSON missing name field", () => {
    const text = '{"arguments": {"q": "x"}}';
    const result = extractInlineToolCallsWithResidual(text);

    expect(result.calls).toEqual([]);
    expect(result.residualContent).toBe(text);
  });

  it("recognizes `tool` alias for name", () => {
    const text = '{"tool": "search", "arguments": {"q": "x"}}';
    const result = extractInlineToolCallsWithResidual(text);

    expect(result.calls).toEqual([
      { function: { name: "search", arguments: { q: "x" } } },
    ]);
  });

  it("recognizes `tool_name` alias for name", () => {
    const text = '{"tool_name": "search", "params": {"q": "x"}}';
    const result = extractInlineToolCallsWithResidual(text);

    expect(result.calls[0].function.name).toBe("search");
  });

  it("recognizes `function.name` nested shape", () => {
    const text = '{"function": {"name": "search", "arguments": {"q": "x"}}}';
    const result = extractInlineToolCallsWithResidual(text);

    expect(result.calls[0].function.name).toBe("search");
    expect(result.calls[0].function.arguments).toEqual({ q: "x" });
  });

  it("recognizes `query` as args alias (Ollama gemma variant)", () => {
    const text = '{"tool": "search", "query": "italian food"}';
    const result = extractInlineToolCallsWithResidual(text);

    expect(result.calls).toEqual([
      { function: { name: "search", arguments: "italian food" } },
    ]);
  });

  it("recognizes `input` as args alias", () => {
    const text = '{"tool": "search", "input": "italian food"}';
    const result = extractInlineToolCallsWithResidual(text);

    expect(result.calls[0].function.arguments).toBe("italian food");
  });

  it("ignores malformed JSON", () => {
    const text = '{"tool": "search", "arguments": {missing quote}}';
    const result = extractInlineToolCallsWithResidual(text);

    expect(result.calls).toEqual([]);
    expect(result.residualContent).toBe(text);
  });

  it("trims trailing whitespace from residual when only JSON was present", () => {
    const text = '   ```json\n{"tool": "x", "query": "y"}\n```   ';
    const result = extractInlineToolCallsWithResidual(text);

    expect(result.calls).toHaveLength(1);
    expect(result.residualContent).toBe("");
  });

  it("collapses excessive blank lines in residual", () => {
    const text = 'Line 1.\n\n\n\n{"tool": "x", "arguments": {"y": 1}}\n\n\n\nLine 2.';
    const result = extractInlineToolCallsWithResidual(text);

    expect(result.calls).toHaveLength(1);
    expect(result.residualContent).toBe("Line 1.\n\nLine 2.");
  });

  it("strips orphan markdown fence markers left behind after JSON removal", () => {
    const text = "```json\n{\"tool\": \"x\", \"query\": \"y\"}\n```";
    const result = extractInlineToolCallsWithResidual(text);

    expect(result.residualContent).toBe("");
  });

  it("preserves arrays as content (not mistaken for tool calls)", () => {
    const text = "Here is a list: [1, 2, 3]";
    const result = extractInlineToolCallsWithResidual(text);

    expect(result.calls).toEqual([]);
    expect(result.residualContent).toBe(text);
  });
});

describe("extractInlineToolCallsWithResidual — extended args aliases", () => {
  it("recognizes `action` as args alias (gemma3:27b google_maps variant)", () => {
    // The exact shape from the second screenshot bug 2026-05-04:
    // gemma3:27b emitted {"tool": "google_maps", "action": "get_directions"}
    const text = '{"tool": "google_maps", "action": "get_directions"}';
    const result = extractInlineToolCallsWithResidual(text);

    expect(result.calls).toEqual([
      { function: { name: "google_maps", arguments: "get_directions" } },
    ]);
    expect(result.residualContent).toBe("");
  });

  it("recognizes `request` and `payload` aliases", () => {
    expect(extractInlineToolCallsWithResidual('{"tool": "x", "request": "y"}').calls)
      .toEqual([{ function: { name: "x", arguments: "y" } }]);
    expect(extractInlineToolCallsWithResidual('{"tool": "x", "payload": {"k": 1}}').calls)
      .toEqual([{ function: { name: "x", arguments: { k: 1 } } }]);
  });
});

describe("detectAndStripToolShapedJson", () => {
  it("returns input unchanged when no JSON present", () => {
    expect(detectAndStripToolShapedJson("Hello world")).toEqual({
      stripped: "Hello world",
      hadToolShapedJson: false,
    });
  });

  it("strips JSON that looks like a tool call but has no recognizable args", () => {
    // Model invented a key we don't know about. The heuristic still
    // recognizes the tool/name field and strips the JSON so the user
    // doesn't see raw protocol data.
    const text = 'Here you go: {"tool": "google_maps", "destination": "NYC"}';
    const result = detectAndStripToolShapedJson(text);

    expect(result.hadToolShapedJson).toBe(true);
    expect(result.stripped).toBe("Here you go:");
  });

  it("preserves non-tool-shaped JSON (data examples, configs)", () => {
    const text = 'Config: {"theme": "dark", "size": "lg"}';
    const result = detectAndStripToolShapedJson(text);

    expect(result.hadToolShapedJson).toBe(false);
    expect(result.stripped).toBe(text);
  });

  it("strips fenced markdown around tool-shaped JSON", () => {
    const text = '```json\n{"tool": "x", "unknown_key": "y"}\n```';
    const result = detectAndStripToolShapedJson(text);

    expect(result.hadToolShapedJson).toBe(true);
    expect(result.stripped).toBe("");
  });

  it("strips multiple tool-shaped attempts in one response", () => {
    const text = 'Try {"tool": "a", "x": 1} or {"tool": "b", "y": 2} done.';
    const result = detectAndStripToolShapedJson(text);

    expect(result.hadToolShapedJson).toBe(true);
    expect(result.stripped).toBe("Try  or  done.");
  });

  it("returns empty content + hadToolShapedJson=true when JSON is the whole message", () => {
    const text = '{"tool": "discovery", "unknown_args_key": "something"}';
    const result = detectAndStripToolShapedJson(text);

    expect(result.hadToolShapedJson).toBe(true);
    expect(result.stripped).toBe("");
  });
});

describe("extractInlineToolCalls (public API back-compat)", () => {
  it("returns just the calls array (back-compat shape)", () => {
    const text = '{"tool": "search", "query": "x"}';
    const calls = extractInlineToolCalls(text);

    expect(Array.isArray(calls)).toBe(true);
    expect(calls).toEqual([
      { function: { name: "search", arguments: "x" } },
    ]);
  });

  it("returns empty array on no match (back-compat shape)", () => {
    expect(extractInlineToolCalls("hello")).toEqual([]);
    expect(extractInlineToolCalls("")).toEqual([]);
    expect(extractInlineToolCalls(null)).toEqual([]);
  });
});
