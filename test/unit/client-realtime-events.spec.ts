import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { REALTIME_EVENT_PAYLOADS } from "../../contracts/events/catalog.schema.js";
import { realtimeEventNameSchema } from "../../contracts/events/event-name.schema.js";
import {
  generateClient,
  generateOpenApiDocument,
  realtimeEventComponentName,
} from "../../src/contracts/generate.js";
import { applyFakeApiEnv } from "../support/fake-env.js";

// STORY-026 T24 — STORY-023 AC5 lists four things the published client must
// carry: request/response types, a fetch client, an error-code union, and
// REALTIME EVENT TYPES. The fourth shipped as an acknowledged absence, because
// there was no event catalog to render from until STORY-026 T19.
//
// Generated into a temp directory rather than asserted against the committed
// `client/src`, so this checks the GENERATOR. A test reading the committed
// output would pass on a stale file that nobody had regenerated — which is the
// same class of defect as a drift check that compares a document to itself.

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

let outDir: string;
let events: string;

beforeAll(async () => {
  applyFakeApiEnv();
  outDir = mkdtempSync(join(tmpdir(), "nominara-client-"));
  await generateClient(await generateOpenApiDocument(), outDir);
  events = readFileSync(join(outDir, "events.ts"), "utf8");
});

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe("STORY-026 · the published client carries §11's event catalog", () => {
  it("emits an events module at all", () => {
    expect(events.length).toBeGreaterThan(0);
  });

  it("lists every event, and only those", () => {
    for (const name of realtimeEventNameSchema.options) {
      expect(events, `${name} is missing from the published client`).toContain(`"${name}"`);
    }
  });

  it("carries a payload schema for every event, not just the names", () => {
    // A name union alone lets a consumer switch on the event and then guess at
    // the payload — which is the state the frontend would have been left in.
    for (const name of realtimeEventNameSchema.options) {
      const index = events.indexOf(`"${name}":`);
      expect(index, `${name} has no payload schema`).toBeGreaterThan(-1);
    }
  });

  it("exports the events module from the package index", () => {
    const index = readFileSync(join(outDir, "index.ts"), "utf8");
    expect(index).toContain("./events.js");
    expect(index).toContain("REALTIME_EVENT_SCHEMAS");
  });

  it("emits payload schemas a consumer can validate a socket frame against", () => {
    // A socket frame carries no status code, so a client that cannot validate
    // it has no way to tell a malformed message from a new one. That is why
    // schemas ship, not only types.
    expect(events).toContain('"additionalProperties": false');
  });

  it("keeps member.changed's shape — the event the gateway acts on", () => {
    const parsed = REALTIME_EVENT_PAYLOADS["member.changed"].safeParse({
      workspace_id: "0192f1a0-0000-7000-8000-00000000000a",
      user_id: "0192f1a0-0000-7000-8000-00000000000b",
      role: "analyst",
      status: "removed",
    });
    expect(parsed.success).toBe(true);
    expect(events).toContain('"member.changed"');
  });

  it("is deterministic — two runs of the generator produce byte-identical output", async () => {
    // The property that actually holds. An earlier version of this test
    // compared against the committed `client/src/events.ts`, which is
    // GITIGNORED: a build artifact, absent from a fresh clone, so the
    // comparison proved nothing durable and would have failed for anyone who
    // had not run the generator first.
    //
    // Determinism is what the drift gate needs from this generator, and it is
    // checkable without depending on anything that is not in the repository.
    const second = mkdtempSync(join(tmpdir(), "nominara-client-2-"));
    try {
      await generateClient(await generateOpenApiDocument(), second);
      expect(readFileSync(join(second, "events.ts"), "utf8")).toBe(events);
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });
});

// STORY-026 AC5 — "realtime event types", the half that was missing.
//
// The client shipped event NAMES and each payload's JSON Schema as DATA,
// while this generator's own comment claimed the events were "typed per
// event". A consumer could validate a frame at runtime and still had no
// TypeScript type for it, so every handler took `unknown`. The payload
// schemas now live in the document's `components.schemas`, which means the
// same openapi-typescript pass that types every request and response types
// these — one source, no second renderer, no new dependency.
describe("STORY-026 · AC5 — the client carries a TYPE per event, not just a schema", () => {
  const originalEnv = { ...process.env };
  let dir: string | undefined;

  beforeEach(() => {
    applyFakeApiEnv();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("emits a payload type per event, sourced from the document's components", async () => {
    const document = await generateOpenApiDocument();
    dir = mkdtempSync(resolve(REPO_ROOT, "node_modules/.tmp-story026-ac5-"));
    await generateClient(document, dir);

    const events = readFileSync(join(dir, "events.ts"), "utf8");
    expect(events, "the type map itself").toContain("export type RealtimeEventPayloads");

    // Every event, not a sampled few — a map missing one entry is a handler
    // silently typed `any` at exactly the call site that needed it.
    const missing = realtimeEventNameSchema.options.filter(
      (name) => !events.includes(`"${name}": components["schemas"]`),
    );
    expect(missing, `events with no payload type: ${JSON.stringify(missing)}`).toEqual([]);
  });

  // The discriminating half. A type map pointing at components that do not
  // exist compiles to `any` under a loose config and would pass the check
  // above while typing nothing.
  it("the components those types point at are really in the document, with real fields", async () => {
    const document = (await generateOpenApiDocument()) as unknown as {
      components?: { schemas?: Record<string, { type?: string; properties?: Record<string, unknown> }> };
    };
    const schemas = document.components?.schemas ?? {};

    for (const name of realtimeEventNameSchema.options) {
      const schema = schemas[realtimeEventComponentName(name)];
      expect(schema, `${name} has no component schema`).toBeDefined();
      expect(schema!.type, `${name}'s component is not an object`).toBe("object");
      expect(
        Object.keys(schema!.properties ?? {}).length,
        `${name}'s component has no properties — an empty type is not a type`,
      ).toBeGreaterThan(0);
    }
  });
});
