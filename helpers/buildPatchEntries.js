/**
 * helpers/buildPatchEntries.js — pure construction of the
 * `tethysdash:update-visualization` `apply_patch` payload from the
 * engine's raw `state.pendingPatches` envelopes.
 *
 * Closes Plan 20 #15 (per-envelope atomicity). Each engine envelope
 * becomes its own entry; same UUID may appear multiple times so
 * envelope-N's apply failure does not poison envelope-N-1.
 *
 * Inputs:
 *   rawPatches — array of {uuid, source, ops} envelopes from the engine.
 *                Falsy / non-array → treated as empty.
 *   layerUpdatesByUuid — record of UUIDs that have a sibling
 *                `add_map_service_layer` update in this same turn. Used
 *                only for cross_source_collision detection.
 *
 * Output:
 *   {
 *     entries: [{uuid, source, ops}, ...]   // surviving entries to dispatch
 *     rejectedCollision: [uuid, uuid, ...]  // de-duped UUIDs whose
 *                                              bare-index ops collided with
 *                                              a sibling layer-update
 *   }
 *
 * Cross_source_collision: only entries with a bare-index path on
 * /args/layers (e.g. /args/layers/2 or /args/layers/-) on a UUID that
 * also has a sibling add_map_service_layer are rejected. Field-level
 * patches under a layer (/args/layers/N/fieldName) are fine.
 */

const BARE_LAYER_INDEX = /^\/args\/layers\/(\d+|-)$/;

export function buildPatchEntries(rawPatches, layerUpdatesByUuid) {
  const entries = [];
  if (Array.isArray(rawPatches)) {
    for (const patch of rawPatches) {
      const uuid = patch?.uuid;
      if (!uuid || !Array.isArray(patch.ops) || patch.ops.length === 0) continue;
      entries.push({ uuid, source: patch.source, ops: patch.ops });
    }
  }

  const surviving = [];
  const rejected = [];
  const layerUpdates = layerUpdatesByUuid || {};
  for (const entry of entries) {
    if (layerUpdates[entry.uuid]) {
      const hasBareIndexOp = entry.ops.some(
        (op) => typeof op?.path === "string" && BARE_LAYER_INDEX.test(op.path),
      );
      if (hasBareIndexOp) {
        rejected.push(entry.uuid);
        continue;
      }
    }
    surviving.push(entry);
  }

  return {
    entries: surviving,
    rejectedCollision: Array.from(new Set(rejected)),
  };
}
