import { describe, expect, it } from "vitest";
import { autoTopupJobKey } from "./auto-topup-request.js";

const WS = "11111111-1111-7111-8111-111111111111";

describe("NEW-D-7 checkpoint-3 · the auto-top-up job's dedup key", () => {
  it("NEW-D-7-KEY-1 · two debits within the same UTC minute share one key, so a burst enqueues one job", () => {
    expect(autoTopupJobKey(WS, new Date("2026-10-08T12:34:05Z"))).toBe(autoTopupJobKey(WS, new Date("2026-10-08T12:34:59.999Z")));
  });

  it("NEW-D-7-KEY-2 · the next minute is a new key, so a balance that is still low is re-evaluated", () => {
    expect(autoTopupJobKey(WS, new Date("2026-10-08T12:34:59.999Z"))).not.toBe(autoTopupJobKey(WS, new Date("2026-10-08T12:35:00Z")));
  });

  it("NEW-D-7-KEY-3 · the key names the workspace, so two tenants never share a job", () => {
    const other = "22222222-2222-7222-8222-222222222222";
    expect(autoTopupJobKey(WS, new Date("2026-10-08T12:34:00Z"))).not.toBe(autoTopupJobKey(other, new Date("2026-10-08T12:34:00Z")));
    expect(autoTopupJobKey(WS, new Date("2026-10-08T12:34:00Z"))).toBe(`autotopup:${WS}:202610081234`);
  });
});
