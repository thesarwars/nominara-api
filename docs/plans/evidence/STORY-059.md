# STORY-059 - alignment, coverage, semantic nodes, projected gain (status after review round 3)

Branch story/059-semantic-alignment (unmerged). AC numbers follow the story as numbered after round 2 (AC1 = the 0151 key migration).

## Status by criterion (only the ones with a caveat; the rest are met and tested in test/integration/geo-alignment.spec.ts)

- **AC2 - a session opens for a URL and cluster: LIBRARY ONLY.** `openAlignmentSession` exists and is tested end to end, but nothing
  calls it in production: there is no job processor that runs it and no endpoint that requests it. It is a library, not a feature.
- **AC6 - typed by the deterministic map; near-duplicates collapsed: MET WITH A DISCLOSURE.** The collapse is persisted since round 3
  (`semantic_nodes.collapsed_into_id`, migration 0151): collapsed rows are kept and marked, extraction does not re-insert or re-embed
  them, every reader excludes them, and a keeper that disappears releases its rows (ON DELETE SET NULL). `analyseNodes` also reports
  `pending` and does nothing while a node of the scope lacks a vector. **Disclosure: the deterministic type map
  (`src/lib/geo/alignment/node-types.ts`) never produces `entity` or `differentiator`.** Both are valid `node_type` values in the
  contract and the table, but no rule yields them, so a node can only be compliance, metric, pricing_term, integration, industry,
  persona or capability. Producing them needs a rule set the reference does not define; it is not built.
- **AC7 - a close semantic match is present: OPEN (half).** Exact normalised-phrase presence only. Blocked on an owner decision about
  where content-phrase vectors live: `plans-7day/questions-059-presence-vectors.md`.
- **AC11 - draft recompute is debounced, in-database, inside its objective, free: OPEN.** The draft recompute exists as a library
  (`computeAlignment` with a draft). The job processor, the draft endpoint and the debounce are not built. Carried to a named follow-up:
  **STORY-059-F1 "alignment job processor, draft endpoint and debounce"** (proposed name; to be filed with the owner), which also
  carries AC2's production caller.

## Review round 3 evidence

Red run: `plans-7day/logs/059-r3-red.log` (6 failed of the new tests before any fix: the hazard test failed with "no embed request for a
collapsed phrase: expected 1 to be 0"). Green and mutation runs: `059-r3-green*.log`, `059-r3-mut*.log` (survivors found and fixed in
the tests: coverage denominator and the model-change un-collapse; both now killed).
