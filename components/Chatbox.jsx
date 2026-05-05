/**
 * Chatbox — Generic chatbox component.
 *
 * A complete, self-contained chat interface that works with any MCP server.
 * Consumers render this with minimal config. Domain-specific behavior
 * (NRDS tools, panel creation) is injected via `engineExtensions` and `onResult` props.
 *
 * Usage (generic sidebar):
 *   <Chatbox />
 *
 * Usage (NRDS MFE with extensions):
 *   <Chatbox
 *     engineExtensions={{ systemPromptBuilder, toolCategories, ... }}
 *     onResult={(result) => publishToVariables(result)}
 *   />
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styled, { ThemeProvider } from "styled-components";
import chatTheme from "../theme/index.js";
import { runChatSession } from "../engine/index.js";
import { createProbeScheduler } from "../engine/probe.js";
import { validateServerUrl } from "../engine/transports.js";
import { listModels } from "../helpers/index.js";
import { estimateTokens } from "../conversation/index.js";
import { CONTEXT_BUDGET_RATIO } from "../config/index.js";
import { getMcpServers, addMcpServer, removeMcpServer, toggleMcpServer } from "../storage/mcpStorage.js";
import { sanitizeServerName, stripUrlCredentials } from "../helpers/url.js";
import { buildMcpStatusMessage } from "../helpers/buildMcpStatusMessage.js";
import { scheduleDispatchIfFresh } from "../helpers/scheduleDispatch.js";
import { buildPatchEntries } from "../helpers/buildPatchEntries.js";
import { _buildDispatchBanner } from "./dispatchBanner.js";
import { getProviderConfig } from "../storage/llmProviderStorage.js";
import ChatLog from "./ChatLog";
import ChatInputBar from "./ChatInputBar";
import ChatErrorPanel from "./ChatErrorPanel";
import MCPServerPanel from "./MCPServerPanel";
import LLMProviderPanel from "./LLMProviderPanel.jsx";

const REQUIRED_MODEL_CAPABILITIES = ["tools"];

const ADD_VISUALIZATION_EVENT = "tethysdash:add-visualization";

// R16 — parse a patch_visualization error string into its allowed-prefixes
// hint. The server formats errors as:
//     `whitelist_rejected: op N path '/args/x' is not editable for viz
//     source 'X'. ... one of the allowed prefixes for this source: [...]`
// We extract the bracketed list to tell the "plugin not opted in" bucket
// (empty []) from the "here's what IS editable" bucket (non-empty).
export function _parseAllowedPrefixesFromError(errStr) {
  if (typeof errStr !== "string") return null;
  const match = errStr.match(/allowed prefixes for this source: (\[[^\]]*\])/);
  if (!match) return null;
  try {
    return JSON.parse(match[1].replace(/'/g, '"'));
  } catch {
    return null;
  }
}

// R16 — compose a user-facing warning from server-side rejection events.
// Collapses every whitelist_rejected error into two buckets per the
// simplified D1 scope. Returns the empty string when there's nothing to
// surface (no rejections or only benign errors).
export function _buildWhitelistWarning(rejectedPatches) {
  if (!Array.isArray(rejectedPatches) || rejectedPatches.length === 0) return "";
  const notEditableFromChat = []; // bucket 1
  const pathsBySource = new Map(); // bucket 2 — source -> Set of paths
  for (const entry of rejectedPatches) {
    const err = entry?.error || "";
    if (!err.includes("whitelist_rejected")) continue;
    const allowed = _parseAllowedPrefixesFromError(err);
    const source = entry?.args?.source || "this tile";
    if (!allowed || allowed.length === 0) {
      notEditableFromChat.push(source);
    } else {
      if (!pathsBySource.has(source)) pathsBySource.set(source, new Set());
      for (const p of allowed) pathsBySource.get(source).add(p);
    }
  }
  const parts = [];
  if (notEditableFromChat.length > 0) {
    const unique = Array.from(new Set(notEditableFromChat));
    parts.push(
      `⚠ That field isn't editable from chat. You may need to edit this ` +
        `tile manually via the edit modal. (${unique.join(", ")})\n\n`,
    );
  }
  if (pathsBySource.size > 0) {
    const lines = [];
    for (const [source, paths] of pathsBySource) {
      const pathList = Array.from(paths).sort().join(", ");
      lines.push(`  • ${source}: ${pathList}`);
    }
    parts.push(
      `⚠ That field isn't editable from chat. Editable fields for the ` +
        `targeted tile(s):\n${lines.join("\n")}\n\n`,
    );
  }
  return parts.join("");
}

const Shell = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  height: 100%;
  padding: 0.75rem;
  box-sizing: border-box;
  overflow: hidden;
  justify-content: ${(props) => (props.$hasMessages ? "flex-start" : "flex-start")};
  align-items: ${(props) => (props.$hasMessages ? "stretch" : "center")};
`;

const WelcomeInputWrapper = styled.div`
  width: 100%;
  max-width: 700px;
`;

const Welcome = styled.div`
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  width: 100%;
  max-width: 700px;
  padding: 1rem;
  box-sizing: border-box;
  color: ${({ theme }) => theme.colors.textMuted};
  text-align: center;
`;

const WelcomeHeading = styled.div`
  font-size: 1rem;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
`;

const WelcomeSub = styled.div`
  font-size: 0.85rem;
  line-height: 1.4;
`;

const SuggestedPromptList = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.4rem;
  margin-top: 0.25rem;
`;

const SuggestedPromptChip = styled.button`
  border: 1px solid ${({ theme }) => theme.colors.border};
  background: transparent;
  color: ${({ theme }) => theme.colors.text};
  border-radius: ${({ theme }) => theme.radius.full};
  padding: 0.35rem 0.75rem;
  font-size: 0.8rem;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;

  &:hover {
    background: ${({ theme }) => theme.colors.borderHover};
    border-color: ${({ theme }) => theme.colors.primary};
  }
`;

const DEFAULT_SUGGESTED_PROMPTS = [
  "What can you do?",
  "Help me get started",
];

export default function Chatbox({
  thinkingEnabled = false,
  model = "qwen3",
  modelOptions,
  prompt = "",
  csrfToken,
  mcpServerUrl,
  mcpServers: propMcpServers,
  variableInputValues,
  updateVariableInputValues,
  engineExtensions = {},
  onResult,
  resolveVisualizationUrl,
  MessageRenderer,
  welcomeHeading = "Ask me anything",
  welcomeSubtitle = "I can call tools from your connected MCP servers to help you build and edit.",
  suggestedPrompts = DEFAULT_SUGGESTED_PROMPTS,
}) {
  const isEmbedded = typeof updateVariableInputValues === "function";
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState(prompt);
  const [thinkingBuffer, setThinkingBuffer] = useState("");
  const [contentBuffer, setContentBuffer] = useState("");
  const [selectedModel, setSelectedModel] = useState(model);
  const [isThinkingEnabled, setIsThinkingEnabled] = useState(Boolean(thinkingEnabled));
  const [loading, setLoading] = useState(false);
  const [toolStatus, setToolStatus] = useState(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [discoveredModels, setDiscoveredModels] = useState([]);
  const [error, setError] = useState("");
  const [showMcpPanel, setShowMcpPanel] = useState(false);
  const [providerConfig, setProviderConfig] = useState(() => getProviderConfig());
  const [showProviderPanel, setShowProviderPanel] = useState(false);
  const [userMcpServers, setUserMcpServers] = useState(() => getMcpServers());
  const engineMessagesRef = useRef([]);
  // Plan 002 R2 — dedup the "tools off" session notice across turns within
  // the same browser session. Keyed by `<provider>|<model>|<source>` so a
  // mid-session reclassification (e.g., auto-learn promotion to
  // "auto-learned" source) fires a fresh notice. Resets on full page
  // reload (acceptable; notice fatigue mitigated by Set + ref persistence
  // across React 18 strict-mode double-renders and Chatbox unmount).
  const sessionNoticeSeenRef = useRef(new Set());
  const [contextUsage, setContextUsage] = useState({ used: 0, total: 0 });

  // MCP health-probe state (Unit 4). The Map is the single source of truth
  // for per-server status rendering; the scheduler is instantiated lazily
  // so consumers that never open the panel never pay the allocation.
  const [mcpStatus, setMcpStatus] = useState(new Map());
  const hasProbedThisSessionRef = useRef(new Set());
  const schedulerRef = useRef(null);

  const configuredModels = useMemo(
    () => {
      const opts = Array.isArray(modelOptions) && modelOptions.length ? modelOptions : [model];
      return opts;
    },
    [modelOptions, model],
  );

  const availableModels = useMemo(() => {
    const seen = new Set();
    return discoveredModels.filter((m) => {
      if (!m?.name || seen.has(m.name)) return false;
      seen.add(m.name);
      return true;
    });
  }, [discoveredModels]);

  // Merge prop-provided MCP servers with user-configured from localStorage.
  //
  // Prop-supplied servers are filtered through `validateServerUrl` so a
  // malicious or misconfigured project default cannot inject `file://`,
  // `http://internal-ip`, AWS-IMDS-style link-local addresses, etc. (review
  // SSRF deferral). In production builds the literal-IP guard rejects
  // private/loopback/link-local hosts; dev builds allow them so
  // `http://localhost:9001` works during development.
  //
  // Rejected URLs are logged with credentials redacted via
  // `stripUrlCredentials` — a userinfo-bearing default like
  // `https://user:pass@bad/` does not leak its password into the console.
  const defaultMcpServers = useMemo(() => {
    const candidates = Array.isArray(propMcpServers) && propMcpServers.length > 0
      ? propMcpServers
      : (mcpServerUrl ? [{ url: mcpServerUrl, name: "Default" }] : []);

    const accepted = [];
    for (const candidate of candidates) {
      const validation = validateServerUrl(candidate?.url);
      if (validation.ok) {
        accepted.push({ ...candidate, url: validation.normalizedUrl });
      } else {
        const safeUrl = stripUrlCredentials(candidate?.url ?? "");
        // eslint-disable-next-line no-console
        console.warn(
          `MCP server rejected: ${safeUrl} (${validation.errorKey})`,
        );
      }
    }
    return accepted;
  }, [propMcpServers, mcpServerUrl]);

  const allMcpServers = useMemo(() => {
    // Defaults come from props; sanitize their display names so non-JSX
    // render paths (logging, future analytics) never see caller-supplied
    // HTML. User-added names are sanitized at persistence in addMcpServer.
    const defaults = defaultMcpServers.map((s) => ({
      ...s,
      name: sanitizeServerName(s.name) || s.url,
      isDefault: true,
      enabled: true,
    }));
    const userEnabled = userMcpServers.filter((s) => s.enabled !== false);
    return [...defaults, ...userEnabled];
  }, [defaultMcpServers, userMcpServers]);

  // Lazy scheduler init. Consumers that never open the panel (and never
  // trigger a send-time probe, Unit 6) skip the allocation. `onUpdate`
  // reads-then-writes via functional setState so concurrent probe
  // resolutions coalesce correctly.
  //
  // Declared BEFORE the add/toggle/remove handlers so their useCallback
  // deps arrays can reference it without a TDZ violation.
  const getScheduler = useCallback(() => {
    if (!schedulerRef.current) {
      schedulerRef.current = createProbeScheduler({
        onUpdate: (url, result) => {
          setMcpStatus((prev) => {
            const next = new Map(prev);
            next.set(url, result);
            return next;
          });
        },
      });
    }
    return schedulerRef.current;
  }, []);

  const handleAddMcpServer = useCallback((server) => {
    const result = addMcpServer(server);
    setUserMcpServers(result.servers);
    // Unit 4 B1: on successful add, fire a probe against the sanitized URL
    // so the new row shows yellow → green/orange/red within ~2s. Without
    // this, the row stays grey until the next panel open (when
    // handlePanelOpen's iteration catches it).
    if (result.added) {
      const added = result.servers[result.servers.length - 1];
      if (added?.url) {
        hasProbedThisSessionRef.current.add(added.url);
        getScheduler().schedule(added.url);
      }
    }
    // Return { added, sanitize } so MCPServerPanel can render the D1
    // credential-removed alert or surface an invalid-scheme validation error.
    return { added: result.added, sanitize: result.sanitize };
  }, [getScheduler]);
  const handleRemoveMcpServer = useCallback((url) => {
    // Cancel any in-flight probe before the server disappears, and clear
    // its status entry so no stale dot lingers.
    schedulerRef.current?.cancel(url);
    hasProbedThisSessionRef.current.delete(url);
    setMcpStatus((prev) => {
      if (!prev.has(url)) return prev;
      const next = new Map(prev);
      next.delete(url);
      return next;
    });
    setUserMcpServers(removeMcpServer(url));
  }, []);
  const handleToggleMcpServer = useCallback((url) => {
    const updated = toggleMcpServer(url);
    setUserMcpServers(updated);
    // Find the new enabled state of the toggled server to decide probe vs cancel.
    const record = updated.find((s) => s.url === url);
    if (record?.enabled) {
      // Unit 4 B2: toggle-on → fresh probe.
      hasProbedThisSessionRef.current.add(url);
      getScheduler().schedule(url);
    } else {
      // Toggle-off: cancel any in-flight probe + set dot grey + drop the
      // session marker so the next toggle-on re-probes cleanly (review #10
      // — without the delete, toggle on→off→on would leave the dot grey
      // because handlePanelOpen's "probed this session" check would skip
      // a re-probe).
      schedulerRef.current?.cancel(url);
      hasProbedThisSessionRef.current.delete(url);
      setMcpStatus((prev) => new Map(prev).set(url, { state: "grey" }));
    }
  }, [getScheduler]);

  const handleRetry = useCallback((url) => {
    getScheduler().schedule(url);
  }, [getScheduler]);

  // MCPServerPanel invokes this from its mount effect. Probe each enabled
  // server at most once per session (the Set is a ref so it survives panel
  // close/reopen without re-triggering a probe burst).
  const handlePanelOpen = useCallback(() => {
    const scheduler = getScheduler();
    for (const server of allMcpServers) {
      const url = server?.url;
      if (!url) continue;
      if (hasProbedThisSessionRef.current.has(url)) continue;
      hasProbedThisSessionRef.current.add(url);
      scheduler.schedule(url);
    }
  }, [getScheduler, allMcpServers]);

  // Cancel every in-flight probe on unmount so scheduler timers and
  // transport closes don't outlive the component.
  useEffect(() => () => schedulerRef.current?.cancelAll(), []);

  const handleProviderSave = useCallback((newConfig) => {
    setProviderConfig(newConfig);
    setShowProviderPanel(false);
  }, []);

  const chatLogRef = useRef(null);
  const abortRef = useRef(null);
  // Per-turn identity for the rAF freshness check at the two
  // update-visualization dispatch sites below. Bumped on each user send;
  // captured at schedule time, compared at fire time. See helpers/scheduleDispatch.js.
  const turnIdRef = useRef(0);

  const stopGeneration = useCallback(() => { abortRef.current?.abort(); }, []);

  // Auto-scroll
  useEffect(() => {
    const el = chatLogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, thinkingBuffer, contentBuffer]);

  // Sync props
  useEffect(() => { setInput(prompt ?? ""); }, [prompt]);
  useEffect(() => { setSelectedModel(model); }, [model]);
  useEffect(() => { setIsThinkingEnabled(Boolean(thinkingEnabled)); }, [thinkingEnabled]);
  useEffect(() => { if (!isThinkingEnabled) setThinkingBuffer(""); }, [isThinkingEnabled]);

  // Load models
  useEffect(() => {
    let cancelled = false;
    setLoadingModels(true);
    listModels(providerConfig, { csrfToken })
      .then((models) => { if (!cancelled) setDiscoveredModels(models); })
      .catch((err) => { console.warn("Unable to load model list:", err); })
      .finally(() => { if (!cancelled) setLoadingModels(false); });
    return () => { cancelled = true; };
  }, [providerConfig, csrfToken]);

  // Auto-select model
  useEffect(() => {
    if (!availableModels.length) return;
    if (!selectedModel || !availableModels.some((m) => m.name === selectedModel)) {
      setSelectedModel(availableModels[0].name);
    }
  }, [availableModels, selectedModel]);

  // Context total
  useEffect(() => {
    const modelInfo = discoveredModels.find((m) => m.name === selectedModel);
    setContextUsage((prev) => ({ ...prev, total: modelInfo?.contextLength ?? 8192 }));
  }, [selectedModel, discoveredModels]);

  const sendMessage = useCallback(async () => {
    const userText = input.trim();
    if (!userText || loading) return;

    // Bump turn-id BEFORE any work — pending rAF callbacks from a prior
    // turn are now stale and will bail at fire time. capturedTurnId is
    // taken below and threaded into the rAF freshness check.
    turnIdRef.current += 1;
    const capturedTurnId = turnIdRef.current;

    setError("");
    setThinkingBuffer("");
    setContentBuffer("");
    setLoading(true);
    setMessages((prev) => [...prev, { role: "user", content: userText }]);
    setInput("");

    let accumulatedThinking = "";
    let accumulatedContent = "";
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await runChatSession({
        prompt: userText,
        model: selectedModel,
        thinkingEnabled: isThinkingEnabled,
        signal: controller.signal,
        history: engineMessagesRef.current,
        maxContextTokens: Math.floor(contextUsage.total * CONTEXT_BUDGET_RATIO),
        providerConfig,
        ...(csrfToken ? { csrfToken } : {}),
        mcpServers: allMcpServers,
        // Plan 002 — capability resolution input. The engine reads each
        // model's `capabilities` array (populated by listModels per
        // provider) to decide whether to pass tools and which system
        // prompt variant to use.
        modelList: discoveredModels,
        // Plan 002 R2/R7 — engine fires per turn when tools are gated.
        // Consumer dedups across turns via the seen-Set ref below and
        // appends a UI-only system message to the visible chat (R2).
        onSessionNotice: (event) => {
          if (!event || event.type !== "tools_disabled") return;
          const dedupKey = `${event.provider || "?"}|${event.model}|${event.source || "?"}`;
          if (sessionNoticeSeenRef.current.has(dedupKey)) return;
          sessionNoticeSeenRef.current.add(dedupKey);
          const displayName = event.displayName || event.model;
          const content = event.source === "auto-learned"
            ? `Tools off — ${displayName} answers from training data only. (Learned from earlier responses; clears in 30 days.)`
            : `Tools off — ${displayName} answers from training data only.`;
          setMessages((prev) => [...prev, { role: "system", content }]);
        },
        // Inject domain-specific extensions (empty for generic sidebar)
        ...engineExtensions,
        onToolStatus: (status) => {
          setToolStatus(status);
          // Round-boundary buffer reset: when tools finish and the engine
          // is about to stream the next assistant round, clear the
          // accumulators so LiveActivity / LivePreview reflect only the
          // current round's thinking and content, not stale text from
          // the previous round.
          if (status === null) {
            accumulatedThinking = "";
            accumulatedContent = "";
            setThinkingBuffer("");
            setContentBuffer("");
          }
        },
        // Engine fires this before retrying without tools when a
        // tool-incapable model refused or emitted unparseable tool JSON.
        // Wipe streaming buffers so the misleading first-attempt text
        // doesn't flash in the loading bubble before the retry stream
        // replaces it.
        onContentReset: () => {
          accumulatedThinking = "";
          accumulatedContent = "";
          setThinkingBuffer("");
          setContentBuffer("");
        },
        onThinkingChunk: (chunk) => {
          if (!isThinkingEnabled || !chunk) return;
          accumulatedThinking += chunk;
          setThinkingBuffer(accumulatedThinking);
        },
        onContentChunk: (chunk) => {
          if (!chunk) return;
          accumulatedContent += chunk;
          setContentBuffer(accumulatedContent);
          if (isEmbedded) {
            updateVariableInputValues({ chatbox_markdown: accumulatedContent });
          }
        },
      });

      if (result.messages) {
        engineMessagesRef.current = result.messages;
        setContextUsage((prev) => ({ ...prev, used: estimateTokens(result.messages) }));
      }

      // Unit 6 (C1/C2/C4) — consume send-time per-server outcomes from the
      // engine. For EVERY outcome (including "connected"), cancel any
      // in-flight panel probe for the same URL (bumps generation, closes
      // transport, clears pending 400 ms yellow-hold timer) and write the
      // fresh engine-confirmed status. For non-connected outcomes, append
      // a muted in-chat system line so users see why the assistant had
      // fewer tools available than expected.
      //
      // C3 is satisfied structurally: `perServer` carries exactly one entry
      // per server per send. C5 is satisfied because `outcome.url` /
      // `outcome.name` flow from the server record, which was D1-sanitized
      // on add (Unit 3). C6 is satisfied because the in-chat copy uses a
      // fixed template and does not interpolate SDK error content.
      const perServer = Array.isArray(result?.perServer) ? result.perServer : [];
      const systemMessages = [];
      for (const outcome of perServer) {
        if (!outcome?.url) continue;
        schedulerRef.current?.cancel(outcome.url);
        setMcpStatus((prev) => {
          const next = new Map(prev);
          next.set(outcome.url, { state: outcome.state, errorKey: outcome.errorKey });
          return next;
        });
        const text = buildMcpStatusMessage(outcome);
        if (text) {
          systemMessages.push({ role: "system", content: text });
        }
      }
      if (systemMessages.length > 0) {
        setMessages((prev) => [...prev, ...systemMessages]);
      }

      const content = result.aborted
        ? (accumulatedContent || "(Stopped)")
        : (result.assistantText || "");

      // Domain-specific result handling (panel creation, variable publishing)
      if (onResult) {
        onResult(result, { isEmbedded, updateVariableInputValues });
      }

      // Pre-compute layer update groups so same-conversation layers can be
      // merged into their parent visualization before dispatch. This avoids
      // a timing race: requestAnimationFrame does not guarantee React has
      // committed the new grid item from add-visualization before the
      // update-visualization handler reads gridItemsUpdated.current.
      const layerUpdatesByUuid = {};
      const matchedLayerUuids = new Set();
      if (result.layerUpdates?.length > 0) {
        for (const update of result.layerUpdates) {
          if (!layerUpdatesByUuid[update.map_uuid]) layerUpdatesByUuid[update.map_uuid] = [];
          layerUpdatesByUuid[update.map_uuid].push(update.layer);
        }
      }

      // Dispatch visualization specs from TethysDash MCP as a single batch
      // event. Individual events in a loop cause duplicate grid item keys
      // and lost items because handleAddVisualization reads a stale ref
      // between dispatches (no re-render between synchronous events).
      if (result.visualizations?.length > 0) {
        const panels = result.visualizations.map((viz) => {
          // Resolve MFE URL for client_custom_remote plugins
          if (viz.vizType === "custom" && viz.scope && !viz.url && resolveVisualizationUrl) {
            viz.url = resolveVisualizationUrl(viz);
          }
          let args;
          if (viz.inlineData) {
            args = { vizType: viz.vizType, inlineData: viz.inlineData };
          } else if (viz.vizType === "custom" && viz.scope) {
            // client_custom_remote: Module Federation coordinates
            // Dual-format initialData: generic `data` prop + keyed for backward compat
            const initialData = { data: viz.args || {} };
            if (viz.dataKey) {
              initialData[viz.dataKey] = viz.args || {};
            }
            args = {
              url: viz.url,
              scope: viz.scope,
              module: viz.module,
              remoteType: viz.remoteType || "vite-esm",
              initialData,
            };
          } else {
            args = viz.args;
          }
          return { source: viz.source, args, w: viz.w, h: viz.h, uuid: viz.uuid };
        });

        // Merge same-conversation layer updates into matching panels.
        // The map is created with its layers already included — no timing
        // gap between add-visualization and update-visualization events.
        for (const panel of panels) {
          if (panel.uuid && layerUpdatesByUuid[panel.uuid]) {
            if (!panel.args) panel.args = {};
            if (!Array.isArray(panel.args.layers)) panel.args.layers = [];
            panel.args.layers.push(...layerUpdatesByUuid[panel.uuid]);
            matchedLayerUuids.add(panel.uuid);
          }
        }

        window.dispatchEvent(
          new CustomEvent(ADD_VISUALIZATION_EVENT, {
            detail: { batch: true, panels },
          }),
        );
      }

      // Dispatch layer updates only for UUIDs that didn't match a
      // visualization in the current batch (pre-existing maps from previous
      // sessions). These grid items already exist in React state, so the
      // requestAnimationFrame timing is not a concern.
      const unmatchedUpdates = Object.entries(layerUpdatesByUuid).filter(
        ([uuid]) => !matchedLayerUuids.has(uuid),
      );
      if (unmatchedUpdates.length > 0) {
        scheduleDispatchIfFresh({
          getCurrentTurnId: () => turnIdRef.current,
          capturedTurnId,
          dispatch: () => {
            for (const [uuid, layers] of unmatchedUpdates) {
              window.dispatchEvent(
                new CustomEvent("tethysdash:update-visualization", {
                  detail: { uuid, operation: "append_layers", layers },
                }),
              );
            }
          },
        });
      }

      // Generic update-protocol patches (R1+). Each envelope from the engine
      // is {uuid, source, ops}; group by UUID preserving source. Dispatch
      // order is safe for same-turn create+patch: `tethysdash:add-visualization`
      // fires synchronously (handleAddVisualization runs to completion,
      // updating gridItemsUpdated.current), and the patch dispatch is
      // requestAnimationFrame-scheduled — so by the time handleUpdateVisualization
      // runs with apply_patch, the just-created UUID is already in the ref.
      // No special same-batch handling needed.
      //
      // One rejection path still fires: cross_source_collision (add_map_service_layer
      // + a bare-index-op patch on the same UUID's /args/layers). Those ARE
      // order-dependent (which layer does /args/layers/2 refer to — pre- or
      // post-add?), so we force the LLM to split across turns.
      // Per-envelope construction + cross_source_collision filtering.
      // See helpers/buildPatchEntries.js for the contract; tests in
      // helpers/buildPatchEntries.test.js lock the per-envelope semantics.
      const { entries: survivingEntries, rejectedCollision: rejectedCollisionUnique } =
        buildPatchEntries(result.patches, layerUpdatesByUuid);
      if (rejectedCollisionUnique.length > 0 && typeof console !== "undefined") {
        console.warn(
          "[chatbox] cross_source_collision: patches skipped for UUIDs " +
            "where add_map_service_layer + bare-index patch ops collide " +
            "on /args/layers. Split into two turns so ordering is explicit.",
          rejectedCollisionUnique,
        );
      }
      // Surface the rejection to the user. The MCP server already returned
      // a success envelope (this is a client-side ordering rejection), so
      // without a user-visible message the LLM's final "I updated it"
      // claim is a silent lie — the user sees layers added but the patch
      // dropped. Prepending a warning to the assistant content gives the
      // user a clear next-step: split into two turns.
      const collisionWarning = rejectedCollisionUnique.length > 0
        ? `⚠ Some edits were skipped to avoid ambiguous layer ordering ` +
          `(cross_source_collision on UUID${rejectedCollisionUnique.length > 1 ? "s" : ""} ` +
          `${rejectedCollisionUnique.join(", ")}). ` +
          `Retry those edits in a separate message so the layer changes ` +
          `apply in a well-defined order.\n\n`
        : "";

      // R16 — server-side rejections (whitelist_rejected, etc.) collected
      // by the engine during this turn. Collapsed into two user-facing
      // copy buckets per the plan's simplification from four categories:
      //   1. Not editable from chat — no actionable editable path list
      //      was available (resolution failure / plugin not opted in /
      //      unknown source). User can't fix; pointer-back to manual edit.
      //   2. Field not editable, here's what IS editable — a plugin was
      //      resolved and has real editable paths; surface them so the LLM
      //      and user can retry against a valid field.
      // Resolution-failure routing: the server emits `allowed_prefixes=[]`
      // in its error text (C1 telemetry). Non-empty list is the actionable
      // bucket 2 signal.
      const whitelistWarning = _buildWhitelistWarning(result.rejectedPatches);

      // Plan 003 D4 — structural dispatch-feedback banner. Triggers when a
      // renderable-tagged tool was called this turn but no envelope was
      // dispatched. Defense-in-depth alongside the system-prompt instruction
      // (Plan 003 D3 — host-owned).
      const dispatchBanner = _buildDispatchBanner({
        toolCallsThisTurn: result.toolCallsThisTurn,
        toolTagsByName: result.toolTagsByName,
        visualizations: result.visualizations,
        layerUpdates: result.layerUpdates,
        patches: result.patches,
        assistantText: result.assistantText,
      });

      // Batch dispatch: ONE tethysdash:update-visualization event carrying
      // all surviving entries, scheduled via rAF alongside the layer-update
      // path. Per docs/solutions/logic-errors/stale-ref-batch-dispatch-*,
      // never dispatch N events in a loop when a batch shape exists.
      // Wrapped in scheduleDispatchIfFresh so a stale Turn-N rAF callback
      // is skipped if Turn N+1 has started before it fires (Plan 20 #16).
      if (survivingEntries.length > 0) {
        scheduleDispatchIfFresh({
          getCurrentTurnId: () => turnIdRef.current,
          capturedTurnId,
          dispatch: () => {
            window.dispatchEvent(
              new CustomEvent("tethysdash:update-visualization", {
                detail: {
                  batch: true,
                  operation: "apply_patch",
                  patches: survivingEntries,
                },
              }),
            );
          },
        });
      }

      // Extract plotlyFigure from visualization specs for inline rendering
      // (standalone) and text indicators (sidebar/MFE embedded modes)
      const plotlyViz = result.visualizations?.find((v) => v.vizType === "plotly");
      const inlinePlotly = plotlyViz?.inlineData ?? null;

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: dispatchBanner + collisionWarning + whitelistWarning + content,
          thinking: accumulatedThinking || "",
          plotlyFigure: result.plotlyFigure ?? inlinePlotly,
          mapConfig: result.mapConfig ?? null,
          queryResult: result.queryResult ?? null,
        },
      ]);
      setThinkingBuffer("");
      setContentBuffer("");
    } catch (err) {
      setError(String(err?.message ?? err));
      // Restore the user's text so the input and send button re-enable
      // immediately — without this, the input stays empty after an error
      // and the button looks stuck until the user retypes or switches
      // provider (which coincidentally clears the error).
      setInput(userText);
    } finally {
      abortRef.current = null;
      setToolStatus(null);
      setLoading(false);
      // Clear streaming buffers regardless of how we got here. The success
      // path also clears them, but on abort or thrown error the partial
      // buffers would otherwise survive in state and flash on the next
      // user prompt before its own setThinkingBuffer("")/setContentBuffer("")
      // reset runs.
      setThinkingBuffer("");
      setContentBuffer("");
    }
  }, [input, loading, selectedModel, isThinkingEnabled, contextUsage.total, providerConfig, csrfToken, allMcpServers, isEmbedded, updateVariableInputValues, engineExtensions, onResult, resolveVisualizationUrl]);

  const hasMessages = messages.length > 0 || loading;

  const inputBar = (
    <ChatInputBar
      input={input}
      setInput={setInput}
      onSend={sendMessage}
      onStop={stopGeneration}
      loading={loading}
      loadingModels={loadingModels}
      selectedModel={selectedModel}
      onModelChange={setSelectedModel}
      availableModels={availableModels}
      isThinkingEnabled={isThinkingEnabled}
      onThinkingToggle={() => setIsThinkingEnabled((v) => !v)}
      contextUsage={contextUsage}
      onOpenMcpPanel={() => setShowMcpPanel(true)}
      mcpServerCount={allMcpServers.length}
      showProviderPanel={showProviderPanel}
      onToggleProviderPanel={() => setShowProviderPanel((p) => !p)}
      providerConfig={providerConfig}
    />
  );

  if (showProviderPanel) {
    return (
      <ThemeProvider theme={chatTheme}>
        <Shell $hasMessages>
          <LLMProviderPanel
            onSave={handleProviderSave}
            onClose={() => setShowProviderPanel(false)}
          />
        </Shell>
      </ThemeProvider>
    );
  }

  if (showMcpPanel) {
    return (
      <ThemeProvider theme={chatTheme}>
        <Shell $hasMessages>
          <MCPServerPanel
            defaultServers={defaultMcpServers}
            userServers={userMcpServers}
            onAdd={handleAddMcpServer}
            onRemove={handleRemoveMcpServer}
            onToggle={handleToggleMcpServer}
            onClose={() => setShowMcpPanel(false)}
            statusMap={mcpStatus}
            onRetry={handleRetry}
            onPanelOpen={handlePanelOpen}
          />
        </Shell>
      </ThemeProvider>
    );
  }

  if (!hasMessages) {
    return (
      <ThemeProvider theme={chatTheme}>
        <Shell $hasMessages={false}>
          <Welcome>
            <WelcomeHeading>{welcomeHeading}</WelcomeHeading>
            {welcomeSubtitle && <WelcomeSub>{welcomeSubtitle}</WelcomeSub>}
            {suggestedPrompts.length > 0 && (
              <SuggestedPromptList>
                {suggestedPrompts.map((p) => (
                  <SuggestedPromptChip
                    key={p}
                    type="button"
                    onClick={() => setInput(p)}
                  >
                    {p}
                  </SuggestedPromptChip>
                ))}
              </SuggestedPromptList>
            )}
          </Welcome>
          <WelcomeInputWrapper>{inputBar}</WelcomeInputWrapper>
        </Shell>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider theme={chatTheme}>
      <Shell $hasMessages>
        <ChatLog
          ref={chatLogRef}
          messages={messages}
          isEmbedded={isEmbedded}
          loading={loading}
          isThinkingEnabled={isThinkingEnabled}
          thinkingBuffer={thinkingBuffer}
          contentBuffer={contentBuffer}
          toolStatus={toolStatus}
          MessageRenderer={MessageRenderer}
        />
        <ChatErrorPanel error={error} />
        {inputBar}
      </Shell>
    </ThemeProvider>
  );
}
