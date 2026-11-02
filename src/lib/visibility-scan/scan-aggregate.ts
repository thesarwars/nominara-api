import type { ScanEngineFailure, ScanStreamCompleted, ScanStreamEngineResult } from "../../../contracts/tools/index.js";

// STORY-079 - the parser-free half of the scan's result handling: failure wording and the headline. Kept apart from scan-result.ts (which imports the
// parser) so that the tools module can build a terminal event from a stored snapshot without importing a module that owns a fact table.

const FAILURE_REASONS: Readonly<Record<string, string>> = {
  timeout: "The engine did not answer in time.",
  rate_limited: "The engine is rate-limiting requests right now.",
  quota_exhausted: "The engine's usage quota is exhausted for now.",
  auth_failed: "Nominara could not authenticate with the engine.",
  blocked: "The engine blocked the request.",
  malformed_response: "The engine returned an answer Nominara could not read.",
  upstream_5xx: "The engine had a server error.",
  content_policy_refusal: "The engine declined to answer this query.",
  deadline_exceeded: "The engine had not answered by the scan's latency deadline, so the scan returned what it had.",
  engine_spend_ceiling_reached: "This engine's monthly spend ceiling is reached, so it was not called.",
  engine_degraded: "The engine is currently degraded, so it was not called.",
  engine_unavailable: "The engine is currently unavailable, so it was not called.",
  engine_error: "The engine could not be queried because of an unexpected error.",
};

export function failureFor(engine: string, code: string): ScanEngineFailure {
  return { engine, code, reason: FAILURE_REASONS[code] ?? "The engine did not return an answer." };
}

export function aggregateScan(results: readonly ScanStreamEngineResult[], failures: readonly ScanEngineFailure[], engines: readonly string[]): ScanStreamCompleted["aggregate"] {
  const succeeded = engines.filter((e) => results.some((r) => r.engine === e));
  const failed = engines.filter((e) => !succeeded.includes(e));
  void failures;
  if (results.length === 0) {
    return { sov_estimate: null, citation_count: null, owned_citation_count: null, sentiment_label: null, brand_present: null, engines_succeeded: [], engines_failed: failed, estimated_fields: [] };
  }
  const scored = results.filter((r) => r.sentiment.score !== null);
  const meanScore = scored.length === 0 ? null : scored.reduce((a, r) => a + (r.sentiment.score ?? 0), 0) / scored.length;
  return {
    sov_estimate: results.reduce((a, r) => a + r.sov, 0) / results.length,
    citation_count: results.reduce((a, r) => a + r.citations.length, 0),
    owned_citation_count: results.reduce((a, r) => a + r.citations.filter((c) => c.is_owned).length, 0),
    sentiment_label: meanScore === null ? "absent" : meanScore >= 0.2 ? "positive" : meanScore <= -0.2 ? "negative" : "neutral",
    brand_present: results.some((r) => r.brand_present),
    engines_succeeded: succeeded,
    engines_failed: failed,
    estimated_fields: ["sov_estimate", "citation_count", "sentiment_label", "brand_present"],
  };
}

