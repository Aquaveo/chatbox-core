# @aquaveo/chatbox-core

Generic chatbox engine and UI components. Works with any Ollama-compatible backend and MCP server. Framework-agnostic — consumers can use Vite, webpack, or any bundler.

## Installation

```bash
npm install @aquaveo/chatbox-core
# or, for the prerelease channel during early stabilization:
npm install @aquaveo/chatbox-core@beta

# Peer dependencies (must be installed by the consumer)
npm install react react-dom styled-components
```

### Peer dependencies

| Package | Version | Why |
|---|---|---|
| `react` | `>=17.0.0` | Hooks (`useState`, `useEffect`, `useCallback`) |
| `react-dom` | `>=17.0.0` | Render surface |
| `styled-components` | `>=5.0.0` | Component theming |

### Optional dependencies

| Package | Purpose |
|---|---|
| `@huggingface/transformers` | Local embeddings; only loaded when consumed |

### Status

`0.2.0-beta.0` is the first prerelease publish. The API is **pre-1.0** — minor bumps may carry breaking changes during stabilization. For production use, pin to a specific version (e.g., `"@aquaveo/chatbox-core": "0.2.0-beta.0"`) until `1.0.0` lands.

### Source

- Repository: [github.com/Aquaveo/chatbox-core](https://github.com/Aquaveo/chatbox-core)
- Issues: [github.com/Aquaveo/chatbox-core/issues](https://github.com/Aquaveo/chatbox-core/issues)
- Changelog: [CHANGELOG.md](./CHANGELOG.md)
- License: [MIT](./LICENSE)

## Quick Start

```jsx
import { Chatbox } from "@aquaveo/chatbox-core/components";

function App() {
  return <Chatbox ollamaHost="https://ollama.com" ollamaApiKey="your-key" />;
}
```

## Props Reference

### `<Chatbox>` Component

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `ollamaHost` | `string` | `""` | Ollama API base URL or proxy path. Empty string makes relative requests (e.g., `/api/tags/`). |
| `ollamaApiKey` | `string` | `""` | Bearer token for Ollama Cloud authentication. |
| `csrfToken` | `string` | `""` | CSRF token for Django proxy requests (injected as `x-csrftoken` header). |
| `model` | `string` | `"qwen3"` | Default model name. |
| `modelOptions` | `string[]` | `[model]` | Fallback model list shown when discovery fails or as extras in the dropdown. |
| `thinkingEnabled` | `boolean` | `false` | Enable thinking/reasoning mode. |
| `prompt` | `string` | `""` | Pre-filled input text. |
| `mcpServerUrl` | `string` | `"/sse"` | Single MCP server SSE endpoint. |
| `mcpServers` | `Array<{url, name}>` | `[]` | Multiple MCP servers. Overrides `mcpServerUrl` if provided. |
| `engineExtensions` | `object` | `{}` | Strategy-pattern hooks for domain-specific behavior (see [Engine Extensions](#engine-extensions)). |
| `onResult` | `function` | `null` | Callback after each chat turn: `(result, { isEmbedded, updateVariableInputValues }) => void`. |
| `MessageRenderer` | `React.Component` | `null` | Custom message content renderer (receives message props). |
| `variableInputValues` | `object` | — | Shared state object for embedded mode. Presence of `updateVariableInputValues` enables embedded mode. |
| `updateVariableInputValues` | `function` | — | State setter for embedded mode. If provided, `isEmbedded` becomes `true`. |

### How `ollamaHost` is resolved

The `ollamaHost` prop controls where all Ollama API requests go:

| Value | Behavior | Use case |
|-------|----------|----------|
| `"https://ollama.com"` | Direct connection to Ollama Cloud | Standalone with API key |
| `"http://localhost:11434"` | Local Ollama server | Local development |
| `"/apps/tethysdash/ollama-proxy"` | Relative path — uses `proxy: true` in Ollama SDK, custom fetch prepends path | Django proxy (sidebar) |
| `"http://localhost:5001"` | Requests go to this host; Vite proxy can forward to Ollama | MFE via Vite dev/preview server |
| `""` or omitted | Relative `/api/` requests against `window.location.origin` | Behind a reverse proxy |

## Configuration Patterns

### 1. Standalone Vite App

Read env vars in your entry point and pass as props. The library itself never reads `import.meta.env`.

```jsx
// App.jsx
import { Chatbox } from "@aquaveo/chatbox-core/components";

const ollamaHost = import.meta.env.VITE_OLLAMA_HOST?.trim() || undefined;
const ollamaApiKey = import.meta.env.VITE_OLLAMA_API_KEY?.trim() || undefined;

function App() {
  return (
    <Chatbox
      ollamaHost={ollamaHost}
      ollamaApiKey={ollamaApiKey}
      model="qwen3"
    />
  );
}
```

For development, the Vite proxy in `vite.config.js` can forward `/api` to the Ollama host and inject the API key server-side:

```js
// vite.config.js
const ollamaProxy = {
  target: env.VITE_OLLAMA_HOST,
  changeOrigin: true,
  headers: { Authorization: `Bearer ${env.VITE_OLLAMA_API_KEY}` },
};
```

### 2. MFE in Host App (Module Federation)

The host app passes `ollamaHost` pointing to the MFE's Vite server. The Vite proxy handles forwarding and authentication.

```python
# chatjs.py (intake plugin)
"props": {
    "ollamaHost": self.mfe_unpkg_url.rsplit("/assets/", 1)[0],
    "model": "qwen3.5:397b-cloud",
}
```

The MFE wrapper can read CSRF tokens from cookies for Django-backed deployments:

```jsx
// chatbox.jsx (MFE wrapper)
function getCsrfToken() {
  const match = document.cookie.match(/csrftoken=([^;]+)/);
  return match ? match[1] : "";
}

export default function ChatBox(props) {
  return <Chatbox {...props} csrfToken={props.csrfToken || getCsrfToken()} />;
}
```

### 3. Native Sidebar (webpack / non-Vite)

Pass the server-side proxy path and CSRF token from your app context:

```jsx
// ChatSidebar.js
import { Chatbox } from "@aquaveo/chatbox-core/components";

function ChatSidebar() {
  const { tethysApp, csrf } = useContext(AppContext);

  return (
    <Chatbox
      ollamaHost={tethysApp.chatboxConfig?.ollamaHost}
      csrfToken={csrf}
    />
  );
}
```

The Django proxy handles authentication server-side — no API key needed in the browser.

## Engine Extensions

Inject domain-specific behavior via the `engineExtensions` prop. All extension points are optional — omitting them produces a generic chatbox.

```jsx
<Chatbox
  engineExtensions={{
    systemPromptBuilder,    // () => message — builds the system prompt
    toolCategories,         // object — categorizes MCP tools for early return / continuation logic
    earlyReturnCheck,       // (toolName, result, state) => object|null — terminal tool detection
    beforeToolExecution,    // (toolName, args) => args — modify/validate tool args before execution
    toolErrorCheck,         // (toolName, result) => string|null — detect tool-level errors
    repairMessageBuilder,   // (toolName, error, args) => message — build repair prompt for failed tools
    continuationPrompt,     // string|function — prompt for multi-step tool chaining
    beforeFirstMessage,     // (messages) => messages — modify messages before first LLM call
  }}
/>
```

See `src/engine/index.js` for full signatures and default behavior.

**Example (NRDS domain):**

```jsx
import { Chatbox } from "@aquaveo/chatbox-core/components";

const extensions = {
  systemPromptBuilder: buildNrdsSystemMessage,
  toolCategories: NRDS_TOOL_CATEGORIES,
  earlyReturnCheck: checkNrdsEarlyReturn,
  beforeToolExecution: beforeNrdsToolExecution,
};

<Chatbox ollamaHost={host} engineExtensions={extensions} />
```

## Subpath Imports

```js
import { Chatbox } from "@aquaveo/chatbox-core/components";     // UI components
import { runChatSession } from "@aquaveo/chatbox-core/engine";   // Chat engine
import { listOllamaModels } from "@aquaveo/chatbox-core/helpers"; // Utilities
import { estimateTokens } from "@aquaveo/chatbox-core/conversation"; // Token management
import { DEFAULT_OLLAMA_HOST } from "@aquaveo/chatbox-core/config"; // Static defaults
import { buildGenericSystemMessage } from "@aquaveo/chatbox-core/messages"; // System prompts
import { getMcpServers } from "@aquaveo/chatbox-core/storage";   // localStorage MCP config
import chatTheme from "@aquaveo/chatbox-core/theme";             // Design tokens
```

## Development

Working on the package itself (cloned the repo, want to iterate locally):

```bash
git clone git@github.com:Aquaveo/chatbox-core.git
cd chatbox-core
npm install
npm test                    # 105 vitest tests, ~1s
npm run build               # one-time build to dist/
npm run dev                 # watch mode
```

For consumers who want to co-develop the package alongside their app, use a `file:` link in the consumer's `package.json` (`"@aquaveo/chatbox-core": "file:../path/to/chatbox-core"`) and add `legacy-peer-deps=true` to the linked package's `.npmrc` to avoid duplicate React from npm 7+'s peer-dep auto-install.

The build produces ES modules in `dist/`. Consumers import the pre-built output. The library externalizes `react`, `react-dom`, and `styled-components` as peer dependencies.

**Important:** The library does NOT read `import.meta.env` or `process.env`. All configuration is runtime via props. This ensures the built `dist/` works identically for every consumer regardless of their build environment.
