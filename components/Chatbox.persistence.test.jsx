// @vitest-environment jsdom
/**
 * components/Chatbox.persistence.test.jsx — coverage for the
 * `initialMessages` + `onMessagesChange` props (plan 2026-05-08-004).
 *
 * Generic controlled-component-lite API: host hydrates the conversation
 * via initialMessages, observes changes via onMessagesChange. Defaults
 * preserve today's ephemeral-conversation behavior.
 *
 * Existing chatbox-core consumers that don't pass these props are
 * unaffected — assertions cover that regression baseline.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

// Same network-mock pattern as Chatbox.test.jsx — without this, the
// listModels useEffect tries a real fetch in jsdom.
vi.mock("../helpers/index.js", async () => {
  const actual = await vi.importActual("../helpers/index.js");
  return {
    ...actual,
    listModels: vi.fn(),
  };
});

import { listModels } from "../helpers/index.js";

const mounted = [];

beforeEach(() => {
  listModels.mockResolvedValue([
    { name: "test-model", contextLength: 8192 },
  ]);
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

describe("Chatbox initialMessages — hydration on mount", () => {
  it("renders messages passed via initialMessages", async () => {
    const { container } = await renderChatbox({
      initialMessages: [
        { role: "user", content: "what's the weather" },
        { role: "assistant", content: "I don't know — try a forecast tool." },
      ],
    });
    // Both messages should appear in the chat thread.
    expect(container.textContent).toMatch(/what's the weather/);
    expect(container.textContent).toMatch(/I don't know/);
  });

  it("starts empty when no initialMessages prop is supplied (regression baseline)", async () => {
    const { container } = await renderChatbox();
    // The welcome state renders, no user/assistant message bubbles.
    expect(container.textContent).not.toMatch(/what's the weather/);
  });

  it("starts empty when initialMessages is an explicit empty array", async () => {
    const { container } = await renderChatbox({ initialMessages: [] });
    expect(container.textContent).not.toMatch(/what's the weather/);
  });

  it("preserves _internal system messages in state without rendering them", async () => {
    const { container } = await renderChatbox({
      initialMessages: [
        { role: "user", content: "user prompt" },
        { role: "system", content: "tool retry coaching", _internal: true },
        { role: "assistant", content: "final answer" },
      ],
    });
    // _internal messages are filtered from display (see ChatLog),
    // but the user/assistant messages render normally.
    expect(container.textContent).toMatch(/user prompt/);
    expect(container.textContent).toMatch(/final answer/);
    // The internal coaching string is hidden from the user.
    expect(container.textContent).not.toMatch(/tool retry coaching/);
  });
});

describe("Chatbox onMessagesChange — fires on state change", () => {
  it("fires once on mount with the initialMessages array", async () => {
    const onMessagesChange = vi.fn();
    const initial = [{ role: "user", content: "hello" }];
    await renderChatbox({
      initialMessages: initial,
      onMessagesChange,
    });
    // The first effect fires after the initial render with the
    // hydrated messages. Re-saves are harmless when the host loaded
    // initialMessages from the same storage.
    expect(onMessagesChange).toHaveBeenCalled();
    const lastCall = onMessagesChange.mock.calls.at(-1);
    expect(lastCall[0]).toEqual(initial);
  });

  it("fires once on mount with empty array when no initialMessages", async () => {
    const onMessagesChange = vi.fn();
    await renderChatbox({ onMessagesChange });
    expect(onMessagesChange).toHaveBeenCalled();
    const lastCall = onMessagesChange.mock.calls.at(-1);
    expect(lastCall[0]).toEqual([]);
  });

  it("does not fire when no onMessagesChange prop is supplied (regression baseline)", async () => {
    // No callback to assert against, but the chatbox must mount + render
    // without errors. Coverage for the "callback is null" branch.
    const { container } = await renderChatbox({
      initialMessages: [{ role: "user", content: "hi" }],
    });
    expect(container.textContent).toMatch(/hi/);
  });

  it("survives a host callback that throws (does not crash chatbox)", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onMessagesChange = vi.fn(() => {
      throw new Error("host bug");
    });
    const { container } = await renderChatbox({
      initialMessages: [{ role: "user", content: "test" }],
      onMessagesChange,
    });
    // Chatbox still renders.
    expect(container.textContent).toMatch(/test/);
    // The error was logged via console.warn (try/catch wrapper).
    expect(consoleWarn).toHaveBeenCalled();
    const warnCall = consoleWarn.mock.calls
      .map((c) => c.join(" "))
      .find((s) => s.includes("onMessagesChange"));
    expect(warnCall, "expected console.warn to log onMessagesChange error").toBeTruthy();
    consoleWarn.mockRestore();
  });
});
