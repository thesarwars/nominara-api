import type { ScanEngineFailure, ScanStreamEngineResult } from "../../../contracts/tools/index.js";
import { failureFor } from "./scan-aggregate.js";
import { parseScanAnswer, toEngineResult } from "./scan-result.js";

// STORY-079 - run a scan's engines in parallel and report each one AS IT LANDS (AC "results stream per engine").
//
// PURE ORCHESTRATION over ports: a cache probe, a live capture, a publisher and a clock are handed in, so the deadline, the partial result and the
// cache labelling are testable without an engine. It holds no transaction and makes no call of its own (ADR-0003); the worker handler binds the ports.
//
// THE DEADLINE RETURNS WHAT LANDED. At `deadlineMs` every engine still outstanding becomes a named `deadline_exceeded` failure and the run resolves
// with the rest - four engines now beat six in a minute. A late answer is ignored: it can no longer change a result that was already reported.

/** A capture the engine refused or could not make, with a taxonomy code the failure text is looked up by. */
export class ScanCaptureError extends Error {
  constructor(readonly code: string) {
    super(`scan capture failed: ${code}`);
    this.name = "ScanCaptureError";
  }
}

export interface CachedAnswer {
  readonly text: string;
  readonly structuredCitations?: readonly { readonly url: string; readonly title?: string; readonly slot: number }[];
  /** When the answer was ORIGINALLY captured. */
  readonly capturedAt: Date;
}

export interface LiveAnswer {
  readonly text: string;
  readonly structuredCitations?: readonly { readonly url: string; readonly title?: string; readonly slot: number }[];
  readonly latencyMs: number;
}

export type ScanPublished =
  | { readonly kind: "engine_result"; readonly result: ScanStreamEngineResult }
  | { readonly kind: "engine_failed"; readonly failure: ScanEngineFailure };

export interface ScanPorts {
  /** A cached answer for the engine, or undefined. May throw: a cache that cannot be read is a miss. */
  cached(engine: string): Promise<CachedAnswer | undefined>;
  /** A live capture. Throws `ScanCaptureError` for a classified failure; anything else is an unexpected error. */
  capture(engine: string): Promise<LiveAnswer>;
  publish(event: ScanPublished): Promise<void>;
  now(): Date;
}

export interface RunScanInput {
  readonly engines: readonly string[];
  readonly brandName: string;
  readonly brandUrl: string | null;
  readonly competitors: readonly string[];
  readonly deadlineMs: number;
}

export interface ScanRunOutcome {
  readonly results: ScanStreamEngineResult[];
  readonly failures: ScanEngineFailure[];
  readonly deadlineReached: boolean;
  /** The hinted competitor names that at least one answer actually mentioned. */
  readonly competitors: string[];
}

export async function runVisibilityScan(input: RunScanInput, ports: ScanPorts): Promise<ScanRunOutcome> {
  const results: ScanStreamEngineResult[] = [];
  const failures: ScanEngineFailure[] = [];
  const mentioned = new Set<string>();
  const settled = new Set<string>();
  let closed = false;

  const fail = async (engine: string, code: string): Promise<void> => {
    if (closed || settled.has(engine)) return;
    settled.add(engine);
    const failure = failureFor(engine, code);
    failures.push(failure);
    await ports.publish({ kind: "engine_failed", failure }).catch(() => undefined);
  };

  const one = async (engine: string): Promise<void> => {
    try {
      let cached: CachedAnswer | undefined;
      try {
        cached = await ports.cached(engine);
      } catch {
        cached = undefined;
      }
      const live = cached === undefined ? await ports.capture(engine) : undefined;
      const text = cached?.text ?? live?.text ?? "";
      const structured = cached?.structuredCitations ?? live?.structuredCitations;
      const parse = await parseScanAnswer({
        engineKey: engine,
        text,
        ...(structured !== undefined ? { structuredCitations: structured } : {}),
        brandName: input.brandName,
        brandUrl: input.brandUrl,
        competitors: input.competitors,
      });
      if (closed || settled.has(engine)) return;
      settled.add(engine);
      const now = ports.now();
      const result = toEngineResult({
        engine,
        parse,
        capturedAt: cached?.capturedAt ?? now,
        now,
        latencyMs: live?.latencyMs ?? 0,
        cacheLayer: cached === undefined ? "none" : "l1",
        excerpt: parse.normalizedText,
      });
      for (const mention of parse.mentions) if (mention.mention.entityType === "competitor") mentioned.add(mention.mention.entityLabel);
      results.push(result);
      await ports.publish({ kind: "engine_result", result }).catch(() => undefined);
    } catch (error) {
      await fail(engine, error instanceof ScanCaptureError ? error.code : "engine_error");
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), input.deadlineMs);
  });
  const outcome = await Promise.race([Promise.all(input.engines.map(one)).then(() => "all" as const), deadline]);
  if (timer !== undefined) clearTimeout(timer);

  let deadlineReached = false;
  if (outcome === "deadline") {
    deadlineReached = true;
    for (const engine of input.engines) await fail(engine, "deadline_exceeded");
  }
  closed = true;
  return { results, failures, deadlineReached, competitors: input.competitors.filter((name) => mentioned.has(name)) };
}
