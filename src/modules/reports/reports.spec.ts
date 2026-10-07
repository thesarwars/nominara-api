import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyFakeApiEnv } from "../../../test/support/fake-env.js";
import { PROJECT_PARAM_KEY } from "../../api/decorators/project-param.decorator.js";
import { ReportsController } from "./reports.controller.js";
import { ReportsModule } from "./reports.module.js";
import { MethodologyService } from "./methodology.service.js";

describe("ReportsModule", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    applyFakeApiEnv();
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("NEW-E-100a — mounts the methodology route and its service", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ReportsModule] }).compile();
    expect(moduleRef.get(ReportsController)).toBeInstanceOf(ReportsController);
    expect(moduleRef.get(MethodologyService)).toBeInstanceOf(MethodologyService);
    await moduleRef.close();
  });

  it("NEW-E-100a AC2 — the route is project-scoped through the project param guard", () => {
    const reflector = new Reflector();
    expect(reflector.get(PROJECT_PARAM_KEY, ReportsController.prototype.methodology)).toBe("id");
  });
});
