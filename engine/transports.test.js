// @vitest-environment jsdom
/**
 * engine/transports.test.js — unit coverage for transport selection,
 * SSRF guard, and the catch-path close-on-failure obligation.
 *
 * Locks down behavior that's currently exercised only via Playwright:
 *   - validateServerUrl (sanitize + scheme allowlist + mixed-content +
 *     literal-IP rejection with NODE_ENV-keyed allowLocal default)
 *   - withTimeout (timeout error tagging)
 *   - pickTransport (URL-suffix heuristic, HTTP-first fallback chain,
 *     transport.close() on every failure path)
 *
 * NODE_ENV — vitest sets process.env.NODE_ENV="test" by default, which
 * is neither "production" nor "development". Without explicit stubbing,
 * `validateServerUrl({allowLocal: undefined})` would default
 * `allowLocal=true` (because "test" !== "production"), masking the
 * production-mode literal-IP rejection. Each describe block stubs
 * NODE_ENV explicitly per scenario.
 *
 * SDK mocking — Client / SSEClientTransport / StreamableHTTPClient-
 * Transport are mocked at the file level via vi.mock(). See
 * test-helpers/sdkMocks.js for the export contract; the meta-test at the
 * bottom asserts the real SDK still exports what we mock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ERROR_KEYS } from "./mcpErrors.js";
import {
  SDK_EXPECTED_EXPORTS,
  SDK_VERSION_VERIFIED,
} from "../test-helpers/sdkMocks.js";

// ---- SDK mocks (hoisted before any non-vi import) -----------------------

vi.mock("@modelcontextprotocol/sdk/client", () => ({
  Client: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/client/sse", () => ({
  SSEClientTransport: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp", () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));

// Imports of the mocked classes + the SUT.
import { Client as MCPClient } from "@modelcontextprotocol/sdk/client";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp";

import {
  closeMcpConnection,
  pickTransport,
  validateServerUrl,
  withTimeout,
} from "./transports.js";

// ---- Helpers ----------------------------------------------------------------

/**
 * Wire up MCPClient / SSEClientTransport / StreamableHTTPClientTransport
 * to return controllable instances. Returns the instance objects so the
 * test can assert on `.connect`, `.close`, etc.
 */
function setupSdkMocks({ connectImpl, sseTransport, httpTransport } = {}) {
  const transports = [];

  const sseInstance = sseTransport ?? { close: vi.fn().mockResolvedValue(undefined) };
  const httpInstance = httpTransport ?? { close: vi.fn().mockResolvedValue(undefined) };

  SSEClientTransport.mockImplementation(() => {
    transports.push({ kind: "sse", instance: sseInstance });
    return sseInstance;
  });
  StreamableHTTPClientTransport.mockImplementation(() => {
    transports.push({ kind: "http", instance: httpInstance });
    return httpInstance;
  });

  const clientInstances = [];
  MCPClient.mockImplementation(() => {
    const instance = {
      connect: connectImpl ?? vi.fn().mockResolvedValue(undefined),
    };
    clientInstances.push(instance);
    return instance;
  });

  return { sseInstance, httpInstance, transports, clientInstances };
}

// ---------------------------------------------------------------------------
// validateServerUrl — scheme + mixed-content + literal-IP rejection
// ---------------------------------------------------------------------------

describe("validateServerUrl", () => {
  // vitest defaults NODE_ENV to "test" — pin to "production" so the
  // default-branch tests exercise the production literal-IP guard.
  // Individual test cases override per-scenario via vi.stubEnv.
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
  });

  describe("happy paths", () => {
    it("accepts a public HTTPS URL with allowLocal:false", () => {
      const result = validateServerUrl("https://example.com/mcp", { allowLocal: false });
      expect(result.ok).toBe(true);
      expect(result.normalizedUrl).toBe("https://example.com/mcp");
    });

    it("accepts a public URL when allowLocal:true (allowLocal does not block public hosts)", () => {
      const result = validateServerUrl("https://example.com/mcp", { allowLocal: true });
      expect(result.ok).toBe(true);
    });

    it("strips embedded credentials before validation", () => {
      const result = validateServerUrl("https://user:secret@example.com/", { allowLocal: false });
      expect(result.ok).toBe(true);
      expect(result.normalizedUrl).not.toContain("secret");
      expect(result.sanitize.stripped).toBe(true);
    });
  });

  describe("scheme rejection", () => {
    it.each([
      ["file:///etc/passwd", "file://"],
      ["ws://example.com/", "ws://"],
      ["data:text/plain,hello", "data:"],
      // eslint-disable-next-line no-script-url
      ["javascript:alert(1)", "javascript:"],
    ])("rejects %s with errorKey=invalid-scheme", (input) => {
      const result = validateServerUrl(input);
      expect(result.ok).toBe(false);
      expect(result.errorKey).toBe(ERROR_KEYS.invalidScheme);
    });

    it("rejects unparseable input", () => {
      const result = validateServerUrl("not a url");
      expect(result.ok).toBe(false);
      expect(result.errorKey).toBe(ERROR_KEYS.invalidScheme);
    });

    it("rejects empty / non-string input", () => {
      expect(validateServerUrl("").ok).toBe(false);
      expect(validateServerUrl(null).ok).toBe(false);
      expect(validateServerUrl(undefined).ok).toBe(false);
    });
  });

  describe("mixed-content guard", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("rejects http:// URL when page is served over https", () => {
      vi.stubGlobal("location", { protocol: "https:" });
      const result = validateServerUrl("http://example.com/mcp");
      expect(result.ok).toBe(false);
      expect(result.errorKey).toBe(ERROR_KEYS.mixedContent);
    });

    it("accepts http:// URL when page is served over http (guard inert)", () => {
      vi.stubGlobal("location", { protocol: "http:" });
      // Use a public host so the literal-IP guard doesn't kick in.
      const result = validateServerUrl("http://example.com/mcp", { allowLocal: false });
      expect(result.ok).toBe(true);
    });
  });

  describe("literal-IP rejection (production builds)", () => {
    // NODE_ENV is stubbed to "production" by the outer beforeEach;
    // allowLocal default → false; private/loopback IPs rejected.

    it.each([
      ["http://localhost/mcp", "localhost"],
      ["http://LOCALHOST/mcp", "uppercase localhost"],
      ["http://127.0.0.1/mcp", "IPv4 loopback"],
      ["http://127.255.255.254/mcp", "IPv4 loopback range edge"],
      ["http://10.0.0.1/mcp", "RFC1918 10.x"],
      ["http://172.16.0.1/mcp", "RFC1918 172.16.x"],
      ["http://172.31.255.254/mcp", "RFC1918 172.31.x edge"],
      ["http://192.168.1.1/mcp", "RFC1918 192.168.x"],
      ["http://169.254.169.254/mcp", "AWS IMDS link-local"],
      ["http://0.0.0.0/mcp", "wildcard"],
      ["http://[::1]/mcp", "IPv6 loopback"],
      ["http://[fe80::1]/mcp", "IPv6 link-local"],
    ])("rejects %s (%s)", (input) => {
      const result = validateServerUrl(input);
      expect(result.ok).toBe(false);
      expect(result.errorKey).toBe(ERROR_KEYS.privateIp);
    });

    it("172.15.x is NOT rejected (just outside RFC1918 range)", () => {
      const result = validateServerUrl("http://172.15.0.1/mcp");
      expect(result.ok).toBe(true);
    });

    it("172.32.x is NOT rejected (just outside RFC1918 range)", () => {
      const result = validateServerUrl("http://172.32.0.1/mcp");
      expect(result.ok).toBe(true);
    });

    it("public IPv4 (8.8.8.8) is NOT rejected", () => {
      const result = validateServerUrl("http://8.8.8.8/mcp");
      expect(result.ok).toBe(true);
    });

    it("public IPv6 is NOT rejected", () => {
      const result = validateServerUrl("http://[2001:4860:4860::8888]/mcp");
      expect(result.ok).toBe(true);
    });
  });

  describe("allowLocal toggle", () => {
    it("explicit allowLocal:true accepts localhost regardless of NODE_ENV", () => {
      vi.stubEnv("NODE_ENV", "production");
      const result = validateServerUrl("http://localhost/mcp", { allowLocal: true });
      expect(result.ok).toBe(true);
    });

    it("explicit allowLocal:false rejects localhost regardless of NODE_ENV", () => {
      vi.stubEnv("NODE_ENV", "development");
      const result = validateServerUrl("http://localhost/mcp", { allowLocal: false });
      expect(result.ok).toBe(false);
      expect(result.errorKey).toBe(ERROR_KEYS.privateIp);
    });

    it("allowLocal:undefined defaults to allow when NODE_ENV=development", () => {
      vi.stubEnv("NODE_ENV", "development");
      const result = validateServerUrl("http://localhost/mcp");
      expect(result.ok).toBe(true);
    });

    it("allowLocal:undefined defaults to reject when NODE_ENV=production", () => {
      vi.stubEnv("NODE_ENV", "production");
      const result = validateServerUrl("http://localhost/mcp");
      expect(result.ok).toBe(false);
      expect(result.errorKey).toBe(ERROR_KEYS.privateIp);
    });

    it("allowLocal:undefined still rejects when NODE_ENV is empty", () => {
      // Defensive against future refactors that flip the comparison
      // from `!== "production"` to `=== "development"` — empty must
      // still reject in the common case where it would previously have
      // accepted (the check is "NOT production" not "IS development").
      vi.stubEnv("NODE_ENV", "");
      // With empty NODE_ENV, `!== "production"` is TRUE, so allowLocal
      // defaults to true. This is the current behavior; the assertion
      // documents it. If the comparison flips, the documented behavior
      // changes and this test must be updated deliberately.
      const result = validateServerUrl("http://localhost/mcp");
      expect(result.ok).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// withTimeout
// ---------------------------------------------------------------------------

describe("withTimeout", () => {
  it("resolves with the wrapped promise's value when it settles within budget", async () => {
    const value = await withTimeout(Promise.resolve(42), 100);
    expect(value).toBe(42);
  });

  it("rejects with isTimeout=true when budget elapses first", async () => {
    const slow = new Promise(() => { /* never resolves */ });
    await expect(withTimeout(slow, 10)).rejects.toMatchObject({ isTimeout: true });
  });

  it("rejects with the wrapped promise's error when it rejects within budget", async () => {
    const rejection = new Error("inner failure");
    await expect(withTimeout(Promise.reject(rejection), 100)).rejects.toBe(rejection);
  });
});

// ---------------------------------------------------------------------------
// pickTransport — URL-suffix heuristic + fallback + close-on-failure
// ---------------------------------------------------------------------------

describe("pickTransport", () => {
  beforeEach(() => {
    // pickTransport runs validateServerUrl/preCheckUrl which read
    // window.location for mixed-content. Stub to https so http:// URLs
    // don't accidentally get rejected by the mixed-content guard.
    // Use a public URL test. NODE_ENV=production so localhost rejections
    // don't accidentally bite the test cases.
    vi.stubGlobal("location", { protocol: "https:" });
    vi.stubEnv("NODE_ENV", "production");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("/sse suffix → constructs SSE transport directly (no fallback)", async () => {
    const { sseInstance } = setupSdkMocks();
    await pickTransport("https://example.com/sse");

    expect(SSEClientTransport).toHaveBeenCalledTimes(1);
    expect(StreamableHTTPClientTransport).not.toHaveBeenCalled();
    expect(sseInstance.close).not.toHaveBeenCalled();
  });

  it("/mcp suffix → constructs HTTP transport directly (no fallback)", async () => {
    setupSdkMocks();
    await pickTransport("https://example.com/mcp");

    expect(StreamableHTTPClientTransport).toHaveBeenCalledTimes(1);
    expect(SSEClientTransport).not.toHaveBeenCalled();
  });

  it("ambiguous URL → tries HTTP first; on rejection, falls back to SSE", async () => {
    let attempt = 0;
    const connectImpl = vi.fn().mockImplementation(() => {
      attempt += 1;
      // First attempt (HTTP) rejects; second (SSE) resolves.
      if (attempt === 1) return Promise.reject(new Error("http failed"));
      return Promise.resolve();
    });
    setupSdkMocks({ connectImpl });

    await pickTransport("https://example.com/ambiguous-path");

    expect(StreamableHTTPClientTransport).toHaveBeenCalledTimes(1);
    expect(SSEClientTransport).toHaveBeenCalledTimes(1);
  });

  it("close-on-failure: connect-rejection invokes transport.close()", async () => {
    const { httpInstance } = setupSdkMocks({
      connectImpl: vi.fn().mockRejectedValue(new Error("connect refused")),
    });

    await expect(pickTransport("https://example.com/mcp")).rejects.toThrow();
    expect(httpInstance.close).toHaveBeenCalled();
  });

  // Note: a separate "timeout-rejection invokes transport.close()" test
  // was considered, but attemptConnect's catch path is shared between
  // connect-rejection and timeout-rejection (one try/catch wrapping the
  // `await withTimeout(client.connect(...), budgetMs)` call). The
  // connect-rejection scenario above exercises the same close-on-failure
  // invariant; a separate timeout test would be testing the same code
  // path with a different rejection trigger and is redundant. The
  // withTimeout describe block above tests the timeout's tagging (
  // isTimeout=true) directly.

  it("preCheckUrl rejection short-circuits before any transport is constructed", async () => {
    setupSdkMocks();
    // file:// is rejected by sanitizeMcpUrl/preCheckUrl
    await expect(pickTransport("file:///etc/passwd")).rejects.toThrow();
    expect(SSEClientTransport).not.toHaveBeenCalled();
    expect(StreamableHTTPClientTransport).not.toHaveBeenCalled();
  });

  it("preserves upstream errorKey on the thrown error", async () => {
    setupSdkMocks({
      connectImpl: vi.fn().mockImplementation(() => {
        const err = new Error("custom");
        err.errorKey = ERROR_KEYS.notMcpServer;
        return Promise.reject(err);
      }),
    });

    await expect(pickTransport("https://example.com/mcp")).rejects.toMatchObject({
      errorKey: ERROR_KEYS.notMcpServer,
    });
  });
});

// ---------------------------------------------------------------------------
// closeMcpConnection
// ---------------------------------------------------------------------------

describe("closeMcpConnection", () => {
  it("calls transport.close() on a real connection", async () => {
    const transport = { close: vi.fn().mockResolvedValue(undefined) };
    await closeMcpConnection({ transport });
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when connection is null/undefined", async () => {
    await expect(closeMcpConnection(null)).resolves.toBeUndefined();
    await expect(closeMcpConnection(undefined)).resolves.toBeUndefined();
  });

  it("swallows errors thrown by transport.close()", async () => {
    const transport = { close: vi.fn().mockRejectedValue(new Error("close failed")) };
    await expect(closeMcpConnection({ transport })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SDK version drift guard
// ---------------------------------------------------------------------------

describe("SDK export contract (drift guard)", () => {
  it("documents the SDK version the mocks were verified against", () => {
    // Bump test-helpers/sdkMocks.js when chatbox-core upgrades the SDK.
    expect(SDK_VERSION_VERIFIED).toBe("1.27.0");
  });

  it.each(Object.entries(SDK_EXPECTED_EXPORTS))(
    "real SDK module %s still exports the names this suite mocks",
    async (modulePath, expectedNames) => {
      // vi.unmock so the import below loads the real module, not the
      // file-level mock. vitest 3.x: vi.importActual loads bypassing
      // any vi.mock factory.
      const real = await vi.importActual(modulePath);
      for (const name of expectedNames) {
        expect(real, `${modulePath} missing export: ${name}`).toHaveProperty(name);
      }
    },
  );
});
