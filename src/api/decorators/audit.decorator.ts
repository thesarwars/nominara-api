import { SetMetadata } from "@nestjs/common";

// STORY-020 — declares what AuditInterceptor writes for a mutating route:
// the action name and resource type are static (known at route-definition
// time); the resource id usually is not — a create route only learns it from
// the handler's own response, while an update/delete route already has it in
// the URL. `resourceIdFrom` says which one to read.
export interface AuditOptions {
  readonly action: string;
  readonly resourceType: string;
  /** Where to read resource_id from. "params" reads req.params[paramName] (default); "response" reads the handler's returned body's `.id`. */
  readonly resourceIdFrom?: "params" | "response";
  /**
   * Only used when resourceIdFrom is "response": a dotted path to the id inside a NESTED response body
   * (e.g. "token.id" for `{ token: { id }, secret }`). Absent, the body's own `id` / `<resourceType>_id` is read.
   */
  readonly responseIdPath?: string;
  /** Only used when resourceIdFrom is "params" (the default). The req.params key to read. Defaults to "id". */
  readonly paramName?: string;
}

export const AUDIT_METADATA_KEY = "auditOptions";
export const Audit = (options: AuditOptions): MethodDecorator & ClassDecorator => SetMetadata(AUDIT_METADATA_KEY, options);
