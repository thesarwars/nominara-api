# Checkpoint-2 d-billing fixes: failing integration specs

Source: plans-7day/checkpoint-2-gates.md (integration on f201f35). Two of this lane's specs were red; the third item (track-e-sharing-migration) is re-checked.

## 1. credit-guard-settlement.spec.ts > "the refusal carries the required amount, the bucket split and the tier-filtered packs"
- Cause: the test asserted `packs: []`, true only while `credit_packs` was empty. Migration 0076 (STORY-076a) now seeds `starter_vault` for every tier, so a free workspace is correctly offered it. The code was right, the expectation was stale.
- RED: at base f201f35, exit 1, 1 failed (`packs` expected `[]`, received `[{key: "starter_vault", credits: 1000, price_usd: "15.00"}]`).
- Fix (59ad257): the assertion now names the exact tier-filtered set, `[{ key: "starter_vault", credits: 1000, price_usd: "15.00" }]`. This is stronger, not weaker: `toMatchObject` compares arrays by length, so a leaked above-tier `agency_vault` fails it. Mutation proof: removing the tier predicate in `purchasableOptions` (`AND true`) fails this test (1 red of 32).
- GREEN: spec exit 0, 32 passed.

## 2. credit-ledger-schema.spec.ts > "rolls back cleanly when no request key has more than one attempt" (and its sibling)
- Cause: `rollBackToTwentyTwo` popped at most 20 migrations; 0022 now sits under more than 20 later migrations, so it threw "rolled back twenty migrations without reaching 0022".
- RED: at base f201f35, exit 1, 1 failed (the helper's throw).
- Fix (59ad257): the bound is the count of applied migrations, queried at the start, instead of a guess. It still pops one per pass, still stops at 0022, and still throws if 0022 is never reached. The rollback assertion (`rolled === "0022_credit_ledger_attempt"`, column dropped, re-apply) is untouched; nothing weakened.
- GREEN: spec exit 0, 7 passed (the two specs together: 39 passed).

## 3. track-e-sharing-migration.spec.ts
- The gates file at f201f35 does not list it as failing; the merge step already kept the "roll back until 0052" loop (e-reports-2 merge). Re-run on this tip: exit 0, 4 passed. Nothing to change. (The lane note that it "hard-codes rollbackLast returns 0052" is out of date at this tip.)

## 4. The 17-failure list: files this lane does not own
The other six failing files in the gates list belong to a-api, b-ws, c-src and e-reports. Not touched.

## Gates
Same table as NEW-D-2.md: lint 0, typecheck 0, unit 0 (3313 passed), the nine billing/credit integration files 0 (205 passed).
