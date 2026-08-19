-- STORY-020 fix pass (qa-reviewer blocking finding 1) — closes a marker-
-- forgery hole: nominara_app/nominara_worker both hold an ordinary INSERT
-- grant on audit_log (0005), which AuditInterceptor's request path
-- legitimately uses for every real audit row — but that SAME grant lets any
-- ordinary app-role connection insert a forged 'audit.chain.rechained'
-- marker row too. verifyChain (src/lib/crypto/audit-chain.ts) treats every
-- row strictly before the MOST RECENT marker as exempt from strict
-- content-hash verification (STORY-020-E-9) — a forged marker permanently
-- blinds the verifier for everything before it.
--
-- The marker is legitimately appended from exactly one place today —
-- requestIndividualErasure (src/workers/rollup/retention.ts) — which already
-- runs on a PRIVILEGED (table-owner-class) connection, because it also
-- issues `ALTER TABLE audit_log DISABLE/ENABLE TRIGGER`, an operation table
-- ownership gates on its own. Neither nominara_app nor nominara_worker is
-- ever that connection (see retention.ts's own PRIVILEGE CONTRACT comment).
-- This trigger enforces the same boundary at the row level, following the
-- exact convention 0002/0004's `reject_update_delete` already uses — a
-- trigger function in schema `app`, raising with a specific SQLSTATE —
-- rather than a new table or a new runtime role.
--
-- A CHECK constraint referencing current_user was considered and rejected:
-- Postgres's own documentation warns CHECK expressions should be IMMUTABLE,
-- and lists current_user as an example of a value that is not. A BEFORE
-- INSERT trigger carries no such restriction.
CREATE OR REPLACE FUNCTION app.reject_rechained_marker_from_runtime_roles()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.action = 'audit.chain.rechained' AND current_user IN ('nominara_app', 'nominara_worker') THEN
    RAISE EXCEPTION 'audit_log: % marker rows may only be inserted by a privileged (table-owner-class) connection, not %',
      NEW.action, current_user
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER reject_rechained_marker_from_runtime_roles
  BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION app.reject_rechained_marker_from_runtime_roles();
