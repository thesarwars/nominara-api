> **Historical execution record — not a specification.**
>
> This is the `system-architect`-signed-off execution plan for EPIC-03, committed
> verbatim as it stood at sign-off. It is kept because it carries reasoning that
> exists nowhere else: three planner revisions and three architect review rounds,
> the settled decisions D1–D12, the open questions OQ-1…OQ-8 and their answers,
> and the hand-carried specification-fix list.
>
> **It is not a source of truth and never outranks a story.** Where this document
> and a story in `Nominara-Dev-Docs-main/stories/` disagree, the story wins; where
> a story and a reference disagree, the reference wins. Task numbering (T0–T26)
> and gate numbering (G23–G26) are referenced by commit messages in this
> repository, which is the other reason it is here rather than in a scratchpad.
>
> It was written before any code existed. Statements about the state of the
> repository were true at sign-off and are not maintained.

# EXECUTION PLAN (FINAL): EPIC-03 — API Platform & Contract Pipeline

**Status:** validated by `system-architect` — no further architect round-trip required.
**Repo:** `/Users/sarwaralam/Desktop/Projects/ElegantTech/nominara/api` (the only git repo; `nominara/` is a plain folder, `Nominara-Dev-Docs-main/` is a snapshot with no `.git`).
**Branch:** `epic-03-api-platform-and-contracts` — one branch for the whole epic (a knowing deviation, see "Commit and branch shape").
**Stories:** STORY-023 (2.0d), STORY-024 (1.5d), STORY-025 (1.5d), STORY-026 (1.5d). STORY-022 is already merged.

This document is self-contained. It assumes no chat context.

---

## 1. Summary

Deliver the cross-cutting platform every later endpoint depends on:

- **STORY-023** — zod → OpenAPI 3.1 → published `@nominara/client`, with a drift gate that fails the build.
- **STORY-024** — the error taxonomy, the response envelope, cursor pagination, ETag optimistic concurrency.
- **STORY-025** — the idempotency key store and additive rate-limit token buckets.
- **STORY-026** — the realtime gateway: room authorisation, the typed event catalog, coalescing, backpressure, and the SSE helper.

STORY-023 gates every endpoint story in every later epic and all of EPIC-12.

### Verified state of the repo (measured, not assumed)

- HEAD `671859f` "STORY-015: OAuth 2.1 + PKCE sign-in…", even with `origin/main`, working tree clean.
- `src/api/api.module.ts` composes the global chain exactly once. Guards: `Auth → Workspace → Rbac → Entitlement → Quota → DailyCap → RateLimit → Credit`. **`RateLimitGuard` runs BEFORE `CreditGuard`** — a deliberate correction (STORY-022-E-1) of the diagrams in `system-architecture.md` §2, `security-and-tenancy.md` §5 and EPIC-03's own "The global chain" block, all of whose *prose* says a rate-limited request must never reach the credit guard. **The code is right. Never "fix" the code to match a diagram.**
- Interceptors registered `[Idempotency, TenantContext, Audit, Credit]`; order locked by `src/api/api.module.spec.ts` (198 lines) over a real HTTP request.
- Real and implemented: `auth.guard.ts` (134), `workspace.guard.ts` (152), `rbac.guard.ts` (108), `tenant-context.interceptor.ts` (75), `audit.interceptor.ts` (194), `problem.filter.ts` (51, two spec files).
- No-op stubs awaiting later stories: `entitlement.guard.ts`, `quota.guard.ts`, `daily-cap.guard.ts`, `rate-limit.guard.ts`, `credit.guard.ts`, `idempotency.interceptor.ts`, `credit.interceptor.ts`. **This epic replaces the idempotency and rate-limit stubs only**; entitlement/quota/daily-cap/credit logic stays stubbed (EPIC-10).
- `src/gateway/realtime.gateway.ts` is 26 lines: `/rt` namespace + `server.draining` on shutdown. No rooms, no auth, no adapter, no emitters.
- `contracts/` holds 29 hand-written zod files (34 exported schemas). Naming convention in this repo is `<thing>.schema.ts`.
- **Only four controllers have real routes:** `health`, `identity`, `oauth`, `workspaces`. Every other module is an empty `@Controller` scaffold.
- No `contracts/openapi.generated.json`, no generator, no drift check, no publish script, **no `.github/` directory at all** (no CI exists).
- `docker-compose.yml` has postgres + pgbouncer only. No Valkey.
- `test/` holds `unit`, `integration`, `isolation`, `support`. No `golden`, `e2e`, `perf`.

### Measured baseline (re-run, not inherited)

| Gate | Result |
|---|---|
| `pnpm --config.verify-deps-before-run=false lint` | PASS — clean |
| `pnpm --config.verify-deps-before-run=false typecheck` | **FAIL — two errors** |
| `pnpm --config.verify-deps-before-run=false test:unit` | **FAIL — 6 failed / 437 passed (65 files)** |

Both extra failures share one cause: `node_modules` is stale after the STORY-015 pull. `openid-client@6.8.7` is in `package.json` and absent from `node_modules`; `node_modules/.pnpm` holds **both** `fastify@5.11.3` and `5.12.0`.

```
src/api/register-cookies.ts(8,22): error TS2345: Argument of type 'typeof fastifyCookie' is not assignable …
src/modules/identity/adapters/openid-client.adapter.ts(1,25): error TS2307: Cannot find module 'openid-client'
```

### Environment gotchas (every command)

```bash
# Every pnpm script fails a pnpm 11 dependency pre-check (ERR_PNPM_IGNORED_BUILDS) until T0b:
pnpm --config.verify-deps-before-run=false <script>

# testcontainers (colima) — export before test:integration / test:isolation:
export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
export TESTCONTAINERS_RYUK_DISABLED=true
```

---

## 2. Settled decisions D1–D9

These are decided. Do not reopen them; do not re-derive them.

| # | Decision |
|---|---|
| **D1** | **The `/v1` prefix ships now.** `setGlobalPrefix("v1")` with the health probes excluded so the orchestrator keeps unversioned readiness. **Nest's `exclude` takes `(string \| RouteInfo)[]`, NOT a RegExp** — `exclude: [/^health/]` silently excludes nothing. Correct form: `exclude: [{ path: "health", method: RequestMethod.ALL }, { path: "health/live", method: RequestMethod.GET }, { path: "health/ready", method: RequestMethod.GET }]`. Delivered through `configureApp()` (T0c), never inline in `bootstrap()` alone. |
| **D2** | **Error wire shape: RFC 9457 top-level members (`type`/`title`/`status`/`detail`) PLUS an `error` extension member** carrying `code`/`message`/`details`/`remediation`/`request_id`. Resolves **before T1**. `api-specification.md` §1 and §2 are fixed together, including the `application/json` (§1 line 4) vs RFC 9457's mandated `application/problem+json` (§2) contradiction. |
| **D3** | **Dependencies approved:** no zod-to-OpenAPI library (zod 4.4.3's native `z.toJSONSchema` — verified: all 34 exported contract schemas convert cleanly to `draft-2020-12`, `{ok: 34, fail: 0}`, and `.strict()` correctly emits `additionalProperties: false`); `openapi-typescript` + `openapi-fetch` for client generation; `ioredis` for Valkey; `@socket.io/redis-adapter`. Plus the environment fix (T0b). **`openapi-fetch` is a RUNTIME dependency of the published client and therefore crosses into `nominara-app`** — `project-structure.md` §6's "exactly two packages cross a repository boundary" becomes false and goes on the hand-carried list. |
| **D4** | **STORY-026 AC10 (per-event invalidation keys) is DEFERRED with a named blocker.** Ship the 19 typed event schemas; invent no keys. Do not report AC10 as met. |
| **D5** | **The `@ApiContract()` decorator is the OpenAPI source; `contracts/registry.ts` is dropped.** `contracts-decorator-coverage.spec.ts` is NOT deleted — it is the renamed, rewritten route-coverage gate (T2). Costs recorded in T3. ADR-0002 required, and must state the `@nestjs/swagger` boundary. |
| **D6** | **An idempotent replay carries an `Idempotency-Replayed: true` response header.** The body stays byte-identical, per STORY-025 AC2. |
| **D7** | **`member.changed` is wired**, touching `src/modules/workspaces/workspaces.service.ts`. Scope signal recorded in the PR body. |
| **D8** | **The index-1 insertion of `ResponseEnvelopeInterceptor` into `api.module.ts` is approved.** |
| **D9** | **`@socket.io/redis-emitter` approved.** The api process publishes `member.changed` through the emitter. **Do NOT hand-roll `@socket.io/redis-adapter`'s channel format. Do NOT stand up a socket.io server in the api process merely to emit.** |

**Five dependencies in one epic. README rule 7 governs dependency additions; D3 and D9 are the approving record, and that record must be carried in the PR body (see §6).**

---

## 3. Prerequisites — T0 (block everything)

### T0a · `pnpm install`
- **Owner:** api-dev · **Depends on:** —
- Fixes the 6 unit-test failures and one of the two typecheck errors.
- Not a commit.

### T0b · Environment fix (D3)
- **Owner:** user (interactive) + api-dev
- `pnpm approve-builds` (interactive — the user must run it), then move `pnpm.overrides.fastify` out of `package.json` (pnpm 11 no longer reads the `pnpm` field and warns on every command) into `pnpm-workspace.yaml`, then reinstall.
- **This is the only thing that makes `typecheck` green. Until it is done, STORY-023's drift gate lands into a build whose type gate is red — the exact condition the story exists to remove.**
- **Never** "fix" the `register-cookies.ts` error by loosening the `FastifyInstance` type.
- **Commit:** `chore: move the fastify override to pnpm-workspace.yaml and approve builds`

### T0c · Extract `configureApp()` and land the `/v1` prefix across the suite
- **Owner:** api-dev · **Depends on:** T0a
- **Files:** `src/api/configure-app.ts` (new), `src/main.ts`, `test/support/api-url.ts` (new), and every test that assembles an app.
- **Why `apiUrl()` alone cannot deliver D1.** `setGlobalPrefix` would live in `bootstrap()`, but **no test calls `bootstrap()`** — every test hand-assembles its app. Measured: **12 `createNestApplication` calls across 9 files**, and `registerCookiePlugin` duplicated at **7 call sites across 6 spec files** (`identity-passkey-webauthn.spec.ts` registers twice — line 167 as `app` and line 647 as `apiApp`; plus `identity-session-model.spec.ts:273`, `workspace-switching.spec.ts:221`, `workspace-mutations-audit.spec.ts:92`, `identity-oauth-pkce.spec.ts:195`, `problem.filter.http.spec.ts:103`).
  Without a shared seam there are only two outcomes, both bad: either `apiUrl()` returns the unprefixed path — in which case no test ever exercises production's real path shape and the generated document's `/v1/…` paths are asserted against a router that does not have them, **gutting STORY-023 AC9's "specification entry … all agree"** — or the prefix is hand-added at 9 more sites, a fresh drift surface of exactly the kind this epic exists to close.
- **Required:** extract `configureApp(app)` from `bootstrap()` (global prefix per D1, `registerCookiePlugin`, and anything else `bootstrap()` does); call it from `bootstrap()` **and from all 12 test assembly sites**; `apiUrl()` reads the same exported prefix constant. This also retires the 7-way `registerCookiePlugin` duplication.
- **Measured `/v1` ripple** (`grep -c "\.inject("`):

| File | `app.inject()` calls | response-body reads |
|---|---|---|
| `test/integration/identity-passkey-webauthn.spec.ts` | 56 | 60 |
| `test/integration/identity-oauth-pkce.spec.ts` | 23 | 38 |
| `test/integration/workspace-mutations-audit.spec.ts` | 14 | 15 |
| `src/api/filters/problem.filter.http.spec.ts` | 7 | — |
| `test/integration/identity-session-model.spec.ts` | 6 | 2 |
| `test/integration/audit-interceptor-real-pipeline.spec.ts` | 4 | — |
| `src/api/api.module.spec.ts` | 3 | — |
| `test/integration/workspace-switching.spec.ts` | 2 | 3 |
| `test/integration/health-and-readiness.spec.ts` | 2 | 2 |
| **Total** | **117 across 9 files** | |

  Method: `grep -c "\.inject("` and `grep -c "\.json()\|\.body\|payload"`.
- **Commit:** `chore: extract configureApp and add the /v1 prefix across the test suite`

### T0d · Specification fixes (D2 + the hand-carried list)
- **Owner:** api-dev · **Depends on:** —
- `Nominara-Dev-Docs-main/` has **no `.git`**. Make the edits anyway (the workflow requires the spec to stay truthful), then **tell the user they must be carried to the docs repo by hand.** Full list in §11.
- **Must land before T1** — it determines `contracts/common/problem-details.schema.ts` and `error-code.schema.ts` (T1) and `openapi.generated.json` (T3).

---

## 4. Contract steps (each lands first, alone, within its story)

| Story | Files |
|---|---|
| 023 | `contracts/common/{envelope,pagination,problem-details,error-code}.schema.ts`, `src/api/decorators/api-contract.decorator.ts`, `docs/adr/ADR-0002-*.md` |
| 024 | `contracts/common/error-code.schema.ts` (completed to 27 codes), `error-details.schema.ts`, `money.schema.ts`, `cursor.schema.ts` |
| 025 | `contracts/common/{idempotency,rate-limit}.schema.ts` |
| 026 | `contracts/events/*.schema.ts` — 19 events |

---

## 5. Task breakdown

Owner agents: `api-dev`, `code-reviewer`, `dangerous-area-auditor`. (`frontend-dev` is unused — no frontend repo is cloned and this epic contains no frontend work.)

---

### STORY-023 — zod → OpenAPI 3.1 → published client, with a drift gate (2.0d)

#### T1 · Shared contract shapes + the `@ApiContract()` decorator + ADR-0002
- **Owner:** api-dev · **Depends on:** T0a, T0b, T0c, T0d
- **Files:** `contracts/common/{envelope,pagination,problem-details,error-code}.schema.ts`, `src/api/decorators/api-contract.decorator.ts`, `docs/adr/ADR-0002-contract-decorator-as-the-openapi-source.md`
- **Acceptance:** STORY-023 AC1 ("contracts directory holds schemas organised by area, plus shared envelope, pagination and error shapes"); `NFR-API-03` bounds (hard cap 200, default 50) encoded in the schema, never in a handler.
- `problem-details.schema.ts` encodes **D2's dual shape**.
- **ADR-0002 must state the `@nestjs/swagger` boundary explicitly.** A decorator that reads like Swagger's is an on-ramp to adopting `@nestjs/swagger`, which would make decorator metadata a *second* description of the contract alongside zod and break KAD-05. The ADR records: the decorator carries **references to zod schemas only** — never duplicated field descriptions, examples or types — and `@nestjs/swagger` is not adopted.
- **Own commit.**

#### T2 · RED — the pipeline's failing tests (reviewed before T3 starts)
- **Owner:** api-dev · **Depends on:** T1
- **Files:** `test/unit/contracts-openapi-generate.spec.ts`, `contracts-drift-check.spec.ts`, `contracts-semver-diff.spec.ts`, `contracts-strictness.spec.ts`, `contracts-worked-example.spec.ts`, `contracts-decorator-coverage.spec.ts`, `client-previous-minor.spec.ts`, `test/integration/openapi-route-and-strictness.spec.ts`

| Row | Scenario | Test |
|---|---|---|
| 1 | Generate from the schemas | `contracts-openapi-generate.spec.ts` — regenerate in memory, deep-equal the committed document |
| 2 | Hand-edit the document | `contracts-drift-check.spec.ts` — mutate a fixture copy, assert non-zero exit |
| 3 | Change a schema without regenerating | `contracts-drift-check.spec.ts` — mutate a schema, assert non-zero exit |
| 4 | Add a field | `contracts-semver-diff.spec.ts` → `patch` |
| 5 | Add an endpoint | `contracts-semver-diff.spec.ts` → `minor` |
| 6 | Remove a field | `contracts-semver-diff.spec.ts` → `major` |
| 7 | Narrow a type | `contracts-semver-diff.spec.ts` → `major` |
| 8 | Unknown key to any endpoint | `contracts-strictness.spec.ts` + `openapi-route-and-strictness.spec.ts` (real `POST /v1/workspaces` with an extra key → 400 naming the key) |
| 9 | Type-check a consumer against the previous minor | `client-previous-minor.spec.ts` — **partial; see OQ-8 in §12** |
| 10 | Inspect the worked example | `contracts-worked-example.spec.ts` — validator, inferred type, specification entry and client method all present and agreeing for `POST /v1/workspaces` |

- **`contracts-decorator-coverage.spec.ts` — the coverage gate, and its predicate is load-bearing (D5).**
  The registry's failure mode was "the registry forgot a route"; the decorator's is "the route forgot its decorator", and it is **equally silent** — an undecorated route simply vanishes from the generated document while the drift check passes, because the document matches what generation produced.
  **The exemption predicate must NOT be `@Public()`.** This is the same predicate overload corrected one layer up for the envelope (T10). Verified: `@Public()` sits on **five contract-bearing API routes** — `src/modules/identity/identity.controller.ts:30, 38, 49` and `src/modules/identity/oauth.controller.ts:34, 57` — which are backed by **14 zod contract files (15 exported schemas) under `contracts/identity/`** and are listed in `api-specification.md` §3's endpoint registry. Under a `@Public()`-keyed exemption any of them could lose its `@ApiContract()` and vanish from `openapi.generated.json` and `@nominara/client` **with every gate green** — STORY-023 AC5 and the epic's "one schema, four artifacts, zero drift" failing in exactly the way the drift check exists to prevent.
  **Required, two-sided, mirroring `envelope-scope-and-probe-exemption.spec.ts`:**
  1. exempt **only** the probe routes (keyed on `@NoEnvelope()` / `HealthController`) and the `/v1/openapi.json` route itself;
  2. assert **positively** that all five identity/OAuth routes **DO** declare `@ApiContract()`;
  3. assert every other non-exempt route in the Nest router declares `@ApiContract()`.
- **The strictness assertion must be schema-kind-aware.** `.strict()` is meaningless on three real files — `passkeyVerifyRequestSchema` is a `z.union`, `oauthProviderSchema` a `z.enum`, `entitlementOverridesSchema` a `z.record`. A naive "every request schema is `.strict()`" false-fails on all three. Assert over the **emitted JSON Schema** instead: every object-typed request schema, including each `anyOf` branch of a union, emits `additionalProperties: false`. **There is no pre-existing `.strict()` gap** — all 29 contract files audited.

#### T3 · GREEN — generator, drift check, semver diff, served route
- **Owner:** api-dev · **Depends on:** T2 (reviewed)
- **Files:** `src/contracts/{generate,check,diff,serve}.ts`, `contracts/openapi.generated.json` (new committed build artifact), `src/api/register-openapi.ts`, `src/api/configure-app.ts` (openapi route), `package.json` scripts `contracts:generate` / `contracts:check` / `contracts:diff`
- **Acceptance:** AC3, AC4, AC7, AC8 · `NFR-REPO-01`, `NFR-API-02`, `NFR-API-04`, `NFR-API-10`, KAD-05
- **The decorator's cost, recorded honestly (D5).** `contracts:generate` **stops being a pure file transform.** It must boot the Nest container or walk metadata via `DiscoveryService`. Consequences: it needs a valid environment (the same fake-env block `api.module.spec.ts` already requires at lines 53–69 — `DATABASE_URL`, `DATABASE_URL_POOLED`, `WEBAUTHN_*`, `AUTH_TOKEN_ED25519_*`, `CSRF_SECRET`, `WORKSPACE_DEK_WRAPPING_KEY`, `OAUTH_REDIRECT_BASE_URL`, `OAUTH_STATE_SECRET`); it is materially slower; and **if the app cannot boot, the document cannot be generated at all** — a boot failure and a contract failure become the same red. This is the accepted cost of making route-to-schema divergence structurally impossible. **Mitigation:** `contracts:generate` uses its own committed fixture env, never a developer's `.env`.
- Generation: `z.toJSONSchema(schema, { target: "draft-2020-12" })` into `components.schemas` (draft-2020-12 *is* OpenAPI 3.1's schema dialect); decorator metadata into `paths`.
- `GET /v1/openapi.json` is `@Public()`; assert it exposes no internal-only schema (`NFR-API-06`).
- **Hand-editing `contracts/openapi.generated.json` is never correct.** The checker has no warning mode.
- **Observability (coding-standards §7, DoD item 8):** one metric `nominara_contracts_drift_check_total{result}` and one redacted log line naming the drift path. **Verified, not assumed.**

#### T4 · GREEN — `@nominara/client` generation
- **Owner:** api-dev · **Depends on:** T3
- **Files:** `client/` package (see OQ-4, settled: `api/client/`), `src/contracts/generate-client.ts`, script `client:generate`
- **Acceptance:** AC5 (request/response types, fetch client, realtime event types, error-code union), AC10 (previous minor)
- Uses `openapi-typescript` + `openapi-fetch` (D3). Realtime event types land in T24.

#### T5 · CI wiring — DEFERRED / BLOCKED
- **Owner:** api-dev · **Depends on:** T4
- **Files:** `.github/workflows/contracts.yml`, `.github/workflows/release-client.yml`
- **Acceptance:** AC6 / `NFR-REPO-02`
- **There is no `.github/` directory in this repo — no CI exists at all.** Publishing to private GitHub Packages needs the `@nominara` org registry, OIDC trust and repo secrets. The workflows can be authored but cannot be executed, verified or dry-run here. **Do not tick AC6.**
- Locally provable instead: `contracts:diff` classifies all four change classes (rows 4–7), and `npm pack --dry-run` on the generated client.

#### T6 · Review
- **Owner:** code-reviewer · **Depends on:** T3, T4
- Confirms AC2 — no hand-written request or response interface was introduced.

**→ G23 (story gate, §7)**

---

### STORY-024 — Error taxonomy, envelope, cursor pagination, ETags (1.5d)

#### T7 · Contract — the full taxonomy (own commit)
- **Owner:** api-dev · **Depends on:** T3
- **Files:** `contracts/common/error-code.schema.ts` (completed), `error-details.schema.ts`, `money.schema.ts`, `cursor.schema.ts`
- **Acceptance:** `api-specification.md` §2 in full · `NFR-API-05` (RFC 3339 timestamps, integer-ms `_ms` durations, `{amount_usd: string, currency: "USD"}` money), `NFR-API-13`
- **The taxonomy is 27 codes, not 24.** The §2 table has 24 rows, but three carry multiple codes: `unauthenticated`/`token_expired`/`token_revoked` (one row, three codes) and `workspace_mismatch`/`project_out_of_scope` (one row, two codes). Verified by extraction. The 27: `validation_failed`, `unsupported_engine`, `unauthenticated`, `token_expired`, `token_revoked`, `step_up_required`, `insufficient_credits`, `forbidden`, `workspace_mismatch`, `project_out_of_scope`, `entitlement_exceeded`, `feature_not_in_plan`, `not_found`, `conflict`, `idempotency_conflict`, `workspace_limit_reached`, `price_changed`, `domain_not_verified`, `precondition_unmet`, `unsafe_target`, `rate_limited`, `quota_exceeded`, `daily_limit_reached`, `capture_mode_unavailable`, `engine_unavailable`, `degraded`, `retention_exceeded`.
- **The five spend-and-limit codes get five separate `details` shapes, never a shared one** (`NFR-API-13`: `402 insufficient_credits`, `403 entitlement_exceeded`, `403 feature_not_in_plan`, `429 quota_exceeded`, `429 daily_limit_reached`).
- Regenerating `openapi.generated.json` in the same commit is mandatory, or T3's drift check fails — the gate working as designed.

#### T8 · RED — failing tests (reviewed before T9)
- **Owner:** api-dev · **Depends on:** T7
- **Files:** `test/unit/{error-taxonomy,cursor,money-and-formats}.spec.ts`, `test/integration/{error-taxonomy-http,cursor-pagination-stability,etag-optimistic-concurrency,response-envelope,envelope-scope-and-probe-exemption}.spec.ts`

| Row | Scenario | Test |
|---|---|---|
| 1 | Trigger each taxonomy error | `error-taxonomy.spec.ts` + `error-taxonomy-http.spec.ts` — one case per code across all 27: status, `code`, remediation detail |
| 2 | Trigger all five spend-and-limit conditions | `error-taxonomy.spec.ts` · `NFR-API-13` — five codes, five distinct `remediation.kind`s, asserted pairwise non-equal |
| 3 | Permission denial | `error-taxonomy-http.spec.ts` — 403 with `details.required_permission`, **asserted not 404**; extends the existing `throws-permission-denied` route in `src/api/filters/problem.filter.http.spec.ts` |
| 4 | Page a list while inserting rows | `cursor-pagination-stability.spec.ts` — see the demonstrator note in T11 |
| 5 | Request above the limit cap | `cursor.spec.ts` — `limit=500` clamps to 200; absent clamps to 50 |
| 6 | Modify with a stale concurrency tag | `etag-optimistic-concurrency.spec.ts` — `PATCH /v1/workspaces/{id}` with a stale `If-Match` → 409 |
| 7 | Modify with a current tag | same file — success, new ETag returned |
| 8 | Any response carries the request identifier | `response-envelope.spec.ts` — see the `NFR-API-08` split below |
| 9 | Inspect a money field | `money-and-formats.spec.ts` — `{amount_usd: string, currency: "USD"}`, never a float |
| — | Envelope scope | `envelope-scope-and-probe-exemption.spec.ts` — see T10 |

- **`NFR-API-08` honesty split.** There is no OpenTelemetry in this repo: no `@opentelemetry/*` dependency, no `traceId`/`trace_id` string anywhere in `src/`, and `src/lib/telemetry/metrics.ts` is a `Logger` shim whose own comment says no metrics library exists. `req.id` is Fastify's `req-N` counter. STORY-005 (telemetry) is unmerged.
  - **Provable now:** `meta.request_id` is present on every response and is the same value `AuditInterceptor` writes to `audit_log.request_id` (`src/api/interceptors/audit.interceptor.ts:189`) and the same value the log line carries — so a support ticket resolves to one audit row and one log line.
  - **Not provable now:** that it *is* the OpenTelemetry trace identifier. **Report as pending STORY-005; do not tick "the request identifier is the trace identifier".**
  - **`X-Request-Id` (§1) is IN SCOPE**, not deferred: T10 honours an inbound `X-Request-Id`, generates one when absent, and echoes it.

#### T9 · GREEN — typed domain errors + the filter
- **Owner:** api-dev · **Depends on:** T8 (reviewed)
- **Files:** `src/api/errors/domain-errors.ts` (new), `src/api/filters/problem.filter.ts` (rewrite to D2's dual shape + `application/problem+json`), `src/api/filters/problem.filter.spec.ts` and `problem.filter.http.spec.ts` (update)
- **Acceptance:** AC1, AC2, AC3, AC4 · coding-standards §6
- The 11 existing typed exceptions in `src/tenancy/errors.ts` already carry `code`/`details` and must keep working unchanged — the new classes join them. **Moving them is out of scope.**

#### T10 · GREEN — response envelope interceptor (composition root; D8 approved)
- **Owner:** api-dev · **Depends on:** T9 · **Second engineer: dangerous-area-auditor**
- **Files:** `src/api/interceptors/response-envelope.interceptor.ts`, `src/api/decorators/no-envelope.decorator.ts`, `src/api/api.module.ts` (one added provider), `src/api/api.module.spec.ts` (extend), `src/modules/health/health.controller.ts` (marker only), plus the response-body sites measured in T0c
- **Acceptance:** AC5, AC9 · `NFR-API-08` (provable half)
- **Index 1 — the ordering argument (confirmed against `InterceptorsConsumer` and `api.module.spec.ts:193`).** NestJS runs interceptor *before* logic in registration order and *after* logic in reverse. `[Idempotency, TenantContext, Audit, Credit]` becomes `[Idempotency, ResponseEnvelope, TenantContext, Audit, Credit]`:
  - **inner to `IdempotencyInterceptor`**, so STORY-025 caches the **envelope**, not the bare body (STORY-025 AC: "the store holds the response envelope, not just a marker");
  - **outer to `AuditInterceptor`**, whose `resourceIdFromResponse(body)` reads `body.id` — wrapping into `{data: …}` first breaks audit resource-id resolution and surfaces as `AuditResourceIdUnresolvedError`.
  This **adds** to the array; it does not reorder it.
- **The exemption is keyed on a dedicated probe marker, never on `@Public()`.** Verified: `@Public()` is not probe-specific — it sits on five real API routes (`identity.controller.ts:30, 38, 49`; `oauth.controller.ts:34, 57` — sign-in and the OAuth callback) whose responses `api-specification.md` §1 requires to carry the envelope like every other response. A `@Public()`-keyed exemption would fix the probe failure and **open a spec deviation across the entire authentication surface.** Correct design:
  - a dedicated `@NoEnvelope()` marker applied to `HealthController` only (which already carries class-level `@Public()` at `health.controller.ts:11`);
  - `envelope-scope-and-probe-exemption.spec.ts` boots the **real `ApiModule`** and asserts **both** halves: `/health/live` and `/health/ready` bodies are **unwrapped**, **and** all five identity/OAuth `@Public()` routes **ARE** enveloped.
  - The two-sided assertion is the point. `test/integration/health-and-readiness.spec.ts` boots only `DbModule + HealthModule` (verified) and would stay green through either failure — silently breaking the orchestrator readiness contract that is EPIC-03's own **first** acceptance criterion.
- **Observability:** metric `nominara_api_response_envelope_total{wrapped}`; one redacted log line carrying `request_id` and `workspace_id` — never the workspace name.

#### T11 · GREEN — cursor pagination + ETag helpers
- **Owner:** api-dev · **Depends on:** T10 · **Second engineer: dangerous-area-auditor**
- **Files:** `src/api/pagination/cursor.ts`, `src/api/etag/if-match.ts`, `src/modules/workspaces/workspaces.controller.ts` + `.service.ts` (ETag on `PATCH /v1/workspaces/{id}` only)
- **Acceptance:** AC6, AC7, AC8 · `NFR-API-03`
- **Tenancy mechanism — do not get this wrong.** There is **no `DrizzleService` and no `this.db.tx()`** in this repo; `src/db/db.module.ts` says so in its own comment and provides only `PG_POOL`. The ambient transaction opened by `TenantContextInterceptor` is reached via **`currentTenantStore()!.client`** (`src/tenancy/tenant-context.ts:26`) under `withTenantContext`. A fresh `pool.connect()` inside a handler is outside the ambient context and `src/tenancy/query-guard.ts` will throw — correctly.
- **`GET /workspaces` is NOT the pagination demonstrator.** Verified: `workspaces.controller.ts:61-65` marks it `@SkipTenantContext()`; `workspaces.service.ts:303-307` runs it under `withActorContext` as a cross-tenant self-read under ADR-0001's actor-only policy class; its response is `{owned, joined}` rather than a flat collection; and its schema shipped in STORY-021.
- **Substitute demonstrator: `audit_log`** — append-only with a monotonic per-workspace `seq`, i.e. exactly a sort-key tuple. Two details pinned:
  1. **Appends go through `AuditChainService.append`, never a raw `INSERT`.** A raw insert breaks the `prev_hash`/`row_hash` chain and fails both `test/integration/audit-verify.spec.ts` and the daily verifier. (That verifier was not actually daily, or runnable, until STORY-143 — it had no handler, no schedule and no pnpm script.)
  2. **Appends serialise on `pg_advisory_xact_lock(hashtextextended(workspace_id))`** (`src/modules/audit/audit-chain.service.ts:47`). The test therefore proves **a reader interleaved with serialised appends**, not concurrent writes. That is exactly what AC7 requires — no duplicates, no skips, under insertion — but it must be **named that way** in the test name and the PR body. Claiming write concurrency the table cannot exhibit would be a false claim about the evidence.
- Applying pagination to an HTTP list route is **deferred to the first real list endpoint**. To make that an obligation rather than a hope, T11 adds a build-time assertion that any operation declared `listOf` in `@ApiContract()` uses the cursor helper and declares no `offset` parameter — **forward-guarding AC6 instead of leaving it vacuously true.**
- Cursor is an opaque base64 of the sort-key tuple. **Offset appears nowhere.**

#### T12 · Review
- **Owner:** code-reviewer + **dangerous-area-auditor** · **Depends on:** T11

**→ G24 (story gate, §7)**

---

### STORY-025 — Idempotency store and rate-limit buckets (1.5d)

#### T13 · Contract (own commit)
- **Owner:** api-dev · **Depends on:** T7
- **Files:** `contracts/common/idempotency.schema.ts` (including **D6's `Idempotency-Replayed` response header**), `contracts/common/rate-limit.schema.ts` (bucket config + the `429` detail shapes)
- **Acceptance:** AC "bucket configuration is data" · `api-specification.md` §12

#### T14 · Infrastructure — Valkey arrives
- **Owner:** api-dev · **Second engineer: dangerous-area-auditor** · **Depends on:** —
- **Files:** `docker-compose.yml` (add `valkey-cache`), `src/config/env.schema.ts` + `src/config/env.ts` (`VALKEY_CACHE_URL` added to `KNOWN_KEYS`), `.env.example`, `src/lib/cache/valkey-keys.ts`, `test/support/valkey-fixture.ts`
- **Resolves the epic's Valkey tension: pull the Valkey *cache* instance forward. This is NOT scope creep into STORY-030.** `system-architecture.md` §11 mandates **two** instances — the **queue** instance (`noeviction`, persistence on) holding BullMQ's 21 queues, which is STORY-030's, and the **cache** instance (`allkeys-lru`, persistence off) holding "L1 answer cache, token buckets, locks, idempotency keys, membership and entitlement memoisation, pub/sub", which STORY-025 and STORY-026 need and EPIC-03's acceptance criteria require. Add `valkey-cache` now; correct the `docker-compose.yml` comment ("Valkey … joins in STORY-030") to name the split. STORY-030 later adds `valkey-queue`.
- **Why the auditor, not just a reviewer:** T14 defines `VALKEY_CACHE_URL` and the key-namespace substrate that T16's `{env}:{workspace_id}:idem:{…}` boundary rests on. A cache reachable across environments, or a prefix missing `{env}`, is a cross-tenant defect one layer *below* T16 — invisible to T16's own tests. Both segments are asserted by a test over the key builder, not left to convention.
- **Key forms, fixed here so they are not invented at implementation time** (`project-structure.md` §8):
  - **Bucket configuration document — platform-wide, `{env}:global:` form**, e.g. `{env}:global:ratelimit:config`. It is not tenant data.
  - **Per-bucket counters — tenant-scoped, `{env}:{workspace_id}:…` form**, e.g. `{env}:{workspace_id}:ratelimit:{route_class}:{scope}:{id}`. **These are a tenant boundary in a store with no RLS, exactly like the idempotency key.** A counter key missing `{workspace_id}` lets one tenant's traffic exhaust another's bucket.
  - **Idempotency:** `{env}:{workspace_id}:idem:{sha256(key|user|route)}`, with the BODY hash stored INSIDE the record rather than in the key. *(Corrected during T16. The form originally written here — body included in the key — makes the `409 idempotency_conflict` case structurally unreachable: two bodies under one key land on two different records, both are claimed, and both execute. Confirmed independently by the STORY-025 code review.)*
- **Naming collision preempted:** STORY-030's title also says "idempotency keys". Those are per-queue **job** keys (`cap:{prompt}:{engine}:{run}`, `NFR-SIM-03`) — a different mechanism from `NFR-API-07`'s HTTP request keys. State it in the file header so the two are never merged.
- **Test containers:** `GenericContainer` from the already-installed `testcontainers` package — **no new test dependency.**

#### T15 · RED — failing tests (reviewed before T16/T17) — tests-first is MANDATORY
- **Owner:** api-dev · **Depends on:** T13, T14
- **Files:** `test/integration/{idempotency,idempotency-concurrent-replay,idempotency-key-scoping,rate-limit-buckets}.spec.ts`, `test/unit/rate-limit-before-credit.spec.ts`

| Row | Scenario | Test |
|---|---|---|
| 1 | Billable request with no key | `idempotency.spec.ts` — a route marked billable without `Idempotency-Key` → refused |
| 2 | Replay with the same key and body | `idempotency.spec.ts` — **byte-identical** original envelope, `Idempotency-Replayed: true` header (D6), handler invoked exactly once (spy) |
| 3 | Replay with the same key, different body | `idempotency.spec.ts` → `409 idempotency_conflict` |
| 4 | Concurrent replay while the first is in flight | `idempotency-concurrent-replay.spec.ts` — two in-flight requests, one execution; the second waits or receives the in-progress state |
| 5 | Replay after the window | `idempotency.spec.ts` — past 24 h → treated as new |
| 6 | Exhaust the per-user bucket | `rate-limit-buckets.spec.ts` — refused, `details.retry_after_ms` present |
| 7 | Exhaust the per-workspace bucket with a fresh user | `rate-limit-buckets.spec.ts` — refused (proves additivity) |
| 8 | Rate-limit a credit-spending route | `rate-limit-before-credit.spec.ts` — spy asserts `CreditGuard.canActivate` is **never invoked** |
| 9 | Change a bucket limit in configuration | `rate-limit-buckets.spec.ts` — effective with no restart |
| 10 | Any refusal | `rate-limit-buckets.spec.ts` — `X-RateLimit-Limit` / `-Remaining` / `-Reset` + `Retry-After` |
| **11** | **Cross-tenant key collision** | **`idempotency-key-scoping.spec.ts` — two workspaces, identical key, identical body: the second must NOT receive the first's cached envelope. `NFR-API-06`.** A first-class row: Valkey has no RLS, so the key *is* the isolation boundary. |

- **Row 8 honesty note.** "Nothing debited" is only half-provable today: `CreditGuard` and `CreditInterceptor` are no-op stubs and the credit ledger is EPIC-10. The provable half — the reservation path is never entered — is exactly what the epic's quality criterion asks for ("the guard order is asserted by test, including that a rate limit precedes any reservation"). **Report it as that, not as "nothing was debited".**

#### T16 · GREEN — idempotency store + interceptor
- **Owner:** api-dev · **Second engineer: dangerous-area-auditor** · **Depends on:** T15 (reviewed)
- **Files:** `src/api/idempotency/{store.ts,key.ts}`, `src/api/interceptors/idempotency.interceptor.ts` (replace the no-op), `src/api/decorators/idempotent.decorator.ts`
- **Acceptance:** AC1–AC6 · `NFR-API-07`
- Key form per T14. Enforcement is metadata-driven (`@Idempotent()` / the `@ApiContract()` idempotency flag) because **no billable route exists yet** — the mechanism and its tests are the deliverable, and later epics inherit it.
- **Observability:** metric `nominara_api_idempotency_replay_total{outcome}`; one log line on a conflict carrying `workspace_id` and the key **hash**, never the raw key.

#### T17 · GREEN — token buckets + `RateLimitGuard`
- **Owner:** api-dev · **Second engineer: dangerous-area-auditor** · **Depends on:** T16
- **Files:** `src/api/rate-limit/{buckets.ts,token-bucket.ts,route-class.ts,defaults.ts}`, `src/api/guards/rate-limit.guard.ts` (replace the no-op)
- **Acceptance:** AC7–AC11 · **all 13 route classes from `api-specification.md` §12**, each limit matching the reference **exactly, not a plausible neighbour**. The story's own AC lists 9 — the reference beats the story; we implement 13 and the story text goes on the hand-carried list.
- Additive evaluation: every applicable bucket must have capacity; exhausting any one refuses.
- **`src/api/api.module.ts` is NOT touched** — the slot already exists in the right place.
- **Observability:** metric `nominara_api_rate_limit_refusal_total{route_class,bucket}`; one log line naming the exhausted bucket.

#### T18 · Review
- **Owner:** code-reviewer + **dangerous-area-auditor** · **Depends on:** T17

**→ G25 (story gate, §7)**

---

### STORY-026 — Realtime gateway, event catalog, SSE helper, backpressure (1.5d)

Upstream (STORY-018 workspace guard, STORY-024) satisfied once STORY-024 merges.

#### T19 · Contract — the event catalog (own commit)
- **Owner:** api-dev · **Reviewer: code-reviewer** · **Depends on:** T7
- **Files:** `contracts/events/*.schema.ts` — all 19 events from `api-specification.md` §11
- **Acceptance:** AC5 · vocabulary lint (`run.*` / `capture_runs`, never "simulation"; "pub/sub fan-out" is an explicitly permitted use of the word)
- **AC10 (invalidation keys) is DEFERRED — named blocker (D4).** `api-specification.md` §11's table has **no invalidation-key column**; only the prose beneath it claims "every event maps to a precise TanStack Query invalidation key". There is nothing to transcribe, and inventing 19 keys would make this repo the source of a contract it does not own — the keys belong to `nominara-app`'s `lib/query/` (`project-structure.md` §3: "TanStack keys, staleTime table, event→invalidation map"). **Do not report AC10 as met.** The spec gap is hand-carried.
- 19 payload schemas would otherwise be the largest unreviewed contract surface in the epic — hence a named reviewer on a contract task.

#### T20 · RED — failing tests (reviewed before T21–T23) — tests-first is MANDATORY
- **Owner:** api-dev · **Depends on:** T19
- **Files:** `test/integration/{realtime-room-authorization,realtime-revalidation,realtime-cross-instance,sse-heartbeat-and-deadline,gateway-has-no-http-routes}.spec.ts`, `test/unit/{realtime-coalescing,realtime-backpressure,realtime-event-catalog,realtime-guard-parity,membership-cache-single-instance}.spec.ts`, and extend the existing `test/integration/gateway-shutdown-draining.spec.ts`

| Row | Scenario | Test |
|---|---|---|
| 1 | Join a room as a member | `realtime-room-authorization.spec.ts` — join succeeds, events received |
| 2 | Join a room for a workspace the user is not a member of | same — disconnected with close code **4403** (`system-architecture.md` §9) |
| 3a | Remove the member mid-connection — `member.changed` path | `realtime-revalidation.spec.ts` — socket closes **on the event**; timers stubbed out so the timer cannot carry the assertion |
| 3b | Remove the member mid-connection — 60 s re-validation path | same file, separate test — event suppressed, socket closes on the timer |
| 4 | Broadcast from one instance with the client on another | `realtime-cross-instance.spec.ts` — two gateway instances, one Valkey, no sticky session |
| 5 | Emit many progress events rapidly | `realtime-coalescing.spec.ts` — ≤ 1 `run.progress` per **750 ms** per run |
| 6 | Overwhelm a slow client | `realtime-backpressure.spec.ts` — 20 msg/s cap, one `resync` directive, **no backlog** |
| 7 | Open a stream and idle | `sse-heartbeat-and-deadline.spec.ts` — `: ping` every **15 s**, terminal event at **60 s** (`NFR-API-09`) |
| 8 | Drain the gateway | extend `gateway-shutdown-draining.spec.ts` — `server.draining` carries `reconnect_after_ms`, jitter asserted |
| 9 | Inspect the catalog | `realtime-event-catalog.spec.ts` — every §11 event typed and present in the generated client. **Invalidation-key half deferred (D4)** |
| — | Guard parity | `realtime-guard-parity.spec.ts` — the socket path invokes the **same guard classes from DI** as the HTTP path |
| — | No HTTP surface | `gateway-has-no-http-routes.spec.ts` — the gateway app's router exposes **zero** HTTP routes |
| — | Single cache instance | `membership-cache-single-instance.spec.ts` — `ApiModule` resolves the **same** `MembershipCacheService` instance through both paths |

- **Row 3 is split deliberately.** The story's own wording ("closes on the next re-validation **or** on the change event") would let the AC pass on the timer alone, leaving untested the path that closes the revocation window from 60 seconds to immediate.

#### T21 · GREEN — room authorisation through the same guard chain (security-critical wiring)
- **Owner:** api-dev · **Second engineer: dangerous-area-auditor** · **Depends on:** T20 (reviewed)
- **Files:** `src/gateway/room-authorization.service.ts`, `src/gateway/ws-execution-context.ts`, `src/gateway/realtime.gateway.ts`, `src/gateway/gateway.module.ts`, `src/tenancy/tenancy-access.module.ts` (new, controller-free), `src/modules/workspaces/workspaces.module.ts`
- **Acceptance:** AC1, AC2, AC3
- **The gateway must NOT import `WorkspacesModule`.** Verified: `workspaces.module.ts` declares `WorkspacesController` and imports `IdentityModule`, which declares `IdentityController` **and** `OauthController` (`identity.module.ts:25`). `src/gateway.ts` boots `RealtimeModule` as a `NestFastifyApplication` with **no** `APP_GUARD`, no `TenantContextInterceptor`, no `AuditInterceptor` and no `ProblemFilter` — all of those live in `ApiModule`. Importing `WorkspacesModule` would mount an **unauthenticated, unaudited tenant-mutation surface on `GATEWAY_PORT`**: workspace create/update, member role changes, invitations, and the OAuth callback. Locked by `gateway-has-no-http-routes.spec.ts`.
- **`@Global()` does not self-register.** A `@Global` module must still be imported **once** somewhere in the graph before its exports become ambient, and `RealtimeModule` imports nothing today. **`gateway.module.ts` must import `DbModule` AND `TenancyAccessModule` explicitly**, or the gateway fails to resolve `PG_POOL` at boot.
- **`TenancyAccessModule` must be the sole provider, and `WorkspacesModule` must consume it.** If the new module *provides* `MembershipService` + `MembershipCacheService` while `workspaces.module.ts:24-27` still provides them, any process loading both gets **two `MembershipCacheService` instances — two in-memory `Map`s**. `WorkspacesService`'s synchronous invalidation on `removeMember`/`updateRole` would clear one and leave the other serving a removed member for up to 30 s: precisely the revocation leak `security-and-tenancy.md` §7 and EPIC-02's risk table exist to prevent. Required:
  1. `TenancyAccessModule` provides and exports `MembershipService` + `MembershipCacheService`;
  2. `WorkspacesModule` **imports and re-exports** `TenancyAccessModule` instead of declaring them — one instance per process by construction;
  3. `membership-cache-single-instance.spec.ts` asserts identity of the instance through both paths.
  - Sufficiency verified: `MembershipService`'s only constructor dependency is `MembershipCacheService` (`membership.service.ts:26`), which takes none.
- **Secret-surface note, stated precisely.** `env.schema.ts` already makes `WORKSPACE_DEK_WRAPPING_KEY`, `OAUTH_STATE_SECRET`, `CSRF_SECRET` and `AUTH_TOKEN_ED25519_PRIVATE_KEY` required for **every** process, and `src/gateway.ts` already calls `loadEnv()` — so the hazard is not which variables must be *set*. It is which secret material the gateway would **construct and hold**: importing `WorkspacesModule` runs its `DEK_PROVISIONER` factory, materialising a `LocalDekProvisioner` holding the unwrapped DEK-wrapping key, plus `SessionService`'s token-minting seam, inside a process that needs neither. The controller-free module avoids both.
- **Guard reuse.** All three guards read `context.switchToHttp().getRequest()` (`auth.guard.ts:84`, `workspace.guard.ts:72`, `rbac.guard.ts:52`). **Synthesise an `ExecutionContext` from the socket handshake and invoke the same guard instances resolved from DI, unmodified.** Rejected alternative: making the guards `context.getType()`-aware — that edits `auth.guard.ts`/`workspace.guard.ts`/`rbac.guard.ts`, files owned by STORY-014/018/019. **Scope signal.**
- **Observability:** metric `nominara_gateway_room_join_total{outcome}`; one log line on a 4403 carrying `workspace_id`, never the workspace name.

#### T22 · GREEN — adapter, coalescing, backpressure, resync, `member.changed` (D7, D9)
- **Owner:** api-dev · **Depends on:** T21, T14
- **Files:** `src/gateway/valkey-adapter.ts`, `src/gateway/backpressure.ts`, `src/gateway/emitters/realtime-emitter.service.ts`, `src/gateway.ts`, `src/lib/cache/realtime-publisher.ts`, `src/modules/workspaces/workspaces.service.ts`
- **Acceptance:** AC4 (no sticky sessions), AC6 (750 ms coalescing), AC7 (resync, 20 msg/s cap), AC9 (draining + jitter)
- **`member.changed` is wired (D7).** §11 lists it as emitted by **`api`**, and `MembershipService`/`WorkspacesService` are the only producers in the codebase — verified: the string `member.changed` appears **nowhere** in `src/` or `test/` today. Emitted on member role change and removal. **Scope signal (a STORY-021 file) recorded in the PR body.**
- **The api process publishes through `@socket.io/redis-emitter` (D9).** Do **not** hand-roll `@socket.io/redis-adapter`'s channel format — a private wire format that drifts on the adapter's next minor is a silent realtime outage. Do **not** stand up a socket.io server in the api process merely to emit.
- Worker-side publishing of `run.*`, `aux.*`, `task.*`, `displacement.*`, `credits.*` etc. stays **deferred** — those workers do not exist yet (EPIC-04+). Define the typed emitter; leave the worker publish path to the capture/rollup epics.
- **Observability:** metric `nominara_gateway_coalesced_events_total{event}`; one log line on each `resync` directive.

#### T23 · GREEN — SSE helper, with the interceptor exemption designed now
- **Owner:** api-dev · **Depends on:** T20 (reviewed)
- **Files:** `src/api/streaming/sse-stream.ts`, `src/api/decorators/streaming.decorator.ts`
- **Acceptance:** AC8 · `NFR-API-09`
- **The trap, designed out rather than inherited.** Writing to `FastifyReply.raw` and returning `undefined` makes `lastValueFrom(next.handle())` reject with `EmptyError` on any tenant-scoped route — **rolling back the transaction** — and leaves the envelope wrapping `undefined`. It will not manifest in this epic because STORY-079 owns the actual streaming endpoint, **which is exactly why the exemption must be built now**: a `@Streaming()` decorator that `ResponseEnvelopeInterceptor`, `IdempotencyInterceptor` and `TenantContextInterceptor` each honour, with a unit test per interceptor asserting the skip. Otherwise STORY-079 inherits a rollback bug with no owner.
- Write to `reply.raw` rather than Nest's `@Sse()` observable binding: heartbeat and deadline must be explicit and directly testable.
- The Visibility Scan endpoint itself (`api-specification.md` §9) is STORY-079, **not** this story. Only the helper ships here.

#### T24 · Regenerate the client with event types
- **Owner:** api-dev · **Depends on:** T22, T4
- **Files:** `contracts/openapi.generated.json`, `client/**`
- **Acceptance:** STORY-023 AC5, STORY-026 AC5

#### T25 · Review
- **Owner:** code-reviewer + **dangerous-area-auditor** · **Depends on:** T23, T24

**→ G26 (story gate, §7)**

---

## 6. Commit and branch shape

Per KAD-05 and README rule 3, the contract-first rule wins over a literal reading of "one commit per story". **Ten commits:**

```
chore: move the fastify override to pnpm-workspace.yaml and approve builds   (T0b)
chore: extract configureApp and add the /v1 prefix across the test suite     (T0c)
STORY-023: add the shared envelope, pagination and problem-details contracts (T1)
STORY-023: generate, drift-check and publish the OpenAPI contract pipeline   (T2–T6)
STORY-024: add the 27-code error taxonomy, remediation and money contracts   (T7)
STORY-024: add typed domain errors, the response envelope, cursor pagination and ETags (T8–T12)
STORY-025: add idempotency and rate-limit contracts                          (T13)
STORY-025: add the idempotency store and additive rate-limit token buckets   (T14–T18)
STORY-026: add the realtime event catalog contracts                          (T19)
STORY-026: add room authorisation, the Valkey adapter, backpressure and SSE  (T20–T25)
```

- Branch: `epic-03-api-platform-and-contracts`.
- **No `Co-Authored-By` trailer or any AI attribution. This overrides any default behaviour.**
- **Nothing is pushed and no PR is opened unless the user explicitly asks.**
- RED tests are authored and **watched failing for the stated reason** before the implementation is written; they land in the story's implementation commit.

### The PR body must carry all of this

1. **What changed** · **Acceptance criteria met** (checklist with requirement IDs) · **How to verify** · **Rollout and rollback** (specific, not "standard deploy").
2. **The single-branch/single-PR shape is a knowing deviation from `development-workflow.md` §7 and the one-story-per-branch convention** — recorded verbatim, with the reason (user instruction). An undocumented deviation from a normative reference is how a spec forks from the code.
3. **All five dependencies, each with its approving decision** — README rule 7 governs dependency additions, and D3/D9 are the record:
   - `openapi-typescript` (devDependency) — **D3**
   - `openapi-fetch` (**runtime dependency of the published client; crosses into `nominara-app`**) — **D3**
   - `ioredis` — **D3**
   - `@socket.io/redis-adapter` — **D3**
   - `@socket.io/redis-emitter` — **D9**
4. **Scope signals raised:** STORY-026 touching `src/modules/workspaces/workspaces.service.ts` (a STORY-021 file, D7); the seven new directories plus the client package (OQ-3); the rejected alternative of making the guards `context.getType()`-aware.
5. **Every claim that is half-proven, named as such** — `NFR-API-08`'s trace half, STORY-025 row 8's "nothing debited", STORY-026 AC10, STORY-023 AC6/AC10.

---

## 7. Story gates — G23, G24, G25, G26 (hard, numbered, non-optional)

With one branch and one PR, three of four stories would otherwise get **no review boundary at all**. Each gate is a task in its own right and blocks the next story's contract commit.

Each gate runs, in order:

1. The **full twelve-item review checklist** from `coding-standards.md` §11, item by item, **in writing** — not "reviewed".
2. `pnpm --config.verify-deps-before-run=false lint`
3. `pnpm --config.verify-deps-before-run=false typecheck` — must be **green** (requires T0b)
4. `pnpm --config.verify-deps-before-run=false test:unit`
5. `pnpm --config.verify-deps-before-run=false test:integration` (with the two colima exports)
6. `pnpm --config.verify-deps-before-run=false contracts:check` — exists from G23 onward
7. **Regressions distinguished from pre-existing failures by proof** (stash, or check out the base commit) — never by assertion.
8. **Stop for the user's manual verification.** Do not roll from one story into the next without checking in.

**Gate-specific additions:**

- **G24, G25 and G26 also run `pnpm test:isolation`** as regression. There is no schema change, so the suite is not *required* by the change-type table — but "not required" and "skipped on a change to the tenant-transaction chain, the Valkey key namespace, or the realtime isolation boundary" are different claims, and only one of them is honest.
- Every gate states plainly which documented gates have **no runner in this repo**: `test:golden`, `test:e2e`, `test:perf`, the scoring golden-set regression, and the concurrent-debit test.

**The four gates that cannot be talked past, mapped for this epic:**

| Gate | Status |
|---|---|
| Isolation suite | Runner exists. Not required by change type (no schema/RLS change); **run anyway at G24–G26 as regression, and say so.** |
| Scoring golden-set regression | **No runner** (`test/golden/`, `src/lib/scoring` do not exist). Not applicable. Say so. |
| Concurrent-debit test | **No runner** — no credit ledger until EPIC-10. STORY-025 row 4 is its nearest analogue and is **not a substitute**. Name it. |
| Contract drift check | **This epic builds its runner** (T3). Green from G23 onward, or the build fails. |

---

## 8. Cross-repo sequencing

- **No frontend task exists in this epic.** Neither `nominara-app` nor `nominara-web` is cloned here, so no `frontend-dev` work is planned and no frontend task can guess a response shape.
- This epic **is** the backend-first step for everything downstream. `@nominara/client` is the cross-repo integration point and **cannot be published from this machine** (T5). EPIC-12 / STORY-086 stay blocked on that, correctly.
- **`openapi-fetch` crosses the repository boundary** as a runtime dependency of the published client, landing in `nominara-app`'s dependency tree (D3) — falsifying `project-structure.md` §6's "exactly two packages cross a repository boundary".
- `NFR-REPO-03` (previous-minor support) and `NFR-REPO-05` (contract tests against a deployed preview) are cross-repo mechanisms with no local equivalent. **Do not claim them.**
- `/Users/sarwaralam/Desktop/Projects/ElegantTech/nominara/client/` is an empty directory and is **not** a planned clone — the app repo is `git@github.com:Nominara/nominara-app.git` and would be cloned as `app/`. The generated client package goes at `api/client/` (OQ-4, settled).

---

## 9. Parallelisable groups

One branch limits real parallelism; these are file-disjoint sets, not a promise of concurrency.

- **Group A:** T0a → T0b → {T0c ∥ T0d}
- **Group B:** T1 → T2 → T3 → {T4 ∥ T6} → **G23**; T5 blocked
- **Group C:** T7 → T8 → T9 → T10 → T11 → T12 → **G24**
- **Group D:** T13 → T14 → T15 → T16 → T17 → T18 → **G25**
- **Group E** (file-disjoint from D — `src/gateway/**`, `src/api/streaming/**`, `contracts/events/**` vs `src/api/idempotency/**`, `src/api/rate-limit/**` — **except both need T14**): T19 → T20 → {T21 → T22 ∥ T23} → T24 → T25 → **G26**

Sequence **T14 before either D or E proceeds past its RED task.**

---

## 10. Data changes

**None.**

Verified: no story in this epic touches `src/db/schema/**`; `Nominara-Dev-Docs-main/schemas/` defines no idempotency table and no rate-limit table; the idempotency store, token buckets, locks and pub/sub all live on the Valkey cache instance per `system-architecture.md` §11.

Therefore — and **state this in the PR body explicitly, because silence on a schema question reads as an omission**:

- no migration pair required;
- no expand/contract phase decision;
- **`pnpm db:rls-generate` is NOT required**, and `db:drift-check` / `db:rollback` are not applicable;
- no new table, so no `src/db/conventions.ts` isolation decision.

**This inverts only if OQ-5 is reopened toward a `platform_config` table** (it is settled toward Valkey — see §12). A new table would need an explicit `GLOBAL_TABLES` / `TENANT_SCOPE_COLUMN` entry or the RLS generator throws — **that throw is the feature; do not route around it.**

---

## 11. Dangerous-area exposure and reviewer routing

The four dangerous areas are **RLS policies and tenant context · the credit ledger and wallet · the parser · the scoring functions.** Reasoned per story, not assumed.

| Story | Exposure | Routing |
|---|---|---|
| **023** | None of the four. The pipeline touches no tenant data path. | code-reviewer (T6). Note: the contract drift check **is** one of the four un-talk-past-able gates, and this story builds its runner. |
| **024** | **Tenant context — YES.** T10 inserts an interceptor into the same chain as `TenantContextInterceptor`; its position determines whether the tenant transaction is still open when the envelope applies. T11 queries RLS-enforced tenant tables through `currentTenantStore()!.client`. | **dangerous-area-auditor** on T10, T11, T12. **Tests-first mandatory.** `test:isolation` at G24. |
| **025** | **Tenant context — YES; credit-ledger adjacent.** The idempotency store is a cache with **no RLS**; the Valkey key is the entire isolation boundary, and T14 defines its substrate one layer below T16. The rate-limit counters are likewise tenant-scoped keys in an RLS-free store. The interceptor is also the mechanism that makes a billable retry non-double-charging, and its ordering relative to `CreditGuard`/`CreditInterceptor` is a correctness requirement. | **dangerous-area-auditor** on **T14**, T16, T17, T18. **Tests-first mandatory.** Row 11 is the direct `NFR-API-06` test. |
| **026** | **Tenant context — YES.** `ws:{workspace_id}` room membership is the realtime isolation boundary; a mis-authorised join streams another tenant's events indefinitely. Periodic re-validation is the revocation path. Valkey pub/sub channels are cross-tenant unless namespaced. T21's wiring could either mount an unauthenticated mutation surface **or** fork the membership cache into two instances. | **dangerous-area-auditor** on T21, T22, T25. **code-reviewer on T19** (19 payload schemas). **Tests-first mandatory.** |

**On the dangerous areas, tests-first is mandatory, not preferred:** write the failing test first, **watch it fail for the stated reason**, and have the change reviewed by someone who did not author it. A test that passes before the implementation exists is testing nothing.

---

## 12. Blocked / deferred

1. **T5 — client publish to private GitHub Packages.** No `.github/` directory, no CI, no `@nominara` registry access, no OIDC trust, no secrets. **AC6 / `NFR-REPO-02` not met.**
2. **STORY-023 AC10 / `NFR-REPO-03`** ("the previous minor is supported, exercised by a contract-test matrix") — requires a *published* previous minor, so requires (1). Local proxy per OQ-8. **Ship partial and name the unproven half.**
3. **STORY-026 AC10 — invalidation keys.** Blocked on the `api-specification.md` §11 specification gap (D4). **Not met.**
4. **`NFR-API-08`'s trace half.** Blocked on STORY-005 (telemetry, unmerged). The correlation half ships in T10.
5. **`pnpm typecheck` green** — blocked on T0b, a user action.
6. **Worker-side realtime publishing** — deferred to the capture/rollup epics. **`member.changed` is NOT covered by that deferral** (D7, T22).
7. **Applying cursor pagination to an HTTP list route** — deferred to the first real list endpoint; the build-time `listOf`/no-offset obligation ships in T11.
8. **Story status transitions and every spec fix** live in `Nominara-Dev-Docs-main/`, which has **no `.git`**. Make the edits; they must be hand-carried.

---

## 13. Hand-carried spec fixes (the docs snapshot has no `.git`)

Make each edit in `Nominara-Dev-Docs-main/`, then tell the user it must be carried to the docs repo by hand. **Do not silently skip these — a specification that forks from the code is worse than none.**

1. **D2** — `api-specification.md` §1 and §2: the dual RFC 9457 + `error` shape, and the `application/json` (§1 line 4) vs `application/problem+json` (§2) contradiction.
2. **The guard-order diagram bug** in `references/system-architecture.md` §2, `references/security-and-tenancy.md` §5 **and `epics/EPIC-03-api-platform-and-contracts.md`'s own "The global chain" block** — all three show `CreditGuard → RateLimitGuard` while their own prose says a rate-limited request must never reach the credit guard. **The code is right (STORY-022-E-1); fix the docs, never the code.**
3. **STORY-025's acceptance criteria list 9 route classes; `api-specification.md` §12 defines 13.** Reference beats story: we implement 13 and the story text is corrected.
4. **STORY-024's error taxonomy count** — 27 codes across 24 table rows; make the multi-code rows explicit.
5. **`api-specification.md` §11 has no invalidation-key column** while the prose beneath it claims every event maps to one (D4).
6. **`project-structure.md` §6** — "Exactly **two** packages cross a repository boundary" becomes false once `openapi-fetch` is a runtime dependency of the published client (D3).
7. **`project-structure.md` §2** — add the seven new directories and the `client/` package (OQ-3), and resolve the §2/§6 gap about where the client package lives (OQ-4).
8. **`docker-compose.yml`** — correct the "Valkey … joins in STORY-030" comment to name the cache/queue split (T14). *(Repo file — committable here, unlike the rest of this list.)*
9. **Story status transitions** for STORY-023, 024, 025, 026: `Backlog → In Progress` at start, `→ Done` at completion.

---

## 14. Open questions — settled answers and the remainder

### Settled

| # | Question | Settled answer |
|---|---|---|
| **OQ-1** | Who owns the `/v1` prefix? | **D1** — the app owns it; ships now via `configureApp()`. `exclude` takes `(string \| RouteInfo)[]`, not a RegExp. |
| **OQ-2** | The error wire shape | **D2** — RFC 9457 members + an `error` extension member; both spec sections fixed together. |
| **OQ-3b** | `contracts/registry.ts` vs `@ApiContract()` | **D5** — the decorator wins; the registry is dropped; the coverage test is renamed and rewritten, not deleted. |
| **OQ-4** | Where the client package lives | **`api/client/`.** `project-structure.md` §2's tree shows no `client/` under `nominara-api` while §6 says the client is published *by* `nominara-api` — a gap in the reference, added to the hand-carried list. The empty `nominara/client/` directory is **not** a planned clone. |
| **OQ-5** | Rate-limit bucket configuration home | **A Valkey-held config document — no schema change.** Committed defaults in `src/api/rate-limit/defaults.ts`, read on a short TTL with fallback, satisfying "a limit change needs no redeploy". **Key forms are fixed in T14:** the config document is platform-wide (`{env}:global:ratelimit:config`); the per-bucket **counters** are tenant-scoped (`{env}:{workspace_id}:ratelimit:…`) and are a tenant boundary in a store with no RLS, exactly like the idempotency key. |
| **OQ-6** | Adding a provider to `api.module.ts` | **D8** — approved at index 1. |
| **OQ-8** | Proving previous-minor support with nothing published | **Committed `contracts/baseline/openapi.previous-minor.json` proxy**: generate a client from it into a temp directory and type-check a fixture consumer against both. **Proves shape compatibility only; ship partial and name the unproven half** (the published matrix). |
| **OQ-10** | The idempotent-replay wire shape | **D6** — an `Idempotency-Replayed: true` response header; the body stays byte-identical. |
| **OQ-11** | Scope of the api-side `member.changed` emit | **D7** — wire it; record the scope signal in the PR body. |
| **OQ-12** | Lint-rule coverage gap | **Extend the `no-request-handler-network-call` glob in `eslint.config.js` to `src/gateway/**` and `src/contracts/**`.** Currently it covers only `src/modules/**/*.{controller,service}.ts` and `src/api/**/*.ts`, so most of this epic's new code would land outside EPIC-03's own lint-enforced quality criterion. **This tightens a gate, never relaxes one.** |
| **OQ-D1/D3/D4/D5/D6/D8/D9** | Dependencies and environment | **D3, D9** — see §2. |
| **OQ-D7** | `@socket.io/redis-emitter` | **D9** — reopened and approved; T22 retired the premise it was deferred on. |

### Remaining

- **OQ-3 · Seven new directories `project-structure.md` §2 does not name, plus the package.** `src/contracts/`, `src/api/errors/`, `src/api/pagination/`, `src/api/etag/`, `src/api/idempotency/`, `src/api/rate-limit/`, `src/api/streaming/`, and top-level `client/`; plus the files `src/tenancy/tenancy-access.module.ts`, `src/api/configure-app.ts`, `src/lib/cache/`. **Scope signals raised, not resolved.** Recommendation: accept all and add them to §2 in the hand-carried pass (item 7 of §13). Related smell: taxonomy errors would live in `src/api/errors/` while `src/tenancy/errors.ts` already holds 11 typed exceptions — **do not move the existing ones**; note consolidation as a future story.
- **OQ-7 · Possible specification defect, surfaced not resolved.** `system-architecture.md` §11 places idempotency keys on the **cache** instance (`allkeys-lru`, persistence **off**) while asserting "everything on the cache instance is re-derivable, which is why it needs neither `noeviction` nor persistence". **An idempotency key and its cached response envelope are NOT re-derivable** — evicting one turns a replay into a second execution of a billable action, which is the exact loop `NFR-API-07` exists to break. Does not block T16 locally.

---

## 15. Risks and assumptions

- **The largest risk: four of five acceptance surfaces have almost nothing to attach to.** Only `health`, `identity`, `oauth` and `workspaces` have real routes; there are no billable routes, no HTTP list endpoint worth paginating, one mutable-config endpoint, no credit ledger, and no telemetry. **The mechanisms are the deliverable**, and the tests must prove the mechanism, not a domain behaviour. Where a scenario is half-provable — STORY-025 row 8, `NFR-API-08`, STORY-026 AC10, STORY-023 AC6/AC10 — **name the provable half rather than letting the row read as green.** The real acceptance test of this epic is its own Definition of Done: a later domain endpoint can be added with **no** platform changes.
- **T0c is the epic's highest-leverage task and its largest mechanical change** — 117 `inject()` sites, 12 app-assembly sites, 7 duplicated `registerCookiePlugin` calls, and the seam that makes D1 real rather than cosmetic. It lands as its own commit before STORY-023 so a mechanical rename never rides inside the pipeline commit.
- **Three silent-failure classes are explicitly designed against, and each was introduced by a mitigation for something else:** an envelope exemption keyed too broadly (would have deviated the whole auth surface from §1); a coverage gate exempting `@Public()` (would have let all five identity/OAuth routes vanish from the published client with every gate green); and a duplicated `MembershipCacheService` (would have reopened a 30-second revocation leak). **All three are locked by tests that assert BOTH sides of the boundary** — a one-sided assertion is what let each slip through in the first place.
- **T21's module wiring remains where a mistake would be worst and least visible.** A gateway that mounts `WorkspacesController`, or an `ApiModule` with two membership caches, looks identical in every existing test.
- **D5's cost is real and accepted:** `contracts:generate` now depends on the app booting, so a boot failure and a contract failure become the same red. The committed fixture env in T3 is what keeps that from becoming a developer-environment lottery.
- **The worked example is an existing endpoint (`POST /v1/workspaces`), never a new one.** Inventing a domain endpoint is out of the epic's scope ("Domain endpoints. This epic delivers the platform they are built on.").
- **Assumption:** the gateway gains `DbModule` + `TenancyAccessModule` and therefore Postgres reach for membership checks. That widens the gateway's data reach; if a leaner surface is wanted, that conversation happens before T21, not during it.
- **Estimate:** 6.5 days of story estimate, plus T0 (~1.0d, dominated by T0c) and four story gates.
- **No threshold, gate or assertion is relaxed anywhere in this plan.** The 750 ms coalescing window, the 20 msg/s per-socket cap, the 15 s / 60 s SSE timings, the 200 / 50 pagination bounds, the 24 h idempotency window, close code 4403, and all 13 rate-limit route classes are taken from the reference **exactly**, not from a plausible neighbour. **If a gate is wrong, that is a story.**