import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, "index.js"),
        "engine/index": resolve(__dirname, "engine/index.js"),
        "engine/embeddings": resolve(__dirname, "engine/embeddings.js"),
        "conversation/index": resolve(__dirname, "conversation/index.js"),
        "helpers/index": resolve(__dirname, "helpers/index.js"),
        "config/index": resolve(__dirname, "config/index.js"),
        "messages/index": resolve(__dirname, "messages/index.js"),
        "storage/mcpStorage": resolve(__dirname, "storage/mcpStorage.js"),
        "components/index": resolve(__dirname, "components/index.js"),
        "components/Chatbox": resolve(__dirname, "components/Chatbox.jsx"),
        "components/ChatLog": resolve(__dirname, "components/ChatLog.jsx"),
        "components/ChatMessage": resolve(__dirname, "components/ChatMessage.jsx"),
        "components/ChatInputBar": resolve(__dirname, "components/ChatInputBar.jsx"),
        "components/ChatErrorPanel": resolve(__dirname, "components/ChatErrorPanel.jsx"),
        "components/MCPServerPanel": resolve(__dirname, "components/MCPServerPanel.jsx"),
        "components/ContextUsageIndicator": resolve(__dirname, "components/ContextUsageIndicator.jsx"),
        "components/markdownContent": resolve(__dirname, "components/markdownContent.jsx"),
        "theme/index": resolve(__dirname, "theme/index.js"),
      },
      formats: ["es"],
    },
    rollupOptions: {
      // Only externalize packages that tethysdash already has.
      // Everything else is bundled into dist/ so consumers don't need to install them.
      external: [
        "react",
        "react-dom",
        "react/jsx-runtime",
        "styled-components",
        "@huggingface/transformers",
      ],
      output: {
        preserveModules: false,
      },
    },
    outDir: "dist",
    emptyOutDir: true,
  },
});
