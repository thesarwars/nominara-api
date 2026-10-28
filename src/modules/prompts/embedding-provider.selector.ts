import { OpenAiEmbeddingProvider } from "./adapters/openai-embedding-provider.js";
import { StandInEmbeddingProvider, STAND_IN_EMBEDDING_MODEL } from "./adapters/stand-in-embedding-provider.js";
import { EmbeddingProviderError, type EmbeddingBatchResult, type EmbeddingProvider } from "./ports/embedding-provider.js";

// STORY-133 - which EmbeddingProvider this process runs with. Same shape as email-sender.selector.ts.
//
//   OPENAI_API_KEY set                      -> the OpenAI adapter (text-embedding-3-large at 1536 dimensions).
//   no key, outside production              -> the deterministic stand-in (owner decision 2026-10-28 #1).
//   no key, NODE_ENV=production             -> NEITHER. A fake in production wiring writes junk vectors that L2 then trusts, so this
//                                              provider refuses every call and the job takes the retry ladder, loudly.
//
// The key is read from the validated env passed in, never logged.

export interface EmbeddingSelectionEnv {
  readonly NODE_ENV: string;
  readonly OPENAI_API_KEY?: string | undefined;
}

class UnconfiguredEmbeddingProvider implements EmbeddingProvider {
  readonly model = STAND_IN_EMBEDDING_MODEL.replace("stand-in-bow", "unconfigured");
  readonly dimensions = 1536;
  async embed(_texts: readonly string[]): Promise<EmbeddingBatchResult> {
    throw new EmbeddingProviderError("no embedding provider is configured (OPENAI_API_KEY is unset)", { retryable: true });
  }
}

export function selectEmbeddingProvider(env: EmbeddingSelectionEnv): EmbeddingProvider {
  if (env.OPENAI_API_KEY !== undefined && env.OPENAI_API_KEY.length > 0) {
    return new OpenAiEmbeddingProvider({ apiKey: env.OPENAI_API_KEY });
  }
  if (env.NODE_ENV === "production") return new UnconfiguredEmbeddingProvider();
  return new StandInEmbeddingProvider();
}
