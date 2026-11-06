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
