import "reflect-metadata";
import { DiscoveryModule, DiscoveryService, MetadataScanner } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { ApiModule } from "../../src/api/api.module.js";
import { API_CONTRACT_KEY, type ApiContractOptions } from "../../src/api/decorators/api-contract.decorator.js";
import { HealthController } from "../../src/modules/health/health.controller.js";

// STORY-023 T2 (RED step) — shared by every file that needs "the set of
// real, non-exempt HTTP routes this build actually registers, and whatever
// @ApiContract() metadata (if any) each one carries". Walks the REAL,
// deployed ApiModule's router the same way Nest's own RouterExplorer/
// PathsExplorer do (DiscoveryService.getControllers() +
// MetadataScanner.getAllMethodNames(), reading PATH_METADATA off the
// PROTOTYPE method — verified against node_modules/@nestjs/core's own
// router/paths-explorer.js before writing this file) — never a stand-in
// list of routes that could itself go stale, and never re-implemented
// slightly differently per spec file. A coverage gate's OWN discovery
// logic drifting from itself across files is exactly the failure class
// this module exists to close off.
//
// @nestjs/common's PATH_METADATA constant ("path") is not exported from
// "@nestjs/common"'s public entry point, and the "@nestjs/common/constants"
// subpath does NOT resolve under this project's NodeNext + no-"exports"-
// field tsconfig (verified empirically: `tsc --noEmit` reports TS2307
// against that subpath). Reproduced here as the literal string value Nest's
// own PathsExplorer/RouterExplorer read (@nestjs/common 11.2.1's
// constants.ts: `PATH_METADATA = "path"`).
const NEST_PATH_METADATA_KEY = "path";

// A class constructor reference — spelled out rather than the banned
// `Function` type (@typescript-eslint/no-unsafe-function-type).
export type ClassConstructor = abstract new (...args: never[]) => unknown;

export interface DiscoveredRoute {
  readonly controllerName: string;
  readonly controllerClass: ClassConstructor;
  readonly methodName: string;
  readonly handler: (...args: unknown[]) => unknown;
  readonly fullPath: string;
  /**
   * `@ApiContract()`'s metadata, read from the METHOD ONLY —
   * `Reflect.getMetadata(API_CONTRACT_KEY, handler)`, never falling back to
   * the controller class. `ApiContract` is typed as a `MethodDecorator`
   * only (src/api/decorators/api-contract.decorator.ts), but this reads it
   * defensively regardless of that type-level restriction: a coverage gate
   * whose correctness depends on a decorator's TYPE signature alone, rather
   * than on where its own walk actually looks for metadata, is one
   * refactor away from a single class-level decoration silently covering
   * every method on that controller again (`Reflector.getAllAndOverride`
   * with `[handler, controllerClass]` targets falls back to the class and
   * would not catch that regression).
   */
  readonly contract: ApiContractOptions | undefined;
}

function normalizeSegment(segment: string | undefined): string {
  if (!segment) return "";
  return segment.replace(/^\/+/, "").replace(/\/+$/, "");
}

function joinPath(classPath: string, methodPath: string): string {
  return [normalizeSegment(classPath), normalizeSegment(methodPath)].filter(Boolean).join("/");
}

async function walkRoutes(discovery: DiscoveryService, scanner: MetadataScanner): Promise<DiscoveredRoute[]> {
  const routes: DiscoveredRoute[] = [];
  for (const wrapper of discovery.getControllers()) {
    const instance = wrapper.instance as Record<string, unknown> | undefined;
    if (!instance) continue;
    const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;
    const controllerClass = (instance as { constructor: ClassConstructor }).constructor;
    const classPath = (Reflect.getMetadata(NEST_PATH_METADATA_KEY, controllerClass) as string | undefined) ?? "";

    for (const methodName of scanner.getAllMethodNames(prototype)) {
      const prototypeHandler = prototype[methodName] as ((...args: unknown[]) => unknown) | undefined;
      if (typeof prototypeHandler !== "function") continue;
      const methodPath = Reflect.getMetadata(NEST_PATH_METADATA_KEY, prototypeHandler) as
        | string
        | string[]
        | undefined;
      if (methodPath === undefined) continue; // not an HTTP route handler (e.g. a private helper method)

      routes.push({
        controllerName: controllerClass.name,
        controllerClass,
        methodName,
        handler: prototypeHandler,
        fullPath: joinPath(classPath, Array.isArray(methodPath) ? (methodPath[0] ?? "") : methodPath),
        contract: Reflect.getMetadata(API_CONTRACT_KEY, prototypeHandler) as ApiContractOptions | undefined,
      });
    }
  }
  return routes;
}

/**
 * Excludes ONLY the health probes and the /v1/openapi.json route itself.
 * MUST NOT be keyed on `@Public()` — five contract-bearing identity/OAuth
 * routes are `@Public()` too (identity.controller.ts:30,38,49;
 * oauth.controller.ts:34,57), backed by 14 zod contract files under
 * contracts/identity/ and listed in api-specification.md §3's endpoint
 * registry. An `@Public()`-keyed exemption would let any of them lose
 * `@ApiContract()` and silently vanish from openapi.generated.json and
 * `@nominara/client` with every gate green.
 *
 * Keying note: the execution plan describes the probe exemption as "keyed
 * on `@NoEnvelope()` / HealthController". `@NoEnvelope()` does not exist
 * yet — it is task T10 (STORY-024), a later dispatch. This predicate is
 * keyed on `HealthController` for now; when `@NoEnvelope()` lands, this
 * predicate (and whatever `contracts:generate`/`contracts:check` use)
 * should move to it instead.
 */
export function isExemptFromContractCoverage(route: Pick<DiscoveredRoute, "controllerClass" | "fullPath">): boolean {
  if (route.controllerClass === HealthController) return true;
  if (route.fullPath === "openapi.json" || route.fullPath === "v1/openapi.json") return true;
  return false;
}

/**
 * Boots the real, deployed ApiModule and walks its router. Callers MUST
 * have already applied the fake env (test/support/fake-env.ts's
 * `applyFakeApiEnv()`) before calling this — ApiModule's providers need it
 * to construct.
 */
export async function discoverRealRoutes(): Promise<DiscoveredRoute[]> {
  const moduleRef = await Test.createTestingModule({ imports: [ApiModule, DiscoveryModule] }).compile();
  const discovery = moduleRef.get(DiscoveryService);
  const scanner = moduleRef.get(MetadataScanner);
  return walkRoutes(discovery, scanner);
}
