/**
 * engine/__test_internals__.js — test-only re-export bridge.
 *
 * Plan 2026-05-08-005 Unit 2. Exposes `discoverPrompts` and `getPrompt`
 * (defined in `engine/index.js`) so the test suite can exercise them
 * without committing them to the package's curated public surface
 * (`lib/chatbox-core/index.js` barrel) prematurely.
 *
 * Production code MUST NOT import from this module. Build/publish
 * tooling treats `__test_internals__.js` as an internal artifact —
 * the underscore-prefixed naming convention follows the same opt-out
 * signal used elsewhere (e.g., the `_internal: true` message flag).
 */

export {
  discoverPrompts,
  getPrompt,
  EmptyPromptError,
} from "./index.js";
