import "reflect-metadata";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { API_CONTRACT_KEY, type ApiContractOptions } from "../api/decorators/api-contract.decorator.js";
import { NO_ENVELOPE_KEY } from "../api/decorators/no-envelope.decorator.js";

// STORY-023 T3 — ADR-0002 says `contracts:generate` "must either boot the
// Nest container or walk route metadata via DiscoveryService". Empirically
// verified (see the T3 dispatch's own investigation notes) that the FIRST
// option is not viable for a `tsx <file>.ts` CLI entry point in this repo:
// tsx's esbuild-based transform does not implement TypeScript's
// `emitDecoratorMetadata` (confirmed directly against
// node_modules/esbuild — `z.toJSONSchema`-style probing shows NO
// `design:paramtypes` call is ever emitted, under any `target`), so a
// constructor parameter typed only by its class (e.g. AuthGuard's
// `reflector: Reflector`, with no `@Inject()`) resolves to `undefined` and
// Nest's injector throws `UndefinedDependencyException` the moment ApiModule
// is compiled — before a single route is even walked. Vitest does not hit
// this (a different, Rolldown/oxc-based transform), which is why the
// existing test-only discoverRealRoutes() (test/support/discover-contract-
// routes.ts, run only under vitest) can safely boot the real ApiModule and
// this file cannot.
//
// This module takes the SECOND option instead, without booting anything:
// `@Controller()`/`@Get()`/`@Post()`/etc. and `@ApiContract()` are all plain
// `Reflect.defineMetadata()` calls attached to a class/method at CLASS-
// DEFINITION time (i.e. the moment the module is imported), never at
// INSTANTIATION time — so importing every `*.controller.ts` file directly
// (no DI, no `new`, no constructor ever runs) and reading their metadata
// straight off the prototype gets the exact same live, decorator-sourced
// truth ADR-0002 requires, without needing `design:paramtypes` for a single
// constructor parameter anywhere in the graph.
//
// Every controller lives at `src/modules/<area>/*.controller.ts`
// (project-structure.md §2's module layout, coding-standards.md §1) — this
// walks that whole subtree so a future story's new controller is picked up
// automatically, the same "never a hand-maintained list" property
// DiscoveryService's own walk has.
//
// @nestjs/common's PATH_METADATA/METHOD_METADATA/HTTP_CODE_METADATA
// constants are not exported from "@nestjs/common"'s public entry point
// (verified empirically, same NodeNext + no-"exports"-field constraint
// documented in test/support/discover-contract-routes.ts) — reproduced here
// as the literal string values @nestjs/common 11.2.1's constants.ts defines
// (`PATH_METADATA = "path"`, `METHOD_METADATA = "method"`,
// `HTTP_CODE_METADATA = "__httpCode__"`).
const NEST_PATH_METADATA_KEY = "path";
const NEST_METHOD_METADATA_KEY = "method";
const NEST_HTTP_CODE_METADATA_KEY = "__httpCode__";

// @nestjs/common's RequestMethod enum (11.2.1) — only the values this
// codebase's routes actually use are named; anything else is left
// unresolved (undefined) rather than guessed at.
const HTTP_METHOD_NAMES_BY_ENUM_VALUE: Record<number, string> = {
  0: "get",
  1: "post",
  2: "put",
  3: "delete",
  4: "patch",
  6: "options",
  7: "head",
};

export interface DiscoveredContractRoute {
  readonly controllerName: string;
  readonly methodName: string;
  readonly httpMethod: string;
  /** Nest-style, e.g. "workspaces/:id" — no leading slash, no /v1 prefix. */
  readonly fullPath: string;
  readonly httpStatus: number;
  readonly contract: ApiContractOptions | undefined;
  /**
   * STORY-024 T11 — whether `@NoEnvelope()` exempts this route from the
   * response envelope, read method-then-class exactly as
   * ResponseEnvelopeInterceptor reads it (HealthController carries it at
   * class level to mark all three probes as a group). The generator needs
   * it because the envelope changes the RESPONSE BODY, and a document that
   * describes the unwrapped body describes something the server never sends.
   */
  readonly envelopeExempt: boolean;
}

function normalizeSegment(segment: string | undefined): string {
  if (!segment) return "";
  return segment.replace(/^\/+/, "").replace(/\/+$/, "");
}

function joinPath(classPath: string, methodPath: string): string {
  return [normalizeSegment(classPath), normalizeSegment(methodPath)].filter(Boolean).join("/");
}

function defaultStatusFor(httpMethod: string): number {
  return httpMethod === "post" ? 201 : 200;
}

function isControllerClass(value: unknown): value is new (...args: never[]) => unknown {
  return typeof value === "function" && Reflect.getMetadata(NEST_PATH_METADATA_KEY, value) !== undefined;
}

/**
 * Every `*.controller.ts` file under `src/modules`, relative to THIS file
 * (so it works identically whether invoked via `tsx` or imported by a
 * vitest-run spec).
 */
function findControllerFiles(): string[] {
  const modulesDir = fileURLToPath(new URL("../modules", import.meta.url));
  const entries = readdirSync(modulesDir, { recursive: true }) as string[];
  // Sorted — readdirSync's own ordering is filesystem-dependent, and this
  // list drives the generated document's path insertion order. An
  // unsorted walk would make `contracts/openapi.generated.json` re-diff
  // itself on every regeneration for no schema-related reason at all.
  return entries
    .filter((entry) => entry.endsWith(".controller.ts"))
    .sort()
    .map((entry) => resolve(modulesDir, entry));
}

/**
 * Walks every controller in the tree (no Nest boot — see this file's header
 * comment) and returns every HTTP route handler it finds, decorated or not.
 * Callers filter/compare against `@ApiContract()` metadata themselves, the
 * same shape test/support/discover-contract-routes.ts's discoverRealRoutes()
 * already establishes for the vitest-run half of this suite.
 */
export async function discoverContractRoutes(): Promise<DiscoveredContractRoute[]> {
  const routes: DiscoveredContractRoute[] = [];

  for (const absolutePath of findControllerFiles()) {
    const module = (await import(pathToFileURL(absolutePath).href)) as Record<string, unknown>;

    for (const [controllerName, exported] of Object.entries(module)) {
      if (!isControllerClass(exported)) continue;
      const classPath = (Reflect.getMetadata(NEST_PATH_METADATA_KEY, exported) as string | undefined) ?? "";
      const prototype = exported.prototype as Record<string, unknown>;

      for (const methodName of Object.getOwnPropertyNames(prototype)) {
        if (methodName === "constructor") continue;
        const handler = prototype[methodName] as ((...args: unknown[]) => unknown) | undefined;
        if (typeof handler !== "function") continue;

        const methodPathMeta = Reflect.getMetadata(NEST_PATH_METADATA_KEY, handler) as
          | string
          | string[]
          | undefined;
        if (methodPathMeta === undefined) continue; // not an HTTP route handler

        const methodEnumValue = Reflect.getMetadata(NEST_METHOD_METADATA_KEY, handler) as number | undefined;
        const httpMethod = HTTP_METHOD_NAMES_BY_ENUM_VALUE[methodEnumValue ?? 0] ?? "get";
        const explicitStatus = Reflect.getMetadata(NEST_HTTP_CODE_METADATA_KEY, handler) as number | undefined;

        routes.push({
          controllerName,
          methodName,
          httpMethod,
          fullPath: joinPath(classPath, Array.isArray(methodPathMeta) ? (methodPathMeta[0] ?? "") : methodPathMeta),
          httpStatus: explicitStatus ?? defaultStatusFor(httpMethod),
          contract: Reflect.getMetadata(API_CONTRACT_KEY, handler) as ApiContractOptions | undefined,
          envelopeExempt:
            (Reflect.getMetadata(NO_ENVELOPE_KEY, handler) as boolean | undefined) === true ||
            (Reflect.getMetadata(NO_ENVELOPE_KEY, exported) as boolean | undefined) === true,
        });
      }
    }
  }

  return routes;
}
