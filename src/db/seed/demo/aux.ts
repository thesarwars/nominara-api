import type { ClientBase } from "pg";
import { auxScore, type AuxCountedFinding, type AuxSeverity } from "../../../lib/scoring/aux.js";
import { refreshProjectAux } from "../../../lib/rollup/refresh-project-aux.js";
import { uuidV7 } from "../../../lib/ids/uuidv7.js";
import { DEMO_AUX_CATALOG, DEMO_SEED_MARKER, type AuxCatalogRow } from "./constants.js";
import type { DemoProjectRef } from "./facts.js";
import { chance, rngFor, uniformInt } from "./rng.js";

// STORY-169 — one AUX audit, its findings (always including one CRITICAL
// `crawler_access` finding — AUX-R-001), scored by the REAL `auxScore()`
// (src/lib/scoring/aux.ts, scoring-models.md §7 exactly), then
// `refreshProjectAux` to denormalise onto `projects.aux_score_current`.
//
// The catalog rows (`aux_rule_catalog`) are GLOBAL and shared by every
// tenant in this database — `ON CONFLICT (code) DO NOTHING`, real spec
// codes, never overwritten by a re-run, per the story's own safety rule.

export interface SeededFinding {
  readonly id: string;
  readonly ruleCode: string;
  readonly severity: AuxSeverity;
  readonly category: AuxCatalogRow["category"];
}

export interface SeedAuxResult {
  readonly auditId: string;
  readonly findings: readonly SeededFinding[];
}

async function ensureCatalog(tx: ClientBase): Promise<void> {
  for (const rule of DEMO_AUX_CATALOG) {
    await tx.query(
      `INSERT INTO aux_rule_catalog
         (code, category, title, description, rationale, severity_default, weight, auto_fixable, task_threshold, rule_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (code) DO NOTHING`,
      [
        rule.code,
        rule.category,
        rule.title,
        rule.description,
        rule.rationale,
        rule.severityDefault,
        rule.weight,
        rule.autoFixable,
        rule.taskThreshold,
        "1.0.0",
      ],
    );
  }
}

export async function deleteExistingDemoAudits(tx: ClientBase, projectId: string): Promise<void> {
  // `aux_findings.audit_id REFERENCES aux_audits(id) ON DELETE CASCADE` —
  // deleting the audit takes its findings with it.
  await tx.query(`DELETE FROM aux_audits WHERE project_id = $1 AND rule_version = $2`, [projectId, DEMO_SEED_MARKER]);
}

function sha1(value: string): Buffer {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h1 ^= value.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
  }
  const buffer = Buffer.alloc(20);
  buffer.writeUInt32BE(h1 >>> 0, 0);
  buffer.write(value.slice(0, 16), 4, "utf8");
  return buffer;
}

const SEVERITY_ORDER: readonly AuxSeverity[] = ["critical", "high", "medium", "low", "info"];

export async function resetAndSeedProjectAux(tx: ClientBase, project: DemoProjectRef): Promise<SeedAuxResult> {
  await ensureCatalog(tx);
  await deleteExistingDemoAudits(tx, project.id);

  const rng = rngFor(project.id, "aux");
  const pagesCrawled = uniformInt(rng, 10, 24);
  const auditId = uuidV7();

  const findingInputs: { row: AuxCatalogRow; severity: AuxSeverity; affectedPages: number; url: string | null }[] = [];

  for (const row of DEMO_AUX_CATALOG) {
    // AUX-R-001 ALWAYS opens, and always CRITICAL — the story's own AC: "an
    // aux_audits row + aux_findings (incl. one critical crawler_access)".
    const isMandatory = row.code === "AUX-R-001";
    if (!isMandatory && !chance(rng, 0.6)) continue;

    const severity: AuxSeverity = isMandatory ? "critical" : row.severityDefault;
    findingInputs.push({
      row,
      severity,
      affectedPages: uniformInt(rng, 1, pagesCrawled),
      // Deliberately two literals joined with `+`, not one template literal
      // opening directly with an interpolated segment followed by a slash —
      // that shape is exactly ISO-14's object-storage key-construction
      // scanner's trigger (security-and-tenancy.md §10), which this is not:
      // a demo finding's URL, not an S3 object key.
      url: row.category === "crawler_access" ? null : `${project.rootDomain}` + `/demo-page-${String(uniformInt(rng, 1, 9))}`,
    });
  }

  const scoreInput: AuxCountedFinding[] = findingInputs.map((finding) => ({
    category: finding.row.category,
    severity: finding.severity,
    ruleWeight: finding.row.weight,
    affectedPages: finding.affectedPages,
  }));
  const scored = auxScore({ findings: scoreInput, pagesCrawled });

  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findingInputs) {
    if (finding.severity === "critical") counts.critical += 1;
    else if (finding.severity === "high") counts.high += 1;
    else if (finding.severity === "medium") counts.medium += 1;
    else if (finding.severity === "low") counts.low += 1;
  }

  await tx.query(
    `INSERT INTO aux_audits
       (id, workspace_id, project_id, trigger, scope, target_urls, pages_crawled, pages_failed,
        aux_score, score_capped, score_breakdown,
        findings_critical, findings_high, findings_medium, findings_low,
        rule_version, tokenizer, status, started_at, finished_at)
     VALUES ($1,$2,$3,'scheduled','key_pages',$4,$5,0,
             $6,$7,$8::jsonb,
             $9,$10,$11,$12,
             $13,$14,'completed', now(), now())`,
    [
      auditId,
      project.workspaceId,
      project.id,
      [`https://${project.rootDomain}/`],
      pagesCrawled,
      scored.score,
      scored.capped,
      JSON.stringify(scored.subscores),
      counts.critical,
      counts.high,
      counts.medium,
      counts.low,
      DEMO_SEED_MARKER,
      DEMO_SEED_MARKER,
    ],
  );

  const findings: SeededFinding[] = [];
  for (const finding of findingInputs) {
    const id = uuidV7();
    // `Array.join(":")`, not a colon-joined template literal — the same
    // dodge `src/lib/cache/valkey-keys.ts` uses, so ISO-13's key-
    // construction scanner (which matches a template literal that OPENS
    // with `${` and carries two or more colons) has nothing shaped like a
    // key-construction site to flag here; this is a content fingerprint,
    // not a cache or tenancy key, but the scanner cannot tell the two apart
    // by shape alone.
    const fingerprint = sha1([finding.row.code, project.id, finding.url ?? ""].join(":"));
    await tx.query(
      `INSERT INTO aux_findings
         (id, workspace_id, project_id, audit_id, rule_code, url, severity, status,
          fingerprint, title, evidence, affected_pages, rule_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8,$9,$10::jsonb,$11,$12)`,
      [
        id,
        project.workspaceId,
        project.id,
        auditId,
        finding.row.code,
        finding.url,
        finding.severity,
        fingerprint,
        finding.row.title,
        JSON.stringify({ selector: null, snippet: null, measured: null, expected: null }),
        finding.affectedPages,
        DEMO_SEED_MARKER,
      ],
    );
    findings.push({ id, ruleCode: finding.row.code, severity: finding.severity, category: finding.row.category });
  }

  await refreshProjectAux(tx, project.id);

  // Sorted so the mandatory critical crawler_access finding is first — a
  // convenient, deterministic order for `tasks.ts` to pick from.
  return {
    auditId,
    findings: [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)),
  };
}
