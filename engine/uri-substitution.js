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
 * Default cap on inline list-arg sizes for tools that pair an arg with
 * a `<name>_uri` cache-URI alternative (today: `data`). Inline arrays
 * larger than this reliably exceed small-model output bounds. Observed
 * bug 2026-05-19: nemotron-3-nano-30b corrupting JSON at ~1.2KB on a
 * 24-record array; symptom was `data is not valid JSON: Extra data:
 * line 1 column 1275`. The cap forces the LLM toward `data_uri` for
 * any payload over this size; the cache-URI substitution layer below
 * resolves the URI server-side without re-emitting the bytes.
 */
export const INLINE_LIST_MAX_RECORDS = 20;

// Convention-based scope: only arg names paired with a `<name>_uri`
// cache-URI alternative get capped. Today: `data` (create_plotly_chart,
// create_data_table, create_card). Future tools can extend by adding
// the arg name here.
const CAPPED_INLINE_ARGS = new Set(["data"]);

/**
 * Pre-dispatch cap check on inline list args. Returns `null` when no
 * cap is violated; returns an envelope shaped like the cache-miss
 * envelope (error + fix_hint, plus a `_capped_arg` marker for engine
 * signature tracking) when an arg exceeds the cap AND the LLM did not
 * set the corresponding `*_uri` alternative.
 *
 * Call this BEFORE `substituteCacheUris` so cache-URI-resolved payloads
 * (regardless of size) pass through unaffected — the cap targets the
 * LLM's emission, not the resolved data. When the LLM set BOTH `data`
 * (inline) and `data_uri` (URI), the URI path wins per `maybeWarnConflict`
 * and the cap is skipped here.
 *
 * @param {string} toolName - tool being invoked (used in error text and fix_hint)
 * @param {object} args - the LLM-emitted args
 * @param {number} [cap=INLINE_LIST_MAX_RECORDS] - tunable threshold
 * @returns {object|null} envelope or null
 */
export function checkInlineListCap(
  toolName,
  args,
  cap = INLINE_LIST_MAX_RECORDS,
) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  for (const argName of CAPPED_INLINE_ARGS) {
    const value = args[argName];
    if (!Array.isArray(value)) continue;
    if (value.length <= cap) continue;
    const uriKey = `${argName}_uri`;
    // LLM set the URI alternative — substitution will resolve it.
    // Defer to maybeWarnConflict for the both-set case.
    if (args[uriKey] !== undefined) continue;
    return {
      error:
        `invalid_args: \`${argName}\` has ${value.length} records ` +
        `(cap: ${cap}). Inline arrays this large exceed small-model ` +
        `output bounds and reliably produce JSON parse errors at the ` +
        `~1KB threshold. Use \`${uriKey}\` — pass the \`_cache_uri\` ` +
        `field that was auto-injected on the source tool's result ` +
        `envelope. The engine resolves the URI without re-emitting ` +
        `the bytes.`,
      fix_hint:
        `Retry \`${toolName}\` with \`${uriKey}=<_cache_uri value from ` +
        `a prior tool result>\` instead of inlining \`${argName}\`. ` +
        `Records under ${cap} can still be inlined.`,
      _capped_arg: argName,
    };
  }
  return null;
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
