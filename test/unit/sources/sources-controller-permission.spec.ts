import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import { REQUIRE_PERMISSION_KEY } from "../../../src/api/decorators/require-permission.decorator.js";
import { SourcesController } from "../../../src/modules/analytics/sources.controller.js";

// CP2 c-src audit — the permission name on the two sources routes was never pinned,
// so renaming or dropping it would only have surfaced as a different 403 at runtime.
describe("CP2 c-src · sources routes require aux:read", () => {
  const reflector = new Reflector();

  it("CP2-C-SRC-1 · GET /projects/:id/sources requires aux:read", () => {
    expect(reflector.get(REQUIRE_PERMISSION_KEY, SourcesController.prototype.sourceIndex)).toBe("aux:read");
  });

  it("CP2-C-SRC-2 · GET /projects/:id/sources/:domain/playbook requires aux:read", () => {
    expect(reflector.get(REQUIRE_PERMISSION_KEY, SourcesController.prototype.playbook)).toBe("aux:read");
  });
});
