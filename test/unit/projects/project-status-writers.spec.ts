import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COLUMN_FOR_FIELD } from "../../../contracts/projects/index.js";

// STORY-077 — OWNER DECISION 2026-10-23, review round 2. Archived and person-paused projects use no plan slot, so a
// move OUT of `archived` or `paused` must go through `reactivateProject` (src/modules/projects/project-reactivation.ts),
// which re-counts `projects.max` under the workspace lock. Any other writer of `projects.status` reopens the bypass the
// owner closed: archive one, create one, then `UPDATE projects SET status = 'active'` on the first.
//
// This gate fails when a statement that writes `projects.status` appears outside the files that are allowed to:
//   * src/lib/billing/downgrade-pause.ts        — the cut-over pauses and resumes within the limit it plans;
//   * src/modules/prompts/activation.service.ts — initializing -> active (slot-neutral: both are tracking);
//   * src/modules/projects/project-reactivation.ts — the one door out of archived/paused.
//
// TEST FROM THE HAZARD: the DEFAULT is "report". A dynamic SET (`SET ${...}`) on projects cannot be read statically, so
// it is reported too unless its file is listed below with the reason it cannot write status; a Drizzle
// `.update(projects)` is reported unconditionally (there is none today). Adding a file to an allow-list needs the same
// review as the rule itself.

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const STATUS_WRITERS = new Set([
  "src/lib/billing/downgrade-pause.ts",
  "src/modules/prompts/activation.service.ts",
  "src/modules/projects/project-reactivation.ts",
]);

/** Files whose dynamic `UPDATE projects SET ${...}` is reviewed and cannot name status, with the reason. */
const REVIEWED_DYNAMIC_SET: Readonly<Record<string, string>> = {
  "src/modules/projects/projects.service.ts": "discovery confirmation: assignments come from COLUMN_FOR_FIELD (asserted below to exclude status) plus `discovery`",
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith(".ts") && !name.endsWith(".spec.ts") && !name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

export interface StatusWriteFinding {
  readonly kind: "status_write" | "dynamic_set" | "drizzle_update";
  readonly snippet: string;
}

/** Every statement in `source` that writes, or may write, `projects.status`. Exported for the breaker cases below. */
export function findProjectStatusWrites(source: string): StatusWriteFinding[] {
  const findings: StatusWriteFinding[] = [];
  // The SET list runs from `UPDATE projects` to its WHERE (or the end of the literal); `status =` must not be part of
  // a longer column name (discovery_status, domain_verification_status).
  const update = /UPDATE\s+projects\b([\s\S]*?)(\bWHERE\b|`|"|')/gi;
  for (const match of source.matchAll(update)) {
    const setList = match[1] ?? "";
    if (/\$\{/.test(setList)) findings.push({ kind: "dynamic_set", snippet: match[0].slice(0, 120) });
    else if (/(^|[^a-z_])status\s*=/i.test(setList)) findings.push({ kind: "status_write", snippet: match[0].slice(0, 120) });
  }
  for (const match of source.matchAll(/\.update\(\s*(schema\.)?projects\s*\)/g)) findings.push({ kind: "drizzle_update", snippet: match[0] });
  return findings;
}

describe("STORY-077 owner decision 2026-10-23 · only the allowed files write projects.status", () => {
  it("no file outside the allow-list writes projects.status, and every dynamic SET on projects is reviewed", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(REPO_ROOT, "src"))) {
      const rel = relative(REPO_ROOT, file).split(sep).join("/");
      for (const finding of findProjectStatusWrites(readFileSync(file, "utf8"))) {
        if (finding.kind === "status_write" && STATUS_WRITERS.has(rel)) continue;
        if (finding.kind === "dynamic_set" && rel in REVIEWED_DYNAMIC_SET) continue;
        offenders.push(`${rel}: ${finding.kind}: ${finding.snippet.replace(/\s+/g, " ")}`);
      }
    }
    expect(offenders, "route a move out of archived/paused through reactivateProject").toEqual([]);
  });

  it("the reviewed dynamic SET cannot name status: COLUMN_FOR_FIELD maps no field to a status column", () => {
    expect(Object.values(COLUMN_FOR_FIELD).filter((column) => /(^|_)status$/.test(String(column)))).toEqual([]);
  });

  // Breakers: the scanner itself must see the shapes the hazard takes, or the gate above is green by blindness.
  it.each([
    ["a literal status write", "await tx.query(`UPDATE projects SET status = 'active', updated_at = now() WHERE id = $1`, [id]);", "status_write"],
    ["a parameterised status write on one line", 'await c.query("UPDATE projects SET updated_at = now(), status = $2 WHERE id = $1", [id, s]);', "status_write"],
    ["a dynamic SET", "await c.query(`UPDATE projects SET ${parts.join(', ')} WHERE id = $1`, p);", "dynamic_set"],
    ["a Drizzle update", "await db.update(projects).set({ status: 'active' });", "drizzle_update"],
  ])("the scanner reports %s", (_name, source, kind) => {
    expect(findProjectStatusWrites(source).map((f) => f.kind)).toEqual([kind]);
  });

  it("the scanner does not report a longer column that merely ends in status", () => {
    expect(findProjectStatusWrites("await tx.query(\"UPDATE projects SET discovery_status = 'running' WHERE id = $1\", [id]);")).toEqual([]);
  });
});
