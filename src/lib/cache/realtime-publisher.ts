import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { Emitter } from "@socket.io/redis-emitter";
import { Redis } from "ioredis";
import type { RealtimeEventPayloads } from "../../../contracts/events/catalog.schema.js";
import type { RealtimeEventName } from "../../../contracts/events/event-name.schema.js";
import { loadEnv } from "../../config/env.js";
import { cacheKeyNamespace, socketIoChannelPrefix } from "./key-namespace.js";
import { globalKey } from "./valkey-keys.js";
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

/**
 * The channel the GATEWAY subscribes to, as opposed to the rooms clients sit in.
 *
 * A control message and a client event are different things travelling to
 * different audiences: `member.changed` must reach every gateway PROCESS so it
 * can close the affected sockets, and a room emit reaches CLIENTS. The gateway
 * cannot read its own room emits, and subscribing to the adapter's internal
 * channels to try would be reading a private wire format.
 */
export function realtimeControlChannel(namespace: string): string {
  return globalKey(namespace, "rt", "control");
}

export interface RealtimePublisher {
  /** Publishes to every socket in a workspace's room, across every gateway instance. */
  toWorkspace<Name extends RealtimeEventName>(
    workspaceId: string,
    event: Name,
    payload: RealtimeEventPayloads[Name],
  ): void;

  /**
   * `member.changed` — to clients AND to every gateway process, in one call.
   *
   * One method rather than two calls at each site, because the two halves are
   * not optional relative to each other: the client notification without the
   * control message leaves a revoked member's socket open until the
   * re-validation timer fires, which is the sixty-second window §7 exists to
   * close. A caller that could do one and forget the other would eventually
   * do exactly that.
   */
  memberChanged(workspaceId: string, payload: RealtimeEventPayloads["member.changed"]): void;
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
    // The emitter is handed a PUBLISH-ONLY WRAPPER rather than the client
    // itself. `@socket.io/redis-emitter@5.1.0` calls exactly one method on
    // whatever it is given — `publish` — and discards the promise, so an
    // unreachable Valkey turns every emit into an unhandled rejection, which
    // Node 24 answers by terminating the process. Wrapping is the whole fix
    // and needs no patching: same connection underneath, same single failure
    // mode, but nothing is left dangling.
    this.emitter = new Emitter(
      { publish: (channel: string, message: string | Buffer) => { this.publish(channel, message); } } as never,
      // The same namespaced prefix the gateway's adapter uses. These two must
      // agree exactly or the api process publishes into channels no gateway is
      // listening on, and `member.changed` reaches nobody.
      { key: socketIoChannelPrefix(cacheKeyNamespace()) },
      "/rt",
    );
  }

  /**
   * Publishes without waiting, and without discarding the rejection.
   *
   * FIRE AND FORGET IS NOT DISCARD. `void promise` silences the lint rule and
   * changes nothing about what happens when the promise rejects: on Node 24 an
   * unhandled rejection ends the process. So the shape written to stop a cache
   * blip from failing a committed workspace mutation would instead have taken
   * the API down, on the one path where Valkey is already unwell.
   *
   * A dropped event is the correct outcome here — the client refetches from
   * the authoritative API — but it must be a LOGGED outcome. The connection
   * error handler above fires for the same condition, so no separate metric is
   * introduced for it.
   */
  private publish(channel: string, message: string | Buffer): void {
    void this.client.publish(channel, message as string).catch((error: Error) => {
      logger.error({ message: "realtime publish failed; the event was dropped", error: error.name });
    });
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

  memberChanged(workspaceId: string, payload: RealtimeEventPayloads["member.changed"]): void {
    this.toWorkspace(workspaceId, "member.changed", payload);
    this.publish(realtimeControlChannel(cacheKeyNamespace()), JSON.stringify(payload));
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

  memberChanged(workspaceId: string, payload: RealtimeEventPayloads["member.changed"]): void {
    this.toWorkspace(workspaceId, "member.changed", payload);
  }
}

@Injectable()
export class RealtimePublisherProvider {
  /** Chosen by environment, exactly as the cache adapter is — never by availability. */
  static create(): RealtimePublisher {
    const env = loadEnv();
    if (env.NODE_ENV === "test") {
      // NOT ON THE WORD OF NODE_ENV ALONE — the same guard `cache.module.ts`
      // carries, for the same reason, and this file quoted that file's
      // rationale without carrying over its check. Preview and ephemeral
      // deploys commonly run NODE_ENV=test, and `NoopRealtimePublisher`
      // publishes NOTHING to the control channel: no cross-instance broadcast,
      // and no immediate socket revocation, leaving only the sixty-second
      // timer that `security-and-tenancy.md` §7 treats as the ceiling rather
      // than the mechanism. Silently. Found in the STORY-026 review.
      //
      // A test RUNNER, not a build mode, is what licenses it.
      if (process.env.VITEST === undefined) {
        throw new Error(
          "realtime: NODE_ENV=test selects the no-op publisher, but no test runner is present. " +
            "That deployment would have no cross-instance broadcast and no immediate socket revocation — " +
            "a removed member keeps a live socket for up to 60s. " +
            "Set NODE_ENV appropriately for this deployment, or run under the test runner.",
        );
      }
      return new NoopRealtimePublisher();
    }
    return new ValkeyRealtimePublisher(env.VALKEY_CACHE_URL);
  }
}
