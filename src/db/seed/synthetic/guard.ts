import { assertLocalSeedAllowed, type DemoSeedGuardInput } from "../demo/guard.js";

// STORY-004 AC5 — the refusal in front of `pnpm db:seed`. The SAME three
// conditions as the demo seed (src/db/seed/demo/guard.ts): NODE_ENV is not
// production, BOTH connection strings name a local host (src/db/local-
// target.ts, which reads the host node-postgres actually resolves, `?host=`
// override included), and an explicit opt-in. Its own opt-in variable, so a
// shell that has NOMINARA_DEMO_SEED=1 exported for one tool has not consented
// to the other. `pnpm dev:up` sets it for the one command; nothing else does.

export type SyntheticSeedGuardInput = DemoSeedGuardInput;

export const SYNTHETIC_SEED_OPT_IN = "NOMINARA_SYNTHETIC_SEED";

/** Throws a `DemoSeedRefusedError` naming the first unmet condition. */
export function assertSyntheticSeedAllowed(input: SyntheticSeedGuardInput): void {
  assertLocalSeedAllowed(input, { what: "synthetic tenants", optInName: SYNTHETIC_SEED_OPT_IN });
}
