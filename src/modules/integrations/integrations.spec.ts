import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { PG_POOL } from "../../db/pg-pool.js";
import { QueueProducer } from "../../lib/queue/queue-producer.js";
import { IntegrationsModule } from "./integrations.module.js";
import { IntegrationsController } from "./integrations.controller.js";

// STORY-022 — one compiles-test per scaffolded module (task 6 of this
// story's breakdown). Logic and real assertions land with this bounded
// area's own future story.
describe("STORY-022 · IntegrationsModule compiles", () => {
  it("resolves in a Nest testing module", async () => {
    // STORY-115: the Search Console service needs the pool and the queue producer, which the real application supplies globally.
    const moduleRef = await Test.createTestingModule({ imports: [IntegrationsModule] })
      .useMocker((token) => (token === PG_POOL || token === QueueProducer ? {} : undefined))
      .compile();
    expect(moduleRef.get(IntegrationsController)).toBeInstanceOf(IntegrationsController);
    await moduleRef.close();
  });
});
