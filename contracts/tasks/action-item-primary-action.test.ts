import { describe, expect, it } from "vitest";
import { actionItemPrimaryActionSchema } from "./action-item-response.schema.js";

// STORY-089 Actions AC2 — "Each item shows its ... primary action — open, diagnose, copy the patch, or open the playbook."
// The playbook route is keyed by domain, so `open_playbook` carries the domain; no other kind does.
describe("STORY-089 · primary_action.domain (open_playbook opens the playbook)", () => {
  it("open_playbook carries the source domain the playbook route is keyed by", () => {
    expect(actionItemPrimaryActionSchema.parse({ kind: "open_playbook", target: "seed-reddit", domain: "reddit.com" })).toEqual({
      kind: "open_playbook",
      target: "seed-reddit",
      domain: "reddit.com",
    });
  });

  it("open_playbook with no source domain is null, never an invented one", () => {
    expect(actionItemPrimaryActionSchema.parse({ kind: "open_playbook", target: "seed-reddit", domain: null }).domain).toBeNull();
  });

  it("an empty domain is refused", () => {
    expect(actionItemPrimaryActionSchema.safeParse({ kind: "open_playbook", target: "seed-reddit", domain: "" }).success).toBe(false);
  });

  it.each(["diagnose", "copy_patch", "open_task"] as const)("%s never carries a domain", (kind) => {
    expect(actionItemPrimaryActionSchema.safeParse({ kind, target: "x", domain: "reddit.com" }).success).toBe(false);
    expect(actionItemPrimaryActionSchema.safeParse({ kind, target: "x", domain: null }).success).toBe(false);
    expect(actionItemPrimaryActionSchema.safeParse({ kind, target: "x" }).success).toBe(true);
  });
});
