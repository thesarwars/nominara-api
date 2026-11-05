# STORY-180 - report artifacts in object storage: evidence and status notes

Owner decision 54 (2026-11-02) answers the story's four open decisions. Built on it:

| Decision | Built as |
|---|---|
| (1) Keep E-0, upload after commit | `ExportService.export` records the row with `object_key = 'pending:<id>'`, presigns locally, and registers the upload with `afterCommit`. The upload (`put`, no transaction open) is followed by ONE short tenant transaction that records the real key. No async job. |
| (2) On-screen link = 15-minute presign, re-presigned on each fetch | `download_url` is `presignGet("reports", "<id>.<format>", 900 s)`, minted on every export response. `EXPORT_DOWNLOAD_URL_SECONDS` in `contracts/reports/export.schema.ts`. |
| (3) 7-day emailed link = stored revocable token, then a fresh 15-minute presign | `GET /v1/report-links/{workspaceId}/{token}` (public, tenant-less, 302). Migration 0161 adds `report_artifacts.link_token_hash` (SHA-256, unique where set) and `link_revoked_at`. The link lives until the artifact's own `expires_at` (7 days from build). |
| (4) 8 MB = 8,388,608 bytes | `REPORT_ATTACHMENT_MAX_BYTES`. A file of at most that is attached, one byte more is linked. |

## Design points a reviewer should know
- **The link token is derived, not random:** `HMAC-SHA256(QUEUE_JOB_SIGNING_KEY, "nominara/report-artifact-link/v1:" || artifact_id)`, base64url (43 chars). A cadence delivery that fails is retried with the SAME artifacts and its email must stay byte-identical (Resend refuses a changed body under one idempotency key); a random token cannot be recovered from the stored hash. Only the SHA-256 is stored. Rotating the key does not break an issued link (lookup is by the stored hash).
- **The route's workspace id is a lookup scope, not a credential.** It selects whose RLS the two statements run under (system actor). A token presented under another workspace's id finds no row. Every refusal (unknown, wrong workspace, revoked, expired, upload never landed, key outside the workspace prefix) is the same 404.
- **The API origin for the link is `OAUTH_REDIRECT_BASE_URL`** (the only existing setting that names the API's public origin). If a dedicated setting is wanted, that is a one-line change in `mailDepsFromEnv`.
- **Known windows, by design of decision 54 (1):** (a) the response carries a presigned URL a few milliseconds before the post-commit upload lands; (b) an `Idempotency-Key` replay returns the first response, whose 15-minute URL may have expired; (c) a failed upload leaves the row `pending:` (counted `nominara_reports_artifact_uploads_total{outcome="put_failed"}`, logged, link route 404, cadence resume rebuilds it).
- A scheduled email resolves its files once, before the first recipient. A file that never reached storage fails every recipient (nothing is mailed), so the delivery reads `failed` and the cadence path retries.
- Observability: span-shaped log lines `reports.artifact.upload`, `reports.link.resolve`, `reports.scheduled.mail_artifacts` (workspace ID only); metrics `nominara_reports_artifact_uploads_total{outcome}`, `nominara_reports_link_clicks_total{outcome}`, `nominara_reports_mail_artifacts_total{outcome}`.

## Not built (needs an owner decision or another story)
- **Revocation has no endpoint.** `link_revoked_at` is honoured on every click; nothing sets it yet. Who may revoke, and from where (an artifact list, the scheduled-report history), is a product question.
- **The client** (`app-fnt-dev-main`) must stop decoding `data:` and open `download_url` instead (AC4 second half).
- **Real buckets (STORY-003)** are not part of this change; LocalStack/dev backend only.

## Doc changes to carry to the docs repo
- `stories/agency/STORY-180`: record decision 54 in the open-decisions section, tick the AC, add the Test scenarios table (the story has none) and a Technical notes list.
- `references/integrations-and-sharing.md` section 5 "As built": attachment up to 8 MiB, link through `GET /v1/report-links/{workspaceId}/{token}`; remove the "Open (owner)" STS bullet.
- `references/system-architecture.md` section 8: the STS open item is resolved by option 3B; the reports key layout `{env}/{ws}/{artifact_id}.{pdf|csv}`.
- `references/api-specification.md`: `POST /projects/{id}/reports/export` returns a presigned https `download_url` (15 min); add `GET /report-links/{workspaceId}/{token}` (public, 302, 404 for every refusal).
- `schemas/tools-attribution-agency.md`: `report_artifacts.link_token_hash bytea`, `link_revoked_at timestamptz`; `object_key` is `pending:<id>` until the upload is recorded.
