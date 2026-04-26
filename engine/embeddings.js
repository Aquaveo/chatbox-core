/**
 * embeddings.js — Browser-side semantic matching for MCP tool selection.
 *
 * Loads @huggingface/transformers lazily on first use. Computes embeddings
 * for tool name+description pairs and ranks them against user prompts via
 * cosine similarity.
 *
 * This module is a separate Vite entry point — it is dynamically imported
 * from engine/index.js only when a large-catalog server (>=15 tools) is
 * detected. The ~23MB ONNX model downloads once and is cached by the browser.
 *
 * All operations run on the main thread during the async connectMcpServers
 * phase. See plan Key Technical Decisions for rationale (Vite lib mode does
 * not support Web Workers).
 */

// ---------------------------------------------------------------------------
// Module-level caches (persist across runChatSession calls within a browser session)
// ---------------------------------------------------------------------------

/** @type {import("@huggingface/transformers").Pipeline | null} */
let pipelineInstance = null;

/** @type {Promise<import("@huggingface/transformers").Pipeline | null> | null} */
let initPromise = null;

/** @type {boolean} */
let initFailed = false;

/**
 * Cache of precomputed tool embeddings.
 * Key: `${serverUrl}:${toolFingerprint}` where toolFingerprint is a hash
 * of sorted tool names. Prevents re-embedding on every chat message.
 * @type {Map<string, Map<string, Float32Array>>}
 */
const embeddingCache = new Map();

// ---------------------------------------------------------------------------
// Pipeline Initialization
// ---------------------------------------------------------------------------

const EMBED_INIT_TIMEOUT_MS = 15000;

/**
 * Lazily initialize the embedding pipeline. Returns null on failure.
 * The pipeline + ONNX model (~23MB quantized) download once and are
 * cached by the browser via the transformers.js cache mechanism.
 *
 * Uses a shared Promise to prevent concurrent calls from downloading
 * the model twice (e.g., two rapid user messages).
 */
export async function initEmbeddings() {
  if (pipelineInstance) return pipelineInstance;
  if (initFailed) return null;

  if (!initPromise) {
    initPromise = (async () => {
      try {
        const { pipeline } = await import("@huggingface/transformers");
        const result = await Promise.race([
          pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8" }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Embedding pipeline init timed out")), EMBED_INIT_TIMEOUT_MS),
          ),
        ]);
        pipelineInstance = result;
        return result;
      } catch (err) {
        console.warn("Failed to initialize embedding pipeline:", err);
        initFailed = true;
        initPromise = null;
        return null;
      }
    })();
  }

  return initPromise;
}

// ---------------------------------------------------------------------------
// Embedding Computation
// ---------------------------------------------------------------------------

/**
 * Compute a fingerprint for a set of tools (sorted tool names joined).
 * Used as a cache key to detect when a server's tool list has changed.
 */
function toolFingerprint(tools) {
  return JSON.stringify(tools.map((t) => t.function.name).sort());
}

/**
 * Build embeddings for a server's tools. Returns a Map<toolName, Float32Array>
 * or null if embeddings are unavailable.
 *
 * Uses a module-level cache keyed by serverUrl + tool fingerprint to avoid
 * recomputation across chat messages.
 *
 * @param {string} serverUrl - Server URL for cache keying
 * @param {Array} tools - Tool definitions (OpenAI function format)
 * @returns {Promise<Map<string, Float32Array> | null>}
 */
export async function buildEmbeddingsForServer(serverUrl, tools) {
  const fp = toolFingerprint(tools);
  const cacheKey = `${serverUrl}:${fp}`;

  if (embeddingCache.has(cacheKey)) {
    return embeddingCache.get(cacheKey);
  }

  const embedder = await initEmbeddings();
  if (!embedder) return null;

  try {
    const embeddings = new Map();

    for (const tool of tools) {
      const text = `${tool.function.name} ${tool.function.description || ""}`;
      const output = await embedder(text, { pooling: "mean", normalize: true });
      embeddings.set(tool.function.name, new Float32Array(output.data));
    }

    // Cap cache at 20 entries (~1.5MB max) to prevent unbounded growth
    if (embeddingCache.size >= 20) {
      const firstKey = embeddingCache.keys().next().value;
      embeddingCache.delete(firstKey);
    }
    embeddingCache.set(cacheKey, embeddings);
    return embeddings;
  } catch (err) {
    console.warn("Failed to build tool embeddings:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cosine Similarity & Tool Selection
// ---------------------------------------------------------------------------

/**
 * Cosine similarity between two vectors.
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {number} Similarity score in [-1, 1]
 */
export function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Select the top N tools from a server based on semantic similarity
 * to the user prompt.
 *
 * @param {string} prompt - User prompt text
 * @param {Array} tools - Tool definitions for this server
 * @param {Map<string, Float32Array>} toolEmbeddings - Precomputed tool embeddings
 * @param {number} topN - Maximum number of tools to return
 * @returns {Promise<Array>} Top-ranked tools
 */
export async function selectTopTools(prompt, tools, toolEmbeddings, topN) {
  const embedder = await initEmbeddings();
  if (!embedder) return tools; // Fallback: return all

  try {
    const promptOutput = await embedder(prompt, { pooling: "mean", normalize: true });
    const promptEmb = new Float32Array(promptOutput.data);

    const scored = tools.map((tool) => {
      const toolEmb = toolEmbeddings.get(tool.function.name);
      return {
        tool,
        score: toolEmb ? cosineSimilarity(promptEmb, toolEmb) : 0,
      };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topN).map((x) => x.tool);
  } catch (err) {
    console.warn("Semantic tool matching failed, returning all tools:", err);
    return tools;
  }
}
