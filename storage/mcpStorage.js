/**
 * chatboxMcpStorage.js
 *
 * Persists user-configured MCP servers to localStorage.
 * Each server: { url: string, name: string, enabled: boolean }
 *
 * URL + name are sanitized on add (see helpers/url.js) so that credentials
 * in URLs never reach localStorage and server names can't smuggle HTML into
 * the chat log.
 */

import { sanitizeServerName } from "../helpers/url.js";
import { validateServerUrl } from "../engine/transports.js";

const STORAGE_KEY = "chatbox_mcp_servers";

export function getMcpServers() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveMcpServers(servers) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(servers));
  } catch {
    // localStorage full or unavailable — silently fail
  }
}

/**
 * Adds an MCP server to localStorage after validating + sanitizing the URL
 * and name.
 *
 * @returns {{
 *   servers: Array,
 *   sanitize: {
 *     invalidScheme: boolean,
 *     stripped: boolean,
 *     reasons: string[],
 *     errorKey: string | null,
 *   },
 *   added: boolean
 * }}
 *
 * Callers (e.g., MCPServerPanel) use `sanitize` to drive UI — `invalidScheme`
 * is a generic "URL was rejected" flag preserved for backward compatibility;
 * `errorKey` carries the specific reason (`invalid-scheme`, `mixed-content`,
 * `private-ip`) so callers can render targeted error copy. `stripped` triggers
 * the D1 credential-removed inline alert. `added: false` means the URL was
 * rejected (validation failure or duplicate) and the server list is unchanged.
 *
 * Validation routes through `validateServerUrl` so prop-supplied servers
 * (Chatbox.jsx default-server filter) and user-typed servers share one
 * predicate. In production builds, literal private/loopback/link-local IPs
 * are rejected; dev builds allow them.
 */
export function addMcpServer({ url, name }) {
  const servers = getMcpServers();
  const rawUrl = typeof url === "string" ? url : "";
  const validation = validateServerUrl(rawUrl);
  const sanitizeResult = validation.sanitize ?? {
    stripped: false,
    reasons: [],
  };

  if (!validation.ok) {
    return {
      servers,
      sanitize: {
        invalidScheme: true,
        stripped: false,
        reasons: [],
        errorKey: validation.errorKey,
      },
      added: false,
    };
  }

  // 0.0.0.0 is a server bind address, not a browser-reachable address.
  let normalized = validation.normalizedUrl
    .replace(/\/\/0\.0\.0\.0([:/])/g, "//localhost$1")
    .replace(/\/+$/, "");

  // Deduplicate by URL
  if (servers.some((s) => s.url.replace(/\/+$/, "") === normalized)) {
    return {
      servers,
      sanitize: {
        invalidScheme: false,
        stripped: sanitizeResult.stripped,
        reasons: sanitizeResult.reasons,
        errorKey: null,
      },
      added: false,
    };
  }

  const cleanName = sanitizeServerName(name) || normalized;
  const updated = [
    ...servers,
    { url: normalized, name: cleanName, enabled: true },
  ];
  saveMcpServers(updated);
  return {
    servers: updated,
    sanitize: {
      invalidScheme: false,
      stripped: sanitizeResult.stripped,
      reasons: sanitizeResult.reasons,
      errorKey: null,
    },
    added: true,
  };
}

export function removeMcpServer(url) {
  const servers = getMcpServers();
  const normalized = url.trim().replace(/\/+$/, "");
  const updated = servers.filter(
    (s) => s.url.replace(/\/+$/, "") !== normalized,
  );
  saveMcpServers(updated);
  return updated;
}

export function toggleMcpServer(url) {
  const servers = getMcpServers();
  const normalized = url.trim().replace(/\/+$/, "");
  const updated = servers.map((s) =>
    s.url.replace(/\/+$/, "") === normalized
      ? { ...s, enabled: !s.enabled }
      : s,
  );
  saveMcpServers(updated);
  return updated;
}
