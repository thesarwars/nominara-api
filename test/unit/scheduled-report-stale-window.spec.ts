import { describe, expect, it } from "vitest";
import { SCHEDULED_REPORT_MAX_RECIPIENTS } from "../../contracts/reports/index.js";
import {
  RESEND_BACKOFF_BASE_MS,
  RESEND_MAX_ATTEMPTS,
  RESEND_MAX_RETRY_AFTER_MS,
  RESEND_TIMEOUT_MS,
  RESEND_WORST_CASE_SEND_MS,
} from "../../src/modules/identity/adapters/resend-email-sender.adapter.js";
import { STALE_SENDING_MARGIN_MS, STALE_SENDING_MS } from "../../src/modules/reports/scheduled-reports.service.js";

// Group C review — a `sending` delivery is read as `failed` once it is older than STALE_SENDING_MS. That must NEVER be shorter
// than a legitimate delivery: recipients go one at a time, each send can take attempts x timeout plus the sleeps between them.

describe("STALE_SENDING_MS covers the slowest legitimate delivery", () => {
  it("is at least recipients x the worst-case send, spelled out independently of the production formula", () => {
    // Independent arithmetic from the raw constants: every attempt hits its timeout; each retry sleeps the Retry-After cap
    // (which is larger than any backoff step).
    const worstSend = RESEND_MAX_ATTEMPTS * RESEND_TIMEOUT_MS + (RESEND_MAX_ATTEMPTS - 1) * Math.max(RESEND_MAX_RETRY_AFTER_MS, RESEND_BACKOFF_BASE_MS * 2 ** RESEND_MAX_ATTEMPTS * 1.5);
    expect(RESEND_WORST_CASE_SEND_MS).toBeGreaterThanOrEqual(worstSend);
    expect(STALE_SENDING_MS).toBeGreaterThanOrEqual(SCHEDULED_REPORT_MAX_RECIPIENTS * worstSend + STALE_SENDING_MARGIN_MS);
  });

  it("is pinned: growing any recipient/timeout/attempt/Retry-After constant fails here, forcing a deliberate look at the window", () => {
    expect(SCHEDULED_REPORT_MAX_RECIPIENTS).toBe(25);
    expect(RESEND_WORST_CASE_SEND_MS).toBe(90_000);
    expect(STALE_SENDING_MS).toBe(25 * 90_000 + 5 * 60_000); // 42.5 minutes
  });
});
