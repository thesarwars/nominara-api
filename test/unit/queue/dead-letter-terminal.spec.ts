import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { UnrecoverableError, type Job } from "bullmq";
import { describe, expect, it } from "vitest";
import { willBullmqRetry } from "../../../src/lib/queue/dead-letter.js";

// ⚠ STORY-154 — THE PREDICATE THAT DECIDES WHETHER A FAILURE IS EVER RECORDED.
//
// `attachDeadLetterHandler` used to ask `job.attemptsMade >= (opts.attempts ??
// 1)`, and its comment called the other branch "will still be retried". That
// was an INFERENCE about BullMQ, not a fact from it, and BullMQ has three ways
// to stop retrying that never touch the attempt count. The most important of
// them is the one this codebase uses ON PURPOSE:
// `audit-verify.handler.ts:129` throws `UnrecoverableError` on a detected
// audit-chain tamper, specifically to get exactly one dead-letter entry a day.
// It got none. The nightly tamper alarm's only machine-readable output was
// dropped by the listener meant to record it.
//
// So the cases below are NOT a list I wrote from reading our own code — that
// list is what had the blind spot. They are derived from BullMQ's own
// `shouldRetryJob`, and the first test fails if that function changes at all.
describe("STORY-154 · willBullmqRetry, against BullMQ's real retry decision", () => {
  const require_ = createRequire(import.meta.url);

  /** BullMQ's own `shouldRetryJob`, read out of the installed package. */
  const shouldRetryJobSource = (() => {
    const jobPath = require_.resolve("bullmq/dist/cjs/classes/job.js");
    const source = readFileSync(jobPath, "utf8");
    const start = source.indexOf("async shouldRetryJob(err)");
    if (start === -1) {
      throw new Error("bullmq's shouldRetryJob was not found — this test cannot see the decision it exists to track");
    }
    // Bounded at whichever comes first of the next method and the docblock
    // that introduces it — bounding on the method alone swept that docblock in,
    // which the fingerprint test below caught on its first run.
    const bounds = ["\n    async ", "\n    /**", "\n    get "]
      .map((marker) => source.indexOf(marker, start + 1))
      .filter((index) => index !== -1);
    if (bounds.length === 0) {
      throw new Error("bullmq's shouldRetryJob has no following member — the slice would run to end of file");
    }
    return source.slice(start, Math.min(...bounds));
  })();

  /**
   * The exact decision we enumerated the terminal paths from, whitespace-
   * normalized.
   *
   * ⚠ THE DEFAULT HERE IS "REPORT", WHICH IS THE WHOLE DESIGN. Anything this
   * function grows — a fourth terminal branch, a renamed sentinel, a new error
   * class — changes this string and fails this test by construction. The
   * alternative was a list of conditions to check for, and a list cannot
   * mention a branch that does not exist yet: it would have gone on passing
   * while the new branch silently dropped dead-letter entries, which is
   * precisely the failure being repaired.
   *
   * WHEN THIS FAILS: re-read `shouldRetryJob`, work out every way it can now
   * return `[false, ...]`, make sure each one has a case in TERMINAL_PATHS
   * below and in test/integration/queue-terminal-failures.spec.ts, and only
   * then update this fingerprint.
   */
  const KNOWN_DECISION =
    "async shouldRetryJob(err) { if (this.attemptsMade + 1 < this.opts.attempts && " +
    "!(err instanceof unrecoverable_error_1.UnrecoverableError || err.name == 'UnrecoverableError')) { " +
    "const opts = this.queue.opts; const delay = await backoffs_1.Backoffs.calculate(this.opts.backoff, " +
    "this.attemptsMade + 1, err, this, opts.settings && opts.settings.backoffStrategy); " +
    "return [delay == -1 ? false : true, delay == -1 ? 0 : delay]; } else { return [false, 0]; } }";

  it("⚠ BullMQ's retry decision is still the one we enumerated the terminal paths from", () => {
    const normalized = shouldRetryJobSource.replace(/\s+/gu, " ").trim();
    expect(
      normalized,
      "bullmq's shouldRetryJob changed. Do NOT just update this string: re-derive every way it can decline " +
        "a retry, and give each one a case here and an integration case, or the DLQ will silently drop it.",
    ).toBe(KNOWN_DECISION);
  });

  it("the enumerated paths are the ones actually present in that decision", () => {
    // Anti-vacuity: if the fingerprint above were ever loosened, these still
    // pin the individual levers each case below exercises.
    expect(shouldRetryJobSource).toContain("this.attemptsMade + 1 < this.opts.attempts");
    expect(shouldRetryJobSource).toContain("err instanceof unrecoverable_error_1.UnrecoverableError");
    expect(shouldRetryJobSource).toContain("err.name == 'UnrecoverableError'");
    expect(shouldRetryJobSource).toContain("delay == -1 ? false : true");
  });

  /**
   * A job as the "failed" listener sees it. `attemptsMade` is ALREADY
   * incremented at that point — `moveToFailed` does `this.attemptsMade += 1`
   * after `shouldRetryJob` (job.js:512) — and `finishedOn` is assigned only on
   * the non-retry branch, which is what makes it the direct answer.
   */
  const jobAs = (attemptsMade: number, attempts: number, finishedOn?: number): Job =>
    ({ id: "1", data: {}, attemptsMade, finishedOn, opts: { attempts } }) as unknown as Job;

  it("a job with retries left is left alone — the DLQ is not a log of every attempt", () => {
    expect(willBullmqRetry(jobAs(1, 4))).toBe(true);
    expect(willBullmqRetry(jobAs(3, 4))).toBe(true);
  });

  it("the exhausted retry ladder is still terminal (the case the old counter got right)", () => {
    expect(willBullmqRetry(jobAs(4, 4))).toBe(false);
    expect(willBullmqRetry(jobAs(1, 1))).toBe(false); // deploy.cms shape
  });

  it("⚠ a job BullMQ finished early is terminal even with the counter saying otherwise", () => {
    // All three of UnrecoverableError-by-instance, UnrecoverableError-by-name
    // and a backoff returning -1 reach the listener in exactly this shape:
    // one event, attemptsMade 1 of 4, finishedOn set. The old counter read
    // 1 < 4 and dropped the entry.
    expect(willBullmqRetry(jobAs(1, 4, 1_700_000_000_000))).toBe(false);
  });

  it("⚠ a terminal job that removeOnFail already deleted is still terminal", () => {
    // This is the case that rules out `await job.isFailed()`, which reads the
    // failed SET and answers false once the job is gone. `finishedOn` comes
    // from a client-built timestamp on the non-retry branch, so removal cannot
    // erase it. Latent today (topology pins removeOnFail to {age}), and pinned
    // by removeOnFail-is-never-overridden.spec.ts.
    expect(willBullmqRetry(jobAs(2, 2, 1_700_000_000_000))).toBe(false);
  });

  it("a missing attempts option does not make a failure retryable", () => {
    // `opts.attempts` is optional in BullMQ; undefined means one attempt.
    expect(willBullmqRetry({ attemptsMade: 1, finishedOn: undefined, opts: {} } as unknown as Job)).toBe(false);
  });

  it("the two signals are independent — either one alone reports the failure", () => {
    // If `finishedOn` ever stopped being set, the counter still catches the
    // ordinary exhausted ladder; if the counter is wrong, finishedOn catches
    // everything. Neither is load-bearing alone.
    expect(willBullmqRetry(jobAs(4, 4, undefined)), "counter alone must still report").toBe(false);
    expect(willBullmqRetry(jobAs(1, 4, 1_700_000_000_000)), "finishedOn alone must still report").toBe(false);
  });

  it("UnrecoverableError is a real BullMQ export, not a name we invented", () => {
    // The duck-typed branch keys off this exact name; if the class were
    // renamed upstream the fingerprint test fails, but this keeps the
    // relationship visible from our side too.
    expect(new UnrecoverableError("x").name).toBe("UnrecoverableError");
  });
});
