// STORY-011 — security-and-tenancy.md §4 "Tenant context propagation".

// STORY-011-E-4 (see that story's Implementation Decisions section) — the
// system actor used for worker jobs, where there is no human/API-key caller
// to attribute the action to. audit_log.actor_id is `uuid` with no FK
// constraint (schemas/tools-attribution-agency.md), so the all-zeros UUID is
// safe to use here — it can never collide with an application-generated
// UUIDv7 actor id.
export const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-000000000000";

// The three GUC names app.current_workspace()/current_actor()/
// current_scope_projects() (src/db/rls/generate.ts) read via current_setting.
// Declared once here so withTenantContext and every future caller use the
// exact same strings — a typo in one but not the other would silently
// reopen the fail-closed guarantee.
export const WORKSPACE_GUC = "app.current_workspace_id";
export const ACTOR_GUC = "app.current_actor_id";
export const SCOPE_GUC = "app.current_scope_projects";

// STORY-018 — the header a key-authenticated request carries the target
// workspace on (security-and-tenancy.md §5's enforcement chain: "X-Nominara-
// Workspace for an API key"). Session requests carry the workspace in the
// `ws` JWT claim instead and never send this header.
export const WORKSPACE_HEADER_NAME = "x-nominara-workspace";

// STORY-019 — security-and-tenancy.md §5 "Step-up re-auth" line / §13
// NFR-SEC-12: "a fresh WebAuthn or OTP within 5 minutes". Closed interval —
// exactly 5 minutes old still passes, refused only once strictly older.
export const STEP_UP_WINDOW_MS = 5 * 60 * 1000;

// Extensible on purpose: landing a method adds a literal here, not a rewrite
// of every call site that reads this list (assertStepUpFresh,
// StepUpRequiredException's `details.methods`). STORY-173 added "email_otp"
// when an email one-time code began stamping the session it creates
// (sessions.last_strong_auth_method, migration 0030) — security-and-tenancy.md
// §5: "a fresh WebAuthn or OTP within 5 minutes". OAuth is deliberately NOT
// here: a provider sign-in is not a re-authentication ceremony the platform
// itself performed.
export const ACCEPTABLE_STEP_UP_METHODS = ["webauthn", "email_otp"] as const;
export type StrongAuthMethod = (typeof ACCEPTABLE_STEP_UP_METHODS)[number];
