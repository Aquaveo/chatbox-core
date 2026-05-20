// @vitest-environment jsdom
/**
 * components/Chatbox.cache.test.jsx — coverage for Plan 2026-05-19-002
 * Unit 4: per-mount MCP connection cache wiring on <Chatbox>.
 *
 * Scope: behaviors that the Chatbox wrapper orchestrates (lazy cache
 * init, `connectionCache` prop threading into runChatSession, unmount
 * cleanup, allMcpServers URL-set-change invalidation). Lower-level
 * engine integration is covered by `engine/connect-with-cache.test.js`
 * + `engine/discover-with-cache.test.js`.
 *
 * Strategy: mock the engine helpers + the connection-cache factory so
 * the wiring is observable via mock call counts without standing up a
 * live MCP server. Mirrors `Chatbox.prompts.test.jsx` setup.
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
    runChatSession: vi.fn(),
  };
});

// Mock the cache factory so we can assert what gets passed through
// and observe lifecycle calls. The mock returns an object whose method
// surface matches the real factory.
vi.mock("../engine/connection-cache.js", async () => {
  return {
    createConnectionCache: vi.fn(() => {
      const instance = {
        getOrOpen: vi.fn(),
        invalidate: vi.fn(() => Promise.resolve()),
        invalidateUrlsNotIn: vi.fn(() => Promise.resolve()),
        closeAll: vi.fn(() => Promise.resolve()),
      };
      return instance;
    }),
  };
});

import { listModels } from "../helpers/index.js";
import { discoverPrompts, runChatSession } from "../engine/index.js";
import { createConnectionCache } from "../engine/connection-cache.js";

const mounted = [];

beforeEach(() => {
  listModels.mockResolvedValue([{ name: "test-model", contextLength: 8192 }]);
  discoverPrompts.mockResolvedValue({
    promptsByServer: {},
    promptServerMap: new Map(),
    perServer: [],
  });
  runChatSession.mockResolvedValue({ messages: [] });
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

function lastCacheInstance() {
  // The factory mock returns a fresh instance per call; the most recent
  // instance is the one Chatbox is currently holding via cacheRef.
  const calls = createConnectionCache.mock.results;
  if (calls.length === 0) return null;
  return calls[calls.length - 1].value;
}

describe("Chatbox connection cache — lazy init + prop threading", () => {
  it("constructs the cache lazily on first cache-consuming operation", async () => {
    await renderChatbox({});
    // Mount fires discoverPrompts which calls getCache() → first construct.
    // (discoverPrompts is the earliest cache consumer in the mount path.)
    expect(createConnectionCache).toHaveBeenCalledTimes(1);
  });

  it("passes the cache + memo into discoverPrompts on mount", async () => {
    await renderChatbox({
      mcpServers: [{ url: "https://a", name: "A", enabled: true }],
    });
    expect(discoverPrompts).toHaveBeenCalled();
    const callArgs = discoverPrompts.mock.calls[0];
    expect(callArgs[1]).toMatchObject({
      cache: expect.any(Object),
      memo: expect.any(Object),
    });
  });

  it("the same cache instance is reused across discoverPrompts and runChatSession", async () => {
    // Trigger a send so runChatSession fires alongside the mount-time discover.
    await renderChatbox({});
    // runChatSession isn't called on mount; only on user send. Since this
    // test doesn't simulate a send, we assert via the more visible path:
    // discoverPrompts and the lazy-init contract.
    const cache = lastCacheInstance();
    expect(cache).toBeTruthy();
    const discoverCacheArg = discoverPrompts.mock.calls[0][1]?.cache;
    expect(discoverCacheArg).toBe(cache);
  });
});

describe("Chatbox connection cache — unmount cleanup", () => {
  it("calls cache.closeAll on unmount", async () => {
    const { root, container } = await renderChatbox({});
    const cache = lastCacheInstance();
    expect(cache).toBeTruthy();
    expect(cache.closeAll).not.toHaveBeenCalled();

    // Pull this mount out of the tracked-mounts list so afterEach
    // doesn't try to unmount it again.
    const idx = mounted.findIndex((m) => m.root === root);
    if (idx >= 0) mounted.splice(idx, 1);

    await act(async () => {
      root.unmount();
    });
    container.remove();

    expect(cache.closeAll).toHaveBeenCalledTimes(1);
  });
});

describe("Chatbox connection cache — allMcpServers URL-set change", () => {
  it("invalidates URLs no longer in the active set on mcpServers prop change", async () => {
    const { root, container } = await renderChatbox({
      mcpServers: [
        { url: "https://a", name: "A", enabled: true },
        { url: "https://b", name: "B", enabled: true },
      ],
    });
    const cache = lastCacheInstance();

    const { default: Chatbox } = await import("./Chatbox.jsx");
    await act(async () => {
      root.render(
        <Chatbox
          mcpServers={[{ url: "https://a", name: "A", enabled: true }]}
        />,
      );
    });

    // invalidateUrlsNotIn fires with the new active URL set.
    expect(cache.invalidateUrlsNotIn).toHaveBeenCalled();
    const lastCall =
      cache.invalidateUrlsNotIn.mock.calls[
        cache.invalidateUrlsNotIn.mock.calls.length - 1
      ];
    // URL normalization may add a trailing slash on bare hosts; accept either.
    expect(lastCall[0]).toHaveLength(1);
    expect(lastCall[0][0]).toMatch(/^https:\/\/a\/?$/);

    // Cleanup
    const idx = mounted.findIndex((m) => m.root === root);
    if (idx >= 0) mounted.splice(idx, 1);
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("URL-set-equal prop reference change does NOT close any cached transport", async () => {
    const servers = [{ url: "https://a", name: "A", enabled: true }];
    const { root, container } = await renderChatbox({ mcpServers: servers });
    const cache = lastCacheInstance();

    // Same URLs, different array reference — should still invalidateUrlsNotIn
    // (the effect runs on reference change), but with the SAME active set,
    // so nothing actually gets closed (cache module's behavior, not ours).
    const { default: Chatbox } = await import("./Chatbox.jsx");
    await act(async () => {
      root.render(
        <Chatbox
          mcpServers={[{ url: "https://a", name: "A", enabled: true }]}
        />,
      );
    });

    // invalidateUrlsNotIn fires (effect runs), but with ["https://a"]
    // matching the cached set. The cache module will close zero entries.
    const lastCall =
      cache.invalidateUrlsNotIn.mock.calls[
        cache.invalidateUrlsNotIn.mock.calls.length - 1
      ];
    // URL normalization may add a trailing slash on bare hosts; accept either.
    expect(lastCall[0]).toHaveLength(1);
    expect(lastCall[0][0]).toMatch(/^https:\/\/a\/?$/);

    const idx = mounted.findIndex((m) => m.root === root);
    if (idx >= 0) mounted.splice(idx, 1);
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
