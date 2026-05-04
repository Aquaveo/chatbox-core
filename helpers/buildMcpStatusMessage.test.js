/**
 * helpers/buildMcpStatusMessage.test.js — unit coverage for the in-chat
 * MCP-server-outcome status message helper.
 *
 * Locks the exact user-visible copy emitted on send-time MCP failures so
 * future edits can't silently drift the strings. Pure function, node env.
 */

import { describe, expect, it } from "vitest";

import { buildMcpStatusMessage } from "./buildMcpStatusMessage.js";

describe("buildMcpStatusMessage", () => {
  it("returns null for the connected state", () => {
    expect(
      buildMcpStatusMessage({ state: "connected", url: "https://x", name: "X" }),
    ).toBeNull();
  });

  it("emits 'Couldn't reach...' for the failed state, using name", () => {
    expect(
      buildMcpStatusMessage({ state: "failed", url: "https://x", name: "Foo" }),
    ).toBe(
      `Couldn't reach MCP server "Foo" — skipping its tools for this message.`,
    );
  });

  it("emits 'reports no tools.' for the no-tools state, using name", () => {
    expect(
      buildMcpStatusMessage({
        state: "no-tools",
        url: "https://x",
        name: "Bar",
      }),
    ).toBe(`MCP server "Bar" reports no tools.`);
  });

  it("falls back to URL when name is missing", () => {
    expect(
      buildMcpStatusMessage({ state: "failed", url: "https://x.example/" }),
    ).toBe(
      `Couldn't reach MCP server "https://x.example/" — skipping its tools for this message.`,
    );
  });

  it("falls back to URL when name is empty string", () => {
    expect(
      buildMcpStatusMessage({
        state: "no-tools",
        url: "https://x.example/",
        name: "",
      }),
    ).toBe(`MCP server "https://x.example/" reports no tools.`);
  });

  it("returns null for null outcome", () => {
    expect(buildMcpStatusMessage(null)).toBeNull();
  });

  it("returns null for undefined outcome", () => {
    expect(buildMcpStatusMessage(undefined)).toBeNull();
  });

  it("treats unknown states as the catch-all 'Couldn't reach' message", () => {
    expect(
      buildMcpStatusMessage({
        state: "timeout",
        url: "https://x",
        name: "Z",
      }),
    ).toBe(
      `Couldn't reach MCP server "Z" — skipping its tools for this message.`,
    );
  });

  it("does not throw when both name and url are missing (catch-all branch)", () => {
    // Undefined displayName falls into the message template — defensive
    // smoke check that it does not throw, even if the resulting copy is
    // suboptimal. Real outcomes always have at least a url.
    expect(() => buildMcpStatusMessage({ state: "failed" })).not.toThrow();
  });
});
