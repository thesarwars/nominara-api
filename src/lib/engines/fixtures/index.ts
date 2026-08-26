import type { CaptureAdapter, EngineKey } from "../contract.js";
import { FixtureAdapter } from "./fixture-adapter.js";
import { chatgptFixtures } from "./payloads/chatgpt.js";
import { claudeFixtures } from "./payloads/claude.js";
import { geminiFixtures } from "./payloads/gemini.js";
import { googleAioFixtures } from "./payloads/google_aio.js";
import { googleAiModeFixtures } from "./payloads/google_ai_mode.js";
import { perplexityFixtures } from "./payloads/perplexity.js";

// STORY-027 — the map the registry consumes. Only the 6 active engines; the
// 4 reserved keys (D3) never get a fixture set or an adapter.
//
// captureMode/supportsCitations from tracking-engine.md §3: `licensed_serp`
// for both Google surfaces, `api` for the other four.
export type ActiveEngineKey = Exclude<EngineKey, "grok" | "copilot" | "meta_ai" | "deepseek">;

export const FIXTURE_ADAPTERS: Record<ActiveEngineKey, CaptureAdapter> = {
  google_aio: new FixtureAdapter({
    engineKey: "google_aio",
    captureMode: "licensed_serp",
    adapterVersion: "0.1.0-fixture",
    supportsCitations: true,
    concurrencyPerTask: 4,
    payloads: googleAioFixtures,
  }),
  google_ai_mode: new FixtureAdapter({
    engineKey: "google_ai_mode",
    captureMode: "licensed_serp",
    adapterVersion: "0.1.0-fixture",
    supportsCitations: true,
    concurrencyPerTask: 4,
    payloads: googleAiModeFixtures,
  }),
  perplexity: new FixtureAdapter({
    engineKey: "perplexity",
    captureMode: "api",
    adapterVersion: "0.1.0-fixture",
    supportsCitations: true,
    concurrencyPerTask: 6,
    payloads: perplexityFixtures,
  }),
  chatgpt: new FixtureAdapter({
    engineKey: "chatgpt",
    captureMode: "api",
    adapterVersion: "0.1.0-fixture",
    supportsCitations: false,
    concurrencyPerTask: 4,
    payloads: chatgptFixtures,
  }),
  gemini: new FixtureAdapter({
    engineKey: "gemini",
    captureMode: "api",
    adapterVersion: "0.1.0-fixture",
    supportsCitations: true,
    concurrencyPerTask: 4,
    payloads: geminiFixtures,
  }),
  claude: new FixtureAdapter({
    engineKey: "claude",
    captureMode: "api",
    adapterVersion: "0.1.0-fixture",
    supportsCitations: false,
    concurrencyPerTask: 3,
    payloads: claudeFixtures,
  }),
};
