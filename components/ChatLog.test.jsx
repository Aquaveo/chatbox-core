// @vitest-environment jsdom
/**
 * components/ChatLog.test.jsx — covers behavior introduced by the UI
 * polish pass:
 *
 * 1. The streaming <ThinkingDropdown> opens by default but respects a
 *    user click-to-collapse mid-stream (controlled toggle, reset on
 *    loading→false turn boundary).
 * 2. The LiveActivity ElapsedSuffix is hidden below 3s and renders the
 *    seconds count once at/above the threshold.
 *
 * Uses a tiny act+createRoot render helper to avoid pulling in
 * @testing-library/react as a dev dep — the chatbox-core surface is a
 * published library and we keep the dep tree minimal.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "styled-components";

import chatTheme from "../theme/index.js";
import ChatLog from "./ChatLog.jsx";

const mounted = [];
afterEach(() => {
  while (mounted.length) {
    const { root, container } = mounted.pop();
    act(() => root.unmount());
    container.remove();
  }
  vi.useRealTimers();
});

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

const baseProps = {
  messages: [],
  isEmbedded: false,
  loading: true,
  isThinkingEnabled: true,
  thinkingBuffer: "reasoning step one",
  contentBuffer: "",
  toolStatus: null,
  MessageRenderer: undefined,
};

describe("ChatLog streaming ThinkingDropdown", () => {
  it("renders open by default while streaming with thinking enabled", () => {
    const { container } = render(<ChatLog {...baseProps} />);
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details.open).toBe(true);
  });

  it("respects user collapse mid-stream and does not re-open on chunk re-render", () => {
    const { container, rerender } = render(<ChatLog {...baseProps} />);
    const details = container.querySelector("details");
    expect(details.open).toBe(true);

    // Simulate user clicking the summary to collapse. <details> toggles
    // its `open` attribute on click, then fires the 'toggle' event —
    // which is what our onToggle handler captures.
    act(() => {
      details.open = false;
      details.dispatchEvent(new Event("toggle"));
    });
    expect(details.open).toBe(false);

    // Next streaming chunk arrives — re-render with a longer buffer.
    // The dropdown must stay closed because userCollapsed is now true.
    rerender(<ChatLog {...baseProps} thinkingBuffer="reasoning step one\nstep two" />);
    expect(details.open).toBe(false);
  });

  it("re-opens on the next turn (loading transitions to false then true)", () => {
    const { container, rerender } = render(<ChatLog {...baseProps} />);
    const details = container.querySelector("details");

    // User collapses mid-stream.
    act(() => {
      details.open = false;
      details.dispatchEvent(new Event("toggle"));
    });
    expect(details.open).toBe(false);

    // Turn ends — loading goes false, thinking buffer clears.
    rerender(<ChatLog {...baseProps} loading={false} thinkingBuffer="" />);

    // Next turn starts — loading true again, fresh thinking buffer.
    rerender(<ChatLog {...baseProps} thinkingBuffer="new turn reasoning" />);
    const nextDetails = mounted[0].container.querySelector("details");
    expect(nextDetails.open).toBe(true);
  });
});

describe("ChatLog LiveActivity ElapsedSuffix", () => {
  it("hides the elapsed suffix below 3 seconds", () => {
    vi.useFakeTimers();
    const { container } = render(<ChatLog {...baseProps} />);
    // Elapsed starts at 0; ElapsedSuffix is unmounted.
    expect(container.textContent).not.toMatch(/\d+s/);
  });

  it("renders the elapsed suffix at and above 3 seconds", () => {
    vi.useFakeTimers();
    const { container } = render(<ChatLog {...baseProps} />);

    // Advance the timer past the 3-second threshold. The setInterval in
    // useElapsedSeconds fires on each second, and React schedules a
    // state update each tick — wrap the timer advance in act so the
    // updates flush before we assert.
    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(container.textContent).toMatch(/3s/);
  });
});

describe("ChatLog LiveActivity per-tool status (plan 2026-05-08-003)", () => {
  it("renders 'Thinking' as the default label when toolStatus is null", () => {
    const { container } = render(<ChatLog {...baseProps} thinkingBuffer="" />);
    expect(container.textContent).toMatch(/Thinking/);
  });

  it("renders the tool start friendly text on tool_start", () => {
    const { container } = render(
      <ChatLog
        {...baseProps}
        thinkingBuffer=""
        toolStatus={{ type: "tool_start", toolName: "create_map_visualization" }}
      />,
    );
    expect(container.textContent).toMatch(/Creating map\.\.\./);
  });

  it("renders the tool complete friendly text on tool_complete success", () => {
    const { container } = render(
      <ChatLog
        {...baseProps}
        thinkingBuffer=""
        toolStatus={{ type: "tool_complete", toolName: "create_map_visualization", success: true }}
      />,
    );
    expect(container.textContent).toMatch(/Map created/);
  });

  it("renders 'Failed: ...' on tool_complete success: false", () => {
    const { container } = render(
      <ChatLog
        {...baseProps}
        thinkingBuffer=""
        toolStatus={{ type: "tool_complete", toolName: "create_plotly_chart", success: false }}
      />,
    );
    expect(container.textContent).toMatch(/Failed: creating chart/);
  });

  it("reverts to the default label after the grace window expires", () => {
    vi.useFakeTimers();
    // Hold a stable reference for toolStatus — in production, setToolStatus
    // only fires when a NEW event arrives, so the prop doesn't change
    // identity until a new event lands. New-object-per-rerender would
    // re-run the effect and re-schedule the grace timer indefinitely.
    const stableStatus = {
      type: "tool_complete",
      toolName: "create_map_visualization",
      success: true,
    };
    const { container } = render(
      <ChatLog {...baseProps} thinkingBuffer="" toolStatus={stableStatus} />,
    );
    expect(container.textContent).toMatch(/Map created/);

    // Advance past the grace window — timer fires, setStickyLabel(null)
    // schedules a re-render with sticky cleared. Falls back to "Thinking".
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(container.textContent).toMatch(/Thinking/);
    expect(container.textContent).not.toMatch(/Map created/);
  });

  it("most-recent-event wins: a new tool_start cancels a pending grace timer", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <ChatLog
        {...baseProps}
        thinkingBuffer=""
        toolStatus={{ type: "tool_complete", toolName: "create_map_visualization", success: true }}
      />,
    );
    expect(container.textContent).toMatch(/Map created/);

    // Within the grace window, a new tool starts.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    rerender(
      <ChatLog
        {...baseProps}
        thinkingBuffer=""
        toolStatus={{ type: "tool_start", toolName: "add_wms_layer" }}
      />,
    );
    expect(container.textContent).toMatch(/Adding WMS layer\.\.\./);
    expect(container.textContent).not.toMatch(/Map created/);
  });

  it("falls back to humanized name for unknown tools", () => {
    const { container } = render(
      <ChatLog
        {...baseProps}
        thinkingBuffer=""
        toolStatus={{ type: "tool_start", toolName: "create_widget" }}
      />,
    );
    expect(container.textContent).toMatch(/Creating widget\.\.\./);
  });

  it("uses default fallback when statusToLabel returns null (suppressed entry)", () => {
    const { container } = render(
      <ChatLog
        {...baseProps}
        thinkingBuffer=""
        toolStatus={{ type: "tool_start", toolName: "call_tool" }}
      />,
    );
    // call_tool's start is suppressed (start: null in mapping) so we fall
    // through to the default — no thinking buffer + no content = "Thinking".
    expect(container.textContent).toMatch(/Thinking/);
  });
});
