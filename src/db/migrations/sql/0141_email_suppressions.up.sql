-- STORY-178 — email bounce and complaint suppression (owner decisions 8 and 9, 2026-10-26). EXPAND-ONLY: one new table.
--
-- GLOBAL (src/db/conventions.ts GLOBAL_TABLES), no `workspace_id`, no RLS, and that is a decision rather than an omission:
-- a hard bounce is a property of the ADDRESS, and the sending reputation it protects is shared by every workspace, so one
-- suppression covers all of them. The webhook that writes it resolves no workspace (Resend knows none), and a tenant table
-- could not hold its rows. It holds no tenant data and no address: only the peppered HMAC-SHA256 of the normalised address
-- (the same hash the OTP rate-limit ledger and the mail adapter's log line use), so a read of this table cannot enumerate
-- who bounced without the pepper.
--
-- PEPPER ROTATION. `recipient_hash` is keyed on OTP_EMAIL_HASH_PEPPER. Changing that secret re-keys every address, so every
-- existing row would stop matching (a bounced address would be mailed again) and the operator command could no longer find a
-- row to lift. A rotation must therefore re-hash this table's addresses first, which cannot be done from here (the addresses
-- are not stored): either keep the old pepper for suppression lookups or accept losing the list. The API and the report worker
-- must also run the SAME pepper, or the worker's sends skip the check the API's webhook wrote.
--
--   kind               `bounce` (a PERMANENT bounce; a transient one never lands here, it is a metric) or `complaint`.
--                      A bounce suppresses all mail; a complaint suppresses only non-transactional mail.
--   provider_event_id  Svix's message id (`svix-id`). With the hash it is UNIQUE, so a redelivered event is a no-op; the pair
--                      rather than the id alone because one event can list several addresses in `to`.
--   fanned_out_at      when the workspaces whose scheduled reports include the address were told (NULL = not yet; the report
--                      worker's sweep does it, because the webhook route cannot see across tenants).
--   deleted_at         the operator lifted it. The row STAYS, so a replay of the event that created it is still a conflict.
CREATE TABLE email_suppressions (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_hash    bytea       NOT NULL CHECK (octet_length(recipient_hash) = 32),
  kind              text        NOT NULL CHECK (kind IN ('bounce', 'complaint')),
  provider_event_id text        NOT NULL CHECK (provider_event_id <> ''),
  created_at        timestamptz NOT NULL DEFAULT now(),
  fanned_out_at     timestamptz,
  deleted_at        timestamptz,
  CONSTRAINT ux_email_suppressions_event UNIQUE (provider_event_id, recipient_hash)
);

-- Every send looks an address up by its hash among the active suppressions.
CREATE INDEX ix_email_suppressions_active ON email_suppressions (recipient_hash) WHERE deleted_at IS NULL;
-- The fan-out sweep's work list: active suppressions nobody has been told about yet.
CREATE INDEX ix_email_suppressions_unfanned ON email_suppressions (created_at) WHERE fanned_out_at IS NULL AND deleted_at IS NULL;

COMMENT ON TABLE email_suppressions IS
  'STORY-178 — addresses that must not be mailed: the peppered hash, the kind (bounce|complaint) and the provider event. GLOBAL: no workspace_id, no RLS, no address.';

-- The API's webhook route appends; every process that sends mail reads. Nobody but the operator (the owner connection) updates:
-- lifting a suppression and marking it fanned out are not runtime-role writes. Runs after ALTER DEFAULT PRIVILEGES (0005).
REVOKE ALL ON email_suppressions FROM nominara_app, nominara_worker, nominara_report, nominara_portal;
GRANT SELECT, INSERT ON email_suppressions TO nominara_app;
GRANT SELECT ON email_suppressions TO nominara_worker;
