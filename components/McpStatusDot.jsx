/**
 * McpStatusDot — presentational 5-state MCP server status indicator.
 *
 * Props:
 *   - state: "grey" | "yellow" | "green" | "orange" | "red"
 *       Anything else (undefined, unknown string) is treated as "grey".
 *   - serverName: optional string used to personalize the aria-label so
 *     screen readers distinguish repeated status-change announcements
 *     across rows. Absent → the shared state-only label is used.
 *
 * Icon shape (not color alone) is distinguishable per B6:
 *   - grey   → empty circle stroke
 *   - yellow → dashed circle with CSS rotation (probing)
 *   - green  → check inside filled circle (connected)
 *   - orange → info glyph (neutral notice: connected but no tools)
 *   - red    → X inside filled circle (failed)
 *
 * The scheduler owns the 400 ms yellow-min-display smoothing (see
 * engine/probe.js) — this component has no internal timers.
 */

import styled, { keyframes } from "styled-components";

const STATE_LABELS = Object.freeze({
  grey: "Status: disabled",
  yellow: "Status: checking connection",
  green: "Status: connected",
  orange: "Status: connected but no tools",
  red: "Status: connection failed",
});

const STATE_COLORS = Object.freeze({
  grey: "#bbb",
  yellow: "#e5a100",
  green: "#4caf50",
  orange: "#e07b1f",
  red: "#d03f3f",
});

function normalizeState(state) {
  return Object.prototype.hasOwnProperty.call(STATE_LABELS, state) ? state : "grey";
}

const rotate = keyframes`
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
`;

const DotWrapper = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: ${(props) => STATE_COLORS[props.$state] || STATE_COLORS.grey};
  line-height: 0;
`;

const SpinningSvg = styled.svg`
  width: 100%;
  height: 100%;
  animation: ${rotate} 1s linear infinite;
`;

const StaticSvg = styled.svg`
  width: 100%;
  height: 100%;
`;

function IconForState({ state }) {
  switch (state) {
    case "grey":
      // Empty circle stroke
      return (
        <StaticSvg viewBox="0 0 16 16">
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
        </StaticSvg>
      );
    case "yellow":
      // Dashed rotating circle (probing). stroke-dasharray makes the dashes;
      // the keyframe rotates the whole svg.
      return (
        <SpinningSvg viewBox="0 0 16 16">
          <circle
            cx="8"
            cy="8"
            r="6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeDasharray="3 3"
            strokeLinecap="round"
          />
        </SpinningSvg>
      );
    case "green":
      // Filled circle with inset check
      return (
        <StaticSvg viewBox="0 0 16 16">
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path
            d="M4.5 8.2 L7 10.7 L11.5 5.8"
            fill="none"
            stroke="#ffffff"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </StaticSvg>
      );
    case "orange":
      // Info glyph: open circle, vertical "i" stem + dot (neutral notice,
      // NOT an alert triangle — "no tools" is informational).
      return (
        <StaticSvg viewBox="0 0 16 16">
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <circle cx="8" cy="4.5" r="1.1" fill="#ffffff" />
          <rect x="7" y="6.8" width="2" height="5.2" rx="0.6" fill="#ffffff" />
        </StaticSvg>
      );
    case "red":
      // Filled circle with inset X
      return (
        <StaticSvg viewBox="0 0 16 16">
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path
            d="M5 5 L11 11 M11 5 L5 11"
            stroke="#ffffff"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </StaticSvg>
      );
    default:
      return null;
  }
}

export default function McpStatusDot({ state, serverName }) {
  const resolved = normalizeState(state);
  const baseLabel = STATE_LABELS[resolved];
  const ariaLabel = serverName ? `${serverName} — ${baseLabel}` : baseLabel;
  return (
    <DotWrapper $state={resolved} role="img" aria-label={ariaLabel}>
      <IconForState state={resolved} />
    </DotWrapper>
  );
}
