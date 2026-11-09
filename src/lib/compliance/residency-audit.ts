// STORY-111 / NFR-CMP-04 - the automated resource-and-bucket residency audit.
//
// "A region-pinned workspace has no data at rest outside its region" is verified by this audit, not by a manual review. It takes the
// workspace -> region pins and an inventory of resources (S3 objects, buckets, ...) and reports every resource whose region is not its
// workspace's pin. FAIL CLOSED: a resource whose region could not be determined, or that names a workspace with no pin, is a VIOLATION,
// never a pass. A resource that names no workspace is listed as `unattributed` (shared infrastructure) so it is visible, not skipped. An EMPTY
// inventory while workspaces are pinned is fail-closed too.
//
// KNOWN EXCEPTION, owner/infra decision: the surviving compliance exports and the purge journal are keyed by PSEUDONYM or sit under
// `purge-journal/`, outside `{env}/{workspace}/`, and are written to the single configured raw bucket whatever the workspace's pin. An inventory
// that attributes objects by the `{env}/{workspace}/` prefix will list them as `unattributed`. That is deliberate for the journal and the
// exports (they must not name an erased tenant), but it means a pinned workspace's 7-year exports are not region-checked. Fix with STORY-003:
// a per-region compliance bucket, or an attribution rule that maps the pseudonym.
//
// The inventory SOURCE (listing real buckets and their regions) needs cloud access and is infrastructure (owner decision 45: Terraform and
// observability are parked); this core is the part the schedule runs against whatever inventory port is wired in.

export interface ResidencyResource {
  readonly kind: "s3_object" | "bucket" | "database" | "queue" | "cache";
  /** An object key or resource name. Never customer content. */
  readonly id: string;
  /** null = could not be determined. */
  readonly region: string | null;
  /** null = not attributable to a workspace (shared infrastructure). */
  readonly workspaceId: string | null;
}

export interface ResidencyViolation extends ResidencyResource {
  /** null when the workspace has no pin. */
  readonly expectedRegion: string | null;
}

export interface ResidencyReport {
  readonly checked: number;
  /** True when the inventory held no resource at all. With pinned workspaces that is a failure of the listing, not a pass. */
  readonly inventoryEmpty: boolean;
  readonly violations: readonly ResidencyViolation[];
  readonly unattributed: readonly ResidencyResource[];
}

export class ResidencyViolationError extends Error {
  constructor(readonly violations: readonly ResidencyViolation[]) {
    super(`residency audit FAILED: ${String(violations.length)} resource(s) outside their workspace's region`);
    this.name = "ResidencyViolationError";
  }
}

/** The inventory was empty while workspaces ARE region-pinned: an empty listing proves nothing about where their data is. */
export class ResidencyInventoryEmptyError extends Error {
  constructor(readonly pinnedWorkspaces: number) {
    super(`residency audit FAILED: the resource inventory is empty but ${String(pinnedWorkspaces)} workspace(s) are region-pinned`);
    this.name = "ResidencyInventoryEmptyError";
  }
}

export function auditResidency(
  pins: ReadonlyMap<string, string>,
  resources: readonly ResidencyResource[],
  options: { readonly failOnViolation?: boolean } = {},
): ResidencyReport {
  const violations: ResidencyViolation[] = [];
  const unattributed: ResidencyResource[] = [];
  for (const resource of resources) {
    if (resource.workspaceId === null) {
      unattributed.push(resource);
      continue;
    }
    const expected = pins.get(resource.workspaceId) ?? null;
    if (expected === null || resource.region === null || resource.region !== expected) {
      violations.push({ ...resource, expectedRegion: expected });
    }
  }
  const report = { checked: resources.length, inventoryEmpty: resources.length === 0, violations, unattributed };
  if (options.failOnViolation === true && report.inventoryEmpty && pins.size > 0) throw new ResidencyInventoryEmptyError(pins.size);
  if (options.failOnViolation === true && violations.length > 0) throw new ResidencyViolationError(violations);
  return report;
}
