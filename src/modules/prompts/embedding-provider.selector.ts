import { OpenAiEmbeddingProvider } from "./adapters/openai-embedding-provider.js";
import { OpenRouterEmbeddingProvider } from "./adapters/openrouter-embedding-provider.js";
import { StandInEmbeddingProvider, STAND_IN_EMBEDDING_MODEL } from "./adapters/stand-in-embedding-provider.js";
import { EmbeddingProviderError, type EmbeddingBatchResult, type EmbeddingProvider } from "./ports/embedding-provider.js";

// STORY-133 - which EmbeddingProvider this process runs with. Same shape as email-sender.selector.ts.
//
//   OPENAI_API_KEY set                      -> the OpenAI adapter (text-embedding-3-large at 1536 dimensions).
//   no key, outside production              -> the deterministic stand-in (owner decision 2026-10-28 #1).
//   no key, NODE_ENV=production             -> NEITHER. A fake in production wiring writes junk vectors that L2 then trusts, so this
//                                              provider refuses every call and the job takes the retry ladder, loudly.
//
// Owner decision 41 (2026-10-30): EMBEDDING_PROVIDER picks explicitly. `auto` (the default) is the behaviour above, so a process that
// merely HAS an OPENROUTER_API_KEY (for the engine adapter) never starts sending embedding text to it.
//
//   openrouter + OPENROUTER_API_KEY, not production -> OpenRouter's free nemotron embeddings (development only: free providers may
//                                                      log input). No key, or production -> the refusing provider, never the stand-in.
//   stand-in, not production                        -> the deterministic stand-in whatever keys are set. Production -> refuses.
//   openai                                          -> the OpenAI adapter; no OPENAI_API_KEY -> refuses.
//
// The key is read from the validated env passed in, never logged.

export interface EmbeddingSelectionEnv {
  readonly NODE_ENV: string;
  readonly OPENAI_API_KEY?: string | undefined;
  readonly EMBEDDING_PROVIDER?: "auto" | "stand-in" | "openrouter" | "openai" | undefined;
  readonly OPENROUTER_API_KEY?: string | undefined;
  readonly OPENROUTER_EMBED_REQUESTS_PER_MINUTE?: number | undefined;
}

class UnconfiguredEmbeddingProvider implements EmbeddingProvider {
  readonly model = STAND_IN_EMBEDDING_MODEL.replace("stand-in-bow", "unconfigured");
  readonly dimensions = 1536;
  constructor(private readonly reason: string = "OPENAI_API_KEY is unset") {}
  async embed(_texts: readonly string[]): Promise<EmbeddingBatchResult> {
    throw new EmbeddingProviderError(`no embedding provider is configured (${this.reason})`, { retryable: true });
  }
}

const present = (value: string | undefined): value is string => value !== undefined && value.length > 0;

export function selectEmbeddingProvider(env: EmbeddingSelectionEnv): EmbeddingProvider {
  switch (env.EMBEDDING_PROVIDER) {
    case "openrouter":
      if (env.NODE_ENV === "production") return new UnconfiguredEmbeddingProvider("OpenRouter free embeddings are development only");
      if (!present(env.OPENROUTER_API_KEY)) return new UnconfiguredEmbeddingProvider("EMBEDDING_PROVIDER=openrouter but OPENROUTER_API_KEY is unset");
      return new OpenRouterEmbeddingProvider({
        apiKey: env.OPENROUTER_API_KEY,
        ...(env.OPENROUTER_EMBED_REQUESTS_PER_MINUTE !== undefined ? { requestsPerMinute: env.OPENROUTER_EMBED_REQUESTS_PER_MINUTE } : {}),
      });
    case "stand-in":
      return env.NODE_ENV === "production" ? new UnconfiguredEmbeddingProvider("the stand-in never runs in production") : new StandInEmbeddingProvider();
    case "openai":
      return present(env.OPENAI_API_KEY) ? new OpenAiEmbeddingProvider({ apiKey: env.OPENAI_API_KEY }) : new UnconfiguredEmbeddingProvider();
    default:
      break;
  }
  if (env.OPENAI_API_KEY !== undefined && env.OPENAI_API_KEY.length > 0) {
    return new OpenAiEmbeddingProvider({ apiKey: env.OPENAI_API_KEY });
  }
  if (env.NODE_ENV === "production") return new UnconfiguredEmbeddingProvider();
  return new StandInEmbeddingProvider();
}
