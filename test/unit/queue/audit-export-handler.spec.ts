import { UnrecoverableError, type Job } from "bullmq";
import type { ClientBase } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/config/env.schema.js";
import { createAuditExportHandler, selectAuditExportSink } from "../../../src/lib/queue/handlers/audit-export.handler.js";
import { QUEUE_HANDLERS } from "../../../src/lib/queue/handlers.js";
import { S3ObjectLockExportSink } from "../../../src/modules/audit/adapters/s3-object-lock-export-sink.js";
import { LocalDirExportSink } from "../../../src/modules/audit/adapters/local-dir-export-sink.js";
import type { AuditExportSink } from "../../../src/modules/audit/ports/export-sink.js";

// STORY-020 AC8 - the `audit.export` job: nightly, through the export sink port, single-flight, and loud when it cannot run.

const env = (over: Record<string, unknown> = {}): Env => ({ DATABASE_URL: "postgres://x/y", NODE_ENV: "development", ...over }) as unknown as Env;

function fakeClient(lockHeld = true): { client: ClientBase & { end(): Promise<void> }; queries: string[]; ended: () => boolean } {
  const queries: string[] = [];
  let ended = false;
  const client = {
    query: (text: string) => {
      queries.push(text);
      if (text.includes("pg_try_advisory_lock")) return Promise.resolve({ rows: [{ locked: lockHeld }] });
      if (text.includes("pg_advisory_unlock")) return Promise.resolve({ rows: [{ released: true }] });
      return Promise.resolve({ rows: [] });
    },
    end: () => {
      ended = true;
      return Promise.resolve();
    },
  } as unknown as ClientBase & { end(): Promise<void> };
  return { client, queries, ended: () => ended };
}

const sink: AuditExportSink = { export: () => Promise.resolve("s3://b/k") };
const job = {} as Job;

describe("STORY-020 AC8 - audit.export handler", () => {
  it("is registered in the queue handler registry", () => {
    expect(QUEUE_HANDLERS["audit.export"]).toBeTypeOf("function");
  });

  it("scenario 9 - runs the export through the sink with the 7-year retention, then releases the lock and ends the connection", async () => {
    const f = fakeClient();
    const runExport = vi.fn().mockResolvedValue("s3://b/k");
    const handler = createAuditExportHandler({ env: env() } as never, { connect: () => Promise.resolve(f.client), sinkFor: () => sink, runExport });
    await handler(undefined as never, job);
    expect(runExport).toHaveBeenCalledWith(f.client, sink);
    expect(f.queries.some((q) => q.includes("pg_advisory_unlock"))).toBe(true);
    expect(f.ended()).toBe(true);
  });

  it("yields without exporting when another replica holds the lock (single flight)", async () => {
    const f = fakeClient(false);
    const runExport = vi.fn();
    const handler = createAuditExportHandler({ env: env() } as never, { connect: () => Promise.resolve(f.client), sinkFor: () => sink, runExport });
    await handler(undefined as never, job);
    expect(runExport).not.toHaveBeenCalled();
    expect(f.ended()).toBe(true);
  });

  it("a failing export fails the job (never reported as written) and still releases the connection", async () => {
    const f = fakeClient();
    const handler = createAuditExportHandler({ env: env() } as never, { connect: () => Promise.resolve(f.client), sinkFor: () => sink, runExport: () => Promise.reject(new Error("s3 down")) });
    await expect(handler(undefined as never, job)).rejects.toThrow("s3 down");
    expect(f.ended()).toBe(true);
  });

  it("no sink configured: production fails closed (unrecoverable, no connection opened)", async () => {
    const connect = vi.fn();
    const handler = createAuditExportHandler({ env: env({ NODE_ENV: "production" }) } as never, { connect, sinkFor: () => null, runExport: vi.fn() });
    await expect(handler(undefined as never, job)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(connect).not.toHaveBeenCalled();
  });

  it("no sink configured outside production: a counted, logged skip rather than a nightly dead-letter entry", async () => {
    const connect = vi.fn();
    const runExport = vi.fn();
    const handler = createAuditExportHandler({ env: env() } as never, { connect, sinkFor: () => null, runExport });
    await expect(handler(undefined as never, job)).resolves.toBeUndefined();
    expect(connect).not.toHaveBeenCalled();
    expect(runExport).not.toHaveBeenCalled();
  });
});

describe("STORY-020 AC8 - selectAuditExportSink", () => {
  it("AUDIT_EXPORT_BUCKET selects the Object Lock S3 sink", () => {
    expect(selectAuditExportSink(env({ AUDIT_EXPORT_BUCKET: "audit-locked", STORAGE_REGION: "eu-west-1" }), {})).toBeInstanceOf(S3ObjectLockExportSink);
  });
  it("only AUDIT_EXPORT_DIR selects the local-directory sink", () => {
    expect(selectAuditExportSink(env(), { AUDIT_EXPORT_DIR: "/tmp/x" })).toBeInstanceOf(LocalDirExportSink);
  });
  it("the bucket wins over the directory, and neither selects nothing", () => {
    expect(selectAuditExportSink(env({ AUDIT_EXPORT_BUCKET: "b" }), { AUDIT_EXPORT_DIR: "/tmp/x" })).toBeInstanceOf(S3ObjectLockExportSink);
    expect(selectAuditExportSink(env(), {})).toBeNull();
  });
});
