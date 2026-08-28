import { createHmac } from "node:crypto";
import type { ClientBase } from "pg";
import { describe, expect, it } from "vitest";
import { ACTOR_GUC, SCOPE_GUC, SYSTEM_ACTOR_ID, WORKSPACE_GUC } from "../../src/tenancy/constants.js";
import { JobSignatureError } from "../../src/tenancy/errors.js";
import {
  currentActorStore,
  currentTenantStore,
  withActorContext,
  withTenantContext,
  type ActorOnlyContext,
  type TenantContext,
} from "../../src/tenancy/tenant-context.js";
import { hmacSha256JobVerifier, withTenantJob, type TenantJob } from "../../src/tenancy/with-tenant-job.js";

// STORY-011 · src/tenancy/tenant-context.ts and with-tenant-job.ts. No real
// database anywhere in this file — a recording fake ClientBase stands in for
// the transaction, so every assertion here is about CALL ORDER and BIND
// PARAMETERS, not about Postgres behavior (that's the integration suite's
// job).

interface RecordedQuery {
  text: string;
  params: unknown[] | undefined;
}

function createFakeClient(options: { failOn?: (text: string) => boolean } = {}) {
  const log: RecordedQuery[] = [];
  const fakeClient = {
    query: async (text: string, params?: unknown[]) => {
      log.push({ text, params });
      if (options.failOn?.(text)) {
        throw new Error(`simulated failure for: ${text}`);
      }
      return { rows: [] };
    },
  };
  return { client: fakeClient as unknown as ClientBase, log };
}

describe("STORY-011 · withTenantContext — exact call order and bind parameters", () => {
  it("BEGIN → 3 set_configs → body → COMMIT, in that exact order, with every value bound as a parameter (never in the SQL text)", async () => {
    const { client, log } = createFakeClient();
    const context: TenantContext = { workspaceId: "ws-1", actorId: "actor-1", scopeProjectIds: ["p1", "p2"] };
    const bodyCalls: string[] = [];

    const result = await withTenantContext(client, context, async (tx) => {
      bodyCalls.push("body");
      expect(tx).toBe(client);
      return "ok";
    });

    expect(result).toBe("ok");
    expect(bodyCalls).toEqual(["body"]);
    expect(log.map((q) => q.text)).toEqual([
      "BEGIN",
      "SELECT set_config($1, $2, true)",
      "SELECT set_config($1, $2, true)",
      "SELECT set_config($1, $2, true)",
      "COMMIT",
    ]);
    expect(log[1]!.params).toEqual([WORKSPACE_GUC, "ws-1"]);
    expect(log[2]!.params).toEqual([ACTOR_GUC, "actor-1"]);
    expect(log[3]!.params).toEqual([SCOPE_GUC, "p1,p2"]);

    for (const q of log) {
      expect(q.text).not.toContain("ws-1");
      expect(q.text).not.toContain("actor-1");
      expect(q.text).not.toContain("p1,p2");
    }
  });

  const EXPECTED_WITHOUT_SCOPE = [
    "BEGIN",
    "SELECT set_config($1, $2, true)",
    "SELECT set_config($1, $2, true)",
    "COMMIT",
  ];

  it("omits the scope-projects set_config entirely when scopeProjectIds is not provided at all", async () => {
    const { client, log } = createFakeClient();
    await withTenantContext(client, { workspaceId: "ws", actorId: "actor" }, async () => "x");
    expect(log.map((q) => q.text)).toEqual(EXPECTED_WITHOUT_SCOPE);
  });

  it("omits the scope-projects set_config entirely when scopeProjectIds is an empty array", async () => {
    const { client, log } = createFakeClient();
    await withTenantContext(client, { workspaceId: "ws", actorId: "actor", scopeProjectIds: [] }, async () => "x");
    expect(log.map((q) => q.text)).toEqual(EXPECTED_WITHOUT_SCOPE);
  });

  it("ROLLBACK then rethrows the ORIGINAL error when the body throws", async () => {
    const { client, log } = createFakeClient();
    const boom = new Error("boom");

    await expect(
      withTenantContext(client, { workspaceId: "ws", actorId: "actor" }, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(log.map((q) => q.text)).toEqual([
      "BEGIN",
      "SELECT set_config($1, $2, true)",
      "SELECT set_config($1, $2, true)",
      "ROLLBACK",
    ]);
  });

  it("a ROLLBACK failure is attached as .cause and does NOT mask the original error", async () => {
    const { client } = createFakeClient({ failOn: (text) => text === "ROLLBACK" });
    const original = new Error("original failure");

    await expect(
      withTenantContext(client, { workspaceId: "ws", actorId: "actor" }, async () => {
        throw original;
      }),
    ).rejects.toBe(original);

    expect(original.cause).toBeInstanceOf(Error);
    expect((original.cause as Error).message).toContain("ROLLBACK");
  });

  it("fix pass — a set_config failure (BEFORE the body ever runs) still issues a ROLLBACK, not a leaked open transaction", async () => {
    // BEGIN and the set_config calls used to run OUTSIDE the try block, so a
    // failure here never reached the ROLLBACK path at all — the connection
    // would be handed back sitting in an open, aborted transaction (pinning
    // a server connection under pgBouncer transaction-mode pooling). This
    // fails against that old shape (log would end at the failing
    // set_config, no ROLLBACK ever attempted) and passes now that BEGIN/
    // set_config are inside the try/catch.
    const { client, log } = createFakeClient({ failOn: (text) => text === "SELECT set_config($1, $2, true)" });
    const bodyCalls: string[] = [];

    await expect(
      withTenantContext(client, { workspaceId: "ws", actorId: "actor" }, async () => {
        bodyCalls.push("body");
        return "unreachable";
      }),
    ).rejects.toThrow("simulated failure for: SELECT set_config($1, $2, true)");

    expect(bodyCalls).toEqual([]);
    expect(log.map((q) => q.text)).toEqual(["BEGIN", "SELECT set_config($1, $2, true)", "ROLLBACK"]);
  });

  it("fix pass — a BEGIN failure still attempts a ROLLBACK rather than throwing straight past it", async () => {
    const { client, log } = createFakeClient({ failOn: (text) => text === "BEGIN" });

    await expect(withTenantContext(client, { workspaceId: "ws", actorId: "actor" }, async () => "unreachable")).rejects.toThrow(
      "simulated failure for: BEGIN",
    );

    // ROLLBACK outside any transaction is a harmless no-op in Postgres (a
    // NOTICE, not an error) — issuing it defensively even when BEGIN itself
    // failed is correct, not wasted work.
    expect(log.map((q) => q.text)).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("runs the body inside the AsyncLocalStorage store — currentTenantStore() reflects the active context", async () => {
    const { client } = createFakeClient();
    let observed: TenantContext | undefined;
    await withTenantContext(client, { workspaceId: "ws-2", actorId: "actor-2" }, async () => {
      observed = currentTenantStore()?.context;
    });
    expect(observed).toEqual({ workspaceId: "ws-2", actorId: "actor-2" });
    // Outside the call, no store is active.
    expect(currentTenantStore()).toBeUndefined();
  });
});

describe("STORY-026 · afterCommit — a side effect must not outlive a rolled-back transaction", () => {
  const context: TenantContext = { workspaceId: "ws-1", actorId: "actor-1" };

  // THE DEFECT THIS EXISTS FOR. `member.changed` was published from inside the
  // request's transaction, before COMMIT. It closes the affected sockets and
  // tells every client the membership changed — so a transaction that then
  // failed left sockets closed and clients informed about a change that never
  // happened, and the authoritative API they refetch would contradict it.
  //
  // Not fixable by moving the call after `withTenantContext` returns: the
  // service method does not own the transaction, TenantContextInterceptor
  // does, and a service cannot see the commit from inside it. Hence a seam.
  it("runs registered tasks AFTER the commit, never before", async () => {
    const { client, log } = createFakeClient();
    const order: string[] = [];

    await withTenantContext(client, context, async () => {
      currentTenantStore()!.afterCommit(() => order.push("effect"));
      order.push("body");
    });

    expect(order).toEqual(["body", "effect"]);
    // Belt and braces: the effect must land after the COMMIT statement, not
    // merely after the body — the body returning is not the commit.
    expect(log[log.length - 1]!.text).toBe("COMMIT");
  });

  it("runs NOTHING when the transaction rolls back", async () => {
    const { client } = createFakeClient({ failOn: (text) => text === "COMMIT" });
    const effects: string[] = [];

    await expect(
      withTenantContext(client, context, async () => {
        currentTenantStore()!.afterCommit(() => effects.push("published"));
      }),
    ).rejects.toThrow();

    expect(effects, "a failed commit must leave no client told anything").toEqual([]);
  });

  it("runs nothing when the BODY throws, either", async () => {
    const { client } = createFakeClient();
    const effects: string[] = [];

    await expect(
      withTenantContext(client, context, async () => {
        currentTenantStore()!.afterCommit(() => effects.push("published"));
        throw new Error("handler failed");
      }),
    ).rejects.toThrow("handler failed");

    expect(effects).toEqual([]);
  });

  // The mirror of the bug being fixed: the transaction has ALREADY committed,
  // so a throwing side effect must not turn a successful, durable mutation
  // into a failed request. The caller would retry a change that already
  // happened.
  it("a failing task neither fails the request nor stops the ones after it", async () => {
    const { client } = createFakeClient();
    const effects: string[] = [];

    await expect(
      withTenantContext(client, context, async () => {
        const store = currentTenantStore()!;
        store.afterCommit(() => {
          throw new Error("valkey is down");
        });
        store.afterCommit(() => effects.push("second"));
        return "committed";
      }),
    ).resolves.toBe("committed");

    expect(effects, "one broken effect must not silence the next").toEqual(["second"]);
  });

  it("runs tasks in the order they were registered", async () => {
    const { client } = createFakeClient();
    const order: number[] = [];

    await withTenantContext(client, context, async () => {
      const store = currentTenantStore()!;
      for (const n of [1, 2, 3]) store.afterCommit(() => order.push(n));
    });

    expect(order).toEqual([1, 2, 3]);
  });
});

describe("STORY-021 · withActorContext — ADR-0001 actor-only context, exact call order", () => {
  it("BEGIN → READ ONLY → clear-workspace set_config → actor set_config → body → COMMIT, in that exact order", async () => {
    const { client, log } = createFakeClient();
    const context: ActorOnlyContext = { actorId: "actor-1" };
    const bodyCalls: string[] = [];

    const result = await withActorContext(client, context, async (tx) => {
      bodyCalls.push("body");
      expect(tx).toBe(client);
      return "ok";
    });

    expect(result).toBe("ok");
    expect(bodyCalls).toEqual(["body"]);
    expect(log.map((q) => q.text)).toEqual([
      "BEGIN",
      "SET LOCAL TRANSACTION READ ONLY",
      "SELECT set_config($1, $2, true)",
      "SELECT set_config($1, $2, true)",
      "COMMIT",
    ]);
    expect(log[2]!.params).toEqual([WORKSPACE_GUC, ""]);
    expect(log[3]!.params).toEqual([ACTOR_GUC, "actor-1"]);
  });

  it("the workspace GUC is EXPLICITLY cleared to an empty string, never left unset or non-empty", async () => {
    const { client, log } = createFakeClient();
    await withActorContext(client, { actorId: "actor-1" }, async () => "x");
    const workspaceClearCall = log.find((q) => q.params?.[0] === WORKSPACE_GUC);
    expect(workspaceClearCall?.params).toEqual([WORKSPACE_GUC, ""]);
  });

  it("ROLLBACK then rethrows the ORIGINAL error when the body throws", async () => {
    const { client, log } = createFakeClient();
    const boom = new Error("boom");

    await expect(
      withActorContext(client, { actorId: "actor-1" }, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(log.map((q) => q.text)).toEqual([
      "BEGIN",
      "SET LOCAL TRANSACTION READ ONLY",
      "SELECT set_config($1, $2, true)",
      "SELECT set_config($1, $2, true)",
      "ROLLBACK",
    ]);
  });

  it("a ROLLBACK failure is attached as .cause and does NOT mask the original error", async () => {
    const { client } = createFakeClient({ failOn: (text) => text === "ROLLBACK" });
    const original = new Error("original failure");

    await expect(
      withActorContext(client, { actorId: "actor-1" }, async () => {
        throw original;
      }),
    ).rejects.toBe(original);

    expect(original.cause).toBeInstanceOf(Error);
    expect((original.cause as Error).message).toContain("ROLLBACK");
  });

  it("runs the body inside its OWN AsyncLocalStorage store — currentActorStore() reflects it, currentTenantStore() stays undefined", async () => {
    const { client } = createFakeClient();
    let observedActor: ActorOnlyContext | undefined;
    let observedTenant: TenantContext | undefined;
    await withActorContext(client, { actorId: "actor-2" }, async () => {
      observedActor = currentActorStore()?.context;
      observedTenant = currentTenantStore()?.context;
    });
    expect(observedActor).toEqual({ actorId: "actor-2" });
    expect(observedTenant).toBeUndefined();
    // Outside the call, no store is active.
    expect(currentActorStore()).toBeUndefined();
  });
});

describe("STORY-011 · withTenantJob — signature verification precedes context", () => {
  it("verifies BEFORE any client.query call — a rejecting verifier leaves the query log COMPLETELY EMPTY", async () => {
    const { client, log } = createFakeClient();
    const job: TenantJob = { data: { workspaceId: "ws-1" }, signature: "irrelevant" };
    const rejectingVerifier = () => {
      throw new JobSignatureError("tampered");
    };

    await expect(withTenantJob(client, job, rejectingVerifier, async () => "never")).rejects.toBeInstanceOf(
      JobSignatureError,
    );
    expect(log).toEqual([]);
  });

  it("a passing verifier delegates to withTenantContext with actorId ALWAYS = SYSTEM_ACTOR_ID, never caller-supplied", async () => {
    const { client, log } = createFakeClient();
    const job: TenantJob<{ payload: string }> = {
      data: { workspaceId: "ws-9", payload: "x" },
      signature: "ignored-by-this-verifier",
    };

    let observedContext: TenantContext | undefined;
    await withTenantJob(client, job, () => undefined, async () => {
      observedContext = currentTenantStore()?.context;
      return "ok";
    });

    expect(observedContext).toEqual({ workspaceId: "ws-9", actorId: SYSTEM_ACTOR_ID });
    expect(log.map((q) => q.text)).toEqual([
      "BEGIN",
      "SELECT set_config($1, $2, true)",
      "SELECT set_config($1, $2, true)",
      "COMMIT",
    ]);
  });

  it("hmacSha256JobVerifier accepts a genuinely correctly-signed job", () => {
    const key = Buffer.from("test-signing-key");
    const verify = hmacSha256JobVerifier(key);
    const data = { workspaceId: "ws-1", amount: 42 };
    const signature = signJobData(key, data);
    expect(() => verify({ data, signature })).not.toThrow();
  });

  it("hmacSha256JobVerifier REJECTS a genuinely tampered payload (not just a stub check)", () => {
    const key = Buffer.from("test-signing-key");
    const verify = hmacSha256JobVerifier(key);
    const originalData = { workspaceId: "ws-1", amount: 42 };
    const signature = signJobData(key, originalData);

    // Tamper with the payload after signing — the classic "poisoned queue
    // entry" scenario NFR-SEC-04 guards against.
    const tamperedData = { workspaceId: "ws-EVIL", amount: 42 };
    expect(() => verify({ data: tamperedData, signature })).toThrow(JobSignatureError);
  });

  it("hmacSha256JobVerifier REJECTS a tampered signature against the original payload", () => {
    const key = Buffer.from("test-signing-key");
    const verify = hmacSha256JobVerifier(key);
    const data = { workspaceId: "ws-1", amount: 42 };
    const signature = signJobData(key, data);
    const tamperedSignature = signature.slice(0, -2) + (signature.slice(-2) === "00" ? "ff" : "00");
    expect(() => verify({ data, signature: tamperedSignature })).toThrow(JobSignatureError);
  });

  it("hmacSha256JobVerifier REJECTS a signature signed with the WRONG key", () => {
    const realKey = Buffer.from("real-signing-key");
    const wrongKey = Buffer.from("wrong-signing-key");
    const verify = hmacSha256JobVerifier(realKey);
    const data = { workspaceId: "ws-1", amount: 42 };
    const signature = signJobData(wrongKey, data);
    expect(() => verify({ data, signature })).toThrow(JobSignatureError);
  });

  it("hmacSha256JobVerifier is insensitive to key ORDER in the payload (canonical JSON)", () => {
    const key = Buffer.from("test-signing-key");
    const verify = hmacSha256JobVerifier(key);
    const inOneOrder = { workspaceId: "ws-1", amount: 42, nested: { b: 1, a: 2 } };
    const inAnotherOrder = { amount: 42, nested: { a: 2, b: 1 }, workspaceId: "ws-1" };
    const signature = signJobData(key, inOneOrder);
    expect(() => verify({ data: inAnotherOrder, signature })).not.toThrow();
  });

  it("hmacSha256JobVerifier rejects a malformed (non-hex) signature", () => {
    const key = Buffer.from("test-signing-key");
    const verify = hmacSha256JobVerifier(key);
    expect(() => verify({ data: { workspaceId: "ws-1" }, signature: "not-hex!!" })).toThrow(JobSignatureError);
  });
});

// Test-only helper mirroring hmacSha256JobVerifier's own canonicalization —
// duplicated deliberately (not imported from the implementation) so this
// test doesn't just assert the implementation echoes itself.
function signJobData(key: Buffer, data: unknown): string {
  return createHmac("sha256", key).update(JSON.stringify(sortKeysDeep(data))).digest("hex");
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeysDeep(source[key]);
    }
    return sorted;
  }
  return value;
}
