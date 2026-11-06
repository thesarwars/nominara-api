# STORY-110 evidence - abuse suites (api half)

Branch `story/110-abuse-suite`, from origin/main f545da3c. No migration (0166 not needed). Red runs: `plans-7day/logs/s110-red-*.log`; green: `s110-green-*.log`; gates: `s110-gate-*.log`.

## What the pack is

An indexed set of adversarial specs that run inside the existing gates on every push (`test:unit`, `test:integration`, `test:isolation`); `test/unit/abuse/suite-index.spec.ts` fails if any spec the ACs lean on is deleted.

| AC | Spec |
|---|---|
| Guarded-fetch rejection | NEW `test/unit/abuse/guarded-fetch-abuse.spec.ts` (every spelling of an internal address, rebinding answers, ports, schemes) + `src/lib/net/guarded-fetch.test.ts` (per-hop re-check, caps) |
| Prompt injection | NEW `test/unit/abuse/prompt-injection.spec.ts`: differential (injected text vs inert filler of equal length) over the parser, the arbiter envelope, the aux rule engine on a crawled page, and the task template/fingerprint |
| Enumeration | NEW `test/integration/abuse-workspace-enumeration.spec.ts`; identity: existing timing specs; share token: `portal-session-http.spec.ts` s6/s16 |
| Unknown keys | NEW `test/unit/abuse/unknown-keys.spec.ts` (entitlement, action, engine) |
| Portal read-only | NEW `test/unit/abuse/portal-read-only.spec.ts` (layer 1, route table) + `portal-context-http.spec.ts` (layer 2) + `isolation/portal.spec.ts` ISO-10 (layer 3) |
| Step-up | NEW `test/unit/abuse/step-up-sweep.spec.ts` |

## Findings (each has a regression test that was red first)

| # | Severity | Finding | Fix |
|---|---|---|---|
| F-1 | High (conditional on NAT64/6to4 egress), otherwise medium | `isGloballyReachable` unwrapped only the dotted `::ffff:a.b.c.d` form. `URL` rewrites `[::127.0.0.1]` to `[::7f00:1]`, and NAT64 (`64:ff9b::/96`), SIIT (`::ffff:0:0:0/96`), 6to4 (`2002::/16`) and site-local (`fec0::/10`) addresses all passed. The RFC 5737 TEST-NETs and `192.88.99.0/24` also passed. | `embeddedIpv4()` extracts the IPv4 from every embedding and judges it; ranges added to the block list |
| F-2 | Medium | `assertSafeUrl` accepted an EMPTY resolver answer (no address to pin the connection to). | refuse as `dns_resolution_failed` |
| F-3 | Medium | `POST /workspaces/:id/switch` checked workspace status before membership: a nonexistent id and a suspended foreign workspace answered `workspace_suspended`, an active foreign one `not_a_member`. Three shapes mapped which ids exist and in what state. | membership first; a non-member gets one refusal; a member still learns their own workspace is suspended |
| F-4 | Low | `CreditGuard` read an unknown `@Credits` action as price `null` and let the route run UNPRICED. TypeScript forbids it at compile time; the runtime half was missing. | `UnknownCreditActionError`, thrown before any wallet access |

Triaged without a code change:

| # | Severity | Decision |
|---|---|---|
| T-1 | Low | `entitlementOverridesSchema` is `.strict()` but zod drops an own `__proto__` key instead of refusing it. Nothing reads it, so it grants nothing. Accepted; noted in the spec. |
| T-2 | Low (follow-up) | `export-csv.ts` prefixes any cell starting with `-` with `'`, which also hits a NEGATIVE numeric value (e.g. a negative sentiment score becomes `'-0.2`). Safe, but the figure is no longer a number in a spreadsheet. Needs a decision: exempt cells that are plain numbers (a numeric cell cannot be a formula). |
| T-3 | Design question | A revoked or expired share token answers `token_revoked` ("no longer available") while an unknown secret answers `401 unauthenticated`. Only the holder of a 256-bit secret can tell them apart, so this is not enumeration, but the story's "ONE neutral refusal" wording could be read either way. Owner to confirm. |

## Open (owner, vendor or other repo)

- External review (isolation, ledger, fetcher), its findings list, the no-open-critical/high record and triage: owner or vendor.
- Adversarial rendering of every capture surface in the app: client repo (app-fnt-dev-main). The API emits no markup from engine text (JSON, CSV with formula neutralisation, PDF text).
- Multi-account abuse SIGNAL: EC-49 names signup velocity per network and per-account cost alarms feeding a weekly review; none exists. The metric names, thresholds and the "never auto-block" rule need a spec decision. The existing controls (daily cap independent of the wallet, a purchase not lifting it, one owned workspace per user) are covered by existing specs.
- Nightly staging isolation run that blocks deploys (needs a staging environment); secrets/dependency/image scanning in CI; paging integration for audit-verify and wallet replay; per-action step-up for actions that have no route yet (`workspace:delete`, `sso:configure`, `agency:custom_domain`).
- Step-up scope: the prose list in security-and-tenancy.md names "integration credential creation" and "share-token password changes", which the permission table does not mark step-up and which have no route/permission of their own (a share-token password is set at mint under `share_token:mint`). Decision needed before a sweep can include them.
- Merge-without-regression-test gate (scenario 3): process/CI policy, not code in this repo.

## Doc changes needed (carry to the docs repo)

- STORY-110 status: ACs "Guarded-fetch rejection", "Unknown keys", "Portal read-only" (all three layers asserted), "Enumeration" (workspace id), "Prompt injection" (parser, arbiter, crawled pages, task generation) move to Met in the api; the rest stay open as listed above.
- security-and-tenancy.md: state that `POST /workspaces/:id/switch` refuses a non-member identically whether or not the workspace exists (F-3); decide T-3 wording.
- edge-cases-and-slos.md EC-49: define the abuse signal (metric names, thresholds) before it is built.

## Owner decision 68(e) and slow unit specs

- CSV export: a cell starting `-` is quote-prefixed only when it is not a plain decimal number (`src/lib/reports/export-csv.ts`; `test/unit/reports/export-csv-injection.spec.ts`, red first: 5 failures, then green). `= + @ tab CR` still prefix.
- Slow unit specs: the cost is the cold import of every `*.controller.ts` graph in `discoverContractRoutes()` (awaited serially), paid once per contract/client spec file. Imports now run concurrently (worked-example 2.95 s to 1.8 s cold). No timeout changed.
- Not fixable by code: `guarded-fetch.test.ts` scenario 15 waits a real 10 s by design; `document-model-budget.test.ts` is a latency budget; `worker.spec.ts` boots the app context per test (about 2.2 s each).
- Doc note: the CSV rule in the reports reference should read "quote prefix on `-` only for non-numeric cells".
