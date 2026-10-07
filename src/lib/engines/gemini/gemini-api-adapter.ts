import { BaseCaptureAdapter } from "../base-adapter.js";
import type { CaptureContext, CaptureInput, CaptureMode, EngineKey } from "../contract.js";

// NEW-A-3 — INTENTIONALLY UNIMPLEMENTED. This file pins the public surface the RED tests in
// gemini.spec.ts are written against; NEW-A-4 implements every body below (native fetch, no SDK,
// single turn, google_search always set, hard per-capture timeout, modelVersion -> modelFingerprint,
// ctx.recordCost). Nothing here is wired into the registry.

export interface GeminiApiAdapterConfig {
  readonly apiKey: string;
  /** Injected so unit tests never touch the network. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Hard per-capture timeout; an elapsed timeout is classified `timeout`. */
  readonly timeoutMs: number;
  readonly model?: string;
}

/** The generateContent request body we send. */
export interface GeminiRequest {
  readonly contents: readonly { readonly role: "user"; readonly parts: readonly { readonly text: string }[] }[];
  readonly tools?: readonly Record<string, unknown>[];
}

/** Thrown BEFORE dispatch when a request lacks google_search: an ungrounded answer measures the wrong thing. */
export class UngroundedRequestError extends Error {
  constructor() {
    super("gemini request refused before dispatch: google_search grounding is not enabled");
    this.name = "UngroundedRequestError";
  }
}

const NOT_IMPLEMENTED = "NEW-A-4: not implemented";

export function buildGeminiRequest(_input: CaptureInput): GeminiRequest {
  throw new Error(NOT_IMPLEMENTED);
}

export function assertGrounded(_request: GeminiRequest): void {
  throw new Error(NOT_IMPLEMENTED);
}

export class GeminiApiAdapter extends BaseCaptureAdapter {
  readonly engineKey: EngineKey = "gemini";
  readonly captureMode: CaptureMode = "api";
  readonly adapterVersion = "0.1.0";
  readonly supportsCitations = true;
  readonly concurrencyPerTask = 4;

  constructor(protected readonly config: GeminiApiAdapterConfig) {
    super();
  }

  /** Guard + HTTP call. Rejects with UngroundedRequestError, before any fetch, on an ungrounded request. */
  async dispatch(_request: GeminiRequest, _ctx: CaptureContext): Promise<unknown> {
    throw new Error(NOT_IMPLEMENTED);
  }

  protected async fetchVendorResponse(_input: CaptureInput, _ctx: CaptureContext): Promise<unknown> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async healthProbe(): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
