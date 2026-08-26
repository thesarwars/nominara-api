import { describe, expect, it } from "vitest";
import { attemptsFor, resolvePriority, QueuePriorityVariantError } from "../../../src/lib/queue/queue-factory.js";
import { QUEUE_TOPOLOGY } from "../../../src/lib/queue/topology.js";

const byName = (name: string) => {
  const entry = QUEUE_TOPOLOGY.find((e) => e.name === name);
  if (!entry) throw new Error(`fixture bug: no queue named "${name}"`);
  return entry;
};

describe("STORY-030 · queue-factory attemptsFor", () => {
  it("deploy.cms's empty retry ladder yields exactly 1 attempt — no automatic retry", () => {
    expect(attemptsFor(byName("deploy.cms"))).toBe(1);
  });

  it("capture.plan's 3-step ladder yields 4 attempts (1 initial try + 3 retries)", () => {
    expect(attemptsFor(byName("capture.plan"))).toBe(4);
  });

  it("capture.execute's 4-step ladder yields 5 attempts", () => {
    expect(attemptsFor(byName("capture.execute"))).toBe(5);
  });
});

describe("STORY-030 · queue-factory resolvePriority", () => {
  it("returns the single documented priority for an ordinary queue, ignoring any variant", () => {
    expect(resolvePriority(byName("capture.plan"))).toBe(5);
  });

  it("capture.execute resolves to its scheduled priority when variant='scheduled'", () => {
    expect(resolvePriority(byName("capture.execute"), "scheduled")).toBe(5);
  });

  it("capture.execute resolves to its interactive priority when variant='interactive'", () => {
    expect(resolvePriority(byName("capture.execute"), "interactive")).toBe(1);
  });

  it("throws QueuePriorityVariantError when capture.execute is resolved with no variant", () => {
    expect(() => resolvePriority(byName("capture.execute"))).toThrow(QueuePriorityVariantError);
  });
});
