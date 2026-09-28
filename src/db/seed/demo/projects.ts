import type { ClientBase } from "pg";
import { uuidV7 } from "../../../lib/ids/uuidv7.js";
import { resolveEntitlements } from "../../../lib/entitlements/resolution.js";
import { SYSTEM_ACTOR_ID } from "../../../tenancy/constants.js";
import { DEMO_PROJECT_CREATED_KEY, DEMO_PROJECT_FIXTURES } from "./constants.js";

// STORY-169 — which projects the seed targets, and creating the fixture
// projects when a workspace has fewer than three.

export interface TargetProject {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly slug: string;
  readonly rootDomain: string;
}

/** Every active, non-deleted project in the workspace — the seed's target set, per the story: "target all active projects of one workspace". */
export async function listActiveProjects(tx: ClientBase, workspaceId: string): Promise<TargetProject[]> {
  const result = await tx.query<{ id: string; workspace_id: string; name: string; slug: string; root_domain: string }>(
    `SELECT id, workspace_id, name, slug::text AS slug, root_domain
       FROM projects
      WHERE workspace_id = $1 AND status = 'active' AND deleted_at IS NULL
      ORDER BY created_at`,
    [workspaceId],
  );
  return result.rows.map((row) => ({ id: row.id, workspaceId: row.workspace_id, name: row.name, slug: row.slug, rootDomain: row.root_domain }));
}

async function freeSlug(tx: ClientBase, workspaceId: string, base: string): Promise<string> {
  const taken = await tx.query<{ slug: string }>(
    `SELECT slug::text AS slug FROM projects WHERE workspace_id = $1 AND deleted_at IS NULL AND (slug = $2 OR slug LIKE $3)`,
    [workspaceId, base, `${base}-%`],
  );
  const used = new Set(taken.rows.map((row) => row.slug));
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${String(n)}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`too many projects already use the slug base "${base}"`);
}

function slugFromDomain(domain: string): string {
  return domain.split(".")[0]!.toLowerCase();
}

/**
 * The plan's `projects.max`, resolved through the real entitlement pipeline
 * — never a hardcoded number (`no-hardcoded-plan-values`). `null` ("not
 * applicable"), `"custom"`, or `"uncapped"` all mean this plan places no
 * numeric ceiling the seed can read, so they resolve to `Infinity` here —
 * `min(3, cap)` then simply stays 3.
 */
export async function projectsMaxCap(tx: ClientBase, workspaceId: string): Promise<number> {
  const resolved = await resolveEntitlements(tx, workspaceId);
  const raw = resolved.entitlements["projects.max"]?.value;
  return typeof raw === "number" ? raw : Number.POSITIVE_INFINITY;
}

/**
 * Creates demo projects (HubSpot CRM / Stripe Payments / Zendesk Service
 * Hub) up to `min(3, projects.max)`, never more, when the workspace has
 * fewer active projects than that. Marks each created project with
 * `fingerprint.demo_seed_created = true` (read only by `--purge`, to decide
 * which projects it deletes outright versus only cleans) and
 * `status = 'active'` immediately — this seed writes facts straight into it,
 * skipping the real `initializing` discovery flow entirely (KAD-06: nothing
 * here makes a network call).
 */
export async function ensureDemoProjects(tx: ClientBase, workspaceId: string): Promise<TargetProject[]> {
  const existing = await listActiveProjects(tx, workspaceId);
  const cap = await projectsMaxCap(tx, workspaceId);
  const target = Math.min(3, cap);
  if (existing.length >= target) return [];

  const created: TargetProject[] = [];
  for (const fixture of DEMO_PROJECT_FIXTURES) {
    if (existing.length + created.length >= target) break;
    // A workspace that already has a project on this exact domain (e.g. a
    // re-run after a partial earlier seed) is not given a second one.
    if (existing.some((project) => project.rootDomain === fixture.rootDomain)) continue;

    const id = uuidV7();
    const slug = await freeSlug(tx, workspaceId, slugFromDomain(fixture.rootDomain));
    await tx.query(
      `INSERT INTO projects
         (id, workspace_id, name, slug, root_url, root_domain, status, fingerprint, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'active',$7::jsonb,$8)`,
      [id, workspaceId, fixture.name, slug, `https://${fixture.rootDomain}`, fixture.rootDomain, JSON.stringify({ [DEMO_PROJECT_CREATED_KEY]: true }), SYSTEM_ACTOR_ID],
    );
    created.push({ id, workspaceId, name: fixture.name, slug, rootDomain: fixture.rootDomain });
  }
  return created;
}
