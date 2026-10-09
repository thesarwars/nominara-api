import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";

// NEW-D-2 / STORY-075 AC2 — signature verification needs the BYTES Stripe
// signed, and Fastify's JSON parser throws them away. The footgun the story
// names is the usual fix: enabling raw-body capture (or replacing the JSON
// parser) for the whole app, which changes parsing, limits and validation for
// every route. This does neither.
//
// ⚠ HOW IT IS SCOPED. A route opts in with `@RouteConfig({ rawBody: true })`
// (Nest's own decorator for Fastify route config). A `preParsing` hook — which
// runs BEFORE the content-type parser and can only observe the stream — buffers
// the payload for opted-in routes only, stashes the Buffer on the request, and
// hands the parser a fresh stream of the same bytes. The JSON parser is
// untouched, so the parsed body is what it always was and every other route's
// request handling is byte-for-byte what it was before this file existed.
//
// ⚠ NOT AN ENCAPSULATED CONTENT-TYPE PARSER, AND WHY. The story's wording
// reaches for Fastify encapsulation, but Nest registers every controller on the
// ROOT instance; a child scope's parser would apply to no Nest route at all.
// Replacing the root `application/json` parser to read route config would be
// the global change this exists to avoid. The route-config-gated hook is the
// narrowest mechanism a Nest controller route can use, and
// stripe-webhook.http.spec.ts asserts the property that matters: another JSON
// route still receives parsed JSON, still rejects an unknown field, and never
// gets a `rawBody`.

/** Stripe events are a few KB. Bounded so an unauthenticated caller cannot make us buffer more. */
export const RAW_BODY_LIMIT_BYTES = 1024 * 1024;

export interface RawBodyRequest extends FastifyRequest {
  rawBody?: Buffer;
}

export function registerRawBodyCapture(fastify: FastifyInstance): void {
  fastify.addHook("preParsing", async (request: RawBodyRequest, _reply, payload) => {
    const config = request.routeOptions?.config as { rawBody?: unknown } | undefined;
    if (config?.rawBody !== true) return payload;

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of payload as AsyncIterable<Buffer | string>) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > RAW_BODY_LIMIT_BYTES) {
        throw Object.assign(new Error("request body is too large"), { statusCode: 413 });
      }
      chunks.push(buffer);
    }
    const raw = Buffer.concat(chunks);
    request.rawBody = raw;
    return Readable.from([raw]);
  });
}
