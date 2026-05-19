// @vitest-environment jsdom
/**
 * components/Chatbox.clear.test.jsx — coverage for Plan 2026-05-19-001:
 * `/clear` slash command + `clientCommands` extension point + `onClear`
 * callback.
 *
 * Scope: behaviors that the Chatbox wrapper orchestrates (built-in
 * `/clear` injection, `clearConversation` invocation, `onClear` callback
 * lifecycle, host override). Lower-level slash popover + intercept
 * behavior is covered in `ChatInputBar.slash.test.jsx`.
 *
 * Mocks the engine helpers (`discoverPrompts`, `getPrompt`) so the tests
 * don't need a live MCP server, and mocks `clearConversation` so cache
 * invocations are observable without touching real IndexedDB. Mirrors
 * `Chatbox.prompts.test.jsx` setup conventions: jsdom env, lazy import
 * of Chatbox after vi.mock, createRoot + act render, mount/unmount
 * tracking via the `mounted` array.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

vi.mock("../helpers/index.js", async () => {
  const actual = await vi.importActual("../helpers/index.js");
  return {
    ...actual,
    listModels: vi.fn(),
  };
});

vi.mock("../engine/index.js", async () => {
  const actual = await vi.importActual("../engine/index.js");
  return {
    ...actual,
    discoverPrompts: vi.fn(),
    getPrompt: vi.fn(),
  };
});

vi.mock("../engine/cache.js", async () => {
  const actual = await vi.importActual("../engine/cache.js");
  return {
    ...actual,
    clearConversation: vi.fn(() => Promise.resolve()),
  };
});

import { listModels } from "../helpers/index.js";
import { discoverPrompts } from "../engine/index.js";
import { clearConversation } from "../engine/cache.js";

const mounted = [];

function emptyDiscoverEnvelope() {
  return {
    promptsByServer: {},
    promptServerMap: new Map(),
    perServer: [],
  };
}

beforeEach(() => {
  listModels.mockResolvedValue([{ name: "test-model", contextLength: 8192 }]);
  discoverPrompts.mockResolvedValue(emptyDiscoverEnvelope());
  clearConversation.mockResolvedValue(undefined);
  globalThis.localStorage?.clear?.();
});

afterEach(() => {
  while (mounted.length) {
    const { root, container } = mounted.pop();
    act(() => root.unmount());
    container.remove();
  }
  vi.clearAllMocks();
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

// Drive the input → Enter sequence on the textarea — mirrors
// renderAndSelectFirstPrompt from Chatbox.prompts.test.jsx so /clear
// goes through the same submit-handler pipeline a real user would hit.
async function typeAndEnter(textarea, value) {
  await act(async () => {
    textarea.focus();
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    ).set;
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    textarea.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    // Flush microtasks for awaited clearConversation + onClear.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Chatbox /clear — built-in client command", () => {
  it("injects the built-in `/clear` even when no `clientCommands` prop is provided", async () => {
    const { container } = await renderChatbox({});
    const textarea = container.querySelector("textarea");
    // Built-in /clear means the slash hint is always present.
    expect(textarea.placeholder).toMatch(/\/ for templates/);
    // Open the popover by typing `/c` — `/clear` should be the only filtered item.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      ).set;
      setter.call(textarea, "/c");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const rows = document.body.querySelectorAll('[role="option"]');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toMatch(/\/clear/);
  });

  it("typing `/clear` + Enter invokes `clearConversation(conversationId)` exactly once", async () => {
    const { container } = await renderChatbox({
      enableResultCache: true,
      conversationId: "dashboard-xyz",
    });
    const textarea = container.querySelector("textarea");
    await typeAndEnter(textarea, "/clear");
    expect(clearConversation).toHaveBeenCalledTimes(1);
    expect(clearConversation).toHaveBeenCalledWith("dashboard-xyz");
  });

  it("falls back to 'default' conversationId when none is provided", async () => {
    const { container } = await renderChatbox({});
    const textarea = container.querySelector("textarea");
    await typeAndEnter(textarea, "/clear");
    expect(clearConversation).toHaveBeenCalledWith("default");
  });

  it("fires the host's `onClear` callback after the engine wipe completes", async () => {
    const callOrder = [];
    clearConversation.mockImplementation(async () => {
      callOrder.push("clearConversation");
    });
    const onClear = vi.fn(async () => {
      callOrder.push("onClear");
    });
    const { container } = await renderChatbox({
      conversationId: "abc",
      onClear,
    });
    const textarea = container.querySelector("textarea");
    await typeAndEnter(textarea, "/clear");
    expect(onClear).toHaveBeenCalledTimes(1);
    // clearConversation runs BEFORE onClear (engine state cleared before
    // the host wipes its own persistence).
    expect(callOrder).toEqual(["clearConversation", "onClear"]);
  });

  it("survives when `onClear` is not provided (engine still clears)", async () => {
    const { container } = await renderChatbox({ conversationId: "abc" });
    const textarea = container.querySelector("textarea");
    await typeAndEnter(textarea, "/clear");
    // No throw, clearConversation still ran.
    expect(clearConversation).toHaveBeenCalledTimes(1);
  });

  it("does not roll back engine state when `onClear` throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const onClear = vi.fn(() => {
      throw new Error("host persistence wipe failed");
    });
    const { container } = await renderChatbox({
      conversationId: "abc",
      onClear,
    });
    const textarea = container.querySelector("textarea");
    await typeAndEnter(textarea, "/clear");
    // clearConversation ran first; onClear threw; the throw was caught
    // and surfaced to console.error but did not block the rest.
    expect(clearConversation).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledTimes(1);
    const errCall = consoleError.mock.calls.find((args) =>
      args.some(
        (a) => typeof a === "string" && a.includes("onClear callback threw"),
      ),
    );
    expect(errCall).toBeTruthy();
    consoleError.mockRestore();
  });

  it("non-fatal `clearConversation` rejection still fires `onClear`", async () => {
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    clearConversation.mockRejectedValueOnce(new Error("IndexedDB blew up"));
    const onClear = vi.fn();
    const { container } = await renderChatbox({
      conversationId: "abc",
      onClear,
    });
    const textarea = container.querySelector("textarea");
    await typeAndEnter(textarea, "/clear");
    expect(onClear).toHaveBeenCalledTimes(1);
    // Best-effort cache clear logs at info level.
    const infoCall = consoleInfo.mock.calls.find((args) =>
      args.some(
        (a) =>
          typeof a === "string" && a.includes("clearConversation error"),
      ),
    );
    expect(infoCall).toBeTruthy();
    consoleInfo.mockRestore();
  });
});

describe("Chatbox /clear — host override + merge precedence", () => {
  it("host `clientCommands` entry named `/clear` overrides the built-in", async () => {
    const hostExecute = vi.fn();
    const onClear = vi.fn();
    const { container } = await renderChatbox({
      clientCommands: [
        {
          name: "/clear",
          description: "Host's own clear",
          execute: hostExecute,
        },
      ],
      conversationId: "abc",
      onClear,
    });
    const textarea = container.querySelector("textarea");
    await typeAndEnter(textarea, "/clear");
    // Host's execute fires; the built-in's clearConversation+onClear path is NOT taken.
    expect(hostExecute).toHaveBeenCalledTimes(1);
    expect(clearConversation).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
  });

  it("host-added non-`/clear` commands coexist with the built-in `/clear`", async () => {
    const fooExecute = vi.fn();
    const { container } = await renderChatbox({
      clientCommands: [
        { name: "/foo", description: "Host foo", execute: fooExecute },
      ],
    });
    const textarea = container.querySelector("textarea");
    // Open popover with just `/` → expect both `/foo` and the built-in `/clear`.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      ).set;
      setter.call(textarea, "/");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const rows = Array.from(document.body.querySelectorAll('[role="option"]'));
    const names = rows.map((r) => r.textContent);
    expect(names.some((n) => n.includes("/foo"))).toBe(true);
    expect(names.some((n) => n.includes("/clear"))).toBe(true);
  });
});
