/**
 * engine/prompts.test.js — coverage for the module-private prompt-template
 * helpers (Plan 2026-05-08-005 Unit 2).
 *
 *   1. `discoverPrompts(mcpServers)` — opens transient transport per server,
 *      calls listPrompts, returns {promptsByServer, promptServerMap,
 *      perServer}. Nil/empty input returns the empty envelope synchronously
 *      WITHOUT opening any transport. Same-name collision: first-wins +
 *      console.warn (mirrors the toolServerMap precedent at
 *      engine/index.js:252-256).
 *
 *   2. `getPrompt(serverIdx, name, args, mcpServers)` — opens transient
 *      transport, calls getPrompt, filters text-only content per R7a, and
 *      returns the concatenated string. Empty result throws
 *      `EmptyPromptError` so callers can distinguish from network/transport
 *      errors.
 *
 * Both helpers stay module-private (no public engine export). Tests reach
 * them via `engine/__test_internals__.js`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ERROR_KEYS } from "./mcpErrors.js";
import { makeFakeClient } from "../test-helpers/fakeConn.js";

// ---------------------------------------------------------------------------
// Stub the MCP transport so discoverPrompts / getPrompt don't try to talk to
// a real server. Same pattern as engine/tool-tags.test.js.
// ---------------------------------------------------------------------------

vi.mock("./transports.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    pickTransport: vi.fn(),
    closeMcpConnection: vi.fn().mockResolvedValue(undefined),
  };
});

import { pickTransport, closeMcpConnection } from "./transports.js";
import {
  discoverPrompts,
  getPrompt,
  EmptyPromptError,
} from "./__test_internals__.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeServerWithPrompts(prompts) {
  const client = makeFakeClient({
    listPromptsImpl: vi.fn().mockResolvedValue({ prompts }),
  });
  return { client, transport: { close: vi.fn() }, protocolUsed: "http" };
}

function makeFakeServerWithListPromptsError(err) {
  const client = makeFakeClient({
    listPromptsImpl: vi.fn().mockRejectedValue(err),
  });
  return { client, transport: { close: vi.fn() }, protocolUsed: "http" };
}

function makeFakeServerWithGetPromptResponse(messages) {
  const client = makeFakeClient({
    getPromptImpl: vi.fn().mockResolvedValue({ messages }),
  });
  return { client, transport: { close: vi.fn() }, protocolUsed: "http" };
}

let warnSpy;
beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  pickTransport.mockReset();
  closeMcpConnection.mockClear();
});
afterEach(() => {
  warnSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// discoverPrompts — happy path
// ---------------------------------------------------------------------------

describe("discoverPrompts — happy path", () => {
  it("collects prompts from two servers and builds promptServerMap", async () => {
    pickTransport
      .mockResolvedValueOnce(
        makeFakeServerWithPrompts([
          { name: "plot_timeseries", description: "Plot timeseries" },
        ]),
      )
      .mockResolvedValueOnce(
        makeFakeServerWithPrompts([
          { name: "summarize_query", description: "Summarize a query" },
        ]),
      );

    const result = await discoverPrompts([
      { url: "http://a", name: "A" },
      { url: "http://b", name: "B" },
    ]);

    expect(Object.keys(result.promptsByServer)).toEqual(["0", "1"]);
    expect(result.promptsByServer["0"]).toHaveLength(1);
    expect(result.promptsByServer["0"][0].name).toBe("plot_timeseries");
    expect(result.promptsByServer["1"][0].name).toBe("summarize_query");

    expect(result.promptServerMap).toBeInstanceOf(Map);
    expect(result.promptServerMap.get("plot_timeseries")).toBe(0);
    expect(result.promptServerMap.get("summarize_query")).toBe(1);

    expect(result.perServer).toEqual([
      { serverId: "0", promptCount: 1, errorKey: null },
      { serverId: "1", promptCount: 1, errorKey: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
// discoverPrompts — nil/empty input contract
// ---------------------------------------------------------------------------

describe("discoverPrompts — nil/empty input", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty array", []],
  ])(
    "returns empty envelope synchronously for %s without opening a transport",
    async (_label, input) => {
      const result = await discoverPrompts(input);

      expect(result).toEqual({
        promptsByServer: {},
        promptServerMap: expect.any(Map),
        perServer: [],
      });
      expect(result.promptServerMap.size).toBe(0);

      // The contract: no transport handshake on the no-op input.
      expect(pickTransport).not.toHaveBeenCalled();
      expect(closeMcpConnection).not.toHaveBeenCalled();
    },
  );
});

// ---------------------------------------------------------------------------
// discoverPrompts — name collision
// ---------------------------------------------------------------------------

describe("discoverPrompts — name collision", () => {
  it("first server wins on same-name collision; console.warn fires once", async () => {
    pickTransport
      .mockResolvedValueOnce(
        makeFakeServerWithPrompts([
          { name: "duplicate_prompt", description: "First server" },
        ]),
      )
      .mockResolvedValueOnce(
        makeFakeServerWithPrompts([
          { name: "duplicate_prompt", description: "Second server" },
        ]),
      );

    const result = await discoverPrompts([
      { url: "http://a", name: "A" },
      { url: "http://b", name: "B" },
    ]);

    // First server wins.
    expect(result.promptServerMap.get("duplicate_prompt")).toBe(0);

    // Both servers' raw prompt lists are still preserved (the per-server
    // map is uncontested); the promptServerMap is the resolution surface.
    expect(result.promptsByServer["0"]).toHaveLength(1);
    expect(result.promptsByServer["1"]).toHaveLength(1);

    // One warning, format mirrors the toolServerMap precedent.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("Prompt name collision");
    expect(warnSpy.mock.calls[0][0]).toContain("duplicate_prompt");
  });
});

// ---------------------------------------------------------------------------
// discoverPrompts — empty list per server
// ---------------------------------------------------------------------------

describe("discoverPrompts — empty per-server list", () => {
  it("server returns {prompts: []} → entry is [], promptCount 0, no error", async () => {
    pickTransport.mockResolvedValueOnce(makeFakeServerWithPrompts([]));

    const result = await discoverPrompts([{ url: "http://x", name: "S" }]);

    expect(result.promptsByServer["0"]).toEqual([]);
    expect(result.promptServerMap.size).toBe(0);
    expect(result.perServer).toEqual([
      { serverId: "0", promptCount: 0, errorKey: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
// discoverPrompts — error paths
// ---------------------------------------------------------------------------

describe("discoverPrompts — error paths", () => {
  it("R10a: -32601 method-not-found → entry [] + errorKey notMcpServer; other servers unaffected", async () => {
    const methodNotFound = new Error("Method not found");
    methodNotFound.code = -32601;

    pickTransport
      .mockResolvedValueOnce(makeFakeServerWithListPromptsError(methodNotFound))
      .mockResolvedValueOnce(
        makeFakeServerWithPrompts([
          { name: "prompt_b", description: "Survivor" },
        ]),
      );

    const result = await discoverPrompts([
      { url: "http://a", name: "A" },
      { url: "http://b", name: "B" },
    ]);

    // Failing server: empty entry + errorKey set.
    expect(result.promptsByServer["0"]).toEqual([]);
    expect(result.perServer[0]).toEqual({
      serverId: "0",
      promptCount: 0,
      errorKey: ERROR_KEYS.notMcpServer,
    });

    // Sibling server is untouched.
    expect(result.promptsByServer["1"]).toHaveLength(1);
    expect(result.promptServerMap.get("prompt_b")).toBe(1);
    expect(result.perServer[1]).toEqual({
      serverId: "1",
      promptCount: 1,
      errorKey: null,
    });

    // Transport for the failing server was still closed.
    expect(closeMcpConnection).toHaveBeenCalledTimes(2);
  });

  it("R10c: generic network error → entry [] + errorKey notMcpServer; transport closed", async () => {
    pickTransport.mockResolvedValueOnce(
      makeFakeServerWithListPromptsError(new Error("network down")),
    );

    const result = await discoverPrompts([{ url: "http://x", name: "S" }]);

    expect(result.promptsByServer["0"]).toEqual([]);
    expect(result.perServer[0].errorKey).toBe(ERROR_KEYS.notMcpServer);
    expect(closeMcpConnection).toHaveBeenCalledTimes(1);
  });

  it("transport-phase failure (pickTransport rejects) → entry [] + connectionFailed; no close", async () => {
    pickTransport.mockRejectedValueOnce(new Error("connect refused"));

    const result = await discoverPrompts([{ url: "http://x", name: "S" }]);

    expect(result.promptsByServer["0"]).toEqual([]);
    expect(result.perServer[0].errorKey).toBe(ERROR_KEYS.connectionFailed);
    // pickTransport never returned a connection, so closeMcpConnection
    // shouldn't be called on a null conn.
    expect(closeMcpConnection).not.toHaveBeenCalled();
  });

  it("transport-phase failure with errorKey already set → propagates that errorKey", async () => {
    const err = new Error("invalid scheme");
    err.errorKey = ERROR_KEYS.invalidScheme;
    pickTransport.mockRejectedValueOnce(err);

    const result = await discoverPrompts([{ url: "file:///bad", name: "S" }]);

    expect(result.perServer[0].errorKey).toBe(ERROR_KEYS.invalidScheme);
  });

  it("timeout (isTimeout=true) on listPrompts → entry [] + errorKey timeout; treated like R10c silent fallback", async () => {
    const timeoutErr = new Error("Operation timed out after 3000ms");
    timeoutErr.isTimeout = true;
    pickTransport.mockResolvedValueOnce(
      makeFakeServerWithListPromptsError(timeoutErr),
    );

    const result = await discoverPrompts([{ url: "http://slow", name: "S" }]);

    expect(result.promptsByServer["0"]).toEqual([]);
    expect(result.perServer[0].errorKey).toBe(ERROR_KEYS.timeout);
    // Transport was opened, then closed in finally.
    expect(closeMcpConnection).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// getPrompt — happy path / R7a content filtering
// ---------------------------------------------------------------------------

describe("getPrompt — text-only content filter (R7a)", () => {
  it("happy path: returns string containing all 8 [bracket] placeholders", async () => {
    const renderedText =
      "Retrieve a line chart of the time series for variable [variable] for " +
      "feature id [feature_id] for output index [index] for the [forecast] " +
      "forecast on [model] model and date [date], cycle [cycle], and " +
      "vpu [vpu]";
    pickTransport.mockResolvedValueOnce(
      makeFakeServerWithGetPromptResponse([
        {
          role: "user",
          content: { type: "text", text: renderedText },
        },
      ]),
    );

    const text = await getPrompt(
      0,
      "plot_timeseries",
      {},
      [{ url: "http://x", name: "S" }],
    );

    // All 8 named brackets present verbatim.
    for (const name of [
      "[variable]",
      "[feature_id]",
      "[index]",
      "[forecast]",
      "[model]",
      "[date]",
      "[cycle]",
      "[vpu]",
    ]) {
      expect(text).toContain(name);
    }
  });

  it("filters out non-text content (image, resource); only text.text values appear", async () => {
    pickTransport.mockResolvedValueOnce(
      makeFakeServerWithGetPromptResponse([
        {
          role: "user",
          content: [
            { type: "text", text: "before-" },
            { type: "image", data: "BASE64DATA", mimeType: "image/png" },
            {
              type: "resource",
              resource: { uri: "file:///x", text: "ignored" },
            },
            { type: "text", text: "after" },
          ],
        },
      ]),
    );

    const text = await getPrompt(
      0,
      "mixed",
      {},
      [{ url: "http://x", name: "S" }],
    );

    expect(text).toBe("before-after");
    expect(text).not.toContain("BASE64DATA");
    expect(text).not.toContain("ignored");
  });

  it("concatenates text across multiple messages in order", async () => {
    pickTransport.mockResolvedValueOnce(
      makeFakeServerWithGetPromptResponse([
        { role: "user", content: { type: "text", text: "alpha " } },
        { role: "assistant", content: { type: "text", text: "beta " } },
        { role: "user", content: { type: "text", text: "gamma" } },
      ]),
    );

    const text = await getPrompt(
      0,
      "multi",
      {},
      [{ url: "http://x", name: "S" }],
    );

    expect(text).toBe("alpha beta gamma");
  });

  it("closes transport after successful resolve", async () => {
    pickTransport.mockResolvedValueOnce(
      makeFakeServerWithGetPromptResponse([
        { role: "user", content: { type: "text", text: "ok" } },
      ]),
    );

    await getPrompt(0, "ok", {}, [{ url: "http://x", name: "S" }]);

    expect(closeMcpConnection).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// getPrompt — empty result throws EmptyPromptError
// ---------------------------------------------------------------------------

describe("getPrompt — empty resolved text", () => {
  it("throws EmptyPromptError when no messages", async () => {
    pickTransport.mockResolvedValueOnce(makeFakeServerWithGetPromptResponse([]));

    await expect(
      getPrompt(0, "empty", {}, [{ url: "http://x", name: "S" }]),
    ).rejects.toBeInstanceOf(EmptyPromptError);
  });

  it("throws EmptyPromptError when all content is non-text", async () => {
    pickTransport.mockResolvedValueOnce(
      makeFakeServerWithGetPromptResponse([
        {
          role: "user",
          content: [
            { type: "image", data: "x", mimeType: "image/png" },
            { type: "resource", resource: { uri: "file:///x" } },
          ],
        },
      ]),
    );

    await expect(
      getPrompt(0, "imageonly", {}, [{ url: "http://x", name: "S" }]),
    ).rejects.toBeInstanceOf(EmptyPromptError);
  });

  it("throws EmptyPromptError when text values are all empty strings", async () => {
    pickTransport.mockResolvedValueOnce(
      makeFakeServerWithGetPromptResponse([
        { role: "user", content: { type: "text", text: "" } },
        { role: "assistant", content: { type: "text", text: "" } },
      ]),
    );

    await expect(
      getPrompt(0, "blanks", {}, [{ url: "http://x", name: "S" }]),
    ).rejects.toBeInstanceOf(EmptyPromptError);
  });

  it("closes transport even when EmptyPromptError is thrown", async () => {
    pickTransport.mockResolvedValueOnce(makeFakeServerWithGetPromptResponse([]));

    await expect(
      getPrompt(0, "empty", {}, [{ url: "http://x", name: "S" }]),
    ).rejects.toBeInstanceOf(EmptyPromptError);

    expect(closeMcpConnection).toHaveBeenCalledTimes(1);
  });
});
