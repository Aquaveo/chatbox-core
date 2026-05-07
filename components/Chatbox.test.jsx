// @vitest-environment jsdom
/**
 * components/Chatbox.test.jsx — covers the persistent ExperimentalBanner
 * that must appear in every Chatbox render path.
 *
 * The four paths today are: welcome (no messages), provider panel,
 * MCP panel, and default messages view. The default-with-messages
 * branch can only be activated by the engine's send flow, which would
 * require mocking the entire engine; the other three are reachable
 * either at mount or via a single button click and are covered here.
 *
 * If a fifth render path is added in the future without including the
 * banner, the welcome test will keep passing — but the panel tests
 * would still catch a hoisted-shell regression. The intent of this
 * suite is structural: assert the banner contract at the surfaces we
 * can reach without engine setup.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

// Mock the network call Chatbox fires on mount. Without this, the
// listModels useEffect attempts a real fetch in jsdom and the test
// hangs / errors with a fetch failure.
//
// Note: the mock implementation is re-set in beforeEach because the
// project's vitest.config sets `restoreMocks: true`, which calls
// .mockRestore() on every spy between tests. Setting the resolved
// value inside the mock factory only survives the first test.
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
  // Clear any persisted user MCP servers from the per-worker
  // localStorage stub so test cases don't leak server config.
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
  // Import lazily so the vi.mock for helpers/index.js is in place
  // before Chatbox.jsx pulls in listModels.
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

function findExperimentalBanner(container) {
  const note = container.querySelector('[role="note"][aria-label="Experimental feature"]');
  return note;
}

describe("Chatbox ExperimentalBanner across render paths", () => {
  it("renders the banner in the welcome state (no messages, no panels)", async () => {
    const { container } = await renderChatbox();
    const banner = findExperimentalBanner(container);
    expect(banner).not.toBeNull();
    expect(banner.textContent).toMatch(/experimental/i);
    expect(banner.textContent).toMatch(/beta/i);
  });

  it("renders the banner when the MCP panel is open", async () => {
    const { container } = await renderChatbox();

    // Open the MCP panel by finding the button that opens it.
    // ChatInputBar exposes an onOpenMcpPanel handler — the button has
    // aria-label="MCP servers" or similar. Match via title or aria-label
    // tolerantly to avoid coupling to exact copy.
    const buttons = Array.from(container.querySelectorAll("button"));
    const mcpBtn = buttons.find((b) =>
      /mcp/i.test(`${b.getAttribute("aria-label") ?? ""} ${b.getAttribute("title") ?? ""} ${b.textContent ?? ""}`),
    );
    expect(mcpBtn, "expected an MCP-panel-opening button in the input bar").toBeTruthy();
    await act(async () => {
      mcpBtn.click();
    });

    expect(findExperimentalBanner(container)).not.toBeNull();
    // Sanity: the MCP panel header should also be present so we know
    // the panel actually rendered — otherwise the welcome banner
    // could pass the assertion accidentally.
    expect(container.textContent).toMatch(/mcp servers/i);
  });

  it("renders the banner when the provider panel is open", async () => {
    const { container } = await renderChatbox();

    const buttons = Array.from(container.querySelectorAll("button"));
    const providerBtn = buttons.find((b) =>
      /provider|llm|model/i.test(`${b.getAttribute("aria-label") ?? ""} ${b.getAttribute("title") ?? ""}`),
    );
    expect(providerBtn, "expected a provider-panel button in the input bar").toBeTruthy();
    await act(async () => {
      providerBtn.click();
    });

    expect(findExperimentalBanner(container)).not.toBeNull();
  });
});
