import { Logger, type CallHandler, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { of, lastValueFrom } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envelopeMetaSchema } from "../../../contracts/common/envelope.schema.js";
import { NoEnvelope } from "../decorators/no-envelope.decorator.js";
import { Page } from "../pagination/page.js";
import { SCORING_VERSION } from "../../lib/scoring/index.js";
import { ResponseEnvelopeInterceptor } from "./response-envelope.interceptor.js";

// STORY-024 T10 — coding-standards.md §7: "Every story adds at least one
// metric and one log line, and both are verified, not assumed."
//
// Verified HERE rather than by grepping a test run's output, because vitest
// suppresses stdout for passing tests — a log line "confirmed" by eyeballing
// a green run is confirmed by nothing at all. Both the counter (via
// metrics.ts's own Logger) and the interceptor's log line go through
// Logger.prototype.log, so one spy sees both.
class Wrapped {}
class Exempt {
  static marked = false;
}
NoEnvelope()(Exempt);

function contextFor(controller: object, workspaceId: string | null, headers: Record<string, string> = {}) {
  const header = vi.fn();
  const request = { id: "req-1", headers, auth: workspaceId === null ? undefined : { ws: workspaceId } };
  return {
    context: {
      getHandler: () => function handler() {},
      getClass: () => controller,
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ header }) }),
    } as unknown as ExecutionContext,
    header,
  };
}

const handlerReturning = (value: unknown): CallHandler => ({ handle: () => of(value) });

describe("STORY-024 · ResponseEnvelopeInterceptor", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  const logged = (): Record<string, unknown>[] =>
    (logSpy.mock.calls as unknown[][]).map((call) => call[0] as Record<string, unknown>);

  it("wraps a resource in §1's envelope with a valid meta", async () => {
    const { context } = contextFor(Wrapped, "11111111-1111-4111-8111-111111111111");
    const result = (await lastValueFrom(
      new ResponseEnvelopeInterceptor(new Reflector()).intercept(context, handlerReturning({ id: "abc" })),
    )) as { data: unknown; meta: unknown };

    expect(result.data).toEqual({ id: "abc" });
    expect(envelopeMetaSchema.safeParse(result.meta).success).toBe(true);
    expect((result.meta as { scoring_version: string }).scoring_version).toBe(SCORING_VERSION);
  });

  it("a void handler still carries the identifier — data is explicitly null, never a missing member", async () => {
    const { context } = contextFor(Wrapped, null);
    const result = (await lastValueFrom(
      new ResponseEnvelopeInterceptor(new Reflector()).intercept(context, handlerReturning(undefined)),
    )) as Record<string, unknown>;

    expect(result).toHaveProperty("data", null);
    expect(result).toHaveProperty("meta");
  });

  it("leaves an exempt controller's body untouched", async () => {
    const { context } = contextFor(Exempt, null);
    const result = await lastValueFrom(
      new ResponseEnvelopeInterceptor(new Reflector()).intercept(context, handlerReturning({ status: "ok" })),
    );

    expect(result, "a probe body must reach the orchestrator unwrapped").toEqual({ status: "ok" });
  });

  // STORY-024 owner decision 2026-10-13 #2 — an inbound X-Request-Id never becomes the identity.
  it("echoes the 32-hex trace id on the response and ignores an inbound X-Request-Id", async () => {
    const { context, header } = contextFor(Wrapped, null, { "x-request-id": "from-caller" });
    await lastValueFrom(new ResponseEnvelopeInterceptor(new Reflector()).intercept(context, handlerReturning({})));

    expect(header).toHaveBeenCalledWith("x-request-id", expect.stringMatching(/^[0-9a-f]{32}$/));
    expect(header).not.toHaveBeenCalledWith("x-request-id", "from-caller");
  });

  it("emits the counter, labelled by whether the body was wrapped", async () => {
    const { context } = contextFor(Wrapped, null);
    await lastValueFrom(new ResponseEnvelopeInterceptor(new Reflector()).intercept(context, handlerReturning({})));

    expect(logged()).toContainEqual(
      expect.objectContaining({ metric: "nominara_api_response_envelope_total", wrapped: "true" }),
    );

    logSpy.mockClear();
    const exempt = contextFor(Exempt, null);
    await lastValueFrom(
      new ResponseEnvelopeInterceptor(new Reflector()).intercept(exempt.context, handlerReturning({})),
    );
    expect(logged()).toContainEqual(
      expect.objectContaining({ metric: "nominara_api_response_envelope_total", wrapped: "false" }),
    );
  });

  // §7: "A log line carries the workspace ID, never the workspace name.
  // Names are customer data; IDs are not."
  it("logs the workspace ID and nothing resembling a name or a body", async () => {
    const workspaceId = "22222222-2222-4222-8222-222222222222";
    const { context } = contextFor(Wrapped, workspaceId);
    await lastValueFrom(
      new ResponseEnvelopeInterceptor(new Reflector()).intercept(
        context,
        handlerReturning({ id: "abc", name: "Acme Corporation", secret: "s3cret" }),
      ),
    );

    const line = logged().find((entry: Record<string, unknown>) => entry.message === "response enveloped");
    expect(line, "the story's one log line must be emitted").toBeDefined();
    expect(line).toEqual({
      message: "response enveloped",
      request_id: expect.stringMatching(/^[0-9a-f]{32}$/),
      workspace_id: workspaceId,
    });

    const serialized = JSON.stringify(logged());
    expect(serialized, "a workspace NAME must never reach a log line").not.toContain("Acme Corporation");
    expect(serialized, "no response body content belongs in a log line").not.toContain("s3cret");
  });

  // STORY-117 — the `pagination` member. Declared in the envelope since
  // STORY-023 and populated by nothing until now, which is how four list
  // endpoints shipped unbounded arrays while the published contract described
  // the shape that would have satisfied NFR-API-03.
  describe("a Page becomes the pagination member", () => {
    const pagination = { cursor_next: "eyJ2IjoxLCJrIjpbMV19", has_more: true, limit: 50 };

    it("splits a Page into data and pagination, and does not nest it under data", async () => {
      const interceptor = new ResponseEnvelopeInterceptor(new Reflector());
      const { context } = contextFor(Wrapped, "ws-1");
      const body = (await lastValueFrom(
        interceptor.intercept(context, handlerReturning(new Page([{ id: "a" }], pagination))),
      )) as Record<string, unknown>;

      expect(body.data).toEqual([{ id: "a" }]);
      expect(body.pagination).toEqual(pagination);
      expect(envelopeMetaSchema.safeParse(body.meta).success).toBe(true);
    });

    // STORY-134 — the prompt list's `data` is `{ prompts, summary }`, not its rows, yet its paging still belongs in
    // the envelope's `pagination` like every other list.
    it("[STORY-134] a Page carrying its own data body keeps pagination at the top level and uses that body as data", async () => {
      const interceptor = new ResponseEnvelopeInterceptor(new Reflector());
      const { context } = contextFor(Wrapped, "ws-1");
      const data = { prompts: [{ id: "a" }], summary: { active: 1 } };
      const body = (await lastValueFrom(
        interceptor.intercept(context, handlerReturning(new Page([{ id: "a" }], pagination, data))),
      )) as Record<string, unknown>;

      expect(body.data).toEqual(data);
      expect(body.pagination).toEqual(pagination);
    });

    it("omits pagination entirely for a single resource — never an empty or null placeholder", async () => {
      const interceptor = new ResponseEnvelopeInterceptor(new Reflector());
      const { context } = contextFor(Wrapped, "ws-1");
      const body = (await lastValueFrom(
        interceptor.intercept(context, handlerReturning({ id: "a" })),
      )) as Record<string, unknown>;

      expect(body).not.toHaveProperty("pagination");
      expect(body.data).toEqual({ id: "a" });
    });

    // A plain object carrying the same two fields must NOT be mistaken for a
    // page: that would silently reshape any resource that happened to have an
    // `items` and a `pagination` property.
    it("treats a look-alike object as ordinary data", async () => {
      const interceptor = new ResponseEnvelopeInterceptor(new Reflector());
      const { context } = contextFor(Wrapped, "ws-1");
      const lookalike = { items: [{ id: "a" }], pagination };
      const body = (await lastValueFrom(
        interceptor.intercept(context, handlerReturning(lookalike)),
      )) as Record<string, unknown>;

      expect(body.data).toEqual(lookalike);
      expect(body).not.toHaveProperty("pagination");
    });
  });
});
