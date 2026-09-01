import { Injectable } from "@nestjs/common";
import { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import type { ResolvedEntitlementsResponse } from "./dto/index.js";

// STORY-069 AC5 — the service behind `GET /billing/entitlements`.
//
// Thin on purpose: resolution lives in src/lib/entitlements/ because
// EntitlementGuard needs it too and a guard must not reach into a module's
// service. This class exists so the controller has one method to call
// (coding-standards.md §1) and so the module owns its own read path rather
// than the controller talking to a lib directly.
@Injectable()
export class EntitlementsService {
  constructor(private readonly resolver: EntitlementResolver) {}

  /**
   * `entitlementVersion` is the value WorkspaceGuard established for this
   * request. Passing it through means the endpoint shares the guard's memo
   * entry instead of resolving separately — the same payload the gates were
   * evaluated against, which is what "every limit and gate in the interface
   * renders from one payload" has to mean to be worth anything.
   */
  async resolve(workspaceId: string, entitlementVersion: number | undefined): Promise<ResolvedEntitlementsResponse> {
    return entitlementVersion === undefined
      ? await this.resolver.resolveForWorkspace(workspaceId)
      : await this.resolver.resolve(workspaceId, entitlementVersion);
  }
}
