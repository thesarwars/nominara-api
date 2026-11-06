import { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import { RequireStorage } from "../../api/decorators/require-storage.decorator.js";
import { DegradedError } from "../../api/errors/domain-errors.js";
import { unconfiguredStoragePort } from "../../lib/storage/unconfigured-port.js";
import { TenantObjectStore } from "../../lib/storage/tenant-object-store.js";
import { StorageReadyGuard } from "./storage-ready.guard.js";

// STORY-180 r5 (owner decision 60, "move the readiness probe out") - storage readiness is decided by a guard, BEFORE the request
// transaction opens, so credential resolution never happens while a pooled connection is held (ADR-0003).

class Marked {
  @RequireStorage()
  handler(): void {}
  plain(): void {}
}
const contextFor = (name: "handler" | "plain") => ({ getHandler: () => Marked.prototype[name], getClass: () => Marked }) as never;
const guardFor = (store: TenantObjectStore) => new StorageReadyGuard(new Reflector(), store);

describe("STORY-180 r5 · StorageReadyGuard", () => {
  it("passes when the store can presign, with no tenant context in scope", async () => {
    const presignGet = vi.fn(async () => "https://s3.example.test/x");
    const guard = guardFor(new TenantObjectStore({ presignGet } as never, "unit"));
    await expect(guard.canActivate(contextFor("handler"))).resolves.toBe(true);
    expect(presignGet).toHaveBeenCalledWith("reports", expect.any(String), 1);
  });

  it("answers 503 degraded when storage is not configured", async () => {
    const guard = guardFor(new TenantObjectStore(unconfiguredStoragePort(), "unit"));
    await expect(guard.canActivate(contextFor("handler"))).rejects.toBeInstanceOf(DegradedError);
  });

  it("STORY-180 r6 · a route that did not declare @RequireStorage() is not probed (the guard is global, so it must be a no-op elsewhere)", async () => {
    const presignGet = vi.fn(async () => "https://s3.example.test/x");
    const guard = guardFor(new TenantObjectStore({ presignGet } as never, "unit"));
    await expect(guard.canActivate(contextFor("plain"))).resolves.toBe(true);
    expect(presignGet).not.toHaveBeenCalled();
  });

  it("probes a fixed key of no workspace: it names no tenant object", async () => {
    const presignGet = vi.fn(async () => "https://s3.example.test/x");
    await new TenantObjectStore({ presignGet } as never, "unit").assertReady();
    const key = (presignGet.mock.calls[0] as unknown as [string, string, number])[1];
    expect(key).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});
