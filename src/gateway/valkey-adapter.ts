import { Logger } from "@nestjs/common";
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";
import { cacheKeyNamespace, socketIoChannelPrefix } from "../lib/cache/key-namespace.js";
import type { Server } from "socket.io";

// STORY-026 T22 — AC4: "The gateway requires NO STICKY SESSIONS: broadcast
// goes through the Valkey adapter."
//
// Without this, a broadcast reaches only the sockets attached to the instance
// that emitted it. Two gateway replicas and a client is served by whichever
// one the balancer picked — so half the events silently do not arrive, which
// looks like a flaky product rather than a missing adapter. Sticky sessions
// "fix" that by pinning a client to one instance, and then a rolling deploy
// disconnects every pinned client at once and a hot instance cannot shed load.
//
// TWO CONNECTIONS, NOT ONE, and it is not optional. A Redis/Valkey connection
// in subscriber mode may issue no other commands, so the adapter needs a
// separate publisher. Sharing one client leaves the adapter unable to publish
// the moment it subscribes.
//
// This is `@socket.io/redis-adapter`'s own construction (decision D3). Its
// channel format is private and changes between minors; hand-rolling a
// publisher against it would produce a realtime outage on a routine
// dependency bump, with nothing in the diff to point at.

const logger = new Logger("valkey-adapter");

export interface ValkeyAdapterHandle {
  close(): Promise<void>;
}

/**
 * Attaches the Valkey adapter to a socket.io server.
 *
 * Returns a handle rather than nothing so the caller can close both
 * connections on shutdown — an unclosed subscriber keeps the process alive and
 * turns a graceful drain into a hung one.
 */
export function attachValkeyAdapter(server: Server, url: string): ValkeyAdapterHandle {
  const pub = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false });
  const sub = pub.duplicate();

  for (const [name, client] of [
    ["publisher", pub],
    ["subscriber", sub],
  ] as const) {
    client.on("error", (error: Error) => {
      // The error NAME only: a connection error can carry the URL, and the URL
      // can carry credentials.
      logger.error({ message: "valkey adapter connection error", client: name, error: error.name });
    });
  }

  // NAMESPACED, like every other key this service writes. `createAdapter`
  // defaults its channel prefix to the literal "socket.io", which is built
  // INSIDE the library and so bypasses `valkey-keys.ts` entirely — the file
  // whose first line claims every Valkey key this service writes is built
  // there. Two deployments sharing one Valkey cache instance would therefore
  // cross-broadcast every realtime event of every workspace to each other,
  // which is the precise failure `CACHE_KEY_NAMESPACE` exists to prevent and
  // the one hazard T22 was written to avoid. Found in the STORY-026 review.
  server.adapter(createAdapter(pub, sub, { key: socketIoChannelPrefix(cacheKeyNamespace()) }));
  logger.log({ message: "valkey adapter attached — broadcast is cross-instance, no sticky sessions" });

  return {
    close: async (): Promise<void> => {
      // `quit()`, which drains in-flight commands, rather than `disconnect()`,
      // which abandons them. A rolling deploy closes this while a broadcast may
      // still be in flight, and losing that broadcast is a real if small
      // product defect.
      //
      // CALL THIS ONLY AFTER SOCKET.IO HAS CLOSED ITS SERVER. Closing the
      // server is what makes socket.io call `RedisAdapter.close()`, which
      // issues unsubscribes on `sub` without catching the promises ioredis
      // returns. Quit first and every one of them rejects with "Connection is
      // closed" as an unhandled rejection. `RealtimeGateway` does this from
      // `onApplicationShutdown` for exactly that reason; see the note there.
      await Promise.allSettled([pub.quit(), sub.quit()]);
    },
  };
}
