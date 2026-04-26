/**
 * ContextUsageIndicator
 *
 * Small SVG ring that fills as the conversation approaches
 * the model's context window limit.
 *
 * Color thresholds:
 *   0–60%  green   — plenty of room
 *   60–80% amber   — approaching limit
 *   80%+   red     — near limit, trimming will occur
 */

export default function ContextUsageIndicator({ used, total }) {
  if (!total || total <= 0) return null;
  // Hide at 0% — the empty ring without context (no tokens used yet) reads as
  // a mystery UI element in a narrow sidebar. Only show when there's something
  // meaningful to communicate.
  if (!used || used <= 0) return null;

  const pct = Math.min((used / total) * 100, 100);
  const radius = 9;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (pct / 100) * circumference;

  const color =
    pct < 60 ? "#4caf50" : pct < 80 ? "#ff9800" : "#f44336";

  const label = `Context: ${used.toLocaleString()} / ${total.toLocaleString()} tokens (${Math.round(pct)}%)`;

  return (
    <div
      title={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "default",
        width: 24,
        height: 24,
      }}
    >
      <svg width="22" height="22" viewBox="0 0 22 22">
        <circle
          cx="11"
          cy="11"
          r={radius}
          fill="none"
          stroke="#e0e0e0"
          strokeWidth="3"
        />
        {pct > 0 && (
          <circle
            cx="11"
            cy="11"
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth="3"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            transform="rotate(-90 11 11)"
            style={{ transition: "stroke-dashoffset 0.3s ease" }}
          />
        )}
      </svg>
    </div>
  );
}
