import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { RAW_BODY_LIMIT_BYTES, registerRawBodyCapture, type RawBodyRequest } from "./stripe-raw-body.js";

// STORY-075 AC2 / scenario 14 — "raw-body parsing scoped to the webhook route
// only". Asserted on a bare Fastify instance carrying exactly the production
// hook, so the property is the hook's and not an accident of the Nest wiring.
// The same property is asserted again through the real ApiModule in
// test/integration/stripe-webhook.spec.ts.

describe("STORY-075 · scenario 14 — raw-body capture is scoped to the route that opts in", () => {
  let app: FastifyInstance;

  async function build(): Promise<{ seen: Record<string, { raw: Buffer | undefined; body: unknown }> }> {
    // Fastify's default Ajv STRIPS unknown keys (removeAdditional); turn that
    // off so the fixture rejects the way the real strict zod pipe does.
    app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
    registerRawBodyCapture(app);
    const seen: Record<string, { raw: Buffer | undefined; body: unknown }> = {};
    app.post("/hook", { config: { rawBody: true } }, (req) => {
      seen.hook = { raw: (req as RawBodyRequest).rawBody, body: req.body };
      return { ok: true };
    });
    app.post("/other", { schema: { body: { type: "object", additionalProperties: false, properties: { a: { type: "number" } } } } }, (req) => {
      seen.other = { raw: (req as RawBodyRequest).rawBody, body: req.body };
      return { ok: true };
    });
    app.post("/flagged-false", { config: { rawBody: false } }, (req) => {
      seen.flagged = { raw: (req as RawBodyRequest).rawBody, body: req.body };
      return { ok: true };
    });
    await app.ready();
    return { seen };
  }

  afterEach(async () => {
    await app.close();
  });

  it("the opted-in route gets the exact bytes AND the parsed JSON", async () => {
    const { seen } = await build();
    // Deliberate whitespace and key order: re-serialising the parsed body would not reproduce these bytes.
    const body = '{ "b":2,   "a":1 }';
    const res = await app.inject({ method: "POST", url: "/hook", headers: { "content-type": "application/json" }, payload: body });
    expect(res.statusCode).toBe(200);
    expect(seen.hook!.raw!.toString("utf8")).toBe(body);
    expect(seen.hook!.body).toEqual({ b: 2, a: 1 });
  });

  it("another JSON route receives parsed JSON and NO raw body", async () => {
    const { seen } = await build();
    const res = await app.inject({ method: "POST", url: "/other", headers: { "content-type": "application/json" }, payload: '{"a":1}' });
    expect(res.statusCode).toBe(200);
    expect(seen.other!.body).toEqual({ a: 1 });
    expect(seen.other!.raw).toBeUndefined();
  });

  it("another JSON route still runs validation — an unknown field is still a 400", async () => {
    const { seen } = await build();
    const res = await app.inject({ method: "POST", url: "/other", headers: { "content-type": "application/json" }, payload: '{"a":1,"x":2}' });
    expect(res.statusCode).toBe(400);
    expect(seen.other).toBeUndefined();
  });

  it("rawBody: false is not an opt-in — only the literal true is", async () => {
    const { seen } = await build();
    await app.inject({ method: "POST", url: "/flagged-false", headers: { "content-type": "application/json" }, payload: "{}" });
    expect(seen.flagged!.raw).toBeUndefined();
  });

  it("the JSON parser is not replaced: malformed JSON on the opted-in route is still a 400", async () => {
    await build();
    const res = await app.inject({ method: "POST", url: "/hook", headers: { "content-type": "application/json" }, payload: "{not json" });
    expect(res.statusCode).toBe(400);
  });

  it("an opted-in body over the limit is refused with 413 rather than buffered", async () => {
    await build();
    const res = await app.inject({
      method: "POST",
      url: "/hook",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ pad: "x".repeat(RAW_BODY_LIMIT_BYTES) }),
    });
    expect(res.statusCode).toBe(413);
  });

  it("an opted-in body exactly at the limit is accepted (boundary)", async () => {
    const { seen } = await build();
    const overhead = Buffer.byteLength(JSON.stringify({ pad: "" }));
    const payload = JSON.stringify({ pad: "x".repeat(RAW_BODY_LIMIT_BYTES - overhead) });
    expect(Buffer.byteLength(payload)).toBe(RAW_BODY_LIMIT_BYTES);
    const res = await app.inject({ method: "POST", url: "/hook", headers: { "content-type": "application/json" }, payload });
    expect(res.statusCode).toBe(200);
    expect(seen.hook!.raw!.length).toBe(RAW_BODY_LIMIT_BYTES);
  });
});
