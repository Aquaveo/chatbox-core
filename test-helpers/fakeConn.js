/**
 * test-helpers/fakeConn.js — shared fake-transport / fake-client factories.
 *
 * Single canonical shape used by both engine/transports.test.js (Unit 4)
 * and engine/probe.test.js (Unit 5). Establishing the shape here prevents
 * fragmentation when the two suites are written in parallel.
 *
 * The factories return plain JS objects with `vi.fn()` methods so tests
 * can configure per-call behavior via `.mockResolvedValueOnce(...)` etc.
 * without reaching into instance internals.
 */

import { vi } from "vitest";

/**
 * Build a fake `SSEClientTransport` / `StreamableHTTPClientTransport`
 * instance. Override any field via the second arg.
 */
export function makeFakeTransport(overrides = {}) {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/**
 * Build a fake `Client` instance with `connect()` and `listTools()` as
 * `vi.fn()`s. Defaults: connect resolves; listTools returns no tools.
 *
 * Optional `listPromptsImpl` / `getPromptImpl` (Plan 2026-05-08-005 Unit 2):
 * default to UNDEFINED (matching the existing pattern for other optional
 * methods) so tests covering the engine's prompt-discovery path can
 * mock them per-suite without affecting other tests.
 */
export function makeFakeClient({
  tools = [],
  connectImpl,
  listToolsImpl,
  callToolImpl,
  listPromptsImpl,
  getPromptImpl,
} = {}) {
  return {
    connect: connectImpl ?? vi.fn().mockResolvedValue(undefined),
    listTools: listToolsImpl ?? vi.fn().mockResolvedValue({ tools }),
    callTool: callToolImpl ?? vi.fn().mockResolvedValue({ data: null }),
    listPrompts: listPromptsImpl,
    getPrompt: getPromptImpl,
  };
}

/**
 * Build a fake `{client, transport, protocolUsed}` connection — the shape
 * `pickTransport` returns. Useful for testing `probeMcpServer` and the
 * scheduler without exercising real SDK transports.
 */
export function makeFakeConn({ tools = [], protocolUsed = "http" } = {}) {
  return {
    client: makeFakeClient({ tools }),
    transport: makeFakeTransport(),
    protocolUsed,
  };
}
