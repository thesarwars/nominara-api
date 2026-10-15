import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAlertEmailerForTests } from "../../../lib/alerts/alerts.js";
import { LoggingPagingNotifier } from "./logging-paging-notifier.js";

// STORY-020 D-2 — LoggingPagingNotifier is a stub: it logs and returns. It
// deliberately does NOT set a process exit code — that decision belongs to
// the calling worker script (audit-verify.ts), not this class.

describe("STORY-020 · LoggingPagingNotifier", () => {
  // Group C — the notifier also emails when ALERT_EMAIL_TO is set. These cases are about the LOG line only, so they run
  // with alerts explicitly unconfigured (no emailer) rather than reading an environment this spec never set up.
  beforeEach(() => setAlertEmailerForTests(null));
  afterEach(() => setAlertEmailerForTests(undefined));

  it("logs the alert's workspaceId, seq, and reason via Logger.error", async () => {
    const errorSpy = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const notifier = new LoggingPagingNotifier();

    await notifier.page({ workspaceId: "ws-1", seq: "42", reason: "hash_mismatch" });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message] = errorSpy.mock.calls[0]!;
    expect(String(message)).toContain("ws-1");
    expect(String(message)).toContain("42");
    expect(String(message)).toContain("hash_mismatch");

    errorSpy.mockRestore();
  });

  it("never logs row content — only workspaceId, seq, and reason are passed", async () => {
    const errorSpy = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const notifier = new LoggingPagingNotifier();

    await notifier.page({ workspaceId: "ws-1", seq: "1", reason: "prev_hash_mismatch" });

    const [message] = errorSpy.mock.calls[0]!;
    expect(String(message)).not.toContain("before_state");
    expect(String(message)).not.toContain("after_state");

    errorSpy.mockRestore();
  });
});
