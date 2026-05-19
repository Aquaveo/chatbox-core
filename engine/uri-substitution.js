/**
 * engine/uri-substitution.js — Unit 3 of the MCP result-by-reference protocol
 * (plan 2026-05-18-002).
 *
 * Walks an outgoing tool-call's args. For each arg whose name ends in
 * `_uri` AND whose value is an `mcp+cache://` URI (or an array thereof),
 * resolves the URI(s) against the IndexedDB cache (Unit 1) and substitutes
 * the resolved payload into the corresponding non-`_uri` arg before
 * dispatch. The receiving server tool then sees inline data — never the
 * URI — so the existing tool body and validation work unchanged.
 *
 * Conflict resolution (URI + inline both set): URI wins, inline is
 * dropped, an INFO-level console log fires. Per plan, this treats
 * both-set as an LLM bug worth surfacing in metrics but not worth
 * failing the call.
 *
 * Cache miss: returns a structured `invalid_args` envelope (same shape
 * as the input-validation middleware on the server side). The caller
 * short-circuits dispatch and pushes the envelope as the tool result
 * so the LLM gets a recoverable error envelope with a `fix_hint`
 * directing it to re-fetch the source tool.
 */

import { CACHE_URI_SCHEME, readCachedPayload } from "./cache.js";

/**
 * Attempt to substitute every `*_uri` arg in `args` against the cache.
 *
 * Returns one of:
 *   - `{ ok: true, args: <mutated copy> }` on success (no misses, or no
 *     URI args present at all).
 *   - `{ ok: false, envelope: <invalid_args envelope> }` if any URI arg
 *     was present but couldn't be resolved.
 *
 * The args object is never mutated in place — substitution returns a
 * shallow copy with the `*_uri` keys removed and the corresponding
 * non-`_uri` keys populated with resolved payloads.
 */
export async function substituteCacheUris(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { ok: true, args };
  }

  const next = { ...args };
  let touched = false;
  const misses = [];

  for (const key of Object.keys(args)) {
    if (!key.endsWith("_uri")) continue;
    const value = args[key];
    const targetKey = key.slice(0, -"_uri".length); // e.g., "data_uri" → "data"

    // Detect: scalar URI string, array of URI strings, or unrecognized value.
    if (typeof value === "string" && value.startsWith(CACHE_URI_SCHEME)) {
      const payload = await readCachedPayload(value);
      if (payload === null) {
        misses.push(value);
        continue;
      }
      maybeWarnConflict(next, targetKey);
      next[targetKey] = payload;
      delete next[key];
      touched = true;
    } else if (
      Array.isArray(value) &&
      value.every(
        (v) => typeof v === "string" && v.startsWith(CACHE_URI_SCHEME),
      )
    ) {
      // Array of URIs — resolve each. Any miss aborts the substitution
      // with the FIRST missing URI named in the envelope (plan: cache-miss
      // on any list element returns invalid_args naming the specific
      // missing URI). We collect all misses for the envelope's
      // `_missing_uris` list so the LLM gets the full picture.
      const resolved = [];
      let listOk = true;
      for (const uri of value) {
        const payload = await readCachedPayload(uri);
        if (payload === null) {
          misses.push(uri);
          listOk = false;
        } else if (listOk) {
          resolved.push(payload);
        }
      }
      if (listOk) {
        maybeWarnConflict(next, targetKey);
        next[targetKey] = resolved;
        delete next[key];
        touched = true;
      }
      // If listOk === false, leave args alone for this key — caller will
      // see misses array and emit the envelope.
    }
    // Else: value isn't a recognized cache URI shape; leave it alone.
    // Caller's downstream validation will reject if the value is otherwise
    // invalid. We don't fail here on shape because a tool author may legitimately
    // have a `*_uri` arg that accepts non-cache URIs (e.g., `image_uri:
    // "https://..."`); the cache layer only claims `mcp+cache://`.
  }

  if (misses.length > 0) {
    return {
      ok: false,
      envelope: buildCacheMissEnvelope(misses),
    };
  }

  return { ok: true, args: touched ? next : args };
}

/**
 * Conflict log: the LLM set BOTH `data` and `data_uri` (or any `*_uri` +
 * its corresponding inline name). URI wins; we drop the inline value
 * silently but fire a console.info so the host can surface telemetry.
 *
 * Mutates `next` to remove the inline key when present — caller will then
 * overwrite the same slot with the resolved payload.
 */
function maybeWarnConflict(next, targetKey) {
  if (Object.prototype.hasOwnProperty.call(next, targetKey)) {
    console.info(
      `[chatbox-core cache] conflict: both '${targetKey}' and '${targetKey}_uri' set on tool call. URI wins; inline value dropped.`,
    );
    delete next[targetKey];
  }
}

/**
 * Build the invalid_args envelope the engine surfaces to the LLM on
 * cache miss. Shape mirrors the input-validation-middleware envelope so
 * the LLM's existing recovery pattern applies.
 */
function buildCacheMissEnvelope(missingUris) {
  const first = missingUris[0];
  const isArrayMiss = missingUris.length > 1;
  return {
    error: isArrayMiss
      ? `invalid_args: ${missingUris.length} cache URIs could not be resolved`
      : `invalid_args: cache URI ${first} could not be resolved`,
    _missing_uris: missingUris,
    fix_hint:
      "The cached result(s) referenced by this call's `*_uri` arg have " +
      "been evicted or were never minted. Re-call the source tool that " +
      "originally produced this data (the tool result envelope will " +
      "carry a fresh `_cache_uri` you can pass to this call). If the " +
      "user just refreshed the page or switched dashboards, ask them to " +
      "confirm before re-fetching, since the source tool may incur " +
      "cost or take time.",
  };
}
