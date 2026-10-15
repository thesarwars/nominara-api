import type { ClientBase } from "pg";
import { describe, expect, it } from "vitest";
import { releaseReservation, ReservationSettlementError } from "../../../src/lib/credits/settle.js";

// STORY-073 — the branches `releaseReservation` cannot reach against a real
// database, which is exactly why they need a test.
//
// Under the wallet row lock the ledger cannot gain a settlement entry between
// the check and the insert, so the "the index refused my entry" branch is
// unreachable in the integration suite. Unreachable is not the same as
// unnecessary: it guards the 40 credits the second-engineer review watched
// disappear out of an unrelated live hold when an earlier version returned
// that refusal as a boolean and let the caller commit the balance movement
// anyway.

interface Script {
  readonly walletLocked?: boolean;
  readonly settlement?: "commit" | "release" | null;
  readonly appendConflicts?: boolean;
  readonly walletVanishes?: boolean;
}

function fakeTx(script: Script): { tx: ClientBase; statements: string[] } {
  const statements: string[] = [];
  const query = async (sql: string): Promise<{ rows: unknown[]; rowCount: number }> => {
    statements.push(sql.trim().split("\n")[0]!.trim());

    if (sql.includes("FOR UPDATE")) {
      return { rows: script.walletLocked === false ? [] : [{ ok: 1 }], rowCount: script.walletLocked === false ? 0 : 1 };
    }
    if (sql.includes("SELECT entry_type FROM credit_ledger")) {
      const settlement = script.settlement ?? null;
      return settlement === null ? { rows: [], rowCount: 0 } : { rows: [{ entry_type: settlement }], rowCount: 1 };
    }
    // STORY-072 AC13: closing the hold's carry. These scripts release holds that carry nothing across a cycle roll.
    if (sql.startsWith("UPDATE credit_hold_carries")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("UPDATE credit_wallets")) return { rows: [], rowCount: 1 };
    if (sql.includes("FROM credit_wallets WHERE workspace_id")) {
      return script.walletVanishes === true
        ? { rows: [], rowCount: 0 }
        : {
            rows: [{ included_balance: "600", purchased_balance: "0", reserved: "0", cycle_end: "2026-10-01" }],
            rowCount: 1,
          };
    }
    if (sql.includes("INSERT INTO credit_ledger")) {
      return { rows: [], rowCount: script.appendConflicts === true ? 0 : 1 };
    }
    throw new Error(`unexpected query: ${sql}`);
  };
  return { tx: { query } as unknown as ClientBase, statements };
}

const RESERVATION = {
  workspaceId: "ws-1",
  idempotencyKey: "job",
  attempt: 1,
  credits: 40,
  actionCode: "manual_scan",
} as const;

describe("STORY-073 · releaseReservation", () => {
  it("releases an open reservation and records it", async () => {
    const { tx, statements } = fakeTx({});
    expect(await releaseReservation(tx, RESERVATION)).toBe("released");
    expect(statements.some((sql) => sql.includes("INSERT INTO credit_ledger"))).toBe(true);
  });

  it("⚠ takes the wallet row lock BEFORE reading the ledger", async () => {
    // The order is the fix. Reading first and locking second is a
    // check-then-act, and the window between them is where two releasers both
    // decide to proceed.
    const { tx, statements } = fakeTx({});
    await releaseReservation(tx, RESERVATION);

    const lockAt = statements.findIndex((sql) => sql.includes("FOR UPDATE"));
    const readAt = statements.findIndex((sql) => sql.includes("SELECT entry_type FROM credit_ledger"));
    const moveAt = statements.findIndex((sql) => sql.startsWith("UPDATE credit_wallets"));
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(lockAt).toBeLessThan(readAt);
    expect(readAt).toBeLessThan(moveAt);
  });

  for (const settlement of ["commit", "release"] as const) {
    it(`moves nothing when the attempt was already settled by a ${settlement}`, async () => {
      const { tx, statements } = fakeTx({ settlement });
      expect(await releaseReservation(tx, RESERVATION)).toBe("already_settled");
      expect(statements.some((sql) => sql.startsWith("UPDATE credit_wallets"))).toBe(false);
      expect(statements.some((sql) => sql.includes("INSERT INTO credit_ledger"))).toBe(false);
    });
  }

  it("⚠ THROWS when the ledger refuses the release entry, rather than returning the refusal", async () => {
    // ⚠ UNREACHABLE AGAINST A REAL DATABASE, AND THAT IS NOT A REASON TO
    // LEAVE IT UNTESTED. The balance has already moved by this point in the
    // function; returning instead of throwing lets the caller COMMIT a
    // release the ledger just refused to record. The review reproduced
    // exactly that: two reconciler runs, one release entry, and 40 credits
    // taken out of a live reservation belonging to someone else.
    const { tx } = fakeTx({ appendConflicts: true });
    await expect(releaseReservation(tx, RESERVATION)).rejects.toThrow(ReservationSettlementError);
  });

  it("refuses a workspace with no wallet row to release against", async () => {
    const { tx, statements } = fakeTx({ walletLocked: false });
    await expect(releaseReservation(tx, RESERVATION)).rejects.toThrow(/no wallet row/u);
    expect(statements.some((sql) => sql.startsWith("UPDATE credit_wallets"))).toBe(false);
  });

  it("refuses rather than inventing an after-state if the wallet vanishes mid-release", async () => {
    const { tx } = fakeTx({ walletVanishes: true });
    await expect(releaseReservation(tx, RESERVATION)).rejects.toThrow(/lost its wallet row/u);
  });
});
