import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Job, UnrecoverableError } from "bullmq";
import { describe, expect, it } from "vitest";
import { willBullmqRetry } from "../../../src/lib/queue/dead-letter.js";

// ⚠ STORY-154 — THE PREDICATE THAT DECIDES WHETHER A FAILURE IS EVER RECORDED.
//
// `attachDeadLetterHandler` used to ask `job.attemptsMade >= (opts.attempts ??
// 1)`, and its comment called the other branch "will still be retried". That
// was an INFERENCE about BullMQ, not a fact from it, and BullMQ has several
// ways to stop retrying that never touch the attempt count. The most important
// of them is the one this codebase uses ON PURPOSE:
// the tamper throw in `audit-verify.handler.ts` raises `UnrecoverableError`
// on a detected
// audit-chain tamper, specifically to get exactly one dead-letter entry a day.
// It got none. The nightly tamper alarm's only machine-readable output was
// dropped by the listener meant to record it.
//
// So the cases below are NOT a list written from reading our own code — that
// reading is what had the blind spot. They are derived from BullMQ's own
// retry decision, and the first test fails if that decision changes at all.
describe("STORY-154 · willBullmqRetry, against BullMQ's real retry decision", () => {
  /**
   * The decision AS THE RUNTIME EXECUTES IT.
   *
   * ⚠ READ OFF THE LOADED PROTOTYPE, NOT OFF A FILE PATH, AND THE DIFFERENCE
   * IS NOT PEDANTIC. The first version of this suite asserted against
   * `bullmq/dist/cjs/commands/*.lua` — which is the BUILD INPUT, still carrying
   * unexpanded `--- @include` directives. The executed artifact is
   * `dist/cjs/scripts/*.js` (`redis-connection.js:8` does
   * `require("../scripts")`). A review removed the guarantee from the executed
   * script, left the .lua untouched, and the suite stayed green. Reading a
   * package by path means guessing which of its builds is live; reading the
   * function off the prototype is the thing itself.
   */
  const shouldRetryJobSource = ((): string => {
    // `shouldRetryJob` is private in BullMQ's .d.ts. Reaching past that is the
    // point: this suite's job is to notice when internals move, and a test that
    // could only see the public surface could not see this decision at all.
    const proto = Job.prototype as unknown as { shouldRetryJob?: () => unknown };
    if (typeof proto.shouldRetryJob !== "function") {
      throw new Error("bullmq's Job.prototype.shouldRetryJob is gone — the retry decision moved and must be re-found");
    }
    return proto.shouldRetryJob.toString();
  })();

  /**
   * The exact decision the terminal paths were enumerated from,
   * whitespace-normalized.
   *
   * ⚠ THE DEFAULT HERE IS "REPORT". Anything this function grows — a fourth
   * branch, a renamed sentinel, a new error class — changes this string and
   * fails by construction. A list of conditions to look for cannot mention a
   * branch that does not exist yet: it would go on passing while the new branch
   * silently dropped dead-letter entries, which is precisely the failure being
   * repaired.
   *
   * ⚠ AND ITS SCOPE IS THIS FUNCTION ONLY — it is not a guarantee about every
   * terminal path. BullMQ decides terminality elsewhere too: a job stalled past
   * `maxStalledCount` is marked with a `defa` hash field by
   * moveStalledJobsToWait, which `worker.js` later converts into an
   * `UnrecoverableError`. `willBullmqRetry` handles that correctly — it reaches
   * the same non-retry branch, so `finishedOn` is set, and it can arrive with
   * `attemptsMade` as low as 0, which the OLD counter dropped outright — but it
   * is the predicate's fail-terminal DIRECTION that covers it, not this
   * fingerprint. Do not read a green test here as "every terminal path is
   * watched".
   *
   * WHEN THIS FAILS: re-read `shouldRetryJob`, work out every way it can now
   * return `[false, ...]`, give each one a case below and in
   * test/integration/queue-terminal-failures.spec.ts, and only then update it.
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
    // All of UnrecoverableError-by-instance, UnrecoverableError-by-name and a
    // backoff returning -1 reach the listener in exactly this shape: one event,
    // attemptsMade 1 of 4, finishedOn set. The old counter read 1 < 4 and
    // dropped the entry.
    expect(willBullmqRetry(jobAs(1, 4, 1_700_000_000_000))).toBe(false);
  });

  it("⚠ a stalled-past-the-limit job, which can arrive with attemptsMade 0, is terminal", () => {
    // moveStalledJobsToWait marks the job and worker.js converts it into an
    // UnrecoverableError on the next pass. The old counter read 0 < 4.
    expect(willBullmqRetry(jobAs(0, 4, 1_700_000_000_000))).toBe(false);
  });

  it("⚠ a terminal job that removeOnFail already deleted is still terminal", () => {
    // This is the case that rules out `await job.isFailed()`, which reads the
    // failed SET and answers false once the job is gone. `finishedOn` comes
    // from a client-built timestamp on the non-retry branch, so removal cannot
    // erase it. Latent today (topology pins removeOnFail to {age}), and pinned
    // by remove-on-fail-is-never-overridden.spec.ts.
    expect(willBullmqRetry(jobAs(2, 2, 1_700_000_000_000))).toBe(false);
  });

  it("a missing attempts option does not make a failure retryable", () => {
    // `opts.attempts` is optional in BullMQ; undefined means one attempt, and
    // shouldRetryJob's `1 < undefined` is false, so both agree it is terminal.
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
    expect(new UnrecoverableError("x").name).toBe("UnrecoverableError");
  });
});

// ⚠ STORY-154 — THE ONE WAY `finishedOn` COULD LIE, AND WHY IT CANNOT HERE.
//
// The predicate treats a set `finishedOn` as proof BullMQ declined a retry. A
// Job is rehydrated from its Redis hash on every fetch, so the question that
// decides whether the fix is safe is: can a job reach a worker ALREADY carrying
// `finishedOn` from an earlier terminal failure? If it could, the listener
// would write a dead-letter entry for a run the job is about to make, and a
// second when it really failed — duplicates in `audit.verify.dlq`, the one
// queue whose entries an operator reads as a tamper alarm.
//
// It cannot, and the reason that actually protects us is the THIRD one below:
// nothing here revives a finished job at all. The two BullMQ guarantees are a
// second line of defence for a path we do not use, and they are asserted
// against the EXECUTED scripts rather than the build inputs — the first version
// of this file got that wrong and a review broke the executed artifact while
// the suite stayed green.
describe("STORY-154 · a rehydrated job cannot carry a stale finishedOn into a retry", () => {
  const require_ = createRequire(import.meta.url);
  const read = (specifier: string): string => readFileSync(require_.resolve(specifier), "utf8");

  it("⚠ the artifacts asserted below are the ones BullMQ actually loads", () => {
    // The control that the previous version of this suite lacked. If BullMQ
    // ever stops loading `../scripts`, every assertion in this block is about
    // a dead file and must be re-pointed rather than trusted.
    expect(read("bullmq/dist/cjs/classes/redis-connection.js")).toContain('require("../scripts")');
    // And the build inputs are demonstrably NOT executable as-is, which is what
    // makes asserting on them a silent no-op.
    expect(read("bullmq/dist/cjs/commands/reprocessJob-8.lua")).toContain("@include");
  });

  it.each([
    ["reprocessJob-8", "Job.retry()"],
    ["moveJobsToWait-8", "Queue.retryJobs() / Queue.promoteJobs()"],
  ])("⚠ the executed %s script clears finishedOn when reviving a finished job (%s)", (script) => {
    const executed = read(`bullmq/dist/cjs/scripts/${script}.js`);
    expect(
      executed,
      `${script} no longer clears finishedOn. A revived job would reach the dead-letter listener already ` +
        "looking terminal, producing an entry for a run it is about to make and a duplicate when it really fails.",
    ).toMatch(/HDEL[^)]*finishedOn/u);
  });

  it("⚠ and this codebase never revives a finished job in the first place", () => {
    // Admin DLQ replay enqueues a NEW job with a replay idempotency suffix
    // (admin.service.ts, STORY-030 AC7) rather than reviving the original.
    //
    // ⚠ ANY RECEIVER, NOT A LIST OF NAMES. The first version matched
    // `(?:job|dlqJob|replayedJob)\.retry\(` — a deny-list of three identifiers,
    // in a change whose own sibling spec disavows exactly that shape. A review
    // walked straight past it with `failedJob.retry()` and, worse,
    // `q.retryJobs()` — the BULK revival of the entire failed set, which is
    // precisely what an operator reaches for after a DLQ page, and which the
    // old pattern did not even mention.
    const REVIVAL = /\.(?:retry|retryJobs|promoteJobs)\s*\(/u;
    const src = fileURLToPath(new URL("../../../src", import.meta.url));
    const offenders: string[] = [];
    let scanned = 0;
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.[cm]?tsx?$/u.test(name)) {
          scanned++;
          readFileSync(full, "utf8")
            .split("\n")
            .forEach((line, index) => {
              const trimmed = line.trim();
              if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
              if (REVIVAL.test(trimmed)) offenders.push(`${relative(src, full)}:${String(index + 1)} — ${trimmed}`);
            });
        }
      }
    };
    walk(src);

    // Anti-vacuity, in both directions: the walk must have read real files, and
    // the pattern must actually match the forms it claims to. A broken regex
    // would otherwise report clean forever.
    expect(scanned, "the source walk found nothing — every assertion here would be vacuous").toBeGreaterThan(50);
    for (const form of ["await failedJob.retry();", "await q.retryJobs({ state: 'failed' });", "job.retry()", "queue.promoteJobs()"]) {
      expect(REVIVAL.test(form), `the scanner does not recognise ${form}`).toBe(true);
    }
    expect(REVIVAL.test("const r = retryCount(job);"), "the scanner matches a non-revival call").toBe(false);

    expect(
      offenders,
      "reviving a finished BullMQ job puts a stale finishedOn one HDEL away from the dead-letter predicate. " +
        "Replay by enqueueing a new job with a replay idempotency suffix, as admin.service.ts does.",
    ).toEqual([]);
  });
});
