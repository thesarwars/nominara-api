import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

// STORY-025 T14 / STORY-030 Phase B — real Valkey containers for the tests
// that need one, for EACH of the two documented instances (system-
// architecture.md §11). `GenericContainer` from the already-installed
// `testcontainers` package — no new test dependency, and the same
// colima-backed Docker every other integration spec uses.
//
// `startValkey()` mirrors docker-compose.yml's `valkey-cache`: `allkeys-lru`
// with no persistence. `startValkeyFixture()` mirrors the `valkey` (queue)
// service: `noeviction`. A test container running the wrong instance's
// eviction policy would be a friendlier (or stricter) Valkey than the one it
// stands in for, and a test that passes only against the wrong policy proves
// nothing about the deployment — hence two distinct starters, not one
// parameterised by a flag that could default wrong.

const CACHE_VALKEY_IMAGE = "valkey/valkey:8.1-alpine";
const CACHE_VALKEY_PORT = 6379;

export interface StartedValkey {
  readonly url: string;
  stop(): Promise<void>;
}

/** The CACHE instance's disposable test double — allkeys-lru, no persistence. */
export async function startValkey(): Promise<StartedValkey> {
  const container: StartedTestContainer = await new GenericContainer(CACHE_VALKEY_IMAGE)
    .withCommand([
      "valkey-server",
      "--maxmemory",
      "64mb",
      "--maxmemory-policy",
      "allkeys-lru",
      "--save",
      "",
      "--appendonly",
      "no",
    ])
    .withExposedPorts(CACHE_VALKEY_PORT)
    .start();

  return {
    url: `redis://${container.getHost()}:${String(container.getMappedPort(CACHE_VALKEY_PORT))}`,
    stop: async (): Promise<void> => {
      await container.stop();
    },
  };
}

// STORY-030 Phase B — the queue instance's disposable test double.
// system-architecture.md §11 pins Valkey 9.1 as the queue engine; no
// @testcontainers/* module ships a Valkey-specific wrapper, so this mirrors
// test/support/pgbouncer-fixture.ts's plain GenericContainer pattern rather
// than adding a new dependency. `noeviction` matches the QUEUE instance's
// documented eviction policy (§11's cache/queue split) — this fixture is
// standing in for the queue instance specifically, never the cache one.

export const VALKEY_IMAGE = "valkey/valkey:9.1";
const QUEUE_VALKEY_PORT = 6379;

export interface ValkeyFixture {
  readonly container: StartedTestContainer;
  readonly host: string;
  readonly port: number;
  /** `redis://host:port` — ioredis and BullMQ both accept this connection-string form. */
  readonly connectionString: string;
  stop(): Promise<void>;
}

/** The QUEUE instance's disposable test double — noeviction, matching BullMQ's durability requirement. */
export async function startValkeyFixture(): Promise<ValkeyFixture> {
  const container = await new GenericContainer(VALKEY_IMAGE)
    .withCommand(["valkey-server", "--maxmemory-policy", "noeviction"])
    .withExposedPorts(QUEUE_VALKEY_PORT)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(QUEUE_VALKEY_PORT);

  return {
    container,
    host,
    port,
    connectionString: `redis://${host}:${port}`,
    async stop() {
      await container.stop();
    },
  };
}
