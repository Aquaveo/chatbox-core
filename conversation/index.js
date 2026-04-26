/**
 * chatboxConversation.js
 *
 * Utilities for managing multi-turn conversation state:
 * - Token estimation (chars/4 heuristic)
 * - Conversation trimming (remove oldest turns to fit token budget)
 */

/**
 * Estimate the token count of a messages array.
 * Uses chars/4 heuristic — not exact, but sufficient for budget decisions.
 */
export function estimateTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    }
    if (msg.tool_calls) {
      chars += JSON.stringify(msg.tool_calls).length;
    }
  }
  return Math.ceil(chars / 4);
}

/**
 * Group messages (excluding the system message at index 0) into turn groups.
 * A turn starts with a "user" message and includes all subsequent
 * assistant/tool messages until the next "user" message.
 *
 * Returns: Array of arrays, e.g. [[user1, assistant1, tool1], [user2, assistant2]]
 */
function groupIntoTurns(messages) {
  const turns = [];
  let current = null;

  for (const msg of messages) {
    if (msg.role === "user") {
      if (current) turns.push(current);
      current = [msg];
    } else if (current) {
      current.push(msg);
    }
  }
  if (current) turns.push(current);
  return turns;
}

/**
 * Trim a conversation to fit within a token budget.
 *
 * Always keeps:
 *   - messages[0] (system message)
 *   - The last turn group (most recent user + assistant + tool messages)
 *
 * Removes oldest turn groups first until the total is under maxTokens.
 */
export function trimConversation(messages, maxTokens) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  if (estimateTokens(messages) <= maxTokens) return messages;

  const systemMsg = messages[0];
  const rest = messages.slice(1);
  const turns = groupIntoTurns(rest);

  if (turns.length <= 1) {
    // Only one turn — can't trim further without removing the current prompt
    return messages;
  }

  // Remove oldest turns until we fit
  let startIdx = 0;
  while (startIdx < turns.length - 1) {
    const kept = [systemMsg, ...turns.slice(startIdx + 1).flat()];
    if (estimateTokens(kept) <= maxTokens) {
      return kept;
    }
    startIdx++;
  }

  // Last resort: system + last turn only
  return [systemMsg, ...turns[turns.length - 1]];
}
