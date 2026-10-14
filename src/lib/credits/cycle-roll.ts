import type { ClientBase } from "pg";
import type { WalletState } from "./wallet.js";

// STORY-072 AC13 — the billing-cycle roll. RED-phase stub: the behaviour lands in the next commit.

export interface CycleRollRequest {
  readonly workspaceId: string;
  /** The plan's `credits_per_cycle` for the cycle that is starting. */
  readonly grant: number;
  /** `YYYY-MM-DD`, UTC. */
  readonly cycleStart: string;
  readonly cycleEnd: string;
}

export type CycleRollOutcome =
  | { readonly rolled: true; readonly expired: number; readonly granted: number; readonly wallet: WalletState }
  | { readonly rolled: false; readonly reason: "no_wallet" | "not_newer" };

export class CycleRollBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CycleRollBlockedError";
  }
}

export async function rollIncludedCycle(_tx: ClientBase, _request: CycleRollRequest): Promise<CycleRollOutcome> {
  return { rolled: false, reason: "not_newer" };
}
