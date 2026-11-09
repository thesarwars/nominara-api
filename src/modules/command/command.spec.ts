import { readFileSync, readdirSync } from "node:fs";
import { Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";
import { COMMAND_INTENTS, UNRESOLVED_INTENT, type CommandIntent } from "../../../contracts/command/command-intent.schema.js";
import { commandParseRequestSchema } from "../../../contracts/command/parse-request.schema.js";
import { commandParseResponseSchema } from "../../../contracts/command/parse-response.schema.js";
import { AUDIT_METADATA_KEY, type AuditOptions } from "../../api/decorators/audit.decorator.js";
import { API_CONTRACT_KEY } from "../../api/decorators/api-contract.decorator.js";
import { CREDITS_KEY } from "../../api/decorators/credits.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "../../api/decorators/require-permission.decorator.js";
import { RATE_LIMIT_CLASS_KEY } from "../../api/rate-limit/route-class.js";
import { CACHE, type Cache } from "../../lib/cache/cache.port.js";
import { InMemoryCacheAdapter } from "../../lib/cache/in-memory-cache.adapter.js";
import { CommandController } from "./command.controller.js";
import { ToolsController } from "../tools/tools.controller.js";
import { TrackingController } from "../tracking/tracking.controller.js";
import { evaluatePermission } from "../../tenancy/permission-matrix.js";
import { RunLifecycleService } from "../tracking/run-lifecycle.service.js";
import { TasksService } from "../tasks/tasks.service.js";
import { CommandService } from "./command.service.js";
import type { CommandCaller } from "./command-caller.js";
import { EntityIndexService } from "./entity-index.service.js";
import { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import { CommandExecuteService } from "./command-execute.service.js";
import { parseCacheKey, PARSE_INDEX_VERSION } from "./command-parse-cache.js";
import { cacheKeyNamespace } from "../../lib/cache/key-namespace.js";
import { parseRecordKey } from "../../lib/command/parse-record.js";

const WS_A = "0197b2c0-0000-7000-8000-00000000000a";
const WS_B = "0197b2c0-0000-7000-8000-00000000000b";
const ACTOR_1 = "0197b2c0-0000-7000-8000-0000000000a1";

/** One phrase per intent, each of which the grammar must resolve to exactly that intent. */
const PHRASES: Readonly<Record<CommandIntent, string>> = {
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

/** A caller with every project visible; `parse(WS_A, ...)` below reads as before. */
const callerFor = (workspaceId: string, actorId = ACTOR_1, role = "owner", projectScope: readonly string[] | null = null): CommandCaller => ({
  workspaceId,
  actorId,
  membership: { role, projectScope },
  lastStrongAuthAt: null,
});

const noEntities = { bindProject: async () => null, usageOf: async () => 0 } as unknown as EntityIndexService;
const noPrice = { resolveForWorkspace: async () => ({ entitlements: {} }) } as unknown as EntitlementResolver;

/** The parse service over a fake entity index and resolver; tests that need a project or a price pass their own. */
function makeService(cache: Cache = new InMemoryCacheAdapter(), entities: EntityIndexService = noEntities, resolver: EntitlementResolver = noPrice): ParseHarness {
  const service = new CommandService(cache, entities, resolver);
  return {
    service,
    parse: (workspace: string | CommandCaller, query: string) => service.parse(typeof workspace === "string" ? callerFor(workspace) : workspace, query),
  };
}
interface ParseHarness {
  readonly service: CommandService;
  parse(workspace: string | CommandCaller, query: string): ReturnType<CommandService["parse"]>;
}

describe("STORY-085 #7 · the grammar covers exactly the canonical intents", () => {
  it("every canonical intent has a phrase here, and each phrase resolves to its own intent", async () => {
    expect(Object.keys(PHRASES).sort()).toEqual([...COMMAND_INTENTS].sort());
    for (const intent of COMMAND_INTENTS) {
      const result = await makeService().parse(WS_A, PHRASES[intent]);
      expect(result.intent, PHRASES[intent]).toBe(intent);
      expect(result.resolved_by).toBe("grammar");
      expect(result.candidates).toEqual([]);
      expect(result.cost).toEqual({ credits: 0 });
      expect(commandParseResponseSchema.safeParse(result).success).toBe(true);
    }
  });

  it("binds slots from the input", async () => {
    const compare = await makeService().parse(WS_A, "Compare Acme with Globex");
    expect(compare.slots).toEqual({ left: "acme", right: "globex" });
    const invite = await makeService().parse(WS_A, "invite jo@example.com as viewer");
    expect(invite.slots).toEqual({ email: "jo@example.com", role: "viewer" });
  });
});

describe("STORY-085 #8 · input matching no intent", () => {
  it("is unresolved with suggestions, cost 0, no actions, resolved_by null", async () => {
    const result = await makeService().parse(WS_A, "order me a pizza");
    expect(result.intent).toBe(UNRESOLVED_INTENT);
    expect(result.resolved_by).toBeNull();
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.actions).toEqual([]);
    expect(result.candidates).toEqual([]);
    expect(result.cost).toEqual({ credits: 0 });
    expect(result.confidence).toBe(0);
  });

  it("empty-after-normalisation input is unresolved, not an error", async () => {
    const result = await makeService().parse(WS_A, "  ?!  ");
    expect(result.intent).toBe(UNRESOLVED_INTENT);
  });
});

describe("STORY-085 #12 · ambiguous input", () => {
  it("returns candidates and does not guess", async () => {
    const result = await makeService().parse(WS_A, "create new");
    expect(result.intent).toBe(UNRESOLVED_INTENT);
    expect(result.resolved_by).toBeNull();
    expect(result.actions).toEqual([]);
    expect(result.candidates.map((c) => c.intent).sort()).toEqual(["create_project", "create_task"]);
    expect(result.cost).toEqual({ credits: 0 });
  });

  it("a specific phrase is not made ambiguous by a generic one", async () => {
    const result = await makeService().parse(WS_A, "find tasks");
    expect(result.intent).toBe("show_tasks");
  });
});

describe("STORY-085 #10 · the parse cache", () => {
  it("the second identical parse is a cache hit, cost 0, with the same answer and a fresh parse_id", async () => {
    const service = makeService();
    const first = await service.parse(WS_A, "show tasks");
    const second = await service.parse(WS_A, "  Show   TASKS ");
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.cost).toEqual({ credits: 0 });
    expect({ ...second, parse_id: "", cached: false }).toEqual({ ...first, parse_id: "", cached: false });
    expect(second.parse_id).not.toBe(first.parse_id);
  });

  it("an unresolved parse is cached too (a cached parse is free however it resolved)", async () => {
    const service = makeService();
    await service.parse(WS_A, "order me a pizza");
    expect((await service.parse(WS_A, "order me a pizza")).cached).toBe(true);
  });

  it("the cache is per workspace", async () => {
    const service = makeService();
    await service.parse(WS_A, "show tasks");
    expect((await service.parse(WS_B, "show tasks")).cached).toBe(false);
  });

  it("the key is sha256(normalised | workspace | index version) under a tenant-namespaced key, 24 h TTL", async () => {
    const cache = new InMemoryCacheAdapter();
    const set = vi.spyOn(cache, "set");
    await makeService(cache).parse(WS_A, "Show Tasks");
    const key = parseCacheKey("test", WS_A, "show tasks", PARSE_INDEX_VERSION);
    // The grammar entry is one write; the single-use parse record (its own key family) is the other.
    const grammar = set.mock.calls.filter((call) => /:command-parse:/.test(call[0]));
    expect(grammar).toHaveLength(1);
    expect(set).toHaveBeenCalledTimes(2);
    expect(grammar[0]?.[0]).toMatch(new RegExp(`^[^:]+:${WS_A}:command-parse:[0-9a-f]{64}$`));
    expect(grammar[0]?.[2]).toEqual({ ttlMs: 24 * 60 * 60 * 1000 });
    expect(key).toMatch(/^test:.*:command-parse:[0-9a-f]{64}$/);
  });

  it("a different workspace, query or index version gives a different key", () => {
    const base = parseCacheKey("test", WS_A, "show tasks", "v1");
    expect(parseCacheKey("test", WS_B, "show tasks", "v1")).not.toBe(base);
    expect(parseCacheKey("test", WS_A, "show task", "v1")).not.toBe(base);
    expect(parseCacheKey("test", WS_A, "show tasks", "v2")).not.toBe(base);
    expect(parseCacheKey("test", WS_A, "show tasks", "v1")).toBe(base);
  });
});

describe("STORY-085 #11 · a parse never mutates and never enqueues", () => {
  it("across every intent plus unresolved and ambiguous input, the only cache writes are the parse-cache entry and the single-use parse record", async () => {
    const cache = new InMemoryCacheAdapter();
    const ops = { set: vi.spyOn(cache, "set"), del: vi.spyOn(cache, "delete"), delIf: vi.spyOn(cache, "deleteIf"), inc: vi.spyOn(cache, "increment"), consume: vi.spyOn(cache, "consume") };
    const harness = makeService(cache);
    const inputs = [...Object.values(PHRASES), "order me a pizza", "create new"];
    let withAction = 0;
    for (const input of inputs) withAction += (await harness.parse(WS_A, input)).actions.length;
    // One grammar entry per input, plus one record per input that offered an action - and nothing else.
    expect(ops.set).toHaveBeenCalledTimes(inputs.length + withAction);
    for (const call of ops.set.mock.calls) expect(call[0]).toMatch(/:command-parse(-id)?:/);
    expect(ops.del).not.toHaveBeenCalled();
    expect(ops.delIf).not.toHaveBeenCalled();
    expect(ops.inc).not.toHaveBeenCalled();
    expect(ops.consume).not.toHaveBeenCalled();
  });

  it("the parse service reaches the cache, the entity index and the plan's price - and no write path", () => {
    const held = Object.keys(makeService().service as unknown as Record<string, unknown>).sort();
    expect(held).toEqual(["cache", "entities", "logger", "resolver"]);
    expect(CommandService.length).toBe(3);
  });

  it("the execute service is a different class the parse service cannot reach", () => {
    expect(Object.keys(makeService().service as unknown as Record<string, unknown>)).not.toContain("runs");
    expect(Object.keys(makeService().service as unknown as Record<string, unknown>)).not.toContain("tasks");
    expect(CommandExecuteService).not.toBe(CommandService);
  });

  // The parse-side files may READ (the entity index is how a typed name becomes an id), and that is the one file
  // allowed a tenant transaction. Everything else on the parse side keeps the original ban, and the entity index
  // itself may contain no statement that writes.
  it("no parse-side source file imports a queue, credit, billing, engine, task or run path; only the entity index touches the tenant store, and it never writes", () => {
    const dir = new URL(".", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".spec.ts"));
    expect(files.length).toBeGreaterThan(2);
    const writerFiles = ["command-execute.service.ts", "command.controller.ts", "command.module.ts"];
    const banned = /from\s+"[^"]*(\/db\/|credit|billing|\/queue\/|\/engines\/|drizzle|bullmq|CreditGuard|ledger|\/tasks\/|\/tracking\/)[^"]*"/i;
    for (const file of files.filter((f) => !writerFiles.includes(f))) {
      const source = readFileSync(new URL(file, dir), "utf8");
      expect(source, file).not.toMatch(banned);
      if (file !== "entity-index.service.ts") expect(source, file).not.toMatch(/from\s+"[^"]*tenant-context[^"]*"/);
    }
    const index = readFileSync(new URL("entity-index.service.ts", dir), "utf8");
    expect(index).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|set_config|nextval)\b/);
  });

  it("an actions[] entry that spends credits is flagged as needing confirmation and is never executed by the parse", async () => {
    const result = await makeService().parse(WS_A, PHRASES.run_deep_scan);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({ kind: "run_deep_scan", is_mutating: true, requires_confirmation: true });
  });
});

describe("STORY-085-A · the route", () => {
  const handler = CommandController.prototype.parse;

  it("is rate-limited as command_parse (120/min, api-specification.md §12)", () => {
    expect(Reflect.getMetadata(RATE_LIMIT_CLASS_KEY, handler)).toBe("command_parse");
  });

  it("requires workspace:read and carries no credit decorator, so CreditGuard has nothing to act on", () => {
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler)).toBe("workspace:read");
    expect(Reflect.getMetadata(CREDITS_KEY, handler)).toBeUndefined();
    expect(Reflect.getMetadata(CREDITS_KEY, CommandController)).toBeUndefined();
  });

  it("declares its contract with a strict request schema", () => {
    const contract = Reflect.getMetadata(API_CONTRACT_KEY, handler) as { operationId: string; requestSchema: unknown; responseSchema: unknown };
    expect(contract.operationId).toBe("parseCommand");
    expect(contract.requestSchema).toBe(commandParseRequestSchema);
    expect(contract.responseSchema).toBe(commandParseResponseSchema);
    expect(commandParseRequestSchema.safeParse({ query: "x", extra: 1 }).success).toBe(false);
    expect(commandParseRequestSchema.safeParse({ query: "   " }).success).toBe(false);
  });

  it("calls the service with the tenant's workspace id", async () => {
    const parse = vi.fn().mockResolvedValue({ ok: true });
    const controller = new CommandController({ parse } as unknown as CommandService, {} as never, {} as never);
    await controller.parse({ tenant: { workspaceId: WS_A, actorId: ACTOR_1 }, membership: { role: "viewer", projectScope: null } } as never, { query: "show tasks" });
    expect(parse).toHaveBeenCalledWith({ workspaceId: WS_A, actorId: ACTOR_1, membership: { role: "viewer", projectScope: null }, lastStrongAuthAt: null }, "show tasks");
  });

  it("resolves in a Nest testing module (the module's own wiring is driven end to end by command-execute-http.spec.ts)", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CommandController],
      providers: [
        CommandService,
        CommandExecuteService,
        EntityIndexService,
        { provide: CACHE, useValue: new InMemoryCacheAdapter() },
        { provide: EntitlementResolver, useValue: {} },
        { provide: RunLifecycleService, useValue: {} },
        { provide: TasksService, useValue: {} },
      ],
    }).compile();
    expect(moduleRef.get<Cache>(CACHE)).toBeDefined();
    expect(moduleRef.get(CommandController)).toBeInstanceOf(CommandController);
    await moduleRef.close();
  });
});

// STORY-085-A audit [major] — written from api-specification.md §10 (a parse
// never mutates; execution of a spending action is two-step) and the
// security-and-tenancy.md §6 permission matrix, NOT copied from ACTIONS.
// `requires_confirmation` is what the client reads to decide whether to show a
// confirmation before a spending action, so a silent flip is a credit hazard.
// Every intent is pinned; a new intent fails the key-set check until it is.
const EXPECTED: Readonly<Record<CommandIntent, { mutating: boolean; permission: string | null }>> = {
  filter_find: { mutating: false, permission: "project:read" },
  compare: { mutating: false, permission: "project:read" },
  navigate: { mutating: false, permission: null },
  run_visibility_scan: { mutating: true, permission: "lookup:execute" },
  run_prompt_research: { mutating: true, permission: "prompt:write" },
  run_competitor_finder: { mutating: true, permission: "lookup:execute" },
  run_aux_audit: { mutating: true, permission: "aux:trigger" },
  run_deep_scan: { mutating: true, permission: "tracking:trigger" },
  create_project: { mutating: true, permission: "project:create" },
  create_task: { mutating: true, permission: "task:create" },
  show_tasks: { mutating: false, permission: "task:read" },
  build_report: { mutating: true, permission: "export:data" },
  explain_metric: { mutating: false, permission: null },
  invite_member: { mutating: true, permission: "member:invite" },
};

describe("STORY-085-A audit · every intent's action flags and permission are pinned", () => {
  it("the fixture covers exactly the canonical intents", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...COMMAND_INTENTS].sort());
  });

  it.each(COMMAND_INTENTS)("%s: is_mutating, requires_confirmation and required_permission", async (intent) => {
    const result = await makeService().parse(WS_A, PHRASES[intent]);
    const expected = EXPECTED[intent];
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      kind: intent,
      is_mutating: expected.mutating,
      requires_confirmation: expected.mutating,
      required_permission: expected.permission,
    });
  });
});

// B5 review finding: `required_permission` ENFORCES (disabled_reason, execute's re-check), so it must be the permission of the route the action
// reaches. Derived from the controllers' own @RequirePermission metadata, not typed a second time.
describe("B5 · each action's required_permission is its target route's @RequirePermission", () => {
  const routePermission = (ctrl: object, method: string): string =>
    Reflect.getMetadata(REQUIRE_PERMISSION_KEY, (ctrl as Record<string, object>)[method] as object) as string;
  const TARGET: Partial<Record<CommandIntent, string>> = {
    run_visibility_scan: routePermission(ToolsController.prototype, "scan"),
    run_prompt_research: routePermission(ToolsController.prototype, "discoverPrompts"),
    run_competitor_finder: routePermission(ToolsController.prototype, "findCompetitors"),
    run_aux_audit: routePermission(ToolsController.prototype, "auxAuditStart"),
    run_deep_scan: routePermission(TrackingController.prototype, "trigger"),
  };

  it.each(Object.keys(TARGET) as CommandIntent[])("%s matches its route", (intent) => {
    expect(TARGET[intent]).toBeTruthy();
    expect(EXPECTED[intent].permission).toBe(TARGET[intent]);
  });

  it("an analyst (lookup:execute allow, tracking:trigger deny) is offered the scan and competitor finder the tool screen allows", async () => {
    const analyst = callerFor(WS_A, ACTOR_1, "analyst");
    expect(evaluatePermission("analyst", "lookup:execute").access).not.toBe("deny");
    expect(evaluatePermission("analyst", "tracking:trigger").access).toBe("deny");
    for (const intent of ["run_visibility_scan", "run_competitor_finder"] as const) {
      const parsed = await makeService().parse(analyst, PHRASES[intent]);
      expect(parsed.actions[0]?.disabled_reason, intent).toBeNull();
    }
  });
});

// STORY-085-A CP2 audit — the parse's one audited row must not copy customer
// text. `slots` and `candidates[].slots` are verbatim input (an invitee's
// email, a task title); `redactState` only catches long high-entropy strings,
// so the row is built from a closed list of outcome fields instead.
describe("STORY-085-A CP2 · the audit row carries the outcome, never the customer's text", () => {
  const options = Reflect.getMetadata(AUDIT_METADATA_KEY, CommandController.prototype.parse) as AuditOptions;

  it("declares an afterState selector on the parse route", () => {
    expect(typeof options.afterState).toBe("function");
  });

  it.each([
    ["invite jo@acme.io as viewer", "jo@acme.io"],
    ["create a task to fire jane doe for misconduct", "jane doe"],
    ["compare acme with globex", "globex"],
    ["order me a pizza", "pizza"],
  ])("%s: the selected state holds intent, resolved_by, cached and confidence only", async (phrase, secret) => {
    const response = await makeService().parse(WS_A, phrase);
    const state = options.afterState!(response) as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual(["cached", "confidence", "intent", "resolved_by"]);
    expect(state).toEqual({
      intent: response.intent,
      resolved_by: response.resolved_by,
      cached: response.cached,
      confidence: response.confidence,
    });
    expect(JSON.stringify(state)).not.toContain(secret);
  });

  it("keeps null distinct from a value: an unresolved parse has resolved_by null, not absent", async () => {
    const state = options.afterState!(await makeService().parse(WS_A, "order me a pizza")) as Record<string, unknown>;
    expect(state).toHaveProperty("resolved_by", null);
    expect(state).toHaveProperty("confidence", 0);
  });
});

describe("STORY-085-A CP2 · metric and log are asserted directly", () => {
  it("emits nominara_command_parse_total with outcome and cached, and a log line with the workspace ID and no query text", async () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    try {
      const service = makeService();
      const phrase = "invite secret.person@example.com as viewer";
      await service.parse(WS_A, phrase);
      await service.parse(WS_A, phrase);
      await service.parse(WS_A, "order me a pizza");
      const lines = log.mock.calls.map((call) => call[0] as Record<string, unknown>);
      const metrics = lines.filter((line) => line.metric === "nominara_command_parse_total");
      expect(metrics.map((m) => [m.outcome, m.cached])).toEqual([
        ["resolved", "false"],
        ["resolved", "true"],
        ["unresolved", "false"],
      ]);
      const parseLines = lines.filter((line) => line.event === "command.parse");
      expect(parseLines).toHaveLength(3);
      for (const line of parseLines) expect(line.workspace_id).toBe(WS_A);
      const everything = JSON.stringify(lines);
      expect(everything).not.toContain("secret.person");
      expect(everything).not.toContain("pizza");
    } finally {
      log.mockRestore();
    }
  });
});

describe("STORY-085 review round 1 - free text keeps the user's own casing (title, name); matching and the cache key stay normalised", () => {
  it("a task title and a project name are stored as typed, with edge punctuation dropped", async () => {
    const task = await makeService().parse(WS_A, "create a task called Fix Homepage FAQ for iOS.");
    expect(task.intent).toBe("create_task");
    expect(task.slots).toEqual({ title: "Fix Homepage FAQ for iOS" });
    const project = await makeService().parse(WS_A, "Create a project called Acme GmbH");
    expect(project.slots).toEqual({ name: "Acme GmbH" });
  });

  it("two spellings of one request share the cache entry and each keeps ITS OWN casing", async () => {
    const service = makeService();
    const first = await service.parse(WS_A, "create a task called fix faq");
    const second = await service.parse(WS_A, "Create a task called Fix FAQ");
    expect(first.slots).toEqual({ title: "fix faq" });
    expect(second.cached).toBe(true);
    expect(second.slots).toEqual({ title: "Fix FAQ" });
  });

  it("the single-use record stores the cased slot, so execute creates the task with it", async () => {
    const cache = new InMemoryCacheAdapter();
    const parsed = await makeService(cache).parse(WS_A, "create a task called Fix Homepage FAQ");
    const raw = await cache.get(parseRecordKey(cacheKeyNamespace(), WS_A, parsed.parse_id));
    expect(raw, "the parse record").toBeDefined();
    expect(JSON.parse(raw!).slots).toEqual({ title: "Fix Homepage FAQ" });
  });

  it("slots that are not free text stay normalised (a role, a metric, an e-mail address)", async () => {
    expect((await makeService().parse(WS_A, "Invite Jo@Example.com as Viewer")).slots).toEqual({ email: "jo@example.com", role: "viewer" });
  });
});

describe("STORY-085 review round 1 - FR-CMD-05: an action outside the plan is returned DISABLED with the reason, per intent", () => {
  const free = { "projects.max": { value: 0 }, "seats.max": { value: 1 }, "exports.pdf_per_cycle": { value: 0 }, "deep_scan.credits": { value: null } };
  const growth = { "projects.max": { value: 3 }, "seats.max": { value: 7 }, "exports.pdf_per_cycle": { value: 25 }, "deep_scan.credits": { value: 200 } };
  const resolverOf = (entitlements: Record<string, { value: unknown }>) => ({ resolveForWorkspace: async () => ({ entitlements }) }) as unknown as EntitlementResolver;
  const usage = (n: number) => ({ bindProject: async () => null, usageOf: async () => n }) as unknown as EntityIndexService;
  const reasonOf = async (entitlements: Record<string, { value: unknown }>, used: number, intent: CommandIntent): Promise<string | null | undefined> =>
    (await makeService(new InMemoryCacheAdapter(), usage(used), resolverOf(entitlements)).parse(WS_A, PHRASES[intent])).actions[0]?.disabled_reason;

  it("create a project on a plan with no project slot is entitlement_exceeded:projects.max (a structural limit, never feature_not_in_plan)", async () => {
    expect(await reasonOf(free, 0, "create_project")).toBe("entitlement_exceeded:projects.max");
  });
  it("create a project at the ceiling is the same refusal; below it the action is enabled", async () => {
    expect(await reasonOf(growth, 3, "create_project")).toBe("entitlement_exceeded:projects.max");
    expect(await reasonOf(growth, 2, "create_project")).toBeNull();
  });
  it("invite a member at the seat ceiling is entitlement_exceeded:seats.max; with a free seat it is enabled", async () => {
    expect(await reasonOf(free, 1, "invite_member")).toBe("entitlement_exceeded:seats.max");
    expect(await reasonOf(growth, 6, "invite_member")).toBeNull();
  });
  it("build a report on a plan whose PDF allowance is 0 is feature_not_in_plan:exports.pdf_per_cycle; on a plan that has it, enabled", async () => {
    expect(await reasonOf(free, 0, "build_report")).toBe("feature_not_in_plan:exports.pdf_per_cycle");
    expect(await reasonOf(growth, 0, "build_report")).toBeNull();
  });
  it("a deep scan on a plan with no price is feature_not_in_plan:deep_scan.credits; unlimited keys (custom, unlimited) never disable", async () => {
    expect(await reasonOf(free, 0, "run_deep_scan")).toBe("feature_not_in_plan:deep_scan.credits");
    expect(await reasonOf({ "projects.max": { value: "custom" }, "seats.max": { value: "unlimited" } }, 999, "create_project")).toBeNull();
    expect(await reasonOf({ "projects.max": { value: "custom" }, "seats.max": { value: "unlimited" } }, 999, "invite_member")).toBeNull();
  });
  it("a role refusal still comes first, and an intent with no gating key is never disabled by the plan", async () => {
    const viewer = callerFor(WS_A, ACTOR_1, "viewer");
    const parsed = await makeService(new InMemoryCacheAdapter(), usage(9), resolverOf(free)).parse(viewer, PHRASES.create_project);
    expect(parsed.actions[0]?.disabled_reason).toBe("forbidden:project:create");
    expect(await reasonOf(free, 9, "create_task")).toBeNull();
  });
});
