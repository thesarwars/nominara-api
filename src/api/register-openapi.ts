import scalarApiReference from "@scalar/fastify-api-reference";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { loadCommittedOpenApiDocument } from "../contracts/serve.js";
import { API_VERSION_PREFIX } from "./configure-app.js";

// STORY-023 T3 (GREEN step) — AC8: `GET /v1/openapi.json` serves the
// committed specification document. Registered directly on the underlying
// Fastify instance (same seam registerCookiePlugin() uses for
// `@fastify/cookie` — `app.register(...)`/`app.getHttpAdapter()`), never as
// a Nest `@Controller()`: this route must be reachable with NO auth, NO
// tenant context, and NO envelope wrapping, and it must never become
// subject to ApiModule's global `APP_GUARD`/`APP_INTERCEPTOR` chain by
// accident the way a Nest-routed controller method — even one carrying
// `@Public()` — always is. It is also, deliberately, invisible to
// discoverRealRoutes()'s Nest-container walk and to this task's own
// filesystem-based discover-routes.ts (neither ever needs to cover it —
// isExemptFromContractCoverage()'s "openapi.json"/"v1/openapi.json" branch
// exists defensively for exactly this route, in case a future refactor
// ever does move it onto a Nest controller).
export function registerOpenApiRoute(app: NestFastifyApplication): void {
  const instance = app.getHttpAdapter().getInstance();
  instance.get(`/${API_VERSION_PREFIX}/openapi.json`, async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.header("content-type", "application/json; charset=utf-8");
    return loadCommittedOpenApiDocument();
  });
}

/**
 * Where the reference UI is mounted, when it is mounted at all.
 *
 * A FUNCTION, not a `const`. This module and `configure-app.ts` import each
 * other, so a top-level template literal reading `API_VERSION_PREFIX`
 * evaluates inside the cycle and throws `Cannot access 'API_VERSION_PREFIX'
 * before initialization` — at import time, taking the whole process with it.
 * Every other use of the prefix in this file already sits inside a function
 * body, which is why the cycle was harmless until something read it eagerly.
 */
export function apiReferencePath(): `/${string}` {
  // The literal-template return type is what the plugin's `routePrefix`
  // demands; a plain `string` is too wide for it.
  return `/${API_VERSION_PREFIX}/docs`;
}

/**
 * STORY-023 AC8's companion — a browsable reference over the same document.
 *
 * IT READS THE COMMITTED DOCUMENT, not a runtime reconstruction. That is the
 * whole point: the UI renders exactly the artifact `contracts:check` gates and
 * `@nominara/client` is generated from, so it can never show a shape the
 * published contract does not contain. A UI built from live decorators would
 * be a fourth description of the API, free to drift from the other three.
 *
 * NOT REGISTERED IN PRODUCTION. `/v1/openapi.json` is already public — it is
 * registered on the raw Fastify instance, below the guard chain — so this adds
 * no secret. What it adds is discoverability: a browsable index of every
 * endpoint, request shape and error code. In development that is the point; in
 * production it is an invitation, and there is no product requirement for it.
 * The caller decides, and passes `enabled` explicitly rather than this file
 * reading NODE_ENV itself — a route's existence should be visible at the
 * composition root, not buried behind an env read two files down.
 */
export async function registerApiReference(app: NestFastifyApplication, enabled: boolean): Promise<void> {
  if (!enabled) return;
  const instance = app.getHttpAdapter().getInstance();
  await instance.register(scalarApiReference, {
    routePrefix: apiReferencePath(),
    // The URL, not the object: the browser fetches the same route any other
    // consumer would, so what the page renders and what a client downloads
    // cannot diverge.
    configuration: { url: `/${API_VERSION_PREFIX}/openapi.json` },
  });

  // `/` sends a browser to the reference.
  //
  // Every real route lives under `/v1`, so the bare host had no handler and
  // answered a problem+json 404 — correct for an API client and
  // indistinguishable from a broken deployment for a person who typed the
  // host into a browser.
  //
  // REGISTERED HERE, INSIDE THE `enabled` BRANCH, deliberately. The redirect
  // and its target are one fact: a redirect that outlived the page would send
  // the root to a 404 in production, which is worse than the 404 it replaced
  // because it looks like a misconfiguration rather than an absent route.
  // Keeping them in the same branch makes that unrepresentable.
  //
  // 302, never 301. A permanent redirect is cached by the browser against the
  // ORIGIN, so a developer who hit localhost:4000 in development would keep
  // being redirected on any later service sharing that host and port — long
  // after the docs stopped existing there. The root is only temporarily the
  // documentation, and only in development.
  instance.get("/", async (_request: FastifyRequest, reply: FastifyReply) => {
    await reply.redirect(apiReferencePath(), 302);
  });
}
