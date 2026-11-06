# STORY-097 evidence (week 2, API side) — branch story/097-099-agency

Built: the style override (`custom_css`) allow-list parser, the email footer sanitiser, the SVG sanitiser and the asset limits
(pure libs in `src/lib/theme/`), and PUT /agency/theme wiring for `custom_css` and `email_footer_html`. No migration: both
columns already exist on `brand_themes` (migration 0169 stays unused by this story).

| AC | State | Evidence |
|---|---|---|
| Style override: property allow-list, design-system selectors | Met | `custom-css.spec.ts`; `agency-theme-http.spec.ts` scenario 12 |
| No external refs / imports / generated content / fixed positioning | Met | `custom-css.spec.ts` (incl. obfuscation), `agency-theme-http.spec.ts` scenario 13 (400 naming the construct, nothing stored, no audit row) |
| Parsed, re-serialised; unrecognised input dropped and reported back | Met | the PUT response carries `dropped`; stored text asserted equal to the re-serialised one |
| Email footer is a sanitised subset | Met | `email-footer.spec.ts`; `agency-theme-http.spec.ts` footer test; footer is editor-only (`portal-reads-http.spec.ts`) |
| Vector sanitised and re-serialised; construct named | Library met | `svg-sanitiser.spec.ts`, `asset-limits.spec.ts` (scenario 9, 10). NOT reachable over HTTP yet: see below |
| Raster/vector logos and favicon within limits | Library met | as above |
| Assets served from the platform origin | Open | no upload or serve route |
| Brand removal: no platform name in portal | Partial | `portal-reads-http.spec.ts` content scan of the portal overview (values only). Exports/emails: no scan; no email render path exists |
| Single stored theme drives emails / sender identity / preview | Open | unchanged: no mail transport themed render |

## Doc changes needed (docs repo; NOT edited here)
- STORY-097: status line and the AC table above; scenarios 12, 13 now have tests.
- api-specification.md section 3: `PUT /agency/theme` accepts `custom_css`, `email_footer_html`; the response carries `dropped`
  `{custom_css[], email_footer_html[]}`; a refusal is 400 `validation_failed` with `details.refused[{construct,message}]`.
- integrations-and-sharing.md section 2: the design-system class list for `custom_css` selectors (below), and the colour rule:
  colours in `custom_css` are only `var(--nm-color-primary|accent|bg|fg)`; each rule's resulting pair is contrast-checked at save
  (text 4.5:1, border/outline 3:1, a side the rule does not set is the theme's own); a failing rule is a 400 `contrast` refusal with
  the measured ratio; literal colours are dropped and reported. font-size under 10px and negative margins are dropped.
- Email footer: named entities decoded are amp, lt, gt, quot, apos, nbsp, copy, reg, trade, mdash, ndash plus numeric references;
  an unknown one is removed and reported.

## Design-system class list (`DESIGN_SYSTEM_CLASSES` in `src/lib/theme/custom-css.ts`)
`nm-card`, `nm-kpi`, `nm-heading`, `nm-table`, `nm-button`, `nm-badge`, `nm-nav`, `nm-chart`. NEW VOCABULARY that no reference or
client defines yet; the portal serves override text that matches nothing until the client ships these hooks.

## Owner questions (open; recorded here so they survive the scratchpad)
1. Is the `nm-*` hook list above the right set, and is the client to ship it? (client stream)
2. Asset route: where are logos / favicons uploaded and served (platform origin; serve stored re-serialised bytes with the
   validated Content-Type, `Content-Security-Policy: default-src 'none'`, `X-Content-Type-Options: nosniff`)? Needs an endpoint
   spec; not invented here.
3. Colour contrast in `custom_css` is CLOSED on the API path (review round 1): token references only, pair-checked. Confirm the
   approach, and the token names `--nm-color-*` (new vocabulary).
4. Per-rule judgement is an approximation: a descendant or hover state is judged as its own rule; a nested element over an
   unrelated background is not knowable server-side.

## Known follow-ups
- Portal overview cache is keyed on `themeId`, not theme content, so an edited `custom_css` (and colours) reach portal viewers
  only after the cache TTL. Fix: add a theme revision to `policyFingerprint` or invalidate on PUT /agency/theme.
- SVG/asset libraries have no upload or serve route (ACs open, above).

## Round 3 - owner decision 67 (n) and (o)

- (n) `POST /v1/themes/{id}/assets` (agency:branding, audited `agency.theme_asset_uploaded`) takes `{slot, content_type, data_base64}` and accepts PNG, JPEG and WebP only, <= 1 MiB (logo <= 1200x400; favicon PNG/JPEG/WebP <= 100 KB, square; ICO refused). An SVG is refused naming the file type; `svg-sanitiser.ts` and its spec were deleted in review round 2 (nothing calls them). The object is written to the `reports` bucket under `{env}/{workspace}/branding/{theme}/{slot}-{uuid}.{ext}` AFTER the request transaction (afterTransaction); the key is recorded in its own short tenant transaction only once the write succeeded. `GET /v1/themes/{id}/assets/{slot}` answers 302 to a 60 s presign; `logo_url` on the theme is that platform path. Tests: `test/integration/agency-theme-asset-http.spec.ts`, `src/lib/theme/asset-limits.spec.ts`.
- (o) The portal cache key now digests the theme content (`policyFingerprint`), so a theme update is a cache miss on the next request. Test: `portal-reads.service.spec.ts`.
- The integration harness's app role does not enforce RLS (a PUT naming another workspace's theme id returns 200 there), so cross-workspace isolation for the asset columns rests on `agency-theme-rls.spec.ts` / `test:isolation`, not on an HTTP assertion.

Doc changes needed: api-specification.md section 3 lists `POST /agency/theme/assets` (pre-signed upload, <= 2 MB, PNG/SVG/WebP, SVG sanitised); decision 67 (n) replaced it with `POST /themes/{id}/assets` (JSON base64, <= 1 MiB, PNG/JPEG/WebP, SVG refused). integrations-and-sharing.md section 2 and STORY-097 AC "Assets" (vector sanitised and re-serialised, 2 MB) need the same carry. The story's status check rows for raster limits / assets-from-own-origin move to Met on the API side.

## Review round 2 (round-1 findings) - what changed

- Cross-workspace: `agency-theme-asset-http.spec.ts` now boots with `runAsAppRole: true`; a foreign upload and a foreign fetch are 404 and the foreign row's keys stay null. Red against the superuser connection: `logs/s097-r4-red-superuser.log` (201 instead of 404). `agency-theme-rls.spec.ts` adds `assetKey` and `recordAssetKey` (own pool connection) cases as `nominara_app`; red with the recorder on a superuser pool: `logs/s097-r4-red-mutated.log`.
- Portal: `themeForPortal` sends `logo_url: null` (the stored logo's only route needs a workspace session + agency:branding). OPEN: a portal-session logo route (e.g. `/portal/theme/assets/{slot}`, resolved from the session's pinned theme) is not built; the white-label logo is therefore not shown in the portal.
- Audit: the `@Audit` interceptor row is now `agency.theme_asset_upload_requested` (accepted request); `agency.theme_asset_uploaded` is appended inside `recordAssetKey`'s transaction, so a failed write leaves no "uploaded" row. A `recordAssetKey` failure deletes the just-written object best-effort.
- Favicon follows decision 67 (n): PNG/JPEG/WebP, square, <= 100 KB; the ICO branch is gone.
- (o): `portal-reads-http` case: a theme edit shows on the next request with the same token; red without the content digest.
- NOT done (needs owner/product): presign `ResponseContentType`/`nosniff` (the storage port's `presignGet` has no such option; widening it is outside this story's files). Scenario 11 "served from the platform origin" is PARTIAL: the route answers 302 to the object-store host, so the portal CSP `img-src` must list that host (stopped_for_owner #3).

### Doc changes for the docs repo
- api-specification section 3 / integrations-and-sharing.md section 2: `POST /themes/{id}/assets` (not `/agency/theme/assets`), 1 MiB limit, SVG refused (not sanitised), favicon PNG/JPEG/WebP (no ICO).
- STORY-097: scenario 11 Partial; new audit actions `agency.theme_asset_upload_requested` + `agency.theme_asset_uploaded`.
