import {
  PROMPT_RESEARCH_ALSO_MENTIONED_THRESHOLD,
  type PromptResearchResult,
} from "../../../contracts/tools/index.js";
import { failureFor } from "../visibility-scan/scan-aggregate.js";

// STORY-080 - a run's answers added up: every detected entity ranked by share of answer, the domains feeding those answers, and the collapsed group.
//
// PARSER-FREE, like scan-aggregate.ts: the tools module reads this without importing a module that owns a fact table.
//
// BRAND-AGNOSTIC: the input carries no brand and the output has no field that could mark one. An entity is a name and two counts, on the same footing as every other.

/** One answered cell: which engine, which prompt, and what the answer named. */
export interface ResearchAnswer {
  readonly engine: string;
  readonly promptIndex: number;
  readonly entities: readonly string[];
  /** One entry per citation (repeats allowed): the domain it points at. */
  readonly domains: readonly string[];
}

export interface ResearchCellFailure {
  readonly engine: string;
  readonly prompt_index: number | null;
  readonly code: string;
  readonly reason: string;
}

export interface AggregateResearchInput {
  readonly prompts: readonly string[];
  /** Cells asked: prompts x engines. */
  readonly asked: number;
  readonly answers: readonly ResearchAnswer[];
  readonly failures: readonly ResearchCellFailure[];
  readonly engines: readonly string[];
}

export interface AggregatedResearch {
  readonly result: PromptResearchResult;
  /** Distinct entities detected (ranked + collapsed). `null` when no answer came back at all: nothing was measured, which is not a measured zero. */
  readonly entitiesFound: number | null;
  readonly enginesSucceeded: string[];
  readonly enginesFailed: string[];
}

/** Keep the stored payload well inside the 24 KB `result_json` trigger. */
const MAX_ENTITIES = 50;
const MAX_ALSO_MENTIONED = 50;
const MAX_DOMAINS = 30;

const byCountThenName = <T extends { name: string; answers_named: number }>(a: T, b: T): number => b.answers_named - a.answers_named || a.name.localeCompare(b.name);

export function aggregateResearch(input: AggregateResearchInput): AggregatedResearch {
  const named = new Map<string, { name: string; answers: number }>();
  for (const answer of input.answers) {
    for (const name of new Set(answer.entities)) {
      const key = name.toLowerCase();
      const row = named.get(key);
      if (row === undefined) named.set(key, { name, answers: 1 });
      else row.answers += 1;
    }
  }
  const all = [...named.values()].map((row) => ({ name: row.name, answers_named: row.answers }));
  const total = all.reduce((sum, row) => sum + row.answers_named, 0);
  const ranked = all.filter((row) => row.answers_named >= PROMPT_RESEARCH_ALSO_MENTIONED_THRESHOLD).sort(byCountThenName);
  const collapsed = all.filter((row) => row.answers_named < PROMPT_RESEARCH_ALSO_MENTIONED_THRESHOLD).sort(byCountThenName);

  const domains = new Map<string, { citations: number; answers: number }>();
  for (const answer of input.answers) {
    const counts = new Map<string, number>();
    for (const domain of answer.domains) counts.set(domain, (counts.get(domain) ?? 0) + 1);
    for (const [domain, n] of counts) {
      const row = domains.get(domain) ?? { citations: 0, answers: 0 };
      row.citations += n;
      row.answers += 1;
      domains.set(domain, row);
    }
  }

  const answeredBy = new Map<string, number>();
  for (const answer of input.answers) answeredBy.set(answer.engine, (answeredBy.get(answer.engine) ?? 0) + 1);
  const failedBy = new Map<string, number>();
  for (const failure of input.failures) failedBy.set(failure.engine, (failedBy.get(failure.engine) ?? 0) + 1);
  const enginesSucceeded = input.engines.filter((engine) => (answeredBy.get(engine) ?? 0) > 0);
  const enginesFailed = input.engines.filter((engine) => !enginesSucceeded.includes(engine));

  const result: PromptResearchResult = {
    schema_version: 1,
    mode: "run",
    prompts: [...input.prompts],
    answers: { asked: input.asked, answered: input.answers.length, failed: input.failures.length },
    entities: ranked.slice(0, MAX_ENTITIES).map((row) => ({ name: row.name, answers_named: row.answers_named, share_of_answer: total === 0 ? 0 : row.answers_named / total })),
    also_mentioned: collapsed.slice(0, MAX_ALSO_MENTIONED),
    also_mentioned_threshold: PROMPT_RESEARCH_ALSO_MENTIONED_THRESHOLD,
    domains: [...domains.entries()]
      .map(([domain, row]) => ({ domain, citations: row.citations, answers_cited: row.answers }))
      .sort((a, b) => b.citations - a.citations || b.answers_cited - a.answers_cited || a.domain.localeCompare(b.domain))
      .slice(0, MAX_DOMAINS),
    engines: input.engines.map((engine) => ({ engine, answered: answeredBy.get(engine) ?? 0, failed: failedBy.get(engine) ?? 0 })),
    engine_failures: input.failures.map((f) => ({ engine: f.engine, prompt_index: f.prompt_index, code: f.code, reason: f.reason })),
    estimated: true,
  };
  return { result, entitiesFound: input.answers.length === 0 ? null : all.length, enginesSucceeded, enginesFailed };
}

export { failureFor };
