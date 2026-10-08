# NEW-C-1 — competitor panel: engine_data_source on the one vocabulary (lane c-comp)

Branch 7day/c-comp-3 from f201f35. Spans DEFERRED to week 2 (decision 3).

## Result: already in the tip; this item adds proof and no code
The merge at f201f35 already carries it: `contracts/analytics/competitor-panel-response.schema.ts` declares
`engine_data_source: z.record(z.string(), dataSourceSchema.nullable())` with `dataSourceSchema = live | demo | mixed`, and
`CompetitorPanelService.dataSources` uses the shared `dataSourceOf(live, demo)` (live-only -> live, demo-only -> demo, both -> **mixed**,
neither -> no entry, rendered `null`).

## Proof
- `contracts/analytics/data-source.schema.test.ts` > "competitor panel accepts live/demo/mixed/null per engine" (commit `9e771c5`).
- `test/integration/competitor-panel.spec.ts` > "marks an engine demo when every capture in the window is seeded, live when none is, mixed when both kinds contributed, null when none" and > "an engine with both seeded and real captures in the window is mixed, not demo" (`{ chatgpt: "mixed", gemini: "live" }`). Run on this tip: pass (exit 0).

## Other acceptance criteria
Contract-first (802656d), RED (f59aa3d), implementation (8430b10); brand row, win rate, null-not-0 untracked rows: `competitor-panel.spec.ts`
"STORY-092 #1" x3, "#2", "#4"; `tracking:read` and no `@Audit` in `competitor-panel.controller.ts`; second-workspace 404 under the app role:
"a second workspace reading this project, under the application role, gets 404". The Gemini half of criterion 5 is NOT met this week — see CP1-c-comp.md.

## Gates
Integration (4 c-comp specs + migration spec) exit 0, 58 tests; `pnpm lint` 0; `pnpm typecheck` 0; `pnpm test:unit` 0; `pnpm contracts:check` 0.
