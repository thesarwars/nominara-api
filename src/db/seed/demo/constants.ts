// STORY-169 — shared constants for the dev-only demo seed
// (`src/db/seed-demo.ts` and its `src/db/seed/demo/*` helpers).

/**
 * The marker this seed stamps onto every row it can — `answer_captures.
 * normalizer_version`, `aux_audits.rule_version`/`tokenizer`, `aux_findings.
 * rule_version`, and `tasks.playbook_payload->>'demo_seed_marker'`.
 *
 * "Mark everything" (the story's own words) is an honesty requirement, not
 * only a purge mechanism: `answer_captures.normalizer_version` and
 * `aux_audits.rule_version` are customer-visible provenance fields, and a
 * synthetic row wearing the SAME version string as a real one would make an
 * invented number look measured — exactly the STORY-145/147 concern
 * `denormalizeProject`'s own header names. `--purge` also reads this marker
 * on the tables that carry it, on top of scoping by project, as a second,
 * independent check before it deletes anything.
 */
export const DEMO_SEED_MARKER = "demo-seed";

/** `projects.fingerprint` marker for a project THIS SEED created (as opposed to a pre-existing project it only seeded data into). Only `--purge` reads this key; it decides which projects are deleted outright versus only cleaned. */
export const DEMO_PROJECT_CREATED_KEY = "demo_seed_created";

/** `tasks.playbook_payload` marker key, read back by `--purge`. */
export const DEMO_TASK_MARKER_KEY = "demo_seed_marker";

export interface DemoProjectFixture {
  readonly name: string;
  readonly rootDomain: string;
}

/**
 * The three demo projects created when a workspace has fewer than three —
 * "HubSpot CRM", "Stripe Payments", "Zendesk Service Hub", per the story.
 * Real, recognisable brands make the seeded Command Center legible at a
 * glance; the domains are their real marketing domains, used here only as
 * the `root_domain`/`root_url` of a synthetic project row, never crawled
 * (KAD-06 — nothing on this path makes a network call).
 */
export const DEMO_PROJECT_FIXTURES: readonly DemoProjectFixture[] = [
  { name: "HubSpot CRM", rootDomain: "hubspot.com" },
  { name: "Stripe Payments", rootDomain: "stripe.com" },
  { name: "Zendesk Service Hub", rootDomain: "zendesk.com" },
];

/**
 * Prompt templates, parameterised by the project's own name — ~8 per
 * project, spanning a few of `tracked_prompts.intent_archetype`'s real
 * values so the Prompts matrix and SoV are not all one shape.
 */
export interface PromptTemplate {
  readonly text: (projectName: string) => string;
  readonly intentArchetype:
    | "recommendation"
    | "head_to_head"
    | "alternatives"
    | "use_case_fit"
    | "pricing_value"
    | "integration_capability";
  readonly funnelStage: "awareness" | "consideration" | "decision";
}

export const DEMO_PROMPT_TEMPLATES: readonly PromptTemplate[] = [
  { text: (n) => `best ${n} alternatives for a growing team`, intentArchetype: "alternatives", funnelStage: "consideration" },
  { text: (n) => `${n} vs the competition`, intentArchetype: "head_to_head", funnelStage: "consideration" },
  { text: (n) => `is ${n} worth the price`, intentArchetype: "pricing_value", funnelStage: "decision" },
  { text: (n) => `what is ${n} used for`, intentArchetype: "use_case_fit", funnelStage: "awareness" },
  { text: (n) => `recommend a tool like ${n}`, intentArchetype: "recommendation", funnelStage: "awareness" },
  { text: (n) => `does ${n} integrate with common tools`, intentArchetype: "integration_capability", funnelStage: "consideration" },
  { text: (n) => `${n} pricing plans compared`, intentArchetype: "pricing_value", funnelStage: "decision" },
  { text: (n) => `${n} for enterprise use cases`, intentArchetype: "use_case_fit", funnelStage: "consideration" },
];

/** Two or three synthetic competitors per project, deterministic by position. */
export const DEMO_COMPETITOR_NAMES: readonly string[] = ["Northwind Rival", "Contoso Alternative", "Globex Challenger"];

// ---------------------------------------------------------------------------
// AUX rule catalog — a subset of aux-and-geo-analysis.md §2's real 34 rules,
// one per category so the AUX score exercises every W_cat weight, plus the
// one this seed always opens a CRITICAL finding against (AUX-R-001). Every
// field below is transcribed from that table — rule code, category, weight
// and auto_fixable — never invented. `severity_default` is the rule's OWN
// column (aux_rule_catalog), separate from the SEVERITY A GIVEN FINDING
// carries (aux_findings.severity), which this seed sets explicitly per
// finding.
// ---------------------------------------------------------------------------
export interface AuxCatalogRow {
  readonly code: string;
  readonly category: "crawler_access" | "structured_data" | "render_mode" | "context_fitness" | "freshness" | "entity_clarity";
  readonly title: string;
  readonly description: string;
  readonly rationale: string;
  readonly severityDefault: "critical" | "high" | "medium" | "low" | "info";
  readonly weight: number;
  readonly autoFixable: boolean;
  readonly taskThreshold: "critical" | "high" | "medium" | "low";
}

export const DEMO_AUX_CATALOG: readonly AuxCatalogRow[] = [
  {
    code: "AUX-R-001",
    category: "crawler_access",
    title: "AI crawler Disallow",
    description: "robots.txt disallows a named AI crawler (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, or another) from the tracked prompt set's paths.",
    rationale: "engines that cannot fetch a page cannot cite it, no matter how good the content is",
    severityDefault: "critical",
    weight: 0.3,
    autoFixable: true,
    taskThreshold: "critical",
  },
  {
    code: "AUX-R-008",
    category: "structured_data",
    title: "JSON-LD syntax error",
    description: "a <script type=\"application/ld+json\"> block fails to parse.",
    rationale: "an engine cannot read a broken structured-data block, so it falls back to the visible text alone",
    severityDefault: "critical",
    weight: 0.14,
    autoFixable: true,
    taskThreshold: "critical",
  },
  {
    code: "AUX-R-010",
    category: "structured_data",
    title: "No primary entity schema",
    description: "the page has none of Organization, Product, SoftwareApplication, Service, or Article schema.",
    rationale: "engines cannot name what the page is about without a declared entity",
    severityDefault: "high",
    weight: 0.12,
    autoFixable: true,
    taskThreshold: "high",
  },
  {
    code: "AUX-R-019",
    category: "context_fitness",
    title: "Page token count excessive",
    description: "the rendered page exceeds the safe context window an engine will read in full.",
    rationale: "content past the window is invisible to the engine no matter how relevant it is",
    severityDefault: "high",
    weight: 0.16,
    autoFixable: false,
    taskThreshold: "high",
  },
  {
    code: "AUX-R-026",
    category: "render_mode",
    title: "JS-only main content",
    description: "the main content differs materially between the raw HTML and the rendered DOM.",
    rationale: "a non-executing crawler sees the raw HTML — content that only exists after JavaScript runs is invisible to it",
    severityDefault: "high",
    weight: 0.34,
    autoFixable: false,
    taskThreshold: "high",
  },
  {
    code: "AUX-R-030",
    category: "freshness",
    title: "dateModified absent",
    description: "no dateModified in schema and no visible last-updated date.",
    rationale: "engines weight freshness signals when choosing between otherwise-similar sources",
    severityDefault: "medium",
    weight: 0.5,
    autoFixable: true,
    taskThreshold: "medium",
  },
  {
    code: "AUX-R-032",
    category: "entity_clarity",
    title: "Brand name absent from title/H1",
    description: "neither the page title nor its H1 contains a brand alias.",
    rationale: "an engine summarising the page has no brand name to attribute the content to",
    severityDefault: "medium",
    weight: 0.34,
    autoFixable: true,
    taskThreshold: "medium",
  },
];

// ---------------------------------------------------------------------------
// task_generation_rules — the two codes named by the story, transcribed from
// scoring-models.md §15's alert catalog (trigger_kind, and the code each
// alert generates) and page-inventory.md's wireframe (the example impact/
// effort figures that motivate the category and effort_band chosen here —
// the exact impact_score and effort_band THIS SEED assigns to an individual
// task are generated per-task below, not copied from the wireframe).
// ---------------------------------------------------------------------------
export interface TaskRuleRow {
  readonly code: string;
  readonly category: "content" | "technical" | "authority" | "monitoring";
  readonly titleTemplate: string;
  readonly descriptionTemplate: string;
  readonly triggerKind:
    | "sov_drop"
    | "source_absence";
  readonly defaultPriority: number;
  readonly impactWeight: number;
  readonly effortBand: "xs" | "s" | "m" | "l" | "xl";
}

export const DEMO_TASK_RULES: readonly TaskRuleRow[] = [
  {
    code: "TG-SOV-DROP-ENGINE",
    category: "monitoring",
    titleTemplate: "Share of voice dropped on {engine}",
    descriptionTemplate: "Share of voice on {engine} fell at least 15% relative to the prior 7-day window.",
    triggerKind: "sov_drop",
    defaultPriority: 2,
    impactWeight: 0.8,
    effortBand: "m",
  },
  {
    code: "TG-SOURCE-ABSENCE",
    category: "authority",
    titleTemplate: "Seed {domain} as a citable source",
    descriptionTemplate: "{domain} is a seedable source with a critical citation gap for this project.",
    triggerKind: "source_absence",
    defaultPriority: 3,
    impactWeight: 0.6,
    effortBand: "l",
  },
];
