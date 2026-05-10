// @vitest-environment jsdom
/**
 * components/ChatInputBar.slash.test.jsx — slash-command popover (Unit 3
 * of plan 2026-05-08-005). Covers slash detection (R5), keyboard /
 * popover behavior (R6), selection generation-counter race protection
 * (R7), placeholder-hint discoverability, ARIA combobox/listbox pattern,
 * and regression coverage for existing Enter / Shift+Enter behavior.
 *
 * jsdom has no layout engine, so `scrollHeight`, `getBoundingClientRect`,
 * and `selectionStart` are stubbed in `beforeEach` (vitest's
 * `restoreMocks: true` resets per-test).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "styled-components";

import chatTheme from "../theme/index.js";
import ChatInputBar from "./ChatInputBar.jsx";

const mounted = [];

beforeEach(() => {
  // jsdom layout shims — same pattern as Chatbox.persistence.test.jsx +
  // ChatInputBar.test.jsx. Stub on prototypes so every textarea created
  // in the test inherits the layout values without per-element setup.
  Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return 60;
    },
  });
  Object.defineProperty(HTMLTextAreaElement.prototype, "selectionStart", {
    configurable: true,
    get() {
      return 0;
    },
    set() {},
  });
  HTMLElement.prototype.getBoundingClientRect = function rect() {
    return {
      left: 10,
      top: 100,
      right: 410,
      bottom: 144,
      width: 400,
      height: 44,
      x: 10,
      y: 100,
      toJSON: () => ({}),
    };
  };
});

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

const examplePrompts = [
  {
    name: "plot_timeseries",
    description: "Plot a timeseries from NRDS query output",
  },
  {
    name: "plot_alt",
    description: "Alt timeseries variant",
  },
  {
    name: "summarize",
    description: "Summarize a dataset",
  },
];

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

function getTextarea(container) {
  return container.querySelector('textarea[role="combobox"]');
}

function getPopover() {
  // Popover is portaled to document.body, not the test container.
  return document.body.querySelector('[role="listbox"]');
}

function getRows() {
  return Array.from(document.body.querySelectorAll('[role="option"]'));
}

// Drive the controlled-input model: the parent updates `input` from
// the setInput callback. Tests need a tiny stateful host to mirror the
// real Chatbox behavior.
function HostedInputBar(props) {
  const [val, setVal] = React.useState(props.initialInput ?? "");
  return (
    <ChatInputBar
      {...baseProps}
      {...props}
      input={val}
      setInput={(v) => {
        setVal(v);
        props.setInput?.(v);
      }}
    />
  );
}

function fireKey(el, init) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });
}

function typeInto(textarea, value) {
  act(() => {
    // Native HTMLInputElement value setter so React's onChange fires.
    const proto = Object.getPrototypeOf(textarea);
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("ChatInputBar slash-command — R5 detection", () => {
  it("opens popover when user types `/` with non-empty prompts", () => {
    const { container } = render(<HostedInputBar prompts={examplePrompts} />);
    const ta = getTextarea(container);
    typeInto(ta, "/");
    const popover = getPopover();
    expect(popover).not.toBeNull();
    expect(getRows()).toHaveLength(3);
  });

  it("opens popover on initial render when controlled value is `/plot`", () => {
    const { container } = render(
      <HostedInputBar prompts={examplePrompts} initialInput="/plot" />,
    );
    expect(getTextarea(container)).not.toBeNull();
    const popover = getPopover();
    expect(popover).not.toBeNull();
    // /plot prefix-matches plot_timeseries and plot_alt, not summarize.
    expect(getRows()).toHaveLength(2);
  });

  it("filters case-insensitively on prefix-match against prompt.name", () => {
    const { container } = render(<HostedInputBar prompts={examplePrompts} />);
    const ta = getTextarea(container);
    typeInto(ta, "/p");
    expect(getRows()).toHaveLength(2);
    typeInto(ta, "/x");
    expect(getPopover()).toBeNull();
  });

  it("does NOT open popover when `/` is typed mid-word", () => {
    const { container } = render(<HostedInputBar prompts={examplePrompts} />);
    const ta = getTextarea(container);
    typeInto(ta, "hello/");
    expect(getPopover()).toBeNull();
  });

  it("does NOT open popover for `/etc/passwd` (regex fails on second `/`)", () => {
    const { container } = render(<HostedInputBar prompts={examplePrompts} />);
    const ta = getTextarea(container);
    typeInto(ta, "/etc/passwd");
    expect(getPopover()).toBeNull();
  });

  it("opens popover when `/plot` is pasted exactly", () => {
    const { container } = render(<HostedInputBar prompts={examplePrompts} />);
    const ta = getTextarea(container);
    typeInto(ta, "/plot");
    expect(getPopover()).not.toBeNull();
  });

  it("closes popover when a space is appended to `/`", () => {
    const { container } = render(<HostedInputBar prompts={examplePrompts} />);
    const ta = getTextarea(container);
    typeInto(ta, "/");
    expect(getPopover()).not.toBeNull();
    typeInto(ta, "/ ");
    expect(getPopover()).toBeNull();
  });

  it("closes popover when input is backspaced from `/` to empty", () => {
    const { container } = render(<HostedInputBar prompts={examplePrompts} />);
    const ta = getTextarea(container);
    typeInto(ta, "/");
    expect(getPopover()).not.toBeNull();
    typeInto(ta, "");
    expect(getPopover()).toBeNull();
  });

  it("Esc closes popover; subsequent `/` reopens", () => {
    const { container } = render(<HostedInputBar prompts={examplePrompts} />);
    const ta = getTextarea(container);
    typeInto(ta, "/");
    expect(getPopover()).not.toBeNull();
    fireKey(ta, { key: "Escape" });
    expect(getPopover()).toBeNull();
    // Re-trigger: empty the input then type `/` again.
    typeInto(ta, "");
    typeInto(ta, "/");
    expect(getPopover()).not.toBeNull();
  });

  it("does NOT open popover when prompts is empty", () => {
    const { container } = render(<HostedInputBar prompts={[]} />);
    const ta = getTextarea(container);
    typeInto(ta, "/");
    expect(getPopover()).toBeNull();
  });

  it("does NOT throw and does not open when neither prompts nor onPromptSelected supplied", () => {
    const { container } = render(<HostedInputBar />);
    const ta = getTextarea(container);
    expect(() => typeInto(ta, "/")).not.toThrow();
    expect(getPopover()).toBeNull();
  });
});

describe("ChatInputBar slash-command — placeholder hint", () => {
  it("uses `Send a message… or / for templates` when prompts is non-empty", () => {
    const { container } = render(<HostedInputBar prompts={examplePrompts} />);
    const ta = getTextarea(container);
    expect(ta.placeholder).toBe("Send a message… or / for templates");
  });

  it("preserves the original `Send a message…` placeholder when prompts is empty", () => {
    const { container } = render(<HostedInputBar prompts={[]} />);
    const ta = getTextarea(container);
    expect(ta.placeholder).toBe("Send a message…");
  });
});

describe("ChatInputBar slash-command — R6 keyboard behavior", () => {
  it("ArrowDown moves highlight from row 0 to row 1; ArrowUp moves back", () => {
    const { container } = render(<HostedInputBar prompts={examplePrompts} />);
    const ta = getTextarea(container);
    typeInto(ta, "/");
    let rows = getRows();
    expect(rows[0].getAttribute("aria-selected")).toBe("true");
    fireKey(ta, { key: "ArrowDown" });
    rows = getRows();
    expect(rows[1].getAttribute("aria-selected")).toBe("true");
    fireKey(ta, { key: "ArrowUp" });
    rows = getRows();
    expect(rows[0].getAttribute("aria-selected")).toBe("true");
  });

  it("ArrowDown on last row stays on last row (no wrap)", () => {
    const { container } = render(<HostedInputBar prompts={examplePrompts} />);
    const ta = getTextarea(container);
    typeInto(ta, "/");
    fireKey(ta, { key: "ArrowDown" });
    fireKey(ta, { key: "ArrowDown" });
    fireKey(ta, { key: "ArrowDown" }); // already at last; no wrap
    const rows = getRows();
    expect(rows[2].getAttribute("aria-selected")).toBe("true");
    expect(rows[0].getAttribute("aria-selected")).toBe("false");
  });

  it("ArrowUp on first row stays on first row (no wrap)", () => {
    const { container } = render(<HostedInputBar prompts={examplePrompts} />);
    const ta = getTextarea(container);
    typeInto(ta, "/");
    fireKey(ta, { key: "ArrowUp" });
    const rows = getRows();
    expect(rows[0].getAttribute("aria-selected")).toBe("true");
  });

  it("Enter on highlighted row calls onPromptSelected with the prompt object", () => {
    const onPromptSelected = vi.fn(() => Promise.resolve());
    const { container } = render(
      <HostedInputBar prompts={examplePrompts} onPromptSelected={onPromptSelected} />,
    );
    const ta = getTextarea(container);
    typeInto(ta, "/");
    fireKey(ta, { key: "Enter" });
    expect(onPromptSelected).toHaveBeenCalledTimes(1);
    expect(onPromptSelected.mock.calls[0][0].name).toBe("plot_timeseries");
  });

  it("Tab on highlighted row calls onPromptSelected and prevents default focus traversal", () => {
    const onPromptSelected = vi.fn(() => Promise.resolve());
    const { container } = render(
      <HostedInputBar prompts={examplePrompts} onPromptSelected={onPromptSelected} />,
    );
    const ta = getTextarea(container);
    typeInto(ta, "/");
    let preventDefaulted = false;
    const evt = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    const origPrevent = evt.preventDefault;
    evt.preventDefault = function () {
      preventDefaulted = true;
      origPrevent.call(this);
    };
    act(() => {
      ta.dispatchEvent(evt);
    });
    expect(preventDefaulted).toBe(true);
    expect(onPromptSelected).toHaveBeenCalledTimes(1);
  });

  it("Click on a row calls onPromptSelected with that row's prompt", async () => {
    const onPromptSelected = vi.fn(() => Promise.resolve());
    const { container } = render(
      <HostedInputBar prompts={examplePrompts} onPromptSelected={onPromptSelected} />,
    );
    const ta = getTextarea(container);
    typeInto(ta, "/");
    const rows = getRows();
    // React 18 schedules click handlers asynchronously when prior renders
    // produced effect work; `await act(async)` flushes the dispatch path.
    await act(async () => {
      rows[1].click();
    });
    expect(onPromptSelected).toHaveBeenCalledTimes(1);
    expect(onPromptSelected.mock.calls[0][0].name).toBe("plot_alt");
  });

  it("window resize while popover is open closes the popover", () => {
    const { container } = render(<HostedInputBar prompts={examplePrompts} />);
    const ta = getTextarea(container);
    typeInto(ta, "/");
    expect(getPopover()).not.toBeNull();
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(getPopover()).toBeNull();
  });

  it("document scroll while popover is open closes the popover", () => {
    const { container } = render(<HostedInputBar prompts={examplePrompts} />);
    const ta = getTextarea(container);
    typeInto(ta, "/");
    expect(getPopover()).not.toBeNull();
    act(() => {
      // Capture-phase listener — fire from a child element so the event
      // propagates to the document-level capture listener.
      ta.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(getPopover()).toBeNull();
  });

  it("scroll inside the popover (own overflow-y:auto + Chromium auto-scroll-to-aria-activedescendant) does NOT close the popover", () => {
    // Regression for the inner-popover-scroll dismiss bug: the
    // capture-phase scroll listener used to fire indiscriminately on
    // any descendant scroll, including the popover's own overflow-y
    // scrolling and Chromium's auto-scroll-to-aria-activedescendant on
    // ArrowUp/ArrowDown row navigation. Both should leave the popover
    // open. Outer-page scrolls (covered by the test above) still close.
    const { container } = render(<HostedInputBar prompts={examplePrompts} />);
    const ta = getTextarea(container);
    typeInto(ta, "/");
    const popover = getPopover();
    expect(popover).not.toBeNull();
    act(() => {
      popover.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(getPopover()).not.toBeNull();
    // Also a row-internal scroll (matches Chromium's auto-scroll target
    // on aria-activedescendant change).
    const rows = getRows();
    expect(rows.length).toBeGreaterThan(0);
    act(() => {
      rows[0].dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(getPopover()).not.toBeNull();
  });
});

describe("ChatInputBar slash-command — R7 selection generation-counter", () => {
  it("highlighted row shows loading indicator while onPromptSelected is pending", async () => {
    let resolveFn;
    const onPromptSelected = vi.fn(
      () => new Promise((resolve) => {
        resolveFn = resolve;
      }),
    );
    const { container } = render(
      <HostedInputBar prompts={examplePrompts} onPromptSelected={onPromptSelected} />,
    );
    const ta = getTextarea(container);
    typeInto(ta, "/");
    fireKey(ta, { key: "Enter" });
    // While pending: highlighted row should contain a spinner with
    // aria-label "Loading"; other rows should not.
    const rows = getRows();
    expect(rows[0].querySelector('[aria-label="Loading"]')).not.toBeNull();
    expect(rows[1].querySelector('[aria-label="Loading"]')).toBeNull();
    expect(rows[2].querySelector('[aria-label="Loading"]')).toBeNull();
    // Resolve to avoid unhandled-promise warnings.
    await act(async () => {
      resolveFn();
      await Promise.resolve();
    });
  });

  it("Esc'd selection: late-arriving resolve drops the result; loadingPromptName clears", async () => {
    let resolveFn;
    const onPromptSelected = vi.fn(
      () => new Promise((resolve) => {
        resolveFn = resolve;
      }),
    );
    const onSuccessSpy = vi.fn();
    const wrappedSelect = (prompt) => {
      return onPromptSelected(prompt).then(() => onSuccessSpy(prompt));
    };
    const { container } = render(
      <HostedInputBar prompts={examplePrompts} onPromptSelected={wrappedSelect} />,
    );
    const ta = getTextarea(container);
    typeInto(ta, "/");
    fireKey(ta, { key: "Enter" });
    // Esc-close popover before resolve.
    fireKey(ta, { key: "Escape" });
    expect(getPopover()).toBeNull();
    // Resolve — the wrapped onSuccessSpy fires (because the host-side
    // chain doesn't have a guard), but ChatInputBar's internal guard
    // prevents popover-reopen and clears loadingPromptName.
    await act(async () => {
      resolveFn();
      await Promise.resolve();
      await Promise.resolve();
    });
    // Popover stays closed — abandonment was honored.
    expect(getPopover()).toBeNull();
  });

  it("racing selections: selecting B after slow A honors only B's resolution", async () => {
    let resolveA;
    let resolveB;
    let call = 0;
    const onPromptSelected = vi.fn((prompt) => {
      call += 1;
      if (call === 1) {
        return new Promise((r) => {
          resolveA = r;
        });
      }
      return new Promise((r) => {
        resolveB = r;
      });
    });
    const { container } = render(
      <HostedInputBar prompts={examplePrompts} onPromptSelected={onPromptSelected} />,
    );
    const ta = getTextarea(container);
    typeInto(ta, "/");
    fireKey(ta, { key: "Enter" }); // select A (plot_timeseries)
    // Click row B (plot_alt). React 18 schedules click handlers async
    // when prior renders produced effect work; `await act(async)` flushes
    // the dispatch path so the spy sees the second call before assertion.
    const rows = getRows();
    await act(async () => {
      rows[1].click();
    });
    expect(onPromptSelected).toHaveBeenCalledTimes(2);
    // Resolve B FIRST (success path runs for B), then A late.
    await act(async () => {
      resolveB();
      await Promise.resolve();
      await Promise.resolve();
    });
    // After B resolves, popover closes.
    expect(getPopover()).toBeNull();
    await act(async () => {
      resolveA();
      await Promise.resolve();
      await Promise.resolve();
    });
    // Still closed; A's late resolve does not re-open or otherwise
    // affect the visible state.
    expect(getPopover()).toBeNull();
  });

  it("typing-over selection: late-arriving A is dropped when triggerToken changed", async () => {
    let resolveFn;
    const onPromptSelected = vi.fn(
      () => new Promise((resolve) => {
        resolveFn = resolve;
      }),
    );
    const { container } = render(
      <HostedInputBar prompts={examplePrompts} onPromptSelected={onPromptSelected} />,
    );
    const ta = getTextarea(container);
    typeInto(ta, "/");
    fireKey(ta, { key: "Enter" }); // select A — captures tokenAtSelect=""
    // Type-over: change input to /p, popover stays open with new filter.
    typeInto(ta, "/p");
    expect(getPopover()).not.toBeNull();
    // Resolve A — guard checks triggerToken === tokenAtSelect ("" vs "p")
    // and bails. Popover state for "/p" is preserved.
    await act(async () => {
      resolveFn();
      await Promise.resolve();
      await Promise.resolve();
    });
    // The popover from the new /p typing is still open (A's resolve did
    // not trigger any close-side-effect because the guard fired).
    expect(getPopover()).not.toBeNull();
  });

  it("error path: rejected onPromptSelected closes popover and clears loading", async () => {
    let rejectFn;
    const onPromptSelected = vi.fn(
      () => new Promise((_, reject) => {
        rejectFn = reject;
      }),
    );
    const { container } = render(
      <HostedInputBar prompts={examplePrompts} onPromptSelected={onPromptSelected} />,
    );
    const ta = getTextarea(container);
    typeInto(ta, "/");
    fireKey(ta, { key: "Enter" });
    expect(getPopover()).not.toBeNull();
    await act(async () => {
      rejectFn(new Error("boom"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getPopover()).toBeNull();
    // Re-render check: typing again should work cleanly.
    typeInto(ta, "");
    typeInto(ta, "/");
    expect(getPopover()).not.toBeNull();
    const rows = getRows();
    // No row carries a leftover spinner.
    for (const row of rows) {
      expect(row.querySelector('[aria-label="Loading"]')).toBeNull();
    }
  });
});

describe("ChatInputBar slash-command — ARIA accessibility", () => {
  it("textarea has role=combobox; aria-expanded reflects popover state; aria-controls matches popover id", () => {
    const { container } = render(<HostedInputBar prompts={examplePrompts} />);
    const ta = getTextarea(container);
    expect(ta.getAttribute("role")).toBe("combobox");
    expect(ta.getAttribute("aria-expanded")).toBe("false");
    typeInto(ta, "/");
    expect(ta.getAttribute("aria-expanded")).toBe("true");
    const popover = getPopover();
    expect(popover).not.toBeNull();
    expect(ta.getAttribute("aria-controls")).toBe(popover.getAttribute("id"));
  });

  it("aria-activedescendant matches highlighted row id; arrow keys update it", () => {
    const { container } = render(<HostedInputBar prompts={examplePrompts} />);
    const ta = getTextarea(container);
    typeInto(ta, "/");
    const initial = ta.getAttribute("aria-activedescendant");
    expect(initial).toBeTruthy();
    expect(getRows()[0].getAttribute("id")).toBe(initial);
    fireKey(ta, { key: "ArrowDown" });
    const after = ta.getAttribute("aria-activedescendant");
    expect(after).toBe(getRows()[1].getAttribute("id"));
    expect(after).not.toBe(initial);
  });

  it("each row has role=option and aria-selected reflects highlight", () => {
    const { container } = render(<HostedInputBar prompts={examplePrompts} />);
    const ta = getTextarea(container);
    typeInto(ta, "/");
    const rows = getRows();
    for (const row of rows) {
      expect(row.getAttribute("role")).toBe("option");
    }
    expect(rows[0].getAttribute("aria-selected")).toBe("true");
    expect(rows[1].getAttribute("aria-selected")).toBe("false");
    fireKey(ta, { key: "ArrowDown" });
    const rows2 = getRows();
    expect(rows2[0].getAttribute("aria-selected")).toBe("false");
    expect(rows2[1].getAttribute("aria-selected")).toBe("true");
  });
});

describe("ChatInputBar slash-command — regression", () => {
  it("Enter without popover open calls onSend; Shift+Enter inserts newline", () => {
    const onSend = vi.fn();
    const { container } = render(
      <HostedInputBar prompts={examplePrompts} onSend={onSend} initialInput="hello" />,
    );
    const ta = getTextarea(container);
    expect(getPopover()).toBeNull();
    fireKey(ta, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
    // Shift+Enter does NOT call onSend.
    fireKey(ta, { key: "Enter", shiftKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});
