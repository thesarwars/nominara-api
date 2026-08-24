# `@nominara/client`

The typed client for the Nominara API. **Generated, never hand-written**
(`project-structure.md` §6) — `src/` and `dist/` are gitignored build output.

```sh
pnpm client:generate   # from the api repo root — writes client/src/
pnpm --dir client build
```

- `types.ts` — request/response types, emitted by `openapi-typescript` from the
  same document `pnpm contracts:check` gates.
- `errors.ts` — the error-code union, rendered from `errorCodeSchema`.
- `index.ts` — `createNominaraClient()`, `openapi-fetch` bound to `paths`.

## Not yet delivered

- **WebSocket event types** — STORY-026 task T24, deliberately out of scope here,
  so AC4 is partially delivered.
- **Publishing** — `version` stays `0.0.0`. NFR-REPO-02 derives the real semver
  from the spec diff in an automated release job; this repository has no CI yet
  (STORY-023 AC6, blocked), so nothing publishes and no `N-1` release exists.
  `test/unit/client-previous-minor.spec.ts` therefore proves shape
  compatibility against a committed proxy document only — read its header.
