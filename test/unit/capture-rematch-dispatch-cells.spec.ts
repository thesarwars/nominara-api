import { describe, expect, it } from "vitest";
import { rematchDispatchCells, rematchIdempotencyKey, type RematchJob } from "../../src/lib/capture/dispatch-cells.js";

// STORY-032 AC7 — the re-match parse as a dispatchable cell. The idempotency key is `capture.parse`'s own
// `parse:{result}` pattern (topology.ts), shared with capture.execute's enqueue, so the two cannot both queue a
// parse for one row.
const JOB: RematchJob = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  resultId: "22222222-2222-4222-8222-222222222222",
  projectId: "33333333-3333-4333-8333-333333333333",
  promptId: "44444444-4444-4444-8444-444444444444",
  engineKey: "perplexity",
  capturedAt: "2026-08-20T12:00:00.000Z",
};

describe("STORY-032 AC7 · rematchDispatchCells", () => {
  it("[I4 idempotent] keys each job parse:{result}, so a replay is the same job", () => {
    expect(rematchIdempotencyKey(JOB.resultId)).toBe(`parse:${JOB.resultId}`);
    const [cell] = rematchDispatchCells([JOB]);
    expect(cell!.idempotencyKey).toBe(`parse:${JOB.resultId}`);
    expect(rematchDispatchCells([JOB])[0]!.idempotencyKey).toBe(cell!.idempotencyKey);
  });

  it("carries exactly the capture.parse payload fields, and nothing else", () => {
    const [cell] = rematchDispatchCells([JOB]);
    expect(cell!.payload).toEqual(JOB);
    expect(Object.keys(cell!.payload as object).sort()).toEqual(
      ["capturedAt", "engineKey", "projectId", "promptId", "resultId", "workspaceId"],
    );
  });

  it("an empty plan yields no cells", () => {
    expect(rematchDispatchCells([])).toEqual([]);
  });

  it("one cell per job, in order", () => {
    const other = { ...JOB, resultId: "55555555-5555-4555-8555-555555555555" };
    expect(rematchDispatchCells([JOB, other]).map((c) => c.idempotencyKey)).toEqual([`parse:${JOB.resultId}`, `parse:${other.resultId}`]);
  });
});
