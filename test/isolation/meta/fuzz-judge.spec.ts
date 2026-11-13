import { describe, expect, it } from "vitest";
import { judgeReplay, normaliseBody } from "../support/fuzz-judge.js";

// STORY-012 AC5 - the replay judge can fail. Each hazard the HTTP fuzz exists for is PLANTED here and must be reported; a judge that stopped reporting would
// otherwise leave the 500 replays green for the wrong reason.
const FOREIGN = "0192f1a0-0000-7000-8000-00000000000a";
const OTHER = "0192f1a0-0000-7000-8000-0000000000bb";
const missing = JSON.stringify({ error: { code: "not_found", message: "no such project", request_id: "r1" } });
const baseline = { status: 404, body: normaliseBody(missing, []) };
const replay = (over: Partial<Parameters<typeof judgeReplay>[0]> = {}) =>
  judgeReplay({ label: "#0 GET /projects/x", status: 404, body: JSON.stringify({ error: { code: "not_found", message: "no such project", request_id: "r2" } }), used: [FOREIGN], baseline, resolves: true, foreignIds: new Set([FOREIGN, OTHER]), ...over });

describe("STORY-012 AC5 · the HTTP replay judge", () => {
  it("passes a refusal that is indistinguishable from a missing id, whatever its request id", () => {
    expect(replay()).toEqual([]);
  });

  it("reports a 200 for a foreign id where a missing id is refused", () => {
    const failures = replay({ status: 200, body: JSON.stringify({ data: { name: "A's project" } }) });
    expect(failures.some((f) => f.includes("succeeded where a missing id is refused"))).toBe(true);
    expect(failures.some((f) => f.includes("must refuse a foreign id with 403 or 404"))).toBe(true);
  });

  it("reports a foreign identifier echoed in the body, but not one the request itself named", () => {
    expect(replay({ body: JSON.stringify({ error: { code: "not_found", message: "no such project", request_id: "r2", hint: OTHER } }) }).some((f) => f.includes("carries a foreign identifier"))).toBe(true);
    expect(replay({ body: JSON.stringify({ error: { code: "not_found", message: `no such project ${FOREIGN}`, request_id: "r2" } }), baseline: { status: 404, body: normaliseBody(JSON.stringify({ error: { code: "not_found", message: "no such project 0192f1a0-0000-7000-8000-000000000001", request_id: "r1" } }), ["0192f1a0-0000-7000-8000-000000000001"]) } })).toEqual([]);
  });

  it("reports a response distinguishable from a random id: a different status (403 vs 404) and a different body", () => {
    expect(replay({ status: 403, body: JSON.stringify({ error: { code: "forbidden" } }) }).some((f) => f.includes("differs from the answer"))).toBe(true);
    expect(replay({ body: JSON.stringify({ error: { code: "not_found", message: "that project belongs to someone else" } }) }).some((f) => f.includes("differs from the answer"))).toBe(true);
  });

  it("reports a server error and a throttled replay, which prove nothing", () => {
    expect(replay({ status: 500 })).toEqual(["#0 GET /projects/x: a server error"]);
    expect(replay({ status: 429 })).toEqual(["#0 GET /projects/x: throttled, so the replay proves nothing"]);
  });
});
