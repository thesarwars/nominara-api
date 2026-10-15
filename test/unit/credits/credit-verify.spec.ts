import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ClientBase } from "pg";
import { describe, expect, it } from "vitest";
import {
  ReplayOrderingUnavailableError,
  verifyAllWallets,
} from "../../../src/workers/rollup/credit-verify.js";
import type { WalletMismatch } from "../../../src/lib/credits/replay.js";
import type { WalletPagingNotifier } from "../../../src/modules/credits/ports/wallet-paging-notifier.js";

// STORY-073 scenarios 6 and 7 — the nightly job pages on a discrepancy, and
// an automatic correction is not possible.

interface WalletFixture {
  readonly wallet: {
    included: number;
    purchased: number;
    reserved: number;
    /** Defaults to what the ledger below adds up to — only set to break it deliberately. */
    lifetimeGranted?: number;
  } | null;
  readonly ledger: readonly {
    seq: string;
    entry_type: string;
    credits: number;
    bucket: string | null;
    idempotency_key: string;
    attempt: number;
    included_after: number;
    purchased_after: number;
    reserved_after: number;
  }[];
}

/**
 * A client that answers the three queries the verifier asks, and nothing
 * else — so a query it was not expecting is a test failure rather than an
 * empty result silently standing in for one.
 */
function fakeClient(
  fixtures: Readonly<Record<string, WalletFixture>>,
  options: { readonly seqColumn?: boolean } = {},
): ClientBase {
  const query = async (sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> => {
    const rows = ((): unknown[] => {
      if (sql.includes("information_schema.columns")) {
        return options.seqColumn === false ? [] : [{ exists: 1 }];
      }
      const workspaceId = String(params?.[0] ?? "");
      const fixture = fixtures[workspaceId];
      if (fixture === undefined) throw new Error(`no fixture for workspace ${workspaceId}`);

      if (sql.includes("FROM credit_wallets")) {
        if (fixture.wallet === null) return [];
        const granted = fixture.wallet.lifetimeGranted ?? sumOf(fixture, "grant");
        return [
          {
            included_balance: String(fixture.wallet.included),
            purchased_balance: String(fixture.wallet.purchased),
            reserved: String(fixture.wallet.reserved),
            cycle_end: "2026-10-01",
            lifetime_granted: String(granted),
            lifetime_purchased: String(sumOf(fixture, "purchase")),
            lifetime_spent: String(sumOf(fixture, "commit")),
          },
        ];
      }
      // STORY-072 AC13: the carries table the verifier now cross-checks. No fixture carries a hold across a roll.
      if (sql.includes("FROM credit_hold_carries")) return [];
      if (sql.includes("FROM credit_ledger")) {
        return fixture.ledger.map((row) => ({
          ...row,
          credits: String(row.credits),
          included_after: String(row.included_after),
          purchased_after: String(row.purchased_after),
          reserved_after: String(row.reserved_after),
        }));
      }
      throw new Error(`unexpected query: ${sql}`);
    })();
    return { rows, rowCount: rows.length };
  };
  return { query } as unknown as ClientBase;
}

function sumOf(fixture: WalletFixture, entryType: string): number {
  return fixture.ledger.filter((row) => row.entry_type === entryType).reduce((total, row) => total + row.credits, 0);
}

function recordingNotifier(): { notifier: WalletPagingNotifier; pages: WalletMismatch[] } {
  const pages: WalletMismatch[] = [];
  return {
    pages,
    notifier: {
      page: async (mismatch) => {
        pages.push(mismatch);
        await Promise.resolve();
      },
    },
  };
}

const clean = (included: number): WalletFixture => ({
  wallet: { included, purchased: 0, reserved: 0 },
  ledger: [
    {
      seq: "1",
      entry_type: "grant",
      credits: included,
      bucket: "included",
      idempotency_key: "grant:provision:2026-09-01",
      attempt: 1,
      included_after: included,
      purchased_after: 0,
      reserved_after: 0,
    },
  ],
});

describe("STORY-073 · verifyAllWallets", () => {
  it("finds nothing to page about when every wallet matches its ledger", async () => {
    const { notifier, pages } = recordingNotifier();
    const client = fakeClient({ a: clean(600), b: clean(1200) });

    const result = await verifyAllWallets(client, notifier, ["a", "b"]);

    expect(result).toEqual({ checked: 2, mismatch: null });
    expect(pages).toEqual([]);
  });

  it("pages on a wallet holding credits its ledger cannot account for", async () => {
    // Scenario 6. The ledger grants 600 and the wallet holds 640 — the shape
    // a balance movement written with no entry produces.
    const { notifier, pages } = recordingNotifier();
    const client = fakeClient({
      a: { wallet: { included: 640, purchased: 0, reserved: 0 }, ledger: clean(600).ledger },
    });

    const result = await verifyAllWallets(client, notifier, ["a"]);

    expect(result.mismatch?.workspaceId).toBe("a");
    expect(result.mismatch?.seq).toBeNull();
    expect(result.mismatch?.reason).toContain("a movement was made with no entry");
    expect(result.mismatch?.wallet.included).toBe(640);
    expect(result.mismatch?.replayed.included).toBe(600);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toEqual(result.mismatch);
  });

  it("pages on a lifetime total that does not add up, even when the balances do", async () => {
    // ⚠ THE HALF A BALANCE CHECK MISSES. STORY-072's review drained a
    // 600-credit wallet to zero through three retries and the wallet
    // reported `lifetime_spent: 0` — a verifier that only compared the
    // spendable balances would have called that wallet healthy.
    const { notifier, pages } = recordingNotifier();
    const client = fakeClient({
      a: { wallet: { included: 600, purchased: 0, reserved: 0, lifetimeGranted: 0 }, ledger: clean(600).ledger },
    });

    const result = await verifyAllWallets(client, notifier, ["a"]);

    expect(result.mismatch?.reason).toContain("lifetime_granted");
    expect(result.mismatch?.counter).toEqual({ counter: "granted", wallet: 0, replayed: 600 });
    // The balances themselves reconcile — which is the point.
    expect(result.mismatch?.wallet).toEqual(result.mismatch?.replayed);
    expect(pages).toHaveLength(1);
  });

  it("stops at the first mismatch rather than sweeping the estate", async () => {
    // A page carrying forty workspaces is a page nobody can act on at 3am,
    // and the run is nightly: the next one finds the next problem.
    const { notifier, pages } = recordingNotifier();
    const client = fakeClient({
      a: clean(600),
      b: { wallet: { included: 1, purchased: 0, reserved: 0 }, ledger: clean(600).ledger },
      // `c` has no fixture on purpose — reaching it throws, which is how the
      // test proves the walk stopped instead of merely reporting one page.
    });

    const result = await verifyAllWallets(client, notifier, ["a", "b", "c"]);

    expect(result.checked).toBe(2);
    expect(result.mismatch?.workspaceId).toBe("b");
    expect(pages).toHaveLength(1);
  });

  it("reports a workspace whose ledger outlived its wallet", async () => {
    const { notifier, pages } = recordingNotifier();
    const client = fakeClient({ a: { wallet: null, ledger: clean(600).ledger } });

    const result = await verifyAllWallets(client, notifier, ["a"]);

    expect(result.mismatch?.reason).toContain("no wallet row");
    expect(pages).toHaveLength(1);
  });

  it("treats a workspace with neither wallet nor history as fine, not as broken", async () => {
    const { notifier } = recordingNotifier();
    const client = fakeClient({ a: { wallet: null, ledger: [] } });

    expect(await verifyAllWallets(client, notifier, ["a"])).toEqual({ checked: 1, mismatch: null });
  });

  it("refuses to run at all when migration 0023 is not applied", async () => {
    // ⚠ NOT A FALLBACK TO `occurred_at`. That would page a human every time
    // two priced requests raced for one wallet, and a verifier that cries
    // wolf gets muted — which is indistinguishable from no verifier on the
    // night it matters.
    const { notifier, pages } = recordingNotifier();
    const client = fakeClient({ a: clean(600) }, { seqColumn: false });

    await expect(verifyAllWallets(client, notifier, ["a"])).rejects.toThrow(ReplayOrderingUnavailableError);
    expect(pages).toEqual([]);
  });
});

describe("STORY-073 scenario 7 · an automatic correction is not possible", () => {
  /**
   * ⚠ THE BEHAVIOURAL LAYER, because the source greps below do not bite on
   * their own. The second-engineer review wrote the obvious self-heal —
   * import `applyBucketDelta` from `wallet.js` rather than `adjustCredits`
   * from `balance.js`, nudge `included` toward the replayed value — and every
   * test in this file passed, all three scenario-7 tests included.
   *
   * ⚠ AND IT RECORDS THE ATTEMPT RATHER THAN RELYING ON THE THROW. A client
   * that merely refuses writes is defeated by `try {} catch {}`, which is how
   * a "best effort" self-heal would actually be written — and is how the
   * review wrote it. Re-running that exact mutant against a refuse-only
   * client passed. What cannot be swallowed is the fact that the statement
   * was issued at all.
   */
  function recordingClient(): { client: ClientBase; writes: string[] } {
    const writes: string[] = [];
    const query = async (sql: string): Promise<{ rows: unknown[]; rowCount: number }> => {
      if (!/^\s*(SELECT|WITH)\b/iu.test(sql)) {
        writes.push(sql.trim().slice(0, 80));
        throw new Error("this client is read-only");
      }
      if (sql.includes("information_schema.columns")) return { rows: [{ exists: 1 }], rowCount: 1 };
      if (sql.includes("FROM credit_wallets")) {
        return {
          rows: [
            {
              included_balance: "640",
              purchased_balance: "0",
              reserved: "0",
              cycle_end: "2026-10-01",
              lifetime_granted: "600",
              lifetime_purchased: "0",
              lifetime_spent: "0",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM credit_ledger")) {
        return {
          rows: [
            {
              seq: "1",
              entry_type: "grant",
              credits: "600",
              bucket: "included",
              idempotency_key: "g",
              attempt: 1,
              included_after: "600",
              purchased_after: "0",
              reserved_after: "0",
            },
          ],
          rowCount: 1,
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    };
    return { client: { query } as unknown as ClientBase, writes };
  }

  it("ATTEMPTS no statement but SELECT, against the most tempting mismatch there is", async () => {
    // A wallet 40 credits richer than its ledger. Setting it to 600 is one
    // line and hides whatever produced the 40.
    const { notifier, pages } = recordingNotifier();
    const { client, writes } = recordingClient();

    const result = await verifyAllWallets(client, notifier, ["a"]);

    expect(writes, `the verifier issued: ${writes.join(" | ")}`).toEqual([]);
    expect(result.mismatch?.wallet.included).toBe(640);
    expect(result.mismatch?.replayed.included).toBe(600);
    expect(pages).toHaveLength(1);
  });

  it("attempts none after the page either, which is where a tidy-up would go", async () => {
    // A self-heal sits most naturally AFTER the page — "we told someone, now
    // let us fix it". The notifier resolving is what would unblock it.
    const { client, writes } = recordingClient();

    await verifyAllWallets(client, { page: async () => Promise.resolve() }, ["a"]);

    expect(writes).toEqual([]);
  });

  const sourceOf = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

  const verifier = sourceOf("../../../src/workers/rollup/credit-verify.ts");
  const replay = sourceOf("../../../src/lib/credits/replay.ts");

  it("gives the verifier no way to reach the one function that can adjust a balance", () => {
    // ⚠ THE TEMPTATION IS A ONE-LINER AND THIS IS WHY IT IS FORBIDDEN. The
    // verifier is holding both numbers when it finds a mismatch; setting the
    // wallet to what the ledger replays to is obvious, quiet, and hides the
    // defect that caused the divergence. §6 rule 4: a discrepancy is
    // resolved by a human-authored `adjustment` with a reason, and the
    // system never silently rewrites a balance.
    // Matched as an IMPORT and as a CALL rather than as a substring: this
    // file's own header names `adjustCredits` when it explains the rule, and
    // a test that failed on its own documentation would be deleted by the
    // first person it inconvenienced.
    expect(verifier).not.toMatch(/from\s+"[^"]*credits\/balance\.js"/u);
    expect(verifier).not.toMatch(/\badjustCredits\s*\(/u);
  });

  it("gives neither the verifier nor the replay any statement that writes", () => {
    for (const [name, source] of [
      ["credit-verify.ts", verifier],
      ["replay.ts", replay],
    ] as const) {
      const writes = /\b(INSERT\s+INTO|UPDATE\s+credit_|DELETE\s+FROM)\b/i.exec(source);
      expect(writes, `${name} contains a writing statement: ${writes?.[0] ?? ""}`).toBeNull();
    }
  });

  it("keeps the wallet-reading helper read-only too", () => {
    // `verifyWorkspaceWallet` composes `readWallet` and `readLedgerForReplay`
    // and nothing else. If a future edit reaches for `applyBucketDelta` here,
    // the correction becomes possible again without anyone noticing.
    expect(replay).not.toMatch(/\bapplyBucketDelta\s*\(/u);
    expect(replay).not.toMatch(/\bappendLedgerEntry\s*\(/u);
  });
});
