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
  /** Stable per-route identity used as the generated document's operationId and the drift fingerprint's key. */
  readonly operationId: string;
  /** Absent on a route with no request body (e.g. a plain GET). */
  readonly requestSchema?: ZodType;
  readonly responseSchema: ZodType;
  /** Absent when the route carries no error shape beyond the shared `problemDetailsSchema`. */
  readonly errorSchema?: ZodType;
}

export const API_CONTRACT_KEY = "apiContract";
export const ApiContract = (options: ApiContractOptions): MethodDecorator & ClassDecorator =>
  SetMetadata(API_CONTRACT_KEY, options);
