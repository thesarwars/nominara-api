import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyFakeApiEnv } from "../../../test/support/fake-env.js";
import { RATE_LIMIT_CLASS_KEY } from "../../api/rate-limit/route-class.js";
import { DAILY_CAP_KEY } from "../../api/decorators/daily-cap.decorator.js";
import { STREAMING_KEY } from "../../api/decorators/streaming.decorator.js";
import { ToolsController } from "./tools.controller.js";
import { ToolsModule } from "./tools.module.js";
import { ToolsService } from "./tools.service.js";

// STORY-022 - one compiles-test per scaffolded module.
//
// STORY-078 gave ToolsModule real collaborators (ProjectsModule -> QueueProducerModule, EntitlementsModule), whose factories read the
// environment at .compile() time - hence the env fixture, as in projects.spec.ts.
describe("STORY-022 · ToolsModule compiles", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    applyFakeApiEnv();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("resolves in a Nest testing module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ToolsModule] }).compile();
    expect(moduleRef.get(ToolsController)).toBeInstanceOf(ToolsController);
    expect(moduleRef.get(ToolsService)).toBeInstanceOf(ToolsService);
    await moduleRef.close();
  });
});

// STORY-079 - the scan route's guard declarations (api-specification.md section 12, security-and-tenancy.md section 5). A guard that is never
// declared never runs, and nothing fails when it does not, so the declarations are asserted on the handler itself.
describe("STORY-079 · the scan route declares its guards", () => {
  const handler = (name: keyof ToolsController): unknown => (ToolsController.prototype as unknown as Record<string, unknown>)[name];

  it("is a capture-backed tool (5/min per user), shares the one daily counter, and streams", () => {
    expect(Reflect.getMetadata(RATE_LIMIT_CLASS_KEY, handler("scan") as object)).toBe("capture_backed_tools");
    expect(Reflect.getMetadata(DAILY_CAP_KEY, handler("scan") as object)).toBe("lookup");
    expect(Reflect.getMetadata(STREAMING_KEY, handler("scan") as object)).toBe(true);
  });

  it("the free estimate is neither daily-capped nor streaming: it costs nothing and starts nothing", () => {
    expect(Reflect.getMetadata(DAILY_CAP_KEY, handler("estimateScan") as object)).toBeUndefined();
    expect(Reflect.getMetadata(STREAMING_KEY, handler("estimateScan") as object)).toBeUndefined();
  });
});

// STORY-081 - the Competitor Finder route shares the one `lookup` daily counter (an account cannot alternate tools to defeat it) and the capture-backed rate class.
describe("STORY-081 · the Competitor Finder route declares its guards", () => {
  const handler = (ToolsController.prototype as unknown as Record<string, object>)["findCompetitors"]!;
  it("is a capture-backed tool on the shared daily counter, and not a stream", () => {
    expect(Reflect.getMetadata(RATE_LIMIT_CLASS_KEY, handler)).toBe("capture_backed_tools");
    expect(Reflect.getMetadata(DAILY_CAP_KEY, handler)).toBe("lookup");
    expect(Reflect.getMetadata(STREAMING_KEY, handler)).toBeUndefined();
  });
});

// STORY-082 - the AUX audit tool routes: the permission the reference names, the crawl-backed rate class (10/hour per user), and no streaming.
describe("STORY-082 · the AUX audit tool routes declare their guards", () => {
  const handler = (name: string): object => (ToolsController.prototype as unknown as Record<string, object>)[name]!;
  it("the start route is on the AUX audit rate class and is not a stream", () => {
    expect(Reflect.getMetadata(RATE_LIMIT_CLASS_KEY, handler("auxAuditStart"))).toBe("project_aux_audits");
    expect(Reflect.getMetadata(STREAMING_KEY, handler("auxAuditStart"))).toBeUndefined();
  });
  it("the free estimate is neither daily-capped nor streaming", () => {
    expect(Reflect.getMetadata(DAILY_CAP_KEY, handler("auxAuditEstimate"))).toBeUndefined();
    expect(Reflect.getMetadata(STREAMING_KEY, handler("auxAuditEstimate"))).toBeUndefined();
  });
});
