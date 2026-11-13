# Security & Multi-Tenancy

Isolation is the platform's load-bearing property. Competing brands are frequently tracked inside the same infrastructure, and an agency's two clients may be direct competitors. The isolation boundary therefore lives **inside PostgreSQL**, not in application code, so that an application defect cannot produce a cross-tenant read or write.

---

## 1. Entity hierarchy

```
users (global identity, owns no data)
  └─ workspace_members (role, status, project_scope)   ← the ONLY bridge between identity and data
       └─ workspaces (TENANT ROOT — the RLS boundary, owns billing and residency)
            ├─ projects
            │    ├─ tracked_prompts → answer_captures → mention/citation facts → displacement_events
            │    ├─ competitors, goals, project_source_index
            │    ├─ aux_audits → aux_findings
            │    ├─ tasks → task_events → milestones
            │    └─ geo_alignments → content_chunks, semantic_nodes, patches
            ├─ tool_runs
            ├─ gsc_connections, attribution_configs (envelope-encrypted credentials)
            ├─ share_tokens, brand_themes, custom_domains
            ├─ subscriptions, credit_wallets, credit_ledger, usage_counters, invoices
            └─ audit_log (hash-chained, per-tenant chain)
```

**R1.** A `users` row never carries data. Every data row carries `workspace_id`. Authorisation is therefore always the same question: *does this session have a live membership in this workspace, at a sufficient role, within scope?*

**R2.** **Twelve tables** are global by design, each named and reviewed here (owner decision 91 raised this from ten): `users`, `user_credentials`, `plans`, `engines`, `credit_packs`, `platform_metrics`, `niche_reports`, `aux_rule_catalog`, `task_generation_rules`, `engine_health`, and the versioned business taxonomy and its curated peers, `business_categories` and `category_peers` (`SELECT` only for every runtime role; rows change only by a migration, STORY-189). **The twelve are not the whole allow-list:** `GLOBAL_TABLES` in `src/db/conventions.ts` holds **25** entries as of migration 0190, because thirteen more were added by their own stories for platform, session or owner-only state (`purge_failures`, `webauthn_challenges`, `sessions`, `refresh_tokens`, `oauth_authorization_requests`, `email_otp_codes`, `email_otp_requests`, `stripe_webhook_events`, `audit_chain_marks`, `email_suppressions`, `legal_holds`, `purge_runs`, `subject_erasure_queue`). `ISO-06` asserts the census (96 tables, 71 tenant, 25 global, as of migration 0202, batch 10). Every other table has `workspace_id uuid NOT NULL` and a generated RLS policy. CI asserts this — a migration adding a table without `workspace_id` fails unless the name is in the `GLOBAL_TABLES` allow-list.

**"Global" is a statement about scope, not about access.** `users` and `user_credentials` hold no tenant rows, but they are still restricted — by `GRANT`, which is the correct tool for "only the auth path may read this". `nominara_worker`, `nominara_report`, and `nominara_portal` have **no privilege at all** on `user_credentials`. RLS would have been the weaker control there, because it would imply the table was reachable and merely filtered.

**Every `GLOBAL_TABLES` entry is a catalog, a build-time artifact, or global identity. No table in the schema is writable by an unauthenticated request.** That invariant removes an entire class of reasoning from every future RLS review, and it is worth preserving deliberately.

**`email_suppressions` (STORY-178, owner decision 2026-10-26) is global by decision.** A hard bounce is a property of the address and the sending reputation it protects is shared by every workspace, so one suppression covers all of them. The table holds no tenant data and no address — only the peppered HMAC-SHA256 of the normalised address (`OTP_EMAIL_HASH_PEPPER`), the kind, the provider event id and timestamps — and it is written only by `POST /webhooks/resend` **after** the Svix signature over the raw body verifies (the same class of signed public route as `POST /webhooks/stripe`). `nominara_app` may `SELECT` and `INSERT`, `nominara_worker` may `SELECT`; lifting a suppression and marking it fanned out are owner-connection (operator) writes only (`pnpm email:unsuppress`; no API route in D1). Two consequences, both accepted by the decision: rotating the pepper silently voids every suppression (the addresses are not stored, so they cannot be re-hashed), and the API and every worker that sends must run the **same** pepper; and a workspace can learn that an address is suppressed somewhere on the platform by adding it as a recipient and reading the delivery reason or the notification.

## 2. Database roles

```sql
-- Migration/DDL owner. Owns all objects. NEVER used by a running service.
CREATE ROLE nominara_owner NOINHERIT NOLOGIN;

-- Runtime roles. RLS applies to all of them (see FORCE ROW LEVEL SECURITY, §3).
CREATE ROLE nominara_app     LOGIN NOINHERIT CONNECTION LIMIT 400;  -- src/api, src/gateway
CREATE ROLE nominara_worker  LOGIN NOINHERIT CONNECTION LIMIT 300;  -- src/workers/*
CREATE ROLE nominara_report  LOGIN NOINHERIT CONNECTION LIMIT 40;   -- read-only, replica only
CREATE ROLE nominara_portal  LOGIN NOINHERIT CONNECTION LIMIT 60;   -- share-token portal, read-only

-- Definer owners. NOLOGIN, so nobody connects as them; NOBYPASSRLS (ISO-07); no role is a member of them (ISO-24, ISO-28).
-- nominara_share_lookup owns app.share_token_by_hash (ADR-0002, migration 0112).
-- nominara_maintenance owns the three count-only app.maintenance_* functions (ADR-0004, migration 0160).
-- nominara_platform_agg owns app.refresh_platform_metrics and app.apply_benchmark_membership (ADR-0005, migration 0190).
CREATE ROLE nominara_share_lookup NOLOGIN NOINHERIT NOBYPASSRLS;
CREATE ROLE nominara_maintenance  NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE nominara_platform_agg NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;

-- Break-glass. Dual approval + a 60-minute TTL credential from Secrets Manager.
CREATE ROLE nominara_breakglass LOGIN NOINHERIT BYPASSRLS CONNECTION LIMIT 2;

GRANT USAGE ON SCHEMA app, public TO nominara_app, nominara_worker, nominara_report, nominara_portal;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nominara_app, nominara_worker;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO nominara_report, nominara_portal;

REVOKE ALL ON audit_log FROM nominara_app, nominara_worker;   -- append-only, see §7
GRANT INSERT, SELECT ON audit_log TO nominara_app, nominara_worker;

REVOKE ALL ON user_credentials FROM nominara_worker, nominara_report, nominara_portal;
```

- **No service role has `BYPASSRLS`.** `nominara_breakglass` exists solely for incident response; its use emits an **alert email to `ALERT_EMAIL_TO`** and an immutable audit record, and its credential is time-boxed. (Owner decision 2026-10-15: operational alerts are email through Resend; there is no separate paging service. **Not built:** nothing in code emits the break-glass alert yet — [STORY-010](../stories/data/STORY-010-database-roles-and-pgbouncer.md).)
- **`nominara_maintenance`** exists so the nightly integrity checks (orphan scan, default-partition row count, vector-recall check) can count rows across every workspace without any identity holding `BYPASSRLS`. It is `NOLOGIN NOINHERIT NOBYPASSRLS` and owns `app.maintenance_default_partition_rows()`, `app.maintenance_orphan_counts()` and `app.maintenance_recall_overlap(text, halfvec, int)`: `SECURITY DEFINER`, `search_path = pg_catalog, pg_temp`, every output column text (a table or partition name), bigint or integer. Its reach is column-level `SELECT` on key columns of seven tables (§3). `EXECUTE` is revoked from `PUBLIC` and granted to `nominara_owner` only, never to a runtime role (ISO-27, ISO-29, ISO-30). Migration 0160, ADR-0004 (`docs/adr/` in the api repository).
- **`nominara_platform_agg`** (STORY-176, migration 0190, ADR-0005, owner decisions 91 and 93) is the only identity that reads across workspaces to build the category benchmark. It is `NOLOGIN NOINHERIT NOBYPASSRLS`, has no members (`ISO-24`, `ISO-28`), and owns two `SECURITY DEFINER` functions with `search_path = pg_catalog, pg_temp`: `app.apply_benchmark_membership()` (the nightly step that moves a project's benchmark category, 7-day cooldown held as a constant inside it, returns one count) and `app.refresh_platform_metrics(from, to, categories, scoring_version)` (recomputes `platform_metrics`, returns two counts). It holds column-level `SELECT` on the named columns of `metric_daily`, `projects`, `project_source_index` and `source_domains`, `UPDATE` on `projects.benchmark_category_slug` and `benchmark_category_applied_at` only, `SELECT (key)` on `engines`, and full DML on `platform_metrics`, which it is the only writer of. `EXECUTE` is granted to `nominara_worker`, `nominara_app` and `nominara_owner`, never to `nominara_report` or `nominara_portal` or `PUBLIC`.
- **`platform_metrics` is read-only to the runtime roles** (migration 0190 revokes `INSERT`, `UPDATE`, `DELETE` and `TRUNCATE` from `nominara_app` and `nominara_worker`; `SELECT` stays, as a global table read by the read path). The definer is its only writer.
- `nominara_portal` and `nominara_report` hold `SELECT` only, so the read-only portal cannot mutate state even if a route were mis-registered.
- **The portal is read-only, with exactly three `POST`s under `/portal`** (STORY-110 layer 1, STORY-098/099, owner decision 71b–c). `POST /portal/session` and `POST /portal/session/verify` are the gate: public, not `@PortalRoute`, and they run in the token's workspace on the application pool, not on `nominara_portal`. `POST /portal/telemetry` is the one `@PortalRoute` that is not a `GET`: the portal request's own transaction stays `READ ONLY` on the `SELECT`-only role, and the beat records on the application pool in its own short tenant transaction, pinned to the cookie's view, token and workspace (the request never names a view). Every other `@PortalRoute` is a `GET` and carries no permission, credit or idempotency metadata. `test/unit/abuse/portal-read-only.spec.ts` holds the mutating set to exactly these three; any other non-`GET` under `/portal` fails it (layer 2: `portal-context-http.spec.ts`; layer 3: `ISO-10`).
- **`legal_holds`, `purge_runs` and `subject_erasure_queue`** (STORY-111, migration 0165) are owner-only platform state: global, no RLS, and `ALL` is revoked from `nominara_app`, `nominara_worker`, `nominara_report` and `nominara_portal`. They are read and written only by the owner connection (the nightly `retention.purge` handler and the operator CLIs `db:subject:export`, `db:subject:erase`, `db:hold:place` and `db:hold:release`).

## 3. Forced row-level security

The detail most implementations miss: **table owners bypass RLS by default.** Every tenant table therefore gets both `ENABLE` and `FORCE`.

```sql
CREATE SCHEMA IF NOT EXISTS app;

-- Transaction-scoped context accessors. STABLE so the planner can inline them.
CREATE OR REPLACE FUNCTION app.current_workspace() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.current_actor() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.current_actor_id', true), '')::uuid
$$;

-- Portal / share-token sessions expose only an explicit project allow-list.
CREATE OR REPLACE FUNCTION app.current_scope_projects() RETURNS uuid[]
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT COALESCE(
    string_to_array(NULLIF(current_setting('app.current_scope_projects', true), ''), ',')::uuid[],
    ARRAY[]::uuid[])
$$;
```

Applied to every tenant table by a **generated** migration, so a new table cannot ship without isolation:

```sql
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE  ROW LEVEL SECURITY;

CREATE POLICY ws_isolation_projects ON projects
  FOR ALL
  TO nominara_app, nominara_worker, nominara_report
  USING      (workspace_id = app.current_workspace())
  WITH CHECK (workspace_id = app.current_workspace());

-- Portal role additionally constrained to the share token's project scope.
CREATE POLICY portal_scope_projects ON projects
  FOR SELECT
  TO nominara_portal
  USING (workspace_id = app.current_workspace()
         AND id = ANY (app.current_scope_projects()));
```

Project-descendant tables carry **both** keys, so a mis-set `project_id` cannot escape the tenant and portal scope is enforced without a join:

```sql
CREATE POLICY portal_scope_answer_captures ON answer_captures
  FOR SELECT TO nominara_portal
  USING (workspace_id = app.current_workspace()
         AND project_id = ANY (app.current_scope_projects()));
```

**`portal_scope_source_domains` (owner decision 83c, migration 0178).** The one portal policy that enforces scope through a join. `source_domains` has no `project_id` column, and a workspace-only policy would let a project-scoped token enumerate every domain in the workspace, so the policy admits a domain only where a `project_source_index` row exists for a project in the token's scope:

```sql
CREATE POLICY portal_scope_source_domains ON source_domains
  FOR SELECT TO nominara_portal
  USING (workspace_id = app.current_workspace()
         AND EXISTS (SELECT 1 FROM project_source_index psi
                     WHERE psi.source_domain_id = source_domains.id
                       AND psi.project_id = ANY (app.current_scope_projects())));
```

`project_source_index` is itself portal-scoped by its own `project_id`, so the subquery runs under the portal role's RLS too, and a domain seen only in an out-of-scope project stays invisible (ISO-09). This backs `GET /portal/sources`. It overrides the earlier note, from STORY-011, that removed `source_domains` from the portal-readable set.

**Why `WITH CHECK` is mandatory.** `USING` filters reads. Without `WITH CHECK`, a defect or a crafted payload could `INSERT` — or `UPDATE … SET workspace_id = <other tenant>` — writing into a tenant it could never read. Every `FOR ALL` policy specifies both, and CI asserts that `pg_policies` contains a non-null `with_check` for every one of them.

**Maintenance count policies (migration 0160, ADR-0004).** `nominara_maintenance` (§2) is admitted to exactly seven tables by one role-targeted policy each, and to nothing else. Each is `FOR SELECT TO nominara_maintenance USING (true)`; permissive policies combine per role, so none contributes anything to any other role. The grant behind them is column-level `SELECT` on key columns only (no table grant, no write, no content column). The functions read the partitioned parents, so no per-partition policy is needed as months are added.

**Platform aggregate policies (migration 0190, ADR-0005).** `nominara_platform_agg` is admitted to exactly four tenant tables by one role-targeted policy each, `platform_aggregate_<table> ... FOR SELECT TO nominara_platform_agg USING (true)` on `metric_daily`, `projects`, `project_source_index` and `source_domains`, plus one `FOR UPDATE` policy on `projects` for the two benchmark-membership columns. Each is inert for every other role and declared to `rls-check`. Reach is bounded by the column grants, not the policy.

| Policy | Table |
|---|---|
| `maintenance_count_answer_captures` | `answer_captures` |
| `maintenance_count_mention_facts` | `mention_facts` |
| `maintenance_count_citation_facts` | `citation_facts` |
| `maintenance_count_tracked_prompts` | `tracked_prompts` |
| `maintenance_count_topic_clusters` | `topic_clusters` |
| `maintenance_count_content_chunks` | `content_chunks` |
| `maintenance_count_corpus_passages` | `corpus_passages` |

**Fail-closed default.** `app.current_workspace()` returns `NULL` when the setting is unset. Because `workspace_id = NULL` evaluates to `NULL` rather than true, an un-contextualised query returns **zero rows** and every write is rejected. There is no configuration in which "forgot to set the tenant" means "see everything".

**`share_token_email_codes` (STORY-098, owner decision 71b, migration 0169).** The allowed-email-domain sign-in codes for a share link. A tenant table: `workspace_id`, `ENABLE` and `FORCE ROW LEVEL SECURITY`, and one policy created in its own migration, `ws_isolation_share_token_email_codes` `FOR ALL TO nominara_app, nominara_worker, nominara_report` with `USING` and `WITH CHECK` on `workspace_id = app.current_workspace()`. **It is not portal-readable**: no `portal_scope_*` policy names it. A row holds the code's Argon2id hash and a peppered hash of the address (domain-separated with `portal-code:` from the sign-in ledger's hash of the same address, so the two tables cannot be joined on it), never the address or the code. It cascades with its share token (composite foreign key on `(workspace_id, share_token_id)`) and has no foreign key to `users`. The subject inventory classes it **`exempt` from the subject access export** (owner decision 74): exporting it would expose hash columns, which the default-deny credential check forbids, and a code expires within ten minutes.

**`prompt_generations` (STORY-045, owner decision 95a, migration 0193, batch 8).** One background prompt-generation pass: the pointer `POST /projects/{id}/prompts/generate` returns and `GET /projects/{id}/prompts/generations/{id}` reads. A tenant table: `workspace_id` (cascading from `workspaces` and `projects`), `ENABLE` and `FORCE ROW LEVEL SECURITY`, and one policy created in its own migration, `ws_isolation_prompt_generations` `FOR ALL TO nominara_app, nominara_worker, nominara_report` with `USING` and `WITH CHECK` on `workspace_id = app.current_workspace()`. **It is not portal-readable**: no `portal_scope_*` policy names it. The `prompt.generate` job is signed and tenant-scoped; a job signed for one workspace that names another's generation does nothing. The stale-generation sweep runs on the scheduler's owner connection to find rows across tenants (ids only) and writes each through a per-generation tenant context. The subject inventory classes it **`exempt`** (request and result hold brand vocabulary and prompt text, no person). Open follow-ups: whether `nominara_report` needs the grant at all, and confirming that `request.brand_context` needs no erasure handling.

**`name_match_verdicts` and `name_match_judge_usage` (STORY-191, owner decisions 99c and 99l, migrations 0197 and 0202, batch 10).** Both are tenant tables: `workspace_id` cascading from `workspaces`, `ENABLE` and `FORCE ROW LEVEL SECURITY`, and one policy created in their own migration (`ws_isolation_name_match_verdicts`, `ws_isolation_name_match_judge_usage`) `FOR ALL TO nominara_app, nominara_worker, nominara_report` on `workspace_id = app.current_workspace()`. **Neither is portal-readable.** Verdicts hold ids and a label, no answer text; the usage row holds a monthly count. The subject inventory classes both **`exempt`**. Open follow-up: retention of verdict rows after their `mention_facts` partition is dropped.

**`retention_exports` (STORY-185, owner decisions 100(c) and 100(j), migrations 0203, 0205 and 0206, batch 11).** The full-data export offered while a retention-shortening purge is pending: state, stored object key, coverage, `scope`, `object_purged_at`. A tenant table: `workspace_id` cascading from `workspaces`, `ENABLE` and `FORCE ROW LEVEL SECURITY`, and one policy created in its own migration (`ws_isolation_retention_exports`) `FOR ALL TO nominara_app, nominara_worker, nominara_report` on `workspace_id = app.current_workspace()`. **Not portal-readable.** `requested_by` references `users` `ON DELETE SET NULL`. The subject inventory classes it **`export`** with `object_key` omitted. The zip is reachable only through a tenant-checked route that mints a fresh presigned URL (at most 15 minutes) per fetch; the request needs step-up, as data export does; the stored object is deleted once the link expires (nightly `report.cleanup`), and a key outside the workspace's prefix is refused, never deleted.

**`sessions.user_agent` (STORY-096, owner decision 100(d), migration 0204, batch 11).** The User-Agent header at sign-in and refresh, at most 512 characters, parsed only for the account's own session list (`GET /me/sessions`: browser, OS, device type; the raw header is never returned) and **never logged**. **No IP address is stored.** The same migration adds `'user_revoked'` to the `revoked_reason` CHECK (`DELETE /me/sessions/{id}`).

**Batch 10 column additions on existing tenant tables (no policy change):** `tracked_prompts.status_changed_at` (migration 0199, STORY-066; inventory `exportable`) and `geo_alignments.page_structure` (migration 0201, STORY-060 S3; inventory `omit`).

**Batch 8 column additions on existing tenant tables (no policy change):** `capture_runs.retry_of` (migration 0195, STORY-195 AC4) and `workspace_members.sentiment_alerts_enabled` (migration 0196, decision 96a). Both tables were already tenant-scoped with RLS; the subject inventory lists both new columns.

## 4. Tenant context propagation and the pooling constraint

pgBouncer runs in **transaction pooling** mode, so a server connection is leased only for the duration of a transaction. This makes session-level `SET` unsafe — it would leak to the next tenant that borrows the connection — and makes `SET LOCAL` mandatory.

```ts
// nominara-api/src/tenancy/tenant-context.interceptor.ts
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(private readonly db: DrizzleService) {}

  intercept(ctx: ExecutionContext, next: CallHandler) {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const { workspaceId, actorId, scopeProjectIds } = req.tenant; // set by WorkspaceGuard

    // The whole handler body executes inside ONE transaction carrying the tenant context.
    return from(
      this.db.transaction(async (tx) => {
        // set_config(..., is_local => true) === SET LOCAL: reverts at COMMIT/ROLLBACK.
        await tx.execute(sql`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`);
        await tx.execute(sql`SELECT set_config('app.current_actor_id',     ${actorId},     true)`);
        if (scopeProjectIds?.length) {
          await tx.execute(
            sql`SELECT set_config('app.current_scope_projects', ${scopeProjectIds.join(',')}, true)`,
          );
        }
        return AsyncLocalStorageTx.run(tx, () => lastValueFrom(next.handle()));
      }),
    );
  }
}
```

Worker-side context, with signature verification **before** any `set_config`:

```ts
// nominara-api/src/lib/queue/with-tenant.ts
export async function withTenant<T>(db: DrizzleService, job: TenantJob, fn: (tx: Tx) => Promise<T>) {
  assertJobSignature(job);                                   // NFR-SEC-04 · ISO-11
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_workspace_id', ${job.data.workspaceId}, true)`);
    await tx.execute(sql`SELECT set_config('app.current_actor_id', ${SYSTEM_ACTOR_ID}, true)`);
    return fn(tx);
  });
}
```

| ID | Guardrail |
|---|---|
| `NFR-SEC-01` | A Drizzle `beforeQuery` hook throws `TenantContextMissingError` if a query targeting a table in the generated `TENANT_TABLES` set executes outside an `AsyncLocalStorageTx` transaction. This converts "forgot the interceptor" from a data leak into a 500 in CI. |
| `NFR-SEC-02` | Session-scoped `SET` is banned in application code by lint. Only `set_config(..., true)` is permitted. |
| `NFR-SEC-03` | Long-running analytics reads use the replica pool with the **identical** interceptor. There is no unscoped read path. |
| `NFR-SEC-04` | Workers set tenant context from the job payload's `workspace_id`, and the payload is HMAC-SHA256 signed over its canonical JSON with a rotating queue key, so a poisoned Valkey entry cannot redirect a worker into another tenant. |
| `NFR-SEC-05` | Cross-tenant platform aggregates are computed by a dedicated job through a `SECURITY DEFINER` function that reads **only** `metric_daily` (brand rows, `entity_type = 'brand'`), `projects` (`category_slug`, `aux_score_current`, `workspace_id`), and `project_source_index` with `source_domains` (domain, `context_weight`). It returns pre-anonymised aggregates: no `workspace_id`, and k-anonymity ≥ 20, where k is the number of **distinct contributing workspaces** for that category, engine and date. A group below 20 produces no row (owner decisions 88d and 91, option A). **Benchmark privacy (owner decision 93):** a project's category counts only at the **nightly batch**, and a project's benchmark membership changes **at most once per 7 days**; published percentiles and the AUX median are **rounded to whole numbers**; the workspace count is exposed only as the **band `20+`** (the exact `sample_size` stays in the table and is never on the wire); top source domains are published **in order, without weights**; and the read path serves **nothing older than the 7-day batch window**. As built the grant also names `projects.id`, `projects.deleted_at` and the two benchmark-membership columns, and each `metric_daily` row's project and scoring version, none of them content (ADR-0005). **Known limit:** a suspended or pending-deletion workspace is not excluded from k, because that needs `workspaces.status`, outside this read set; that is a further spec change. Whether 20 workspaces under related owners count as 20 is open (decision 93). |

## 5. Authentication

| Method | Availability | Implementation notes |
|---|---|---|
| **Passkeys (WebAuthn)** | all plans, default | `@simplewebauthn/server`; resident keys; user verification `preferred`; multiple credentials per user; `authenticator_attachment` recorded. **Sign-in is anonymous; registration never is** (STORY-173): a passkey is added only from a signed-in session that has stepped up, to an account whose address is proved (`users.email_verified_at`), at `POST /me/passkeys/options` · `/verify`. A new person proves their address with an email code first, then adds the passkey. No anonymous request names an account and attaches a credential, and a passkey on an address nobody has proved yields no session |
| **OAuth 2.1 + PKCE** | Google, GitHub, Microsoft | `openid-client`; the email must be provider-verified. **A provider that did not verify the address binds no credential, creates no account and mints no session** — `403 forbidden`, `details.reason = email_not_verified`, "sign in with an email code first, then connect <provider> from settings" (STORY-173; this replaces the old "create it `unverified`" path, which was how a credential could be planted on an address before its owner arrived). A verified address that meets an `unverified` row **claims** it as a first proof (one transaction: lock, revoke everything earlier, set the proof, bind the credential, mint the session); a **proved** row is never claimed — that is `email_collision`. Connecting or disconnecting a provider needs a proved address and a fresh step-up |
| **Email OTP** | all plans | 8-digit code, 10-minute TTL, 5 attempts, Argon2id-hashed at rest, single use, rate-limited 3/hour/email. It is also how a new account is created and proved (STORY-173): a request for an address with no account creates it `unverified` — no credential, no session — and mails a code, doing exactly the work a known address does; only a verified code sets `email_verified_at` and makes it `active`. The **first** proof of an address revokes every credential and session that predates it |
| **OIDC SSO** | Enterprise | per-workspace IdP config via `openid-client`. Authorization Code + PKCE; `state` and `nonce` bound to the session; `iss`/`aud`/`azp` checked; discovery document and JWKS cached with a bounded TTL. **The v1 SSO path** |
| **SAML 2.0 SSO** | post-launch, on request | `@node-saml/node-saml`, hardened per `NFR-SEC-17…21`. **Not enabled for any customer until an external review passes** |
| **SCIM 2.0** | Enterprise | built in-house against RFC 7644 — `/Users` and `/Groups`, `PATCH` semantics, a bearer token per connection, soft-deactivate on `active:false` |
| **Service API keys** | Business+ | `nk_live_{22 chars}` shown once; stored as SHA-256; scoped to one workspace and an explicit permission set; last-used IP recorded |

### Session model

- **Access token.** JWT, EdDSA (Ed25519), 15-minute TTL, claims `{sub, sid, ws, role, scope, ent_v, iat, exp, jti}`. `ws` is the **active** workspace; switching workspaces mints a new token. **A token is never valid for two tenants.**
- **Refresh token.** Opaque 32-byte random, stored hashed, 30-day sliding TTL, **rotating with reuse detection**: presenting a consumed refresh token revokes the entire session family and raises a `session.reuse_detected` security event.
- **Refresh-token reuse grace window.** The one documented exception to the rule above: a refresh presenting the token consumed by the session's **own immediately-preceding rotation**, within a short window after that rotation (default 2s, `REFRESH_TOKEN_GRACE_WINDOW_MS`, hard-capped at 5s), receives the **identical successor** refresh token back instead of being treated as reuse — never a sibling, never a revocation. This exists because a request can legitimately arrive after its session's own rotation already completed (a second browser tab, a second app instance, a retried request that raced the winning one) presenting the token that rotation just consumed; without this window that arrival reads as theft and kills the session it belongs to. It is deliberately narrow: an older, two-back token, a different session's token, or this same token presented once its window has closed all still revoke the whole family and raise `session.reuse_detected` exactly as before. The successor's raw value is held in a **slot in the cache (Valkey) — never in Postgres**, written with a TTL equal to the window as the last step of the rotation's transaction, so the window is anchored at the rotation's commit on the cache's clock and the slot ceases to exist when the window closes. **The cache is not the only bound on that window:** a slot write the rotation abandoned at its deadline is not cancelled — Valkey executes it when it recovers, with a full TTL from that moment — so the eligibility check also requires the presented token's own consumption, stamped by the rotation with the database's `clock_timestamp()` inside the transaction that commits it, to be younger than **the window plus the cache deadline** (`REFRESH_TOKEN_GRACE_CACHE_DEADLINE_MS`, 500ms). That is the hard bound: it is measured on the database's clock, from a stamp never later than the rotation's commit, and no cache stall can move it, so a slot that lands late is inert. It is kept encrypted with the same AES-256-GCM envelope format §8 uses for `workspace_keys`, under a key derived from the **predecessor token itself** (HKDF-SHA256, salted with the session id) — never a server-held key. The slot stores only the predecessor's hash next to that ciphertext, so only a caller presenting that token can recover the successor: a database read cannot reach a live refresh token at all, and a cache read alone, even with every server secret, does not reveal it. A slot is honoured only while the session is not revoked and only while the successor it names is still a live (unconsumed, unexpired) refresh token of that session. The next rotation overwrites the slot and a reuse revocation deletes it. **The cache is never trusted to be there:** when Valkey is unavailable the grace window is skipped — the rotation still succeeds, without a slot, and a replay of the consumed token then revokes the family exactly as the strict rule above says. After one missed deadline or cache error the cache is skipped altogether for a cool-off (30s, per process) — no slot written, none read — so a silent cache costs one deadline rather than one per rotation, and a replay in that time revokes; one call then probes it before it is used again. A grace-window hit raises its own `session.refresh_grace_reuse` security event, naming the session id and never the token.
- **Cookies.** `HttpOnly; Secure; SameSite=Lax; Path=/; __Host-` prefix, plus a separate CSRF double-submit token for cookie-authenticated mutating requests.
- **Share-link sessions with allowed email domains** (STORY-098, owner decision 71b). Where a share token names `allowed_email_domains`, `POST /portal/session` sets no cookie: it checks the password first (where the link has one), then the address's domain (exact, case-insensitive, after the last `@`; a refused domain is the same `401` as a wrong password), and mails a **six-digit code** after the transaction commits, answering `202 {code_sent: true}` whether or not the mailbox exists. The cookie comes from `POST /portal/session/verify`, which takes the secret, the address, the code and, where the link has one, **the password again**, so a code alone never opens a password-protected link. A code is drawn from a CSPRNG, stored Argon2id-hashed, lives **10 minutes**, allows **5 attempts** (the fifth wrong one invalidates it) and is superseded by a newer one. Issue is capped at **3 codes per address per hour, 10 per link per hour and 30 per link per rolling 24 hours** (the daily cap is the 098 security review's bound on a password-less link holder farming fresh five-attempt budgets). The mail carries the code and its lifetime and nothing else (no agency, client, link or workspace). Every wrong, expired, used or unknown code answers the same `401`. Open follow-ups from the review: mint reveals the domain allow-list to a holder of the link; mailbox-flood alerting; a verify-driven lockout of a link's password.
- **Step-up re-auth** (a fresh WebAuthn or OTP within 5 minutes — a WebAuthn assertion or an email one-time code stamps the session it creates, `sessions.last_strong_auth_at/method`) is required for adding a passkey (STORY-173) and for: ownership transfer, SSO configuration changes, custom-domain changes, API-key creation, integration credential creation, share-token password changes, workspace deletion, data export, requesting the retention export (`POST /billing/retention-export`, decision 100(j)), and revoking a session (`POST /me/sessions/revoke-others`, `DELETE /me/sessions/{id}`).

### Enforcement chain — every authenticated route, in this order

```
AuthGuard          verify JWT signature and expiry, load the session, reject a revoked jti
 → WorkspaceGuard  resolve the target workspace from the JWT `ws` (or X-Nominara-Workspace for an
                   API key); RE-VERIFY A LIVE workspace_members ROW — never trust the token's role
                   alone; populate req.tenant
   → RbacGuard     @RequirePermission('project:write') evaluated against the §6 matrix
     → EntitlementGuard  @RequireEntitlement('projects.max') | @RequireFeature('integrations.gsc')
                         → 403 entitlement_exceeded | 403 feature_not_in_plan
       → RateLimitGuard  Valkey token bucket keyed (route class, workspace, user, ip)
         → StorageReadyGuard  acts only on @RequireStorage(): unconfigured object storage → 503 degraded
                              before anything is reserved
           → QuotaGuard      @Meter('pdf_exports', n) — non-credit TIER CAPS only → 429 quota_exceeded
             → DailyCapGuard @DailyCap('lookup') → 429 daily_limit_reached, debits nothing
               → CreditGuard @Credits('manual_scan', estimator) — reserve from credit_wallets; verify
                             X-Nominara-Confirmed-Credits → 402 insufficient_credits | 409 price_changed
                 → TenantContextInterceptor   open the TX, SET LOCAL context
                   → handler
                     → CreditInterceptor  commit the actual debit (≤ reservation) or release on failure
                     → AuditInterceptor   append a hash-chained audit_log row on a mutating route
```

The order matters and is asserted by test (`api.module.spec.ts`). `CanonicalParamsGuard` runs before `AuthGuard` so every guard reads the same path parameters the database will store. A rate-limited request must never reach `StorageReadyGuard`, `QuotaGuard`, `DailyCapGuard` or `CreditGuard` (STORY-180), so nothing is reserved for a `429`, and `StorageReadyGuard` precedes `QuotaGuard` so unconfigured storage is refused before a tier-cap unit is reserved. A rate-limited request must never reach `CreditGuard`, so no reservation is created; a permission failure must be a `403` distinct from a `402` for insufficient balance.

**STORY-022-E-1.** This ordering — `RateLimitGuard` before `CreditGuard` — is what the diagram above shows, and this prose was always correct; [`system-architecture.md`](./system-architecture.md#2-logical-architecture) and [`EPIC-03`](../epics/EPIC-03-api-platform-and-contracts.md#the-global-chain) previously diagrammed the reverse order and are corrected to match this prose, never the other way around.

## 6. Permission matrix

Roles are workspace-scoped. `manager` may additionally be restricted to an explicit project set via `workspace_members.project_scope uuid[]` (`NULL` = all projects). "scoped" below means "only within `project_scope`".

| Permission | `owner` | `admin` | `manager` | `analyst` | `viewer` | share token |
|---|---|---|---|---|---|---|
| `workspace:read` | ✓ | ✓ | ✓ | ✓ | ✓ | metadata only |
| `workspace:update` | ✓ | ✓ | — | — | — | — |
| `workspace:delete` | ✓ (step-up) | — | — | — | — | — |
| `workspace:transfer_ownership` | ✓ (step-up + dual accept) | — | — | — | — | — |
| `member:invite` | ✓ | ✓ | — | — | — | — |
| `member:update_role` | ✓ | ✓ (cannot grant `owner`) | — | — | — | — |
| `member:remove` | ✓ | ✓ (not `owner`) | — | — | — | — |
| `billing:read` (incl. credit ledger) | ✓ | ✓ | — | — | — | — |
| `billing:write` (plan, add-ons, packs, auto-top-up) | ✓ | ✓ | — | — | — | — |
| `credits:spend` | ✓ | ✓ | scoped | ✓ (tools only) | — | — |
| `sso:configure` | ✓ (step-up) | ✓ (step-up) | — | — | — | — |
| `apikey:create` | ✓ (step-up) | ✓ (step-up) | — | — | — | — |
| `project:create` | ✓ | ✓ | ✓ | — | — | — |
| `project:read` | ✓ | ✓ | scoped | ✓ | scoped | token scope |
| `project:update` | ✓ | ✓ | scoped | — | — | — |
| `project:delete` | ✓ | ✓ | — | — | — | — |
| `prompt:write` | ✓ | ✓ | scoped | — | — | — |
| `tracking:trigger` | ✓ | ✓ | scoped | — | — | — |
| `tracking:read` | ✓ | ✓ | scoped | ✓ | scoped | token scope |
| `lookup:execute` | ✓ | ✓ | ✓ | ✓ | — | — |
| `lookup:read_history` | ✓ | ✓ | ✓ | ✓ | — | — |
| `aux:trigger` | ✓ | ✓ | scoped | — | — | — |
| `aux:read` | ✓ | ✓ | scoped | ✓ | scoped | token scope |
| `task:create` / `task:move` | ✓ | ✓ | scoped | — | — | — |
| `task:comment` | ✓ | ✓ | scoped | ✓ | — | — |
| `task:read` | ✓ | ✓ | scoped | ✓ | scoped | token scope |
| `optimizer:use` | ✓ | ✓ | scoped | — | — | — |
| `agency:branding` | ✓ | ✓ | — | — | — | — |
| `agency:custom_domain` | ✓ (step-up) | ✓ (step-up) | — | — | — | — |
| `share_token:mint` / `:revoke` | ✓ | ✓ | scoped | — | — | — |
| `export:data` | ✓ (step-up) | ✓ (step-up) | scoped | ✓ (CSV only) | — | PDF only |
| `audit_log:read` | ✓ | ✓ | — | — | — | — |

**Invariants.**
- Exactly one `owner` per workspace at all times, enforced by a partial unique index.
- `owner` cannot be removed; ownership must be **transferred**.
- `viewer` is a first-class read-only role for named external stakeholders who need a login; anonymous stakeholders use share tokens instead.
- **`credits:spend` is separable from `billing:write` on purpose.** An `analyst` may run tools without any ability to buy credits, and a finance-focused `admin` may buy credits without spending them. This is the separation of duties agencies and finance teams ask for.
- Every credit-debiting route additionally passes `CreditGuard`, so lacking balance is a `402`, distinct from lacking permission (`403`).
- A permission denial returns `403 forbidden` naming the required permission — **never `404`**, since the resource's existence within the tenant is already known to the caller.
- **`POST /exports/{id}/revoke-link` requires `agency:branding`** (owner decision 60 (d), STORY-180), so `owner` and `admin` only. It is workspace-wide, not `@ScopedByQuery`: a project-scoped `manager` is refused `403` naming `agency:branding`. The public link route it disables, `GET /report-links/{workspaceId}/{token}`, takes no permission (the recipient has no session).
- **`POST /results/{id}/reparse` additionally requires the `owner` or `admin` role** (owner decision 2026-10-23, STORY-034). A scoped `manager` holds `tracking:trigger` and is refused with `403` naming `tracking:trigger`; an API key has no membership and is refused. The check is a route guard (`ReparseGuard`) on the live membership role, not a row of the table above.

## 7. Revocation and freshness

Access tokens are short-lived but not instantly revocable, which is unacceptable for seat removal in a competitive-brand context. Four layers:

1. **Membership re-check on every request.** `WorkspaceGuard` reads `workspace_members`, cached in Valkey for 30 s keyed `mem:{user}:{ws}` and **invalidated synchronously** on any membership mutation. Removing a seat takes effect within 30 s worst case, immediately in the common case.
2. **Session revocation list.** `sid`/`jti` deny-list in Valkey with TTL equal to the remaining token lifetime. Populated on logout, credential change, role downgrade, refresh-reuse detection, and workspace suspension.
3. **Entitlement version.** The JWT carries `ent_v`; a plan change bumps `workspaces.entitlement_version`, and a mismatch forces a token refresh so a downgraded entitlement cannot be exercised with a stale token.
4. **WebSocket re-authorisation.** Sockets re-validate membership every 60 s and on any `member.changed` event; failed re-validation closes with `4403`.

`RbacGuard` evaluates against the **live** membership row. The token's `role` claim is a hint for UI rendering only.

## 8. Secrets and encryption

**At rest.**
- Aurora storage encryption with a per-region KMS CMK; S3 buckets `SSE-KMS` with bucket keys.
  - **As built (object storage, Group C).** Every object write sends `ServerSideEncryption`: `aws:kms` (the default when `STORAGE_SSE` is unset), always with `BucketKeyEnabled: true`, or `AES256` (SSE-S3) for local development only. **Production boot is refused** when SSE-KMS is in force (explicitly or by default) without `STORAGE_KMS_KEY_ID`: the account's default `aws/s3` key is not the CMK this section requires. Outside production an unset key ID falls back to `aws/s3`.
- **Application-level envelope encryption for customer-held secrets** — integration credentials, SSO client secrets, GA4 credentials. Share-token passwords are *hashed*, not encrypted.
  - One **DEK per workspace**, AES-256-GCM, generated by KMS `GenerateDataKey`, stored only as ciphertext in `workspace_keys.wrapped_dek`.
  - Field format `v1:{dek_id}:{base64(iv)}:{base64(ciphertext||tag)}`. **AAD binds `workspace_id|table|column|row_id`**, so a ciphertext copied to another row or tenant fails to decrypt (`ISO-12`).
  - Plaintext DEKs are cached in-process for ≤ 5 minutes, never logged, and zeroed on eviction.
  - DEKs rotate every 90 days; a background job re-encrypts lazily on read when `dek_id` differs. Ownership transfer forces an immediate re-wrap.
- Password-like values use Argon2id (m=64 MiB, t=3, p=1); high-entropy random tokens use SHA-256.

**In transit.** **TLS 1.3, with 1.2 as the hard floor and nothing below it accepted** — everywhere, including intra-VPC database and Valkey connections; HSTS `max-age=31536000; includeSubDomains; preload`. Certificate pinning is deliberately **not** used — it breaks agency custom domains.

**Egress.** Outbound requests from `worker-crawl` pass through a NAT gateway with a static egress IP set that customers can allow-list, and are filtered by the SSRF guard in §9. **The egress NAT has no IAM role attached**, IMDSv2 is required, and the hop limit is 1.

## 9. Application security controls

| Threat | Control |
|---|---|
| **SSRF via user-supplied URLs** (project root URL, audit target, beacon origin) | Strict allow-list: scheme ∈ {http,https}, port ∈ {80,443}; DNS resolved **before** connect and **re-checked after every redirect**; reject RFC1918, loopback, link-local, CGNAT, IPv6-ULA, and metadata addresses; max 3 redirects, all re-validated; 10 s connect / 20 s total timeout; 5 MB response cap; egress via the dedicated no-IAM-role NAT. **STORY-110 (2026-11-06):** an IPv4 address embedded in IPv6 is extracted and judged as IPv4 in every embedding (`::ffff:a.b.c.d` in either spelling, NAT64 `64:ff9b::/96`, SIIT, 6to4 `2002::/16`, IPv4-compatible), site-local `fec0::/10`, the RFC 5737 TEST-NETs and `192.88.99.0/24` are refused, and an **empty resolver answer** is refused as `dns_resolution_failed` (nothing to pin the connection to). `test/unit/abuse/guarded-fetch-abuse.spec.ts` |
| **Domain-ownership spoofing** (auditing a domain you do not own) | Audits beyond public-surface scope require verification: DNS `TXT _nominara-verify=<nonce>`, a `/.well-known/nominara-<nonce>.txt` file, or a meta tag. Unverified domains receive a rate-limited, robots-respecting public-surface audit with every excluded rule named |
| **Stored XSS via scraped engine text** | Raw response text is stored as text and rendered **only** through a strict sanitizer that emits `<mark data-entity-id>` from Nominara's own span map. No engine-supplied HTML is ever rendered. CSP: `default-src 'self'; script-src 'self' 'strict-dynamic' 'nonce-…'; object-src 'none'; base-uri 'none'; frame-ancestors <agency-domains>` |
| **SQL injection** | Parameterised queries only; raw SQL restricted to `src/db` with `sql` tagged templates; lint bans string concatenation into `sql.raw` |
| **IDOR** | Not expressible: RLS filters by tenant, and every resource read is additionally checked against `project_scope` for scoped roles |
| **Mass assignment** | zod `.strict()` on every request DTO — an unknown key is a `400`, never silently ignored |
| **CSRF** | Cookie sessions require a double-submit token bound to `sid`; API-key auth is header-only and cookie-less |
| **Replay** | `Idempotency-Key` required on every `POST` that creates a billable or external effect; stored 24 h in Valkey with the response envelope |
| **Enumeration** | Login, OTP, and invitation endpoints return uniform responses **and uniform timing**; workspace slugs are non-sequential; share tokens are 256-bit random. Uniform means the same status, body, headers **and the same sequence of statements** for an address with an account and one without — asserted deterministically, not only by latency. There is no anonymous passkey-registration endpoint to enumerate (STORY-173): the request is refused as a validation failure before any lookup. **A sign-in code to a suppressed address** (STORY-178) is refused inside the deferred send, after the response, so the request keeps its identical response and timing; only a **hard bounce** suppresses OTP mail — a complaint suppresses only non-transactional mail (reports, digests, alerts) and a transient bounce never suppresses (owner decision 2026-10-26). **`POST /workspaces/{id}/switch` checks membership before the workspace's state** (STORY-110 F-3): a non-member gets one refusal (`not_a_member`) whether the id does not exist, is suspended or is active, and only a member learns that their own workspace is suspended (`test/integration/abuse-workspace-enumeration.spec.ts`). **Share links:** a revoked or expired link answers `401 token_revoked`, an unknown secret `401 unauthenticated` (owner decision 68d, as for report links); only the holder of a 256-bit secret can tell the two apart |
| **Account takeover and pre-hijack via passkey registration or OAuth** | An anonymous caller must never be able to bind a credential to an account (STORY-173); **the same holds for OAuth**: an unverified provider binds nothing, and the first-proof revocation is **durable** (`user_credentials.revoked_reason = 'address_proved'`, never reactivated by a sign-in — only a credential its owner unlinked is). Every session is minted in the transaction that decides who the user is, so the first proof cannot miss one. Registration is session-authenticated, step-up gated and requires a proved address; the ceremony is claimed by purpose **and owner** in one `UPDATE`; `status = 'active'` is reached only with `email_verified_at`; an anonymous request never rewrites an existing user row, its address casing included; and the first proof of an address revokes every earlier credential and session, so nothing planted before the owner arrived survives their proof |
| **Forwarded invitation link** | An invitation is **bound to its address** (STORY-172). Accepting requires the signed-in account's **verified** email (`users.email_verified_at IS NOT NULL` — not merely `status = 'active'`, which a passkey registration also sets) to equal `workspace_invitations.email`, compared case-insensitively inside the **same atomic claim** as the token, so a link pasted to the wrong person joins nobody — and the address cannot be claimed without proof: STORY-173 (merged before STORY-172; merge order 174 → 173 → 172) means `users.email_verified_at` is set only by an OTP verify, a provider-verified OAuth sign-in, or as the first proof of the address, and anonymous passkey registration no longer exists. A mismatch is indistinguishable from an unknown, expired, revoked or used token — same `400`, same body, same query cost — and **does not consume the token**, so the invited person can still accept within the TTL. An already-active member is refused `409 conflict` (`details.reason = already_member`) without consuming the token; only the invited, verified account can reach that branch, so it discloses nothing to a bearer. The refusal reason is recorded only in a metric label and a redacted log line (workspace ID, never the token or address) — never in the response, and never as an audit row, which would hand any token holder a way to contend on a workspace's chain |
| **Prompt injection via scraped content** | Any scraped text reaching the sentiment arbiter is wrapped in a delimited, instruction-free envelope; the arbiter is constrained to a zod-validated enum output, has no tools and no network, and a non-conforming output fails closed to `neutral` with `arbiter_rejected=true`. **Scraped text never constructs a tool call, a URL, a SQL fragment, or a prompt template.** A 60-payload red-team fixture suite runs in CI |
| **Crawling against a site's wishes** (owner decision 70d) | Every fetch that identifies as NominaraBot reads the target host's `robots.txt` and keeps to a per-host request budget: the AUX site audit through its own crawler, and seeding verification and the corpus page fetcher through **one crawl gate** (`src/lib/net/crawl-gate.ts`, STORY-111 branch) built on the same parser and budget. The gate checks **every redirect hop**, fails closed (a `robots.txt` that cannot be read refuses the fetch as `robots_unavailable`; a `4xx` means no rules), caches a host's rules for an hour and a read failure for five minutes, tracks at most 1,000 hosts, and holds no connection or tenant context (it runs in a phased job's `run` phase). A disallowed seeding URL is reported `unreachable`. **One stated exception (owner decision 99j, 2026-11-12):** Wikimedia's robots.txt disallows `/w/` for `*`, so the STORY-060 entity probe uses its own gate (`src/lib/geo/entity-probe/wikimedia-gate.ts`) exempting only the official API endpoints: https on the default port, `www.wikidata.org/w/api.php` with `action` `wbsearchentities` or `wbgetentities`, and `en.wikipedia.org/w/api.php` with `action=query`, re-judged on every redirect hop. Every other path on those hosts still obeys robots.txt. The SSRF guard, the identifying `NominaraBot` User-Agent and a strict 1 request/second per host stay; the shared `crawlGatedFetch` has no exemption |
| **Erasure under a legal hold** (STORY-111, owner decisions 68b and 70c) | An individual erasure whose subject has a membership row (active or removed) in a workspace under a legal hold is **deferred as a whole**: it is queued in `subject_erasure_queue`, audited once as `subject_request.deferred`, and runs under the same request id when the hold is released or lapses. The check is re-read **inside** the erasure's transaction under the hold register's advisory lock, which `placeLegalHold` also takes, so a hold placed mid-request still defers it; a workspace or project purge re-checks the register the same way and skips a held subject. Holds are placed and released only by the operator CLI (`pnpm db:hold:place` with a requester, an approver, a reason, an expiry and `--confirm`; `pnpm db:hold:release`; audited `legal_hold.placed` / `legal_hold.released`). Subject access and erasure are operator-run (owner decision 68a); no HTTP route exists |
| **Dependency supply chain** | Lockfile integrity, Renovate with a 3-day cooldown, an audit + Socket gate in CI, a CycloneDX SBOM attached to every image, images signed with cosign and verified at deploy |
| **Container** | Distroless base, non-root UID, read-only root filesystem, no shell in production images, seccomp default, registry scanning blocking `HIGH`+ |

## 10. Isolation verification suite

`test/isolation`, blocking in CI and nightly against staging. **Any failure is a release blocker, and a P1 incident if found in production.**

| Test | Assertion |
|---|---|
| `ISO-01` | For each tenant table (68 as built, 2026-11-06): `SELECT count(*)` with **no** tenant context returns 0 |
| `ISO-02` | For each tenant table: reading with tenant A's context returns zero rows belonging to B (fixture: 3 tenants × 50 rows) |
| `ISO-03` | `INSERT` with A's context and B's `workspace_id` raises `42501 new row violates row-level security policy` |
| `ISO-04` | `UPDATE … SET workspace_id = B` under A's context affects 0 rows, or raises |
| `ISO-05` | `pg_policies` has a non-null `with_check` for every `FOR ALL` policy; every tenant table has `relforcerowsecurity = true` |
| `ISO-06` | Every table in `information_schema.tables` either has `workspace_id` with RLS enabled, appears in `TENANT_SCOPE_COLUMN`, or appears in `GLOBAL_TABLES`. **The census counts are asserted too** — 59 tenant, 10 global — so a table added without a decision fails here rather than silently shrinking `ISO-01`'s loop. **As built (2026-11-06, batch 4): 91 base tables, 68 tenant, 23 global** — STORY-111 adds three global tables (`legal_holds`, `purge_runs`, `subject_erasure_queue`, migration 0165) and STORY-098 one tenant table (`share_token_email_codes`, migration 0169). **Batch 8 (2026-11-10): 94 base tables, 69 tenant, 25 global** — STORY-045 adds one tenant table (`prompt_generations`, migration 0193); `test/isolation/assertions/iso-06-census.ts` asserts 94/69, and the Drizzle table census (`test/integration/drizzle-schema-and-service.spec.ts`) counts it. **Batch 10 (2026-11-12, api `batch10/combined`, pending merge): 96 base tables, 71 tenant, 25 global**: STORY-191 adds two tenant tables, `name_match_verdicts` (migration 0197) and `name_match_judge_usage` (migration 0202, decision 99l); `iso-06-census.ts` asserts 96/71. **Batch 11 (2026-11-13, api `batch11/combined`, pending merge): 97 base tables, 72 tenant, 25 global**: STORY-185 adds one tenant table, `retention_exports` (migration 0203); `iso-06-census.ts` asserts 97/72. The subject inventory (`src/lib/compliance/subject-inventory.ts`) is keyed on the same tenant-table list, so a tenant table with no inventory entry fails the build |
| `ISO-07` | No runtime role has `rolbypassrls`; only `nominara_breakglass` does |
| `ISO-08` | Fuzz: 500 randomised authenticated requests replaying tenant A's resource IDs under tenant B's session yield only 403/404 — never 200 with A's data |
| `ISO-09` | A share-token session cannot read a project outside `scope_project_ids`, even within the same workspace; this covers `source_domains` through `portal_scope_source_domains` (owner decision 83c) |
| `ISO-10` | A share-token session receives `42501` on any `INSERT`/`UPDATE`/`DELETE` — the role has no grants |
| `ISO-11` | A worker job whose payload signature is tampered is rejected **before** any `set_config` executes |
| `ISO-12` | Ciphertext from tenant A fails to decrypt when copied into tenant B's row (AAD binding). Runs against **every** table holding an envelope-encrypted column, **discovered from the schema rather than named**, so a table added later is picked up automatically |
| `ISO-13` | Valkey keys are namespaced `{env}:{ws}:…`; a scan asserts no un-namespaced tenant key exists. The global answer cache (`{env}:global:sim:…`) is the single documented exception |
| `ISO-14` | S3 object keys are prefixed `{env}/{workspace_id}/`; an IAM policy evaluation confirms a task role restricted by prefix cannot read another prefix. **As built (Group C):** keys are composed only in `src/lib/storage/`. `raw` is `{env}/{workspace_id}/{relative}` in the raw bucket, `reports` the same in the reports bucket, `crawl` is `crawl/{env}/{workspace_id}/{relative}` in the raw bucket; `{env}` is `STORAGE_KEY_ENV` (required in production when storage is configured; `crawl` is reserved). Feature code reaches storage only through `TenantObjectStore`, which takes the workspace from the tenant context and has no workspace parameter; `bind()` captures it inside the transaction so the I/O can run after commit. A key read back from a row is refused (`StorageTenancyError`) unless it lies inside the current workspace's prefix. Checked today by a source scanner over template literals that begin `${…}/`; the IAM policy evaluation needs the infra repository (STORY-003). **Open (owner):** the crawl shape does not begin `{env}/{workspace_id}/` and the scanner does not see it — amend this row to allow a fixed leading kind segment (`crawl/`), or move crawl snapshots to `{env}/{ws}/crawl/…` |
| `ISO-15` | Platform aggregates contain no `workspace_id` and satisfy k ≥ 20 distinct contributing workspaces (`CHECK (sample_size >= 20)` on `platform_metrics`, 19 rejected and 20 accepted) |
| `ISO-16` | **Materialized views are absent from the schema.** RLS does not apply to matviews, so all pre-aggregation uses ordinary tables maintained incrementally. Migration lint enforces this |
| `ISO-27` | The three `app.maintenance_*` functions are exactly three, `SECURITY DEFINER`, owned by `nominara_maintenance` (`NOSUPERUSER NOLOGIN NOBYPASSRLS`), pinned to `search_path = pg_catalog, pg_temp` with `TimeZone` and `DateStyle` set, `EXECUTE` not granted to `PUBLIC` and the ACL exactly the owner and `nominara_owner`, and every output column text, bigint or integer (counts only) |
| `ISO-28` | A definer-owner role is a member of no other role, in `pg_auth_members` and by effective reach (`pg_has_role`) — the converse of `ISO-24`, since PG16+ decides `INHERIT` per grant and a grant could hand a `SECURITY DEFINER` body another role's rights |
| `ISO-29` | No runtime role, no share-lookup role and no non-`BYPASSRLS` break-glass role can effectively `EXECUTE` a maintenance function: `has_function_privilege` for the role and every role it is a member of, including membership of `nominara_owner` |
| `ISO-30` | The same effective-`EXECUTE` check as `ISO-29`, registered separately for the `ADMIN`-only membership route (no `INHERIT`, no `SET`, yet the holder can grant itself both) |
| `ISO-31` | A report-link token never serves another workspace's object. Under row-level security alone, workspace B's context cannot see A's token hash (and no context sees nothing); through `ReportLinksService`, for every (token, path workspace) pair of the three-tenant fixture only the token's own workspace serves it, an expired or foreign token is refused, a revoked token is refused, and a stored key outside the workspace prefix is refused; and the unique index on `link_token_hash` names one artifact in one workspace |
| `ISO-32` | The two platform-aggregate functions keep their shape: `SECURITY DEFINER`, owned by `nominara_platform_agg`, `search_path` pinned, `PUBLIC` cannot execute, the executors are exactly `nominara_app`, `nominara_worker`, `nominara_owner` and the owner, and each returns counts only (ADR-0005) |
| `ISO-33` | The k rule held on the function, behaviourally: 19 distinct workspaces publish nothing, 20 publish one row, a domain cited by 19 of the 20 is not listed, and the figures are whole numbers (ADR-0005, decisions 88d and 93) |

## 11. Internal access, support and impersonation

- Support engineers have **no standing data access.** Reading a tenant's data requires a time-boxed grant in `support_grants`: workspace, `requested_by`, `approved_by ≠ requested_by`, justification, ticket reference, TTL ≤ 4 h, scope ∈ {metadata, findings, full}.
- Grants are visible to the workspace `owner`/`admin` in a **Trust & Access** panel in real time, are announced by email at issue time, and appear in the tenant's own audit log.
- Impersonation renders a persistent banner, blocks all mutating routes by default (a separate write grant with owner consent is required), and stamps every log line and audit row with `actor_type='support'` plus the grant ID.
- Break-glass database access additionally requires a linked incident and produces a mandatory post-incident review with a query-log attachment.

## 12. Audit log

Hash-chained, append-only, per-tenant chain. Full DDL in [`../schemas/tools-attribution-agency.md`](../schemas/tools-attribution-agency.md#audit_log--hash-chained-append-only).

- `row_hash = sha256(prev_hash || canonical_json(row_without_hashes))`; `prev_hash` is the previous row's `row_hash` **for the same workspace**, so one tenant's export does not disclose another's activity volume.
- Append-only enforced by a trigger rejecting `UPDATE`/`DELETE`, plus `REVOKE UPDATE, DELETE`.
- Nightly export to S3 with Object Lock in COMPLIANCE mode, 7-year retention. A verifier job re-walks each chain daily and **pages on the first mismatch**.
  - **As built (Group C).** A page is an alert email to `ALERT_EMAIL_TO` through the `EMAIL_SENDER` port (owner decision 2026-10-15). The `audit.verify` job only collects mismatches while it holds its advisory lock; it emails them after the lock and the connection are released, waits at most 5 s for the mail, then fails the job. The alert body carries IDs, counts and enum-like reasons only. The Object Lock export is **not built** (a local-directory sink only; [STORY-020](../stories/identity/STORY-020-hash-chained-audit-log.md)).
- `before_state`/`after_state` are redacted: secrets are replaced with `[redacted]` before the row is written, never after.

## 13. Non-functional security requirements

| ID | Requirement |
|---|---|
| `NFR-SEC-10` | No cross-tenant data disclosure. Verified by §10 on every pull request and nightly in staging. |
| `NFR-SEC-11` | Secrets never appear in logs, traces, error messages, crash payloads, or audit state fields. Enforced by a redaction transport with a deny-list **plus** a high-entropy-string detector. |
| `NFR-SEC-12` | All privileged actions require re-authentication within 5 minutes. |
| `NFR-SEC-13` | Vulnerability remediation: `CRITICAL` 24 h, `HIGH` 7 d, `MEDIUM` 30 d, `LOW` 90 d, measured from triage. |
| `NFR-SEC-14` | Annual third-party penetration test with an explicit multi-tenant isolation objective; findings tracked to closure. |
| `NFR-SEC-15` | Backups are encrypted, cross-region replicated, and restore-tested monthly; PITR window 35 days. **Restore drills re-assert `relforcerowsecurity` post-restore, and re-apply every purge recorded in the purge journal after the snapshot timestamp** — see [`data-model.md`](./data-model.md#7-retention-erasure-and-the-deletion-cascade). A restore that resurrects a purged tenant is a compliance incident caused by a recovery procedure. |
| `NFR-SEC-16` | Every production database credential is issued by Secrets Manager with 30-day automatic rotation. No service reads a credential from an environment variable baked into an image. |
| `NFR-SEC-17` | *(SAML, post-launch)* Assertions are validated against a **pinned IdP certificate**, never against a certificate embedded in the assertion. Signature verification precedes any parsing of assertion content. |
| `NFR-SEC-18` | *(SAML)* **XML Signature Wrapping defence**: the signed element is resolved by reference and the *signed* subtree is the only one read. A document containing more than one `Assertion`, or any `Assertion` outside the signed subtree, is **rejected outright** rather than disambiguated. |
| `NFR-SEC-19` | *(SAML)* `Audience`, `Recipient`, `NotBefore`/`NotOnOrAfter`, and `InResponseTo` are all validated. `ID` enters a replay cache for the assertion lifetime; a repeat is a security event and a rejected login. |
| `NFR-SEC-20` | *(SAML)* XML parsing runs with DTD loading and external entity resolution **disabled**, with an entity-expansion limit. **Parser configuration is asserted by a unit test**, never left to library defaults. |
| `NFR-SEC-21` | SCIM bearer tokens are per connection, hashed at rest, revocable independently of the SSO connection, and scoped to that workspace's `/Users` and `/Groups` only. A SCIM token can never authenticate an interactive session. |
