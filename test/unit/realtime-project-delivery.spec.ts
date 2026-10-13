import { afterEach, describe, expect, it, vi } from "vitest";
import { REALTIME_EVENT_PAYLOADS } from "../../contracts/events/catalog.schema.js";
import type { RealtimeEventName } from "../../contracts/events/event-name.schema.js";
import { RealtimeGateway } from "../../src/gateway/realtime.gateway.js";
import { projectRoom } from "../../src/gateway/room-authorization.service.js";
import {
  NoopRealtimePublisher,
  ValkeyRealtimePublisher,
  realtimeFanoutChannel,
  workspaceRoomName,
} from "../../src/lib/cache/realtime-publisher.js";
import { cacheKeyNamespace } from "../../src/lib/cache/key-namespace.js";
import { applyFakeApiEnv } from "../support/fake-env.js";
import { DEAD_VALKEY_URL } from "../support/test-valkey.js";

// STORY-026 AC1 — project-scoped DELIVERY.
//
// `join:project` has always enforced `workspace_members.project_scope`, but
// delivery consulted the workspace room alone, so a manager scoped to project A
// was refused B's room and still received B's events through the workspace
// room. A project-bearing event is now delivered ONLY to a socket that holds
// BOTH the workspace room (the tenant boundary) and that project's room (the
// scope boundary, which `join:project` and the 60 s re-check police).
//
// Driven with stub sockets so the assertion is on exactly what the gateway
// emits to whom — the integration spec drives the same property over real
// sockets and a real Valkey.

const WS_A = "0192f1a0-0000-7000-8000-00000000000a";
const WS_B = "0192f1a0-0000-7000-8000-00000000000b";
const PROJECT_1 = "0192f1a0-0000-7000-8000-0000000000a1";
const PROJECT_2 = "0192f1a0-0000-7000-8000-0000000000a2";
const TASK = "0192f1a0-0000-7000-8000-0000000000c1";

interface StubSocket {
  id: string;
  rooms: Set<string>;
  emit: ReturnType<typeof vi.fn>;
}

function socketIn(id: string, ...rooms: string[]): StubSocket {
  return { id, rooms: new Set(rooms), emit: vi.fn() };
}

function gatewayWith(...sockets: StubSocket[]): RealtimeGateway {
  const gateway = new RealtimeGateway({} as never, 0);
  (gateway as unknown as { server: unknown }).server = { sockets: new Map(sockets.map((s) => [s.id, s])) };
  return gateway;
}

const wsRoom = workspaceRoomName;
const taskCreated = (projectId: string) => ({ task_id: TASK, project_id: projectId });
const envelope = (workspaceId: string, event: string, payload: unknown, projectId?: string): string =>
  JSON.stringify({ workspaceId, event, payload, ...(projectId === undefined ? {} : { projectId }) });

const received = (socket: StubSocket, event: string): unknown[] =>
  socket.emit.mock.calls.filter((call) => call[0] === event).map((call) => call[1]);

describe("STORY-026 AC1 · a project-bearing event reaches only sockets holding that project's room", () => {
  it("delivers to a socket that holds the workspace room AND the project room", () => {
    const member = socketIn("s1", wsRoom(WS_A), projectRoom(PROJECT_1));
    gatewayWith(member).deliverFanout(envelope(WS_A, "task.created", taskCreated(PROJECT_1), PROJECT_1));
    expect(received(member, "task.created")).toEqual([taskCreated(PROJECT_1)]);
  });

  it("does NOT deliver to a workspace-room socket that never joined the project (a scoped manager)", () => {
    const scoped = socketIn("scoped", wsRoom(WS_A), projectRoom(PROJECT_2));
    const other = socketIn("other", wsRoom(WS_A), projectRoom(PROJECT_1));
    gatewayWith(scoped, other).deliverFanout(envelope(WS_A, "task.created", taskCreated(PROJECT_1), PROJECT_1));

    expect(received(scoped, "task.created"), "out-of-scope project").toEqual([]);
    expect(received(other, "task.created"), "the in-scope recipient must still receive").toHaveLength(1);
  });

  it("does NOT deliver to a socket holding only the workspace room", () => {
    const wsOnly = socketIn("ws-only", wsRoom(WS_A));
    gatewayWith(wsOnly).deliverFanout(envelope(WS_A, "task.created", taskCreated(PROJECT_1), PROJECT_1));
    expect(received(wsOnly, "task.created")).toEqual([]);
  });

  it("applies when a producer used toWorkspace: the project is read from the payload, with no envelope projectId", () => {
    // A producer that forgot toProject must not leak. The gateway decides from
    // the payload, which the catalog schema has already validated.
    const wsOnly = socketIn("ws-only", wsRoom(WS_A));
    const member = socketIn("member", wsRoom(WS_A), projectRoom(PROJECT_1));
    gatewayWith(wsOnly, member).deliverFanout(envelope(WS_A, "task.created", taskCreated(PROJECT_1)));
    expect(received(wsOnly, "task.created")).toEqual([]);
    expect(received(member, "task.created")).toHaveLength(1);
  });

  it("never delivers across workspaces, even to a socket holding the project's room", () => {
    // A socket in workspace B that somehow holds project 1's room still must
    // not receive workspace A's event: the workspace room is the tenant boundary.
    const crossTenant = socketIn("cross", wsRoom(WS_B), projectRoom(PROJECT_1));
    const projectRoomOnly = socketIn("room-only", projectRoom(PROJECT_1));
    gatewayWith(crossTenant, projectRoomOnly).deliverFanout(
      envelope(WS_A, "task.created", taskCreated(PROJECT_1), PROJECT_1),
    );
    expect(received(crossTenant, "task.created")).toEqual([]);
    expect(received(projectRoomOnly, "task.created")).toEqual([]);
  });

  it("matches the project room on the canonical (lowercase) id", () => {
    const member = socketIn("s1", wsRoom(WS_A), projectRoom(PROJECT_1));
    const upper = taskCreated(PROJECT_1.toUpperCase());
    gatewayWith(member).deliverFanout(envelope(WS_A, "task.created", upper));
    expect(received(member, "task.created"), "an uppercase id must not fall into a room nobody joined").toHaveLength(1);
  });

  it("drops an event whose envelope projectId disagrees with its payload", () => {
    const one = socketIn("one", wsRoom(WS_A), projectRoom(PROJECT_1));
    const two = socketIn("two", wsRoom(WS_A), projectRoom(PROJECT_2));
    gatewayWith(one, two).deliverFanout(envelope(WS_A, "task.created", taskCreated(PROJECT_1), PROJECT_2));
    expect(received(one, "task.created")).toEqual([]);
    expect(received(two, "task.created")).toEqual([]);
  });

  it("drops an event published for a project whose payload names none", () => {
    const wsOnly = socketIn("ws-only", wsRoom(WS_A));
    gatewayWith(wsOnly).deliverFanout(
      envelope(
        WS_A,
        "credits.threshold",
        {
          available: 1,
          included_balance: 1,
          purchased_balance: 0,
          pct_remaining: 5,
          cycle_end: "2026-11-01T00:00:00.000Z",
          packs: [],
        },
        PROJECT_1,
      ),
    );
    expect(received(wsOnly, "credits.threshold")).toEqual([]);
  });
});

describe("STORY-026 AC1 · workspace-level events are unchanged", () => {
  const threshold = {
    available: 1,
    included_balance: 1,
    purchased_balance: 0,
    pct_remaining: 5,
    cycle_end: "2026-11-01T00:00:00.000Z",
    packs: [],
  };

  it("an event with no project reaches every workspace-room socket, project rooms or not", () => {
    const scoped = socketIn("scoped", wsRoom(WS_A), projectRoom(PROJECT_2));
    const wsOnly = socketIn("ws-only", wsRoom(WS_A));
    gatewayWith(scoped, wsOnly).deliverFanout(envelope(WS_A, "credits.threshold", threshold));
    expect(received(scoped, "credits.threshold")).toHaveLength(1);
    expect(received(wsOnly, "credits.threshold")).toHaveLength(1);
  });

  it("an account-level debit (project_id null) is workspace-level, not a project event", () => {
    const wsOnly = socketIn("ws-only", wsRoom(WS_A));
    const debit = {
      action_code: "x",
      credits: 1,
      available_after: 9,
      reference_type: "t",
      reference_id: "r",
      project_id: null,
    };
    gatewayWith(wsOnly).deliverFanout(envelope(WS_A, "credits.debited", debit));
    expect(received(wsOnly, "credits.debited")).toHaveLength(1);
  });

  it("a debit that names a project IS a project event", () => {
    const wsOnly = socketIn("ws-only", wsRoom(WS_A));
    const debit = {
      action_code: "x",
      credits: 1,
      available_after: 9,
      reference_type: "t",
      reference_id: "r",
      project_id: PROJECT_1,
    };
    gatewayWith(wsOnly).deliverFanout(envelope(WS_A, "credits.debited", debit));
    expect(received(wsOnly, "credits.debited")).toEqual([]);
  });
});

describe("STORY-026 AC1 · the budgets are spent only on events a socket may see", () => {
  it("a filtered rate-limited event spends no budget and sends no resync to the out-of-scope socket", () => {
    const scoped = socketIn("scoped", wsRoom(WS_A), projectRoom(PROJECT_2));
    const gateway = gatewayWith(scoped);
    // Twenty creations in project 1 (the budget is 5/s): were the filter after
    // the budget, the out-of-scope socket would be told to resync PROJECT_1.
    for (let i = 0; i < 20; i += 1) {
      gateway.deliverFanout(envelope(WS_A, "task.created", { task_id: TASK, project_id: PROJECT_1 }, PROJECT_1));
    }
    expect(scoped.emit).not.toHaveBeenCalled();
  });
});

describe("STORY-026 AC1 · the publisher's toProject path", () => {
  it("NoopRealtimePublisher records a toProject publication with its project", () => {
    const publisher = new NoopRealtimePublisher();
    publisher.toProject(WS_A, PROJECT_1, "task.created", taskCreated(PROJECT_1));
    expect(publisher.published).toEqual([
      expect.objectContaining({ workspaceId: WS_A, event: "task.created", projectId: PROJECT_1 }),
    ]);
  });

  it("ValkeyRealtimePublisher puts projectId on the fan-out envelope", () => {
    applyFakeApiEnv();
    const publisher = new ValkeyRealtimePublisher(DEAD_VALKEY_URL);
    const sent: { channel: string; message: string }[] = [];
    (publisher as unknown as { client: { publish: unknown } }).client.publish = (
      channel: string,
      message: string,
    ): Promise<number> => {
      sent.push({ channel, message });
      return Promise.resolve(1);
    };
    publisher.toProject(WS_A, PROJECT_1, "task.created", taskCreated(PROJECT_1));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.channel).toBe(realtimeFanoutChannel(cacheKeyNamespace()));
    expect(JSON.parse(sent[0]!.message)).toEqual({
      workspaceId: WS_A,
      projectId: PROJECT_1,
      event: "task.created",
      payload: taskCreated(PROJECT_1),
    });
  });

  it("refuses to publish a toProject whose payload names a different project", () => {
    const publisher = new NoopRealtimePublisher();
    expect(() => {
      publisher.toProject(WS_A, PROJECT_1, "task.created", taskCreated(PROJECT_2));
    }).toThrow(/projectId does not match/);
  });
});

// REVIEW (MAJOR) — the filter must apply on EVERY delivery branch, the
// coalesced (replace_latest) one included. A filter skipped for one event name
// or one branch passed the whole suite, because the earlier cases published
// only task.* and credits.* and every coalescing socket held the project room.
//
// The event list is DERIVED from the catalog, so an event added later with a
// top-level `project_id` is covered — or fails for lack of a fixture — rather
// than silently escaping.
const RUN = "0192f1a0-0000-7000-8000-0000000000d1";
const FIXTURES = (projectId: string): Record<string, (n: number) => Record<string, unknown>> => ({
  "run.progress": (n) => ({ run_id: RUN, project_id: projectId, planned: 10, captured: n, skipped: 0, failed: 0, pct: n, eta_ms: null }),
  "run.completed": () => ({ run_id: RUN, project_id: projectId, status: "completed", captured: 1, failed: 0, duration_ms: 5, visibility_delta: null }),
  "run.failed": () => ({ run_id: RUN, project_id: projectId, error_code: "x", failed_engines: [] }),
  "aux.audit_completed": () => ({ audit_id: RUN, project_id: projectId, aux_score: 50, delta: null, findings: { critical: 0, high: 0, medium: 0, low: 0 } }),
  "aux.finding_created": () => ({ finding_id: RUN, project_id: projectId, rule_code: "R", severity: "high", url: "https://example.test/a" }),
  "task.created": () => ({ task_id: TASK, project_id: projectId }),
  "task.moved": () => ({ task_id: TASK, project_id: projectId }),
  "displacement.detected": () => ({ event_id: RUN, project_id: projectId, prompt_id: RUN, engine_key: "e", kind: "k", impact_score: 1 }),
  // Gateway-originated, but a published one would be delivered like any other.
  resync: () => ({ reason: "rate_limited", scope: "project", project_id: projectId }),
  "credits.debited": () => ({ action_code: "x", credits: 1, available_after: 9, reference_type: "t", reference_id: "r", project_id: projectId }),
});

const PROJECT_EVENTS = (Object.keys(REALTIME_EVENT_PAYLOADS) as RealtimeEventName[]).filter((name) => {
  const schema = REALTIME_EVENT_PAYLOADS[name] as unknown as { shape?: Record<string, unknown> };
  return schema.shape !== undefined && "project_id" in schema.shape;
});

describe("STORY-026 AC1 · EVERY project-bearing catalog event is filtered, on every delivery branch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the derived list is non-empty and includes the events the review named", () => {
    expect(PROJECT_EVENTS.length).toBeGreaterThan(0);
    for (const name of ["run.progress", "run.completed", "run.failed", "aux.audit_completed", "aux.finding_created", "displacement.detected"]) {
      expect(PROJECT_EVENTS, name).toContain(name);
    }
  });

  it.each(PROJECT_EVENTS)("%s: has a fixture that satisfies its catalogued schema", (name) => {
    const make = FIXTURES(PROJECT_1)[name];
    expect(make, `add a fixture for ${name}`).toBeDefined();
    expect(REALTIME_EVENT_PAYLOADS[name].safeParse(make!(1)).success).toBe(true);
  });

  it.each(PROJECT_EVENTS)("%s: a ws-only socket receives nothing, a project-room socket receives it (after the coalescing window)", (name) => {
    vi.useFakeTimers();
    const make = FIXTURES(PROJECT_1)[name]!;
    const wsOnly = socketIn("ws-only", wsRoom(WS_A));
    const member = socketIn("member", wsRoom(WS_A), projectRoom(PROJECT_1));
    const gateway = gatewayWith(wsOnly, member);

    // Twice: the second submission of a replace_latest event is the one that is
    // DEFERRED to the window's end, which is the branch under test.
    gateway.deliverFanout(envelope(WS_A, name, make(1)));
    gateway.deliverFanout(envelope(WS_A, name, make(2)));
    vi.advanceTimersByTime(2_000);

    expect(received(wsOnly, name), `${name} must not reach a socket without the project room`).toEqual([]);
    expect(received(member, name).length, `${name} must reach the socket that holds it`).toBeGreaterThan(0);
  });
});

describe("STORY-026 AC1 · event schemas name their project only as project_id", () => {
  it("any other top-level key mentioning a project is a count, not an identifier the gateway would miss", () => {
    for (const name of Object.keys(REALTIME_EVENT_PAYLOADS) as RealtimeEventName[]) {
      const shape = (REALTIME_EVENT_PAYLOADS[name] as unknown as { shape?: Record<string, { def?: { type?: string } }> }).shape ?? {};
      for (const [key, value] of Object.entries(shape)) {
        if (!/project/i.test(key) || key === "project_id") continue;
        expect(value.def?.type, `${name}.${key}`).toBe("number");
      }
    }
  });
});
