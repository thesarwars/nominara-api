# ADR-0002 / 0112 checkpoint-4 (branch 7day/e-portal-5)

Items: (1) membership of nominara_share_lookup untested [blocker], (3) share-token lookup isolation assertion unregistered [major].
Item (2) (NEW-E-099b AC2) is NOT touched here: it needs the owner's ruling, see NEW-E-099b.md.

RED `b22026c`: `migrations.spec.ts` DEF-D1 (hand-added membership) and DEF-D2 (hand-altered BYPASSRLS on the role) failed
because drift-check did not know the role (2 failed, exit 1). DEF-11 (catalog membership test) was added in the same commit
and passes on the clean tree; its failure is shown by the mutation below.

| Requirement | Test |
|---|---|
| No pg_auth_members row with roleid = nominara_share_lookup; no non-superuser role has MEMBER/USAGE/SET | `share-token-lookup-definer.spec.ts` "DEF-11"; isolation `ISO-24` (`iso-24-definer-owner-no-members.ts`, green path in `catalog.spec.ts`) |
| Registered ISO assertion with a breaker that is exactly the GRANT | ISO-24 breaker: `GRANT nominara_share_lookup TO nominara_worker`, reverted with REVOKE (cluster-wide object); `breaker-execution.spec.ts` "ISO-24" |
| Role in the role registry / role-check | `DEFINER_OWNER_ROLES` (src/db/conventions.ts) folded into `checkDrift`: attributes plus a no-members check; DEF-D1, DEF-D2. Not added to `DATABASE_ROLES` because `database-roles-and-grants.spec.ts` migrates 0001-0005 only |
| Finding 3: lookup shape registered with a paired breaker | ISO-25 (`iso-25-share-lookup-definer-shape.ts`: SECURITY DEFINER, search_path exactly `pg_catalog, pg_temp`, owner NOSUPERUSER/NOLOGIN/NOBYPASSRLS, EXECUTE not PUBLIC and held by nominara_app alone); breaker re-grants EXECUTE to PUBLIC. The standalone `share-token-gate-lookup.spec.ts` was removed (ISO-25 is the same checks, now run by a breaker) |

Mutation D2 (append `GRANT nominara_share_lookup TO nominara_worker;` to 0112, restored afterwards): `test:isolation` 1 failed
(ISO-24, exit 1); integration `share-token-lookup-definer` + `migrations` 2 failed (DEF-11, scenario 3b drift), exit 1.
Previously 16/16 and 53/53 passed.

Gates: lint 0; typecheck 0; test:unit 0 (3755 passed, 1 skipped); test:isolation 0 (54 passed); test:isolation:breakers 0
(26 passed, includes ISO-24 and ISO-25); integration (share-token-lookup-definer, share-token-gate-rls, migrations,
database-roles-and-grants, rls-check) 0, 93 passed.
Not run: `db:drift-check` CLI (needs DATABASE_URL; only the owner's 55432 is reachable); the same code path is exercised by migrations.spec.
