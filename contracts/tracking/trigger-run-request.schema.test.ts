import { describe, expect, it } from "vitest";
import { triggerRunRequestSchema } from "./trigger-run-request.schema.js";

// STORY-034 test scenario 4 — "Trigger with a scope in the body → Rejected as
// an unknown field."

describe("triggerRunRequestSchema", () => {
  it("accepts an empty body", () => {
    expect(triggerRunRequestSchema.parse({})).toEqual({});
  });

  it.each([
    ["an engine selection", { engines: ["chatgpt"] }],
    ["a prompt scope", { scope: "priority" }],
    ["a single prompt", { prompt_ids: ["01a06ccd-9e37-7f0c-957b-195fa6d263dd"] }],
    ["a price the caller would prefer", { credits: 0 }],
  ])("refuses %s", (_label, body) => {
    // Refused rather than ignored, and the difference is money. A caller that
    // believes it narrowed the scan to one engine, and is then charged the
    // flat price for all of them, has been mischarged by exactly the amount
    // it tried to avoid — and would have no way to tell from a 200.
    expect(triggerRunRequestSchema.safeParse(body).success).toBe(false);
  });
});
