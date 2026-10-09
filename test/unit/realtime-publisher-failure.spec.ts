import { describe, expect, it } from "vitest";
import { ValkeyRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { socketIoChannelPrefix } from "../../src/lib/cache/key-namespace.js";
import { applyFakeApiEnv } from "../support/fake-env.js";
import { DEAD_VALKEY_URL } from "../support/test-valkey.js";

// STORY-026 G26 — the publisher is FIRE AND FORGET by design: a realtime event
// is a hint, and awaiting delivery would make a committed workspace mutation
// fail because a cache was briefly unreachable.
//
// Fire-and-forget is not the same as DISCARD. `void promise` satisfies the
// lint rule and does nothing about the rejection, and Node 24 terminates the
// process on an unhandled rejection by default — so a Valkey blip during a
// role change would take the API down. That is strictly worse than the failure
// the design was written to avoid, and it can only happen on the path where
// Valkey is already unwell, which is when the process is least able to spare
// it.
//
// Verified against the real driver before this was written: an ioredis
// `publish()` whose promise is discarded emits `unhandledRejection`.
//
// Both halves of `memberChanged` are covered because they publish through
// DIFFERENT objects — the control message through the ioredis client directly,
// the client-facing event through `@socket.io/redis-emitter`, which calls
// `publish()` on whatever client it was given and does not catch it either.
// A fix that only guarded our own call would leave the emitter's uncaught.

const PAYLOAD = {
  workspace_id: "0192f1a0-0000-7000-8000-00000000000a",
  user_id: "0192f1a0-0000-7000-8000-00000000000b",
  role: "analyst" as const,
  status: "removed" as const,
};

/** A client that fails every publish, which is what an unreachable Valkey looks like. */
function failingPublisher(): ValkeyRealtimePublisher {
  applyFakeApiEnv();
  const publisher = new ValkeyRealtimePublisher(DEAD_VALKEY_URL);
  const client = (publisher as unknown as { client: { publish: unknown } }).client;
  // A PLAIN rejecting function, not `vi.fn().mockRejectedValue(...)`. The mock
  // helper retains the promise it produced in order to report it in
  // `mock.results`, and that retention counts as a handler — so the rejection
  // never becomes unhandled and this file passed against the very bug it was
  // written to catch. Verified by watching it go red only after this change.
  client.publish = (): Promise<never> => Promise.reject(new Error("Connection is closed."));
  return publisher;
}

describe("STORY-026 · a failed publish never escapes as an unhandled rejection", () => {
  it("memberChanged does not throw when Valkey is unreachable", () => {
    const publisher = failingPublisher();
    expect(() => {
      publisher.memberChanged(PAYLOAD.workspace_id, PAYLOAD);
    }).not.toThrow();
  });

  it("settles every publish it starts, so nothing is left dangling", async () => {
    // If either half discards its promise, the rejection surfaces as an
    // unhandled error and vitest fails this file — which is exactly the
    // production failure, observed rather than argued about.
    const publisher = failingPublisher();
    publisher.memberChanged(PAYLOAD.workspace_id, PAYLOAD);
    publisher.toWorkspace(PAYLOAD.workspace_id, "member.changed", PAYLOAD);
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("routes the emitter's publishes to the same connection as the control message", async () => {
    // One connection, so one failure mode and one error handler. Two would
    // make "the control channel is up but the event channel is down" a real
    // state, and revocation would then depend on which one was healthy.
    //
    // Asserted through BEHAVIOUR rather than object identity: the emitter is
    // deliberately given a wrapper rather than the client, so identity would
    // now be false for a correct implementation and true for one that handed
    // over the raw client and reintroduced the unhandled rejection.
    applyFakeApiEnv();
    const publisher = new ValkeyRealtimePublisher(DEAD_VALKEY_URL);
    const channels: string[] = [];
    const client = (publisher as unknown as { client: { publish: unknown } }).client;
    client.publish = (channel: string): Promise<number> => {
      channels.push(channel);
      return Promise.resolve(1);
    };

    publisher.memberChanged(PAYLOAD.workspace_id, PAYLOAD);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(channels, "both halves must go through the one client").toHaveLength(2);
  });
});

describe("STORY-026 · realtime pub/sub channels carry the deployment namespace", () => {
  it("publishes to a channel prefixed with the deployment, not the library default", async () => {
    // `@socket.io/redis-emitter` and `@socket.io/redis-adapter` both default
    // their channel prefix to the literal "socket.io", built inside the
    // library and therefore invisible to `valkey-keys.ts`. Two deployments
    // sharing one Valkey cache instance would exchange every realtime event of
    // every workspace. ISO-13 cannot see this: it exercises the exported key
    // constructors, and these channels never pass through them.
    applyFakeApiEnv();
    process.env.CACHE_KEY_NAMESPACE = "staging-42";
    const publisher = new ValkeyRealtimePublisher(DEAD_VALKEY_URL);
    const channels: string[] = [];
    const client = (publisher as unknown as { client: { publish: unknown } }).client;
    client.publish = (channel: string): Promise<number> => {
      channels.push(channel);
      return Promise.resolve(1);
    };

    publisher.memberChanged(PAYLOAD.workspace_id, PAYLOAD);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(channels.length).toBeGreaterThan(0);
    for (const channel of channels) {
      expect(channel, `${channel} would be shared with every other deployment`).toContain("staging-42");
    }
    expect(
      channels.some((channel) => channel.startsWith("socket.io")),
      "no channel may start with the library's un-namespaced default",
    ).toBe(false);
  });

  it("gives the emitter the same prefix the gateway's adapter uses", () => {
    // Two ends of one channel. A mismatch is SILENT: the api process publishes
    // and no gateway is subscribed, so member.changed never arrives and
    // revocation quietly falls back to the sixty-second timer.
    expect(socketIoChannelPrefix("staging-42")).toBe("staging-42:socket.io");
  });
});
