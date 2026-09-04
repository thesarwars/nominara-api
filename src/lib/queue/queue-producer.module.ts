import { Global, Module } from "@nestjs/common";
import { Redis } from "ioredis";
import { loadEnv } from "../../config/env.js";
import { createQueueReaderConnection, queueKeyPrefix } from "./connection.js";
import {
  QueueProducer,
  QUEUE_PRODUCER_CONNECTION,
  QUEUE_PRODUCER_PREFIX,
  QUEUE_PRODUCER_SIGNING_KEYS,
} from "./queue-producer.js";
import { signingKeysFromEnv } from "./worker-factory.js";
import type { RotatingSigningKeys } from "./signing.js";

// STORY-043 — the producer half of the queue, for the API process.
//
// @Global for the same reason DbModule is: several bounded areas will produce
// to a queue (projects now, runs and reports later), and each importing this
// would build its own Redis connection for no benefit.
//
// The connection is created HERE and closed here, not inside QueueProducer —
// the thing that creates a resource is the thing that closes it, which is why
// QueueProducer.onModuleDestroy deliberately closes its queues and leaves the
// connection alone.
@Global()
@Module({
  providers: [
    {
      provide: QUEUE_PRODUCER_CONNECTION,
      useFactory: (): Redis => createQueueReaderConnection(loadEnv().QUEUE_REDIS_URL),
    },
    {
      provide: QUEUE_PRODUCER_PREFIX,
      useFactory: (): string => queueKeyPrefix(loadEnv().NODE_ENV),
    },
    {
      provide: QUEUE_PRODUCER_SIGNING_KEYS,
      useFactory: (): RotatingSigningKeys => signingKeysFromEnv(loadEnv()),
    },
    QueueProducer,
  ],
  exports: [QueueProducer],
})
export class QueueProducerModule {}
