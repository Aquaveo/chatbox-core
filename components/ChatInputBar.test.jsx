// @vitest-environment jsdom
/**
 * components/ChatInputBar.test.jsx — guards the textarea auto-resize
 * cap. Without a max, a long prompt grows the textarea unbounded,
 * pushes the toolbar (send button + provider/MCP/Thinking pills) below
 * the chatbox Shell's overflow:hidden boundary, and clips them out of
 * view. The visible contract: the JS effect must clamp the inline
 * height to TEXTAREA_MAX_PX, regardless of how tall scrollHeight grows.
 *
 * Stubs scrollHeight directly because JSDOM has no layout engine —
 * native scrollHeight is always 0 there, so the only way to exercise
 * the cap branch is to override the getter on the element.
 */

import { afterEach, describe, expect, it } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "styled-components";

import chatTheme from "../theme/index.js";
import ChatInputBar, { TEXTAREA_MAX_PX } from "./ChatInputBar.jsx";

const mounted = [];
afterEach(() => {
  while (mounted.length) {
    const { root, container } = mounted.pop();
    act(() => root.unmount());
    container.remove();
  }
});

const noop = () => {};
const baseProps = {
  input: "",
  setInput: noop,
  onSend: noop,
  onStop: noop,
  loading: false,
  loadingModels: false,
  selectedModel: "test-model",
  onModelChange: noop,
  availableModels: [{ name: "test-model" }],
  isThinkingEnabled: false,
  onThinkingToggle: noop,
  contextUsage: { used: 0, total: 8192 },
  providerConfig: { provider: "ollama" },
};

function render(ui) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<ThemeProvider theme={chatTheme}>{ui}</ThemeProvider>);
  });
  mounted.push({ root, container });
  return {
    container,
    rerender(next) {
      act(() => {
        root.render(<ThemeProvider theme={chatTheme}>{next}</ThemeProvider>);
      });
    },
  };
}

function stubScrollHeight(el, value) {
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => value,
  });
}

describe("ChatInputBar textarea auto-resize", () => {
  it("exports a positive TEXTAREA_MAX_PX cap", () => {
    expect(typeof TEXTAREA_MAX_PX).toBe("number");
    expect(TEXTAREA_MAX_PX).toBeGreaterThan(44); // larger than min-height
  });

  it("clamps inline height to TEXTAREA_MAX_PX when scrollHeight exceeds it", () => {
    const { container, rerender } = render(<ChatInputBar {...baseProps} />);
    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();

    // Simulate a very long prompt's natural content height.
    stubScrollHeight(textarea, 9999);
    rerender(<ChatInputBar {...baseProps} input={"line\n".repeat(200)} />);

    expect(textarea.style.height).toBe(`${TEXTAREA_MAX_PX}px`);
  });

  it("uses scrollHeight directly when it is below the cap", () => {
    const { container, rerender } = render(<ChatInputBar {...baseProps} />);
    const textarea = container.querySelector("textarea");

    stubScrollHeight(textarea, 100);
    rerender(<ChatInputBar {...baseProps} input="just a short line or two" />);

    expect(textarea.style.height).toBe("100px");
  });
});
