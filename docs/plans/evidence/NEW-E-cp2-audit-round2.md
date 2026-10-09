# NEW-E checkpoint-2 audit, round 2 (branch 7day/e-portal-3)

Host free disk at the time of this work: 7.7 GiB (under the 8 GiB testcontainers floor), so no integration or isolation spec was run. Nothing below claims a green integration run.

1. Isolation gates: NOT RUN (disk, and the support_grants fixture crash belongs to the d-admin lane). Must run test:isolation and test:isolation:breakers on the merged tip with >= 8 GiB free. The share-token lookup owner assertion is not an ISO-* assertion and has no breaker; the integration DEF-1..10 suite (mutation-proven) stands in for it. Registering an ISO assertion plus breaker is a story, not done here.
2. STORY-099 s14 (rollups only): OPEN, needs an owner ruling (amend s14/AC for 099a, or rollup-only portal projections for engineConfig measured, last_capture, engineDataSourcesForDates). Not built.
3. NEW-E-099b: stays partial. GET /portal/sources not built; blocked on source_domains portal access (owner decision).
4. CP2 QA red specs: scheduled-report-deliveries-fk.spec.ts (CP1-E-FK-6) and share-token-views-fk.spec.ts (CP1-E-FK-12) now roll back UNTIL their migration (same pattern as track-e-sharing-migration.spec.ts). Written, not run (disk). These specs were red at the base because 0112 is newest; the failure is the pre-fix state. Gates: pnpm lint exit 0, tsc --noEmit exit 0.
   Open CP1 MINORs, not resolved: (1) themeForPortal serves stored hide_nominara_brand without a whitelabel.remove_branding re-check; (2) store() treats an empty scope as unrestricted; (3) first-theme race. Each is a behaviour change needing its own red test and a running DB.
