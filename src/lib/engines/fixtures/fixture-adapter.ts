import { BaseCaptureAdapter } from "../base-adapter.js";
import type { CaptureInput, CaptureMode, EngineKey } from "../contract.js";
import { FIXTURE_CASES, type FixturePayloadSet } from "./fixture-cases.js";

export interface FixtureAdapterConfig {
  readonly engineKey: EngineKey;
  readonly captureMode: CaptureMode;
  readonly adapterVersion: string;
  readonly supportsCitations: boolean;
  readonly concurrencyPerTask: number;
  readonly payloads: FixturePayloadSet;
}

/**
 * tracking-engine.md §1 — "FixtureAdapter: CI and local development —
 * recorded responses, no network." `capture()` is inherited from
 * BaseCaptureAdapter UNCHANGED: every fixture payload still runs through
 * the same `rawCaptureSchema` validation path a real adapter's response
 * would.
 *
 * Case selection is a private convention of this test double only, never
 * part of the public CaptureInput contract and never reachable from
 * production traffic: `input.promptText` must be exactly one of
 * FIXTURE_CASES (see fixture-cases.ts).
 */
export class FixtureAdapter extends BaseCaptureAdapter {
  readonly engineKey: EngineKey;
  readonly captureMode: CaptureMode;
  readonly adapterVersion: string;
  readonly supportsCitations: boolean;
  readonly concurrencyPerTask: number;

  constructor(private readonly config: FixtureAdapterConfig) {
    super();
    this.engineKey = config.engineKey;
    this.captureMode = config.captureMode;
    this.adapterVersion = config.adapterVersion;
    this.supportsCitations = config.supportsCitations;
    this.concurrencyPerTask = config.concurrencyPerTask;
  }

  protected async fetchVendorResponse(input: CaptureInput): Promise<unknown> {
    const fixtureCase = FIXTURE_CASES.find((candidate) => candidate === input.promptText);
    if (!fixtureCase) {
      throw new Error(
        `FixtureAdapter('${this.engineKey}') has no fixture case matching promptText '${input.promptText}' — expected one of ${FIXTURE_CASES.join(", ")}`,
      );
    }
    return this.config.payloads[fixtureCase];
  }

  async healthProbe(): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    return { ok: true, latencyMs: 0 };
  }
}
