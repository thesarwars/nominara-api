import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { REALTIME_EVENT_PAYLOADS } from "../../contracts/events/catalog.schema.js";
import { realtimeEventNameSchema } from "../../contracts/events/event-name.schema.js";
import { generateClient, generateOpenApiDocument } from "../../src/contracts/generate.js";
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
