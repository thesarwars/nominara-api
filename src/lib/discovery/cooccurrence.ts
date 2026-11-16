import type { ClientBase } from "pg";
import type { ProposedCompetitor } from "../../../contracts/projects/index.js";
import { hasFactsStatusSql } from "../rollup/aggregate-day.js";
import { isBrand, MAX_PROPOSED_COMPETITORS } from "./competitors.js";

// STORY-043 AC11 - the THIRD competitor basis (product-spec.md section 2.1, api-specification.md 4.5): "entities co-occurring in the first capture run".
//
// SOURCE. The parsed `mention_facts` of the project's FIRST capture run: no model call, no fetch. Every detected entity is stored there
// (captures-and-facts.md: "every detected entity is stored, not only tracked ones"), and the ones nobody tracks are `entity_type = 'other'`.
// A tracked competitor is `'competitor'` and is therefore never re-proposed; the brand is `'brand'`.
//
// CO-OCCURRING MEANS "in the same answer as the brand". An entity is counted once per answer (result) that also names the brand. A run in
// which the brand is named nowhere proposes nothing on this basis: that is an honest empty, not a fall-back to every answer's entities
// (a decision recorded in the STORY-043 delivery note; widening it is a one-clause change to the `brand` CTE below).
//
// WHEN. A first capture does not exist while discovery runs, so this basis is applied AFTER it: `ProjectsService.discoveryFor` merges it into the
// payload it returns, behind the two bases `discover` wrote. It is derived on read from facts already stored, so nothing new is persisted and
// there is no migration.
//
// NOT FROM THE REFERENCE (named, so no one reads them as spec): the minimum of two answers, and the confidence, which is the share of the
// brand's answers that also name the entity.

export const COOCCURRENCE_BASIS = "co-occurring in first capture";
/** An entity named in a single answer is noise, not a pattern. */
export const MIN_COOCCURRING_RESULTS = 2;
const MAX_NAME_CHARS = 50; // the same ceiling competitors.ts puts on a name
const MAX_ENTITIES_READ = 20;

export interface CooccurringEntity {
  readonly label: string;
  /** Distinct answers in the first run that name both the brand and this entity. */
  readonly results: number;
  /** Distinct answers in the first run that name the brand. */
  readonly brandResults: number;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Untracked entities named alongside the brand in the project's first finished run, most frequent first. Runs inside the caller's tenant
 * transaction: no workspace predicate, RLS is the guarantee. Empty when there is no first run, it has not finished, or the brand is not named.
 */
export async function loadCooccurringEntities(client: Pick<ClientBase, "query">, projectId: string): Promise<CooccurringEntity[]> {
  const result = await client.query<{ label: string; results: number | string; brand_results: number | string }>(
    `WITH first_run AS (
       SELECT id, status FROM (SELECT id, status FROM capture_runs WHERE project_id = $1 ORDER BY created_at ASC, id ASC LIMIT 1) earliest
        WHERE status IN ('completed', 'partial')
     ),
     answers AS (
       SELECT c.id FROM answer_captures c JOIN first_run r ON c.run_id = r.id WHERE c.project_id = $1 AND ${hasFactsStatusSql("c.status")}
     ),
     brand AS (
       SELECT DISTINCT m.result_id FROM mention_facts m WHERE m.project_id = $1 AND m.entity_type = 'brand' AND m.result_id IN (SELECT id FROM answers)
     )
     SELECT min(m.entity_label) AS label, count(DISTINCT m.result_id)::int AS results, (SELECT count(*)::int FROM brand) AS brand_results
       FROM mention_facts m
      WHERE m.project_id = $1 AND m.entity_type = 'other' AND m.result_id IN (SELECT result_id FROM brand)
      GROUP BY lower(m.entity_label)
      ORDER BY results DESC, label ASC
      LIMIT ${String(MAX_ENTITIES_READ)}`,
    [projectId],
  );
  return result.rows.map((row) => ({ label: row.label, results: Number(row.results), brandResults: Number(row.brand_results) }));
}

/**
 * Fills the places the first two bases left empty (up to five in all) with co-occurring entities. Pure. The existing proposals keep their order
 * and are never displaced; a rival already proposed (by name, ignoring case and punctuation) or the brand itself is not added.
 */
export function mergeCooccurringEntities(input: {
  readonly own: readonly ProposedCompetitor[];
  readonly entities: readonly CooccurringEntity[];
  readonly ownBrandNames: readonly string[];
  /** Names the project already tracks (its competitors table): never proposed again. Compared like the proposals, ignoring case and punctuation. */
  readonly excludeNames?: readonly string[];
}): ProposedCompetitor[] {
  const merged = [...input.own].slice(0, MAX_PROPOSED_COMPETITORS);
  const seen = new Set([...merged.map((c) => norm(c.name)), ...(input.excludeNames ?? []).map(norm)]);

  const candidates = input.entities
    .flatMap((e) => {
      const name = e.label.trim();
      if (name === "" || name.length > MAX_NAME_CHARS || e.brandResults <= 0 || e.results < MIN_COOCCURRING_RESULTS) return [];
      if (isBrand(name, input.ownBrandNames)) return [];
      return [{ name, confidence: Math.min(1, Math.round((e.results / e.brandResults) * 100) / 100) }];
    })
    .sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));

  for (const candidate of candidates) {
    if (merged.length >= MAX_PROPOSED_COMPETITORS) break;
    const key = norm(candidate.name);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    merged.push({ name: candidate.name, confidence: candidate.confidence, basis: COOCCURRENCE_BASIS });
  }
  return merged;
}
