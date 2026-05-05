// @vitest-environment jsdom
/**
 * storage/capabilityStorage.test.js — coverage for the auto-learn
 * override store.
 *
 * Plan 002 Unit 3: persists `(provider, model) → {toolUse: "unsupported", source: "auto-learned"}`
 * after N=2 consecutive observed failures, with TTL + schema-version
 * expiry. Provides the override that the engine's resolveModelCapability
 * consults before falling back to the model list / per-provider defaults.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CAPABILITY_SCHEMA_VERSION,
  TTL_MS,
  _resetForTests,
  clearExpired,
  clearOverride,
  getOverride,
  recordFailure,
  resetFailureCounter,
} from "./capabilityStorage.js";

describe("recordFailure (N=2 threshold)", () => {
  beforeEach(() => {
    _resetForTests();
  });

  it("does NOT persist on first failure", () => {
    const count = recordFailure("ollama", "gemma3:12b");
    expect(count).toBe(1);
    expect(getOverride("ollama", "gemma3:12b")).toBeNull();
  });

  it("persists auto-learned 'unsupported' on second consecutive failure", () => {
    recordFailure("ollama", "gemma3:12b");
    const count = recordFailure("ollama", "gemma3:12b");

    expect(count).toBe(2);
    const entry = getOverride("ollama", "gemma3:12b");
    expect(entry).not.toBeNull();
    expect(entry.toolUse).toBe("unsupported");
    expect(entry.source).toBe("auto-learned");
    expect(entry.consecutiveFailures).toBe(2);
    expect(entry.schemaVersion).toBe(CAPABILITY_SCHEMA_VERSION);
  });

  it("scopes counters to (provider, model) — different keys don't bleed", () => {
    recordFailure("ollama", "gemma3:12b");
    recordFailure("ollama", "llama3.2:latest"); // different model
    expect(getOverride("ollama", "gemma3:12b")).toBeNull();
    expect(getOverride("ollama", "llama3.2:latest")).toBeNull();
  });

  it("scopes counters per provider — same model on two providers tracked separately", () => {
    recordFailure("ollama", "claude-sonnet-4");
    recordFailure("anthropic", "claude-sonnet-4"); // different provider
    expect(getOverride("ollama", "claude-sonnet-4")).toBeNull();
    expect(getOverride("anthropic", "claude-sonnet-4")).toBeNull();
  });
});

describe("resetFailureCounter", () => {
  beforeEach(() => {
    _resetForTests();
  });

  it("prevents N=2 escalation when success interleaves failures", () => {
    recordFailure("ollama", "gemma3:12b"); // count = 1
    resetFailureCounter("ollama", "gemma3:12b"); // success — counter cleared
    const count = recordFailure("ollama", "gemma3:12b"); // count = 1 (reset)
    expect(count).toBe(1);
    expect(getOverride("ollama", "gemma3:12b")).toBeNull();
  });

  it("does not affect the persisted override (counter is in-session only)", () => {
    recordFailure("ollama", "gemma3:12b");
    recordFailure("ollama", "gemma3:12b"); // override persisted
    resetFailureCounter("ollama", "gemma3:12b"); // counter reset
    // Persisted override remains.
    expect(getOverride("ollama", "gemma3:12b")?.toolUse).toBe("unsupported");
  });
});

describe("getOverride — TTL and schema-version expiry", () => {
  beforeEach(() => {
    _resetForTests();
  });

  it("returns the override within TTL", () => {
    recordFailure("ollama", "gemma3:12b");
    recordFailure("ollama", "gemma3:12b");
    expect(getOverride("ollama", "gemma3:12b")).not.toBeNull();
  });

  it("treats an override past 30-day TTL as missing", () => {
    // Manually plant an expired entry.
    const stalePast = new Date(Date.now() - TTL_MS - 1000).toISOString();
    localStorage.setItem(
      "@chatbox/core:modelCapabilities:v1",
      JSON.stringify({
        "ollama|gemma3:12b": {
          toolUse: "unsupported",
          source: "auto-learned",
          at: stalePast,
          consecutiveFailures: 2,
          schemaVersion: CAPABILITY_SCHEMA_VERSION,
        },
      }),
    );
    expect(getOverride("ollama", "gemma3:12b")).toBeNull();
  });

  it("treats an override with mismatched schemaVersion as missing", () => {
    localStorage.setItem(
      "@chatbox/core:modelCapabilities:v1",
      JSON.stringify({
        "ollama|gemma3:12b": {
          toolUse: "unsupported",
          source: "auto-learned",
          at: new Date().toISOString(),
          consecutiveFailures: 2,
          schemaVersion: CAPABILITY_SCHEMA_VERSION + 99, // bumped
        },
      }),
    );
    expect(getOverride("ollama", "gemma3:12b")).toBeNull();
  });
});

describe("getOverride — schema validation", () => {
  beforeEach(() => {
    _resetForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drops entries with invalid toolUse value", () => {
    localStorage.setItem(
      "@chatbox/core:modelCapabilities:v1",
      JSON.stringify({
        "ollama|broken": {
          toolUse: "rocket", // invalid enum
          source: "auto-learned",
          at: new Date().toISOString(),
          schemaVersion: CAPABILITY_SCHEMA_VERSION,
        },
      }),
    );
    expect(getOverride("ollama", "broken")).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it("drops entries with invalid source value", () => {
    localStorage.setItem(
      "@chatbox/core:modelCapabilities:v1",
      JSON.stringify({
        "ollama|broken": {
          toolUse: "unsupported",
          source: "from-the-future", // invalid enum
          at: new Date().toISOString(),
          schemaVersion: CAPABILITY_SCHEMA_VERSION,
        },
      }),
    );
    expect(getOverride("ollama", "broken")).toBeNull();
  });

  it("returns null for missing entry without warning", () => {
    expect(getOverride("ollama", "missing")).toBeNull();
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe("clearOverride / clearExpired", () => {
  beforeEach(() => {
    _resetForTests();
  });

  it("clearOverride removes a specific entry", () => {
    recordFailure("ollama", "gemma3:12b");
    recordFailure("ollama", "gemma3:12b");
    expect(getOverride("ollama", "gemma3:12b")).not.toBeNull();

    clearOverride("ollama", "gemma3:12b");
    expect(getOverride("ollama", "gemma3:12b")).toBeNull();
  });

  it("clearExpired removes all expired/invalid entries and reports the count", () => {
    const stalePast = new Date(Date.now() - TTL_MS - 1000).toISOString();
    const fresh = new Date().toISOString();
    localStorage.setItem(
      "@chatbox/core:modelCapabilities:v1",
      JSON.stringify({
        "ollama|expired": {
          toolUse: "unsupported", source: "auto-learned",
          at: stalePast, schemaVersion: CAPABILITY_SCHEMA_VERSION,
        },
        "ollama|invalid": { toolUse: "rocket", source: "user", at: fresh, schemaVersion: CAPABILITY_SCHEMA_VERSION },
        "ollama|fresh": {
          toolUse: "unsupported", source: "auto-learned",
          at: fresh, schemaVersion: CAPABILITY_SCHEMA_VERSION,
        },
      }),
    );
    const removed = clearExpired();
    expect(removed).toBe(2);
    expect(getOverride("ollama", "fresh")).not.toBeNull();
    expect(getOverride("ollama", "expired")).toBeNull();
    expect(getOverride("ollama", "invalid")).toBeNull();
  });
});

describe("fail-open behavior when localStorage is unavailable", () => {
  beforeEach(() => {
    _resetForTests();
  });

  it("recordFailure throwing on localStorage write does not crash", () => {
    // Force localStorage.setItem to throw.
    const origSetItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    expect(() => {
      recordFailure("ollama", "gemma3:12b");
      recordFailure("ollama", "gemma3:12b");
    }).not.toThrow();

    // Override falls through to the in-memory fallback Map and is still
    // readable within this session.
    const entry = getOverride("ollama", "gemma3:12b");
    expect(entry?.toolUse).toBe("unsupported");

    localStorage.setItem = origSetItem;
  });
});
