/**
 * engine/applyExtensionMessage.test.js — coverage for the
 * `beforeFirstMessage` extension's role-aware merge behavior.
 *
 * Bug context (2026-05-04): when `engineExtensions.beforeFirstMessage`
 * returns a `role: "system"` message (e.g., ChatSidebar's dashboard-state
 * injection that fires whenever the dashboard has at least one
 * visualization), the engine used to append it as a separate message.
 * On turn 2+ this produced sequences like
 * `[system_initial, user1, assistant1, user2, system_extra]` — Ollama
 * Cloud rejects with "Conversation roles must alternate
 * user/assistant/..." because the trailing system breaks the alternation
 * after `user2`.
 *
 * The fix: merge system-content extensions into the trailing user
 * message. These tests pin that behavior.
 */

import { describe, expect, it } from "vitest";

import { applyExtensionMessage } from "./index.js";

const SYSTEM_PROMPT = { role: "system", content: "You are a helpful assistant." };
const USER_MSG = (content) => ({ role: "user", content });
const ASSISTANT_MSG = (content) => ({ role: "assistant", content });

describe("applyExtensionMessage", () => {
  it("returns messages unchanged when extra is null", () => {
    const messages = [SYSTEM_PROMPT, USER_MSG("hello")];
    const result = applyExtensionMessage(messages, null);
    expect(result).toEqual(messages);
  });

  it("returns messages unchanged when extra is undefined", () => {
    const messages = [SYSTEM_PROMPT, USER_MSG("hello")];
    const result = applyExtensionMessage(messages, undefined);
    expect(result).toEqual(messages);
  });

  it("merges a system extra into the trailing user message", () => {
    const messages = [
      SYSTEM_PROMPT,
      USER_MSG("hello"),
      ASSISTANT_MSG("hi"),
      USER_MSG("how are you?"),
    ];
    const extra = { role: "system", content: "Dashboard context: 2 charts" };
    const result = applyExtensionMessage(messages, extra);

    expect(result).toHaveLength(4);
    expect(result[3]).toEqual({
      role: "user",
      content: "Dashboard context: 2 charts\n\nhow are you?",
    });
    // Strict user/assistant alternation preserved (after leading system).
    expect(result.slice(1).map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
  });

  it("merges system extra into a first-turn user message too", () => {
    const messages = [SYSTEM_PROMPT, USER_MSG("hello")];
    const extra = { role: "system", content: "Context: foo" };
    const result = applyExtensionMessage(messages, extra);

    expect(result).toEqual([
      SYSTEM_PROMPT,
      { role: "user", content: "Context: foo\n\nhello" },
    ]);
  });

  it("appends non-system extras as separate messages", () => {
    const messages = [SYSTEM_PROMPT, USER_MSG("hello")];
    const extra = { role: "user", content: "side note" };
    const result = applyExtensionMessage(messages, extra);

    expect(result).toEqual([...messages, extra]);
  });

  it("appends a system extra when the trailing message is not a user turn", () => {
    // Defensive: if for some reason the extension is invoked when the
    // trailing message is an assistant message, fall back to append
    // behavior rather than corrupting an assistant turn.
    const messages = [SYSTEM_PROMPT, USER_MSG("hi"), ASSISTANT_MSG("hello!")];
    const extra = { role: "system", content: "ctx" };
    const result = applyExtensionMessage(messages, extra);

    expect(result).toEqual([...messages, extra]);
  });

  it("does not mutate the input messages array", () => {
    const messages = [SYSTEM_PROMPT, USER_MSG("hello")];
    const extra = { role: "system", content: "ctx" };
    applyExtensionMessage(messages, extra);

    expect(messages).toEqual([SYSTEM_PROMPT, USER_MSG("hello")]);
  });

  it("handles empty extra.content gracefully", () => {
    const messages = [SYSTEM_PROMPT, USER_MSG("hello")];
    const extra = { role: "system", content: "" };
    const result = applyExtensionMessage(messages, extra);

    expect(result[1].content).toBe("\n\nhello");
  });

  it("handles empty user message content gracefully", () => {
    const messages = [SYSTEM_PROMPT, USER_MSG("")];
    const extra = { role: "system", content: "ctx" };
    const result = applyExtensionMessage(messages, extra);

    expect(result[1].content).toBe("ctx\n\n");
  });

  it("preserves additional user message fields (e.g., name) during merge", () => {
    const messages = [
      SYSTEM_PROMPT,
      { role: "user", content: "hi", name: "alice" },
    ];
    const extra = { role: "system", content: "ctx" };
    const result = applyExtensionMessage(messages, extra);

    expect(result[1]).toEqual({
      role: "user",
      content: "ctx\n\nhi",
      name: "alice",
    });
  });
});

describe("strict-alternation invariant after extension applied", () => {
  // This test simulates the Ollama Cloud rejection scenario. Pre-fix, the
  // result of two turns with a system-injecting beforeFirstMessage produced
  // `[system, user, assistant, user, system]`. Post-fix, the array is
  // strictly user/assistant after the leading system.

  it("produces strict alternation after a multi-turn session with system injections", () => {
    let messages = [SYSTEM_PROMPT];

    // Turn 1: empty-dashboard case (no extra injected)
    messages.push(USER_MSG("create a chart"));
    messages = applyExtensionMessage(messages, null);
    messages.push(ASSISTANT_MSG("I created a chart."));

    // Turn 2: dashboard now has a viz, beforeFirstMessage returns system
    messages.push(USER_MSG("summarize it"));
    messages = applyExtensionMessage(messages, {
      role: "system",
      content: "Dashboard state: 1 chart",
    });

    // After leading system, every message must alternate user/assistant.
    const rolesAfterLeading = messages.slice(1).map((m) => m.role);
    expect(rolesAfterLeading).toEqual(["user", "assistant", "user"]);

    // The system context made it into the final user message.
    expect(messages[messages.length - 1]).toEqual({
      role: "user",
      content: "Dashboard state: 1 chart\n\nsummarize it",
    });
  });
});
