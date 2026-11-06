import { describe, expect, it } from "vitest";
import { cancelReasonFor } from "../capture/verification-run.js";
import { verificationHorizons } from "./verification-schedule.js";

// STORY-067 - the pure halves of the scheduler: the configurable horizons (AC12) and why a pending verification is called off (AC9, AC10).
describe("STORY-067 verificationHorizons", () => {
  it("[AC12] defaults to +48 hours and +14 days", () => {
    expect(verificationHorizons({})).toEqual({ shortMs: 48 * 3_600_000, longMs: 14 * 86_400_000 });
    expect(verificationHorizons({ TASK_VERIFICATION_SHORT_HOURS: "  ", TASK_VERIFICATION_LONG_DAYS: "" })).toEqual(verificationHorizons({}));
  });
  it("[AC12] honours both settings", () => {
    expect(verificationHorizons({ TASK_VERIFICATION_SHORT_HOURS: "24", TASK_VERIFICATION_LONG_DAYS: "7" })).toEqual({ shortMs: 24 * 3_600_000, longMs: 7 * 86_400_000 });
  });
  it.each([["0"], ["-1"], ["1.5"], ["abc"]])("[AC12] refuses %s rather than scheduling at a neighbour", (value) => {
    expect(() => verificationHorizons({ TASK_VERIFICATION_SHORT_HOURS: value })).toThrow();
    expect(() => verificationHorizons({ TASK_VERIFICATION_LONG_DAYS: value })).toThrow();
  });
  it("[AC12] a long horizon that is not after the short one is refused", () => {
    expect(() => verificationHorizons({ TASK_VERIFICATION_SHORT_HOURS: "48", TASK_VERIFICATION_LONG_DAYS: "2" })).toThrow();
  });
});

describe("STORY-067 cancelReasonFor", () => {
  const live = { project_status: "active", project_deleted: false, task_status: "done", task_deleted: false } as const;
  it("a live project and a done task are measured", () => expect(cancelReasonFor(live)).toBeNull());
  it("[AC10] a paused or archived project is cancelled as paused", () => {
    expect(cancelReasonFor({ ...live, project_status: "paused" })).toBe("project_paused");
    expect(cancelReasonFor({ ...live, project_status: "archived" })).toBe("project_paused");
  });
  it("[AC10] a deleted or missing project is cancelled as deleted, ahead of the pause", () => {
    expect(cancelReasonFor({ ...live, project_deleted: true, project_status: "paused" })).toBe("project_deleted");
    expect(cancelReasonFor({ ...live, project_status: null })).toBe("project_deleted");
  });
  it("[AC9] a task no longer done is cancelled as reopened; a deleted or missing one as deleted", () => {
    expect(cancelReasonFor({ ...live, task_status: "todo" })).toBe("task_reopened");
    expect(cancelReasonFor({ ...live, task_status: "in_progress" })).toBe("task_reopened");
    expect(cancelReasonFor({ ...live, task_deleted: true })).toBe("task_deleted");
    expect(cancelReasonFor({ ...live, task_status: null })).toBe("task_deleted");
  });
});
