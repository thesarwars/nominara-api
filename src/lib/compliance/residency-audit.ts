// STORY-111 / NFR-CMP-04 - the automated resource-and-bucket residency audit.
//
// "A region-pinned workspace has no data at rest outside its region" is verified by this audit, not by a manual review. It takes the
// workspace -> region pins and an inventory of resources (S3 objects, buckets, ...) and reports every resource whose region is not its
// workspace's pin. FAIL CLOSED: a resource whose region could not be determined, or that names a workspace with no pin, is a VIOLATION,
// never a pass. A resource that names no workspace is listed as `unattributed` (shared infrastructure) so it is visible, not skipped.
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
  readonly violations: readonly ResidencyViolation[];
  readonly unattributed: readonly ResidencyResource[];
}

export class ResidencyViolationError extends Error {
  constructor(readonly violations: readonly ResidencyViolation[]) {
    super(`residency audit FAILED: ${String(violations.length)} resource(s) outside their workspace's region`);
    this.name = "ResidencyViolationError";
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
  const report = { checked: resources.length, violations, unattributed };
  if (options.failOnViolation === true && violations.length > 0) throw new ResidencyViolationError(violations);
  return report;
}
