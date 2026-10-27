import { hostnameOf, isLocalTarget } from "../../local-target.js";

// STORY-169 — the refusal in front of `pnpm db:seed-demo`.
//
// This writes real rows — facts, an AUX audit, tasks, a wallet grant — onto
// whatever the two connection strings name, and it runs from an operator's
// shell rather than from a request a guard chain can intercept. So it gets
// its OWN, stricter check than `src/db/studio.ts`'s, not a reuse of it:
//
//   1. NODE_ENV must not be "production" — env.schema.ts's own note that a
//      staging deploy may legitimately run as NODE_ENV=production means this
//      alone is not sufficient, which is why it is one of three independent
//      conditions rather than the only one.
//   2. BOTH DATABASE_URL (the owner connection, for partition DDL and
//      listing projects) and DATABASE_URL_POOLED (nominara_app, for every
//      tenant write) must name a local host — `src/db/local-target.ts`'s
//      shared allow-list. Checking only one leaves a hybrid setup (a local
//      app pointed at a shared staging Postgres, or vice versa) able to seed
//      synthetic rows onto a database other engineers are using.
//   3. An explicit opt-in, `NOMINARA_DEMO_SEED=1`. Passing NODE_ENV and both
//      host checks is still not consent — a developer running the wrong
//      script by habit (e.g. copying a `pnpm db:seed-demo` line from a stale
//      note) should not silently write thousands of rows. The opt-in makes
//      running this script a decision made on purpose, every time.
//
// Every failure is reported by its OWN condition — never a single generic
// "refused" — so the operator sees exactly which of the three is unmet
// rather than having to guess.

export class DemoSeedRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoSeedRefusedError";
  }
}

export interface DemoSeedGuardInput {
  readonly nodeEnv: string | undefined;
  readonly databaseUrl: string | undefined;
  readonly databaseUrlPooled: string | undefined;
  /** `process.env.NOMINARA_DEMO_SEED` — must be exactly `"1"`. */
  readonly optIn: string | undefined;
}

/**
 * STORY-004 — the same three conditions, worded for whichever dev-only seed
 * is asking. `pnpm db:seed` (the synthetic tenants) reuses this rather than
 * retyping the checks; only the noun in each message and the name of the
 * opt-in variable differ, so the two refusals cannot drift apart.
 */
export interface LocalSeedWording {
  /** What the refusal says it will not seed, e.g. "demo data". */
  readonly what: string;
  /** The opt-in variable the operator must set to exactly "1". */
  readonly optInName: string;
}

const DEMO_WORDING: LocalSeedWording = { what: "demo data", optInName: "NOMINARA_DEMO_SEED" };

/** Throws a `DemoSeedRefusedError` naming the first unmet condition. Exported for its test — no database required. */
export function assertDemoSeedAllowed(input: DemoSeedGuardInput): void {
  assertLocalSeedAllowed(input, DEMO_WORDING);
}

/** The shared refusal behind every dev-only seed: NODE_ENV, both hosts local, an explicit opt-in. */
export function assertLocalSeedAllowed(input: DemoSeedGuardInput, wording: LocalSeedWording): void {
  const what = wording.what;
  if (input.nodeEnv === "production") {
    throw new DemoSeedRefusedError(
      `refusing to seed ${what}: NODE_ENV=production. This is a dev-only tool; it never runs in a production deploy.`,
    );
  }

  if (input.databaseUrl === undefined || input.databaseUrl.trim() === "") {
    throw new DemoSeedRefusedError(`refusing to seed ${what}: DATABASE_URL is not set.`);
  }
  if (input.databaseUrlPooled === undefined || input.databaseUrlPooled.trim() === "") {
    throw new DemoSeedRefusedError(`refusing to seed ${what}: DATABASE_URL_POOLED is not set.`);
  }

  if (!isLocalTarget(input.databaseUrl)) {
    throw new DemoSeedRefusedError(
      `refusing to seed ${what}: DATABASE_URL names "${hostnameOf(input.databaseUrl)}", not a local host. ` +
        "This seed writes synthetic tenant data and must never run against anything but a developer's own database.",
    );
  }
  if (!isLocalTarget(input.databaseUrlPooled)) {
    throw new DemoSeedRefusedError(
      `refusing to seed ${what}: DATABASE_URL_POOLED names "${hostnameOf(input.databaseUrlPooled)}", not a local host. ` +
        "Both connections must be local, or a hybrid setup could seed synthetic rows onto a shared database.",
    );
  }

  if (input.optIn !== "1") {
    throw new DemoSeedRefusedError(
      `refusing to seed ${what}: set ${wording.optInName}=1 to opt in explicitly. Passing every other check is not consent.`,
    );
  }
}
