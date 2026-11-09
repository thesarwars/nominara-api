import { z } from "zod";

// `POST /v1/projects/fingerprint` (STORY-195, owner decision 87b; product-spec.md FR-ONB-04). A PRE-CREATION suggestion: a root URL in, what the
// site looks like out, each suggestion with its confidence, before any project exists. It writes nothing, belongs to no workspace and charges
// nothing (`credits_charged` is the literal 0). It goes through the guarded fetcher and is bounded in time; a failure to read the site is an
// ANSWER (`status: "unavailable"` with a reason), never an error, because onboarding must be submittable without it (FR-ONB-04).
//
// HONESTY. A suggestion is a reading of the page, never a decision: it carries a confidence and the client pre-checks it editable. The category is the
// taxonomy nearest match discovery uses (STORY-189), as a slug, and is `null` below the 0.60 low-confidence line (`LOW_CONFIDENCE_THRESHOLD`): a guessed
// category would make every category-relative comparison silently wrong, since `category_slug` is the benchmark join key. What cannot be derived is SAID,
// in `not_derived`, and never faked: `category` is named there when it could not be classified this time (the provider failed or the deadline passed;
// the page was still read), and `verticals` always (the taxonomy carries none). `category: null` with `category` in `not_derived` reads "this endpoint
// cannot say", where `null` alone reads "looked and found nothing sure enough".

/** The platforms a page can be recognised as. A closed set: a platform is only named when a marker for it was found. */
export const FINGERPRINT_PLATFORMS = ["wordpress", "shopify", "wix", "squarespace", "webflow", "framer", "ghost", "drupal", "joomla", "hubspot"] as const;
export const fingerprintPlatformSchema = z.enum(FINGERPRINT_PLATFORMS);
export type FingerprintPlatform = z.infer<typeof fingerprintPlatformSchema>;

/** The longest the endpoint waits for the site, in milliseconds. Shorter than the guarded fetcher's own 20 s ceiling: onboarding must not wait on a slow site. */
export const FINGERPRINT_BUDGET_MS = 8_000;

export const fingerprintRequestSchema = z
  .object({
    root_url: z
      .string()
      .url()
      .max(2048)
      .refine((value) => /^https?:\/\//i.test(value), { message: "root_url must be an http(s) URL" }),
  })
  .strict();
export type FingerprintRequest = z.infer<typeof fingerprintRequestSchema>;

const suggestion = <T extends z.ZodType>(value: T) => z.object({ value, confidence: z.number().min(0).max(1) }).strict();

export const FINGERPRINT_UNAVAILABLE_REASONS = ["budget_exceeded", "unreachable", "http_error", "not_html"] as const;

export const fingerprintResponseSchema = z
  .object({
    root_url: z.string(),
    status: z.enum(["complete", "unavailable"]),
    /** Why the site could not be read; null exactly when `status` is `complete`. A short code, never the underlying error's message (it can carry an address). */
    reason: z.enum(FINGERPRINT_UNAVAILABLE_REASONS).nullable(),
    category: suggestion(z.string().min(1)).nullable(),
    verticals: z.array(suggestion(z.string().min(1))),
    platform: suggestion(fingerprintPlatformSchema).nullable(),
    /** The fields this endpoint cannot derive at all (as opposed to derived-and-found-nothing). */
    not_derived: z.array(z.enum(["category", "verticals"])),
    duration_ms: z.number().int().nonnegative(),
    credits_charged: z.literal(0),
  })
  .strict()
  .superRefine((r, ctx) => {
    if ((r.status === "complete") !== (r.reason === null)) {
      ctx.addIssue({ code: "custom", message: "a reason is present exactly when the site could not be read", path: ["reason"] });
    }
    if (r.status === "unavailable" && (r.platform !== null || r.category !== null || r.verticals.length > 0)) {
      ctx.addIssue({ code: "custom", message: "an unavailable fingerprint carries no suggestion", path: ["status"] });
    }
  });
export type FingerprintResponse = z.infer<typeof fingerprintResponseSchema>;
