import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { describe, expect, it } from "vitest";
import { JobSignatureError } from "../../../src/tenancy/errors.js";
import { signQueueJobPayload } from "../../../src/lib/queue/envelope.js";
import type { RotatingSigningKeys } from "../../../src/lib/queue/signing.js";
import { QUEUE_TOPOLOGY } from "../../../src/lib/queue/topology.js";
import { createJobProcessor, PHASES_DONE, phasedProcessor, phasesOf, type JobPhases } from "../../../src/lib/queue/worker-factory.js";

// ADR-0003 / KAD-06 — a PHASED tenant job: `prepare` in one short tenant transaction, `run` with NO transaction and NO pooled
// connection checked out (this is where the network is), `commit` in a second short tenant transaction. These tests pin the
// ordering and the ownership of the connection, which is what makes "no transaction across a fetch" a property of the factory
// rather than of one handler's good behaviour.

const ENTRY = QUEUE_TOPOLOGY.find((e) => e.name === "crawl.audit")!;
const KEYS: RotatingSigningKeys = { current: { kid: "phased-kid", key: Buffer.alloc(32, 5) } };
const WS = "018bcfe5-0000-7000-8000-00000000000f";

function signedJob(over: Record<string, unknown> = {}): Job {
  return { data: signQueueJobPayload({ workspaceId: WS, kid: KEYS.current.kid, ...over }, KEYS.current.key) } as unknown as Job;
}

/** Records every statement and every acquire/release, so a test can say what was open when. */
function harness() {
  const events: string[] = [];
  let checkedOut = 0;
  let nextId = 0;
  const makeClient = (id: number): ClientBase =>
    ({
      query: async (sql: string) => {
        const first = String(sql).trim().split(/\s+/)[0]!.toUpperCase();
        events.push(first === "SELECT" && String(sql).includes("set_config") ? "set_config" : first);
        return { rows: [], rowCount: 0 };
      },
      id,
    }) as unknown as ClientBase;
  return {
    events,
    get checkedOut() {
      return checkedOut;
    },
    getClient: () => {
      checkedOut += 1;
      const id = (nextId += 1);
      events.push(`acquire#${String(id)}`);
      return makeClient(id);
    },
    releaseClient: (client: ClientBase) => {
      checkedOut -= 1;
      events.push(`release#${String((client as unknown as { id: number }).id)}`);
    },
  };
}

describe("ADR-0003 · createJobProcessor with a PHASED processor", () => {
  it("prepare and commit each get their own short transaction on their own client, and run holds no connection at all", async () => {
    const h = harness();
    const seen: string[] = [];
    const phases: JobPhases<{ n: number }, string> = {
      prepare: async () => {
        seen.push(`prepare(checkedOut=${String(h.checkedOut)})`);
        return { n: 1 };
      },
      run: async (prepared) => {
        seen.push(`run(checkedOut=${String(h.checkedOut)},n=${String(prepared.n)})`);
        return "fetched";
      },
      commit: async (_tx, prepared, fetched) => {
        seen.push(`commit(checkedOut=${String(h.checkedOut)},${fetched},n=${String(prepared.n)})`);
      },
    };
    const processor = createJobProcessor(ENTRY, { keys: KEYS, getClient: h.getClient, releaseClient: h.releaseClient, process: phasedProcessor(phases) });
    await processor(signedJob());

    expect(seen).toEqual(["prepare(checkedOut=1)", "run(checkedOut=0,n=1)", "commit(checkedOut=1,fetched,n=1)"]);
    expect(h.checkedOut).toBe(0);
    // two separate transactions, in order, with the release of the first BEFORE run and the acquire of the second AFTER it
    const begins = h.events.filter((e) => e === "BEGIN").length;
    const commits = h.events.filter((e) => e === "COMMIT").length;
    expect([begins, commits]).toEqual([2, 2]);
    expect(h.events.indexOf("COMMIT")).toBeLessThan(h.events.indexOf("release#1"));
    expect(h.events.indexOf("release#1")).toBeLessThan(h.events.indexOf("acquire#2"));
  });

  it("sets the tenant context in BOTH transactions, from the verified payload, with set_config (is_local) and never before verification", async () => {
    const h = harness();
    const processor = createJobProcessor(ENTRY, {
      keys: KEYS,
      getClient: h.getClient,
      releaseClient: h.releaseClient,
      process: phasedProcessor({ prepare: async () => ({}), run: async () => ({}), commit: async () => undefined }),
    });
    await processor(signedJob());
    expect(h.events.filter((e) => e === "set_config").length).toBeGreaterThanOrEqual(2);
    // every BEGIN is followed by a set_config before anything else touches the connection
    h.events.forEach((e, i) => {
      if (e === "BEGIN") expect(h.events[i + 1]).toBe("set_config");
    });
  });

  it("a tampered job is rejected BEFORE any client is acquired, for a phased processor too (ISO-11 ordering)", async () => {
    const h = harness();
    const processor = createJobProcessor(ENTRY, {
      keys: KEYS,
      getClient: h.getClient,
      releaseClient: h.releaseClient,
      process: phasedProcessor({ prepare: async () => ({}), run: async () => ({}), commit: async () => undefined }),
    });
    const good = signedJob();
    const tampered = { data: { payload: { ...(good.data as { payload: object }).payload, workspaceId: "018bcfe5-0000-7000-8000-0000000000ff" }, signature: (good.data as { signature: string }).signature } } as unknown as Job;
    await expect(processor(tampered)).rejects.toThrow(JobSignatureError);
    expect(h.events).toEqual([]);
  });

  it("prepare may end the job: nothing is run and no second transaction is opened", async () => {
    const h = harness();
    let ran = false;
    const processor = createJobProcessor(ENTRY, {
      keys: KEYS,
      getClient: h.getClient,
      releaseClient: h.releaseClient,
      process: phasedProcessor<object, object>({
        prepare: async () => PHASES_DONE,
        run: async () => {
          ran = true;
          return {};
        },
        commit: async () => {
          ran = true;
        },
      }),
    });
    await processor(signedJob());
    expect(ran).toBe(false);
    expect(h.events.filter((e) => e === "BEGIN")).toHaveLength(1);
    expect(h.checkedOut).toBe(0);
  });

  it("a run that throws leaves nothing checked out and nothing committed, and the error reaches the queue (so BullMQ retries)", async () => {
    const h = harness();
    let committed = false;
    const processor = createJobProcessor(ENTRY, {
      keys: KEYS,
      getClient: h.getClient,
      releaseClient: h.releaseClient,
      process: phasedProcessor({
        prepare: async () => ({}),
        run: async () => {
          throw new Error("target hung");
        },
        commit: async () => {
          committed = true;
        },
      }),
    });
    await expect(processor(signedJob())).rejects.toThrow("target hung");
    expect(committed).toBe(false);
    expect(h.checkedOut).toBe(0);
    expect(h.events.filter((e) => e === "BEGIN")).toHaveLength(1);
  });

  it("a commit that throws rolls back its own transaction, releases its client with the failure, and rethrows", async () => {
    const h = harness();
    const failures: unknown[] = [];
    const processor = createJobProcessor(ENTRY, {
      keys: KEYS,
      getClient: h.getClient,
      releaseClient: (client, failure) => {
        failures.push(failure);
        h.releaseClient(client);
      },
      process: phasedProcessor({
        prepare: async () => ({}),
        run: async () => ({}),
        commit: async () => {
          throw new Error("write failed");
        },
      }),
    });
    await expect(processor(signedJob())).rejects.toThrow("write failed");
    expect(h.events).toContain("ROLLBACK");
    expect(h.checkedOut).toBe(0);
    expect(failures.map((f) => (f instanceof Error ? f.message : f))).toEqual([undefined, "write failed"]);
  });

  it("a prepare that throws rolls back and releases, and run is never reached", async () => {
    const h = harness();
    let ran = false;
    const processor = createJobProcessor(ENTRY, {
      keys: KEYS,
      getClient: h.getClient,
      releaseClient: h.releaseClient,
      process: phasedProcessor({
        prepare: async () => {
          throw new Error("no such project row");
        },
        run: async () => {
          ran = true;
          return {};
        },
        commit: async () => undefined,
      }),
    });
    await expect(processor(signedJob())).rejects.toThrow("no such project row");
    expect(ran).toBe(false);
    expect(h.events).toContain("ROLLBACK");
    expect(h.checkedOut).toBe(0);
  });

  it("a phased processor called as a plain function composes the three phases on the ONE client it is given (tests and tools; production goes through createJobProcessor)", async () => {
    const order: string[] = [];
    const processor = phasedProcessor({
      prepare: async () => {
        order.push("prepare");
        return { a: 1 };
      },
      run: async () => {
        order.push("run");
        return "r";
      },
      commit: async (_tx, prepared, fetched) => {
        order.push(`commit:${String(prepared.a)}:${fetched}`);
      },
    });
    await processor({} as ClientBase, {} as Job);
    expect(order).toEqual(["prepare", "run", "commit:1:r"]);
    expect(phasesOf(processor)).toBeDefined();
    expect(phasesOf(async () => undefined)).toBeUndefined();
  });

  it("a phased processor on a NON-tenant queue is refused: there is no tenant transaction to split", () => {
    const global = QUEUE_TOPOLOGY.find((e) => e.name === "credit.reconcile")!;
    expect(global.tenantScoped).toBe(false);
    expect(() =>
      createJobProcessor(global, {
        keys: KEYS,
        getClient: () => ({}) as ClientBase,
        process: phasedProcessor({ prepare: async () => ({}), run: async () => ({}), commit: async () => undefined }),
      }),
    ).toThrow(/tenant/i);
  });
});
