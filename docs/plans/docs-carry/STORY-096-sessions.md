# STORY-096 AC4/AC7 - sessions list and single revoke (batch 11 S3, owner decision 100(d)), to carry to the docs repo

api-specification.md, the identity table (next to `POST /me/sessions/revoke-others`):

| `GET` | `/me/sessions` | session | the caller's OWN live sessions across every workspace (not revoked, and holding an unexpired unconsumed refresh token), newest first, cursor-paginated: `{id, browser, os, device_type, created_at, last_active_at, current}`. `browser`, `os` and `device_type` (`desktop`, `mobile`, `tablet`) are parsed from the stored User-Agent and are `null` where it was absent or not recognised; the raw header and any IP are never returned. `last_active_at` is the last sign-in or refresh, not the last request. `current` marks the calling session. No step-up |
| `DELETE` | `/me/sessions/{id}` | session | ends ONE of the caller's own sessions: `200`, same fresh step-up as revoke-others (checked before the lookup, so a stale session cannot probe ids). A session that is not the caller's, and an unknown id, are the same `404 not_found`. Revoking an already-ended own session is a no-op that keeps its first reason. **Revoking the CURRENT session is allowed** and signs it out like logout (builder reading, spec silent: owner to confirm). `revoked_reason = 'user_revoked'` |

schemas/identity-and-tenancy.md, `sessions`: new column `user_agent text` (at most 512 characters, set at sign-in and refresh, never logged, no IP stored) and `'user_revoked'` in the `revoked_reason` CHECK (migration 0204).

# STORY-096 AC15 and AC3 (same batch)

- `GET /billing/usage` also returns `daily_lookups {used, cap}`, `daily_nlp_parses {used, cap}` and `daily_resets_at`. The daily caps are read from `credit_daily_counters` (plans-and-entitlements.md section 2, billing-and-credits.md), NOT `usage_counters` (the batch brief said usage_counters; the schema reference says the two must never overlap, and the reference wins). `used` is today's UTC row (0 with none); `cap` is the plan's current entitlement, `null` on every paid tier. `fair_use_captures` stays hidden.
- `GET /workspaces/{id}` also returns `retention_purge_not_before` (ISO, or null once the deferral has lapsed). It is on the workspace rather than `GET /billing/subscription` because a workspace that cancelled to Free has no live subscription (404 there) and STORY-185's decision (c) says the deferral covers cancel-to-Free. The per-project purge LIST is still only in the notice email: no read exposes it. A purge-preview read is a new route and needs an owner decision.

# STORY-096 AC3 / decision 100(h): GET /billing/retention-purge

api-specification.md billing table: `GET /billing/retention-purge` (`billing:read`, owner and admin): the per-project purge list of a PENDING retention-shortening deferral, the same content as the `retention_shortened` notice email (one builder). `{purge_not_before, raw, rollups, attribution}`; each section `{from_days|null (no limit), to_days, cutoff, total, projects[{name, count, oldest, newest}]}`; raw counts are captures, rollup and attribution counts are days; a soft-deleted project is listed with "(deleted project)". All null when no deferral is in force or the date has passed; a section is null when its window is not shorter. Read-only, 0 credits, no export offer (STORY-185 owns export).
