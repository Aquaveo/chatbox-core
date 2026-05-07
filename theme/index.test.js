/**
 * theme/index.test.js — guard against accidentally deleting or
 * misspelling tokens consumed by styled-components. A misspelled token
 * resolves to `undefined` at render time, which renders the element with
 * a transparent or default-color value — a silent regression with no
 * console warning.
 */

import { describe, expect, it } from "vitest";

import chatTheme from "./index.js";

describe("chatTheme.colors", () => {
  // Tokens that other tests pin to specific values would couple too
  // tightly to design choices; this suite asserts presence + non-empty
  // string only.
  it.each([
    "primary",
    "primaryHover",
    "primaryLight",
    "userBubble",
    "assistantBubble",
    "thinking",
    "thinkingBorder",
    "thinkingText",
    "experimentalBorder",
    "experimentalText",
    "error",
    "border",
  ])("exposes a non-empty string for color token %s", (token) => {
    expect(typeof chatTheme.colors[token]).toBe("string");
    expect(chatTheme.colors[token].length).toBeGreaterThan(0);
  });
});

describe("chatTheme structure", () => {
  it("exposes spacing, fontSize, radius, sizes scales as objects", () => {
    expect(chatTheme.spacing).toBeTypeOf("object");
    expect(chatTheme.fontSize).toBeTypeOf("object");
    expect(chatTheme.radius).toBeTypeOf("object");
    expect(chatTheme.sizes).toBeTypeOf("object");
  });
});
