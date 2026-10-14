import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import { RATE_LIMIT_CLASS_KEY } from "../../src/api/rate-limit/route-class.js";
import { TrackingController } from "../../src/modules/tracking/tracking.controller.js";

// STORY-025 AC11 — "each of the 13 classes has its documented limit" holds for the route table only if the route
// declares its class. The integration spec proves the behaviour over HTTP; this proves the declaration itself in the
// fast suite, so removing the decorator is caught without a container.

describe("STORY-025 AC11 · route-class declarations", () => {
  it("STORY-025 AC11 · POST /projects/:id/runs (TrackingController.trigger) declares the project_runs class", () => {
    const declared = new Reflector().get<string | undefined>(RATE_LIMIT_CLASS_KEY, TrackingController.prototype.trigger);
    expect(declared).toBe("project_runs");
  });
});
