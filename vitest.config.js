/**
 * vitest.config.js — chatbox-core unit-test runner.
 *
 * Pinned to vitest ^3.0 (verify with `cat node_modules/vitest/package.json`).
 * Major-version drifts change `vi.useFakeTimers` defaults, mock-reset
 * behavior, and pool configuration, so the explicit configuration here
 * doesn't rely on undocumented defaults.
 *
 * vitest reads vite.config.js automatically for resolver + transform
 * pipeline. The plugins (react()) are picked up implicitly. This file
 * exists only for the test-specific overrides below.
 *
 * NOTE: keep this file in sync with the test infrastructure plan
 * docs/plans/2026-04-26-002-feat-chatbox-core-test-infrastructure-plan.md
 * — the per-test teardown flags below are load-bearing for the destroyed-
 * flag, NODE_ENV, and window.location stubbing patterns described there.
 */

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Explicitly include the React plugin so JSX in test files (and the
  // .jsx production files they import) compiles with the automatic
  // runtime. vitest reads vite.config.js for resolver/transform but the
  // `build.lib` entry block there does not propagate the plugin to the
  // test pipeline reliably; declaring it here is the lightweight fix.
  plugins: [react()],
  test: {
    // Default to node — pure-helper tests (helpers/url.test.js) don't need
    // a DOM and node is faster. Tests that touch window.location should
    // declare `// @vitest-environment jsdom` at the top of the test file
    // (see engine/transports.test.js and engine/probe.test.js once Units 4
    // and 5 land). vitest 3.x deprecated environmentMatchGlobs; the
    // per-file directive is the modern convention.
    environment: "node",

    // Co-located test files. Excludes dist/ and node_modules implicitly.
    include: ["**/*.test.{js,jsx}"],
    exclude: ["dist/**", "node_modules/**"],

    // Setup hook — runs before each test file. Bridges Node 22+'s
    // built-in `localStorage` (an empty `{}`) to jsdom's real Storage
    // object so legacy bare-`localStorage` references work under
    // `// @vitest-environment jsdom`. See test-setup.js for the why.
    setupFiles: ["./test-setup.js"],

    // Per-test teardown — the load-bearing config that prevents stubs from
    // leaking across tests within the same worker. vitest defaults vary by
    // major; setting these explicitly makes the test contract auditable.
    restoreMocks: true,
    clearMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
  },
});
