import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { applyFakeApiEnv } from "../support/fake-env.js";
import type { EmailMessage, EmailSender } from "../../src/modules/identity/ports/email-sender.js";
import { EmailAlertAdapter, ALERT_EMAIL_COOLDOWN_MS, ALERT_EMAIL_MAX_PER_NAME_PER_WINDOW, renderAlertEmail } from "../../src/lib/alerts/email-alert.adapter.js";
import { getAlertEmailer, setAlertEmailerForTests, announceAlertRouting, drainAlertEmails } from "../../src/lib/alerts/alerts.js";
import {
  DLQ_DEPTH_PAGE_THRESHOLD,
  DLQ_DEPTH_SUSTAINED_MS,
  DlqDepthMonitor,
} from "../../src/lib/queue/dead-letter.js";
import { BLACKOUT_THRESHOLD_MS, BlackoutMonitor } from "../../src/lib/engines/blackout.js";
import { ParseAlertMonitor } from "../../src/lib/parser/parse-alerts.js";
import { LoggingPagingNotifier } from "../../src/modules/audit/adapters/logging-paging-notifier.js";
import { LoggingWalletPagingNotifier } from "../../src/modules/credits/adapters/logging-wallet-paging-notifier.js";

// Group C item 2 — alerts by email through the EMAIL_SENDER port. Every sender below is a fake; nothing is delivered.

const TO = "oncall@example.net";
const WORKSPACE_ID = "0198f2a0-0000-7000-8000-000000000001";

class FakeSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  failNext = 0;
  async send(message: EmailMessage): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("provider down");
    }
    this.sent.push(message);
  }
}

let sender: FakeSender;
let now: number;
let emailer: EmailAlertAdapter;
const logged: string[] = [];
const originalEnv = { ...process.env };

beforeEach(() => {
  applyFakeApiEnv();
  logged.length = 0;
  for (const level of ["log", "warn", "error", "debug", "verbose", "fatal"] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
  sender = new FakeSender();
  now = 1_700_000_000_000;
  emailer = new EmailAlertAdapter({ sender, to: TO, clock: () => now, environment: "test", delivers: true });
  setAlertEmailerForTests(emailer);
});

afterEach(() => {
  setAlertEmailerForTests(undefined);
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

describe("alert email · cooldown", () => {
  it("one sustained condition is ONE email per window, not one per tick", async () => {
    for (let tick = 0; tick < 50; tick += 1) {
      emailer.page("queue is deep", { alertName: "dlq_depth_sustained", queue: "capture.run", depth: 90 });
      now += 60_000;
    }
    await emailer.drain();
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.to).toBe(TO);
  });

  it("pages again once the cooldown has elapsed", async () => {
    emailer.page("queue is deep", { alertName: "dlq_depth_sustained", queue: "q1" });
    await emailer.drain();
    now += ALERT_EMAIL_COOLDOWN_MS - 1;
    emailer.page("queue is deep", { alertName: "dlq_depth_sustained", queue: "q1" });
    await emailer.drain();
    expect(sender.sent).toHaveLength(1);
    now += 1;
    emailer.page("queue is deep", { alertName: "dlq_depth_sustained", queue: "q1" });
    await emailer.drain();
    expect(sender.sent).toHaveLength(2);
  });

  it("is keyed by alert name AND subject: a different queue, workspace or alert is its own incident", async () => {
    emailer.page("m", { alertName: "dlq_depth_sustained", queue: "q1" });
    emailer.page("m", { alertName: "dlq_depth_sustained", queue: "q2" });
    emailer.page("m", { alertName: "engine_blackout", engineKey: "q1" });
    await emailer.drain();
    expect(sender.sent).toHaveLength(3);
  });

  it("a FAILED send releases its claim, so the next occurrence tries again instead of being swallowed", async () => {
    sender.failNext = 1;
    emailer.page("m", { alertName: "engine_blackout", engineKey: "gemini" });
    await emailer.drain();
    expect(sender.sent).toHaveLength(0);
    emailer.page("m", { alertName: "engine_blackout", engineKey: "gemini" });
    await emailer.drain();
    expect(sender.sent).toHaveLength(1);
  });

  it("a send failure never throws into the caller", async () => {
    sender.failNext = 1;
    expect(() => emailer.page("m", { alertName: "x" })).not.toThrow();
    await expect(emailer.notify("m", { alertName: "y" })).resolves.toBeUndefined();
  });
});

describe("alert email · body carries IDs only", () => {
  it("omits free-text values, redacts anything address-shaped, keeps ids and numbers", () => {
    const rendered = renderAlertEmail(
      `trouble for ${TO} in workspace ${WORKSPACE_ID}`,
      {
        alertName: "sentiment_escalation_rate",
        workspaceId: WORKSPACE_ID,
        rate: 0.31,
        promptText: "what is the best CRM for alice@example.org",
        email: "alice@example.org",
        reason: "mailto alice@example.org",
      },
      "test",
      new Date(0),
    );
    const everything = `${rendered.subject}\n${rendered.textBody}`;
    expect(everything).toContain(WORKSPACE_ID);
    expect(everything).toContain("0.31");
    expect(everything).not.toContain("alice");
    expect(everything).not.toContain("best CRM");
    expect(everything).not.toContain(TO);
    expect(rendered.textBody).toContain("promptText: [omitted]");
  });
});

describe("alert email · no-config fallback", () => {
  it("ALERT_EMAIL_TO unset: no emailer, the pager sites keep their log line and counter, and ONE warning says alerts go nowhere", () => {
    setAlertEmailerForTests(undefined);
    delete process.env.ALERT_EMAIL_TO;
    expect(getAlertEmailer()).toBeNull();
    announceAlertRouting();
    announceAlertRouting();
    const warnings = logged.filter((line) => line.includes("ALERT_EMAIL_TO is not set"));
    expect(warnings).toHaveLength(1);

    const monitor = new DlqDepthMonitor({ clock: () => now });
    monitor.observe("capture.run", DLQ_DEPTH_PAGE_THRESHOLD + 1);
    now += DLQ_DEPTH_SUSTAINED_MS;
    expect(() => monitor.observe("capture.run", DLQ_DEPTH_PAGE_THRESHOLD + 1)).not.toThrow();
    expect(logged.some((line) => line.includes("nominara_queue_dlq_depth_page_total"))).toBe(true);
  });

  it("ALERT_EMAIL_TO set: builds the emailer from env and a page reaches the configured sender (Resend, over a fake fetch)", async () => {
    setAlertEmailerForTests(undefined);
    process.env.ALERT_EMAIL_TO = TO;
    process.env.RESEND_API_KEY = "re_test_PLACEHOLDER";
    process.env.RESEND_FROM_EMAIL = "Nominara <no-reply@nominara.test>";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "m" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const built = getAlertEmailer();
      expect(built).not.toBeNull();
      built!.page("m", { alertName: "dlq_depth_sustained", queue: "q1" });
      await built!.drain();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as { to: string[]; subject: string };
      expect(body.to).toEqual([TO]);
      expect(body.subject).toContain("dlq_depth_sustained");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("alert email · an unloadable environment never replaces the failure being reported", () => {
  it("a page with a broken env resolves, is not emailed, and says so in an error line", async () => {
    setAlertEmailerForTests(undefined);
    delete process.env.OTP_EMAIL_HASH_PEPPER; // a required key: loadEnv() now throws
    await expect(
      new LoggingPagingNotifier().page({ workspaceId: WORKSPACE_ID, seq: "1", reason: "chain_broken" }),
    ).resolves.toBeUndefined();
    expect(logged.some((line) => line.includes("alert email unavailable") && line.includes("EnvValidationError"))).toBe(true);
    expect(sender.sent).toHaveLength(0);
    const monitor = new DlqDepthMonitor({ clock: () => now });
    monitor.observe("q", DLQ_DEPTH_PAGE_THRESHOLD + 1);
    now += DLQ_DEPTH_SUSTAINED_MS;
    expect(() => monitor.observe("q", DLQ_DEPTH_PAGE_THRESHOLD + 1)).not.toThrow();
  });
});

describe("alert email · every existing page site sends exactly one email for its condition", () => {
  it("SLO-24 dead-letter depth (DlqDepthMonitor, default pager)", async () => {
    const monitor = new DlqDepthMonitor({ clock: () => now });
    monitor.observe("capture.run", DLQ_DEPTH_PAGE_THRESHOLD + 5);
    now += DLQ_DEPTH_SUSTAINED_MS;
    for (let tick = 0; tick < 10; tick += 1) {
      monitor.observe("capture.run", DLQ_DEPTH_PAGE_THRESHOLD + 5);
      now += 30_000;
    }
    await emailer.drain();
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.subject).toContain("dlq_depth_sustained");
    expect(sender.sent[0]!.textBody).toContain("capture.run");
  });

  it("EC-06 engine blackout (BlackoutMonitor, default pager); a second monitor instance in the same window is suppressed by the email cooldown", async () => {
    const first = new BlackoutMonitor(undefined, () => now);
    const second = new BlackoutMonitor(undefined, () => now);
    first.observe("gemini", false);
    second.observe("gemini", false);
    now += BLACKOUT_THRESHOLD_MS + 1;
    first.observe("gemini", false);
    first.observe("gemini", false);
    second.observe("gemini", false);
    await emailer.drain();
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.subject).toContain("engine_blackout");
    expect(sender.sent[0]!.subject).toContain("gemini");
  });

  it.each([
    ["citation_resolution_failure", { citationsAttempted: 40, citationsFailed: 30, mentions: 0, escalatedMentions: 0, capableMentions: 0, classifiedFromElements: 0 }],
    ["sentiment_escalation_rate", { citationsAttempted: 0, citationsFailed: 0, mentions: 60, escalatedMentions: 40, capableMentions: 0, classifiedFromElements: 0 }],
    ["rendering_classification_coverage", { citationsAttempted: 0, citationsFailed: 0, mentions: 0, escalatedMentions: 0, capableMentions: 60, classifiedFromElements: 10 }],
  ])("parse alert %s (ParseAlertMonitor, default pager)", async (kind, counts) => {
    const monitor = new ParseAlertMonitor({ clock: () => now });
    const observation = { workspaceId: WORKSPACE_ID, engineKey: "gemini", ...counts };
    monitor.observe(observation);
    monitor.observe(observation);
    await emailer.drain();
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.subject).toContain(kind);
  });

  it("STORY-020 audit-chain mismatch (LoggingPagingNotifier)", async () => {
    await new LoggingPagingNotifier().page({ workspaceId: WORKSPACE_ID, seq: "42", reason: "chain_broken" });
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.subject).toContain("audit_chain_mismatch");
    expect(sender.sent[0]!.textBody).toContain(WORKSPACE_ID);
    expect(sender.sent[0]!.textBody).toContain("42");
  });

  it("STORY-073 wallet mismatch (LoggingWalletPagingNotifier) carries the balances as numbers", async () => {
    await new LoggingWalletPagingNotifier().page({
      workspaceId: WORKSPACE_ID,
      seq: "17",
      reason: "the balance this entry records is not the balance replaying the ledger produces",
      wallet: { included: 10, purchased: 5, reserved: 0 },
      replayed: { included: 12, purchased: 5, reserved: 0 },
      counter: null,
    });
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.subject).toContain("wallet_ledger_mismatch");
    expect(sender.sent[0]!.textBody).toContain(WORKSPACE_ID);
    expect(sender.sent[0]!.textBody).toMatch(/wallet_included: 10/);
    expect(sender.sent[0]!.textBody).toMatch(/replayed_included: 12/);
  });

  it("STORY-073 a lifetime-counter mismatch carries the counter name and both values", async () => {
    await new LoggingWalletPagingNotifier().page({
      workspaceId: WORKSPACE_ID,
      seq: null,
      reason: "the balances reconcile and lifetime_granted does not: a movement was counted wrong",
      wallet: { included: 10, purchased: 5, reserved: 0 },
      replayed: { included: 10, purchased: 5, reserved: 0 },
      counter: { counter: "granted", wallet: 120, replayed: 100 },
    });
    expect(sender.sent[0]!.textBody).toContain("counter: granted");
    expect(sender.sent[0]!.textBody).toContain("counter_wallet: 120");
    expect(sender.sent[0]!.textBody).toContain("counter_replayed: 100");
  });

  it("notify never rejects, even when dispatch itself blows up (a throwing clock)", async () => {
    const broken = new EmailAlertAdapter({ sender, to: TO, delivers: true, clock: () => { throw new Error("clock exploded"); } });
    await expect(broken.notify("m", { alertName: "x" })).resolves.toBeUndefined();
    expect(logged.some((l) => l.includes("dispatch failed unexpectedly") && l.includes("Error"))).toBe(true);
    expect(logged.some((l) => l.includes("clock exploded"))).toBe(false);
  });

  it("a verifier port still resolves when the mail fails (an alert path cannot fail the verifier)", async () => {
    sender.failNext = 1;
    await expect(
      new LoggingPagingNotifier().page({ workspaceId: WORKSPACE_ID, seq: "1", reason: "chain_broken" }),
    ).resolves.toBeUndefined();
  });
});

describe("alert email · honesty about delivery", () => {
  function metrics(): string[] {
    return logged.filter((line) => line.includes("nominara_alerts_email_total"));
  }

  it("a sender that delivers to nobody is counted not_delivered and never logged as emailed", async () => {
    const quiet = new EmailAlertAdapter({ sender, to: TO, clock: () => now, delivers: false });
    quiet.page("m", { alertName: "engine_blackout", engineKey: "gemini" });
    await quiet.drain();
    expect(metrics().some((l) => l.includes('"outcome":"not_delivered"'))).toBe(true);
    expect(metrics().some((l) => l.includes('"outcome":"sent"'))).toBe(false);
    expect(logged.some((l) => l.includes("alert emailed"))).toBe(false);
    expect(logged.some((l) => l.includes("NOT delivered"))).toBe(true);
  });

  it("outside production, ALERT_EMAIL_TO without Resend builds a non-delivering emailer, warns once, and its alert is not_delivered", async () => {
    setAlertEmailerForTests(undefined);
    process.env.NODE_ENV = "development";
    process.env.ALERT_EMAIL_TO = TO;
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
    const built = getAlertEmailer()!;
    announceAlertRouting();
    expect(logged.filter((l) => l.includes("alerts are NOT delivered"))).toHaveLength(1);
    expect(logged.some((l) => l.includes("are emailed to ALERT_EMAIL_TO"))).toBe(false);
    built.page("m", { alertName: "dlq_depth_sustained", queue: "q" });
    await built.drain();
    expect(metrics().some((l) => l.includes('"outcome":"not_delivered"'))).toBe(true);
    expect(metrics().some((l) => l.includes('"outcome":"sent"'))).toBe(false);
  });

  it("with Resend configured the alert is counted sent", async () => {
    setAlertEmailerForTests(undefined);
    process.env.NODE_ENV = "development";
    process.env.ALERT_EMAIL_TO = TO;
    process.env.RESEND_API_KEY = "re_test_PLACEHOLDER";
    process.env.RESEND_FROM_EMAIL = "Nominara <no-reply@nominara.test>";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "m" }), { status: 200 })));
    try {
      const built = getAlertEmailer()!;
      built.page("m", { alertName: "dlq_depth_sustained", queue: "q" });
      await built.drain();
      expect(metrics().some((l) => l.includes('"outcome":"sent"'))).toBe(true);
      expect(logged.some((l) => l.includes("are emailed to ALERT_EMAIL_TO through Resend"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("alert email · per-name cap", () => {
  it("a verifier run that finds many subjects sends the cap, suppresses the rest, and logs ONE 'N more suppressed' line", async () => {
    for (let i = 0; i < 12; i += 1) {
      await emailer.notify("m", { alertName: "audit_chain_mismatch", workspaceId: `ws-${i}` });
    }
    await emailer.drain();
    expect(sender.sent).toHaveLength(ALERT_EMAIL_MAX_PER_NAME_PER_WINDOW);
    const suppressedMetrics = logged.filter((l) => l.includes("nominara_alerts_email_total") && l.includes('"outcome":"suppressed"'));
    expect(suppressedMetrics).toHaveLength(12 - ALERT_EMAIL_MAX_PER_NAME_PER_WINDOW);
    expect(logged.filter((l) => l.includes("7 more suppressed name=audit_chain_mismatch"))).toHaveLength(1);
  });

  it("is per NAME: another alert still sends", async () => {
    for (let i = 0; i < 7; i += 1) await emailer.notify("m", { alertName: "audit_chain_mismatch", workspaceId: `ws-${i}` });
    await emailer.notify("m", { alertName: "wallet_ledger_mismatch", workspaceId: "ws-x" });
    expect(sender.sent.filter((m) => m.subject.includes("wallet_ledger_mismatch"))).toHaveLength(1);
  });

  it("the cap resets with the window", async () => {
    for (let i = 0; i < 6; i += 1) await emailer.notify("m", { alertName: "audit_chain_mismatch", workspaceId: `ws-${i}` });
    now += ALERT_EMAIL_COOLDOWN_MS;
    await emailer.notify("m", { alertName: "audit_chain_mismatch", workspaceId: "ws-new" });
    expect(sender.sent).toHaveLength(ALERT_EMAIL_MAX_PER_NAME_PER_WINDOW + 1);
  });

  it("a failed send does not consume the cap", async () => {
    sender.failNext = 3;
    for (let i = 0; i < 3; i += 1) await emailer.notify("m", { alertName: "audit_chain_mismatch", workspaceId: `f-${i}` });
    for (let i = 0; i < 5; i += 1) await emailer.notify("m", { alertName: "audit_chain_mismatch", workspaceId: `ok-${i}` });
    expect(sender.sent).toHaveLength(5);
  });
});

describe("alert email · shutdown drain", () => {
  it("drainAlertEmails waits for an in-flight send but is bounded when the provider hangs", async () => {
    const hung: EmailSender = { send: () => new Promise<void>(() => {}) };
    const stuck = new EmailAlertAdapter({ sender: hung, to: TO, delivers: true });
    setAlertEmailerForTests(stuck);
    stuck.page("m", { alertName: "x" });
    const started = performance.now();
    await drainAlertEmails(50);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(logged.some((l) => l.includes("alert email drain timed out"))).toBe(true);
  });

  it("drainAlertEmails returns once pending sends settle", async () => {
    emailer.page("m", { alertName: "x" });
    await drainAlertEmails(5000);
    expect(sender.sent).toHaveLength(1);
  });
});
