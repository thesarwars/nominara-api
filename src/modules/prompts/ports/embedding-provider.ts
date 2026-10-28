// STORY-133 — the seam the embedding provider fills behind, without any caller importing a provider SDK. Same port-plus-adapter
// precedent as EMAIL_SENDER (src/modules/identity/ports/email-sender.ts), OAUTH_CLIENT and DEK_PROVISIONER.
//
// *** REACHABLE FROM THE `embed.batch` HANDLER AND FROM NOWHERE ELSE. *** NFR-ARCH-01 / KAD-06: no request handler may call an
// embedding provider. eslint.config.js bans importing this file, the adapters and the selector from everywhere except the
// handler (src/lib/queue/handlers/embed-batch.handler.ts), so a request handler importing the port fails CI.
//
// Interface and error type only. A model that returns a vector of the wrong size, or fewer vectors than texts, is an error here
// and never a partial result: a half-embedded batch would make L2's `IS NOT NULL` guard true for rows nobody compared.

export const EMBEDDING_PROVIDER = Symbol("EMBEDDING_PROVIDER");

export interface EmbeddingBatchResult {
  /** One vector per input text, in input order, each `EmbeddingProvider.dimensions` long. */
  readonly vectors: readonly (readonly number[])[];
  /** The provider's own identifier for the model that produced them. Written beside every stored vector (EC-23). */
  readonly model: string;
  /** What the PROVIDER reported it charged for this call. Never an estimate: `embed_tokens` exists so a runaway is visible. */
  readonly totalTokens: number;
}

export interface EmbeddingProvider {
  /** The stable model identifier vectors are stored under. Pinned: a provider alias that silently upgrades makes the pin a lie. */
  readonly model: string;
  /** The dimension of every vector. The schema's vector columns are `halfvec(1536)`. */
  readonly dimensions: number;
  /** ONE provider call for up to 96 texts (system-architecture.md section 4). */
  embed(texts: readonly string[]): Promise<EmbeddingBatchResult>;
}

/** A failed provider call. Carries no request text and no credential, ever. */
export class EmbeddingProviderError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;
  constructor(message: string, options: { readonly status?: number; readonly retryable: boolean }) {
    super(message);
    this.name = "EmbeddingProviderError";
    this.status = options.status;
    this.retryable = options.retryable;
  }
}
