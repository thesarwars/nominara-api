import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { S3Adapter } from "../../src/lib/storage/s3.adapter.js";
import { resolveStorageConfig } from "../../src/lib/storage/storage-config.js";
import { hashReportLinkToken, reportLinkToken } from "../../src/lib/reports/report-artifact-mail.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startLocalstack, type LocalstackFixture } from "../support/localstack-fixture.js";
import { fetchStored, REPORT_STORAGE_KEY_ENV, reportStorageEnv } from "../support/report-storage-env.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-180 AC2 / AC3 / AC6 - the emailed 7-day link, GET /v1/report-links/{workspaceId}/{token}, through the REAL ApiModule against
// LocalStack: a stored, revocable token, then a 302 to a fresh 15-minute presign of the stored key. No cookie anywhere: the route is public.

describe("STORY-180 · the emailed report link over HTTP", () => {
  let cacheValkey: StartedValkey;
  let queueValkey: ValkeyFixture;
  let localstack: LocalstackFixture;
  let s3: S3Adapter;
  const harness = useApiHarness({
    // The real nominara_app role (NOBYPASSRLS): a cross-workspace assertion through the superuser would pass for the wrong reason.
    runAsAppRole: true,
    env: () => ({ VALKEY_CACHE_URL: cacheValkey.url, QUEUE_REDIS_URL: queueValkey.connectionString, ...reportStorageEnv(localstack.endpoint) }),
  });

  beforeAll(async () => {
    [cacheValkey, queueValkey, localstack] = await Promise.all([startValkey(), startValkeyFixture(), startLocalstack()]);
    const config = resolveStorageConfig({ NODE_ENV: "test", ...reportStorageEnv(localstack.endpoint) } as never);
    if (config === null) throw new Error("storage config unexpectedly null");
    s3 = new S3Adapter(config);
  }, 240_000);
  afterAll(async () => {
    await Promise.all([cacheValkey.stop(), queueValkey.stop(), localstack.stop()]);
  });

  async function workspace(): Promise<string> {
    const r = await harness.db().query("INSERT INTO workspaces (name, slug, plan_key) VALUES ('W', $1, 'free') RETURNING id", [`w-${randomUUID().slice(0, 12)}`]);
    return (r.rows[0] as { id: string }).id;
  }

  interface Artifact {
    readonly id: string;
    readonly token: string;
  }

  /** An artifact row in `workspaceId`, its file in the bucket under `objectWorkspaceId`'s prefix, and a link token hash. */
  async function artifact(workspaceId: string, over: { bytes?: Buffer; objectWorkspaceId?: string; pending?: boolean; expired?: boolean; revoked?: boolean; noLink?: boolean } = {}): Promise<Artifact> {
    const id = randomUUID();
    const bytes = over.bytes ?? Buffer.from("%PDF-1.4 report bytes");
    const key = `${REPORT_STORAGE_KEY_ENV}/${over.objectWorkspaceId ?? workspaceId}/${id}.pdf`;
    await s3.put({ bucket: "reports", key, body: bytes, contentType: "application/pdf" });
    const token = reportLinkToken(Buffer.alloc(32, 9), id);
    await harness.db().query(
      `INSERT INTO report_artifacts (id, workspace_id, project_ids, period_start, period_end, format, object_key, bytes, methodology_footer,
                                     expires_at, link_token_hash, link_revoked_at)
       VALUES ($1,$2,'{}','2026-10-01','2026-10-31','pdf',$3,$4,'{}'::jsonb, $5, $6, $7)`,
      [
        id, workspaceId, over.pending === true ? `pending:${id}` : key, bytes.length,
        over.expired === true ? new Date(Date.now() - 60_000) : new Date(Date.now() + 7 * 86_400_000),
        over.noLink === true ? null : hashReportLinkToken(token),
        over.revoked === true ? new Date() : null,
      ],
    );
    return { id, token };
  }

  const click = (workspaceId: string, token: string) => harness.app().inject({ method: "GET", url: apiUrl(`/report-links/${workspaceId}/${token}`) });
  const refusal = (res: { statusCode: number; json(): unknown }) => {
    const { code, message } = (res.json() as { error: { code: string; message: string } }).error;
    return { status: res.statusCode, code, message }; // request_id differs per request by design
  };

  it("STORY-180 AC3 · a valid token is a 302 to a 15-minute presign of the stored file, with no cookie, uncached", async () => {
    const ws = await workspace();
    const a = await artifact(ws, { bytes: Buffer.from("the quarterly report") });
    const res = await click(ws, a.token);
    expect(res.statusCode, res.body).toBe(302);
    const location = String(res.headers.location);
    expect(location).toContain(`/nominara-reports/${REPORT_STORAGE_KEY_ENV}/${ws}/${a.id}.pdf`);
    expect(new URL(location).searchParams.get("X-Amz-Expires")).toBe("900");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect((await fetchStored(location)).toString()).toBe("the quarterly report");
    const row = (await harness.db().query("SELECT download_count FROM report_artifacts WHERE id = $1", [a.id])).rows[0] as { download_count: number };
    expect(row.download_count).toBe(1);
  }, 120_000);

  it("STORY-180 AC3 · every click re-checks the token: after revocation the NEXT click is a 404 (a presign already issued stays valid for its 15 minutes)", async () => {
    const ws = await workspace();
    const a = await artifact(ws);
    expect((await click(ws, a.token)).statusCode).toBe(302);
    await harness.db().query("UPDATE report_artifacts SET link_revoked_at = now() WHERE id = $1", [a.id]);
    const res = await click(ws, a.token);
    expect(res.statusCode).toBe(404);
    expect(res.headers.location).toBeUndefined();
  }, 120_000);

  it("STORY-180 AC3 · a link past its 7 days, an unknown token, another workspace's id and an artifact with no link are all the SAME 404", async () => {
    const ws = await workspace();
    const other = await workspace();
    const expired = await artifact(ws, { expired: true });
    const valid = await artifact(ws);
    const noLink = await artifact(ws, { noLink: true });
    const refusals = [
      await click(ws, expired.token),
      await click(ws, reportLinkToken(Buffer.alloc(32, 1), randomUUID())),
      await click(other, valid.token),
      await click(ws, noLink.token),
    ].map(refusal);
    for (const r of refusals) expect(r).toEqual(refusals[0]);
    expect(refusals[0]!.status).toBe(404);
  }, 120_000);

  it("STORY-180 AC3 · a workspace that is soft-deleted or pending erasure stops serving its emailed links", async () => {
    const ws = await workspace();
    const a = await artifact(ws);
    expect((await click(ws, a.token)).statusCode).toBe(302);
    await harness.db().query("UPDATE workspaces SET deletion_execute_at = now() + interval '1 day' WHERE id = $1", [ws]);
    expect((await click(ws, a.token)).statusCode).toBe(404);
    await harness.db().query("UPDATE workspaces SET deletion_execute_at = NULL, deleted_at = now() WHERE id = $1", [ws]);
    expect((await click(ws, a.token)).statusCode).toBe(404);
  }, 120_000);

  it("STORY-180 AC3 · a token that is not 43 base64url characters is a 400 before any lookup", async () => {
    const ws = await workspace();
    expect((await click(ws, "short")).statusCode).toBe(400);
    expect((await harness.app().inject({ method: "GET", url: apiUrl(`/report-links/not-a-uuid/${"a".repeat(43)}`) })).statusCode).toBe(400);
  }, 120_000);

  it("STORY-180 AC2 · a stored key that lies in ANOTHER workspace's prefix is refused: the same 404, no redirect, no click counted", async () => {
    const ws = await workspace();
    const other = await workspace();
    const a = await artifact(ws, { objectWorkspaceId: other });
    const res = await click(ws, a.token);
    expect(res.statusCode).toBe(404);
    expect(res.headers.location).toBeUndefined();
    const row = (await harness.db().query("SELECT download_count FROM report_artifacts WHERE id = $1", [a.id])).rows[0] as { download_count: number };
    expect(row.download_count).toBe(0);
  }, 120_000);

  it("STORY-180 AC1 · an artifact whose upload never landed (key still pending) is not linkable", async () => {
    const ws = await workspace();
    const a = await artifact(ws, { pending: true });
    const res = await click(ws, a.token);
    expect(res.statusCode).toBe(404);
    expect(res.headers.location).toBeUndefined();
  }, 120_000);
});
