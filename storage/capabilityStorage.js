/**
 * storage/capabilityStorage.js — localStorage-backed override store for
 * model tool-capability classifications.
 *
 * Plan 002 Unit 3: when Plan 001's reactive detection fires twice in a
 * row for a (provider, model) classified as "supported", auto-learn
 * persists an "unsupported" override here. Subsequent capability
 * lookups consult this store first; a found override takes precedence
 * over the registry-/listModels-derived classification.
 *
 * Override entries also expire — by 30-day TTL OR on capability-schema
 * version bump (whichever fires first). Expiry exists because a model
 * may be improved upstream and the auto-learned classification should
 * not persist forever.
 */

// Bump only when the classification logic itself changes (e.g., schema
// shape change, semantics of override fields). Patch/minor releases of
// chatbox-core do NOT bump this — those are unrelated to capability.
export const CAPABILITY_SCHEMA_VERSION = 1;

// 30-day TTL on auto-learned entries.
export const TTL_MS = 30 * 24 * 60 * 60 * 1000;

const STORAGE_KEY = "@chatbox/core:modelCapabilities:v1";

// Module-level fallback Map for environments without localStorage
// (private mode, SSR, Electron with restricted storage). Behavior
// degrades to per-session-only learning rather than throwing.
const memoryFallback = new Map();

// Per-session in-memory consecutive-failure counter. Persisted to
// localStorage only on the second consecutive failure (N=2 threshold).
const failureCounters = new Map();

function compositeKey(provider, model) {
  return `${provider || "?"}|${model || "?"}`;
}

function hasLocalStorage() {
  try {
    return typeof localStorage !== "undefined";
  } catch {
    return false;
  }
}

function readAll() {
  if (!hasLocalStorage()) {
    return Object.fromEntries(memoryFallback);
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      // localStorage exists but has no entry. A previous write may have
      // fallen back to memoryFallback (private mode / quota exceeded /
      // setItem mocked-to-throw). Consult that before returning empty so
      // the fail-open path is symmetric across read and write.
      return Object.fromEntries(memoryFallback);
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return Object.fromEntries(memoryFallback);
  }
}

function writeAll(obj) {
  if (!hasLocalStorage()) {
    memoryFallback.clear();
    for (const [k, v] of Object.entries(obj)) memoryFallback.set(k, v);
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch {
    // Quota exceeded / private mode — silently degrade to in-memory.
    memoryFallback.clear();
    for (const [k, v] of Object.entries(obj)) memoryFallback.set(k, v);
  }
}

// Allowed enum values; entries with anything else are considered corrupt.
const VALID_TOOL_USE = new Set(["supported", "unsupported", "unknown"]);
const VALID_SOURCE = new Set(["user", "auto-learned"]);

function isExpired(entry, now = Date.now()) {
  if (!entry) return true;
  if (entry.schemaVersion !== CAPABILITY_SCHEMA_VERSION) return true;
  const at = typeof entry.at === "string" ? Date.parse(entry.at) : entry.at;
  if (!at || Number.isNaN(at)) return true;
  return now - at > TTL_MS;
}

function isValid(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (!VALID_TOOL_USE.has(entry.toolUse)) return false;
  if (!VALID_SOURCE.has(entry.source)) return false;
  return true;
}

/**
 * Look up an override for the given (provider, model). Returns the
 * override entry if it exists, is valid, and is not expired. Returns
 * null otherwise. Drops invalid entries silently (with console.warn so
 * debug sessions can see them).
 */
export function getOverride(provider, model) {
  const all = readAll();
  const key = compositeKey(provider, model);
  const entry = all[key];
  if (!entry) return null;
  if (!isValid(entry)) {
    // eslint-disable-next-line no-console
    console.warn(`capabilityStorage: dropping invalid entry for ${key}`);
    delete all[key];
    writeAll(all);
    return null;
  }
  if (isExpired(entry)) {
    delete all[key];
    writeAll(all);
    return null;
  }
  return entry;
}

/**
 * Record a reactive-detection failure observation for (provider, model).
 * Returns the new in-session consecutive-failure count. Persists an
 * auto-learned "unsupported" override to localStorage when the count
 * reaches N=2.
 */
export function recordFailure(provider, model) {
  const key = compositeKey(provider, model);
  const next = (failureCounters.get(key) || 0) + 1;
  failureCounters.set(key, next);

  if (next >= 2) {
    const all = readAll();
    all[key] = {
      toolUse: "unsupported",
      source: "auto-learned",
      at: new Date().toISOString(),
      consecutiveFailures: next,
      schemaVersion: CAPABILITY_SCHEMA_VERSION,
    };
    writeAll(all);
  }
  return next;
}

/**
 * Reset the in-session failure counter for (provider, model). Called
 * when the engine observes successful tool use — defined as a turn in
 * which a tool was called and the adapter returned a tool result without
 * throwing. Tool result envelopes containing intentional `{error}`
 * payloads still count as success. Chat-only turns (no tool invocation)
 * do NOT reset.
 */
export function resetFailureCounter(provider, model) {
  failureCounters.delete(compositeKey(provider, model));
}

/**
 * Remove the override for (provider, model). Used by the deferred
 * settings UI; available now for testing and future user-override surface.
 */
export function clearOverride(provider, model) {
  const all = readAll();
  delete all[compositeKey(provider, model)];
  writeAll(all);
}

/**
 * Sweep expired entries. Returns the number of entries removed. Safe to
 * call at module init or periodically; not required for correctness
 * (getOverride checks expiry on every read) but keeps storage tidy.
 */
export function clearExpired() {
  const all = readAll();
  let removed = 0;
  for (const key of Object.keys(all)) {
    if (!isValid(all[key]) || isExpired(all[key])) {
      delete all[key];
      removed += 1;
    }
  }
  if (removed > 0) writeAll(all);
  return removed;
}

/**
 * Test helper: reset all in-memory state (failure counters AND
 * memoryFallback). Not exported in the public API surface; available
 * via the named export for tests only.
 */
export function _resetForTests() {
  failureCounters.clear();
  memoryFallback.clear();
  if (hasLocalStorage()) {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }
}
