import { Logger } from "@nestjs/common";
import type { ClientBase, Pool } from "pg";
import { resolvedEntitlementsResponseSchema } from "../../../contracts/entitlements/resolved-entitlements.schema.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import type { Cache } from "../cache/cache.port.js";
import { cacheKeyNamespace } from "../cache/key-namespace.js";
import { entitlementsKey } from "../cache/valkey-keys.js";
import { readEntitlementVersion, resolveEntitlements, type ResolvedEntitlementsResponse } from "./resolution.js";

// STORY-069 AC4 — plans-and-entitlements.md §8: "Memoised in Valkey for 60 s
// keyed `ent:{workspace_id}:{entitlement_version}`. **The version bumps on any
// plan, add-on, or override change**, which is what makes the memoisation safe
// (`NFR-CRD-05`)."
//
// AND WHY THE VERSION IS A PARAMETER RATHER THAN SOMETHING THIS CLASS READS.
// The version is already established, once, earlier in every request:
// WorkspaceGuard calls getWorkspaceStatus, compares the live
// `entitlement_version` against the token's `ent_v`, and refuses the request
// outright with `EntitlementStaleException` when they differ. So by the time
// EntitlementGuard runs, the version is a known-fresh fact about this request,
// and re-reading it here would be a second round trip for an answer already
// on the request object.
//
// That existing check is also what makes AC4's "a version bump invalidates it
// immediately" true in the strongest sense available. A bump does not merely
// move the memo key: it invalidates every access token carrying the old
// `ent_v`, so the next request is refused until it presents a token minted
// against the new version. There is no window in which a downgrade has been
// recorded and an old entry is still being served — which is the failure mode
// §8 names, and the one that matters because it points at a customer using a
// tier they have stopped paying for.

export const ENTITLEMENT_MEMO_TTL_MS = 60_000;

const logger = new Logger("entitlements");

export class EntitlementResolver {
  constructor(
    private readonly cache: Cache,
    private readonly pool: Pool,
  ) {}

  /**
   * Resolve at a version the caller has already established.
   *
   * On a memo hit this makes NO database call at all — which is the whole
   * point, and is what test scenario 5 ("resolve twice inside the memo window
   * → one database read") is asserting.
   */
  async resolve(workspaceId: string, entitlementVersion: number): Promise<ResolvedEntitlementsResponse> {
    const namespace = cacheKeyNamespace();
    const cached = await this.cache.get(entitlementsKey(namespace, workspaceId, entitlementVersion));
    if (cached !== undefined) {
      const hit = this.parseMemo(cached, workspaceId);
      if (hit !== undefined) {
        return hit;
      }
    }

    const resolved = await this.read(workspaceId);

    // Written under the version the READ returned, never the one asked for.
    // The two differ when a bump lands between the caller establishing its
    // version and this query running. Writing the fresh values under the old
    // key would hand the next reader at the old version a payload that no
    // longer matches it; leaving that key unwritten means the old version
    // simply keeps missing, which is the correct outcome for a version that
    // has been superseded.
    await this.cache.set(
      entitlementsKey(namespace, workspaceId, resolved.entitlement_version),
      JSON.stringify(resolved),
      { ttlMs: ENTITLEMENT_MEMO_TTL_MS },
    );

    return resolved;
  }

  /**
   * Resolve without knowing the version — one extra primary-key read.
   *
   * For callers with no request-scoped version to hand: a worker, a test, and
   * `GET /billing/entitlements` itself, which must report the version rather
   * than assume one.
   */
  async resolveForWorkspace(workspaceId: string): Promise<ResolvedEntitlementsResponse> {
    const version = await this.withWorkspaceContext(workspaceId, (tx) => readEntitlementVersion(tx, workspaceId));
    return await this.resolve(workspaceId, version);
  }

  /**
   * A memo entry that does not parse is treated as a MISS, not as an error.
   *
   * The entry is data this process wrote, so a parse failure means the shape
   * changed under a deploy — a new entitlement key, a renamed field — and
   * every workspace's entry is suddenly from the previous contract. Failing
   * the request would take the platform down on a deploy that was otherwise
   * correct; falling through to the database costs one query and self-heals on
   * the write below. Logged at warn because it should be rare enough to notice.
   */
  private parseMemo(raw: string, workspaceId: string): ResolvedEntitlementsResponse | undefined {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      logger.warn({ message: "entitlement memo is not valid JSON — falling through to the database", workspaceId });
      return undefined;
    }

    const parsed = resolvedEntitlementsResponseSchema.safeParse(decoded);
    if (!parsed.success) {
      logger.warn({
        message: "entitlement memo does not match the current contract — falling through to the database",
        workspaceId,
        issues: parsed.error.issues.length,
      });
      return undefined;
    }
    return parsed.data;
  }

  private async read(workspaceId: string): Promise<ResolvedEntitlementsResponse> {
    return await this.withWorkspaceContext(workspaceId, (tx) => resolveEntitlements(tx, workspaceId));
  }

  /**
   * SYSTEM_ACTOR_ID, following MembershipService.getWorkspaceStatus.
   *
   * This runs in the guard chain, before TenantContextInterceptor has opened
   * anything, so there is no ambient transaction to reuse and no actor context
   * to inherit. `workspaces`, `plans` and `subscription_addons` are read here
   * on the workspace's own behalf rather than on any user's — a viewer and an
   * owner resolve identical entitlements — and RLS still binds the two
   * tenant-scoped tables to `workspaceId`.
   */
  private async withWorkspaceContext<T>(
    workspaceId: string,
    fn: (tx: ClientBase) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, fn);
    } finally {
      client.release();
    }
  }
}
