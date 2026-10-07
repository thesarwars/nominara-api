import { RequestMethod } from "@nestjs/common";
import type { FastifyInstance } from "fastify";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { registerCookiePlugin } from "./register-cookies.js";
import { registerRawBodyCapture } from "./stripe-raw-body.js";
import { registerApiReference, registerOpenApiRoute } from "./register-openapi.js";
import { loadEnv } from "../config/env.js";

// STORY-023 (EPIC-03 execution plan, decision D1) — the single seam for
// everything `bootstrap()` needs an app instance configured with, shared by
// every test that assembles its own NestFastifyApplication instead of
// calling bootstrap(). Without this seam the global prefix and the cookie
// plugin would each need re-deriving at every app-assembly site, which is
// exactly the drift this epic exists to close (see the execution plan's "Why
// apiUrl() alone cannot deliver D1").
//
// `exclude` must stay a `(string | RouteInfo)[]` — Nest's setGlobalPrefix
// does NOT accept a RegExp there (`exclude: [/^health/]` silently excludes
// nothing), which would move the health probes to /v1/health/* and break
// the orchestrator's unversioned readiness contract.
export const API_VERSION_PREFIX = "v1";

export async function configureApp(app: NestFastifyApplication): Promise<void> {
  app.setGlobalPrefix(API_VERSION_PREFIX, {
    exclude: [
      { path: "health", method: RequestMethod.ALL },
      { path: "health/live", method: RequestMethod.GET },
      { path: "health/ready", method: RequestMethod.GET },
    ],
  });
  await registerCookiePlugin(app);
  // NEW-D-2 — raw bytes for routes that opt in with @RouteConfig({ rawBody: true }) and for no other route.
  registerRawBodyCapture(app.getHttpAdapter().getInstance() as unknown as FastifyInstance);
  registerOpenApiRoute(app);
  // The browsable reference over the SAME committed document — development
  // only. `/v1/openapi.json` above is public in every environment; this adds
  // discoverability rather than access, and production has no requirement for
  // it. Decided here, at the composition root, so a route's existence is
  // visible where the app is assembled.
  await registerApiReference(app, loadEnv().NODE_ENV !== "production");

  // app.enableShutdownHooks() deliberately stays out of this function: it is
  // a process-lifecycle concern (SIGTERM/SIGINT -> Nest's onModuleDestroy
  // etc.), owned by bootstrap() alone. Calling it here would register
  // duplicate process signal handlers across the 12 test apps that also
  // call configureApp().
}
