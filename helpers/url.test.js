/**
 * helpers/url.test.js — unit coverage for the pure URL + name sanitizers.
 *
 * Locks down the entity-decode loop (single, double, triple encoding;
 * named-five case-insensitive; numeric/hex with leading zeros; malformed)
 * and the credential-stripping invariants exercised end-to-end by the
 * Playwright suite at the panel layer.
 *
 * Pure functions — node environment, no mocks needed.
 */

import { describe, expect, it } from "vitest";

import {
  sanitizeMcpUrl,
  sanitizeServerName,
  stripUrlCredentials,
} from "./url.js";

// ---------------------------------------------------------------------------
// sanitizeServerName
// ---------------------------------------------------------------------------

describe("sanitizeServerName", () => {
  it("returns plain input unchanged", () => {
    expect(sanitizeServerName("My Server")).toBe("My Server");
  });

  it("preserves legitimate ampersand (no false strip)", () => {
    expect(sanitizeServerName("Foo & Bar")).toBe("Foo & Bar");
  });

  it("decodes single-encoded entities then strips angle brackets", () => {
    expect(sanitizeServerName("&lt;script&gt;alert(1)&lt;/script&gt;")).toBe(
      "scriptalert(1)/script",
    );
  });

  it("decodes double-encoded payloads via the bounded loop", () => {
    // Iter 1: &amp;lt;script&amp;gt;  → &lt;script&gt;
    // Iter 2: &lt;script&gt;          → script (decoded then stripped)
    const out = sanitizeServerName("&amp;lt;script&amp;gt;");
    expect(out).not.toMatch(/[<>]/);
    expect(out).toMatch(/script/);
  });

  it("triple-encoded input still produces no <script> at the 3-iter cap", () => {
    const out = sanitizeServerName("&amp;amp;lt;script&amp;amp;gt;");
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("</script>");
  });

  it("decodes named entities case-insensitively (uppercase)", () => {
    expect(sanitizeServerName("&LT;img&GT;")).toBe("img");
  });

  it("decodes named entities case-insensitively (mixed case)", () => {
    const out = sanitizeServerName("&Amp;Lt;img&Amp;Gt;");
    expect(out).not.toMatch(/[<>]/);
  });

  it("decodes numeric decimal entities", () => {
    expect(sanitizeServerName("&#60;img&#62;")).toBe("img");
  });

  it("decodes numeric hex entities (lowercase)", () => {
    expect(sanitizeServerName("&#x3c;img&#x3e;")).toBe("img");
  });

  it("decodes numeric hex entities (uppercase X)", () => {
    expect(sanitizeServerName("&#X3C;img&#X3E;")).toBe("img");
  });

  it("decodes numeric entities with leading zeros (decimal)", () => {
    expect(sanitizeServerName("&#0000060;img&#0000062;")).toBe("img");
  });

  it("decodes numeric entities with leading zeros (hex)", () => {
    expect(sanitizeServerName("&#x0000003c;img&#x0000003e;")).toBe("img");
  });

  it("passes malformed entity (no semicolon) through unchanged", () => {
    // No crash; the existing regex doesn't strip the bare ampersand,
    // and the entity decoder doesn't match without a terminating `;`.
    expect(sanitizeServerName("Foo&ampBar")).toBe("Foo&ampBar");
  });

  it("passes unknown named entity through unchanged", () => {
    // `&copy;` is HTML-valid but not in the chatbox-core minimal table —
    // the loop leaves it as-is rather than reaching into a full HTML
    // entity table. Acceptable defense-in-depth limit.
    expect(sanitizeServerName("Foo&copy;Bar")).toBe("Foo&copy;Bar");
  });

  it("trims whitespace and caps at 128 chars", () => {
    const long = "x".repeat(200);
    const out = sanitizeServerName(`  ${long}  `);
    expect(out).toHaveLength(128);
    expect(out).toBe("x".repeat(128));
  });

  it("returns empty string for null / undefined / non-string input", () => {
    expect(sanitizeServerName(null)).toBe("");
    expect(sanitizeServerName(undefined)).toBe("");
    expect(sanitizeServerName(42)).toBe("");
    expect(sanitizeServerName({})).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(sanitizeServerName("")).toBe("");
    expect(sanitizeServerName("   ")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// stripUrlCredentials
// ---------------------------------------------------------------------------

describe("stripUrlCredentials", () => {
  it("returns input unchanged when there are no credentials", () => {
    expect(stripUrlCredentials("https://example.com/mcp")).toBe(
      "https://example.com/mcp",
    );
  });

  it("strips userinfo (user:password)", () => {
    expect(stripUrlCredentials("https://user:pass@example.com/")).toBe(
      "https://example.com/",
    );
  });

  it("strips userinfo with no password", () => {
    expect(stripUrlCredentials("https://onlyuser@host.example/")).toBe(
      "https://host.example/",
    );
  });

  it("strips known credential query params", () => {
    expect(
      stripUrlCredentials("https://example.com/?token=abc&keep=yes"),
    ).toBe("https://example.com/?keep=yes");
  });

  it("strips multiple credential params and keeps benign ones", () => {
    const out = stripUrlCredentials(
      "https://example.com/?token=a&api_key=b&keep=yes&authorization=c",
    );
    expect(out).toContain("keep=yes");
    expect(out).not.toContain("token=");
    expect(out).not.toContain("api_key=");
    expect(out).not.toContain("authorization=");
  });

  it("strips credential param names case-insensitively", () => {
    const out = stripUrlCredentials(
      "https://example.com/?TOKEN=x&Authorization=y&Keep=ok",
    );
    expect(out).not.toContain("TOKEN");
    expect(out).not.toContain("Authorization");
    expect(out).toContain("Keep=ok");
  });

  it("strips both userinfo and credential query params", () => {
    expect(
      stripUrlCredentials("https://u:p@host.example/?api_key=secret"),
    ).toBe("https://host.example/");
  });

  it("returns input unchanged when URL parsing fails", () => {
    expect(stripUrlCredentials("not a url")).toBe("not a url");
  });

  it("returns input unchanged for unsupported schemes (sanitizeMcpUrl is the rejecting layer)", () => {
    // Note: file:// URLs DO parse successfully (they're valid URLs). The
    // assertion here verifies that stripUrlCredentials doesn't strip
    // anything from a parseable file:// URL — the scheme rejection is
    // sanitizeMcpUrl's responsibility, not this helper's.
    expect(stripUrlCredentials("file:///etc/passwd")).toBe(
      "file:///etc/passwd",
    );
  });

  it("returns empty string for empty / non-string input", () => {
    expect(stripUrlCredentials("")).toBe("");
    expect(stripUrlCredentials(null)).toBe("");
    expect(stripUrlCredentials(undefined)).toBe("");
    expect(stripUrlCredentials(42)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// sanitizeMcpUrl
// ---------------------------------------------------------------------------

describe("sanitizeMcpUrl", () => {
  it("returns clean URL with no flags for a valid input", () => {
    const result = sanitizeMcpUrl("https://example.com/mcp");
    expect(result.url).toBe("https://example.com/mcp");
    expect(result.stripped).toBe(false);
    expect(result.invalidScheme).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it("flags userinfo stripping with reason 'userinfo'", () => {
    const result = sanitizeMcpUrl("https://user:pass@example.com/");
    expect(result.stripped).toBe(true);
    expect(result.invalidScheme).toBe(false);
    expect(result.reasons).toContain("userinfo");
    expect(result.url).not.toContain("user:pass");
  });

  it("flags credential query-param stripping with reason 'query-token'", () => {
    const result = sanitizeMcpUrl("https://example.com/?token=x");
    expect(result.stripped).toBe(true);
    expect(result.reasons).toContain("query-token");
    expect(result.url).not.toContain("token=");
  });

  it("flags both userinfo + query-token when both present", () => {
    const result = sanitizeMcpUrl(
      "https://u:p@example.com/?api_key=secret",
    );
    expect(result.stripped).toBe(true);
    expect(result.reasons).toEqual(
      expect.arrayContaining(["userinfo", "query-token"]),
    );
  });

  it("rejects file:// scheme with invalidScheme:true", () => {
    const result = sanitizeMcpUrl("file:///etc/passwd");
    expect(result.invalidScheme).toBe(true);
  });

  it("rejects ws:// scheme with invalidScheme:true", () => {
    const result = sanitizeMcpUrl("ws://example.com/");
    expect(result.invalidScheme).toBe(true);
  });

  it("rejects data: scheme with invalidScheme:true", () => {
    const result = sanitizeMcpUrl("data:text/plain;base64,SGVsbG8=");
    expect(result.invalidScheme).toBe(true);
  });

  it("rejects javascript: scheme with invalidScheme:true", () => {
    // eslint-disable-next-line no-script-url
    const result = sanitizeMcpUrl("javascript:alert(1)");
    expect(result.invalidScheme).toBe(true);
  });

  it("rejects unparseable input with invalidScheme:true", () => {
    const result = sanitizeMcpUrl("not a url");
    expect(result.invalidScheme).toBe(true);
  });

  it("rejects empty / whitespace-only input with invalidScheme:true", () => {
    expect(sanitizeMcpUrl("").invalidScheme).toBe(true);
    expect(sanitizeMcpUrl("   ").invalidScheme).toBe(true);
  });

  it("returns invalidScheme:true and the trimmed input for non-string types", () => {
    expect(sanitizeMcpUrl(null).invalidScheme).toBe(true);
    expect(sanitizeMcpUrl(undefined).invalidScheme).toBe(true);
    expect(sanitizeMcpUrl(42).invalidScheme).toBe(true);
  });

  it("preserves benign query params alongside credential stripping", () => {
    const result = sanitizeMcpUrl(
      "https://example.com/?token=secret&keep=ok",
    );
    expect(result.url).toContain("keep=ok");
    expect(result.url).not.toContain("token=");
  });
});
