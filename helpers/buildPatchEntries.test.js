/**
 * helpers/buildPatchEntries.test.js — unit coverage for the per-envelope
 * patch dispatch construction (Plan 20 #15).
 *
 * Locks the per-envelope semantics so a future refactor can't accidentally
 * re-introduce the merge-by-UUID shape.
 */

import { describe, expect, it } from "vitest";

import { buildPatchEntries } from "./buildPatchEntries.js";

describe("buildPatchEntries — per-envelope construction", () => {
  it("emits one entry per envelope when UUIDs differ", () => {
    const { entries, rejectedCollision } = buildPatchEntries(
      [
        { uuid: "A", source: "Plot", ops: [{ op: "replace", path: "/args/title", value: "X" }] },
        { uuid: "B", source: "Map", ops: [{ op: "add", path: "/args/zoom", value: 5 }] },
      ],
      {},
    );
    expect(entries).toHaveLength(2);
    expect(entries[0].uuid).toBe("A");
    expect(entries[1].uuid).toBe("B");
    expect(rejectedCollision).toEqual([]);
  });

  it("emits two entries for the same UUID when the engine returned two envelopes", () => {
    const { entries } = buildPatchEntries(
      [
        { uuid: "A", source: "Plot", ops: [{ op: "replace", path: "/args/title", value: "X" }] },
        { uuid: "A", source: "Plot", ops: [{ op: "replace", path: "/args/color", value: "red" }] },
      ],
      {},
    );
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.uuid === "A")).toBe(true);
    expect(entries[0].ops[0].path).toBe("/args/title");
    expect(entries[1].ops[0].path).toBe("/args/color");
  });

  it("preserves source per envelope (does not collapse)", () => {
    const { entries } = buildPatchEntries(
      [
        { uuid: "A", source: "Plot", ops: [{ op: "test", path: "/args/title", value: "X" }] },
        { uuid: "A", source: "Plot", ops: [{ op: "replace", path: "/args/title", value: "Y" }] },
      ],
      {},
    );
    expect(entries.map((e) => e.source)).toEqual(["Plot", "Plot"]);
  });
});

describe("buildPatchEntries — cross-source-collision rejection", () => {
  it("rejects a bare-index entry when a sibling layer-update exists on the same UUID", () => {
    const { entries, rejectedCollision } = buildPatchEntries(
      [
        {
          uuid: "M1",
          source: "Map",
          ops: [{ op: "remove", path: "/args/layers/2" }],
        },
      ],
      { M1: [{ name: "new layer" }] },
    );
    expect(entries).toEqual([]);
    expect(rejectedCollision).toEqual(["M1"]);
  });

  it("keeps a field-level patch entry on /args/layers/N/fieldName even with a sibling layer-update", () => {
    const { entries, rejectedCollision } = buildPatchEntries(
      [
        {
          uuid: "M1",
          source: "Map",
          ops: [{ op: "replace", path: "/args/layers/0/name", value: "Renamed" }],
        },
      ],
      { M1: [{ name: "new layer" }] },
    );
    expect(entries).toHaveLength(1);
    expect(rejectedCollision).toEqual([]);
  });

  it("rejects only the bare-index sibling — field-level same-UUID entries survive", () => {
    const { entries, rejectedCollision } = buildPatchEntries(
      [
        {
          uuid: "M1",
          source: "Map",
          ops: [{ op: "remove", path: "/args/layers/2" }], // bare-index → reject
        },
        {
          uuid: "M1",
          source: "Map",
          ops: [{ op: "replace", path: "/args/zoom", value: 7 }], // field-level → survive
        },
      ],
      { M1: [{ name: "new layer" }] },
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].ops[0].path).toBe("/args/zoom");
    expect(rejectedCollision).toEqual(["M1"]);
  });

  it("de-dups rejectedCollision when the same UUID is rejected multiple times", () => {
    const { rejectedCollision } = buildPatchEntries(
      [
        { uuid: "M1", source: "Map", ops: [{ op: "remove", path: "/args/layers/0" }] },
        { uuid: "M1", source: "Map", ops: [{ op: "remove", path: "/args/layers/1" }] },
      ],
      { M1: [{ name: "new layer" }] },
    );
    expect(rejectedCollision).toEqual(["M1"]);
  });

  it("does not reject when the UUID has no sibling layer-update (only chatbox-side context)", () => {
    const { entries, rejectedCollision } = buildPatchEntries(
      [
        {
          uuid: "M1",
          source: "Map",
          ops: [{ op: "remove", path: "/args/layers/2" }],
        },
      ],
      {}, // no sibling layer-update on M1
    );
    expect(entries).toHaveLength(1);
    expect(rejectedCollision).toEqual([]);
  });
});

describe("buildPatchEntries — degenerate inputs", () => {
  it("returns no entries for null rawPatches", () => {
    expect(buildPatchEntries(null, {})).toEqual({
      entries: [],
      rejectedCollision: [],
    });
  });

  it("returns no entries for undefined rawPatches", () => {
    expect(buildPatchEntries(undefined, {})).toEqual({
      entries: [],
      rejectedCollision: [],
    });
  });

  it("returns no entries for empty array", () => {
    expect(buildPatchEntries([], {})).toEqual({
      entries: [],
      rejectedCollision: [],
    });
  });

  it("drops envelopes with missing uuid", () => {
    const { entries } = buildPatchEntries(
      [
        { source: "Plot", ops: [{ op: "replace", path: "/args/title", value: "X" }] },
        { uuid: null, source: "Plot", ops: [{ op: "replace", path: "/args/title", value: "X" }] },
      ],
      {},
    );
    expect(entries).toEqual([]);
  });

  it("drops envelopes with non-array ops", () => {
    const { entries } = buildPatchEntries(
      [{ uuid: "A", source: "Plot", ops: null }],
      {},
    );
    expect(entries).toEqual([]);
  });

  it("drops envelopes with empty ops array (no-op)", () => {
    const { entries } = buildPatchEntries(
      [{ uuid: "A", source: "Plot", ops: [] }],
      {},
    );
    expect(entries).toEqual([]);
  });

  it("tolerates a missing layerUpdatesByUuid argument", () => {
    const { entries, rejectedCollision } = buildPatchEntries([
      { uuid: "A", source: "Plot", ops: [{ op: "replace", path: "/args/title", value: "X" }] },
    ]);
    expect(entries).toHaveLength(1);
    expect(rejectedCollision).toEqual([]);
  });
});
