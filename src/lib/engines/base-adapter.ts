import { incrementCounter } from "../telemetry/metrics.js";
import { rawCaptureSchema, type CaptureAdapter, type CaptureContext, type CaptureInput, type CaptureMode, type EngineKey, type RawCapture } from "./contract.js";
import { CaptureFailureError } from "./failure-taxonomy.js";

/**
 * Template-method base every real adapter extends. `capture()` is NOT
 * overridable — validation against `rawCaptureSchema` is the default path
 * (AC: "The base class makes this the default path, so an adapter that
 * skips it is visibly unusual"). Subclasses implement `fetchVendorResponse`
 * only.
 *
 * Writing a partially-understood response is worse than writing nothing: a
 * missing data point is recoverable, a wrong one silently corrupts a
 * published score (tracking-engine.md §2). A validation failure never
 * resolves `capture()` with a usable value — see this story's D4.
 */
export abstract class BaseCaptureAdapter implements CaptureAdapter {
  abstract readonly engineKey: EngineKey;
  abstract readonly captureMode: CaptureMode;
  abstract readonly adapterVersion: string;
  abstract readonly supportsCitations: boolean;
  abstract readonly concurrencyPerTask: number;

  async capture(input: CaptureInput, ctx: CaptureContext): Promise<RawCapture> {
    ctx.signal.throwIfAborted();

    const vendorPayload = await this.fetchVendorResponse(input, ctx);

    ctx.signal.throwIfAborted();

    const parsed = rawCaptureSchema.safeParse(vendorPayload);
    if (!parsed.success) {
      incrementCounter("nominara_capture_malformed_response_total", {
        engine_key: this.engineKey,
        adapter_version: this.adapterVersion,
      });
      // The vendor billed this call whether or not the payload is usable, and the spend meter is the
      // control that stops runaway spend: meter the cost the payload itself reports, when it is readable.
      const billed = (vendorPayload as { costUsd?: unknown } | null | undefined)?.costUsd;
      if (typeof billed === "number" && Number.isFinite(billed) && billed >= 0) await ctx.recordCost(billed);
      const failure = new CaptureFailureError("malformed_response", this.engineKey);
      ctx.span.recordException(failure);
      throw failure;
    }

    await ctx.recordCost(parsed.data.costUsd);

    ctx.signal.throwIfAborted();

    return parsed.data;
  }

  /** The vendor call. Adapters implement this only — never `capture()` itself. */
  protected abstract fetchVendorResponse(input: CaptureInput, ctx: CaptureContext): Promise<unknown>;

  abstract healthProbe(): Promise<{ ok: boolean; latencyMs: number; detail?: string }>;
}
