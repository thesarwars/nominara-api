import type { ClientBase } from "pg";
import type { DekProvisioner } from "../../../modules/workspaces/ports/dek-provisioner.js";
import type { SyntheticTenant } from "./constants.js";

// STORY-004 AC5 — RED stub. Implemented in the next commit.

export interface SyntheticSeedPoolClient extends ClientBase {
  release(): void;
}
export interface SyntheticSeedPool {
  connect(): Promise<SyntheticSeedPoolClient>;
}

export interface SyntheticSeedDeps {
  /** DATABASE_URL_POOLED — `nominara_app` through pgBouncer. Every write goes through here. */
  readonly pool: SyntheticSeedPool;
  readonly dekProvisioner: DekProvisioner;
  readonly log: (line: string) => void;
}

export interface SyntheticTenantOutcome {
  readonly key: SyntheticTenant["key"];
  readonly workspaceId: string;
  readonly workspaceCreated: boolean;
  readonly planChanged: boolean;
  readonly granted: boolean;
  readonly projectsCreated: number;
  readonly promptsCreated: number;
  readonly competitorsCreated: number;
}

export async function runSyntheticSeed(_deps: SyntheticSeedDeps): Promise<SyntheticTenantOutcome[]> {
  throw new Error("not implemented");
}
