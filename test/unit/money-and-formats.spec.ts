import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MONEY_AMOUNT_USD_PATTERN, moneySchema } from "../../contracts/common/money.schema.js";
import { OtpRateLimitedException } from "../../src/tenancy/errors.js";

// STORY-024 T8 — story scenario 9 ("Inspect a money field → The documented
// shape") and AC10 ("Timestamps, durations, and money follow the documented
// formats everywhere"). `NFR-API-05`: "All timestamps are RFC 3339 with an
// explicit Z or offset; all durations are integer milliseconds with a `_ms`
// suffix; all money is `{amount_usd: string, currency: "USD"}`."
//
// The money block characterises T7's shipped schema and is green today. The
// `_ms` block is genuinely RED: OtpRateLimitedException emits
// `details.retry_after_seconds` (src/tenancy/errors.ts:219), which §2 and
// NFR-API-05 both contradict — decision D13 fixes it in T9.
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("STORY-024 · scenario 9 — money is the documented shape", () => {
  it("accepts §2's printed pack price and the canonical money object", () => {
    expect(moneySchema.parse({ amount_usd: "50.00", currency: "USD" })).toEqual({
      amount_usd: "50.00",
      currency: "USD",
    });
    expect("15.00").toMatch(MONEY_AMOUNT_USD_PATTERN);
  });

  // The whole reason money is a string: numeric(12,2) values are not
  // representable in IEEE-754, so a JSON number here loses cents.
  it("refuses a float amount — the failure mode the string exists to prevent", () => {
    expect(moneySchema.safeParse({ amount_usd: 50.0, currency: "USD" }).success).toBe(false);
    expect(moneySchema.safeParse({ amount_usd: 50.01, currency: "USD" }).success).toBe(false);
  });

  it("refuses a scale other than exactly two decimals, and a currency other than USD", () => {
    for (const amount of ["50", "50.0", "50.000", "5e1", "", "abc", "50.00 "]) {
      expect(moneySchema.safeParse({ amount_usd: amount, currency: "USD" }).success, `"${amount}"`).toBe(false);
    }
    expect(moneySchema.safeParse({ amount_usd: "50.00", currency: "EUR" }).success).toBe(false);
  });

  it("admits a negative amount — a ledger entry can be a debit", () => {
    expect(moneySchema.safeParse({ amount_usd: "-12.50", currency: "USD" }).success).toBe(true);
  });
});

describe("STORY-024 · AC10 — durations are integer milliseconds with a _ms suffix (NFR-API-05)", () => {
  it("a rate-limit error reports retry_after_ms, not seconds (decision D13)", () => {
    const details = (new OtpRateLimitedException(3600).getResponse() as { details: Record<string, unknown> })
      .details;

    expect(
      details,
      "NFR-API-05: durations are integer milliseconds with a _ms suffix — retry_after_seconds violates it",
    ).not.toHaveProperty("retry_after_seconds");
    expect(details).toHaveProperty("retry_after_ms");
    expect(details.retry_after_ms).toBe(3_600_000);
    expect(Number.isInteger(details.retry_after_ms)).toBe(true);
  });
});

// A sweep, not a spot check: AC10 says "everywhere". Reading the contract
// sources directly is what makes this hold for schemas no test has imported.
describe("STORY-024 · AC10 — the contract sources obey NFR-API-05 everywhere", () => {
  function contractFiles(dir: string): string[] {
    return readdirSync(resolve(REPO_ROOT, dir), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? contractFiles(`${dir}/${entry.name}`)
        : entry.name.endsWith(".schema.ts")
          ? [`${dir}/${entry.name}`]
          : [],
    );
  }

  const files = contractFiles("contracts");

  it("finds the contract sources to sweep", () => {
    expect(files.length).toBeGreaterThan(30);
  });

  // STORY-117 — there was ONE named exemption here (decision D14):
  // `expires_in_seconds` on emailOtpRequestResponseSchema, an NFR-API-05
  // violation left standing because it sat in the published document and
  // correcting it meant editing another story's schema, service and tests.
  // STORY-117 did exactly that, so the exemption set is EMPTY and the sweep
  // below is now unqualified. A green run means "everywhere", with no
  // asterisk — which is what it always claimed and did not mean.
  const AC10_DURATION_EXEMPTIONS = new Set<string>();

  it("every duration field ends in _ms and is an integer, never a bare _seconds/_millis spelling", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
      for (const match of source.matchAll(/^\s*([a-z_]*(?:_seconds|_millis|_msec))\s*:/gm)) {
        const offender = `${file}: ${match[1]}`;
        if (!AC10_DURATION_EXEMPTIONS.has(offender)) offenders.push(offender);
      }
    }
    expect(offenders, "NFR-API-05 names the unit _ms; these fields use another spelling").toEqual([]);
  });

  // The D14 guard that lived here asserted the exempted field still existed,
  // so that an exemption could not outlive its reason. It fired: the field is
  // gone. Both it and the exemption are deleted rather than carried forward
  // as a set that matches nothing — the whole point was that it would end.
  it("no duration field anywhere is spelled in seconds", () => {
    const source = readFileSync(resolve(REPO_ROOT, "contracts/identity/email-otp-request-response.schema.ts"), "utf8");
    // A DECLARATION, not any occurrence: the file's own comment records the
    // old name as history, and history is not a violation. The sweep above
    // uses the same shape for the same reason.
    expect([...source.matchAll(/^\s*([a-z_]*_seconds)\s*:/gm)].map((m) => m[1])).toEqual([]);
    expect(source).toContain("expires_in_ms:");
  });

  it("no money-looking field is typed as a number", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
      for (const match of source.matchAll(/^\s*([a-z_]*(?:_usd|price|amount))\s*:\s*z\.number\(\)/gm)) {
        offenders.push(`${file}: ${match[1]}`);
      }
    }
    expect(offenders, "NFR-API-05: money is a string, never a float").toEqual([]);
  });
});
