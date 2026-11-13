import { fileURLToPath } from "node:url";
import { Logger } from "@nestjs/common";
import { loadEnv } from "../config/env.js";
import { connect, requireDatabaseUrl } from "./client.js";
import { assertReembedEnabled, runReembed } from "../lib/embedding/reembed.js";
import { embedBatchEnqueuerFor } from "../lib/embedding/prompt-embedding-request.js";
import { selectedEmbeddingModel } from "../lib/queue/handlers/embed-batch.handler.js";
import { createQueueWorkerConnection, queueKeyPrefix } from "../lib/queue/connection.js";
import { QueueProducer } from "../lib/queue/queue-producer.js";
import { signingKeysFromEnv } from "../lib/queue/worker-factory.js";

// STORY-186 - `pnpm db:reembed`: the ONLY way a re-embed starts (owner decision 104(b)). Refuses unless EMBED_REEMBED_ENABLED=true; no deploy
// trigger, no schedule. One run:
//   - backfills active prompts that were never embedded (the first run does this; nothing spends automatically),
//   - stages new vectors for rows still under another model (the old vectors keep serving),
//   - cuts over each project whose staged set is complete, in one step.
// It enqueues `embed.batch` jobs and calls no provider; the spend happens in the embed workers, metered on embed_tokens. Run it again after the
// workers drain to cut over what completed; a rerun is idempotent and resumes where the last stopped. Exit code 1 if anything failed to enqueue or
// cut over. The output is counts and identifiers only.

async function main(): Promise<void> {
  const env = loadEnv();
  assertReembedEnabled(env);
  const model = selectedEmbeddingModel(env);
  const client = await connect(requireDatabaseUrl());
  const connection = createQueueWorkerConnection(env.QUEUE_REDIS_URL);
  const producer = new QueueProducer(connection, queueKeyPrefix(env.NODE_ENV), signingKeysFromEnv(env));
  try {
    const summary = await runReembed({ client, model, enqueue: embedBatchEnqueuerFor(producer)!, logger: new Logger("embed.reembed") });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (summary.enqueueFailed > 0 || summary.promoteFailed > 0) process.exitCode = 1;
  } finally {
    await connection.quit().catch(() => undefined);
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`db:reembed failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
