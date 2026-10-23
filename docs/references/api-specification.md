# API Specification

Base URL `https://api.nominara.com/v1`; EU residency `https://api.eu.nominara.com/v1`.
Content type `application/json; charset=utf-8` for requests and success responses. **Error responses carry `application/problem+json; charset=utf-8`**, per RFC 9457 — see [§2](#2-error-taxonomy). Streaming endpoints use `text/event-stream`.

**The specification source of truth is `nominara-api/contracts` (zod).** The OpenAPI 3.1 document is generated from it and served at `GET /v1/openapi.json`. Drift between the schemas and the committed document fails CI. Hand-editing the OpenAPI file is never correct.

**The RBAC permission matrix is a generated contract artifact too** (STORY-019): `contracts/permission-matrix.generated.json`, built from the table `RbacGuard` evaluates ([`security-and-tenancy.md` §6](./security-and-tenancy.md#6-permission-matrix)), and exported by `@nominara/client` as `PERMISSION_MATRIX`. `contracts:check` fails on drift. No endpoint serves it.

---

## 1. Request envelope

### Headers

| Header | Required | Notes |
|---|---|---|
| `Authorization: Bearer <jwt>` | one of | Interactive sessions. Ed25519 JWT, 15-minute TTL. The `ws` claim pins the active workspace. |
| `Authorization: Bearer nk_live_…` | one of | Service API key. Requires `X-Nominara-Workspace`. |
| `X-Nominara-Workspace: <uuid>` | API keys only | Must match the key's workspace; a mismatch is `403 workspace_mismatch`. |
| `Idempotency-Key: <=255 chars>` | on every billable or external-effect `POST` | 24-hour replay window. Identical key + identical body returns the cached response; identical key + different body is `409 idempotency_conflict`. On a credit-spending route a key starting with `prompt_activate:` (any case) is refused (`400 validation_failed`): that namespace holds the server's own ledger keys. |
| `If-Match: <etag>` | on `PATCH` of mutable config | Optimistic concurrency on `projects`, `tracked_prompts`, `share_tokens`. |
| `X-Nominara-Confirmed-Credits: <int>` | on every credit-spending execution route | Echoes the exact figure shown to the operator. A mismatch is `409 price_changed`. Digits only: `1e3`, `0x10` and `+5` are refused (`400`). |
| `X-Nominara-Scoring-Version` | optional | Pins analytics reads to a scoring version during a cut-over. |
| `X-Request-Id` | optional | Not an identity; recorded as a span attribute only. The response `X-Request-Id` header, `meta.request_id` and `error.request_id` always carry the server-generated OpenTelemetry trace id (32 lowercase hex); an inbound `traceparent` is likewise ignored. |

Every **successful** response to an authenticated route carries wallet state, read inside the request's own transaction, so **no client ever needs a second call to keep a balance chip current** (`NFR-API-12`). Error responses omit it deliberately: the transaction is rolling back, and a balance read out of it is not current. `402 insufficient_credits` carries the full wallet in its own `details` (STORY-072, owner decision 2026-10-14):

```
X-Nominara-Credits-Available: 1462
X-Nominara-Credits-Reserved:  120
X-Nominara-Credits-Expiring:  380      # included-bucket credits expiring at cycle end
X-Nominara-Credits-Cycle-End: 2026-09-01
X-Nominara-Plan:              business
X-Nominara-Daily-Lookups:     2/3      # only on plans with a daily cap; omitted otherwise
X-Nominara-Daily-Resets-At:   2026-08-05T00:00:00Z
X-RateLimit-Limit / -Remaining / -Reset
```

### Response envelope

```json
{
  "data": [ /* the resource or collection */ ],
  "pagination": { "cursor_next": "eyJ0IjoiMjAyNi0wOC0wNCJ9", "has_more": true, "limit": 50 },
  "meta": { "request_id": "4bf92f3577b34da6a3ce929d0e0e4736", "scoring_version": "v1", "computed_at": "2026-08-04T11:02:31Z" }
}
```

Pagination is **cursor-based** — an opaque base64 of the sort-key tuple. Offset pagination is not offered on any time-series endpoint. Hard `limit` cap 200, default 50.

## 2. Error taxonomy

**RFC 9457 Problem Details, extended.** Every error response carries the RFC's top-level members — `type`, `title`, `status`, `detail` — **plus an `error` extension member** carrying `code`, `message`, `details`, `remediation`, and `request_id`. The RFC members give a generic HTTP client something it already knows how to read; the `error` member is what a Nominara client actually renders. Error responses are served as `application/problem+json` (§1); every error carries enough detail for the client to render the correct remediation without a second request.

```json
{
  "type": "about:blank",
  "title": "Insufficient Credits",
  "status": 402,
  "detail": "This action needs 500 Action Credits. Your wallet has 34 available.",
  "error": {
    "code": "insufficient_credits",
    "message": "This action needs 500 Action Credits. Your wallet has 34 available.",
    "details": {
      "required": 500, "available": 34,
      "wallet": { "included_balance": 0, "purchased_balance": 34, "reserved": 0,
                  "cycle_end": "2026-09-01" },
      "packs": [ { "key": "starter_vault", "credits": 1000, "price_usd": "15.00" },
                 { "key": "agency_vault",  "credits": 5000, "price_usd": "50.00" } ]
    },
    "remediation": { "kind": "purchase_credits", "url": "/settings/billing?pack=agency_vault" },
    "request_id": "4bf92f3577b34da6a3ce929d0e0e4736"
  }
}
```

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `validation_failed` | zod failure; `details.issues[]` carries path and message |
| 400 | `unsupported_engine` | `engine_key` not in the workspace's entitlement, or `engines.status='disabled'` |
| 401 | `unauthenticated` | — |
| 401 | `token_expired` | — |
| 401 | `token_revoked` | — |
| 401 | `step_up_required` | Privileged action; `details.methods` lists acceptable re-auth methods |
| **402** | **`insufficient_credits`** | The wallet cannot cover the action. Carries the required/available split and purchasable packs |
| 403 | `forbidden` | `details.required_permission` names the missing permission |
| 403 | `workspace_mismatch` | Tenant or scoped-role violation |
| 403 | `project_out_of_scope` | Tenant or scoped-role violation. A scoped member asking for a project outside its `project_scope` — named by the path, or, on a route that names an entity (a run, a result, a prompt), by that row's own project. Never `404` (STORY-019) |
| **403** | **`entitlement_exceeded`** | A **structural** plan limit is reached — projects, prompts, seats, competitors, share tokens, API keys. `details.{key, limit, current}` plus upgrade/add-on remediation |
| **403** | **`feature_not_in_plan`** | A **feature flag** entitlement is absent — white-label, Search Console, SSO, CSV export, share links, drift sampling. `details.{key, min_plan}` |
| 404 | `not_found` | Resource absent **within the caller's tenant** |
| 409 | `conflict` | `If-Match` mismatch, unique violation, or state-machine violation (`details.current_state`). Accepting an invitation as an existing member carries `details.reason` — `already_member` or `member_suspended` — and consumes nothing. Ownership-transfer refusals carry a closed `details.reason` (`transfer_already_pending`, `transfer_not_pending`, `transfer_expired`, `workspace_pending_deletion`, `recipient_not_admin`, `recipient_email_unverified`, `recipient_no_strong_authenticator`, `past_due_invoice`) — see `/workspaces/{id}/transfer-ownership`. A superseded (reworded) prompt is refused on `POST /projects/{id}/prompts/activate` and every `PATCH /prompts/{id}` with `details.reason = prompt_superseded`; the message names the row that replaced it The in-app plan change (`/billing/subscription/change*`, STORY-184) carries a closed `details.reason`: `quote_changed` (the echoed quote no longer matches Stripe's current preview, or is stale — nothing was charged), `downgrade_exceeds_limits` (seats, competitors or API keys are above the target plan's limits; `details.excess[]` is the exact `must_reduce` list. Projects and prompts never refuse: they are paused at the cut-over, STORY-077), `downgrade_already_effective` (cancelling a scheduled downgrade that has already taken effect), `subscription_past_due` (an unpaid subscription cannot change plan), `cancellation_pending` (`cancel_at_period_end` is set: resume it in the billing portal first), `change_scheduled` (an add-on removal is scheduled on the subscription), `plan_change_pending` (a plan change is already pending: cancel it first), `plan_change_not_pending` (cancelling when nothing is pending, or reading or recording a keep choice when no downgrade is pending) |
| 409 | `idempotency_conflict` | Same key, different body |
| **409** | **`workspace_limit_reached`** | A user may own only one workspace. `details.{owned_workspace_id, owned_workspace_name}` plus the transfer path. **Joining by invitation never hits this** |
| **409** | **`price_changed`** | `X-Nominara-Confirmed-Credits` does not match the server's current price. `details.{shown, recomputed, reason}`; the client re-presents the modal |
| 422 | `domain_not_verified` | Audit requested beyond public-surface scope on an unverified domain |
| 422 | `precondition_unmet` | e.g. a patch whose `content_before_hash` no longer matches. When a manual deep scan is refused, `details.reason` says which precondition failed: `price_not_agreed` (the plan's deep-scan price is negotiated and none has been agreed) or `no_capturable_scope` (the scope plans no cells — no capture-ready engine the project is entitled to, or no active prompts). A deep scan refused either way reserves and charges nothing. `POST /billing/subscription/change` carries `payment_failed` (the card was declined or needs the customer present, e.g. 3-D Secure — Stripe applied nothing and **nothing changed**) or `cancel_in_portal` (the target is Free: a move to Free is a cancellation at period end, done in the billing portal, never blocked by usage). An absent `reason` is an unclassified refusal |
| **422** | **`unsafe_target`** | A well-formed URL the **guarded fetcher** refuses — internal or loopback address, disallowed port, unsupported scheme, or a redirect landing on any of those. The canonical code for all three user-supplied URL surfaces: project root URL, audit target, and beacon origin. `details.reason` names the check that refused it, **never the resolved address** |
| 429 | `rate_limited` | `details.retry_after_ms`; `Retry-After` set |
| 429 | `quota_exceeded` | A non-credit **tier cap** is exhausted |
| **429** | **`daily_limit_reached`** | A daily action cap is hit. `details.{action_code, used, limit, resets_at}`. **Debits nothing, and is not liftable by buying credits** |
| 451 | `capture_mode_unavailable` | An engine adapter is suspended pending a governance review |
| **500** | **`internal_error`** | A server-side failure this table does not model. Carries **no `details` and no `detail` drawn from the exception** — an unexpected error's own message is the string most likely to leak a connection string, a row, or customer data. `error.request_id` is what a support ticket resolves against, and it is the whole payload |
| 502 | `engine_unavailable` | Upstream circuit open; `details.circuit_opened_at` |
| 503 | `degraded` | Dependency failure with partial results available |
| 507 | `retention_exceeded` | The requested window predates the workspace's retention |

`NFR-API-13`: **`402`, `403 entitlement_exceeded`, `403 feature_not_in_plan`, `429 quota_exceeded`, and `429 daily_limit_reached` are five distinct, non-overlapping conditions.** A client can always tell "buy credits" from "upgrade plan" from "wait for the cycle" from "come back tomorrow" from "slow down". Conflating any two is a specification violation, not a cosmetic issue.

**The table is the whole vocabulary, and `500 internal_error` is what closes it.** Before it existed there was no code for "we did not model this", so an unexpected failure could satisfy the first paragraph of this section — every error carries an `error` member — only by inventing a code or by omitting the member. Both were wrong, and the second is what shipped: a `500` body that the schema published from this document rejected. A server-side failure now has a member of this table to carry, so **every** error response conforms, and `internal_error` is reserved for the unmodelled case — a condition that has its own row is never absorbed into it.

## 3. Endpoint registry

`✚` requires `Idempotency-Key` · `↑` requires step-up auth · `∿` streams (SSE) · `¢` debits credits · `⛨` subject to an entitlement limit or feature flag.

### Identity & workspace

| Method | Path | Permission | Notes |
|---|---|---|---|
| `POST` | `/auth/passkey/options` · `/auth/passkey/verify` | public | WebAuthn **assertion (sign-in) only**. `purpose` is `assertion`; a `registration` body is `400 validation_failed` for every address (STORY-173) |
| `POST` | `/auth/oauth/{provider}/start` · `/callback` | public | PKCE. A provider that did **not** verify the address binds nothing: `403 forbidden`, `details.reason = email_not_verified`, message pointing at the email code (STORY-173). A verified address with no account creates one; with an unproved account, claims it as a first proof; with a proved account, `400` (never an auto-link) |
| `POST` | `/auth/oauth/{provider}/link/start` ↑ · `DELETE` `/me/oauth/{provider}` ↑ | session | connecting or disconnecting a provider needs a proved address and a fresh step-up (STORY-173): `401 step_up_required`, or `403 forbidden` / `email_not_verified` |
| `POST` | `/auth/otp/request` · `/auth/otp/verify` | public | rate-limited 3/h/email, uniform response and timing. A request for an unknown address creates it `unverified` and mails a code (STORY-173); a verified code proves the address and stamps the session as strongly authenticated (`email_otp`) |
| `POST` | `/auth/sso/{workspace_slug}/start` · `/callback` | public | **OIDC** in v1. `/acs` (SAML) is enabled per connection only after the security review |
| `GET`/`POST`/`PATCH`/`DELETE` | `/scim/v2/Users` · `/scim/v2/Groups` | SCIM bearer token | RFC 7644; workspace-scoped; **cannot authenticate an interactive session** |
| `POST` | `/auth/token/refresh` · `/auth/logout` | session | rotating refresh with reuse detection |
| `GET`/`PATCH` | `/me` | session | user, memberships, active entitlements; persona, locale, timezone |
| `GET` | `/me/passkeys` | session | the caller's own registered passkeys; **never `public_key`, `credential_id` or `sign_count`**. `PATCH`/`DELETE` `/me/passkeys/{id}` rename and revoke |
| `POST` | `/me/sessions/revoke-others` ↑ | session | signs out every OTHER live session of the account (all workspaces); the calling session survives. `200 {revoked_count}`, idempotent (a repeat answers `0`). Same fresh step-up as passkey revoke. Revoking a passkey (`DELETE /me/passkeys/{id}`) or unlinking a provider (`DELETE /me/oauth/{provider}`) does the same in the credential change's own transaction (STORY-018) |
| `POST` | `/me/passkeys/options` · `/me/passkeys/verify` ↑ | session | **the only way a passkey is added** (STORY-173). Body of `options` is `{display_name?}` — no email, `.strict()`; the account is the session's. `401 step_up_required` without a fresh WebAuthn or OTP (`details.methods`: `webauthn`, `email_otp`); `403 forbidden` while the account's address is unproved. A ceremony is claimed by purpose and owner; `verify` returns `200` with no body and mints no session |
| `POST` | `/workspaces` ✚ | session | creates the tenant, its DEK, the owner membership, and a trial subscription |
| `GET` | `/workspaces` | session | memberships only, one flat cursor-paginated list; each entry carries `relationship: owned\|joined` so a switcher can group them |
| `GET`/`PATCH` | `/workspaces/{id}` | `workspace:read` / `:update` | |
| `POST` | `/workspaces/{id}/switch` | session | verifies membership, mints a new token; **a token is never valid for two tenants** |
| `POST` | `/workspaces/{id}/transfer-ownership` ✚ ↑ | `workspace:transfer_ownership` | **initiate** (STORY-021): body `{recipient_id}`, `.strict()`; owner only with a step-up ≤ 5 min. `200` with the transfer (`state: awaiting_acceptance`, `expires_at` = +7 days); nothing is mutated until acceptance. Refusals: `409 conflict` with `details.reason` ∈ `transfer_already_pending` · `workspace_pending_deletion` · `recipient_not_admin` (a stranger is answered identically) · `recipient_email_unverified` · `recipient_no_strong_authenticator` (an active, un-revoked passkey — an email code alone does not count) · `past_due_invoice` (any unpaid invoice past its due date); `409 workspace_limit_reached` when the recipient already owns a workspace; `403` naming the permission; `401 step_up_required` |
| `POST` | `/workspaces/{id}/transfer-ownership/accept` ↑ | `workspace:read` + the named recipient | **the execution**: the recipient only, step-up ≤ 5 min; every pre-flight check is run again. One transaction under the workspace row lock: owner→admin, recipient→owner, **all** API keys and every passwordless share token revoked, pending owner- and admin-role invitations revoked, both users' sessions revoked, `entitlement_version` + 1, a `critical` audit row. After commit: the Stripe customer's billing email is re-pointed by the `billing.customer_email` job. A non-recipient is `403 forbidden` whether or not a transfer exists; an expired offer is `409` `transfer_expired` (the lapse is recorded) |
| `POST` | `/workspaces/{id}/transfer-ownership/decline` · `/cancel` | recipient · `workspace:transfer_ownership` | decline: the named recipient (no step-up); cancel: the initiating owner. Either leaves `declined` / `cancelled` on the record, mutates nothing, and a new transfer may follow. `409 transfer_not_pending` when there is nothing live |
| `DELETE` | `/workspaces/{id}` ↑ | `workspace:delete` | 30-day grace |
| `GET`/`POST` | `/workspaces/{id}/members` · `/invitations` | `member:*` | |
| `PATCH`/`DELETE` | `/members/{id}` | `member:update_role` / `:remove` | |
| `GET`/`PUT` | `/workspaces/{id}/sso` ↑ | `sso:configure` | |
| `GET`/`POST`/`DELETE` | `/api-keys` ↑ | `apikey:create` | secret returned once |
| `GET` | `/audit-log` | `audit_log:read` | cursor, filterable by action, actor, date |
| `GET` | `/trust/access-grants` | `workspace:read` | live support-grant transparency panel |

### Billing, entitlements & credits

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/billing/entitlements` | `workspace:read` | **Resolved** effective entitlements (plan + add-ons + overrides) with `entitlement_version`. The client renders every limit and gate from this one payload |
| `GET` | `/billing/subscription` · `/invoices` · `/usage` | `billing:read` | |
| `GET` | `/billing/wallet` | `workspace:read` | both buckets, reserved, expiring-soon, cycle window, auto-top-up config |
| `GET` | `/billing/wallet/ledger` | `billing:read` | cursor over `credit_ledger`; filter by action, project, actor, date; CSV export |
| `GET` | `/billing/credit-packs` | `workspace:read` | catalog filtered to the plan's `min_plan_key` |
| `POST` | `/billing/credit-packs/{key}/purchase` ✚ | `billing:write` | Stripe PaymentIntent; credits land on `succeeded` |
| `PUT` | `/billing/wallet/auto-topup` | `billing:write` | `{enabled, pack_key, threshold, max_per_cycle}`; the cap is enforced in the schema |
| `GET`/`POST`/`DELETE` | `/billing/addons` ✚ | `billing:write` | `extra_project`, `extra_seat`; pro-rated by Stripe |
| `POST` | `/billing/checkout-session` ✚ · `/billing/portal-session` | `billing:write` | |
| `POST` | `/billing/subscription/change/preview` | `billing:write` | **In-app plan change, step 1 (STORY-184).** Body `{plan_key}` — the target is always on the subscription's **own** billing interval (an interval switch is not offered). Returns the direction, `effective` (`immediate` for an upgrade, `period_end` for a downgrade), Stripe's `amount_due_now` (from `invoices.createPreview`, **never computed by us**), a `quote` `{proration_date, amount_due_now, currency}` to echo back, a labelled credit estimate, `purchased_credits_kept: true`, and for a downgrade the `exceeds[]` list (projects in the order the cut-over pauses them — least recently active first, STORY-077 D2 — prompts, seats, competitors, API keys, features lost, add-ons dropped, retention shortened) with `blocked_by` (`exceeds_limits` \| `cancel_in_portal` \| null). Each structural entry carries `effect` (STORY-077): `paused_at_period_end` for `projects.max`, `prompts.max_total` and `prompts.max_per_project`, `must_reduce` for seats, competitors and API keys; `blocked_by` is `exceeds_limits` only for a `must_reduce` entry. A `paused_at_period_end` entry carries `paused` (exactly how many rows the cut-over pauses for it) and each named project carries `prompts` (its active prompts that pause with it); both are optional, and `items` is capped at 100. Makes a Stripe call and charges nothing; rate class `plan_change_preview` (§12) |
| `POST` | `/billing/subscription/change` ✚ | `billing:write` | **Step 2.** Body `{plan_key, quote?}`; the quote is **required for an upgrade**. `202` with `status: pending` — the plan changes only when the signature-verified webhook reconciles the subscription. An **upgrade is charged now** (`always_invoice`, `error_if_incomplete`): a decline or 3-D Secure is `422 precondition_unmet` `payment_failed` and nothing changes; a quote that no longer matches a re-preview with the same `proration_date` is `409 quote_changed`. A **downgrade** is a subscription schedule that takes effect at `current_period_end`, and is refused `409 downgrade_exceeds_limits` only while a `must_reduce` key (seats, competitors, API keys) exceeds the target's limits; excess projects and prompts are paused at the cut-over (STORY-077, [`plans-and-entitlements.md` §14](./plans-and-entitlements.md#14-downgrade-and-over-limit-policy)). Target Free is `422 cancel_in_portal`; enterprise is `400 validation_failed`. Rate class `plan_change` (§12) |
| `DELETE` | `/billing/subscription/change` | `billing:write` | Cancels a **scheduled downgrade**, and with it the keep choice made for it. `409 downgrade_already_effective` if it has already taken effect; `409 plan_change_not_pending` if nothing is pending. "Effective" is read from the subscription (it carries the intent), never from the schedule's status. Rate class `plan_change` |
| `GET` | `/billing/subscription/change/keep` | `billing:read` | **What to keep at a pending downgrade's cut-over (STORY-077 D2, owner approved 2026-10-20).** `{target_plan_key, effective_at, limits: {projects, projects_keepable, prompts_total, prompts_per_project}, projects[], default, choice}`: `limits` are the target plan's resolved limits (the plan, the add-ons it still allows, the overrides; null is unlimited); `projects_keepable` equals `projects` (owner decision 2026-10-23: `projects.max` counts tracking projects only — active or initializing — so an archived or paused project uses no slot and is never paused or resumed by billing); `projects[]` is everything that can be kept — projects tracking now or paused by an earlier downgrade, each with `last_active_at` and its keepable `prompts[]` (active, or paused by an earlier downgrade), most recently active first; `default` `{project_ids, prompt_ids}` is what the cut-over keeps with no choice — the **most recently active** (a project's latest finished capture run, a prompt's latest answer capture; none ranks last; equal activity keeps the older row); `choice` is the recorded choice `{project_ids, prompt_ids, chosen_at}` or null. `409 plan_change_not_pending` unless a downgrade is pending |
| `PUT` | `/billing/subscription/change/keep` | `billing:write` | Records the keep choice for the pending downgrade (stored in `subscriptions.downgrade_keep`, bound to that downgrade). Body `{project_ids, prompt_ids}`. At the cut-over the chosen projects and prompts are kept first and everything else is paused (never deleted), except that room the choice leaves under the limits is filled with the most recently active of the rest. Validated against the target's limits — at most `limits.projects_keepable` (= `limits.projects`) projects, `limits.prompts_per_project` prompts in one project, `limits.prompts_total` in all, every prompt in a chosen project, every id keepable — else `400 validation_failed` naming the field. Answers the same body as the `GET`. Cleared when the downgrade is cancelled or takes effect. `409 plan_change_not_pending` unless a downgrade is pending; rate class `writes` |
| `POST` | `/webhooks/stripe` | signature-verified public route | idempotent by event ID; **state reconciled from a fresh fetch, never applied as a delta** |

### Projects & configuration

| Method | Path | Permission | Notes |
|---|---|---|---|
| `POST` | `/projects` ✚ ⛨ | `project:create` | **URL is the only required field**; every other field is optional. Triggers discovery and the free prompt allowance. See [§4](#4-project-creation). Every creation takes the workspace lock and re-counts `projects.max` under it (tracking projects only, STORY-077): `403 entitlement_exceeded` when there is no room, `503 degraded` (retryable) on a workspace-lock wait past `WORKSPACE_LOCK_WAIT_MS` |
| `GET` | `/projects/{id}/discovery` | `project:read` | discovery status and every discovered field with its confidence |
| `POST` | `/projects/{id}/discovery/confirm` | `project:update` | accept or override discovered fields and proposed competitors |
| `GET` | `/projects` | `project:read` | workspace matrix; includes `visibility_blended`, `sparkline_30d`, `open_task_count`, and `paused_by_downgrade_at` (STORY-077: ISO timestamp, non-null only on a project a downgrade cut-over paused; cleared when it resumes, by upgrade or by a person) |
| `GET`/`PATCH`/`DELETE` | `/projects/{id}` | `project:read` / `:update` | `PATCH` requires `If-Match`. **Leaving `archived` or `paused`** (an un-archive, a person's resume, or resuming a downgrade-paused project) is a move into a `projects.max` slot (STORY-077, owner 2026-10-23): it needs room or is refused `403 entitlement_exceeded` under the workspace lock, re-seeds `next_run_at` from the cadence (null for `manual`), and writes a `project.reactivated` audit row. *As built, `PATCH` is not served yet; the rule lives in `reactivateProject`, which that route must call* |
| `PUT` | `/projects/{id}/engines` | `project:update` | enable/disable, weights, sample counts |
| `GET`/`POST`/`PATCH`/`DELETE` | `/projects/{id}/competitors` ⛨ | `project:update` | `competitors.max_per_project` |
| `POST` | `/projects/{id}/domain-verification` · `/check` | `project:update` | returns the nonce and instructions |

### Prompts

| Method | Path | Permission | Notes |
|---|---|---|---|
| `POST` | `/projects/{id}/prompts/generate` ✚ | `prompt:write` | §5. **Generation is free**; activation is what consumes the cap and the credits |
| `POST` | `/projects/{id}/prompts/activate/preview` | `prompt:write` | **free, read-only** — same body as `activate`; no project lock, no reservation, no ledger row, no write (audited as `prompt.activation_previewed`). `200 { credits, prompts: { requested, already_active, free, charged }, credits_charged: 0 }`; `credits` is the figure to echo. A `PATCH` activation is previewed with `prompt_ids: [id]` |
| `POST` | `/projects/{id}/prompts/activate` ✚ ⛨ **¢** | `prompt:write` | activate a chosen subset; `403 entitlement_exceeded` names the remaining slots (held to the active count per project and workspace-wide, a resume of a downgrade-paused prompt included: STORY-077). **Charges once per generated prompt, at its first activation beyond the free `prompts.free_at_creation`** (STORY-046). `credits_charged` is the whole credits debited (0 when free). Requires `X-Nominara-Confirmed-Credits` when the charge is above 0; `402 insufficient_credits` is a documented refusal; a superseded prompt is `409 conflict` (`prompt_superseded`) |
| `POST` | `/projects/{id}/prompts` ✚ ⛨ | `prompt:write` | manual creation — **0 credits**; the response carries `paused_by_downgrade_at`. The new prompt is `active`, so it must fit the active cap: `403 entitlement_exceeded` (`prompts.max_per_project` \| `prompts.max_total`) otherwise (STORY-077) |
| `GET` | `/projects/{id}/prompts` | `tracking:read` | filter by engine, topic cluster, archetype, funnel, presence, sentiment, status. Each prompt carries `paused_by_downgrade_at` (STORY-077: non-null only on a prompt a downgrade cut-over paused) |
| `PATCH` | `/prompts/{id}` **¢** | `prompt:write` | pause/resume, priority flag, edit text (re-hashes and starts a new series). **Leaving `archived` is an activation** and follows the same charge and quote rule as `activate`: `credits_charged`, `402 insufficient_credits`, the header above 0. An edit's new row inherits whether the prompt was already charged. A superseded row is `409 conflict` (`prompt_superseded`). A move into `active` (a resume) must fit the active cap per project and workspace-wide: `403 entitlement_exceeded` (`prompts.max_per_project` \| `prompts.max_total`) otherwise (STORY-077) |
| `GET` | `/prompts/{id}/stability` | `tracking:read` | drift telemetry |

**The activation price is quoted, then echoed (STORY-046, owner decision 2026-10-15).** `X-Nominara-Confirmed-Credits` is REQUIRED on `POST /projects/{id}/prompts/activate`, and on a `PATCH /prompts/{id}` that leaves `archived`, whenever the recomputed charge is above 0: missing is `400 validation_failed` naming the header (as on the deep-scan route), and a value that is not a non-negative integer is `400`. The server recomputes the charge UNDER THE PROJECT LOCK and compares; a mismatch is `409 price_changed` with `details.{shown, recomputed, reason}`. A fully free activation (charge 0), a replay with nothing new to activate, and a `PATCH` that does not leave `archived` need no header, and a header sent with them is not checked. These two routes are not `@Credits(...)`-guarded, because their price is known only inside the handler; the missing, mismatch and refusal semantics are `CreditGuard`'s. The debit is a `reserve` and a `commit` in the request's own transaction, so a refused activation (`403` at the cap, `402`) leaves no ledger row.

### Tracking

| Method | Path | Permission | Notes |
|---|---|---|---|
| `POST` | `/projects/{id}/runs/estimate` | `tracking:trigger` | **free.** Returns the exact credit price and the cache forecast. This is what the confirmation modal renders |
| `POST` | `/projects/{id}/runs` ✚ **¢** | `tracking:trigger` | **Manual deep scan — one flat price.** Runs the full tracked set on every enabled engine plus the AUX audit, and refreshes every rollup exactly as a scheduled run does. **The body takes no scope or engine selection.** Requires `X-Nominara-Confirmed-Credits` |
| `GET` | `/runs/{id}` | `tracking:read` | progress projection and, on a manual run, the charge with the live/cached split |
| `POST` | `/runs/{id}/cancel` | `tracking:trigger` | drains queued cells |
| `GET` | `/projects/{id}/results` | `tracking:read` | cursor over `answer_captures` |
| `GET` | `/results/{id}` | `tracking:read` | §6 — the full parser document |
| `GET` | `/results/{id}/raw` | `tracking:read` | 302 to a 60-second pre-signed URL |
| `GET` | `/projects/{id}/matrix` | `tracking:read` | prompt × engine grid |

### Analytics

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/projects/{id}/scorecards` | `tracking:read` | per-engine and blended score, presence, share of voice, sentiment, citations, rendering, with deltas and confidence |
| `GET` | `/projects/{id}/growth-map` | `tracking:read` | §7 — series, milestone pins, data gaps |
| `GET` | `/projects/{id}/competitors/panel` | `tracking:read` | per-engine comparison, head-to-head win rate, detection variance |
| `GET` | `/projects/{id}/displacements` | `tracking:read` | Displacement feed (**D1**) |
| `GET` | `/projects/{id}/rendering-quality` | `tracking:read` | per-engine breakdown and attribute coverage (**D4**) |
| `GET` | `/projects/{id}/sources` | `aux:read` | Source Citation Index with gap severity |
| `GET` | `/projects/{id}/topics` · `PATCH /topics/{id}` | `tracking:read` / `prompt:write` | clusters with per-topic visibility, ownership, gap priority; rename |
| `GET` | `/projects/{id}/geo-insights` · `/{analysis}` | `tracking:read` | the digest with the Top Three Levers, and each analysis in full. **0 credits, unmetered** |
| `POST` | `/geo/alignment` ✚ | `optimizer:use` | open an alignment analysis for one URL. **0 credits, unlimited** |
| `GET` | `/geo/alignment/{id}` | `optimizer:use` | §8 |
| `PATCH` | `/geo/alignment/{id}` | `optimizer:use` | `{draft_content_md}` → debounced **in-database** recompute ≤ 200 ms p95 |
| `POST` | `/geo/alignment/{id}/patch` ✚ | `optimizer:use` | immutable copy-ready patch with a precondition hash |
| `GET`/`POST` | `/projects/{id}/milestones` | `tracking:read` / `task:create` | manual annotations permitted |
| `GET`/`POST`/`PATCH` | `/projects/{id}/goals` | `task:create` | **STORY-065.** `POST` body `{title, kind, target: {metric, target_value, engine_key?, prompt_cluster_id?}, target_date?}`; six kinds are creatable, each with **one** metric: `engine_score` and `topic_authority` → `visibility_score`, `citation_presence` → `citation_share`, `rendering_quality` → `rendering_quality`, `sentiment_recovery` → `sentiment_score`, `prompt_recommendation` → `presence_rate`. `custom` is still `400` (no measured source). Every `target_value` is on a 0–100 scale (shares and rates as percentages). `prompt_cluster_id` is required for `topic_authority` and `prompt_recommendation` and refused for the rest; `engine_key` is allowed for every kind except `topic_authority`. `400 validation_failed` naming the field when the metric is not the kind's, the cluster is not this project's, the engine is unknown, or **`target_value` is at or below a baseline measured on a sufficient sample (n ≥ 30)** (owner 2026-10-23). The baseline is captured by the server; the request cannot carry `direction`, which the server sets from the metric and returns in `target.direction` (`up` for every metric today). The rollup refreshes `current` and sets `achieved`/`achieved_at` (inclusive, sufficient sample only, one system-actor `goal.achieved` audit row); `progress_pct` is null while the sample is insufficient or the baseline rested on fewer than 30 cells, until achieved. `PATCH` abandons (no reason) |
| `GET` | `/workspaces/{id}/summary` · `/action-items` | `project:read` / `task:read` | Command Center matrix (each project carries `paused_by_downgrade_at`, STORY-077); cross-project queue, impact first, read from `ix_tasks_open`. **The queue collapses tasks across projects on the displayed rule code and `affected_url`** (STORY-064): each row is the group's highest-impact task and carries `project_count` (distinct readable projects, counted after the scope predicate) and `projects[]` `{id, name, slug}`; a task with no code or no URL never collapses |
| `POST` | `/exports` ✚ ⛨ | `export:data` | async CSV/PDF → `report_artifact_id`. **0 credits**; PDF is tier-capped, CSV is entitlement-gated |

### AUX

| Method | Path | Permission | Notes |
|---|---|---|---|
| `POST` | `/projects/{id}/aux-audits` ✚ **¢** | `aux:trigger` | `{scope, target_urls}`. Scheduled, onboarding, and post-fix audits are **0** |
| `GET` | `/aux-audits/{id}` | `aux:read` | score and category breakdown |
| `GET` | `/projects/{id}/aux-findings` | `aux:read` | filter by severity, status, rule, URL |
| `PATCH` | `/aux-findings/{id}` | `task:create` | acknowledge / `wont_fix` (reason required). **`resolved` is never settable by a client** |
| `POST` | `/aux-findings/{id}/create-task` ✚ | `task:create` | manual promotion |

### Tasks

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET`/`POST` | `/projects/{id}/tasks` ✚ | `task:read` / `task:create` | list grouped by status, ordered by `impact_score`; `sort` is `impact` (default), `priority`, `age` or `goal`. `sort=goal` groups goal-linked tasks by goal and, inside a goal, puts the tasks whose rule feeds the goal's metric and scope first, by impact (contribution, STORY-065) |
| `PATCH` | `/tasks/{id}` | `task:move` | status, assignee, priority, due date, `goal_id`. **There is no ordering field**. A dismissal needs a reason and sets `resurface_at` 180 days out; the daily `task.resurface` sweep reopens a dismissed or snoozed task once that date passes, with a system `reopened` event (STORY-064) |
| `POST` | `/workspaces/{id}/tasks/bulk` | `task:move` (scoped) | **Bulk assign, status change and snooze (STORY-064).** Body `{action: "assign", task_ids, assignee_id \| null}`, `{action: "status", task_ids, status: "todo" \| "in_progress"}` or `{action: "snooze", task_ids, reason, snooze_until}`; 1 to 100 unique ids. A snooze is a dismissal with the caller's re-surface date: the reason and the date are both required, the date must be in the future (no upper bound). `200 {updated, tasks}` (`updated` counts tasks whose state changed; `tasks` is every requested task after the batch, in request order). **All-or-nothing:** `404` if any id is absent, another tenant's or deleted; `403` naming the scope if any is outside a scoped caller's projects; `409` if a `done` task is in a status or snooze batch; `400` for a missing reason or date or a date not in the future. Each task is patched by the same code as `PATCH /tasks/{id}`, so a batch writes the events a single patch would. `Idempotency-Key`; audited as `task.bulk_updated` on the workspace; rate class `writes` |
| `POST` | `/tasks/{id}/comments` | `task:comment` | |
| `GET` | `/tasks/{id}/events` | `task:read` | timeline |
| `POST` | `/tasks/{id}/complete` ✚ | `task:move` | emits a milestone and schedules +48 h / +14 d verification |

### Notifications

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/workspaces/{id}/notifications` | `workspace:read` | **The caller's inbox (STORY-068).** Cursor-paged, newest first; `unread=true` lists only what the caller has not read. Body `{notifications, unread_count}`: `unread_count` is the caller's over the whole inbox (the bell badge). Each item: `id, project_id, kind, severity (info\|warning\|critical), title, body, audience (workspace\|user), deep_link {path, query} \| null, task_id, read, read_at, created_at`. **Read state is per user**: `read`/`read_at` are the caller's, so one member reading never clears it for the team. A member sees workspace-wide rows, rows addressed to them, and only the projects their role may read (a scoped manager or viewer: their `project_scope`). `deep_link` names the surface that diagnoses an alert with its filters (`/p/{project_id}/prompts?engines=gemini&tf=7d`). Never for an API key (`403`) |
| `POST` | `/workspaces/{id}/notifications/{notification_id}/read` | `workspace:read` | marks one notification read **for the caller**; idempotent (the first read time is kept). `200 {id, read_at, unread_count}`; `404` for a notification the caller cannot see (another user's, another project's, another tenant's). Audited as `notification.read` |
| `POST` | `/workspaces/{id}/notifications/read-all` | `workspace:read` | marks everything the caller can see read, for the caller only. `200 {marked, unread_count}`. Audited as `notification.read_all` on the workspace |
| `GET`/`PATCH` | `/workspaces/{id}/notification-preferences` | `workspace:read` | **the caller's own email digest cadence** (owner decision 2026-10-23). `{digest_cadence: off\|daily\|weekly, is_default}`; `PATCH {digest_cadence}` (`null` restores the role default). Default **weekly** for owner, admin and manager, **off** for analyst and viewer. `off` also stops the immediate email for critical alerts. Audited as `notification_preferences.updated` |

Alerts are the §15 catalog of `scoring-models.md`, raised after each rollup by `task.generate` (kind `alert.<rule>`); usage warnings at 80% and 95% are `usage.quota_threshold`, credit warnings at 25% and 10% of the cycle's grant are `credits.threshold`; each fires once per threshold per cycle. **Severity is the channel:** `critical` is emailed at once, `warning` and `info` wait for the member's digest, which coalesces the period into one email and is **not sent when empty**. Email goes out through `notify.dispatch` (one outbox, idempotent by event key).

### Tools

One resource family for all six tools. `tool_key` selects behaviour; lifecycle, history, and the conversion contract are shared.

| Method | Path | Permission | Notes |
|---|---|---|---|
| `POST` | `/tools/visibility-scan` ✚ ∿ **¢** | `lookup:execute` | §9. Flat price. Plan-determined engine set; **no picker** |
| `POST` | `/tools/prompt-research/discover` ✚ | `prompt:write` | generation free; charged per prompt kept on `…/keep` |
| `POST` | `/tools/prompt-research/run` ✚ ∿ **¢** | `lookup:execute` | per prompt per engine; ≤ 10 prompts |
| `POST` | `/tools/competitor-finder` ✚ **¢** | `lookup:execute` | one capture; every result evidenced |
| `POST` | `/tools/aux-audit` ✚ **¢** | `aux:trigger` | `{mode:'site_files'}` → **0 credits**; `{mode:'full'}` → priced per page band |
| `POST` | `/tools/schema-builder` | `lookup:execute` | **0 credits.** Deterministic; no network on the paste path |
| `POST` | `/tools/compare-runs` | `lookup:read_history` | **0 credits.** Two stored snapshots; **no capture path exists** |
| `GET` | `/tools/runs` · `/tools/runs/{id}` | `lookup:read_history` | shared timeline; `?tool_key=`, `?brand=`, `?pinned=`. Reading is **0 credits, always** |
| `PATCH` | `/tools/runs/{id}` | `lookup:read_history` | `{pinned}` |
| `POST` | `/tools/runs/{id}/convert` ✚ ⛨ | `project:create` | creates the project, first prompts, and discovery |

### Command bar

| Method | Path | Notes |
|---|---|---|
| `POST` | `/command/parse` **¢** | §10. **0 credits** when the local grammar resolves it or on a cache hit; 1 credit for a server-side model parse |
| `POST` | `/command/execute` ✚ | executes a parsed action; requires `parse_id`, `action_id`, and `X-Nominara-Confirmed-Credits` when it spends credits |

### Agency, sharing & portal

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET`/`PUT` | `/agency/theme` ⛨ | `agency:branding` | contrast validated server-side on save |
| `POST` | `/agency/theme/assets` ⛨ | `agency:branding` | pre-signed upload, ≤ 2 MB, PNG/SVG/WebP, SVG sanitised |
| `GET`/`POST`/`DELETE` | `/agency/domains` ↑ ⛨ | `agency:custom_domain` | returns CNAME and TXT records |
| `POST` | `/agency/domains/{id}/verify` | `agency:custom_domain` | requires **both** records |
| `GET`/`POST` | `/share-tokens` ✚ ⛨ | `share_token:mint` | secret returned once |
| `PATCH`/`DELETE` | `/share-tokens/{id}` | `share_token:revoke` | revocation is immediate |
| `GET` | `/share-tokens/{id}/views` | `share_token:mint` | access telemetry |
| `GET`/`POST`/`PATCH`/`DELETE` | `/scheduled-reports` · `POST /{id}/send-now` ✚ | `agency:branding` | send-now answers `200` with the delivery in `status: "sending"`; the emails go out after commit — see [Scheduled-report delivery](#scheduled-report-delivery) |
| `POST` | `/portal/session` | token secret + password | → a short-lived scoped cookie (4 h) |
| `GET` | `/portal/overview` · `/growth-map` · `/sources` · `/tasks` · `/matrix` · `/report.pdf` | portal cookie | the origin sets `app.current_scope_projects` from the cookie |

#### Scheduled-report delivery

As built (Group C, owner decision 2026-10-15, option B). `POST /scheduled-reports/{id}/send-now` reserves the PDF cap unit, builds the artifacts, commits the unit, records the delivery as `sending` and answers **`200` with that delivery, `status: "sending"`**. The emails are sent **after the request transaction commits** (`afterCommit`); a second, short tenant transaction then moves the row to its final state with `UPDATE … WHERE status = 'sending'`, so a replayed finalisation is a no-op and the first outcome wins. No row lock, transaction or pooled connection is held while the provider is slow. The client polls `GET /scheduled-reports`, whose `deliveries` carry the final state.

Answering after the sends was rejected: the response cannot outlive the interceptor-owned transaction without either holding an idle transaction and connection across the send, or taking a second pooled connection while the request still holds one (hold-and-wait).

| `status` | Meaning |
|---|---|
| `sending` | Recorded; the emails are not finished yet |
| `delivered` | A sender that really delivers (Resend) accepted every recipient |
| `logged` | A sender that delivers to nobody (the logging adapter) accepted every recipient. Never reported as `delivered` |
| `failed` | The build failed, or at least one recipient could not be sent: `reason` is "N of M recipients could not be sent", `recipients` counts those that succeeded, and `scheduled_reports.last_error` is set. Also "server shutting down before send" when shutdown began before the delivery's turn (nothing was sent, so a resend is correct) |
| `skipped_cap` | The PDF cap was reached; a notification names the cap and the reset date |

- **Stale `sending`.** A process that dies between the commit and the second transaction leaves the row `sending`. Reads show a `sending` row older than `STALE_SENDING_MS` as `failed`, reason "delivery did not complete: the sending process did not report back"; **the row itself is not rewritten**. The window is derived, not chosen: `SCHEDULED_REPORT_MAX_RECIPIENTS` (25) × the Resend worst-case send (3 × 10 s timeout + 2 × 30 s `Retry-After` cap = 90 s) + 5 min margin = **42.5 min**, pinned by a unit test. It is judged on the **database clock** (`now() - attempted_at > STALE_SENDING_MS` in the history query; `now()` is the start of the reading transaction, which can only make a row look younger). Recipients go one at a time. **Follow-up, not built:** a sweep that rewrites stale `sending` rows and sets `last_error` ([STORY-183](../stories/agency/STORY-183-stale-sending-delivery-sweep.md)).
- **Shutdown.** The service waits up to 30 s for in-flight deliveries before the database pool closes. A delivery whose turn comes after shutdown began sends nothing and is recorded `failed` (best effort; if that fails too, it reads stale after the window). Recording an outcome waits at most 10 s for a pooled connection.
- **Recipients** are the ones captured at request time. A report deleted mid-send takes its delivery with it (cascade), and the finalisation updates nothing.
- **Counted once.** `nominara_reports_scheduled_deliveries_total` counts each delivery at its final status, never at `sending`.
- **Contract.** `deliveryStatusSchema` gained `sending`; `contracts:diff` classifies the change as **patch** (a response-side enum widening). The frontend's delivery-status union must gain `sending`.
- **Content as built.** Plain text, one link per built artifact, no attachment. The agency display name and reply-to, the attachment up to 8 MB and the oversize signed link are not built ([`integrations-and-sharing.md` §5](./integrations-and-sharing.md#5-scheduled-reports)).

### Integrations (post-launch)

| Method | Path | Permission | Notes |
|---|---|---|---|
| `POST` | `/integrations/gsc/oauth/start` · `/callback` ⛨ ↑ | `workspace:update` | **read-only scope only.** Nominara never requests a write scope |
| `GET`/`DELETE` | `/integrations/gsc/{id}` | `project:read` / `workspace:update` | health, property, last sync date |
| `POST` | `/integrations/gsc/{id}/sync` | `workspace:update` | manual incremental pull. **0 credits** |
| `GET` | `/projects/{id}/gsc/correlation` ⛨ | `tracking:read` | citation data joined to AI-surface impressions by canonical URL |
| `GET`/`POST`/`DELETE` | `/projects/{id}/attribution/config` ⛨ ↑ | `workspace:update` | returns the embeddable snippet and a live receiving-data state |
| `GET` | `/projects/{id}/attribution` ⛨ | `tracking:read` | per-URL citations × AI sessions × conversions, with the pattern classification |
| `POST` | `/ingest/attribution` | site-token auth, **public route** | Aggregated beacon. Origin-checked; **no per-visitor row, cookie, or full IP is stored** |

### Public

| Method | Path | Controls |
|---|---|---|
| `GET` | `/public/niche-reports` · `/{slug}` | CDN-cached, `s-maxage=86400`, database-free. **Read-only** |

**One public route, and it is a read.** There is **no unauthenticated write path anywhere in the API**, and no public route accepts visitor input for processing or fetches a visitor-nominated host. `nominara-web` renders report pages from a build-time snapshot and does not call this endpoint at request time.

## 4. Project creation

`POST /v1/projects` · `Idempotency-Key` required · returns `202 Accepted`

**`root_url` is the only required field.** Everything else is optional. **A supplied field is used as given and discovery skips it**; an omitted field is discovered from the site, returned with a confidence, and never silently applied.

### 4.1 Request fields

**Required.**

| Field | Type | Notes |
|---|---|---|
| `root_url` | `string` (URL) | The site root this project crawls, audits, and derives ownership from. Validated by the guarded fetcher and normalised to its registrable domain, which becomes `root_domain` |

**Optional — identity and matching.** Supply what the caller already knows; omit the rest.

| Field | Type | If omitted |
|---|---|---|
| `name` | `string` | Set from the discovered brand name |
| `description` | `string` | Discovered from metadata and hero copy |
| `brand_aliases` | `string[]` | Discovered from domain and title variants |
| `negative_aliases` | `string[]` | Proposed automatically when the brand name matches a common-word dictionary. **Strings that must never count as a mention** |
| `owned_domains` | `string[]` | Empty. Additional first-party domains beyond `root_domain`; **drives owned-citation share, subdomains included** |
| `locale` | `string` | Discovered, defaulting to the launch locale |

**Optional — classification.**

| Field | Type | If omitted |
|---|---|---|
| `category_slug` | `string` | Classified from site text. The benchmark join key |
| `verticals` | `string[]` | Proposed by discovery, pre-checked and editable |

**Optional — seeding.** Both consume plan capacity and cost nothing.

| Field | Type | If omitted |
|---|---|---|
| `competitors` | `[{ name, root_domain?, aliases? }]` | Proposed by discovery, each with a basis, for review. Supplied entries are stored as user-authored and count against the competitor cap |
| `prompts` | `[{ text }]` | The free allowance is generated instead. Supplied prompts are stored as manual, **charge nothing**, and count against `prompts_cap` |

**Optional — hierarchy.** Set at creation only.

| Field | Type | If omitted |
|---|---|---|
| `kind` | `"brand"` \| `"product_line"` | `"brand"` |
| `parent_project_id` | `uuid` | `null`. Required when `kind` is `"product_line"` |

**Not accepted here, by design.**

| Field | Where it comes from |
|---|---|
| Topics or tags | **Derived.** Prompts are clustered automatically; there is no manual topic taxonomy anywhere in the product |
| Engines | Resolved from the plan. There is no engine picker |
| Cadence | Resolved from the plan; changed later in project settings |
| `root_domain` | Derived from `root_url`; a supplied value is rejected rather than trusted |

### 4.2 Minimum request

```http
POST /v1/projects
Idempotency-Key: proj-create-01JA3…
Content-Type: application/json

{ "root_url": "https://hubspot.com" }
```

### 4.3 Request using every optional field

Nothing here is required. This is the maximum, shown so the shape of each field is unambiguous.

```http
POST /v1/projects
Idempotency-Key: proj-create-01JA4…
Content-Type: application/json

{
  "root_url": "https://hubspot.com",

  "name": "HubSpot CRM",
  "description": "Customer platform with CRM, marketing, and service hubs.",
  "brand_aliases": ["HubSpot", "HS CRM"],
  "negative_aliases": ["hub spot welding"],
  "owned_domains": ["hubspot.de", "blog.hubspot.com"],
  "locale": "en-US",

  "category_slug": "crm",
  "verticals": ["b2b_saas", "sales_enablement"],

  "competitors": [
    { "name": "Salesforce", "root_domain": "salesforce.com", "aliases": ["SFDC"] },
    { "name": "Pipedrive",  "root_domain": "pipedrive.com" }
  ],
  "prompts": [
    { "text": "most reliable CRM for a 50-rep sales team" },
    { "text": "best CRM for a 10-person startup" }
  ],

  "kind": "brand"
}
```

### 4.4 Response

**`202 Accepted` — the project exists and is readable immediately.** Discovery runs behind it; poll the pointer.

```json
{ "data": {
    "project_id": "9f1c8d21-…", "root_url": "https://hubspot.com", "root_domain": "hubspot.com",
    "status": "initializing", "discovery_status": "running", "prompts_cap": 50,
    "fields_supplied": ["name", "category_slug", "competitors", "prompts"],
    "poll": { "discovery": "/v1/projects/9f1c8d21-…/discovery", "expected_ms": 20000 } } }
```

`fields_supplied` echoes what the caller provided, so a client can render "discovering" only for the fields that are actually being discovered.

**Failure cases.** A malformed URL, an unknown field, or a supplied `root_domain` returns `400 validation_failed` with the offending path in `details.issues[]`. A well-formed URL that the guarded fetcher rejects — an internal address, a loopback host, an unsupported scheme — returns `422 unsafe_target`. Exceeding the project entitlement returns `403 entitlement_exceeded` naming the limit and the current count, and supplying more prompts or competitors than the plan permits returns the same error naming which cap was exceeded (supplied prompts are inserted `active`, so they are counted, after the hash dedupe, against `prompts.max_per_project` and the workspace-wide active `prompts.max_total`, read after the workspace lock from the committed entitlement version: STORY-077) — **in every failure case the project is not created**.

### 4.5 Discovery result

**`GET /v1/projects/{id}/discovery` — polled after creation.** Every discovered field carries a value, a confidence, a source, and an edited flag. Fields the caller supplied are absent from `fields`, because nothing was discovered for them.

```json
{ "data": {
    "discovery_status": "completed", "duration_ms": 17420,
    "fields": {
      "brand_name":  { "value": "HubSpot CRM", "confidence": 0.96, "source": "Organization schema", "user_edited": false },
      "description": { "value": "Customer platform with CRM, marketing, and service hubs…", "confidence": 0.88, "source": "meta+hero" },
      "category":    { "value": "crm", "confidence": 0.93, "source": "text classification" },
      "products":    { "value": ["Sales Hub","Marketing Hub"], "confidence": 0.81, "source": "Product schema + nav" },
      "aliases":     { "value": ["HubSpot","Hubspot CRM","HS CRM"], "confidence": 0.90, "source": "domain + title variants" },
      "locale":      { "value": "en-US", "confidence": 0.99 },
      "cms":         { "value": "custom", "confidence": 0.62 },
      "robots_state":{ "value": "gptbot_allowed", "confidence": 1.0 },
      "sitemap_urls":{ "value": 1204, "confidence": 1.0 } },
    "competitors_proposed": [
      { "name": "Salesforce", "root_domain": "salesforce.com", "confidence": 0.94, "basis": "own comparison page" },
      { "name": "Pipedrive",  "root_domain": "pipedrive.com",  "confidence": 0.72, "basis": "category peers" } ],
    "prompts_generated": [
      { "prompt_id": "5c2e…", "text": "most reliable CRM for a 50-rep sales team",
        "intent_archetype": "scale_fit", "funnel_stage": "decision", "generation_source": "discovery" } ],
    "prompts_free_remaining": 0,
    "credits_charged": 0,
    "low_confidence_fields": ["cms"] } }
```

| Rule | Behaviour |
|---|---|
| Non-blocking | The project exists and is usable the moment `POST /projects` returns; discovery streams in. |
| Supplied wins | A field supplied at creation is never overwritten by discovery, and is not re-proposed for review. |
| Timeout | Discovery failing still leaves a usable project — `discovery_status: "partial"` with whatever it obtained. |
| Never silent | Nothing discovered is applied without appearing in this payload with a confidence. Values below 0.60 are listed in `low_confidence_fields`. |
| Free | Discovery, the free prompt allowance, and any prompts supplied at creation cost **0 credits**. |

## 5. Prompt generation

**Request — `POST /v1/projects/{id}/prompts/generate`.** Highlights only; the full schema is in `contracts/prompts/`.

```json
{
  "batch_size": 5,
  "topic_hint": "lead management",
  "brand_context": {
    "brand_name": "HubSpot CRM", "brand_aliases": ["HubSpot","HS CRM"],
    "root_domain": "hubspot.com", "category_slug": "crm",
    "verticals": ["b2b_saas","sales_enablement"],
    "competitors": [ { "name": "Salesforce", "aliases": ["SFDC"] } ],
    "personas": ["non_technical_marketing_director"], "size_bands": ["mid_market"]
  },
  "archetype_plan": { "mode": "full_coverage", "include": [ /* 15 archetypes */ ], "exclude": [] },
  "generation": { "strategy": "template_first", "naturalizer_enabled": true,
                  "temperature": 0.35, "single_batched_call": true },
  "dedupe": { "method": "pgvector_cosine", "similarity_threshold": 0.92, "scope": "project" },
  "options": { "auto_activate": false, "priority_subset_size": 6 }
}
```

`strategy` semantics: **`template_first`** (default, L5-cacheable) emits one deterministic candidate per included archetype, then makes **a single batched** model call to naturalise phrasing. **`template_only`** skips the model entirely and still yields 15 valid prompts — the fallback when the naturalizer circuit is open. `model_first` is reserved for custom grammars.

The response returns `variants[]` with `prompt_id`, `text`, `text_hash`, `intent_archetype`, `funnel_stage`, `template_id`, `naturalized`, `brand_named`, `competitor_named`, `slots`, a `novelty` object (`max_cosine_to_existing`, `nearest_prompt_id`), `is_priority`, and `status`; plus `rejected[]` with a reason and the conflicting prompt ID, and a `summary` with `requested / generated / accepted / rejected_duplicate / activated / priority_flagged`.

The 15 archetypes, their funnel stage, and their required slots are specified in [`tracking-engine.md`](./tracking-engine.md#archetype-grammar--the-15-templates).

## 6. Answer capture — the parser document

`GET /v1/results/{id}` returns the canonical parser output. **This is also the shape stored in `answer_captures.payload`**, minus `raw_response.text`, which lives in S3 and is inlined only with `?include=raw`.

```json
{ "data": {
  "schema": "answer_capture.v3",
  "result_id": "res_01J9ZR…", "project_id": "9f1c…", "run_id": "run_01J9ZP…",
  "prompt": { "prompt_id": "5c2e…", "text": "What is the most reliable CRM for a sales team with 50+ reps?",
              "intent_archetype": "scale_fit", "funnel_stage": "consideration", "cluster_id": "clu_3f8b…" },
  "engine": { "key": "chatgpt", "display_name": "ChatGPT (Search)", "capture_mode": "api",
              "adapter_version": "chatgpt-api@3.4.1", "model_fingerprint": "gpt-search-2026-06",
              "grounding": "live_web" },
  "capture": { "captured_at": "2026-08-04T06:12:44.812Z", "sample_index": 0, "latency_ms": 9214,
               "response_tokens_est": 612, "response_chars": 2418, "truncated": false,
               "content_hash": "sha256:7d41c0aa…", "normalizer_version": "n1",
               "raw_object_key": "raw/prod/0c9a…/2026/08/res_….json.gz", "retries": 0 },
  "cache": { "layer": "live", "hit": false, "source_result_id": null, "ttl_seconds": 43200 },
  "raw_response": { "format": "markdown", "char_count": 2418,
                    "text": "For organizations managing scaled operations, **HubSpot CRM** is highly recommended due to its intuitive pipeline workflows. However, some enterprises highlight that **Salesforce** offers deeper custom reporting…",
                    "normalized_text_offsets": true },
  "entities": [
    { "entity_type": "brand", "entity_id": "9f1c…", "label": "HubSpot CRM", "matched_alias": "HubSpot CRM",
      "occurrences": [ { "occurrence_index": 0, "char_start": 52, "char_end": 63, "first_token_index": 9,
                         "list_position": 1, "in_heading": false, "in_recommendation_clause": true,
                         "in_link": false } ],
      "rank_position": 1, "prominence": 0.874,
      "prominence_components": { "position_score": 0.979, "frequency_score": 0.333,
                                 "list_rank_score": 1.0, "clause_bonus": 1.20 },
      "render": { "form": "described", "attrs": ["description","link"], "score": 0.16 },
      "position_class": "recommendation", "answer_form": "narrative",
      "sentiment": { "label": "positive", "score": 0.78, "confidence": 0.93, "method": "lexicon",
                     "evidence_char_start": 52, "evidence_char_end": 141,
                     "evidence_text": "HubSpot CRM is highly recommended due to its intuitive pipeline workflows",
                     "cues": ["highly recommended","intuitive"], "negative_reasons": [] } },
    { "entity_type": "other", "entity_id": null, "label": "Pipedrive", "matched_alias": "Pipedrive",
      "rank_position": 4, "prominence": 0.187,
      "sentiment": { "label": "neutral", "score": 0.0, "confidence": 0.88, "method": "heuristic" },
      "discovery": { "candidate_competitor": true, "seen_count_30d": 14 } } ],
  "citations": [
    { "slot_index": 1, "raw_url": "https://www.hubspot.com/products/crm?utm_source=chatgpt",
      "normalized_url": "https://hubspot.com/products/crm", "url_hash": "sha256:1a2b…",
      "domain": "hubspot.com", "path": "/products/crm", "anchor_text": "HubSpot CRM",
      "is_owned": true, "is_competitor": false, "source_class": "vendor_owned",
      "http_status": 200, "position_weight": 1.000, "resolved_at": "2026-08-04T06:12:47Z" },
    { "slot_index": 2, "normalized_url": "https://g2.com/categories/crm", "domain": "g2.com",
      "is_owned": false, "source_class": "review_marketplace", "position_weight": 0.707 } ],
  "metrics": {
    "scoring_version": "v1",
    "share_of_voice": { "method": "prominence_weighted", "brand": 0.4162,
                        "entities": { "9f1c…": 0.4162, "e21f…": 0.2937, "__other__": 0.0897 },
                        "denominator": 2.084, "tracked_entity_count": 4 },
    "brand_present": true, "brand_rank_position": 1,
    "citation_count": 4, "owned_citation_count": 1, "citation_share": 0.25,
    "sentiment_label": "positive", "sentiment_score": 0.78, "render_score": 0.16 },
  "highlight_map": [
    { "char_start": 52,  "char_end": 63,  "class": "brand-positive",      "entity_id": "9f1c…" },
    { "char_start": 176, "char_end": 186, "class": "competitor-neutral",  "entity_id": "e21f…" } ],
  "flags": [
    { "code": "competitor_cited_owned_domain", "severity": "medium",
      "detail": "salesforce.com appears as a citation while hubspot.com appears once." },
    { "code": "candidate_competitor_detected", "severity": "info",
      "detail": "Pipedrive appeared in 14 of 90 cells in the last 30 days but is not tracked." } ],
  "status": "parsed" } }
```

**The `highlight_map` contract.** Character offsets are computed against `raw_response.text` **after a single documented normalization** — CRLF→LF, Unicode NFC, zero-width strip, blank-line collapse, and nothing else — so the frontend can wrap spans without re-running any matcher. The renderer converts each entry into `<mark class="{class}" data-entity-id="…">` and nothing else. **No HTML from an engine response is ever trusted.** The normalization is versioned; a change forces a re-parse rather than silently shifting spans.

### Prompt matrix

`GET /projects/{id}/matrix?timeframe=30d&engines=chatgpt,perplexity,gemini` returns one row per prompt with one cell per engine. A cell that could not be captured carries `result_id: null` with a `status`, an `error_code`, and `last_success_at` — **never an empty object**, because "we could not ask" and "the engine did not mention you" are different facts.

## 7. Growth Map payload

`GET /v1/projects/{id}/growth-map?timeframe=90d&engines=all&entities=brand,competitors&granularity=day`

```json
{ "data": {
  "granularity": "day",
  "timeframe": { "from": "2026-05-07", "to": "2026-08-04", "timezone": "America/New_York" },
  "series": [
    { "series_id": "brand", "label": "HubSpot CRM", "entity_type": "brand", "color_role": "primary",
      "points": [ { "d": "2026-05-07", "visibility_score": 61.4, "sov": 0.298, "cells": 540, "live_ratio": 0.62 } ] },
    { "series_id": "competitor:e21f…", "label": "Salesforce", "entity_type": "competitor",
      "color_role": "comparison", "points": [ /* … */ ] },
    { "series_id": "competitor_baseline", "label": "Competitor Baseline (median)",
      "entity_type": "derived", "color_role": "baseline", "points": [ /* … */ ] } ],
  "milestones": [
    { "milestone_id": "ms_01J9ZT…", "occurred_at": "2026-08-10T14:22:00Z", "kind": "task_completed",
      "title": "Structured Schema Applied", "severity": "positive",
      "source": { "type": "task", "id": "tsk_01J9…", "short_ref": "HUB-142" },
      "affected_engines": ["chatgpt","perplexity","google_aio"],
      "measured_impact": { "visibility_before": 68.1, "visibility_after_14d": 74.5, "delta": 6.4,
                           "window_days": 14, "confidence": "medium", "method": "pre_post_mean_diff",
                           "caveat": "Observational; concurrent changes are not controlled for." },
      "visible_in_portal": true },
    { "milestone_id": "ms_01J9ZU…", "occurred_at": "2026-07-22T09:00:00Z", "kind": "engine_model_change",
      "title": "ChatGPT search model fingerprint changed", "severity": "warning",
      "affected_engines": ["chatgpt"], "visible_in_portal": false } ],
  "annotations": {
    "data_gaps": [ { "from": "2026-06-14", "to": "2026-06-15", "reason": "engine_unavailable",
                     "engines": ["gemini"] } ],
    "cadence_changes": [ { "at": "2026-07-01", "from": "weekly", "to": "daily" } ] },
  "summary": { "visibility_start": 61.4, "visibility_end": 74.5, "visibility_delta": 13.1,
               "best_engine": "perplexity", "worst_engine": "claude",
               "competitor_gap_start": -16.8, "competitor_gap_end": -3.7 } },
  "meta": { "scoring_version": "v1", "computed_at": "2026-08-04T11:02:31Z", "point_count": 270 } }
```

`measured_impact.caveat` is **mandatory** on every milestone with a computed delta and is rendered in the tooltip. A day with `cells_total = 0` is `null` in `points` and appears in `annotations.data_gaps` — **it is never interpolated**.

## 8. GEO alignment payload

`GET /v1/geo/alignment/{id}` returns the alignment score with its **empirical** target band, the coverage ratio, per-chunk alignment, and ranked recommendations. Each recommendation carries `kind ∈ {semantic_node, structure, jsonld}`, a `guardrail ∈ {phrase_only, structure_only}`, `corpus_doc_ratio`, `projected_gain`, `priority_rank`, and at least one evidence snippet with its source URL.

```json
{ "data": {
  "alignment_id": "algn_01J9ZV…", "target_url": "https://hubspot.com/products/crm",
  "prompt_cluster": { "cluster_id": "clu_3f8b…", "label": "Enterprise CRM reliability & scale",
                      "prompt_count": 11, "engines": ["chatgpt","perplexity","google_aio"] },
  "embedding": { "model": "text-embedding-3-large@1536", "dims": 1536, "storage": "halfvec" },
  "centroid": { "source_passage_count": 25, "source_domains": ["g2.com","reddit.com"],
                "built_at": "2026-08-04T05:40:11Z" },
  "alignment": { "baseline": 0.612, "current": 0.612, "target_band": [0.74, 0.86],
                 "percentile_vs_cited_docs": 21 },
  "coverage": { "required_nodes": 18, "present_nodes": 9, "coverage_ratio": 0.500 },
  "content": { "chunks": [ { "chunk_index": 0, "heading_path": ["CRM","Overview"],
                             "token_count": 486, "alignment": 0.590, "weakest": true } ] },
  "recommendations": [
    { "id": "rec_1", "kind": "semantic_node", "node_type": "compliance", "phrase": "SOC 2 Type II",
      "severity": "critical", "corpus_doc_ratio": 0.72, "present_in_content": false,
      "projected_gain": 0.061, "priority_rank": 1, "guardrail": "phrase_only",
      "requires_human_review": true,
      "warning": "Only include if factually accurate for your product.",
      "evidence": [ { "domain": "g2.com", "url": "https://g2.com/categories/crm",
                      "snippet": "Buyers in this category filter heavily on SOC 2 Type II attestation…" } ] },
    { "id": "rec_2", "kind": "structure", "structure_rule": "capability_matrix_table",
      "severity": "high", "projected_gain": 0.048, "priority_rank": 2, "guardrail": "structure_only",
      "rationale": "19 of 25 cited passages present capabilities as a table; extractive engines lift table rows verbatim.",
      "template": "| Capability | Value | Notes |\n|---|---|---|\n" } ],
  "projection": { "if_all_applied": { "alignment": 0.774, "coverage_ratio": 0.833 },
                  "method": "additive_blend_estimate", "confidence": "modeled",
                  "caveat": "Projected alignment is an estimate of embedding proximity, not a ranking guarantee." },
  "anti_filler_policy": { "generation": "disabled",
    "explanation": "Nominara returns phrases, structures, and schema — never generated prose." },
  "status": "open" } }
```

`anti_filler_policy.generation` is asserted `"disabled"` by a contract test. There is no generation endpoint to enable.

## 9. Visibility Scan — SSE contract

The reference contract for every capture-backed tool. Prompt Research reuses the same envelope with `prompt_texts[]` in place of `brand_name`/`query_text`.

```
event: scan.accepted
data: {"tool_run_id":"tr_01J9ZQ…","engines":["chatgpt","perplexity"],
       "credits":{"reserved":10,"rate":"flat","available_after":1457}}

event: scan.engine_result
data: {"engine":"perplexity","cache_layer":"l1","captured_at":"2026-08-04T10:41:02Z","latency_ms":41,
       "brand_present":true,"rank_position":2,"sov":0.31,
       "sentiment":{"label":"positive","score":0.62},
       "citations":[{"slot":1,"domain":"stripe.com","is_owned":true},
                    {"slot":2,"domain":"reddit.com","is_owned":false}],
       "excerpt":"For subscription-heavy SaaS, **Stripe Billing** is the most common choice because…"}

event: scan.completed
data: {"tool_run_id":"tr_01J9ZQ…","status":"completed","duration_ms":9012,
       "aggregate":{"sov_estimate":0.375,"citation_count":7,"owned_citation_count":2,
                    "sentiment_label":"positive","brand_present":true,
                    "engines_succeeded":["perplexity","chatgpt"],"engines_failed":[]},
       "convert_cta":{"endpoint":"/v1/tools/runs/tr_01J9ZQ…/convert",
                      "prefill":{"project_name":"Stripe Billing","root_url":"https://stripe.com/billing",
                                 "prompts":["best subscription billing engine for SaaS"],
                                 "competitors":["Chargebee","Recurly"]}}}
```

On timeout the terminal event is `scan.completed` with `"status":"partial"` and the engines that did respond; **the snapshot is still stored**, because a partial answer is a valid historical record. A run that captured **nothing** releases its reservation and is not charged.

`NFR-API-09`: streaming endpoints send a `: ping` comment every 15 s and terminate at 60 s with a terminal event. A client never holds an indefinite stream.

## 10. Command bar

`POST /v1/command/parse` is local-first. A deterministic grammar plus a trigram entity index over the workspace's projects, competitors, prompts, and tool runs resolves the top intents with **zero model cost and zero credits**. Only unresolved input escalates, and the parse is cached by `sha256(normalized_query | workspace_id | entity_index_version)` for 24 hours.

**Credit rule.** `resolved_by: "grammar"` ⇒ `cost.credits = 0`. `resolved_by: "model"` ⇒ `cost.credits = 1`, debited on the parse itself. **A cache hit is always 0**, regardless of how the original parse resolved.

The response carries `parse_id`, `resolved_by`, `confidence`, `intent`, `slots`, `actions[]`, an optional `preview`, `cost`, and `wallet`. Each action carries `action_id`, `kind`, `label`, `is_mutating`, `requires_confirmation`, `required_permission`, and — when it would spend credits — a full `credit_estimate` with the exact figure and the wallet before/after.

**Safety rules.** A parse never mutates and never enqueues external work. Execution requires **both** `parse_id` and `X-Nominara-Confirmed-Credits` echoing the exact displayed figure. Actions the caller lacks permission or entitlement for are returned **disabled with a reason** rather than hidden, so power users learn the model.

The canonical 14 intents are enumerated **only** in [`product-spec.md`](./product-spec.md#13-f11--nlp-command-bar--p1) (`FR-NL-03`).

## 11. Realtime events

Namespace `/rt`; rooms `ws:{workspace_id}` and `proj:{project_id}`.

| Event | Payload | Emitted by | Coalescing |
|---|---|---|---|
| `run.progress` | `{run_id, project_id, planned, captured, skipped, failed, pct, eta_ms}` | worker-capture | ≤ 1 / 750 ms / run |
| `run.completed` | `{run_id, project_id, status, captured, failed, duration_ms, visibility_delta}` | worker-rollup | — |
| `run.failed` | `{run_id, project_id, error_code, failed_engines[]}` | worker-capture | — |
| `scan.engine_result` · `scan.completed` | see §9 | worker-capture | — |
| `aux.audit_completed` | `{audit_id, project_id, aux_score, delta, findings:{critical,high,medium,low}}` | worker-crawl | — |
| `aux.finding_created` | `{finding_id, project_id, rule_code, severity, url}` | worker-crawl | ≤ 5 / s / project |
| `task.created` | `{task_id, project_id, status, title, priority, impact_score, rule_code}` | worker-rollup | ≤ 5 / s / project |
| `task.moved` | `{task_id, project_id, from_status, to_status, actor_id}` | api | — |
| `displacement.detected` | `{event_id, project_id, prompt_id, engine_key, kind, impact_score}` | worker-rollup | ≤ 5 / s / project |
| `quota.threshold` | `{metric, used, limit, pct, resets_at}` | api / worker | once per threshold |
| `credits.debited` | `{action_code, credits, available_after, reference_type, reference_id, project_id}` | api / worker | — |
| `credits.threshold` | `{available, included_balance, purchased_balance, pct_remaining, cycle_end, packs[]}` | worker | once per threshold per cycle |
| `credits.depleted` | `{cycle_end, scheduled_scans_unaffected: true, packs[]}` | worker | once per cycle |
| `credits.topped_up` | `{pack_key, credits, source, available_after}` | api | — |
| `report.ready` | `{report_artifact_id, download_url_expires_at}` | worker-report | — |
| `engine.degraded` | `{engine_key, circuit_state, since, affected_projects}` | worker-capture | ≤ 1 / min / engine |
| `member.changed` | `{workspace_id, user_id, role, status}` | api | — (forces socket re-auth) |
| `server.draining` | `{reconnect_after_ms}` | gateway | — |

**STORY-026.** `run.progress` previously read `eta_seconds`, which `NFR-API-05` forbids — "all durations are integer milliseconds with a `_ms` suffix". The unconditional requirement wins over a single table cell, the same way it did for `expires_in_seconds` in STORY-117; shipping both spellings would put two duration units on the wire and make the `_ms` convention mean nothing. `eta_ms` is **nullable**: an estimate is not always computable, and zero is a real estimate rather than a missing one.

Every event maps to a **precise** TanStack Query invalidation key on the client. A blanket refetch is a performance-budget violation.

**Decision D4.** The table above has no invalidation-key column, and this API repository does not define one: the keys are owned by `nominara-app`'s `lib/query/` — "TanStack keys, staleTime table, event→invalidation map" ([`project-structure.md` §3](./project-structure.md#3-nominara-app)) — not by this reference. **No invalidation key is defined here**, and none should be invented against this document. STORY-026 AC10 ("each event's documented invalidation key is published alongside it") is deferred pending that mapping.

## 12. Rate limits

Token buckets in Valkey; keys are additive — every applicable bucket must have capacity.

| Route class | Per user | Per workspace | Per IP | Burst |
|---|---|---|---|---|
| Auth (`/auth/*`) | 10/min | — | 30/min | 5 |
| Reads (`GET /*`) | 300/min | 1,200/min | — | 60 |
| Writes | 60/min | 240/min | — | 20 |
| Capture-backed tools | 5/min, 40/day | 20/min | — | 2 |
| Capture-backed tools, capped tiers | 1/min, **3/UTC-day hard cap** | 3/day | 10/hour | 1 |
| `POST /projects/{id}/runs` | 6/hour | 30/hour | — | 2 |
| `POST /projects/{id}/aux-audits` | 10/hour | 60/hour | — | 3 |
| `POST /geo/alignment` | 30/hour | 120/hour | — | 5 |
| `POST /command/parse` | 120/min | — | — | 30 |
| `POST /command/execute` | 20/min | 60/min | — | 5 |
| `POST /billing/credit-packs/{key}/purchase` | 5/hour | 10/hour | — | 2 |
| `POST`/`DELETE /billing/subscription/change` | 5/hour | 10/hour | — | 3 |
| `POST /billing/subscription/change/preview` | 30/hour | 60/hour | — | 5 |
| `POST /portal/session` | — | — | 10/hour; 5 failed passwords → 15-min lock per token | 2 |
| `GET /public/niche-reports*` | — | — | 120/hour | 1 |

**Amended by STORY-026's review, and the amendment is recorded rather than silent.** The paragraph below was added by the story that implemented §12, which is the documentation equivalent of editing a golden fixture — it is stated here so a reader knows the reference and the implementation were changed in the same breath. No NUMBER in the table was altered; an independent audit verified all thirteen rows digit-for-digit against the original.

**Two plan-change classes, `plan_change` and `plan_change_preview` (STORY-184, owner decision 2026-10-16).** The in-app plan change is a money-moving write, so `plan_change` takes the credit-pack purchase's hourly numbers (5/hour per user, 10/hour per workspace) with a burst of 3 (change, cancel, change again is a normal sequence); `POST` and `DELETE /billing/subscription/change` share it. The preview calls Stripe but charges nothing, so it has its own class: 30/hour per user, 60/hour per workspace, burst 5. A same-key replay of the change is still counted: the rate guard runs before the idempotency interceptor, so the replay is not answered from the stored response until the bucket has admitted it. No number in any other row was altered.

**One `Burst` per row, applied to buckets whose windows differ by orders of magnitude.** A row such as the capped tiers carries a per-minute, a per-UTC-day and a per-hour bucket under a single `Burst` of 1. Read literally — burst is the token bucket's capacity, for every bucket in the row — the workspace `3/day` bucket holds one token and refills one per eight hours, so the `3/UTC-day` cap is never the binding constraint. That may be exactly what a capped tier should feel like, or the column may be intended for the minute-scale buckets only. **This document does not say, and the implementation follows the literal reading — but not consistently, which is the part needing a decision.** Within the capped-tier row the implementation reads the single `Burst` two different ways: the `3/UTC-day` hard cap is a plain counter that allows three, while the same row's workspace `3/day` is a capacity-1 token bucket that allows one per eight hours. Nothing in this table licenses reading one column two ways.

**Bucket configuration is data (STORY-025, plan OQ-5).** The table above is the committed default. A JSON document holding all 15 route classes (the `rateLimitConfigSchema` contract) at `{env}:global:ratelimit:config` in the cache Valkey overrides it. Each API instance re-reads it at most every 15 s, so a change is enforced within 15 s with no redeploy. A missing, unparseable, schema-invalid (including any missing route class) or unreadable document is logged (`rate-limit config invalid|unreadable`, outcome only, never the body) and the committed defaults are enforced; it never degrades to unlimited. The document is also held to an **envelope** around the defaults, because a schema-valid document can still switch a control off: for every class the set of `(scope, window, hard_cap)` buckets must equal the defaults' exactly, and each `limit`, `burst` and `window_ms`, and the rate `limit / window_ms` of every rolling bucket, must lie within [default ÷ 10, default × 10]. If any class fails, the whole document is replaced by the defaults (never a partial merge, never the last good document). The read is abandoned after 250 ms and counts as unreadable; a clock that steps backwards counts as stale. Operators write the key directly; there is no admin API and no versioning.

**`/auth/otp/request` has two limits, deliberately (owner decision 2026-10-14).** The `auth` class above (30/min per IP, burst 5, `RateLimitGuard`) answers first over HTTP; STORY-016's per-source ledger inside `EmailOtpService` (30/min per source, no burst) is defence in depth on the same axis.

**Rate limits are an abuse control and are independent of credits.** Exhausting one returns `429 rate_limited` and debits nothing; a credit-spending call that is rate-limited never reaches `CreditGuard`, so no reservation is created.

## 13. Non-functional requirements

| ID | Requirement |
|---|---|
| `NFR-API-01` | Reads p95 ≤ 250 ms, p99 ≤ 600 ms (excluding streaming). Writes p95 ≤ 500 ms. |
| `NFR-API-02` | Every endpoint validates input with a **`.strict()`** zod schema; an unknown field is rejected, never ignored. |
| `NFR-API-03` | Every list endpoint is cursor-paginated with a hard `limit` cap of 200 and a default of 50. |
| `NFR-API-04` | Breaking changes require a new path version. Within `v1` only additive changes ship; a 6-month deprecation window with `Sunset` and `Deprecation` headers precedes any removal. |
| `NFR-API-05` | All timestamps are RFC 3339 with an explicit `Z` or offset; all durations are integer milliseconds with a `_ms` suffix; all money is `{amount_usd: string, currency: "USD"}`. |
| `NFR-API-06` | Responses never contain another tenant's identifiers, credentials, DEK material, or raw engine HTML. |
| `NFR-API-07` | `Idempotency-Key` is **enforced, not merely accepted**, on every endpoint that spends credits, calls an external system, or mints a secret. A replayed credit-spending request returns the original result and debits **nothing** additional. |
| `NFR-API-08` | Every response carries `meta.request_id`, propagated as the OpenTelemetry trace ID, so a support ticket resolves to a single trace. |
| `NFR-API-09` | Streaming endpoints heartbeat every 15 s and terminate at 60 s with a terminal event. |
| `NFR-API-10` | The OpenAPI document is published, versioned in Git, and validated against live responses by a nightly contract test exercising every endpoint against seeded fixtures. |
| `NFR-API-11` | **Every credit-spending endpoint has a paired free estimate endpoint** (or returns the estimate inside a parse), so a client can always show cost before commitment. |
| `NFR-API-12` | Wallet headers are present on every authenticated response. A client never polls `/billing/wallet` to keep a balance current. |
| `NFR-API-13` | The five spend-and-limit failure conditions are distinct and non-overlapping. |
| `NFR-API-14` | A `429 daily_limit_reached` debits nothing. If the daily counter incremented and the wallet reservation then failed, the increment is **compensated under the same idempotency key**. |
