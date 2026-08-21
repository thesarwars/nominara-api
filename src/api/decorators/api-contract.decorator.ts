import { SetMetadata } from "@nestjs/common";
import type { ZodType } from "zod";

// STORY-023 AC1 (T1) — marks a route with the zod schemas that ARE its
// contract, for task T3's generator to walk into `openapi.generated.json`
// and, downstream of that, `@nominara/client`. Same `SetMetadata` + typed-
// factory shape as `@Public()`/`@RequirePermission()`/`@Audit()`.
//
// ADR-0002 records why this decorator exists instead of a
// `contracts/registry.ts`, and why it does not grow into a
// `@nestjs/swagger`-shaped API: the metadata below carries REFERENCES to
// zod schemas only — an operation identity plus the request, response, and
// error schema objects themselves — never a duplicated field description,
// example, or type. Those live exactly once, in the schema. A decorator
// that reads like Swagger's is an on-ramp to adopting `@nestjs/swagger`,
// which would make decorator metadata a second description of the contract
// alongside zod and break KAD-05.
export interface ApiContractOptions {
  /** Stable per-route identity used as the generated document's operationId and the drift fingerprint's key. Unique across all routes. */
  readonly operationId: string;
  /** Absent on a route with no request body (e.g. a plain GET). */
  readonly requestSchema?: ZodType;
  /**
   * Absent when the route returns no response body. Seven routes today return
   * `Promise<void>` (identity.controller.ts:43,54,66,88,94 and
   * workspaces.controller.ts:86,116), and zod cannot represent that — verified:
   * `z.toJSONSchema(z.void())` throws "Void cannot be represented in JSON
   * Schema", and `z.null()` would emit `{"type":"null"}`, which is a lie about
   * a 204/200-with-no-body and would become junk in the published client.
   */
  readonly responseSchema?: ZodType;
  /** The query-string contract, e.g. oauth.controller.ts:62's `oauthCallbackQuerySchema`. AC7 covers it like any other request schema. */
  readonly querySchema?: ZodType;
  /** The path-parameter contract, e.g. oauth.controller.ts's `:provider`. */
  readonly paramsSchema?: ZodType;
  /** Absent when the route carries no error shape beyond the shared `problemDetailsSchema`. */
  readonly errorSchema?: ZodType;
}

export const API_CONTRACT_KEY = "apiContract";

// MethodDecorator ONLY — deliberately not a ClassDecorator. A class-level
// application would satisfy a coverage gate that reads metadata via
// `getAllAndOverride([handler, controllerClass])` for EVERY method on that
// controller, letting one decoration stand in for ten routes with one
// operationId and one schema pair. The coverage gate reads method-level
// metadata only; this type makes the shortcut unavailable in the first place.
export const ApiContract = (options: ApiContractOptions): MethodDecorator => SetMetadata(API_CONTRACT_KEY, options);
