import { createHash } from "node:crypto";
import type { ClientBase } from "pg";
import { describe, expect, it, vi } from "vitest";
import { REPORT_ATTACHMENT_MAX_BYTES } from "../../../contracts/reports/index.js";
import {
  hashReportLinkToken,
  planArtifactMail,
  reportLinkToken,
  reportLinkUrl,
  resolveMailParts,
  type ArtifactMailDeps,
} from "../../../src/lib/reports/report-artifact-mail.js";
import { sendReportEmails } from "../../../src/lib/reports/run-scheduled-report.js";

// STORY-180 AC3 - a scheduled-report email attaches a file of at most 8 MiB (8,388,608 bytes, owner decision 54 (4)) and otherwise
// carries a 7-day link issued through a stored, revocable token (decision 54 (3)).

const WS = "0190bbbb-0000-7000-8000-000000000001";
const A1 = "0190bbbb-0000-7000-8000-0000000000a1";
const A2 = "0190bbbb-0000-7000-8000-0000000000a2";
const KEY = Buffer.alloc(32, 7);
const BASE = "https://api.example.test";

interface Row {
  id: string;
  format: "pdf" | "csv";
  bytes: number;
  period_end: string;
}

function fixture(rows: Row[], over: Partial<ArtifactMailDeps> = {}) {
  const sql: Array<{ text: string; params: unknown[] }> = [];
  const tx = {
    query: vi.fn(async (text: string, params: unknown[] = []) => {
      sql.push({ text, params });
      if (/FROM report_artifacts/.test(text)) return { rows };
      return { rows: [], rowCount: 1 };
    }),
  } as unknown as ClientBase;
  const get = vi.fn(async (_ns: string, relative: string) => Buffer.from(`bytes-of-${relative}`));
  const uploaded = vi.fn(async () => undefined);
  const deps: ArtifactMailDeps = {
    store: { bind: () => ({ get }) } as never,
    apiBaseUrl: BASE,
    signingKey: KEY,
    uploaded,
    ...over,
  };
  return { tx, sql, get, uploaded, deps };
}

describe("STORY-180 AC3 · the link token", () => {
  it("is 43 base64url characters, deterministic per artifact and key, and different for another artifact or key", () => {
    const t = reportLinkToken(KEY, A1);
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(reportLinkToken(KEY, A1)).toBe(t);
    expect(reportLinkToken(KEY, A2)).not.toBe(t);
    expect(reportLinkToken(Buffer.alloc(32, 8), A1)).not.toBe(t);
  });

  it("is stored as its SHA-256, never itself", () => {
    const t = reportLinkToken(KEY, A1);
    expect(hashReportLinkToken(t).equals(createHash("sha256").update(t).digest())).toBe(true);
  });

  it("the URL is an API route carrying the workspace id and the token", () => {
    const t = reportLinkToken(KEY, A1);
    expect(reportLinkUrl(BASE, WS, t)).toBe(`${BASE}/v1/report-links/${WS}/${t}`);
    expect(reportLinkUrl(`${BASE}/`, WS, t)).toBe(`${BASE}/v1/report-links/${WS}/${t}`);
  });
});

describe("STORY-180 AC3 · attach or link", () => {
  it("a file of exactly 8,388,608 bytes is attached; one byte more is linked (the boundary)", async () => {
    expect(REPORT_ATTACHMENT_MAX_BYTES).toBe(8_388_608);
    const f = fixture([
      { id: A1, format: "pdf", bytes: 8_388_608, period_end: "2026-10-31" },
      { id: A2, format: "pdf", bytes: 8_388_609, period_end: "2026-10-31" },
    ]);
    const plan = await planArtifactMail(f.tx, f.deps, WS, [A1, A2]);
    expect(plan.items.map((i) => i.link === null)).toEqual([true, false]);
    expect(plan.items[1]!.link).toBe(reportLinkUrl(BASE, WS, reportLinkToken(KEY, A2)));
  });

  it("a zero-byte file is attached, not linked", async () => {
    const f = fixture([{ id: A1, format: "csv", bytes: 0, period_end: "2026-10-31" }]);
    const plan = await planArtifactMail(f.tx, f.deps, WS, [A1]);
    expect(plan.items[0]!.link).toBeNull();
  });

  it("stores the hash of the token for a linked file only, in the same transaction", async () => {
    const f = fixture([
      { id: A1, format: "pdf", bytes: 10, period_end: "2026-10-31" },
      { id: A2, format: "pdf", bytes: 9_000_000, period_end: "2026-10-31" },
    ]);
    await planArtifactMail(f.tx, f.deps, WS, [A1, A2]);
    const writes = f.sql.filter((s) => /UPDATE report_artifacts/.test(s.text));
    expect(writes).toHaveLength(1);
    expect(writes[0]!.params[0]).toBe(A2);
    expect((writes[0]!.params[1] as Buffer).equals(hashReportLinkToken(reportLinkToken(KEY, A2)))).toBe(true);
    // The raw token is never written.
    expect(JSON.stringify(writes[0]!.params)).not.toContain(reportLinkToken(KEY, A2));
  });

  it("without a signing key an oversize file fails closed (no link without a token)", async () => {
    const f = fixture([{ id: A1, format: "pdf", bytes: 9_000_000, period_end: "2026-10-31" }], { signingKey: undefined });
    await expect(planArtifactMail(f.tx, f.deps, WS, [A1])).rejects.toThrow(/link/i);
  });

  it("an artifact that is not in the workspace's table fails rather than being skipped", async () => {
    const f = fixture([]);
    await expect(planArtifactMail(f.tx, f.deps, WS, [A1])).rejects.toThrow(/artifact/i);
  });

  it("reads an attachment only after the upload has landed, and reads a linked file not at all", async () => {
    const order: string[] = [];
    const f = fixture([
      { id: A1, format: "pdf", bytes: 100, period_end: "2026-10-31" },
      { id: A2, format: "csv", bytes: 9_000_000, period_end: "2026-10-31" },
    ]);
    f.uploaded.mockImplementation(async () => void order.push("uploaded"));
    f.get.mockImplementation(async (_n: string, r: string) => {
      order.push(`get:${r}`);
      return Buffer.from("x");
    });
    const parts = await resolveMailParts(await planArtifactMail(f.tx, f.deps, WS, [A1, A2]));
    expect(order).toEqual(["uploaded", `get:${A1}.pdf`]);
    expect(parts.attachments).toHaveLength(1);
    expect(parts.attachments[0]).toMatchObject({ contentType: "application/pdf" });
    expect(parts.links).toHaveLength(1);
  });
});

describe("STORY-180 AC3 · the email", () => {
  async function send(rows: Row[], over: Partial<ArtifactMailDeps> = {}, recipients = ["a@example.test", "b@example.test"]) {
    const f = fixture(rows, over);
    const plan = await planArtifactMail(f.tx, f.deps, WS, rows.map((r) => r.id));
    const sent: Array<{ to: string; textBody: string; attachments?: Array<{ filename: string; content: Buffer; contentType?: string }> }> = [];
    const email = { send: vi.fn(async (m: (typeof sent)[number]) => void sent.push(m)) };
    const result = await sendReportEmails(email as never, { name: "Monthly", recipients }, plan, {});
    return { f, sent, result, email };
  }

  it("a small file travels as an attachment with its real bytes and no link", async () => {
    const { sent, result } = await send([{ id: A1, format: "pdf", bytes: 100, period_end: "2026-10-31" }]);
    expect(result.sent).toBe(2);
    expect(sent[0]!.attachments).toHaveLength(1);
    expect(sent[0]!.attachments![0]!.content.toString()).toBe(`bytes-of-${A1}.pdf`);
    expect(sent[0]!.attachments![0]!.filename).toBe("nominara-report-2026-10-31.pdf");
    expect(sent[0]!.textBody).not.toContain("report-links");
  });

  it("an oversize file travels as a 7-day link and no attachment", async () => {
    const { sent } = await send([{ id: A1, format: "pdf", bytes: 9_000_000, period_end: "2026-10-31" }]);
    expect(sent[0]!.attachments ?? []).toHaveLength(0);
    expect(sent[0]!.textBody).toContain(reportLinkUrl(BASE, WS, reportLinkToken(KEY, A1)));
    expect(sent[0]!.textBody).toContain("7 days");
  });

  it("the body is byte-identical for every recipient and across a re-plan (the provider's idempotency key requires it)", async () => {
    const rows: Row[] = [{ id: A1, format: "pdf", bytes: 9_000_000, period_end: "2026-10-31" }];
    const first = await send(rows);
    const second = await send(rows);
    expect(first.sent[0]!.textBody).toBe(first.sent[1]!.textBody);
    expect(second.sent[0]!.textBody).toBe(first.sent[0]!.textBody);
  });

  it("several files of one format get distinct attachment names", async () => {
    const { sent } = await send([
      { id: A1, format: "pdf", bytes: 10, period_end: "2026-10-31" },
      { id: A2, format: "pdf", bytes: 10, period_end: "2026-10-31" },
    ]);
    const names = sent[0]!.attachments!.map((a) => a.filename);
    expect(new Set(names).size).toBe(2);
  });

  it("a file that never reached storage fails every recipient and sends nothing (never a mail with a missing file)", async () => {
    const f = fixture([{ id: A1, format: "pdf", bytes: 10, period_end: "2026-10-31" }]);
    f.get.mockRejectedValue(new Error("no such object"));
    const plan = await planArtifactMail(f.tx, f.deps, WS, [A1]);
    const email = { send: vi.fn() };
    const result = await sendReportEmails(email as never, { name: "M", recipients: ["a@example.test", "b@example.test"] }, plan, {});
    expect(email.send).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, failed: 2, suppressed: 0 });
  });
});
