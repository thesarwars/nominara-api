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
