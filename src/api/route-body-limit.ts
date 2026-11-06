import type { FastifyInstance } from "fastify";

// A route that must accept a larger body than Fastify's 1 MiB default (an image upload sent as base64) declares it with
// `@RouteConfig({ bodyLimit: <bytes> })`. This hook copies that number onto the route's own `bodyLimit`, which is where Fastify
// enforces it (413 before the body is parsed). It is a no-op for every route that does not declare one: the global default,
// and every other route's parsing and limits, are exactly what they were. Must be registered before the routes are.
export function registerRouteBodyLimits(fastify: FastifyInstance): void {
  fastify.addHook("onRoute", (route) => {
    const limit = (route.config as { bodyLimit?: unknown } | undefined)?.bodyLimit;
    if (typeof limit === "number" && Number.isInteger(limit) && limit > 0) route.bodyLimit = limit;
  });
}
