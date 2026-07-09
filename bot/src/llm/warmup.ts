import type { BotConfig } from "../data/config.js";
import type { Logger } from "../logger.js";
import { EmbeddingsClient } from "../rag/embeddings.js";
import { createLlmClient } from "./fallback-client.js";

/**
 * Best-effort model pre-warm at startup so the first `!ask` / voice turn does
 * not pay a cold-load penalty. Never blocks startup on failure.
 */
export async function warmLlmModels(config: BotConfig, logger: Logger): Promise<void> {
  const jobs: Promise<void>[] = [];

  if (config.llmEnabled && config.llmUrl?.trim()) {
    const client = createLlmClient({
      primary: {
        baseUrl: config.llmUrl,
        model: config.llmModel || undefined,
        timeoutMs: 120_000,
        logger,
      },
      fallbackUrl: config.llmFallbackUrl,
      fallbackModel: config.llmFallbackModel || undefined,
      logger,
    });
    jobs.push(
      client
        .chat({
          messages: [{ role: "user", content: "ok" }],
          tools: undefined,
          tool_choice: "none",
          max_tokens: 1,
          temperature: 0,
        })
        .then(() => {
          logger.info(
            { url: config.llmUrl, model: config.llmModel || "(default)" },
            "Chat model warmed",
          );
        })
        .catch((err) => {
          logger.warn({ err, url: config.llmUrl }, "Chat model warm-up skipped");
        }),
    );
  }

  if (config.ragEnabled) {
    const embedUrl = config.embeddingUrl?.trim() || config.llmUrl?.trim();
    if (embedUrl) {
      const embeddings = new EmbeddingsClient({
        baseUrl: embedUrl,
        model: config.embeddingModel || undefined,
        timeoutMs: 120_000,
        logger,
      });
      jobs.push(
        embeddings
          .dimension()
          .then((dim) => {
            logger.info(
              { url: embedUrl, model: config.embeddingModel || "(default)", dim },
              "Embedding model warmed",
            );
          })
          .catch((err) => {
            logger.warn({ err, url: embedUrl }, "Embedding model warm-up skipped");
          }),
      );
    }
  }

  await Promise.all(jobs);
}
