/**
 * helpers/buildMcpStatusMessage.js — pure mapping from a per-server
 * MCP-connect outcome to the in-chat system message text (or null).
 *
 * Extracted from `components/Chatbox.jsx` so the user-visible copy can
 * be unit-tested without an end-to-end Playwright LLM stub. Callers
 * push the returned string into the chat log; null means "do not emit".
 *
 * Outcome shape (from `engine/probe.js` / `connectMcpServers`):
 *   { url, name?, state: "connected" | "no-tools" | "failed" | ..., errorKey? }
 *
 * Any state other than "connected" or "no-tools" falls into the
 * "Couldn't reach" catch-all — matches the original ternary in
 * Chatbox.jsx, which only special-cased "no-tools".
 */

export function buildMcpStatusMessage(outcome) {
  if (!outcome || outcome.state === "connected") return null;
  const displayName = outcome.name || outcome.url;
  if (outcome.state === "no-tools") {
    return `MCP server "${displayName}" reports no tools.`;
  }
  return `Couldn't reach MCP server "${displayName}" — skipping its tools for this message.`;
}
