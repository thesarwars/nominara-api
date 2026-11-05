import { describe, expect, it } from "vitest";
import { capturePlanJobSchema } from "./capture-plan-job.schema.js";

const BASE = {
  workspaceId: "01a06ccd-9e37-7f0c-957b-195fa6d263dd",
  kid: "k1",
  projectId: "01a06ccd-9e37-7f0c-957b-195fa6d263de",
  trigger: "scheduled",
};

describe("NEW-A-10 · capturePlanJobSchema", () => {
  it("accepts a scheduled plan job", () => {
    expect(capturePlanJobSchema.parse(BASE)).toEqual(BASE);
  });

  it.each([
    ["an unknown key", { ...BASE, credits: 0 }],
    ["an engine list", { ...BASE, engines: ["gemini"] }],
    ["a manual trigger", { ...BASE, trigger: "manual" }],
    ["a missing project", { ...BASE, projectId: undefined }],
    ["a non-uuid project", { ...BASE, projectId: "nope" }],
  ])("refuses %s", (_label, body) => {
    expect(capturePlanJobSchema.safeParse(body).success).toBe(false);
  });
});

describe("STORY-067 · capturePlanJobSchema, the verification trigger", () => {
  const VERIFICATION = { ...BASE, trigger: "verification", verificationId: "01a06ccd-9e37-7f0c-957b-195fa6d263df" };

  it("accepts a verification plan job that names its verification row", () => {
    expect(capturePlanJobSchema.parse(VERIFICATION)).toEqual(VERIFICATION);
  });

  it.each([
    ["no verification id", { ...VERIFICATION, verificationId: undefined }],
    ["a non-uuid verification id", { ...VERIFICATION, verificationId: "nope" }],
    ["a cluster chosen by the payload", { ...VERIFICATION, promptClusterId: "01a06ccd-9e37-7f0c-957b-195fa6d263dd" }],
    ["a credits field", { ...VERIFICATION, credits: 10 }],
    ["a verification id on a scheduled job", { ...BASE, verificationId: VERIFICATION.verificationId }],
  ])("refuses %s", (_label, body) => {
    expect(capturePlanJobSchema.safeParse(body).success).toBe(false);
  });
});
