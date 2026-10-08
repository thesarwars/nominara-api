import type { AgencyTheme } from "../../../contracts/agency/index.js";

// NEW-E-099a (audit finding 1) — the workspace-level facts a portal read needs and `nominara_portal` cannot read.
//
// The portal role has portal_scope_* policies on the project-scoped fact tables and nothing on `workspaces`,
// `brand_themes`, `project_engines` or the `project_entitled_engines` view (0027 revokes it from the role on purpose).
// Rather than widen the role, PortalContextInterceptor reads these on the APP pool, in the same short per-request
// transaction that re-checks the token (workspace-scoped, before the portal transaction opens), and hands them to the
// services as plain data. The fact tables are still read on the portal pool, so scope stays RLS-enforced there.

/** One entitled, enabled engine of a project — a row of `project_entitled_engines`, the scheduler's own object. */
export interface PortalEngineRow {
  readonly engine_key: string;
  readonly display_name: string | null;
  /** `cadence ->> 'full'` as an integer; null when the plan schedules none. */
  readonly runs_per_cycle: number | null;
  /** `real` rendered as text, so the value the agency read casts back to is the same. */
  readonly weight: string;
}

/** A `project_engines` override row: it can reweight an engine; it can never add one. */
export interface PortalEngineOverride {
  readonly engine_key: string;
  readonly weight: string;
}

export interface PortalProjectEngines {
  readonly entitled: readonly PortalEngineRow[];
  readonly overrides: readonly PortalEngineOverride[];
}

export interface PortalWorkspaceFacts {
  readonly name: string;
  readonly timezone: string;
  readonly scoringVersion: string;
  readonly entitlementOverrides: unknown;
}

export interface PortalFacts {
  readonly workspace: PortalWorkspaceFacts;
  readonly theme: AgencyTheme;
  /** Keyed by project id, for the projects in the cookie's scope. */
  readonly engines: ReadonlyMap<string, PortalProjectEngines>;
}

/** What a service needs for ONE project: the workspace facts and that project's engine rows (empty if it has none). */
export interface PortalProjectFacts {
  readonly workspace: PortalWorkspaceFacts;
  readonly engines: PortalProjectEngines;
}

export function projectFacts(facts: PortalFacts, projectId: string): PortalProjectFacts {
  return { workspace: facts.workspace, engines: facts.engines.get(projectId) ?? { entitled: [], overrides: [] } };
}
