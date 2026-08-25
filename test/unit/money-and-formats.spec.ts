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

  // ONE named exemption (decision D14), never a silent skip. This sweep does
  // NOT cover `expires_in_seconds` on emailOtpRequestResponseSchema, and that
  // field IS an NFR-API-05 violation — a duration that is neither integer
  // milliseconds nor `_ms`-suffixed. It is exempt because it is STORY-016's
  // PUBLISHED surface: it sits in contracts/openapi.generated.json and the
  // generated client, and correcting it means editing another story's schema,
  // service, and two of its tests. Deferred to a follow-up story rather than
  // absorbed into STORY-024 — now STORY-117, which carries it as a rider
  // alongside the list-endpoint reshape because both are breaking wire
  // changes and share one baseline record; when it lands, this set empties
  // and this comment goes with it. Read a green run of this test as "AC10 holds
  // everywhere EXCEPT this named field", never as "AC10 holds everywhere".
  const AC10_DURATION_EXEMPTIONS = new Set(["contracts/identity/email-otp-request-response.schema.ts: expires_in_seconds"]);

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

  // The exemption must not outlive the field it names. If the follow-up story
  // lands and renames it, this test goes red and the exemption gets deleted —
  // an exemption nobody removes is how a permanent deviation is born.
  it("the D14 exemption still describes a field that actually exists", () => {
    const source = readFileSync(resolve(REPO_ROOT, "contracts/identity/email-otp-request-response.schema.ts"), "utf8");
    expect(
      source,
      "expires_in_seconds is gone — delete the D14 exemption above, this deviation is fixed",
    ).toContain("expires_in_seconds");
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
