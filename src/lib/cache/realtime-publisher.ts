import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { Emitter } from "@socket.io/redis-emitter";
import { Redis } from "ioredis";
import type { RealtimeEventPayloads } from "../../../contracts/events/catalog.schema.js";
import type { RealtimeEventName } from "../../../contracts/events/event-name.schema.js";
import { loadEnv } from "../../config/env.js";
import { incrementCounter } from "../telemetry/metrics.js";

// STORY-026 T22, decision D9 — how the API process publishes realtime events.
//
// The API process has no socket.io server and must not grow one. §11 lists
// `api` as the producer of `task.moved`, `member.changed`, `credits.topped_up`
// and half of `quota.threshold`/`credits.debited` — but those events are
// delivered by the GATEWAY process, to sockets the API process has never seen.
//
// TWO THINGS THIS DELIBERATELY IS NOT:
//
//   Not a hand-rolled publisher. `@socket.io/redis-adapter`'s channel format
//   is private and changes between minors. Writing to it directly would work
//   until a routine dependency bump, and then realtime would go quiet with
//   nothing in the diff to explain it.
//
//   Not a socket.io server standing up inside the API process merely to emit.
//   That would give the API process a second network listener, its own adapter
//   connections and a second place where room authorisation could be got
//   wrong — for the sake of sending a message.
//
// `@socket.io/redis-emitter` is the supported way to publish into a socket.io
// deployment from a process that is not part of it, and it is the one the
// adapter's own maintainers keep in step with the channel format.

const logger = new Logger("realtime-publisher");

export const REALTIME_PUBLISHER = Symbol("REALTIME_PUBLISHER");

/** `ws:{workspace_id}` — §11's room form, duplicated nowhere. */
export function workspaceRoomName(workspaceId: string): string {
  return `ws:${workspaceId}`;
}

export interface RealtimePublisher {
  /** Publishes to every socket in a workspace's room, across every gateway instance. */
  toWorkspace<Name extends RealtimeEventName>(
    workspaceId: string,
    event: Name,
    payload: RealtimeEventPayloads[Name],
  ): void;
}

@Injectable()
export class ValkeyRealtimePublisher implements RealtimePublisher, OnModuleDestroy {
  private readonly client: Redis;
  private readonly emitter: Emitter;

  constructor(url: string = loadEnv().VALKEY_CACHE_URL) {
    this.client = new Redis(url, { maxRetriesPerRequest: 2 });
    this.client.on("error", (error: Error) => {
      logger.error({ message: "realtime publisher connection error", error: error.name });
    });
    this.emitter = new Emitter(this.client, undefined, "/rt");
  }

  toWorkspace<Name extends RealtimeEventName>(
    workspaceId: string,
    event: Name,
    payload: RealtimeEventPayloads[Name],
  ): void {
    // FIRE AND FORGET, deliberately. A realtime event is a hint that something
    // changed; the authoritative answer is the API the client will refetch.
    // Awaiting delivery would make a workspace mutation fail because a cache
    // was briefly unreachable — trading a durable, committed change for a
    // notification.
    this.emitter.to(workspaceRoomName(workspaceId)).emit(event, payload);
    incrementCounter("nominara_realtime_published_total", { event });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }
}

/**
 * The publisher used when there is no Valkey to publish to.
 *
 * Counts what it would have sent, so a test can assert the event was produced
 * without a container, and so a misconfigured deployment shows silence in a
 * metric rather than nothing at all.
 */
@Injectable()
export class NoopRealtimePublisher implements RealtimePublisher {
  readonly published: { workspaceId: string; event: RealtimeEventName; payload: unknown }[] = [];

  toWorkspace<Name extends RealtimeEventName>(
    workspaceId: string,
    event: Name,
    payload: RealtimeEventPayloads[Name],
  ): void {
    this.published.push({ workspaceId, event, payload });
    incrementCounter("nominara_realtime_published_total", { event, transport: "noop" });
  }
}

@Injectable()
export class RealtimePublisherProvider {
  /** Chosen by environment, exactly as the cache adapter is — never by availability. */
  static create(): RealtimePublisher {
    const env = loadEnv();
    if (env.NODE_ENV === "test") return new NoopRealtimePublisher();
    return new ValkeyRealtimePublisher(env.VALKEY_CACHE_URL);
  }
}
