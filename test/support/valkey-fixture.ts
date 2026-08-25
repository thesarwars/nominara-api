import { GenericContainer, type StartedTestContainer } from "testcontainers";

// STORY-025 T14 — a real Valkey for the tests that need one.
//
// `GenericContainer` from the already-installed `testcontainers` package — no
// new test dependency, and the same colima-backed Docker every other
// integration spec uses.
//
// The container's settings MIRROR docker-compose.yml's `valkey-cache`
// deliberately: `allkeys-lru` with no persistence. A test container running
// `noeviction` would be a friendlier Valkey than production's, and a test that
// passes only against the friendlier one proves nothing about the deployment.

const VALKEY_IMAGE = "valkey/valkey:8.1-alpine";
const VALKEY_PORT = 6379;

export interface StartedValkey {
  readonly url: string;
  stop(): Promise<void>;
}

export async function startValkey(): Promise<StartedValkey> {
  const container: StartedTestContainer = await new GenericContainer(VALKEY_IMAGE)
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
    .withExposedPorts(VALKEY_PORT)
    .start();

  return {
    url: `redis://${container.getHost()}:${String(container.getMappedPort(VALKEY_PORT))}`,
    stop: async (): Promise<void> => {
      await container.stop();
    },
  };
}
