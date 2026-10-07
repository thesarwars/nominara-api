import { readFileSync, readdirSync } from "node:fs";
import { Test } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";
import { COMMAND_INTENTS, UNRESOLVED_INTENT, type CommandIntent } from "../../../contracts/command/command-intent.schema.js";
import { commandParseRequestSchema } from "../../../contracts/command/parse-request.schema.js";
import { commandParseResponseSchema } from "../../../contracts/command/parse-response.schema.js";
import { API_CONTRACT_KEY } from "../../api/decorators/api-contract.decorator.js";
import { CREDITS_KEY } from "../../api/decorators/credits.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "../../api/decorators/require-permission.decorator.js";
import { RATE_LIMIT_CLASS_KEY } from "../../api/rate-limit/route-class.js";
import { CACHE, type Cache } from "../../lib/cache/cache.port.js";
import { InMemoryCacheAdapter } from "../../lib/cache/in-memory-cache.adapter.js";
import { CommandController } from "./command.controller.js";
import { CommandModule } from "./command.module.js";
import { CommandService } from "./command.service.js";
import { parseCacheKey, PARSE_INDEX_VERSION } from "./command-parse-cache.js";

const WS_A = "0197b2c0-0000-7000-8000-00000000000a";
const WS_B = "0197b2c0-0000-7000-8000-00000000000b";

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

function makeService(cache: Cache = new InMemoryCacheAdapter()): CommandService {
  return new CommandService(cache);
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
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0]?.[0]).toMatch(new RegExp(`^[^:]+:${WS_A}:command-parse:[0-9a-f]{64}$`));
    expect(set.mock.calls[0]?.[2]).toEqual({ ttlMs: 24 * 60 * 60 * 1000 });
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
  it("across every intent plus unresolved and ambiguous input, the only cache writes are the parse-cache entry", async () => {
    const cache = new InMemoryCacheAdapter();
    const ops = { set: vi.spyOn(cache, "set"), del: vi.spyOn(cache, "delete"), delIf: vi.spyOn(cache, "deleteIf"), inc: vi.spyOn(cache, "increment"), consume: vi.spyOn(cache, "consume") };
    const service = makeService(cache);
    const inputs = [...Object.values(PHRASES), "order me a pizza", "create new"];
    for (const input of inputs) await service.parse(WS_A, input);
    expect(ops.set).toHaveBeenCalledTimes(inputs.length);
    for (const call of ops.set.mock.calls) expect(call[0]).toContain(":command-parse:");
    expect(ops.del).not.toHaveBeenCalled();
    expect(ops.delIf).not.toHaveBeenCalled();
    expect(ops.inc).not.toHaveBeenCalled();
    expect(ops.consume).not.toHaveBeenCalled();
  });

  it("the service's only dependency is the cache: no database, queue, credit or billing collaborator can be reached", () => {
    const service = makeService();
    expect(Object.values(service as unknown as Record<string, unknown>).length).toBeLessThanOrEqual(1);
    expect(CommandService.length).toBe(1);
  });

  it("no source file of the module imports a database, queue, credit, billing or engine path", () => {
    const dir = new URL(".", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".spec.ts"));
    expect(files.length).toBeGreaterThan(2);
    const banned = /from\s+"[^"]*(\/db\/|credit|billing|\/queue\/|\/engines\/|drizzle|bullmq|CreditGuard|ledger|tenant-context)[^"]*"/i;
    for (const file of files) {
      const source = readFileSync(new URL(file, dir), "utf8");
      expect(source, file).not.toMatch(banned);
    }
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
    const controller = new CommandController({ parse } as unknown as CommandService);
    await controller.parse({ tenant: { workspaceId: WS_A } } as never, { query: "show tasks" });
    expect(parse).toHaveBeenCalledWith(WS_A, "show tasks");
  });

  it("resolves in a Nest testing module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [CommandModule] })
      .overrideProvider(CACHE)
      .useValue(new InMemoryCacheAdapter())
      .compile();
    expect(moduleRef.get(CommandController)).toBeInstanceOf(CommandController);
    await moduleRef.close();
  });
});
