import { Logger } from "@nestjs/common";
import { GeminiNaturaliser } from "./adapters/gemini-naturaliser.js";
import type { PromptNaturaliser } from "./ports/naturaliser.js";

// STORY-045 AC3 - which PromptNaturaliser this process runs with. Same shape as embedding-provider.selector.ts.
//
//   PROMPT_NATURALISER=none (default)          -> null: every pass is the template-only path (FR-FAN-01d).
//   PROMPT_NATURALISER=gemini and a key        -> the Gemini adapter (a Flash-class model, owner decision 2026-10-28 #3).
//   PROMPT_NATURALISER=gemini and NO key       -> null, with one warning. A naturaliser is an optimisation of the text, never a
//                                                precondition of generating it, so a missing credential must not fail boot or a request.
//
// The key is read from the validated env passed in and is never logged.

export interface NaturaliserSelectionEnv {
  readonly PROMPT_NATURALISER: "none" | "gemini";
  readonly PROMPT_NATURALISER_MODEL: string;
  readonly PROMPT_NATURALISER_TIMEOUT_MS: number;
  readonly GEMINI_API_KEY?: string | undefined;
}

export function selectNaturaliser(env: NaturaliserSelectionEnv): PromptNaturaliser | null {
  if (env.PROMPT_NATURALISER === "none") return null;
  if (env.GEMINI_API_KEY === undefined || env.GEMINI_API_KEY.length === 0) {
    new Logger("prompts.naturaliser").warn({ event: "prompts.naturaliser.unconfigured", provider: env.PROMPT_NATURALISER });
    return null;
  }
  return new GeminiNaturaliser({ apiKey: env.GEMINI_API_KEY, model: env.PROMPT_NATURALISER_MODEL, timeoutMs: env.PROMPT_NATURALISER_TIMEOUT_MS });
}

/**
 * The naturaliser the REQUEST-PATH service may hold: always null, whatever the configuration says.
 *
 * `POST /v1/projects/{id}/prompts/generate` runs inside TenantContextInterceptor's BEGIN..COMMIT, and the audit and idempotency
 * interceptors write into that same transaction after the handler. A bound adapter would therefore await a third party (Gemini) with a
 * transaction open for up to PROMPT_NATURALISER_TIMEOUT_MS, which ADR-0003 / NFR-ARCH-04 forbid, and Gemini is one of our capture
 * engines (NFR-ARCH-01). The only fixes are an enqueued, 202-and-read-back generation (a contract change) or a route outside the
 * ambient transaction (a new pattern): both are STORY-045 decision #5, which is the owner's. Until it is answered the adapter is built,
 * tested and selectable (`selectNaturaliser`) but not bound here, and a configuration that asks for it is REPORTED rather than silently
 * ignored or silently honoured.
 */
export function selectRequestPathNaturaliser(env: NaturaliserSelectionEnv): PromptNaturaliser | null {
  if (env.PROMPT_NATURALISER !== "none") {
    new Logger("prompts.naturaliser").warn({
      event: "prompts.naturaliser.held_off_request_path",
      provider: env.PROMPT_NATURALISER,
      reason: "ADR-0003 / NFR-ARCH-04: the generate route's transaction is open; awaiting STORY-045 decision #5",
    });
  }
  return null;
}
