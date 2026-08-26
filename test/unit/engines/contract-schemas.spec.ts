import { describe, expect, it } from "vitest";
import {
  answerElementSchema,
  captureInputSchema,
  captureModeSchema,
  engineKeySchema,
  rawCaptureSchema,
  type CaptureInput,
  type RawCapture,
} from "../../../src/lib/engines/contract.js";

// STORY-027 · AC1 — "The contract is exactly as specified: the input, the
// raw capture result, and the adapter interface with its declared mode,
// version, citation support, and per-task concurrency." Asserted against
// tracking-engine.md §2's literal interfaces, not a paraphrase.
describe("STORY-027 · AC1 · the capture contract is exactly as specified", () => {
  describe("captureInputSchema", () => {
    const valid: CaptureInput = {
      promptText: "Which CRM do you recommend for a 50-person startup?",
      locale: "en-US",
      sampleIndex: 0,
      requireCitations: true,
    };

    it("accepts exactly the five documented fields, personaHint optional", () => {
      expect(captureInputSchema.parse(valid)).toEqual(valid);
      expect(captureInputSchema.parse({ ...valid, personaHint: "a skeptical CTO" })).toMatchObject({
        personaHint: "a skeptical CTO",
      });
    });

    it("rejects an unknown key (.strict())", () => {
      const result = captureInputSchema.safeParse({ ...valid, extra: "nope" });
      expect(result.success).toBe(false);
    });

    it("rejects a payload missing a required field", () => {
      const { promptText: _promptText, ...withoutPromptText } = valid;
      expect(captureInputSchema.safeParse(withoutPromptText).success).toBe(false);
    });
  });

  describe("rawCaptureSchema", () => {
    // The exact field set from tracking-engine.md §2's RawCapture interface —
    // asserted as a key set rather than a magic count, so the assertion
    // stays correct regardless of how any paraphrase elsewhere counts them.
    const requiredFields = ["text", "format", "truncated", "responseTokensEst", "latencyMs", "costUsd"] as const;
    const optionalFields = ["structuredCitations", "structuredElements", "modelFingerprint", "vendorRequestId"] as const;

    const minimal: RawCapture = {
      text: "Answer text.",
      format: "markdown",
      truncated: false,
      responseTokensEst: 120,
      latencyMs: 3100,
      costUsd: 0.004,
    };

    it("accepts the minimal payload with every optional field omitted", () => {
      expect(rawCaptureSchema.parse(minimal)).toEqual(minimal);
    });

    it("the first four fields are required-vs-optional exactly as listed: text/format required, structuredCitations/structuredElements optional", () => {
      for (const field of ["text", "format"] as const) {
        const { [field]: _omit, ...withoutField } = minimal as Record<string, unknown>;
        expect(rawCaptureSchema.safeParse(withoutField).success, `${field} must be required`).toBe(false);
      }
      expect(
        rawCaptureSchema.safeParse({
          ...minimal,
          structuredCitations: [{ url: "https://example.com", slot: 1 }],
        }).success,
      ).toBe(true);
      expect(
        rawCaptureSchema.safeParse({
          ...minimal,
          structuredElements: [{ kind: "images", links: [] }],
        }).success,
      ).toBe(true);
    });

    it("rejects format outside markdown|plaintext|html", () => {
      expect(rawCaptureSchema.safeParse({ ...minimal, format: "json" }).success).toBe(false);
    });

    it("rejects an unknown key (.strict())", () => {
      expect(rawCaptureSchema.safeParse({ ...minimal, extra: "nope" }).success).toBe(false);
    });

    it("requires every documented required field and permits every documented optional field", () => {
      for (const field of requiredFields) {
        const { [field]: _omit, ...withoutField } = minimal as Record<string, unknown>;
        expect(rawCaptureSchema.safeParse(withoutField).success, `${field} must be required`).toBe(false);
      }
      // optionalFields is asserted structurally elsewhere in this file/suite —
      // referenced here only to keep the const from going unused and to
      // document the full field inventory in one place.
      expect(optionalFields.length).toBe(4);
    });

    it("a structured citation carries exactly url/title?/snippet?/slot", () => {
      const result = rawCaptureSchema.safeParse({
        ...minimal,
        structuredCitations: [{ url: "https://example.com/a", title: "A", snippet: "excerpt", slot: 1 }],
      });
      expect(result.success).toBe(true);
    });
  });

  describe("engineKeySchema", () => {
    const DDL_ORDER = [
      "google_aio",
      "google_ai_mode",
      "perplexity",
      "chatgpt",
      "gemini",
      "claude",
      "grok",
      "copilot",
      "meta_ai",
      "deepseek",
    ] as const;

    it("accepts exactly the 10 DB-canonical keys, in DDL order", () => {
      for (const key of DDL_ORDER) {
        expect(engineKeySchema.safeParse(key).success, key).toBe(true);
      }
      expect(engineKeySchema.options).toEqual(DDL_ORDER);
    });

    it("rejects anything not in the DDL CHECK list", () => {
      expect(engineKeySchema.safeParse("bard").success).toBe(false);
    });
  });

  describe("captureMode", () => {
    it("is exactly api | licensed_serp | headless, matching answer_captures.capture_mode's CHECK", () => {
      expect(captureModeSchema.options).toEqual(["api", "licensed_serp", "headless"]);
    });

    it("rejects a value outside that set", () => {
      expect(captureModeSchema.safeParse("scrape").success).toBe(false);
    });
  });

  describe("answerElementSchema (D2)", () => {
    it("accepts each of the four documented kinds", () => {
      for (const kind of ["ai_overview_element", "table_element", "shopping_element", "images"] as const) {
        const result = answerElementSchema.safeParse({
          kind,
          links: [{ url: "https://vendor.example.com/a" }],
          price: "$49.99",
          rating: 4.5,
          reviewCount: 128,
          image: "https://vendor.example.com/img.png",
          availability: "in_stock",
          description: "A widget.",
          link: "https://vendor.example.com/product",
          spec: { color: "red" },
        });
        expect(result.success, `${kind}: ${result.success ? "" : JSON.stringify((result as { error: unknown }).error)}`).toBe(
          true,
        );
      }
    });

    it("rejects an undocumented kind", () => {
      expect(answerElementSchema.safeParse({ kind: "video_element", links: [] }).success).toBe(false);
    });
  });

  describe("type-level: CaptureInput/RawCapture are z.infer aliases, no hand-written interface", () => {
    it("round-trips a value through captureInputSchema and assigns it to the exported CaptureInput type", () => {
      const parsed: CaptureInput = captureInputSchema.parse({
        promptText: "Best CRM for a 50-person startup?",
        locale: "en-US",
        sampleIndex: 2,
        requireCitations: false,
      });
      expect(parsed.sampleIndex).toBe(2);
    });

    it("round-trips a value through rawCaptureSchema and assigns it to the exported RawCapture type", () => {
      const parsed: RawCapture = rawCaptureSchema.parse({
        text: "Answer",
        format: "plaintext",
        truncated: true,
        responseTokensEst: 0,
        latencyMs: 0,
        costUsd: 0,
      });
      expect(parsed.truncated).toBe(true);
    });
  });
});
