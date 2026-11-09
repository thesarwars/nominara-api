import { z } from "zod";
import { MAX_CONVERSION_EVENT_NAME_LENGTH, MAX_LANDING_URL_LENGTH, MAX_REFERRER_LENGTH } from "./attribution-config.schema.js";

// STORY-113 - `POST /ingest/attribution`. Public; the site token identifies WHICH configuration to increment and authorises
// nothing else. Strict, so an unknown key (a visitor id someone "just adds") is a 400 rather than a silent drop.
export const ingestAttributionRequestSchema = z
  .object({
    site_token: z.string().min(1).max(200),
    landing_url: z.string().min(1).max(MAX_LANDING_URL_LENGTH),
    /** `document.referrer`; empty when the browser stripped it, which is stored as `unattributed_direct`. */
    referrer: z.string().max(MAX_REFERRER_LENGTH).optional(),
    conversion: z
      .object({
        name: z.string().min(1).max(MAX_CONVERSION_EVENT_NAME_LENGTH),
        value: z.number().min(0).max(1_000_000_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type IngestAttributionRequest = z.infer<typeof ingestAttributionRequestSchema>;

/** `recorded` is false for a referrer that is neither an AI engine nor absent (nothing is stored for it). */
export const ingestAttributionResponseSchema = z
  .object({ accepted: z.literal(true), recorded: z.boolean(), conversion_counted: z.boolean() })
  .strict();
export type IngestAttributionResponse = z.infer<typeof ingestAttributionResponseSchema>;
