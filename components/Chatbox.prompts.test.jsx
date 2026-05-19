// @vitest-environment jsdom
/**
 * components/Chatbox.prompts.test.jsx — coverage for Plan 2026-05-08-005
 * Unit 4: prompts state wired through <Chatbox> + R11 error placement
 * fix.
 *
 * Mocks the engine helpers (`discoverPrompts`, `getPrompt`) so the
 * tests don't need a live MCP server. Mirrors Chatbox.persistence.test.jsx
 * setup conventions: jsdom env, lazy import of Chatbox after vi.mock,
 * createRoot + act render, mount/unmount tracking.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

// Same listModels mock as Chatbox.persistence.test.jsx — without this
// the listModels useEffect tries a real fetch in jsdom.
vi.mock("../helpers/index.js", async () => {
  const actual = await vi.importActual("../helpers/index.js");
  return {
    ...actual,
    listModels: vi.fn(),
  };
});

// Mock the engine helpers. runChatSession is preserved as-is from the
// real module so other Chatbox behaviors are unaffected. discoverPrompts
// + getPrompt are vi.fn() so each test can configure resolution behavior.
vi.mock("../engine/index.js", async () => {
  const actual = await vi.importActual("../engine/index.js");
  return {
    ...actual,
    discoverPrompts: vi.fn(),
    getPrompt: vi.fn(),
  };
});

import { listModels } from "../helpers/index.js";
import { discoverPrompts, getPrompt } from "../engine/index.js";

const mounted = [];

function emptyDiscoverEnvelope() {
  return {
    promptsByServer: {},
    promptServerMap: new Map(),
    perServer: [],
  };
}

beforeEach(() => {
  listModels.mockResolvedValue([
    { name: "test-model", contextLength: 8192 },
  ]);
  // Default: discoverPrompts resolves with the empty envelope. Each
  // test that needs prompts overrides per-call.
  discoverPrompts.mockResolvedValue(emptyDiscoverEnvelope());
  getPrompt.mockResolvedValue("default rendered text");
  globalThis.localStorage?.clear?.();
});

afterEach(() => {
  while (mounted.length) {
    const { root, container } = mounted.pop();
    act(() => root.unmount());
    container.remove();
  }
});

async function renderChatbox(props = {}) {
  const { default: Chatbox } = await import("./Chatbox.jsx");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Chatbox {...props} />);
  });
  mounted.push({ root, container });
  return { container, root };
}

async function rerenderChatbox(root, props = {}) {
  const { default: Chatbox } = await import("./Chatbox.jsx");
  await act(async () => {
    root.render(<Chatbox {...props} />);
  });
}

// Helper: a deferred promise so tests can control resolution timing.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const SERVER_A = { url: "https://server-a.example/mcp", name: "Server A" };
const SERVER_B = { url: "https://server-b.example/mcp", name: "Server B" };

const PROMPT_FOO = {
  name: "plot_timeseries",
  description: "Plot a NRDS timeseries",
};
const PROMPT_BAR = {
  name: "summarize_basin",
  description: "Summarize a basin",
};

// Mirrors the post-refactor NRDS shape: every arg is `required: true`
// with a hint-bearing `description`. Used to assert the chatbox-core
// client-side synth produces `[<description>]` brackets.
const PROMPT_PLOT_NRDS = {
  name: "plot_timeseries",
  description: "Plot a NRDS timeseries",
  arguments: [
    {
      name: "model",
      description: "cfe_nom / lstm / routing_only",
      required: true,
    },
    {
      name: "date",
      description: "yyyy-mm-dd",
      required: true,
    },
  ],
};

// FastMCP auto-appends a JSON-schema note to non-bare-`str` arg
// descriptions. The chatbox-core synth strips this suffix so the
// resulting bracket hint is clean.
const FASTMCP_SUFFIX =
  "\n\nProvide as a JSON string matching the following schema: " +
  '{"description":"yyyy-mm-dd","type":"string"}';
const PROMPT_PLOT_NRDS_FASTMCP = {
  name: "plot_timeseries",
  description: "Plot a NRDS timeseries",
  arguments: [
    {
      name: "date",
      description: "yyyy-mm-dd" + FASTMCP_SUFFIX,
      required: true,
    },
  ],
};

// Subway-style: required args with no defaults; rich-text descriptions.
const PROMPT_PLAN_TRIP = {
  name: "plan-trip",
  description: "Plan a NYC subway trip",
  arguments: [
    {
      name: "from",
      description: 'Starting station name (e.g. "Times Square")',
      required: true,
    },
    {
      name: "to",
      description: 'Destination station name (e.g. "Fulton St")',
      required: true,
    },
  ],
};

// Mixed required + optional: optional args should NOT be synthesized
// (so server-side defaults can render).
const PROMPT_MIXED = {
  name: "mixed",
  description: "Required + optional",
  arguments: [
    { name: "needed", description: "must supply", required: true },
    { name: "skip_me", description: "server default", required: false },
  ],
};

// Required arg with no description — synth falls back to bare name.
const PROMPT_NO_DESC = {
  name: "no-desc",
  description: "",
  arguments: [
    { name: "anon", required: true },
  ],
};

describe("Chatbox prompts discovery — R3 mount + change", () => {
  it("calls discoverPrompts once on mount and populates prompts state", async () => {
    discoverPrompts.mockResolvedValueOnce({
      promptsByServer: { 0: [PROMPT_FOO] },
      promptServerMap: new Map([["plot_timeseries", 0]]),
      perServer: [{ serverId: "0", promptCount: 1, errorKey: null }],
    });

    const { container } = await renderChatbox({ mcpServers: [SERVER_A] });

    expect(discoverPrompts).toHaveBeenCalled();
    // ChatInputBar renders the slash hint when prompts is non-empty —
    // a deterministic signal that the prompts state populated.
    const textarea = container.querySelector("textarea");
    expect(textarea).toBeTruthy();
    expect(textarea.placeholder).toMatch(/\/ for templates/);
  });

  it("re-runs discoverPrompts when mcpServers prop reference changes", async () => {
    discoverPrompts
      .mockResolvedValueOnce({
        promptsByServer: { 0: [PROMPT_FOO] },
        promptServerMap: new Map([["plot_timeseries", 0]]),
        perServer: [{ serverId: "0", promptCount: 1, errorKey: null }],
      })
      .mockResolvedValueOnce({
        promptsByServer: { 0: [PROMPT_BAR] },
        promptServerMap: new Map([["summarize_basin", 0]]),
        perServer: [{ serverId: "0", promptCount: 1, errorKey: null }],
      });

    const { root } = await renderChatbox({ mcpServers: [SERVER_A] });
    const callCountAfterMount = discoverPrompts.mock.calls.length;
    expect(callCountAfterMount).toBeGreaterThanOrEqual(1);

    await rerenderChatbox(root, { mcpServers: [SERVER_B] });
    // Allow the second resolve + state update to flush.
    await act(async () => { await Promise.resolve(); });

    expect(discoverPrompts.mock.calls.length).toBeGreaterThan(callCountAfterMount);
  });

  it("drops out-of-order resolves (race A then B; A resolves last)", async () => {
    const dA = deferred();
    const dB = deferred();
    discoverPrompts
      .mockReturnValueOnce(dA.promise)
      .mockReturnValueOnce(dB.promise);

    const { root, container } = await renderChatbox({ mcpServers: [SERVER_A] });
    await rerenderChatbox(root, { mcpServers: [SERVER_B] });

    // B resolves first with PROMPT_BAR.
    await act(async () => {
      dB.resolve({
        promptsByServer: { 0: [PROMPT_BAR] },
        promptServerMap: new Map([["summarize_basin", 0]]),
        perServer: [{ serverId: "0", promptCount: 1, errorKey: null }],
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    // Now A resolves AFTER B. The generation counter must drop A's
    // result. Without this, prompts state would briefly show PROMPT_FOO.
    await act(async () => {
      dA.resolve({
        promptsByServer: { 0: [PROMPT_FOO] },
        promptServerMap: new Map([["plot_timeseries", 0]]),
        perServer: [{ serverId: "0", promptCount: 1, errorKey: null }],
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    // Differentiate via the popover content. Type `/` to open it.
    const textarea = container.querySelector("textarea");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      ).set;
      setter.call(textarea, "/");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });

    // The popover lists the LATEST resolved prompt — PROMPT_BAR (summarize_basin).
    // Stale A's PROMPT_FOO must NOT appear. Search both portal target
    // (document.body) and container.
    const listbox = document.querySelector('[role="listbox"]');
    expect(listbox, "expected popover to open after typing /").toBeTruthy();
    const text = listbox.textContent || "";
    expect(text).toMatch(/summarize_basin/);
    expect(text).not.toMatch(/plot_timeseries/);
  });

  it("post-unmount discoverPrompts resolve does not trigger setState", async () => {
    const d = deferred();
    discoverPrompts.mockReturnValueOnce(d.promise);

    const { root, container } = await renderChatbox({ mcpServers: [SERVER_A] });
    // Unmount before the discover resolves.
    await act(async () => { root.unmount(); });
    container.remove();
    mounted.length = 0; // we already unmounted

    // No "Can't perform a React state update" warning should fire.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => {
      d.resolve({
        promptsByServer: { 0: [PROMPT_FOO] },
        promptServerMap: new Map([["plot_timeseries", 0]]),
        perServer: [{ serverId: "0", promptCount: 1, errorKey: null }],
      });
      await Promise.resolve();
    });

    const stateUpdateWarn = consoleError.mock.calls
      .map((c) => c.join(" "))
      .find((s) => /unmounted|can't perform/i.test(s));
    expect(stateUpdateWarn).toBeFalsy();
    consoleError.mockRestore();
  });

  it("treats empty mcpServers as no prompts (R10 silent fallback)", async () => {
    // discoverPrompts is called with [] — its real impl returns the
    // empty envelope synchronously. The mock honors the same contract
    // because the default beforeEach resolves with the empty envelope.
    const { container } = await renderChatbox({ mcpServers: [] });
    const textarea = container.querySelector("textarea");
    // Plan 2026-05-19-001 — the slash hint persists even with no MCP
    // prompts because <Chatbox> always injects the built-in `/clear`
    // client command. The R10 silent-fallback contract still holds for
    // the prompts list itself (no error panel below).
    expect(textarea.placeholder).toMatch(/\/ for templates/);
  });

  it("keeps prompts empty when discoverPrompts rejects (R10 silent fallback)", async () => {
    discoverPrompts.mockRejectedValueOnce(new Error("network blew up"));
    const { container } = await renderChatbox({ mcpServers: [SERVER_A] });
    // Allow the rejection-handler microtask to flush.
    await act(async () => { await Promise.resolve(); });

    const textarea = container.querySelector("textarea");
    // Plan 2026-05-19-001 — hint still present via built-in `/clear`.
    expect(textarea.placeholder).toMatch(/\/ for templates/);
    // The error panel must NOT render — discoverPrompts failures are
    // silent per R10.
    const alert = container.querySelector('[role="alert"]');
    expect(alert).toBeFalsy();
  });
});

describe("Chatbox prompts selection — R7 happy path + R11 error placement", () => {
  // Helper: render chatbox with one prompt available, then simulate
  // typing `/` and pressing Enter to trigger onPromptSelected.
  async function renderAndSelectFirstPrompt(props = {}) {
    discoverPrompts.mockResolvedValueOnce({
      promptsByServer: { 0: [PROMPT_FOO] },
      promptServerMap: new Map([["plot_timeseries", 0]]),
      perServer: [{ serverId: "0", promptCount: 1, errorKey: null }],
    });
    const result = await renderChatbox({
      mcpServers: [SERVER_A],
      ...props,
    });
    const textarea = result.container.querySelector("textarea");
    await act(async () => {
      textarea.focus();
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      ).set;
      setter.call(textarea, "/");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Press Enter to select highlighted (first) row.
    await act(async () => {
      const enterEvent = new window.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      });
      textarea.dispatchEvent(enterEvent);
      // Allow any awaited getPrompt resolution to flush.
      await Promise.resolve();
      await Promise.resolve();
    });
    return { ...result, textarea };
  }

  it("calls getPrompt with empty args for prompts that have no required args", async () => {
    getPrompt.mockResolvedValueOnce(
      "Retrieve a line chart for variable [variable]",
    );
    const { textarea } = await renderAndSelectFirstPrompt();

    // PROMPT_FOO has no `arguments` field, so synth args is `{}`. Servers
    // whose prompts use server-side defaults (or have no args at all)
    // still get the empty-args call.
    expect(getPrompt).toHaveBeenCalledWith(
      0,
      "plot_timeseries",
      {},
      expect.any(Array),
    );
    expect(textarea.value).toMatch(/Retrieve a line chart for variable \[variable\]/);
  });

  it("synthesizes [description] brackets for each required arg (NRDS shape)", async () => {
    discoverPrompts.mockResolvedValueOnce({
      promptsByServer: { 0: [PROMPT_PLOT_NRDS] },
      promptServerMap: new Map([["plot_timeseries", 0]]),
      perServer: [{ serverId: "0", promptCount: 1, errorKey: null }],
    });
    getPrompt.mockResolvedValueOnce(
      "On the [cfe_nom / lstm / routing_only] model for date [yyyy-mm-dd]",
    );

    const { container } = await renderChatbox({ mcpServers: [SERVER_A] });
    const textarea = container.querySelector("textarea");

    await act(async () => {
      textarea.focus();
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      ).set;
      setter.call(textarea, "/");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Enter", bubbles: true, cancelable: true,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    // Synth produced `[<description>]` brackets per required arg.
    expect(getPrompt).toHaveBeenCalledWith(
      0,
      "plot_timeseries",
      {
        model: "[cfe_nom / lstm / routing_only]",
        date: "[yyyy-mm-dd]",
      },
      expect.any(Array),
    );
    // The rendered text (mocked) is the result; assert input was filled.
    expect(textarea.value).toMatch(/cfe_nom \/ lstm \/ routing_only/);
    expect(textarea.value).toMatch(/yyyy-mm-dd/);
  });

  it("strips FastMCP's auto-appended JSON-schema note from description before bracketing", async () => {
    discoverPrompts.mockResolvedValueOnce({
      promptsByServer: { 0: [PROMPT_PLOT_NRDS_FASTMCP] },
      promptServerMap: new Map([["plot_timeseries", 0]]),
      perServer: [{ serverId: "0", promptCount: 1, errorKey: null }],
    });
    getPrompt.mockResolvedValueOnce("rendered ok");

    const { container } = await renderChatbox({ mcpServers: [SERVER_A] });
    const textarea = container.querySelector("textarea");

    await act(async () => {
      textarea.focus();
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      ).set;
      setter.call(textarea, "/");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Enter", bubbles: true, cancelable: true,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    // Synth bracket is `[yyyy-mm-dd]`, NOT the polluted full description.
    expect(getPrompt).toHaveBeenCalledWith(
      0,
      "plot_timeseries",
      { date: "[yyyy-mm-dd]" },
      expect.any(Array),
    );
  });

  it("handles subway-style prompts (required args with rich descriptions)", async () => {
    discoverPrompts.mockResolvedValueOnce({
      promptsByServer: { 0: [PROMPT_PLAN_TRIP] },
      promptServerMap: new Map([["plan-trip", 0]]),
      perServer: [{ serverId: "0", promptCount: 1, errorKey: null }],
    });
    getPrompt.mockResolvedValueOnce(
      'I need to get from [Starting station name (e.g. "Times Square")] to [Destination station name (e.g. "Fulton St")] on the NYC subway.',
    );

    const { container } = await renderChatbox({ mcpServers: [SERVER_A] });
    const textarea = container.querySelector("textarea");

    await act(async () => {
      textarea.focus();
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      ).set;
      setter.call(textarea, "/");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Enter", bubbles: true, cancelable: true,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getPrompt).toHaveBeenCalledWith(
      0,
      "plan-trip",
      {
        from: '[Starting station name (e.g. "Times Square")]',
        to: '[Destination station name (e.g. "Fulton St")]',
      },
      expect.any(Array),
    );
    expect(textarea.value).toMatch(/Times Square/);
    expect(textarea.value).toMatch(/Fulton St/);
  });

  it("does NOT synthesize args for required: false (preserves server-side defaults)", async () => {
    discoverPrompts.mockResolvedValueOnce({
      promptsByServer: { 0: [PROMPT_MIXED] },
      promptServerMap: new Map([["mixed", 0]]),
      perServer: [{ serverId: "0", promptCount: 1, errorKey: null }],
    });
    getPrompt.mockResolvedValueOnce("ok");

    const { container } = await renderChatbox({ mcpServers: [SERVER_A] });
    const textarea = container.querySelector("textarea");

    await act(async () => {
      textarea.focus();
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      ).set;
      setter.call(textarea, "/");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Enter", bubbles: true, cancelable: true,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    // Only `needed` (required: true) is synthesized; `skip_me` is omitted
    // so the server's own default applies.
    expect(getPrompt).toHaveBeenCalledWith(
      0,
      "mixed",
      { needed: "[must supply]" },
      expect.any(Array),
    );
  });

  it("falls back to bare arg name when required arg has no description", async () => {
    discoverPrompts.mockResolvedValueOnce({
      promptsByServer: { 0: [PROMPT_NO_DESC] },
      promptServerMap: new Map([["no-desc", 0]]),
      perServer: [{ serverId: "0", promptCount: 1, errorKey: null }],
    });
    getPrompt.mockResolvedValueOnce("ok");

    const { container } = await renderChatbox({ mcpServers: [SERVER_A] });
    const textarea = container.querySelector("textarea");

    await act(async () => {
      textarea.focus();
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      ).set;
      setter.call(textarea, "/");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Enter", bubbles: true, cancelable: true,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getPrompt).toHaveBeenCalledWith(
      0,
      "no-desc",
      { anon: "[anon]" },
      expect.any(Array),
    );
  });

  it("survives malformed arguments (non-array): synth = {} and getPrompt is called with empty args", async () => {
    // Defensive guard for spec-violating servers that ship something
    // other than an array for `arguments`. The synth must not throw
    // on the for-of and must degrade gracefully to empty-args call.
    const PROMPT_BAD_ARGS = {
      name: "bad-args",
      description: "Spec-violating shape",
      arguments: { not: "an array" }, // malformed
    };
    discoverPrompts.mockResolvedValueOnce({
      promptsByServer: { 0: [PROMPT_BAD_ARGS] },
      promptServerMap: new Map([["bad-args", 0]]),
      perServer: [{ serverId: "0", promptCount: 1, errorKey: null }],
    });
    getPrompt.mockResolvedValueOnce("ok despite bad args");

    const { container } = await renderChatbox({ mcpServers: [SERVER_A] });
    const textarea = container.querySelector("textarea");

    await act(async () => {
      textarea.focus();
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      ).set;
      setter.call(textarea, "/");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Enter", bubbles: true, cancelable: true,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getPrompt).toHaveBeenCalledWith(
      0,
      "bad-args",
      {},
      expect.any(Array),
    );
    expect(textarea.value).toMatch(/ok despite bad args/);
  });

  it("skips required args missing a usable name (no `undefined` key in synthArgs)", async () => {
    // Defensive guard for spec-violating servers whose argument
    // entries omit the `name` field (or set it to a non-string). A
    // naive synth would write synthArgs[undefined] = "[undefined]"
    // and the server would reject that key. Skip such entries
    // entirely; well-formed entries in the same arguments list are
    // still synthesized.
    const PROMPT_PARTIAL = {
      name: "partial",
      description: "One arg has no name",
      arguments: [
        { name: "good", description: "good hint", required: true },
        { description: "anonymous required arg", required: true }, // no name
        { name: "", description: "empty name", required: true }, // empty name
      ],
    };
    discoverPrompts.mockResolvedValueOnce({
      promptsByServer: { 0: [PROMPT_PARTIAL] },
      promptServerMap: new Map([["partial", 0]]),
      perServer: [{ serverId: "0", promptCount: 1, errorKey: null }],
    });
    getPrompt.mockResolvedValueOnce("rendered");

    const { container } = await renderChatbox({ mcpServers: [SERVER_A] });
    const textarea = container.querySelector("textarea");

    await act(async () => {
      textarea.focus();
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      ).set;
      setter.call(textarea, "/");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Enter", bubbles: true, cancelable: true,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    // Only the well-formed `good` arg is synthesized; the unnamed and
    // empty-name entries are skipped. No `undefined` or empty-string
    // key appears in synthArgs.
    expect(getPrompt).toHaveBeenCalledWith(
      0,
      "partial",
      { good: "[good hint]" },
      expect.any(Array),
    );
    const callArgs = getPrompt.mock.calls[0][2];
    // toEqual(["good"]) already proves no other keys are present, but
    // make the intent explicit for the reader: no `undefined` or
    // empty-string key snuck in from the malformed entries.
    expect(Object.keys(callArgs)).toEqual(["good"]);
    expect(Object.keys(callArgs)).not.toContain("undefined");
    expect(Object.keys(callArgs)).not.toContain("");
  });

  it("clears any prior error state on successful insertion", async () => {
    // Prime an error first by stubbing getPrompt to reject, then a
    // second selection succeeds and clears the panel.
    discoverPrompts.mockResolvedValueOnce({
      promptsByServer: { 0: [PROMPT_FOO] },
      promptServerMap: new Map([["plot_timeseries", 0]]),
      perServer: [{ serverId: "0", promptCount: 1, errorKey: null }],
    });
    getPrompt
      .mockRejectedValueOnce(new Error("server down"))
      .mockResolvedValueOnce("Recovered template text");

    const { container } = await renderChatbox({ mcpServers: [SERVER_A] });
    const textarea = container.querySelector("textarea");

    // First selection — fails, error appears.
    await act(async () => {
      textarea.focus();
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      ).set;
      setter.call(textarea, "/");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Enter", bubbles: true, cancelable: true,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    let alert = container.querySelector('[role="alert"]');
    expect(alert).toBeTruthy();
    expect(alert.textContent).toMatch(/Couldn't load template/);

    // Second selection — succeeds, error cleared. The reject path
    // sticky-marked the empty trigger token, so re-typing `/` alone
    // wouldn't reopen the popover. Clear the input first (drops the
    // dismissal marker), then re-type to reopen.
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    ).set;
    await act(async () => {
      setter.call(textarea, "");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      setter.call(textarea, "/");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Enter", bubbles: true, cancelable: true,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    alert = container.querySelector('[role="alert"]');
    expect(alert).toBeFalsy();
    expect(textarea.value).toMatch(/Recovered template text/);
  });

  it("R11: getPrompt rejection sets error and renders ChatErrorPanel above input in welcome branch", async () => {
    discoverPrompts.mockResolvedValueOnce({
      promptsByServer: { 0: [PROMPT_FOO] },
      promptServerMap: new Map([["plot_timeseries", 0]]),
      perServer: [{ serverId: "0", promptCount: 1, errorKey: null }],
    });
    getPrompt.mockRejectedValueOnce(new Error("kaboom"));

    const { container } = await renderChatbox({ mcpServers: [SERVER_A] });
    const textarea = container.querySelector("textarea");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      ).set;
      setter.call(textarea, "/");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Enter", bubbles: true, cancelable: true,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    // Error panel renders in the welcome branch above the input bar.
    const alert = container.querySelector('[role="alert"]');
    expect(alert).toBeTruthy();
    expect(alert.textContent).toMatch(/Couldn't load template/);
    // R11: the alert must precede the textarea in DOM order.
    const alertPos = alert.compareDocumentPosition(textarea);
    // FOLLOWING bit set means textarea follows alert.
    expect(alertPos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("R11: console.error logs the underlying error object on getPrompt failure", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    discoverPrompts.mockResolvedValueOnce({
      promptsByServer: { 0: [PROMPT_FOO] },
      promptServerMap: new Map([["plot_timeseries", 0]]),
      perServer: [{ serverId: "0", promptCount: 1, errorKey: null }],
    });
    const underlying = new Error("transport refused");
    getPrompt.mockRejectedValueOnce(underlying);

    const { container } = await renderChatbox({ mcpServers: [SERVER_A] });
    const textarea = container.querySelector("textarea");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      ).set;
      setter.call(textarea, "/");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Enter", bubbles: true, cancelable: true,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const matched = consoleError.mock.calls.find((args) =>
      args.some((a) => a === underlying),
    );
    expect(matched, "expected console.error to be called with the underlying error object").toBeTruthy();
    consoleError.mockRestore();
  });

  it("R11: error renders above input in has-messages branch as well", async () => {
    discoverPrompts.mockResolvedValueOnce({
      promptsByServer: { 0: [PROMPT_FOO] },
      promptServerMap: new Map([["plot_timeseries", 0]]),
      perServer: [{ serverId: "0", promptCount: 1, errorKey: null }],
    });
    getPrompt.mockRejectedValueOnce(new Error("failed"));

    // Pre-seed messages so the chatbox uses the has-messages branch.
    const { container } = await renderChatbox({
      mcpServers: [SERVER_A],
      initialMessages: [
        { role: "user", content: "first message" },
        { role: "assistant", content: "first reply" },
      ],
    });
    const textarea = container.querySelector("textarea");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      ).set;
      setter.call(textarea, "/");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Enter", bubbles: true, cancelable: true,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert).toBeTruthy();
    // R11: alert appears above the textarea (DOM order).
    const alertPos = alert.compareDocumentPosition(textarea);
    expect(alertPos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("Chatbox prompts — singular-prompt collision", () => {
  it("template's setInput is NOT overwritten by a re-run of the singular-prompt seed effect", async () => {
    discoverPrompts.mockResolvedValueOnce({
      promptsByServer: { 0: [PROMPT_FOO] },
      promptServerMap: new Map([["plot_timeseries", 0]]),
      perServer: [{ serverId: "0", promptCount: 1, errorKey: null }],
    });
    getPrompt.mockResolvedValueOnce("TEMPLATE TEXT [arg]");

    // Mount with singular prompt="hello".
    const { root, container } = await renderChatbox({
      mcpServers: [SERVER_A],
      prompt: "hello",
    });
    const textarea = container.querySelector("textarea");
    expect(textarea.value).toBe("hello");

    // Trigger slash flow and select the prompt — input becomes the
    // template text.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      ).set;
      setter.call(textarea, "/");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Enter", bubbles: true, cancelable: true,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(textarea.value).toMatch(/TEMPLATE TEXT/);

    // Now host re-renders with a NEW singular prompt — within the 500ms
    // debounce window, the seed effect must NOT overwrite the template.
    await rerenderChatbox(root, {
      mcpServers: [SERVER_A],
      prompt: "different host prompt",
    });
    await act(async () => { await Promise.resolve(); });

    expect(textarea.value).toMatch(/TEMPLATE TEXT/);
    expect(textarea.value).not.toBe("different host prompt");
  });
});

describe("Chatbox prompts — full integration flow", () => {
  it("type / → popover opens with one prompt → Enter → input replaced with rendered text", async () => {
    discoverPrompts.mockResolvedValueOnce({
      promptsByServer: { 0: [PROMPT_FOO] },
      promptServerMap: new Map([["plot_timeseries", 0]]),
      perServer: [{ serverId: "0", promptCount: 1, errorKey: null }],
    });
    getPrompt.mockResolvedValueOnce("RENDERED PROMPT BODY");

    const { container } = await renderChatbox({ mcpServers: [SERVER_A] });
    const textarea = container.querySelector("textarea");

    // Type `/` — popover opens.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      ).set;
      setter.call(textarea, "/");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Listbox surfaces somewhere in the DOM (portal or inline).
    const listbox = document.querySelector('[role="listbox"]');
    expect(listbox, "expected popover listbox after typing /").toBeTruthy();
    expect(listbox.textContent).toMatch(/plot_timeseries/);

    // Enter → selection.
    await act(async () => {
      textarea.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Enter", bubbles: true, cancelable: true,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getPrompt).toHaveBeenCalled();
    expect(textarea.value).toMatch(/RENDERED PROMPT BODY/);
  });
});
