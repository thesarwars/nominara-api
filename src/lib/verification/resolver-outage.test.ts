import { describe, expect, it, vi } from "vitest";

// STORY-048 review round 2 — "our outage is not their absence" for the FILE and META-TAG methods.
//
// The first round fixed it for DNS-TXT only. For the other two, a resolver failure on OUR side surfaces from the
// guarded fetcher as `GuardedFetchRefusal("dns_resolution_failed")`, which the checkers used to report as a
// conclusive `fetch_refused`: one resolver outage at 02:20 UTC then de-verified every file- or tag-verified domain.
// These tests go through the REAL guardedFetch and its REAL resolver step (only the OS lookup is replaced), because a
// plain `Error` fed to a fake `fetch` is exactly the input the first round's tests used, and could not see this.

// A plain function over a variable, not a vi.fn: the OS lookup either answers or fails with a given errno.
let behaviour: { code: string } | { addresses: string[] } = { code: "ENOTFOUND" };
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return {
    ...actual,
    lookup: async () => {
      if ("code" in behaviour) throw Object.assign(new Error(behaviour.code), { code: behaviour.code });
      return behaviour.addresses.map((address) => ({ address, family: 4 }));
    },
  };
});

const { checkMetaTag, checkWellKnownFile } = await import("./checkers.js");
const { guardedFetch } = await import("../net/guarded-fetch.js");

const deps = { resolveTxt: async () => [], fetch: guardedFetch };
const failWith = (code: string): void => {
  behaviour = { code };
};

describe("STORY-048 · a resolver failure on our side is inconclusive for the file and meta-tag methods", () => {

  it.each(["EAI_AGAIN", "ESERVFAIL", "ETIMEOUT", "ECONNREFUSED"])(
    "well_known_file · resolver %s is inconclusive, not a conclusive refusal",
    async (code) => {
      failWith(code);
      const outcome = await checkWellKnownFile("site.test", "n1", deps);
      expect(outcome).toMatchObject({ ok: false, inconclusive: true });
    },
  );

  it.each(["EAI_AGAIN", "ESERVFAIL", "ETIMEOUT", "ECONNREFUSED"])(
    "meta_tag · resolver %s is inconclusive, not a conclusive refusal",
    async (code) => {
      failWith(code);
      const outcome = await checkMetaTag("site.test", "n1", deps);
      expect(outcome).toMatchObject({ ok: false, inconclusive: true });
    },
  );

  it.each(["ENOTFOUND", "ENODATA"])("a %s is conclusive: the name does not exist, which mirrors the DNS-TXT rule", async (code) => {
    failWith(code);
    for (const outcome of [await checkWellKnownFile("site.test", "n1", deps), await checkMetaTag("site.test", "n1", deps)]) {
      expect(outcome).toEqual({ ok: false, reason: "fetch_refused" });
    }
  });

  it("a POLICY refusal (a private address) stays conclusive", async () => {
    behaviour = { addresses: ["10.0.0.5"] };
    expect(await checkWellKnownFile("site.test", "n1", deps)).toEqual({ ok: false, reason: "fetch_refused" });
  });

  it("the customer-facing reason is unchanged and the refusal still names no address", async () => {
    failWith("EAI_AGAIN");
    const outcome = await checkMetaTag("site.test", "n1", deps);
    expect(outcome).toMatchObject({ ok: false, reason: "fetch_refused" });
  });
});
