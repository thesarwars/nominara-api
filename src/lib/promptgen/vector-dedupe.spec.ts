import { describe, expect, it } from "vitest";
import { VECTOR_DEDUPE_THRESHOLD, judgeVectors } from "./vector-dedupe.js";

// STORY-045 AC6 - the decision half of §4 step 5, pure. The SQL half is test/integration/promptgen-vector-dedupe.spec.ts.

const ID_X = "01a06ccd-0000-7000-8000-0000000000a1";
const ID_Y = "01a06ccd-0000-7000-8000-0000000000a2";

describe("STORY-045 AC6 - judgeVectors", () => {
  it("pins the threshold to §4 step 5 / FR-FAN-01's 0.92", () => {
    expect(VECTOR_DEDUPE_THRESHOLD).toBe(0.92);
  });

  it("rejects AT the threshold (>=), keeps just under it, and names the existing prompt it collided with", () => {
    const verdicts = judgeVectors({
      nearest: [{ promptId: ID_X, cosine: 0.92 }, { promptId: ID_Y, cosine: 0.9199 }],
      batchPairs: [],
    });
    expect(verdicts[0]).toEqual({ reject: true, conflictingPromptId: ID_X, maxCosine: 0.92, nearestPromptId: ID_X });
    expect(verdicts[1]).toEqual({ reject: false, conflictingPromptId: null, maxCosine: 0.9199, nearestPromptId: ID_Y });
  });

  it("scenario 10 - 0.93 is rejected by generation dedupe, 0.85 is not", () => {
    const verdicts = judgeVectors({ nearest: [{ promptId: ID_X, cosine: 0.93 }, { promptId: ID_Y, cosine: 0.85 }], batchPairs: [] });
    expect(verdicts.map((v) => v.reject)).toEqual([true, false]);
  });

  it("null stays null: a project with nothing embedded to compare against reports NOT MEASURED, never 0", () => {
    const [verdict] = judgeVectors({ nearest: [null], batchPairs: [] });
    expect(verdict).toEqual({ reject: false, conflictingPromptId: null, maxCosine: null, nearestPromptId: null });
  });

  it("0 stays 0: a measured, maximally distant neighbour is a number, and a negative cosine is clamped to the contract's 0", () => {
    const verdicts = judgeVectors({ nearest: [{ promptId: ID_X, cosine: 0 }, { promptId: ID_Y, cosine: -0.2 }], batchPairs: [] });
    expect(verdicts[0]!.maxCosine).toBe(0);
    expect(verdicts[1]!.maxCosine).toBe(0);
  });

  it("within the batch the EARLIER prompt is kept and the later one rejected", () => {
    const verdicts = judgeVectors({ nearest: [null, null, null], batchPairs: [{ earlier: 0, later: 2, cosine: 0.95 }] });
    expect(verdicts.map((v) => v.reject)).toEqual([false, false, true]);
  });

  it("a chain A~B, B~C (A!~C) rejects B and KEEPS C: a rejected prompt does not reject what is near it", () => {
    const verdicts = judgeVectors({
      nearest: [null, null, null],
      batchPairs: [{ earlier: 0, later: 1, cosine: 0.95 }, { earlier: 1, later: 2, cosine: 0.95 }],
    });
    expect(verdicts.map((v) => v.reject)).toEqual([false, true, false]);
  });

  it("an empty batch has no verdicts", () => {
    expect(judgeVectors({ nearest: [], batchPairs: [] })).toEqual([]);
  });

  it("a batch pair below the threshold rejects nothing", () => {
    const verdicts = judgeVectors({ nearest: [null, null], batchPairs: [{ earlier: 0, later: 1, cosine: 0.91 }] });
    expect(verdicts.map((v) => v.reject)).toEqual([false, false]);
  });
});
