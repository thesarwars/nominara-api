import { describe, expect, it, vi } from "vitest";
import { COMMAND_INTENTS, type CommandIntent } from "../../../contracts/command/command-intent.schema.js";
import { commandExecuteRequestSchema } from "../../../contracts/command/execute-request.schema.js";
import { commandExecuteResponseSchema } from "../../../contracts/command/execute-response.schema.js";
import { entityIndexResponseSchema } from "../../../contracts/command/entity-index.schema.js";
import { API_CONTRACT_KEY } from "../../api/decorators/api-contract.decorator.js";
import { AUDIT_METADATA_KEY, type AuditOptions } from "../../api/decorators/audit.decorator.js";
import { CREDITS_FROM_COMMAND_PARSE, CREDITS_KEY } from "../../api/decorators/credits.decorator.js";
import { IDEMPOTENT_KEY } from "../../api/decorators/idempotent.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "../../api/decorators/require-permission.decorator.js";
import { RATE_LIMIT_CLASS_KEY } from "../../api/rate-limit/route-class.js";
import { ConflictError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { InMemoryCacheAdapter } from "../../lib/cache/in-memory-cache.adapter.js";
import { PARSE_RECORD_TTL_MS } from "../../lib/command/parse-record.js";
import type { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import { PermissionDeniedException, ProjectOutOfScopeException } from "../../tenancy/errors.js";
import type { CommandCaller } from "./command-caller.js";
import { CommandExecuteService } from "./command-execute.service.js";
import { CommandController } from "./command.controller.js";
import { CommandService } from "./command.service.js";
import type { EntityIndexService } from "./entity-index.service.js";

const WS_A = "0197b2c0-0000-7000-8000-00000000000a";
const WS_B = "0197b2c0-0000-7000-8000-00000000000b";
const USER_1 = "0197b2c0-0000-7000-8000-0000000000a1";
const USER_2 = "0197b2c0-0000-7000-8000-0000000000a2";
const ACME = "0197b2c0-0000-7000-8000-0000000000c1";
const OTHER = "0197b2c0-0000-7000-8000-0000000000c2";
const RUN = "0197b2c0-0000-7000-8000-0000000000d1";
const TASK = "0197b2c0-0000-7000-8000-0000000000e1";

const caller = (over: Partial<CommandCaller> = {}): CommandCaller => ({
  workspaceId: WS_A,
  actorId: USER_1,
  membership: { role: "owner", projectScope: null },
  lastStrongAuthAt: null,
  ...over,
});

interface Rig {
  readonly cache: InMemoryCacheAdapter;
  readonly parser: CommandService;
  readonly executor: CommandExecuteService;
  readonly trigger: ReturnType<typeof vi.fn>;
  readonly createTask: ReturnType<typeof vi.fn>;
  readonly bindProject: ReturnType<typeof vi.fn>;
  readonly clock: { now: number };
}

function rig(options: { price?: number | null | string; visibleProjects?: Record<string, { id: string; name: string }> } = {}): Rig {
  const clock = { now: 1_000_000 };
  const cache = new InMemoryCacheAdapter(() => clock.now);
  const visible = options.visibleProjects ?? { acme: { id: ACME, name: "Acme" } };
  const bindProject = vi.fn(async (_caller: CommandCaller, name: string) => visible[name] ?? null);
  const price = options.price === undefined ? 200 : options.price;
  const resolver = { resolveForWorkspace: async () => ({ entitlements: price === null ? {} : { "deep_scan.credits": { value: price } } }) } as unknown as EntitlementResolver;
  const trigger = vi.fn(async (projectId: string) => ({
    progress: { run_id: RUN, project_id: projectId, charge: { credits: 200, charged: false, reason: "pending settlement" } },
    usage: { projectId, referenceType: "run", referenceId: RUN },
  }));
  const createTask = vi.fn(async () => ({ id: TASK }));
  return {
    cache,
    parser: new CommandService(cache, { bindProject } as unknown as EntityIndexService, resolver),
    executor: new CommandExecuteService(cache, { trigger } as never, { createTask } as never),
    trigger,
    createTask,
    bindProject,
    clock,
  };
}

/** Parses and returns the id and action id to present at execute. */
async function parsed(r: Rig, query: string, who: CommandCaller = caller()) {
  const response = await r.parser.parse(who, query);
  const action = response.actions[0]!;
  return { response, parse_id: response.parse_id, action_id: action.action_id };
}

describe("STORY-085 #13 · execute without the parse identifier", () => {
  it("is refused by the strict request schema: a missing parse_id, a missing action_id and an unknown key are all 400s", () => {
    expect(commandExecuteRequestSchema.safeParse({ action_id: "run_deep_scan" }).success).toBe(false);
    expect(commandExecuteRequestSchema.safeParse({ parse_id: "0197b2c0-0000-7000-8000-0000000000f1" }).success).toBe(false);
    expect(commandExecuteRequestSchema.safeParse({ parse_id: "0197b2c0-0000-7000-8000-0000000000f1", action_id: "x", extra: 1 }).success).toBe(false);
  });

  it("an id that was never issued is refused with a 409 and nothing runs", async () => {
    const r = rig();
    await expect(r.executor.execute(caller(), { parse_id: "0197b2c0-0000-7000-8000-0000000000f1", action_id: "run_deep_scan" })).rejects.toBeInstanceOf(ConflictError);
    expect(r.trigger).not.toHaveBeenCalled();
  });

  it("the route is its own endpoint: command_execute rate class, idempotent, the parse-record credit marker, and no handler shared with parse", () => {
    const handler = CommandController.prototype.execute;
    expect(Reflect.getMetadata(RATE_LIMIT_CLASS_KEY, handler)).toBe("command_execute");
    expect(Reflect.getMetadata(IDEMPOTENT_KEY, handler)).toBe(true);
    expect(Reflect.getMetadata(CREDITS_KEY, handler)).toBe(CREDITS_FROM_COMMAND_PARSE);
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler)).toBe("workspace:read");
    expect(handler).not.toBe(CommandController.prototype.parse);
    const contract = Reflect.getMetadata(API_CONTRACT_KEY, handler) as { operationId: string; requestSchema: unknown; responseSchema: unknown; requiresIdempotencyKey?: boolean };
    expect(contract.operationId).toBe("executeCommand");
    expect(contract.requestSchema).toBe(commandExecuteRequestSchema);
    expect(contract.responseSchema).toBe(commandExecuteResponseSchema);
    expect(contract.requiresIdempotencyKey).toBe(true);
  });

  it("the parse route stays free of every credit marker, so the parse can never reserve", () => {
    expect(Reflect.getMetadata(CREDITS_KEY, CommandController.prototype.parse)).toBeUndefined();
    expect(Reflect.getMetadata(CREDITS_KEY, CommandController.prototype.entities)).toBeUndefined();
  });
});

describe("STORY-085 #14 · replay of a used parse identifier", () => {
  it("the second presentation is refused with a 409 and the action ran exactly once", async () => {
    const r = rig();
    const { parse_id, action_id } = await parsed(r, "run deep scan on acme");
    const first = await r.executor.execute(caller(), { parse_id, action_id });
    expect(first.response).toMatchObject({ outcome: "executed", resource: { type: "run", id: RUN }, credits_charged: 200 });
    await expect(r.executor.execute(caller(), { parse_id, action_id })).rejects.toBeInstanceOf(ConflictError);
    expect(r.trigger).toHaveBeenCalledTimes(1);
  });

  it("twenty concurrent presentations of one id: exactly one runs (the consume is atomic)", async () => {
    const r = rig();
    const { parse_id, action_id } = await parsed(r, "run deep scan on acme");
    const outcomes = await Promise.allSettled(Array.from({ length: 20 }, () => r.executor.execute(caller(), { parse_id, action_id })));
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "rejected" && o.reason instanceof ConflictError)).toHaveLength(19);
    expect(r.trigger).toHaveBeenCalledTimes(1);
  });

  it("is bound to the workspace: another workspace's caller cannot present it", async () => {
    const r = rig();
    const { parse_id, action_id } = await parsed(r, "run deep scan on acme");
    await expect(r.executor.execute(caller({ workspaceId: WS_B }), { parse_id, action_id })).rejects.toBeInstanceOf(ConflictError);
    expect(r.trigger).not.toHaveBeenCalled();
  });

  it("is bound to the user: a colleague is refused and the owner's id is NOT burned by it", async () => {
    const r = rig();
    const { parse_id, action_id } = await parsed(r, "run deep scan on acme");
    await expect(r.executor.execute(caller({ actorId: USER_2 }), { parse_id, action_id })).rejects.toBeInstanceOf(ConflictError);
    expect(r.trigger).not.toHaveBeenCalled();
    await expect(r.executor.execute(caller(), { parse_id, action_id })).resolves.toBeDefined();
  });

  it("is bound to the action: a different action_id is a 400 and does not burn the id", async () => {
    const r = rig();
    const { parse_id } = await parsed(r, "run deep scan on acme");
    await expect(r.executor.execute(caller(), { parse_id, action_id: "create_task" })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(r.executor.execute(caller(), { parse_id, action_id: "run_deep_scan" })).resolves.toBeDefined();
  });
});

describe("STORY-085 #15 · a parse identifier that expires", () => {
  it("is refused once the short TTL has passed", async () => {
    const r = rig();
    const { parse_id, action_id } = await parsed(r, "run deep scan on acme");
    r.clock.now += PARSE_RECORD_TTL_MS + 1;
    await expect(r.executor.execute(caller(), { parse_id, action_id })).rejects.toBeInstanceOf(ConflictError);
    expect(r.trigger).not.toHaveBeenCalled();
  });

  it("is still good just inside the TTL, and the TTL is minutes, not hours", async () => {
    const r = rig();
    const { parse_id, action_id } = await parsed(r, "run deep scan on acme");
    r.clock.now += PARSE_RECORD_TTL_MS - 1;
    await expect(r.executor.execute(caller(), { parse_id, action_id })).resolves.toBeDefined();
    expect(PARSE_RECORD_TTL_MS).toBeLessThanOrEqual(15 * 60 * 1000);
  });
});

describe("STORY-085 #17 · an action the role forbids", () => {
  it("parse returns it DISABLED with the permission, not hidden; execute answers 403 naming the permission and runs nothing", async () => {
    const r = rig();
    const viewer = caller({ membership: { role: "viewer", projectScope: null } });
    const { response, parse_id, action_id } = await parsed(r, "run deep scan on acme", viewer);
    expect(response.actions).toHaveLength(1);
    expect(response.actions[0]).toMatchObject({ kind: "run_deep_scan", disabled_reason: "forbidden:tracking:trigger" });
    const refusal = await r.executor.execute(viewer, { parse_id, action_id }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(PermissionDeniedException);
    expect(JSON.stringify((refusal as PermissionDeniedException).getResponse())).toContain("tracking:trigger");
    expect(r.trigger).not.toHaveBeenCalled();
  });

  it("an enabled action carries a null disabled_reason, not an absent one", async () => {
    const r = rig();
    expect((await parsed(r, "run deep scan on acme")).response.actions[0]).toHaveProperty("disabled_reason", null);
  });

  it("the live role is what counts: a role demoted after the parse is refused at execute", async () => {
    const r = rig();
    const { parse_id, action_id } = await parsed(r, "run deep scan on acme");
    await expect(r.executor.execute(caller({ membership: { role: "viewer", projectScope: null } }), { parse_id, action_id })).rejects.toBeInstanceOf(PermissionDeniedException);
    expect(r.trigger).not.toHaveBeenCalled();
  });

  it("a manager scoped to nothing is refused; one scoped elsewhere is out of scope for the project", async () => {
    const r = rig();
    const empty = caller({ membership: { role: "manager", projectScope: [] } });
    const { parse_id, action_id } = await parsed(r, "run deep scan on acme");
    await expect(r.executor.execute(empty, { parse_id, action_id })).rejects.toBeInstanceOf(ProjectOutOfScopeException);
    const elsewhere = caller({ membership: { role: "manager", projectScope: [OTHER] } });
    await expect(r.executor.execute(elsewhere, { parse_id, action_id })).rejects.toBeInstanceOf(ProjectOutOfScopeException);
    expect(r.trigger).not.toHaveBeenCalled();
  });
});

describe("STORY-085 #18 · an action outside the plan", () => {
  it.each([null, "negotiated"])("a plan whose deep_scan.credits is %s: the action is disabled with the entitlement reason and carries no figure", async (price) => {
    const r = rig({ price });
    const { response } = await parsed(r, "run deep scan on acme");
    expect(response.actions[0]).toMatchObject({ disabled_reason: "feature_not_in_plan:deep_scan.credits", credit_estimate: null });
  });

  it("a priced plan carries the exact figure, and 0 stays 0 rather than null", async () => {
    expect((await parsed(rig({ price: 200 }), "run deep scan on acme")).response.actions[0]?.credit_estimate).toEqual({ credits: 200 });
    expect((await parsed(rig({ price: 0 }), "run deep scan on acme")).response.actions[0]?.credit_estimate).toEqual({ credits: 0 });
  });

  it("the parse itself stays free whatever the action costs", async () => {
    expect((await parsed(rig({ price: 500 }), "run deep scan on acme")).response.cost).toEqual({ credits: 0 });
  });
});

describe("STORY-085 · what execute runs, and what it only opens", () => {
  it("run_deep_scan runs the lifecycle on the bound project as the caller; create_task creates the titled task", async () => {
    const r = rig();
    const scan = await parsed(r, "run deep scan on acme");
    await r.executor.execute(caller(), { parse_id: scan.parse_id, action_id: scan.action_id });
    expect(r.trigger).toHaveBeenCalledWith(ACME, USER_1);

    const task = await parsed(r, "create a task to fix schema markup");
    const done = await r.executor.execute(caller(), { parse_id: task.parse_id, action_id: task.action_id, project_id: ACME });
    expect(r.createTask).toHaveBeenCalledWith(ACME, { title: "fix schema markup" });
    expect(done.response).toEqual({ outcome: "executed", intent: "create_task", resource: { type: "task", id: TASK }, target: null, credits_charged: 0 });
  });

  it.each<[CommandIntent, string, string]>([
    ["run_visibility_scan", "run visibility scan on acme", "tools.visibility_scan"],
    ["run_prompt_research", "run prompt research for acme", "tools.prompt_research"],
    ["run_competitor_finder", "run competitor finder for acme", "tools.competitor_finder"],
    ["run_aux_audit", "run aux audit for acme", "tools.aux_audit"],
    ["create_project", "create a new project called newco", "projects.new"],
    ["invite_member", "invite jo@example.com as viewer", "members.invite"],
  ])("%s returns the %s target prefilled and runs, writes and spends nothing", async (intent, phrase, screen) => {
    const r = rig();
    const { parse_id, action_id } = await parsed(r, phrase);
    const result = await r.executor.execute(caller(), { parse_id, action_id });
    expect(result.response).toMatchObject({ outcome: "open_screen", intent, resource: null, credits_charged: 0, target: { screen } });
    expect(commandExecuteResponseSchema.safeParse(result.response).success).toBe(true);
    expect(result.usage).toBeUndefined();
    expect(r.trigger).not.toHaveBeenCalled();
    expect(r.createTask).not.toHaveBeenCalled();
  });

  it("the prefill carries what was typed and the bound project's id and name", async () => {
    const r = rig();
    const scan = await parsed(r, "run visibility scan on acme");
    const out = await r.executor.execute(caller(), { parse_id: scan.parse_id, action_id: scan.action_id });
    expect(out.response.target?.prefill).toEqual({ project_name: "Acme", project_id: ACME });
    const invite = await parsed(r, "invite jo@example.com as viewer");
    const opened = await r.executor.execute(caller(), { parse_id: invite.parse_id, action_id: invite.action_id });
    expect(opened.response.target?.prefill).toEqual({ email: "jo@example.com", role: "viewer" });
  });

  it("an intent the browser answers (navigate, compare, ...) is refused at execute and does not burn its id", async () => {
    const r = rig();
    const nav = await parsed(r, "go to settings");
    await expect(r.executor.execute(caller(), { parse_id: nav.parse_id, action_id: nav.action_id })).rejects.toBeInstanceOf(ValidationFailedError);
    // Still there: refused a second time for the same reason, not as a replay.
    await expect(r.executor.execute(caller(), { parse_id: nav.parse_id, action_id: nav.action_id })).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it("a deep scan or a task with no project bound is a 400 that does not burn the id; one with project_id then proceeds", async () => {
    const r = rig();
    const { parse_id, action_id } = await parsed(r, "run deep scan");
    await expect(r.executor.execute(caller(), { parse_id, action_id })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(r.executor.execute(caller(), { parse_id, action_id, project_id: ACME })).resolves.toBeDefined();
  });

  it("a project_id that disagrees with the bound project is a 400", async () => {
    const r = rig();
    const { parse_id, action_id } = await parsed(r, "run deep scan on acme");
    await expect(r.executor.execute(caller(), { parse_id, action_id, project_id: OTHER })).rejects.toBeInstanceOf(ValidationFailedError);
    expect(r.trigger).not.toHaveBeenCalled();
  });

  it("a task with no title is a 400", async () => {
    const r = rig();
    const { parse_id, action_id } = await parsed(r, "create a task");
    await expect(r.executor.execute(caller(), { parse_id, action_id, project_id: ACME })).rejects.toBeInstanceOf(ValidationFailedError);
    expect(r.createTask).not.toHaveBeenCalled();
  });

  it("unresolved and ambiguous parses offer no action and store no record", async () => {
    const r = rig();
    const set = vi.spyOn(r.cache, "set");
    await r.parser.parse(caller(), "order me a pizza");
    await r.parser.parse(caller(), "create new");
    // Only the two grammar-cache entries: no `command-parse-id` record.
    expect(set.mock.calls.every((call) => !call[0].includes("command-parse-id"))).toBe(true);
  });
});

describe("STORY-085 · entities are bound AFTER the parse cache", () => {
  it("the cached entry holds the typed text and no entity id, and a scoped caller of the same workspace never inherits another's binding", async () => {
    const r = rig();
    // The owner sees Acme; the scoped manager's own query finds nothing under that name.
    r.bindProject.mockImplementation(async () => null);
    r.bindProject.mockImplementationOnce(async () => ({ id: ACME, name: "Acme" }));
    const owner = await r.parser.parse(caller(), "run deep scan on acme");
    expect(owner.entities).toEqual([{ slot: "project", kind: "project", id: ACME, name: "Acme" }]);

    const scoped = caller({ actorId: USER_2, membership: { role: "manager", projectScope: [OTHER] } });
    const second = await r.parser.parse(scoped, "run deep scan on acme");
    expect(second.cached).toBe(true);
    expect(second.entities).toEqual([]);
    // Bound twice: once per caller, never replayed from the cache.
    expect(r.bindProject).toHaveBeenCalledTimes(2);
    expect(r.bindProject).toHaveBeenNthCalledWith(1, expect.objectContaining({ actorId: USER_1 }), "acme");
    expect(r.bindProject).toHaveBeenNthCalledWith(2, expect.objectContaining({ actorId: USER_2 }), "acme");

    // Nothing the cache holds names the project's id.
    const dump: string[] = [];
    for (const key of [...(r.cache as unknown as { entries: Map<string, { value: string }> }).entries.keys()]) {
      if (key.includes(":command-parse:")) dump.push((await r.cache.get(key)) ?? "");
    }
    expect(dump.length).toBeGreaterThan(0);
    for (const value of dump) expect(value).not.toContain(ACME);
  });

  it("a name the index cannot bind (none visible, or several) yields no entity rather than a guess", async () => {
    const r = rig({ visibleProjects: {} });
    const { response } = await parsed(r, "run deep scan on acme");
    expect(response.entities).toEqual([]);
  });
});

describe("STORY-085 #19 · the audit row records the command-bar origin", () => {
  const options = Reflect.getMetadata(AUDIT_METADATA_KEY, CommandController.prototype.execute) as AuditOptions;

  it("is audited as command.executed against the workspace", () => {
    expect(options.action).toBe("command.executed");
    expect(options.resourceType).toBe("workspace");
    expect(options.resourceIdFrom).toBe("workspace");
  });

  it.each([
    [{ outcome: "executed", intent: "run_deep_scan", resource: { type: "run", id: RUN }, target: null, credits_charged: 200 }],
    [{ outcome: "executed", intent: "create_task", resource: { type: "task", id: TASK }, target: null, credits_charged: 0 }],
    [{ outcome: "open_screen", intent: "create_project", resource: null, target: { screen: "projects.new", prefill: { name: "secret co" } }, credits_charged: 0 }],
  ])("the selected state names origin command_bar and never the prefill text: %j", (response) => {
    const state = options.afterState!(response) as Record<string, unknown>;
    expect(state).toMatchObject({ origin: "command_bar", intent: response.intent, outcome: response.outcome, credits_charged: response.credits_charged });
    expect(state).toHaveProperty("resource", response.resource);
    expect(JSON.stringify(state)).not.toContain("secret co");
    expect(Object.keys(state).sort()).toEqual(["credits_charged", "intent", "origin", "outcome", "resource"]);
  });
});

describe("STORY-085 · every executable intent is accounted for", () => {
  it("only run_deep_scan and create_task are handled as `execute`; everything else opens a screen or is the browser's", async () => {
    const r = rig();
    const handling: Record<string, string> = {};
    const phrases: Record<CommandIntent, string> = {
      filter_find: "filter prompts about pricing",
      compare: "compare acme with globex",
      navigate: "go to settings",
      run_visibility_scan: "run visibility scan on acme",
      run_prompt_research: "run prompt research for acme",
      run_competitor_finder: "run competitor finder for acme",
      run_aux_audit: "run aux audit for acme",
      run_deep_scan: "run deep scan on acme",
      create_project: "create a new project called acme",
      create_task: "create a task to fix schema markup",
      show_tasks: "show tasks",
      build_report: "build a report for acme",
      explain_metric: "explain visibility score",
      invite_member: "invite jo@example.com as viewer",
    };
    for (const intent of COMMAND_INTENTS) handling[intent] = (await r.parser.parse(caller(), phrases[intent])).actions[0]!.handling;
    expect(Object.keys(handling).filter((k) => handling[k] === "execute").sort()).toEqual(["create_task", "run_deep_scan"]);
  });
});

describe("STORY-085 AC3 · the entity index contract is bounded", () => {
  it("rejects an unknown key and states its per-kind bound", () => {
    const ok = { entities: [], limit_per_kind: 200, truncated: { project: false, competitor: false, prompt: false, tool_run: false } };
    expect(entityIndexResponseSchema.safeParse(ok).success).toBe(true);
    expect(entityIndexResponseSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });
});
