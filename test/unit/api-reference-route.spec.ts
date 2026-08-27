import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it } from "vitest";
import { apiReferencePath, registerApiReference } from "../../src/api/register-openapi.js";
import { fastifyServerOptions } from "../../src/api/fastify-options.js";
import { applyFakeApiEnv } from "../support/fake-env.js";

// STORY-023 AC8's companion — the browsable reference, and specifically that
// it is NOT served in production.
//
// `/v1/openapi.json` is public in every environment (it is registered on the
// raw Fastify instance, below the guard chain), so this route adds no secret.
// What it adds is discoverability: a browsable index of every endpoint,
// request shape and error code. That is the point in development and an
// invitation in production.
//
// Asserted in BOTH directions on purpose. A test that only checked
// development would pass just as happily against a route registered
// unconditionally — which is the whole failure mode, and the shape of gate
// this repository keeps finding.
describe("STORY-023 · the API reference UI is development-only", () => {
  let app: NestFastifyApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function appWithReference(enabled: boolean): Promise<NestFastifyApplication> {
    applyFakeApiEnv();
    const moduleRef = await Test.createTestingModule({}).compile();
    const created = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(fastifyServerOptions()));
    await registerApiReference(created, enabled);
    await created.init();
    await created.getHttpAdapter().getInstance().ready();
    return created;
  }

  it("serves a browsable page when enabled", async () => {
    app = await appWithReference(true);

    // The plugin mounts the page at the prefix WITH a trailing slash and
    // redirects the bare path to it — asserted rather than worked around, so
    // the URL a person actually types is covered.
    const redirect = await app.inject({ method: "GET", url: apiReferencePath() });
    expect(redirect.statusCode).toBe(301);

    const response = await app.inject({ method: "GET", url: `${apiReferencePath()}/` });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    // It must point at the COMMITTED document route, not carry its own copy —
    // a page rendering an inlined spec could drift from the artifact
    // contracts:check gates and the client is generated from.
    expect(response.body).toContain("/v1/openapi.json");
  });

  it("serves nothing at all when disabled", async () => {
    app = await appWithReference(false);

    const response = await app.inject({ method: "GET", url: apiReferencePath() });
    expect(response.statusCode, "the reference must not exist in production").toBe(404);
  });

  // Every real route lives under `/v1`, so the bare host answered a
  // problem+json 404 — correct for an API client, and indistinguishable from
  // a broken deployment for a person who typed the host into a browser.
  //
  // The status is pinned to 302 exactly, not merely "a redirect". 301 is
  // cached by the browser against the ORIGIN, so a developer who hit
  // localhost:4000 once would keep being redirected by any later service
  // sharing that host and port, long after the docs stopped existing there.
  //
  // A second test asserting `not.toBe(301)` used to sit below this one. It
  // was removed rather than kept: mutating the code to 301 makes Fastify
  // answer 500, so `not.toBe(301)` passed against the broken redirect and
  // could not fail for the reason it claimed. `toBe(302)` catches both.
  it("sends the bare root to the reference when enabled", async () => {
    app = await appWithReference(true);

    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(apiReferencePath());
  });

  // The redirect and its target are one fact. A redirect that outlived the
  // page would send the root to a 404 in production — worse than the 404 it
  // replaced, because it reads as a misconfiguration rather than an absent
  // route.
  it("leaves the root alone when the reference is disabled", async () => {
    app = await appWithReference(false);

    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode, "the redirect must not outlive the page it points at").toBe(404);
  });
});
