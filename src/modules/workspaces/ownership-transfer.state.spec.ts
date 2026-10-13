import { describe, expect, it } from "vitest";
import {
  OWNERSHIP_TRANSFER_TTL_MS,
  expiresAtOf,
  isExpired,
  isPending,
  parseTransfer,
} from "./ownership-transfer.state.js";

// STORY-021 (core slice) / EC-15 — the pure half of the transfer state machine:
// what the `workspaces.ownership_transfer` document means at a given instant.
// The service decides nothing about time or state except through these.

const INITIATED = "2026-10-01T00:00:00.000Z";
const initiatedMs = Date.parse(INITIATED);
const doc = (over: Record<string, unknown> = {}): unknown => ({
  state: "awaiting_acceptance",
  initiatedBy: "0199c000-0000-7000-8000-000000000001",
  recipientId: "0199c000-0000-7000-8000-000000000002",
  initiatedAt: INITIATED,
  expiresAt: new Date(initiatedMs + OWNERSHIP_TRANSFER_TTL_MS).toISOString(),
  ...over,
});

describe("STORY-021 / EC-15 · ownership transfer document — pure state rules", () => {
  it("EC-15 · the acceptance window is exactly seven days", () => {
    expect(OWNERSHIP_TRANSFER_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("EC-15 · a NULL column is 'none': not pending, not expired, nothing parsed", () => {
    expect(parseTransfer(null)).toBeNull();
    expect(isPending(null, new Date())).toBe(false);
    expect(isExpired(null, new Date())).toBe(false);
  });

  it("EC-15 · an unparsable document is treated as no transfer (fail closed: it can never be accepted)", () => {
    for (const garbage of [{}, "awaiting_acceptance", 7, [], { state: "awaiting_acceptance" }, { ...(doc() as object), recipientId: "not-a-uuid" }]) {
      const parsed = parseTransfer(garbage);
      expect(parsed, JSON.stringify(garbage)).toBeNull();
      expect(isPending(parsed, new Date(initiatedMs)), JSON.stringify(garbage)).toBe(false);
    }
  });

  it("EC-15 · pending one millisecond before expiry, EXPIRED exactly at expiry (the boundary fails closed)", () => {
    const parsed = parseTransfer(doc());
    const expiry = initiatedMs + OWNERSHIP_TRANSFER_TTL_MS;
    expect(isPending(parsed, new Date(expiry - 1))).toBe(true);
    expect(isExpired(parsed, new Date(expiry - 1))).toBe(false);
    expect(isPending(parsed, new Date(expiry))).toBe(false);
    expect(isExpired(parsed, new Date(expiry))).toBe(true);
    expect(isExpired(parsed, new Date(expiry + 1))).toBe(true);
  });

  it("EC-15 · a document written without expiresAt expires initiatedAt + 7 days, not never", () => {
    const parsed = parseTransfer(doc({ expiresAt: undefined }));
    expect(parsed).not.toBeNull();
    expect(expiresAtOf(parsed!).getTime()).toBe(initiatedMs + OWNERSHIP_TRANSFER_TTL_MS);
    expect(isExpired(parsed, new Date(initiatedMs + OWNERSHIP_TRANSFER_TTL_MS))).toBe(true);
  });

  it("EC-15 · only awaiting_acceptance is ever pending; every terminal state is inert however fresh it is", () => {
    for (const state of ["completed", "cancelled", "declined", "expired", "failed"]) {
      const parsed = parseTransfer(doc({ state }));
      expect(parsed, state).not.toBeNull();
      expect(isPending(parsed, new Date(initiatedMs)), state).toBe(false);
    }
  });

  it("EC-15 · an expired terminal state is not 'expired' again (expiry is something that happens to a PENDING transfer)", () => {
    const parsed = parseTransfer(doc({ state: "declined" }));
    expect(isExpired(parsed, new Date(initiatedMs + 10 * OWNERSHIP_TRANSFER_TTL_MS))).toBe(false);
  });
});
