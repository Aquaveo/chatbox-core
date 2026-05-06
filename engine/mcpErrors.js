/**
 * mcpErrors.js — Shared error taxonomy for the MCP probe + connect paths.
 *
 * Imported by both `probe.js` (panel probe) and `index.js` (send-time connect)
 * so that the error surface is identical in the panel and in chat messages.
 * The values in ERROR_KEYS are the on-wire strings; callers always return the
 * value, not the property name.
 */

export const ERROR_KEYS = Object.freeze({
  mixedContent: "mixed-content",
  invalidScheme: "invalid-scheme",
  connectionFailed: "connection-failed",
  notMcpServer: "not-mcp-server",
  timeout: "timeout",
});

/**
 * User-facing copy for each error key. Surfaced in the panel's inline error
 * line (B8) and in the engine's in-chat failure messages (C1). Never include
 * content derived from the server's response body.
 */
export const ERROR_COPY = Object.freeze({
  [ERROR_KEYS.mixedContent]:
    "Insecure URL — https deployments cannot connect to http:// servers",
  [ERROR_KEYS.invalidScheme]:
    "Unsupported URL scheme — use http:// or https://",
  [ERROR_KEYS.connectionFailed]: "Connection failed",
  [ERROR_KEYS.notMcpServer]: "Not an MCP server",
  [ERROR_KEYS.timeout]: "Connection timed out",
});

/** Fallback when a new ERROR_KEYS entry lands without a matching ERROR_COPY row. */
export const DEFAULT_ERROR_COPY = "Connection error.";

/** Resolve an errorKey to its display copy, always returning a non-empty string. */
export function copyFor(errorKey) {
  return ERROR_COPY[errorKey] ?? DEFAULT_ERROR_COPY;
}
