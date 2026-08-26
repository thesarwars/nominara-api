import { describe, expect, it } from "vitest";
import {
  buildIdempotencyKey,
  IdempotencyKeyError,
  QUEUE_IDEMPOTENCY_KEY_BUILDERS,
  withReplaySuffix,
} from "../../../src/lib/queue/idempotency.js";

// STORY-030 T3 (RED step) — AC "Every job is idempotent under at-least-once
// delivery, and a replay with the same key produces at most one effect.
// Asserted per queue." and AC "Replay from the administrative surface adds
// a new idempotency suffix, so a replayed job cannot collide with the
// original's key."
//
// One row per queue, transcribed from architecture reference §4's
// idempotency key column — proves buildIdempotencyKey substitutes the
// EXACT documented pattern, not just "however the code happens to format
// it", for every one of the 21 queues.
const PER_QUEUE_CASES: Array<{
  queue: string;
  params: Record<string, string>;
  expectedKey: string;
}> = [
  { queue: "capture.plan", params: { project: "proj_1", window: "2026-08-24" }, expectedKey: "run:proj_1:2026-08-24" },
  {
    queue: "capture.execute",
    params: { prompt: "prompt_1", engine: "chatgpt", run: "run_1" },
    expectedKey: "cap:prompt_1:chatgpt:run_1",
  },
  { queue: "capture.parse", params: { result: "res_1" }, expectedKey: "parse:res_1" },
  { queue: "capture.arbitrate", params: { mention: "mention_1" }, expectedKey: "arb:mention_1" },
  { queue: "lookup.execute", params: { tool_run_id: "tool_1" }, expectedKey: "lookup:tool_1" },
  { queue: "crawl.discover", params: { project: "proj_1" }, expectedKey: "disc:proj_1" },
  { queue: "crawl.fingerprint", params: { project: "proj_1" }, expectedKey: "fp:proj_1" },
  { queue: "crawl.audit", params: { project: "proj_1", audit: "audit_1" }, expectedKey: "aux:proj_1:audit_1" },
  { queue: "embed.batch", params: { "sha256(batch)": "abcd1234" }, expectedKey: "emb:abcd1234" },
  {
    queue: "rollup.metric_daily",
    params: { project: "proj_1", date: "2026-08-24" },
    expectedKey: "rollup:proj_1:2026-08-24",
  },
  {
    queue: "displacement.detect",
    params: { project: "proj_1", prompt: "prompt_1", engine: "chatgpt", run: "run_1" },
    expectedKey: "disp:proj_1:prompt_1:chatgpt:run_1",
  },
  {
    queue: "geo.analyze",
    params: { project: "proj_1", analysis: "analysis_1", window: "2026-08" },
    expectedKey: "geo:proj_1:analysis_1:2026-08",
  },
  {
    queue: "topic.cluster",
    params: { project: "proj_1", prompt_set_hash: "hash_1" },
    expectedKey: "topic:proj_1:hash_1",
  },
  {
    queue: "task.generate",
    params: { project: "proj_1", rule: "rule_1", fingerprint: "fp_1" },
    expectedKey: "taskgen:proj_1:rule_1:fp_1",
  },
  {
    queue: "attribution.rollup",
    params: { project: "proj_1", window: "2026-08" },
    expectedKey: "attr:proj_1:2026-08",
  },
  {
    queue: "gsc.sync",
    params: { connection: "conn_1", date: "2026-08-24" },
    expectedKey: "gsc:conn_1:2026-08-24",
  },
  { queue: "credit.reconcile", params: { bucket: "bucket_1" }, expectedKey: "creditrec:bucket_1" },
  {
    queue: "report.build",
    params: { report: "report_1", period: "2026-08" },
    expectedKey: "rep:report_1:2026-08",
  },
  { queue: "notify.dispatch", params: { event: "event_1" }, expectedKey: "ntf:event_1" },
  { queue: "maintenance.partition", params: { yyyy_mm: "2026_08" }, expectedKey: "part:2026_08" },
  {
    queue: "deploy.cms",
    params: { "Idempotency-Key": "idem_1" },
    expectedKey: "deploy:idem_1",
  },
];

describe("STORY-030 · per-queue idempotency key builders", () => {
  it.each(PER_QUEUE_CASES)("builds $queue's documented key pattern exactly", ({ queue, params, expectedKey }) => {
    expect(buildIdempotencyKey(queue as never, params)).toBe(expectedKey);
    expect(QUEUE_IDEMPOTENCY_KEY_BUILDERS[queue as never]!(params)).toBe(expectedKey);
  });

  it("is deterministic — the same params build the identical key on every call, so a retry is idempotent by construction", () => {
    const params = { project: "proj_1" };
    const first = buildIdempotencyKey("crawl.discover", params);
    const second = buildIdempotencyKey("crawl.discover", params);
    expect(second).toBe(first);
    expect(second).toBe("disc:proj_1");
  });

  it("throws IdempotencyKeyError when a required placeholder is missing", () => {
    expect(() => buildIdempotencyKey("crawl.discover", {})).toThrow(IdempotencyKeyError);
  });

  it("throws IdempotencyKeyError when an unexpected param is supplied", () => {
    expect(() => buildIdempotencyKey("crawl.discover", { project: "proj_1", extra: "nope" })).toThrow(
      IdempotencyKeyError,
    );
  });

  it("throws IdempotencyKeyError for an unknown queue name", () => {
    expect(() => buildIdempotencyKey("not.a.real.queue" as never, {})).toThrow(IdempotencyKeyError);
  });
});

describe("STORY-030 · withReplaySuffix — a replay never collides with the original key", () => {
  it("with an injected suffix, appends it deterministically", () => {
    expect(withReplaySuffix("disc:proj_1", "abc")).toBe("disc:proj_1:replay:abc");
  });

  it("never returns the original key", () => {
    expect(withReplaySuffix("disc:proj_1", "abc")).not.toBe("disc:proj_1");
  });

  it("with no injected suffix, two replays of the same original key produce two DIFFERENT keys", () => {
    const original = "disc:proj_1";
    const first = withReplaySuffix(original);
    const second = withReplaySuffix(original);
    expect(first).not.toBe(second);
    expect(first).not.toBe(original);
    expect(second).not.toBe(original);
    expect(first.startsWith(`${original}:replay:`)).toBe(true);
    expect(second.startsWith(`${original}:replay:`)).toBe(true);
  });
});
