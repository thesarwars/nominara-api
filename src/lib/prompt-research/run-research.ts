import { ScanCaptureError, type CachedAnswer, type LiveAnswer } from "../visibility-scan/run-scan.js";
import { failureFor, type ResearchAnswer, type ResearchCellFailure } from "./aggregate.js";
import { readResearchAnswer } from "./read-answer.js";

// STORY-080 - ask every selected prompt of every engine in the plan's set, and report what came back.
//
// PURE ORCHESTRATION over ports, exactly as run-scan.ts is: a cache probe, a live capture and a clock are handed in, so the deadline and the per-cell failures are
// testable without an engine. It holds no transaction and makes no call of its own (ADR-0003, KAD-06); the worker handler binds the ports.
//
// A CELL is one prompt asked of one engine - the unit the customer is charged for (5 credits per answer). A cell that fails is a NAMED failure; it never makes the
// rest of the run fail. At the deadline every cell still outstanding becomes a named `deadline_exceeded` failure and what landed is returned.

export { ScanCaptureError as ResearchCaptureError };

/** Cells in flight per engine. A run is at most 10 prompts, so this keeps an engine from being asked all of them at once. */
const CELLS_PER_ENGINE = 3;

export interface ResearchPorts {
  cached(engine: string, prompt: string): Promise<CachedAnswer | undefined>;
  /** Throws `ResearchCaptureError` for a classified failure; anything else is an unexpected error. */
  capture(engine: string, prompt: string): Promise<LiveAnswer>;
  now(): Date;
}

export interface RunResearchInput {
  readonly engines: readonly string[];
  readonly prompts: readonly string[];
  readonly deadlineMs: number;
}

export interface ResearchRunOutcome {
  readonly answers: ResearchAnswer[];
  readonly failures: ResearchCellFailure[];
  readonly deadlineReached: boolean;
  /** Live captures made, per engine - what the run cost us. A cached answer is not in it. */
  readonly liveCaptures: ReadonlyMap<string, number>;
}

export async function runPromptResearch(input: RunResearchInput, ports: ResearchPorts): Promise<ResearchRunOutcome> {
  const answers: ResearchAnswer[] = [];
  const failures: ResearchCellFailure[] = [];
  const live = new Map<string, number>();
  const settled = new Set<string>();
  let closed = false;
  const cell = (engine: string, index: number): string => `${engine}\u0000${String(index)}`;

  const fail = (engine: string, index: number, code: string): void => {
    if (closed || settled.has(cell(engine, index))) return;
    settled.add(cell(engine, index));
    const failure = failureFor(engine, code);
    failures.push({ engine, prompt_index: index, code: failure.code, reason: failure.reason });
  };

  const one = async (engine: string, index: number): Promise<void> => {
    const prompt = input.prompts[index] as string;
    try {
      let cached: CachedAnswer | undefined;
      try {
        cached = await ports.cached(engine, prompt);
      } catch {
        cached = undefined;
      }
      const liveAnswer = cached === undefined ? await ports.capture(engine, prompt) : undefined;
      const text = cached?.text ?? liveAnswer?.text ?? "";
      const structured = cached?.structuredCitations ?? liveAnswer?.structuredCitations;
      if (liveAnswer !== undefined) live.set(engine, (live.get(engine) ?? 0) + 1);
      const read = await readResearchAnswer(engine, text, structured);
      if (closed || settled.has(cell(engine, index))) return;
      settled.add(cell(engine, index));
      answers.push({ engine, promptIndex: index, entities: read.entities, domains: read.domains });
    } catch (error) {
      fail(engine, index, error instanceof ScanCaptureError ? error.code : "engine_error");
    }
  };

  const perEngine = async (engine: string): Promise<void> => {
    let next = 0;
    const lanes = Array.from({ length: Math.min(CELLS_PER_ENGINE, input.prompts.length) }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        // A closed run (the deadline fired) starts nothing more: a capture begun now would spend with no run left to record it.
        if (closed || index >= input.prompts.length) return;
        await one(engine, index);
      }
    });
    await Promise.all(lanes);
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), input.deadlineMs);
  });
  const outcome = await Promise.race([Promise.all(input.engines.map(perEngine)).then(() => "all" as const), deadline]);
  if (timer !== undefined) clearTimeout(timer);

  let deadlineReached = false;
  if (outcome === "deadline") {
    deadlineReached = true;
    for (const engine of input.engines) for (let index = 0; index < input.prompts.length; index += 1) fail(engine, index, "deadline_exceeded");
  }
  closed = true;
  answers.sort((a, b) => input.engines.indexOf(a.engine) - input.engines.indexOf(b.engine) || a.promptIndex - b.promptIndex);
  failures.sort((a, b) => input.engines.indexOf(a.engine) - input.engines.indexOf(b.engine) || (a.prompt_index ?? -1) - (b.prompt_index ?? -1));
  return { answers, failures, deadlineReached, liveCaptures: live };
}
