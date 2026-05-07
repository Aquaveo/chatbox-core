// @vitest-environment jsdom
/**
 * components/MCPServerPanel.test.jsx — covers the over-recommended
 * server-count alert introduced by the UI polish pass.
 *
 * Specifically:
 * 1. At/below RECOMMENDED_ENABLED_SERVERS (5) the alert is absent.
 * 2. Above the threshold the alert renders with the live count.
 * 3. defaultServers are force-enabled in the panel's allServers memo
 *    and count toward the threshold (their props.enabled is overridden
 *    to true regardless of input — easy to regress).
 */

import { afterEach, describe, expect, it } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "styled-components";

import chatTheme from "../theme/index.js";
import MCPServerPanel from "./MCPServerPanel.jsx";

const mounted = [];
afterEach(() => {
  while (mounted.length) {
    const { root, container } = mounted.pop();
    act(() => root.unmount());
    container.remove();
  }
});

function render(ui) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<ThemeProvider theme={chatTheme}>{ui}</ThemeProvider>);
  });
  mounted.push({ root, container });
  return container;
}

const noop = () => {};
const baseProps = {
  defaultServers: [],
  userServers: [],
  onAdd: () => ({ added: true, sanitize: { stripped: false } }),
  onRemove: noop,
  onToggle: noop,
  onClose: noop,
  statusMap: new Map(),
  onRetry: noop,
  onPanelOpen: noop,
};

function makeServers(count, prefix) {
  return Array.from({ length: count }, (_, i) => ({
    url: `https://${prefix}-${i}.example.com/mcp`,
    name: `${prefix} ${i}`,
    enabled: true,
  }));
}

function findAlertText(container) {
  const matches = Array.from(container.querySelectorAll('[role="status"]'))
    .map((el) => el.textContent.trim())
    .filter((text) => /servers enabled/i.test(text));
  return matches[0] ?? null;
}

describe("MCPServerPanel over-recommended alert", () => {
  it("does not render the alert when exactly 5 servers are enabled", () => {
    const container = render(
      <MCPServerPanel {...baseProps} userServers={makeServers(5, "user")} />,
    );
    expect(findAlertText(container)).toBeNull();
  });

  it("renders the alert when 6 servers are enabled", () => {
    const container = render(
      <MCPServerPanel {...baseProps} userServers={makeServers(6, "user")} />,
    );
    const text = findAlertText(container);
    expect(text).not.toBeNull();
    expect(text).toMatch(/6 servers enabled/);
  });

  it("counts force-enabled defaultServers toward the threshold", () => {
    // 4 defaults + 2 enabled user servers = 6 enabled total. Even if a
    // hypothetical default were passed with enabled:false, the panel's
    // allServers memo overrides it to true — so the alert must fire.
    const container = render(
      <MCPServerPanel
        {...baseProps}
        defaultServers={makeServers(4, "default")}
        userServers={makeServers(2, "user")}
      />,
    );
    const text = findAlertText(container);
    expect(text).not.toBeNull();
    expect(text).toMatch(/6 servers enabled/);
  });

  it("excludes user servers with enabled=false from the count", () => {
    const userServers = [
      ...makeServers(3, "on"),
      ...makeServers(4, "off").map((s) => ({ ...s, enabled: false })),
    ];
    const container = render(
      <MCPServerPanel {...baseProps} userServers={userServers} />,
    );
    expect(findAlertText(container)).toBeNull();
  });

  it("dismisses the alert when the dismiss button is clicked", () => {
    const container = render(
      <MCPServerPanel {...baseProps} userServers={makeServers(6, "user")} />,
    );
    expect(findAlertText(container)).not.toBeNull();

    const dismissBtn = container.querySelector(
      'button[aria-label="Dismiss server-count notice"]',
    );
    expect(dismissBtn).not.toBeNull();
    act(() => {
      dismissBtn.click();
    });
    expect(findAlertText(container)).toBeNull();
  });
});
