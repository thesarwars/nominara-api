import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as writePool from "./billing-write-pool.js";

// Checkpoint-6 (major). The write pool's bounds (transaction-local statement_timeout and lock_timeout, the
// client `error` listener that keeps pgBouncer closing a connection from being fatal, the 503 mapping) live in
// `inBillingWriteTransaction` ONLY. Nothing tested that a money path calls it: swapping a caller back to
// `connectForWrite` + `withTenantContext` (mutants M12, M13, M14: CreditPacksService.inOwnTransaction,
// BillingSubscriptionService.inOwnTransaction, BillingAddonsService.persistIntents) passed every billing test.
// So the write pool hands out a client in exactly one way, and this pins both halves of that.

const BILLING_DIR = new URL(".", import.meta.url);
const sources = readdirSync(BILLING_DIR)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".spec.ts") && name !== "billing-write-pool.ts" && name !== "billing.module.ts") // the module builds and ends the pool; it hands out no client
  .map((name) => ({ name, text: readFileSync(new URL(name, BILLING_DIR), "utf8") }));
const consumers = sources.filter(({ text }) => text.includes("BILLING_WRITE_POOL") && /@Inject\(BILLING_WRITE_POOL\)/u.test(text));

describe("checkpoint-6 · inBillingWriteTransaction is the only way to a write-pool client", () => {
  it("D-3 AC-write-pool-private . connectForWrite is not exported: no caller can check a write-pool client out without the bounds", () => {
    expect(writePool).not.toHaveProperty("connectForWrite");
  });

  it("D-3 AC-write-pool-consumers . the three money services (checkout, credit packs, add-ons) are the consumers the pin covers", () => {
    expect(consumers.map(({ name }) => name).sort()).toEqual(["billing-addons.service.ts", "billing-subscription.service.ts", "credit-packs.service.ts"]);
  });

  it.each(consumers.map(({ name, text }) => [name, text] as const))("D-3 AC-write-pool-usage . %s touches its injected write pool only as the first argument of inBillingWriteTransaction", (_name, text) => {
    const field = /@Inject\(BILLING_WRITE_POOL\)\s+private readonly (\w+)\s*:/u.exec(text)?.[1];
    expect(field, "the injected write pool field").toBeDefined();
    expect(text, "imports the unbounded checkout").not.toMatch(/\bconnectForWrite\b/u);
    const withoutBoundedUse = text.split(`inBillingWriteTransaction(this.${field!},`).join("");
    expect(withoutBoundedUse, `this.${field!} is used other than through inBillingWriteTransaction`).not.toMatch(new RegExp(`this\\.${field!}\\b`, "u"));
    expect(text, "calls inBillingWriteTransaction at all").toContain(`inBillingWriteTransaction(this.${field!},`);
  });
});
