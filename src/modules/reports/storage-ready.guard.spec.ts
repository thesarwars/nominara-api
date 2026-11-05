import { describe, expect, it, vi } from "vitest";
import { DegradedError } from "../../api/errors/domain-errors.js";
import { unconfiguredStoragePort } from "../../lib/storage/unconfigured-port.js";
import { TenantObjectStore } from "../../lib/storage/tenant-object-store.js";
import { StorageReadyGuard } from "./storage-ready.guard.js";

// STORY-180 r5 (owner decision 60, "move the readiness probe out") - storage readiness is decided by a guard, BEFORE the request
// transaction opens, so credential resolution never happens while a pooled connection is held (ADR-0003).

describe("STORY-180 r5 · StorageReadyGuard", () => {
  it("passes when the store can presign, with no tenant context in scope", async () => {
    const presignGet = vi.fn(async () => "https://s3.example.test/x");
    const guard = new StorageReadyGuard(new TenantObjectStore({ presignGet } as never, "unit"));
    await expect(guard.canActivate()).resolves.toBe(true);
    expect(presignGet).toHaveBeenCalledWith("reports", expect.any(String), 1);
  });

  it("answers 503 degraded when storage is not configured", async () => {
    const guard = new StorageReadyGuard(new TenantObjectStore(unconfiguredStoragePort(), "unit"));
    await expect(guard.canActivate()).rejects.toBeInstanceOf(DegradedError);
  });

  it("probes a fixed key of no workspace: it names no tenant object", async () => {
    const presignGet = vi.fn(async () => "https://s3.example.test/x");
    await new TenantObjectStore({ presignGet } as never, "unit").assertReady();
    const key = (presignGet.mock.calls[0] as unknown as [string, string, number])[1];
    expect(key).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});
