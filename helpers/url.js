/**
 * url.js — Pure URL + name sanitizers for user-supplied MCP server entries.
 *
 * These helpers run on add (see storage/mcpStorage.js) so that nothing
 * unsanitized ever reaches localStorage or any display surface. They are
 * pure — no DOM, no network — and safe to call in any context.
 */

/**
 * Query-string parameter names that commonly carry credentials. Compared
 * case-insensitively. Stripped from the URL on add; the cleaned URL is what
 * gets persisted and rendered everywhere (panel, chat messages, tooltips).
 *
 * If new credential-bearing param names are discovered in the wild, extend
 * this list in one place.
 */
const CREDENTIAL_PARAM_NAMES = new Set([
  "token",
  "api_key",
  "apikey",
  "access_token",
  "secret",
  "password",
  "auth",
  "authorization",
  "key",
  "sessionid",
  "sid",
  "jwt",
  "bearer",
  "nonce",
  "client_secret",
  "x-api-key",
  "x_api_key",
  "api-key",
  "refresh_token",
  "oauth_token",
]);

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/**
 * Strip credentials from a URL: userinfo (`https://user:pass@host`) and any
 * known credential-bearing query-string parameter. Returns the cleaned URL
 * string. Inputs that fail to parse, or whose scheme is not http/https, are
 * returned unchanged — callers that need scheme rejection should run
 * `sanitizeMcpUrl` instead.
 *
 * Exported separately so the SSRF-guard warn path (Unit 1) can redact a
 * rejected URL before logging without re-running scheme validation.
 */
export function stripUrlCredentials(raw) {
  const input = typeof raw === "string" ? raw.trim() : "";
  if (!input) return input;

  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return input;
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) return input;

  if (parsed.username || parsed.password) {
    parsed.username = "";
    parsed.password = "";
  }

  for (const name of Array.from(parsed.searchParams.keys())) {
    if (CREDENTIAL_PARAM_NAMES.has(name.toLowerCase())) {
      parsed.searchParams.delete(name);
    }
  }

  return parsed.toString();
}

/**
 * Sanitize an MCP server URL for persistence and display.
 *
 * @param {string} raw - The user-supplied URL.
 * @returns {{
 *   url: string,
 *   stripped: boolean,
 *   invalidScheme: boolean,
 *   reasons: Array<"userinfo" | "query-token">
 * }}
 *
 * - `invalidScheme: true` → the caller must refuse to persist. Covers parse
 *   failures, `javascript:`, `data:`, `file:`, `ws:`, and anything else
 *   that isn't http/https.
 * - `stripped: true` → the returned `url` differs from `raw` because
 *   credentials were removed. Panel UI surfaces an inline notice.
 */
export function sanitizeMcpUrl(raw) {
  const reasons = [];
  const input = typeof raw === "string" ? raw.trim() : "";

  if (!input) {
    return { url: input, stripped: false, invalidScheme: true, reasons };
  }

  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return { url: input, stripped: false, invalidScheme: true, reasons };
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return { url: input, stripped: false, invalidScheme: true, reasons };
  }

  let stripped = false;

  if (parsed.username || parsed.password) {
    parsed.username = "";
    parsed.password = "";
    stripped = true;
    reasons.push("userinfo");
  }

  let removedQueryToken = false;
  for (const name of Array.from(parsed.searchParams.keys())) {
    if (CREDENTIAL_PARAM_NAMES.has(name.toLowerCase())) {
      parsed.searchParams.delete(name);
      removedQueryToken = true;
    }
  }
  if (removedQueryToken) {
    stripped = true;
    reasons.push("query-token");
  }

  return { url: parsed.toString(), stripped, invalidScheme: false, reasons };
}

/**
 * Named-entity table used by `decodeNamedEntities`. Case-insensitive: the
 * regex matches `&AMP;` / `&Amp;` / `&amp;` etc. and looks up the lowercase
 * key. Limited to entities that decode to characters the strip regex
 * (`<>`) cares about, plus the three other "html-five" entities that
 * commonly appear in encoded display names.
 */
const NAMED_ENTITIES = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'", // legacy alias — handled via numeric path but kept for symmetry
});

/**
 * One pass of HTML-entity decoding covering:
 *   - Named (case-insensitive): `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`
 *   - Numeric decimal: `&#NN;` (any number of leading zeros)
 *   - Numeric hex: `&#xHH;` / `&#XHH;` (any number of leading zeros)
 * Anything else (malformed entities, unknown names) passes through unchanged.
 */
function decodeEntitiesOnce(input) {
  return input
    .replace(/&([a-zA-Z]+);/g, (match, name) => {
      const decoded = NAMED_ENTITIES[name.toLowerCase()];
      return decoded != null ? decoded : match;
    })
    .replace(/&#(\d+);/g, (match, digits) => {
      const code = parseInt(digits, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    })
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (match, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    });
}

/**
 * Sanitize a user-supplied server display name.
 *
 * Strips angle brackets (defense-in-depth against stored XSS if a future
 * render path ever forgets to escape) and truncates to a reasonable length.
 * The persisted name is what renders in the panel and in C1/C2 chat messages.
 *
 * Decode-then-strip in a bounded loop (max 3 iterations) so double-encoded
 * payloads like `&amp;lt;script&amp;gt;` cannot survive a single decode and
 * be rendered as `<script>` by any future non-React HTML pipeline. React's
 * text-node auto-escape handles the currently shipped render path; the loop
 * is defense-in-depth for any other consumer (server-side render, email
 * template, etc.). 3 iterations is plenty in practice — pathological input
 * that doesn't stabilize at 100 iterations doesn't stabilize at 3 either,
 * and the partial output is still safe at the React surface.
 */
export function sanitizeServerName(raw) {
  if (typeof raw !== "string") return "";
  let prev;
  let out = raw;
  for (let i = 0; i < 3 && out !== prev; i++) {
    prev = out;
    out = decodeEntitiesOnce(out).replace(/[<>]/g, "");
  }
  return out.trim().slice(0, 128);
}
