# STORY-085-A evidence — POST /v1/command/parse (checkpoint-2 close-out)

Lane worktree `api-wt-b2`, branch `7day/b-ws-3`, from integration/7day f201f35. Date 2026-10-08.

Commits: earlier `046f3ba` (contracts), `5f6113e` (RED), `0c034c2` (impl), `5d84e05` (audit RED), `c661dc7` (audit fix); this pass RED `12b3619`,
fix `8d3aeca`.

## CP2 findings and how each was closed

1. Audit row stored the parse response, so `slots` (verbatim customer text, e.g. `{email:'jo@acme.io'}`) reached the append-only `audit_log`.
   Closed: `AuditOptions.afterState` (a selector), used by `CommandController.parse` to record exactly `{intent, resolved_by, cached, confidence}`.
   Files outside the story's Technical Notes were touched for this, as the minimal route: `src/api/decorators/audit.decorator.ts` (one optional
   field) and `src/api/interceptors/audit.interceptor.ts` (one expression). Default behaviour for every other route is unchanged (own test).
2. The integration audit test passed vacuously (a long high-entropy address that `redactState` strips by itself, and it only checked `before_state`).
   Closed: it now uses short low-entropy phrases and checks the stored `after_state` keys and that no customer text appears anywhere in the row.
3. "Never mutates" compared row counts, so it could not see an UPDATE. Closed: it fingerprints every public table's content
   (`md5(string_agg(t::text ...))`) and requires that exactly one table changed (`audit_log`) and gained exactly one row, across every intent plus
   unresolved and ambiguous input; the queue producer spies (`enqueueTenantJob`, `dispatchPlannedCells`) are never called.
4. "every role gets 200 ... 120/min bucket" FAILED at f201f35: the test expected `X-RateLimit-Limit: 120` but the guard deliberately reports the
   bucket CAPACITY in tokens (`buckets.ts`: `limit: config.burst`, beside `remaining`), i.e. 30; 120/min is the refill. The test was wrong, not the
   code. It now asserts the header equals the configured burst of the `command_parse` class from `RATE_LIMIT_DEFAULTS`; the 120/min bucket itself stays
   pinned by `test/unit/rate-limit-buckets.spec.ts` ("command_parse / user is 120 per 60000 ms") and `command.spec.ts` ("is rate-limited as command_parse"). No threshold changed.
5. Metric and log line were not asserted directly. Closed: `command.spec.ts` > "emits nominara_command_parse_total with outcome and cached, and a log line
   with the workspace ID and no query text".
6. `requires_confirmation` pinned for only one of eight mutating intents: already closed by `5d84e05` (`it.each(COMMAND_INTENTS)`), still green.
7. 500 on every live request (no `@Audit()`): closed by `c661dc7`; `test/unit/audit-coverage.spec.ts` is green in the full unit run.

## RED (`12b3619`)

- `vitest run src/modules/command src/api/interceptors/audit.interceptor.spec.ts src/modules/prompts/topics.controller.spec.ts`: exit 1, 7 failed / 63 passed
  (no `afterState` selector exists; the interceptor records the whole body). Reason matches.
- Integration (`command-parse-http`, `workspace-summary`): exit 1, 5 failed / 10 passed; the 4 audit-row cases fail with
  `expected [ 'actions', 'cached', ... ] to deeply equal [ 'cached', 'confidence', 'intent', 'resolved_by' ]` (the stored row held the full response).
- The content-fingerprint and header cases are green at RED: they characterise existing behaviour (the parse really writes only its audit row).

## Acceptance criteria

| Criterion | Proof | Result |
|---|---|---|
| Contracts in own commit; intents defined in exactly one place | `046f3ba`; `command-intent-single-source` unit test | met |
| A parse never mutates and never enqueues; test instruments DB writes and the queue producer across every intent | `test/integration/command-parse-http.spec.ts` > "no table's CONTENT changes except audit_log's one appended row, and nothing is enqueued"; `command.spec.ts` > "STORY-085 #11 ... only cache writes are the parse-cache entry" | met, with the audit row as the single allowed write (see Owner decision) |
| Unresolved input: intent `unresolved`, suggestions, cost 0, no model escalation, no debit | `command.spec.ts` "STORY-085 #8"; integration "every role gets 200 ... 0-credit answer" | met |
| Ambiguous input returns candidates, not a guess | `command.spec.ts` "STORY-085 #12" | met |
| Rate limit 120/min per api-spec section 12 | `rate-limit-buckets.spec.ts` (120 / 60 s, burst 30); `command.spec.ts` route class; integration header | met |
| Auditor confirms no CreditGuard/ledger path reachable | see "Ledger review" | engineer review recorded; independent auditor verdict NOT recorded (no auditor agent available to this lane) |

## Ledger review (engineer's, for the dangerous-area-auditor to confirm)

- No `@Credits` on the handler or class (test), the service's only dependency is `CACHE` (test), and no source file in the module imports
  db/credit/billing/queue/engine paths (test). The integration fingerprint covers every table, so any credit-ledger/wallet write would fail it.
- Mutation evidence: removing `afterState` fails the new unit and integration cases (RED); the CP2 QA mutations M1-M8 are recorded in the QA report.

## Owner decision still needed (not decided by this lane)

STORY-085 scenario 11 reads "Zero writes". The merged tip (`c661dc7`) chose to audit each parse (`command.parsed`), mirroring `POST /runs/estimate`,
because `AuditInterceptor` fails closed on any POST. This pass keeps that choice and only removes the leak. If the owner prefers the other option
(a narrow read-only POST marker honoured by the interceptor and the audit-coverage sweep, so a parse writes nothing), that is a gate change and needs
a written decision; otherwise STORY-085 #11 should be amended to "the only row written is the outcome-only audit row". The docs repo has no `.git` here,
so the amendment has to be carried over by hand.

Also open (not blocking): where the shared intent list lives for the frontend `lib/command/grammar.ts` (owner decision from the plan).

## Tracing

OpenTelemetry spans are DEFERRED to week 2 (owner decision R3). No tracer exists in the repo; a missing span is not a failed criterion this week.
The metric `nominara_command_parse_total` and the redacted log line (workspace ID only, never the query) are in place and now asserted.

## Gates (tip `8d3aeca`)

| Command | Exit |
|---|---|
| `pnpm lint` | 0 |
| `pnpm typecheck` | 0 |
| `pnpm test:unit` | 0 (278 files, 3331 tests) |
| integration: command-parse-http, workspace-summary, data-source, audit-interceptor-real-pipeline | 0 (27 tests) |
| `pnpm contracts:generate` / `contracts:check` | no diff / 0 |
| `test:isolation`, `:breakers` | not run, known fixture crash (d-admin); no tenant table touched here |

## Needs a running real API

HTTP-level behaviour was proved here over the real guard/interceptor/handler chain in Nest (`app.inject`) against a real Postgres container.
A check against a running deployed API (and the CommandBar showing `resolved_by` and cost) is collected in NEW-A-17.
