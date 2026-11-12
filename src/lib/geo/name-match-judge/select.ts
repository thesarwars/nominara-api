import { Logger } from "@nestjs/common";
import { HEURISTIC_JUDGE } from "../entity.js";
import { GeminiNameMatchJudge } from "./gemini-name-match-judge.js";
import { NAME_MATCH_PROMPT_VERSION } from "./constants.js";
import type { NameMatchJudge } from "./port.js";

// STORY-191 AC1 - which NameMatchJudge this process runs with. Same shape as the prompt naturaliser's selector.
//
//   NAME_MATCH_JUDGE=none (default)         -> null: the v1 case heuristic is the judge, and no Entity Authority score is published (decision 17).
//   NAME_MATCH_JUDGE=gemini and a key       -> the Gemini adapter (a Flash-class model, owner decision 99c).
//   NAME_MATCH_JUDGE=gemini and NO key      -> null, with one warning: a missing credential must not fail boot, and the heuristic guard then holds.
//
// `judgeInForce` is the identity the A2 analysis is stamped with. It is computed from the SAME inputs as `selectNameMatchJudge`, so the analysis
// can never claim a model judge that was not bound.

export interface NameMatchJudgeEnv {
  readonly NAME_MATCH_JUDGE: "none" | "gemini";
  readonly NAME_MATCH_JUDGE_MODEL: string;
  readonly NAME_MATCH_JUDGE_TIMEOUT_MS: number;
  readonly GEMINI_API_KEY?: string | undefined;
}

const keyed = (env: NameMatchJudgeEnv): boolean => env.NAME_MATCH_JUDGE === "gemini" && env.GEMINI_API_KEY !== undefined && env.GEMINI_API_KEY.length > 0;

export function selectNameMatchJudge(env: NameMatchJudgeEnv, fetchImpl?: typeof fetch): NameMatchJudge | null {
  if (env.NAME_MATCH_JUDGE === "none") return null;
  if (!keyed(env)) {
    new Logger("geo.name_match_judge").warn({ event: "geo.name_match_judge.unconfigured", provider: env.NAME_MATCH_JUDGE });
    return null;
  }
  return new GeminiNameMatchJudge({ apiKey: env.GEMINI_API_KEY!, model: env.NAME_MATCH_JUDGE_MODEL, timeoutMs: env.NAME_MATCH_JUDGE_TIMEOUT_MS, ...(fetchImpl === undefined ? {} : { fetchImpl }) });
}

/** The judge version A2 reads stored verdicts under: the model's, or `HEURISTIC_JUDGE` when none is bound. */
export function judgeInForce(env: NameMatchJudgeEnv): string {
  return keyed(env) ? `${env.NAME_MATCH_JUDGE_MODEL}:${NAME_MATCH_PROMPT_VERSION}` : HEURISTIC_JUDGE;
}
