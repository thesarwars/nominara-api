import type { CaptureAdapter, EngineKey } from "./contract.js";
import { engineKeySchema } from "./contract.js";
import { FIXTURE_ADAPTERS } from "./fixtures/index.js";

// STORY-027 — mirrors src/lib/auth/oauth-providers.ts's static-map shape and
// src/modules/identity/ports/oauth-client.ts's interface-only port shape. No
// DI container, no Nest provider: a plain static Record the rest of the
// system reads through resolveEngine()/healthProbeEngine().
//
// D3 (Implementation decisions) — the registry knows all 10 DB-canonical
// `engines.key` values (0003_projects_prompts_captures.up.sql). Adapters
// exist for the 6 active engines only; the 4 reserved keys resolve to an
// explicit, typed refusal — never `undefined`.
export type EngineRefusalReason = "disabled" | "unknown";

export class EngineRefusalError extends Error {
  readonly engineKey: string;
  readonly reason: EngineRefusalReason;

  constructor(engineKey: string, reason: EngineRefusalReason) {
    super(
      reason === "disabled"
        ? `engine '${engineKey}' is disabled — no adapter is enabled for it (tracking-engine.md §3)`
        : `unknown engine key '${engineKey}'`,
    );
    this.name = "EngineRefusalError";
    this.engineKey = engineKey;
    this.reason = reason;
  }
}

type EngineRegistration = { readonly status: "active"; readonly adapter: CaptureAdapter } | { readonly status: "disabled" };

// Wired to the fixture adapters (STORY-027 T14) — every active key's
// adapter is stamped with its own engineKey (never inferred from a
// payload), read straight off FIXTURE_ADAPTERS.
const REGISTRY: Record<EngineKey, EngineRegistration> = {
  google_aio: { status: "active", adapter: FIXTURE_ADAPTERS.google_aio },
  google_ai_mode: { status: "active", adapter: FIXTURE_ADAPTERS.google_ai_mode },
  perplexity: { status: "active", adapter: FIXTURE_ADAPTERS.perplexity },
  chatgpt: { status: "active", adapter: FIXTURE_ADAPTERS.chatgpt },
  gemini: { status: "active", adapter: FIXTURE_ADAPTERS.gemini },
  claude: { status: "active", adapter: FIXTURE_ADAPTERS.claude },
  grok: { status: "disabled" },
  copilot: { status: "disabled" },
  meta_ai: { status: "disabled" },
  deepseek: { status: "disabled" },
};

export function resolveEngine(engineKey: string): CaptureAdapter {
  const parsed = engineKeySchema.safeParse(engineKey);
  if (!parsed.success) {
    throw new EngineRefusalError(engineKey, "unknown");
  }
  const registration = REGISTRY[parsed.data];
  if (registration.status === "disabled") {
    throw new EngineRefusalError(parsed.data, "disabled");
  }
  return registration.adapter;
}

export async function healthProbeEngine(engineKey: string): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
  return resolveEngine(engineKey).healthProbe();
}
