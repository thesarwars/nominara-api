// STORY-004 AC5 — the three synthetic tenants `pnpm db:seed` writes.
//
// testing-strategy.md §12: "The awkward seed shapes are the point. A pristine
// fixture tenant proves nothing: the entity matcher's failure modes are
// common-word collisions and substring overlaps, and the confidence machinery
// only shows itself below the sample threshold."
//
// The four shapes the story names, and where each one lives:
//   - a common-word brand name            -> "Apple"               (growth tenant)
//   - a multi-word brand name             -> "Blue Ocean Roasters" (growth tenant)
//   - a substring-colliding competitor pair -> "Cloud" / "Cloudflare Systems" (business tenant)
//   - a project with a single prompt      -> "Acme Single"         (starter tenant)
//
// The names deliberately echo test/isolation/support/three-tenant-fixture.ts
// (copied, never imported: that file belongs to the isolation suite and is not
// to be modified or depended on from src/).
//
// Owner decision 2026-10-27 item 5: one tenant per PAID tier, set through the
// real `plan:set` path; each gets a fixed 500-credit grant through the ledger
// grant path under a deterministic idempotency key; owner emails on the
// reserved `nominara.test` domain so `OTP_DEV_LOG_CODES` sign-in works.
//
// IDENTIFIERS ARE FIXED, which is what makes a re-seed a no-op rather than a
// second set of tenants: every workspace and project row is written
// `ON CONFLICT (id) DO NOTHING`. They are UUIDv7-shaped (KAD-15). Domains use
// the reserved `.test` TLD, so no seeded project names a real company's site.

/** `tracked_prompts.generator_meta` / `projects.fingerprint` key marking a row this seed wrote. */
export const SYNTHETIC_SEED_MARKER_KEY = "synthetic_seed";
/** The value stamped under `SYNTHETIC_SEED_MARKER_KEY`. */
export const SYNTHETIC_SEED_MARKER = "story-004";

/** Owner decision 2026-10-27 item 5 — the fixed grant every synthetic tenant receives once. */
export const SYNTHETIC_GRANT_CREDITS = 500;

/**
 * The ledger idempotency key of that grant. `ux_credit_ledger_idem` is
 * (workspace_id, entry_type, idempotency_key, attempt), so a second seed run
 * finds the entry already present and moves nothing (`grantCredits` returns
 * `applied: false`). Bump the suffix only to deliberately grant again.
 */
export const SYNTHETIC_GRANT_IDEMPOTENCY_KEY = "seed:synthetic:grant:v1";

/** `audit_log.action` of the grant's audit row. */
export const SYNTHETIC_GRANT_AUDIT_ACTION = "billing.seed_credits_granted";

/** What `plan:set`'s provenance flags carry for a seed-driven plan write. */
export const SYNTHETIC_PLAN_PROVENANCE = {
  operator: "db:seed",
  ticket: "STORY-004",
  reason: "synthetic local-development tenant (STORY-004 AC5)",
} as const;

export type SyntheticPaidPlan = "starter" | "growth" | "business";

export type SyntheticIntent = "recommendation" | "head_to_head" | "alternatives" | "use_case_fit" | "pricing_value";
export type SyntheticFunnelStage = "awareness" | "consideration" | "decision";

export interface SyntheticPrompt {
  readonly text: string;
  readonly intentArchetype: SyntheticIntent;
  readonly funnelStage: SyntheticFunnelStage;
}

export interface SyntheticCompetitor {
  readonly name: string;
  readonly rootDomain: string;
}

export interface SyntheticProject {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly rootDomain: string;
  readonly brandAliases: readonly string[];
  readonly prompts: readonly SyntheticPrompt[];
  readonly competitors: readonly SyntheticCompetitor[];
}

export interface SyntheticTenant {
  /** Short stable label, for logs and tests. */
  readonly key: "single-prompt" | "common-word" | "substring-pair";
  readonly workspaceId: string;
  readonly name: string;
  readonly slug: string;
  readonly planKey: SyntheticPaidPlan;
  readonly ownerEmail: string;
  readonly projects: readonly SyntheticProject[];
}

export const SYNTHETIC_TENANTS: readonly SyntheticTenant[] = [
  {
    key: "single-prompt",
    workspaceId: "019a2004-0000-7000-8000-00000000a001",
    name: "Synthetic Starter Co",
    slug: "synthetic-starter-co",
    planKey: "starter",
    ownerEmail: "owner-starter@nominara.test",
    projects: [
      {
        // ONE prompt, so every capture of this project stays below the
        // confidence sample threshold and the low-confidence path is always
        // the one a developer sees first.
        id: "019a2004-0000-7000-8000-00000000b001",
        name: "Acme Single",
        slug: "acme-single",
        rootDomain: "acme-single.test",
        brandAliases: [],
        prompts: [
          { text: "What is the best project tracker for a two-person studio?", intentArchetype: "recommendation", funnelStage: "consideration" },
        ],
        competitors: [{ name: "Trackwise", rootDomain: "trackwise.test" }],
      },
    ],
  },
  {
    key: "common-word",
    workspaceId: "019a2004-0000-7000-8000-00000000a002",
    name: "Synthetic Growth Co",
    slug: "synthetic-growth-co",
    planKey: "growth",
    ownerEmail: "owner-growth@nominara.test",
    projects: [
      {
        // A dictionary word as the brand: "apple" appears in answers about
        // fruit, pie and orchards, and the matcher must not count those.
        id: "019a2004-0000-7000-8000-00000000b002",
        name: "Apple",
        slug: "apple",
        rootDomain: "apple.test",
        brandAliases: [],
        prompts: [
          { text: "Which laptop brand is best for video editing on a budget?", intentArchetype: "recommendation", funnelStage: "consideration" },
          { text: "What are good alternatives to a premium laptop for students?", intentArchetype: "alternatives", funnelStage: "consideration" },
          { text: "Is a premium laptop worth the price for office work?", intentArchetype: "pricing_value", funnelStage: "decision" },
        ],
        competitors: [
          { name: "Orchard Computing", rootDomain: "orchard-computing.test" },
          { name: "Pear Devices", rootDomain: "pear-devices.test" },
        ],
      },
      {
        // A multi-word brand: an answer that says "Blue Ocean" or "Ocean
        // Roasters" is a partial mention, not the brand.
        id: "019a2004-0000-7000-8000-00000000b003",
        name: "Blue Ocean Roasters",
        slug: "blue-ocean-roasters",
        rootDomain: "blue-ocean-roasters.test",
        brandAliases: ["Blue Ocean Coffee"],
        prompts: [
          { text: "Which coffee roaster ships the freshest beans by subscription?", intentArchetype: "recommendation", funnelStage: "consideration" },
          { text: "Best specialty coffee roasters for espresso at home?", intentArchetype: "use_case_fit", funnelStage: "awareness" },
          { text: "How do small-batch coffee roasters compare with supermarket brands?", intentArchetype: "head_to_head", funnelStage: "consideration" },
        ],
        competitors: [
          { name: "Deep Sea Coffee", rootDomain: "deep-sea-coffee.test" },
          { name: "Harbor Roast", rootDomain: "harbor-roast.test" },
        ],
      },
    ],
  },
  {
    key: "substring-pair",
    workspaceId: "019a2004-0000-7000-8000-00000000a003",
    name: "Synthetic Business Co",
    slug: "synthetic-business-co",
    planKey: "business",
    ownerEmail: "owner-business@nominara.test",
    projects: [
      {
        // The competitor pair collides by substring: every mention of
        // "Cloudflare Systems" also contains "Cloud", so a naive substring
        // match double-counts one competitor as two.
        id: "019a2004-0000-7000-8000-00000000b004",
        name: "Nimbus Hosting",
        slug: "nimbus-hosting",
        rootDomain: "nimbus-hosting.test",
        brandAliases: ["Nimbus"],
        prompts: [
          { text: "Which managed hosting provider is best for a growing SaaS?", intentArchetype: "recommendation", funnelStage: "consideration" },
          { text: "What are the alternatives to the big cloud providers for small teams?", intentArchetype: "alternatives", funnelStage: "consideration" },
          { text: "How does managed hosting pricing compare across providers?", intentArchetype: "pricing_value", funnelStage: "decision" },
        ],
        competitors: [
          { name: "Cloud", rootDomain: "cloud.test" },
          { name: "Cloudflare Systems", rootDomain: "cloudflare-systems.test" },
        ],
      },
    ],
  },
];
