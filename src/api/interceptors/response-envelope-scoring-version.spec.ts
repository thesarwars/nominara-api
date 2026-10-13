import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { lastValueFrom, of } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResponseEnvelopeInterceptor } from "./response-envelope.interceptor.js";

// STORY-136 AC9 — `meta.scoring_version` is the SCORING LIBRARY's version, not a second constant that happens to
// equal it today. The library is mocked to a version the envelope has never heard of: a literal in the interceptor
// cannot pass this, and a bump of the library's constant moves the envelope with it.
vi.mock("../../lib/scoring/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/scoring/index.js")>()),
  SCORING_VERSION: "v-from-the-scoring-library",
}));

describe("STORY-136 AC9 · the envelope's scoring_version comes from the scoring library", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  });
  afterEach(() => logSpy.mockRestore());

  it("[AC9] echoes the library's SCORING_VERSION in meta", async () => {
    class Wrapped {}
    const context = {
      getHandler: () => function handler() {},
      getClass: () => Wrapped,
      switchToHttp: () => ({
        getRequest: () => ({ id: "req-1", headers: {}, auth: undefined }),
        getResponse: () => ({ header: vi.fn() }),
      }),
    } as unknown as ExecutionContext;
    const next: CallHandler = { handle: () => of({ id: "abc" }) };

    const result = (await lastValueFrom(new ResponseEnvelopeInterceptor(new Reflector()).intercept(context, next))) as {
      meta: { scoring_version: string };
    };

    expect(result.meta.scoring_version).toBe("v-from-the-scoring-library");
  });
});
