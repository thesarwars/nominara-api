import { z } from "zod";

// STORY-113 - api-specification.md section 3: `GET`/`POST`/`DELETE /projects/{id}/attribution/config`
// (`workspace:update`, step-up on the two writes) and `POST /ingest/attribution` (site-token auth, public).
//
// THE SCHEMA IS THE PRIVACY POSTURE. The ingest request carries a landing URL, a referrer and an optional conversion, and the
// stored row (schemas/tools-attribution-agency.md, `attribution_daily`) has columns for the landing URL, the referrer class, a
// coarse country and a device category - nothing that could name a visitor. There is no session, visitor or cookie field here
// because there is none to send.

/** `attribution_configs.method` CHECK. */
export const ATTRIBUTION_METHODS = ["script", "ga4"] as const;
export type AttributionMethod = (typeof ATTRIBUTION_METHODS)[number];

/** `attribution_configs.status` CHECK. `stale` is derived on read from the last event time; see the service. */
export const ATTRIBUTION_STATUSES = ["pending", "receiving", "stale", "disabled"] as const;
export type AttributionStatus = (typeof ATTRIBUTION_STATUSES)[number];

/** `attribution_daily.referrer_class` CHECK. `unattributed_direct` is a first-class class, never dropped (NFR-ANL-09). */
export const REFERRER_CLASSES = ["chatgpt", "perplexity", "gemini", "claude", "copilot", "meta_ai", "other_ai", "unattributed_direct"] as const;
export type ReferrerClass = (typeof REFERRER_CLASSES)[number];

export const MAX_ALLOWED_ORIGINS = 20;
export const MAX_CONVERSION_EVENTS = 20;
export const MAX_CONVERSION_EVENT_NAME_LENGTH = 64;
export const MAX_LANDING_URL_LENGTH = 2048;
export const MAX_REFERRER_LENGTH = 2048;
/** The beacon body is a few hundred bytes. Anything near this is not a beacon, and Fastify refuses it with 413 before parsing. */
export const INGEST_BODY_LIMIT_BYTES = 8 * 1024;

/** An origin is `scheme://host[:port]` and nothing more: no path, query, fragment or credentials. Stored case-folded, because ingest compares the request's lowercased Origin exactly. */
export const originSchema = z
  .string()
  .max(300)
  .refine(
    (value) => {
      if (!URL.canParse(value)) return false;
      const url = new URL(value);
      return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value.toLowerCase();
    },
    { message: "must be an origin such as https://example.com (scheme, host and optional port only)" },
  )
  .transform((value) => value.toLowerCase());

const conversionEventsSchema = z.array(z.string().min(1).max(MAX_CONVERSION_EVENT_NAME_LENGTH)).max(MAX_CONVERSION_EVENTS);

export const createAttributionConfigRequestSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("script"),
      allowed_origins: z.array(originSchema).min(1).max(MAX_ALLOWED_ORIGINS),
      conversion_events: conversionEventsSchema.optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("ga4"),
      ga4_property_id: z.string().regex(/^\d{1,20}$/, "a GA4 property id is numeric"),
      /** Write-only. Envelope-encrypted on arrival and never returned by any route. */
      ga4_credentials: z.string().min(1).max(8192),
      allowed_origins: z.array(originSchema).max(MAX_ALLOWED_ORIGINS).optional(),
      conversion_events: conversionEventsSchema.optional(),
    })
    .strict(),
]);
export type CreateAttributionConfigRequest = z.infer<typeof createAttributionConfigRequestSchema>;

export const attributionConfigSchema = z
  .object({
    id: z.string(),
    project_id: z.string(),
    method: z.enum(ATTRIBUTION_METHODS),
    /** Public by design: it is embedded in the customer's page and authorises nothing a forged origin could exploit. */
    site_token: z.string(),
    allowed_origins: z.array(z.string()),
    conversion_events: z.array(z.string()),
    ga4_property_id: z.string().nullable(),
    /** The only trace of a stored credential a response may carry. */
    credentials_stored: z.boolean(),
    status: z.enum(ATTRIBUTION_STATUSES),
    /** The live receiving-data indicator: true only while `status` is `receiving`. */
    receiving: z.boolean(),
    first_event_at: z.string().nullable(),
    last_event_at: z.string().nullable(),
    /** The one-line install for the `script` method; null for `ga4`. */
    snippet: z.string().nullable(),
    created_at: z.string(),
  })
  .strict();
export type AttributionConfig = z.infer<typeof attributionConfigSchema>;

/** `config: null` is the "nothing connected" state; the section renders it as a setup prompt, not an error. */
export const attributionConfigResponseSchema = z.object({ config: attributionConfigSchema.nullable() }).strict();
export type AttributionConfigResponse = z.infer<typeof attributionConfigResponseSchema>;
