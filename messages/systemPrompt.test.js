/**
 * messages/systemPrompt.test.js — coverage for the toolsAvailable flag
 * extension of getGenericSystemRules and buildGenericSystemMessage.
 *
 * Plan 002 Unit 2: when capability is gated off, the engine swaps to the
 * bare-framed system prompt (omits "you may call tools" + "Tool rules:"
 * block). Existing zero-arg callers must continue to work unchanged.
 */

import { describe, expect, it } from "vitest";

import { buildGenericSystemMessage, getGenericSystemRules } from "./index.js";

describe("getGenericSystemRules", () => {
  it("includes tool-using framing by default (zero-arg back-compat)", () => {
    const lines = getGenericSystemRules();
    const joined = lines.join("\n");
    expect(joined).toMatch(/You may call tools/i);
    expect(joined).toMatch(/Tool rules:/);
  });

  it("includes tool-using framing when toolsAvailable=true", () => {
    const lines = getGenericSystemRules({ toolsAvailable: true });
    const joined = lines.join("\n");
    expect(joined).toMatch(/You may call tools/i);
    expect(joined).toMatch(/Tool rules:/);
  });

  it("omits tool framing when toolsAvailable=false", () => {
    const lines = getGenericSystemRules({ toolsAvailable: false });
    const joined = lines.join("\n");
    expect(joined).not.toMatch(/You may call tools/i);
    expect(joined).not.toMatch(/Tool rules:/);
    expect(joined).not.toMatch(/Use ONLY argument keys/);
    // Sanity: the bare-frame should still include date and a basic answer instruction.
    expect(joined).toMatch(/Today is/);
    expect(joined).toMatch(/your own knowledge/i);
  });
});

describe("buildGenericSystemMessage", () => {
  it("returns role:system with tool-framed content by default", () => {
    const msg = buildGenericSystemMessage();
    expect(msg.role).toBe("system");
    expect(msg.content).toMatch(/You may call tools/i);
  });

  it("returns bare-framed content when toolsAvailable=false", () => {
    const msg = buildGenericSystemMessage({ toolsAvailable: false });
    expect(msg.role).toBe("system");
    expect(msg.content).not.toMatch(/You may call tools/i);
    expect(msg.content).not.toMatch(/Tool rules:/);
  });
});
