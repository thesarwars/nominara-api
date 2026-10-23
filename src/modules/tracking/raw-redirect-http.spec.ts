import "reflect-metadata";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResponseEnvelopeInterceptor } from "../../api/interceptors/response-envelope.interceptor.js";
import { NotFoundError, RetentionExceededError } from "../../api/errors/domain-errors.js";
import { RawDownloadService } from "./raw-download.service.js";
import { ResultDocumentService } from "./result-document.service.js";
import { ResultsController } from "./results.controller.js";

// STORY-181 AC4 - what actually crosses the wire for `GET /results/{id}/raw`. The service-level specs prove the URL is minted; this
// proves the HTTP shape the client's proxy depends on: a real 302 with a Location header (not a 200 {url}), never cached, and the
// ordinary envelope (data null) that api-specification.md section 1 puts on every response but the health probes'.

const SIGNED = "http://localhost:4566/nominara-raw/dev/ws/2026/10/id.json.gz?X-Amz-Expires=60&X-Amz-Signature=abc";

describe("STORY-181 AC4 · GET /results/{id}/raw on the wire", () => {
  let app: NestFastifyApplication;
  let outcome: () => Promise<{ url: string }>;

  beforeEach(async () => {
    outcome = () => Promise.resolve({ url: SIGNED });
    const moduleRef = await Test.createTestingModule({
      controllers: [ResultsController],
      providers: [
        { provide: ResultDocumentService, useValue: {} },
        { provide: RawDownloadService, useValue: { signedUrl: () => outcome() } },
        { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("181-H1 · answers 302 with the signed URL in Location, and nothing in the body points anywhere", async () => {
    const response = await app.inject({ method: "GET", url: "/results/0197a000-0000-7000-8000-0000000000aa/raw" });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(SIGNED);
    expect(response.json()).toMatchObject({ data: null, meta: { request_id: expect.any(String) } });
    expect(response.body).not.toContain("X-Amz-Signature"); // the URL is a credential: it travels in Location only
  });

  it("181-H2 · the redirect is never cached (the URL is a 60-second credential)", async () => {
    const response = await app.inject({ method: "GET", url: "/results/0197a000-0000-7000-8000-0000000000aa/raw" });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("181-H3 · a refusal is not a redirect: 404 and 507 carry no Location", async () => {
    outcome = () => Promise.reject(new NotFoundError({ message: "this capture has no stored raw object" }));
    const missing = await app.inject({ method: "GET", url: "/results/0197a000-0000-7000-8000-0000000000aa/raw" });
    expect(missing.statusCode).not.toBe(302);
    expect(missing.headers.location).toBeUndefined();

    outcome = () => Promise.reject(new RetentionExceededError({ message: "past retention" }));
    const expired = await app.inject({ method: "GET", url: "/results/0197a000-0000-7000-8000-0000000000aa/raw" });
    expect(expired.headers.location).toBeUndefined();
  });
});
