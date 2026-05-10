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
  looksLikeToolRefusal,
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
    // Inline extractor normalizes `arguments` to a JSON string for parity
    // with the adapter-produced shape (anthropic.js:150 stringifies on
    // receive, ollama.js stringifies on send). Without this, inline-
    // extracted calls flowing back to Ollama as message history get
    // rejected by Ollama's Go struct validator with
    //   cannot unmarshal object into ... arguments of type string.
    const text = 'I will look this up. {"name": "search", "arguments": {"q": "apples"}} Let me know.';
    const result = extractInlineToolCallsWithResidual(text);

    expect(result.calls).toHaveLength(1);
    const call = result.calls[0];
    expect(call.function.name).toBe("search");
    expect(typeof call.function.arguments).toBe("string");
    expect(JSON.parse(call.function.arguments)).toEqual({ q: "apples" });
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

  it("returns arguments as a JSON string regardless of source shape", () => {
    // Pins the string-args contract for ALL inline-extracted calls.
    // Object-shaped args from `{"name": "X", "arguments": {...}}` AND
    // string-shaped args from `{"tool": "X", "query": "..."}` both come
    // out as strings, so downstream consumers (the engine, the ollama
    // wire-format) see a uniform shape.
    const objectArgsText = '{"name": "search", "arguments": {"q": "apples"}}';
    const stringArgsText =
      '```json\n{"tool": "discovery", "query": "restaurants"}\n```';

    const fromObject = extractInlineToolCallsWithResidual(objectArgsText);
    const fromString = extractInlineToolCallsWithResidual(stringArgsText);

    expect(typeof fromObject.calls[0].function.arguments).toBe("string");
    expect(typeof fromString.calls[0].function.arguments).toBe("string");
    // No double-encoding: the originally-string arg stays as the same string.
    expect(fromString.calls[0].function.arguments).toBe("restaurants");
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

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].function.name).toBe("search");
    expect(JSON.parse(result.calls[0].function.arguments)).toEqual({ q: "x" });
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
    expect(JSON.parse(result.calls[0].function.arguments)).toEqual({ q: "x" });
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
    // String args pass through unchanged.
    expect(extractInlineToolCallsWithResidual('{"tool": "x", "request": "y"}').calls)
      .toEqual([{ function: { name: "x", arguments: "y" } }]);
    // Object args are normalized to a JSON string (parity with adapter output).
    const objArgsResult =
      extractInlineToolCallsWithResidual('{"tool": "x", "payload": {"k": 1}}');
    expect(objArgsResult.calls[0].function.name).toBe("x");
    expect(JSON.parse(objArgsResult.calls[0].function.arguments)).toEqual({ k: 1 });
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

describe("looksLikeToolRefusal", () => {
  it("matches the gemma3:12b refusal observed in the wild", () => {
    expect(looksLikeToolRefusal(
      "I am a tool-using AI assistant and cannot provide directions.",
    )).toBe(true);
  });

  it("matches variants with hyphenated and unhyphenated phrasing", () => {
    expect(looksLikeToolRefusal("I'm a tool using AI and can't help with that.")).toBe(true);
    expect(looksLikeToolRefusal(
      "As an AI assistant, I cannot perform tool calls.",
    )).toBe(true);
    expect(looksLikeToolRefusal("I cannot use any tools to answer this.")).toBe(true);
  });

  it("does not match a long legitimate answer that mentions tool-using AI in passing", () => {
    const longText =
      "Tool-using AI assistants are a category of large language models that can call functions. " +
      "They include Claude, GPT-4, and several open-source models. The advantage is that they can " +
      "interact with external systems. " +
      "Examples of tasks they can perform include searching the web, querying databases, and " +
      "running code. Users still cannot fully replace human judgment, however, since these models " +
      "do not have access to real-time data without explicit tool wiring.";
    expect(looksLikeToolRefusal(longText)).toBe(false);
  });

  it("does not match plain answers without tool framing", () => {
    expect(looksLikeToolRefusal("To get to Central Park from Chinatown, take the M train north."))
      .toBe(false);
    expect(looksLikeToolRefusal("I cannot find that information.")).toBe(false);
  });

  it("does not match empty / non-string input", () => {
    expect(looksLikeToolRefusal("")).toBe(false);
    expect(looksLikeToolRefusal(null)).toBe(false);
    expect(looksLikeToolRefusal(undefined)).toBe(false);
  });

  it("requires both tool framing AND a refusal phrase", () => {
    // tool framing without refusal — not a refusal
    expect(looksLikeToolRefusal("Tool-calling lets the AI invoke external functions."))
      .toBe(false);
    // refusal without tool framing — not a tool refusal
    expect(looksLikeToolRefusal("I cannot help with that.")).toBe(false);
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
