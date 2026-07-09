/** Canonical Gemma 4 model tags — prefer these over Qwen/other families. */
export const GEMMA4_E2B_QAT = "hf.co/unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL" as const;

export const GEMMA4_12B_QAT = "hf.co/unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL" as const;

/** Google EmbeddingGemma — Gemma-family embeddings for RAG on Pi and x86. */
export const EMBEDDING_GEMMA = "embeddinggemma" as const;

/** Default chat model when config/env omit llmModel (Pi-local ollama). */
export const DEFAULT_CHAT_MODEL = GEMMA4_E2B_QAT;

/** Heavy analyst / long-context model (DESIGN §R1 delegate endpoint). */
export const GEMMA4_31B_QAT = "hf.co/unsloth/gemma-4-31B-it-qat-GGUF:UD-Q4_K_XL" as const;
