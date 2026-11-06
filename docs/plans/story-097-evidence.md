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
- integrations-and-sharing.md section 2: the design-system class list for `custom_css` selectors (see below) and that `custom_css`
  colours are not contrast-validated.
