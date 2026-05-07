/**
 * test-setup.js — vitest setup hook (loaded before each test file).
 *
 * Node 22+ ships a built-in `localStorage` global that is a stub `{}`
 * unless invoked with `--localstorage-file=<path>`. Node 25.x exposes
 * this even without the flag, which shadows jsdom's `window.localStorage`
 * — `localStorage.setItem(...)` then crashes with `TypeError: ... is
 * not a function`. jsdom does not override the existing global.
 *
 * Workaround: install a tiny in-memory Storage implementation onto both
 * `globalThis.localStorage` and (when jsdom is the env) `window.localStorage`.
 * Same object reference for both so `globalThis.localStorage ===
 * window.localStorage` holds, matching the contract pre-Node-25.
 *
 * Node-environment tests fall through the `if (typeof window ...)`
 * guard and only get the global storage; capabilityStorage.js's
 * `hasLocalStorage()` check still works there because the global is
 * present and has `setItem`.
 */

class MemoryStorage {
  constructor() {
    this._data = new Map();
  }
  get length() {
    return this._data.size;
  }
  key(i) {
    return Array.from(this._data.keys())[i] ?? null;
  }
  getItem(k) {
    return this._data.has(String(k)) ? this._data.get(String(k)) : null;
  }
  setItem(k, v) {
    this._data.set(String(k), String(v));
  }
  removeItem(k) {
    this._data.delete(String(k));
  }
  clear() {
    this._data.clear();
  }
}

const storage = new MemoryStorage();
const sessionStorage = new MemoryStorage();

Object.defineProperty(globalThis, "localStorage", {
  value: storage,
  writable: true,
  configurable: true,
});
Object.defineProperty(globalThis, "sessionStorage", {
  value: sessionStorage,
  writable: true,
  configurable: true,
});

if (typeof window !== "undefined") {
  Object.defineProperty(window, "localStorage", {
    value: storage,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, "sessionStorage", {
    value: sessionStorage,
    writable: true,
    configurable: true,
  });
}

// Tell React we're inside an act()-aware environment (jsdom-based
// component tests). Without this, every render triggers a "current
// testing environment is not configured to support act(...)" warning
// to stderr, drowning real diagnostic output.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
