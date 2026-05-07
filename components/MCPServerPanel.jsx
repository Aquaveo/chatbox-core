import { useEffect, useMemo, useRef, useState } from "react";
import styled from "styled-components";
import McpStatusDot from "./McpStatusDot.jsx";
import { copyFor } from "../engine/mcpErrors.js";

const Panel = styled.div`
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
`;

const Header = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: ${({ theme }) => `${theme.spacing.lg} ${theme.spacing.xl}`};
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  flex-shrink: 0;
`;

const Title = styled.span`
  font-weight: 600;
  font-size: ${({ theme }) => theme.fontSize.lg};
  color: ${({ theme }) => theme.colors.text};
`;

const CloseBtn = styled.button`
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 1.2rem;
  line-height: 1;
  &:hover {
    color: ${({ theme }) => theme.colors.text};
  }
`;

const ServerList = styled.div`
  flex: 1;
  overflow-y: auto;
  padding: ${({ theme }) => theme.spacing.lg};
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.spacing.md};
`;

const ServerCard = styled.div`
  display: flex;
  align-items: flex-start;
  gap: ${({ theme }) => theme.spacing.md};
  padding: ${({ theme }) => theme.spacing.lg};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.surface};
`;

const DotSlot = styled.div`
  margin-top: 2px;
  flex-shrink: 0;
  cursor: ${(props) => (props.$clickable ? "pointer" : "default")};
`;

const ServerInfo = styled.div`
  flex: 1;
  min-width: 0;
`;

const ServerName = styled.div`
  font-weight: 600;
  font-size: ${({ theme }) => theme.fontSize.base};
  color: ${({ theme }) => theme.colors.text};
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.spacing.xs};
`;

const DefaultBadge = styled.span`
  font-size: 0.7rem;
  font-weight: 500;
  color: ${({ theme }) => theme.colors.primary};
  background: ${({ theme }) => theme.colors.primaryLight};
  padding: 1px 6px;
  border-radius: ${({ theme }) => theme.radius.full};
`;

const ServerUrl = styled.div`
  font-size: ${({ theme }) => theme.fontSize.sm};
  color: ${({ theme }) => theme.colors.textMuted};
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

// Error / warning line under the URL. Wraps to accommodate the inline retry
// button; row height grows naturally. Red rows get error copy + retry; orange
// rows get the no-tools informational copy (no retry).
const StatusLine = styled.div`
  margin-top: ${({ theme }) => theme.spacing.xs};
  font-size: ${({ theme }) => theme.fontSize.sm};
  color: ${(props) =>
    props.$variant === "error"
      ? props.theme.colors.error
      : props.theme.colors.textStatus};
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.spacing.sm};
  flex-wrap: wrap;
`;

const RetryButton = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  min-height: 32px;
  padding: 0;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.surface};
  color: ${({ theme }) => theme.colors.textMuted};
  cursor: pointer;
  line-height: 1;
  font-size: 1rem;
  &:hover:not(:disabled) {
    color: ${({ theme }) => theme.colors.primary};
    border-color: ${({ theme }) => theme.colors.primary};
  }
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

const RemoveBtn = styled.button`
  background: none;
  border: none;
  cursor: pointer;
  color: ${({ theme }) => theme.colors.textMuted};
  padding: 2px;
  flex-shrink: 0;
  &:hover {
    color: ${({ theme }) => theme.colors.error};
  }
`;

const AddForm = styled.form`
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.spacing.sm};
  padding: ${({ theme }) => theme.spacing.lg};
  border-top: 1px solid ${({ theme }) => theme.colors.border};
  flex-shrink: 0;
`;

const Input = styled.input`
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};
  padding: ${({ theme }) => `${theme.spacing.sm} ${theme.spacing.md}`};
  font-size: ${({ theme }) => theme.fontSize.sm};
  outline: none;
  &:focus {
    border-color: ${({ theme }) => theme.colors.primary};
  }
`;

const FormError = styled.div`
  font-size: ${({ theme }) => theme.fontSize.sm};
  color: ${({ theme }) => theme.colors.error};
`;

const FormHint = styled.div`
  font-size: ${({ theme }) => theme.fontSize.sm};
  color: ${({ theme }) => theme.colors.textMuted};
`;

const AddButton = styled.button`
  border: none;
  border-radius: ${({ theme }) => theme.radius.sm};
  padding: ${({ theme }) => `${theme.spacing.sm} ${theme.spacing.lg}`};
  font-size: ${({ theme }) => theme.fontSize.sm};
  font-weight: 600;
  color: ${({ theme }) => theme.colors.surface};
  background: ${({ theme }) => theme.colors.primary};
  cursor: pointer;
  align-self: flex-start;
  &:hover {
    background: ${({ theme }) => theme.colors.primaryHover};
  }
  &:disabled {
    background: ${({ theme }) => theme.colors.sendDisabled};
    cursor: not-allowed;
  }
`;

const EmptyText = styled.p`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.fontSize.sm};
  text-align: center;
  padding: ${({ theme }) => theme.spacing.xl};
`;

// D1 — credential-stripped inline alert. Softer than ChatErrorPanel's
// role="alert" because sanitization succeeded; we're informing the user
// that their pasted credentials were silently removed before save.
const DismissibleAlert = styled.div`
  display: flex;
  align-items: flex-start;
  gap: ${({ theme }) => theme.spacing.sm};
  margin: ${({ theme }) => `0 ${theme.spacing.lg} ${theme.spacing.md}`};
  padding: ${({ theme }) => theme.spacing.md};
  border: 1px solid ${({ theme }) => theme.colors.thinkingBorder};
  background: ${({ theme }) => theme.colors.thinking};
  color: ${({ theme }) => theme.colors.thinkingText};
  border-radius: ${({ theme }) => theme.radius.sm};
  font-size: ${({ theme }) => theme.fontSize.sm};
`;

const AlertBody = styled.div`
  flex: 1;
  min-width: 0;
`;

const AlertDismissBtn = styled.button`
  background: none;
  border: none;
  cursor: pointer;
  color: inherit;
  font-size: 1.1rem;
  line-height: 1;
  padding: 0 ${({ theme }) => theme.spacing.xs};
  &:hover {
    opacity: 0.7;
  }
`;

// Visually hidden region for the panel-level aria-live summary (B16).
// Positioned absolutely so screen readers still pick it up but the layout
// doesn't shift; we intentionally don't render the summary visibly.
const VisuallyHiddenLive = styled.div`
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
`;

const ARIA_LIVE_DEBOUNCE_MS = 500;
const RECOMMENDED_ENABLED_SERVERS = 5;

/**
 * Map internal scheduler state (from the probe scheduler's onUpdate and
 * the scheduler-emitted `grey` on cancel) to the 5-state UI alphabet.
 * Disabled servers and servers without a probe entry default to grey.
 */
function statusFor(server, statusMap) {
  // Disabled servers and callers passing raw userServers entries without
  // the flag both show grey — matches "not probing, not reporting" intent.
  if (!server?.enabled) return "grey";

  const entry = statusMap?.get?.(server.url);
  if (!entry) return "grey";

  switch (entry.state) {
    case "yellow":
      return "yellow";
    case "connected":
      return "green";
    case "no-tools":
      return "orange";
    case "failed":
      return "red";
    case "grey":
    case "disabled":
    default:
      return "grey";
  }
}

function summarizeEnabled(servers, statusMap) {
  let connected = 0;
  let noTools = 0;
  let failed = 0;
  let checking = 0;
  let total = 0;
  for (const server of servers) {
    if (server.enabled === false) continue;
    total += 1;
    const ui = statusFor(server, statusMap);
    if (ui === "green") connected += 1;
    else if (ui === "orange") noTools += 1;
    else if (ui === "red") failed += 1;
    else if (ui === "yellow") checking += 1;
  }
  if (total === 0) return "";
  const parts = [`${connected} of ${total} servers connected`];
  if (noTools > 0) parts.push(`${noTools} with no tools`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (checking > 0) parts.push(`${checking} checking`);
  return parts.join(", ");
}

export default function MCPServerPanel({
  defaultServers,
  userServers,
  onAdd,
  onRemove,
  onToggle,
  onClose,
  statusMap,
  onRetry,
  onPanelOpen,
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [formError, setFormError] = useState("");
  const [showCredentialAlert, setShowCredentialAlert] = useState(false);
  const [liveSummary, setLiveSummary] = useState("");
  // Sticky-dismiss for the over-recommended notice. Resets only when
  // the user crosses the threshold from below — so a user who dismisses
  // and then enables another server gets the alert again. Closing and
  // reopening the panel also resets (state is local to the mount).
  const [overRecommendedDismissed, setOverRecommendedDismissed] = useState(false);

  // B16: fire onPanelOpen once per mount. Chatbox owns the "have we probed
  // this session" logic — the panel just announces the mount.
  useEffect(() => {
    onPanelOpen?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const allServers = useMemo(
    () => [
      ...defaultServers.map((s) => ({ ...s, isDefault: true, enabled: true })),
      ...userServers,
    ],
    [defaultServers, userServers],
  );

  const enabledCount = allServers.filter((s) => s.enabled !== false).length;
  const overRecommended = enabledCount > RECOMMENDED_ENABLED_SERVERS;

  // Re-arm the dismiss when the user falls back below the threshold,
  // so the next time they cross it the alert returns.
  const wasOverRef = useRef(overRecommended);
  useEffect(() => {
    if (wasOverRef.current && !overRecommended) {
      setOverRecommendedDismissed(false);
    }
    wasOverRef.current = overRecommended;
  }, [overRecommended]);

  // B16 — trailing 500 ms debounce on statusMap changes. Only enabled
  // servers are summarized so disabling a server doesn't cause an
  // announcement. The summary is re-computed inside the timeout to pick
  // up the latest statusMap snapshot via closure capture.
  const debounceRef = useRef(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setLiveSummary(summarizeEnabled(allServers, statusMap));
      debounceRef.current = null;
    }, ARIA_LIVE_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [statusMap, allServers]);

  const handleAdd = (e) => {
    e.preventDefault();
    if (!url.trim()) return;
    const result = onAdd({ url: url.trim(), name: name.trim() });

    // URL rejected by validateServerUrl. The legacy `invalidScheme` flag is
    // preserved as a generic "rejected" boolean; `errorKey` carries the
    // specific reason (invalid-scheme, mixed-content, private-ip) so the
    // form error renders the targeted copy from the shared B8 error table.
    if (result?.sanitize?.invalidScheme) {
      const errorKey = result.sanitize.errorKey;
      const message = errorKey
        ? copyFor(errorKey)
        : "Invalid URL — must be http:// or https://";
      setFormError(message);
      return;
    }

    // Add refused without a scheme error → URL already exists. Tell the
    // user why their input is still in the form rather than silently
    // clearing it (review #8).
    if (!result?.added) {
      setFormError("This server URL is already configured.");
      return;
    }

    // Successful add with stripped credentials → D1 alert.
    if (result.sanitize?.stripped) {
      setShowCredentialAlert(true);
    } else {
      // Clean add clears any stale credential alert from a prior add.
      setShowCredentialAlert(false);
    }

    setFormError("");
    setName("");
    setUrl("");
  };

  return (
    <Panel>
      <Header>
        <Title>MCP Servers</Title>
        <CloseBtn onClick={onClose} aria-label="Close MCP panel">&times;</CloseBtn>
      </Header>

      {/*
        B16 aria-live region — visually hidden, trailing-debounced summary.
        role="status" + aria-live="polite" avoids interrupting the user
        mid-typing. aria-atomic ensures the whole summary is re-read on
        change (otherwise only diffs would be announced).
      */}
      <VisuallyHiddenLive role="status" aria-live="polite" aria-atomic="true">
        {liveSummary}
      </VisuallyHiddenLive>

      {overRecommended && !overRecommendedDismissed && (
        <DismissibleAlert role="status">
          <AlertBody>
            {enabledCount} servers enabled. We recommend at most{" "}
            {RECOMMENDED_ENABLED_SERVERS} for reliable tool selection — every
            connected server adds tools to each request, which can crowd the
            model's context and degrade quality. Disable the ones you don't
            need for this task.
          </AlertBody>
          <AlertDismissBtn
            onClick={() => setOverRecommendedDismissed(true)}
            aria-label="Dismiss server-count notice"
            title="Dismiss"
          >
            &times;
          </AlertDismissBtn>
        </DismissibleAlert>
      )}

      {showCredentialAlert && (
        <DismissibleAlert role="status">
          <AlertBody>
            Credentials were removed from the URL before saving. Use an MCP
            server that supports header-based auth or a signed URL for
            production setups.
          </AlertBody>
          <AlertDismissBtn
            onClick={() => setShowCredentialAlert(false)}
            aria-label="Dismiss credential-removed notice"
            title="Dismiss"
          >
            &times;
          </AlertDismissBtn>
        </DismissibleAlert>
      )}

      <ServerList>
        {allServers.length === 0 && (
          <EmptyText>No MCP servers configured. Add one below.</EmptyText>
        )}
        {allServers.map((server) => {
          const uiState = statusFor(server, statusMap);
          const entry = statusMap?.get?.(server.url);
          const errorKey = entry?.errorKey;
          const showError = uiState === "red";
          const showNoTools = uiState === "orange";
          const retryDisabled = uiState === "yellow";
          return (
            <ServerCard key={server.url}>
              <DotSlot
                $clickable={!server.isDefault}
                onClick={() => !server.isDefault && onToggle(server.url)}
                title={
                  server.isDefault
                    ? "Default server (always enabled)"
                    : server.enabled !== false
                      ? "Click to disable"
                      : "Click to enable"
                }
              >
                <McpStatusDot state={uiState} serverName={server.name || server.url} />
              </DotSlot>
              <ServerInfo>
                <ServerName>
                  {server.name || server.url}
                  {server.isDefault && <DefaultBadge>default</DefaultBadge>}
                </ServerName>
                <ServerUrl title={server.url}>{server.url}</ServerUrl>
                {showError && (
                  <StatusLine $variant="error">
                    <span>{copyFor(errorKey)}</span>
                    <RetryButton
                      type="button"
                      onClick={() => onRetry?.(server.url)}
                      disabled={retryDisabled}
                      aria-label={`Retry connection to ${server.name || server.url}`}
                      title="Retry connection"
                    >
                      <span aria-hidden="true">&#x21bb;</span>
                    </RetryButton>
                  </StatusLine>
                )}
                {showNoTools && (
                  <StatusLine $variant="info">
                    <span>
                      Connected; this server exposes no tools. (Valid if the
                      server only provides prompts or resources.)
                    </span>
                  </StatusLine>
                )}
              </ServerInfo>
              {!server.isDefault && (
                <RemoveBtn
                  onClick={() => onRemove(server.url)}
                  aria-label={`Remove ${server.name || server.url}`}
                  title="Remove server"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
                  </svg>
                </RemoveBtn>
              )}
            </ServerCard>
          );
        })}
      </ServerList>

      <AddForm onSubmit={handleAdd}>
        <Input
          placeholder="Server name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          placeholder="Server URL (e.g., http://localhost:9000/sse)"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
          aria-invalid={formError ? "true" : "false"}
        />
        {formError && <FormError role="alert">{formError}</FormError>}
        <FormHint>Tip: append /sse or /mcp to skip fallback detection.</FormHint>
        <FormHint>
          Heads up: model context is finite. Each connected server adds tools
          to every request, and tool-selection quality drops as the catalog
          grows. We recommend keeping it to ~{RECOMMENDED_ENABLED_SERVERS}{" "}
          servers — only enable the ones you need for the current task.
        </FormHint>
        <AddButton type="submit" disabled={!url.trim()}>
          + Add Server
        </AddButton>
      </AddForm>
    </Panel>
  );
}
