/**
 * test-helpers/sdkMocks.js — SDK version drift guard.
 *
 * VERIFIED AGAINST: @modelcontextprotocol/sdk@1.27.0 (matches the caret
 * range `^1.27.0` in chatbox-core/package.json).
 *
 * When bumping the SDK version:
 *   1. Update SDK_VERSION_VERIFIED below to the new pinned version.
 *   2. Run `npm run test`. The drift meta-test at the bottom of
 *      engine/transports.test.js asserts the expected named exports are
 *      still present on the real SDK module — if the SDK renames or
 *      removes one, that test fails loudly.
 *   3. If the test fails, audit transports.js / probe.js / engine/index.js
 *      for callers of the renamed export and update accordingly.
 *
 * This file does NOT itself contain mocks — vitest's `vi.mock()` factories
 * must be inline in test files (hoisted before non-vi imports). This
 * file's role is to document what's mocked and why, and to centralize the
 * SDK-version contract.
 */

/** Pinned SDK version the mocks were verified against. */
export const SDK_VERSION_VERIFIED = "1.27.0";

/**
 * Named exports the source code uses. Any new import in transports.js,
 * probe.js, or engine/index.js that references the SDK should be added to
 * this list, and the corresponding `vi.mock()` factory in the relevant
 * test file should add the named export to its mocked module.
 */
export const SDK_EXPECTED_EXPORTS = Object.freeze({
  "@modelcontextprotocol/sdk/client": ["Client"],
  "@modelcontextprotocol/sdk/client/sse": ["SSEClientTransport"],
  "@modelcontextprotocol/sdk/client/streamableHttp": ["StreamableHTTPClientTransport"],
});
