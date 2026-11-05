import { SetMetadata } from "@nestjs/common";
import type { AuditSeverity } from "../../lib/crypto/audit-chain.js";

// STORY-020 — declares what AuditInterceptor writes for a mutating route:
// the action name and resource type are static (known at route-definition
// time); the resource id usually is not — a create route only learns it from
// the handler's own response, while an update/delete route already has it in
// the URL. `resourceIdFrom` says which one to read.
export interface AuditOptions {
  readonly action: string;
  /**
   * When one route has more than one audit-worthy outcome (STORY-055: a completion that is a submission for review), picks the action
   * from the handler's response. `action` stays the default and the documented name (the route table reads it); a throw or a non-string falls back to it.
   */
  readonly actionFrom?: (responseBody: unknown) => string;
  readonly resourceType: string;
  /**
   * Where to read resource_id from. "params" reads req.params[paramName] (default); "response" reads the handler's returned body's `.id`.
   * "workspace" (STORY-075a) is for a mutation on a workspace-singleton resource that has no id of its own and
   * whose response carries none (a billing-portal session): the resource IS the caller's workspace, and its id
   * is taken from the tenant context — never from the request.
   */
  readonly resourceIdFrom?: "params" | "response" | "workspace";
  /**
   * Only used when resourceIdFrom is "response": a dotted path to the id inside a NESTED response body
   * (e.g. "token.id" for `{ token: { id }, secret }`). Absent, the body's own `id` / `<resourceType>_id` is read.
   */
  readonly responseIdPath?: string;
  /** Only used when resourceIdFrom is "params" (the default). The req.params key to read. Defaults to "id". */
  readonly paramName?: string;
  /** The row's severity. Defaults to "info"; a credential being minted or revoked declares a higher one (NEW-D-4). */
  readonly severity?: AuditSeverity;
  /**
   * Picks what `after_state` records from the handler's response. Absent, the whole response is recorded. A route whose
   * response carries verbatim customer text (STORY-085-A: a parse echoes the typed query's slots) names a CLOSED list of
   * outcome fields here, because `redactState` only strips long high-entropy strings and cannot be relied on for short text.
   */
  readonly afterState?: (responseBody: unknown) => unknown;
}

export const AUDIT_METADATA_KEY = "auditOptions";
export const Audit = (options: AuditOptions): MethodDecorator & ClassDecorator => SetMetadata(AUDIT_METADATA_KEY, options);
