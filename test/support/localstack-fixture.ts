import { resolve } from "node:path";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

// Group C item 3 - a real LocalStack (S3 only) for the object-storage specs. Mirrors docker-compose.yml's `localstack`
// service: the SAME pinned image, S3 only, signature validation ON (LocalStack skips it by default, which would make a
// presign-expiry test meaningless), and the SAME init script, so the buckets under test are the ones a developer gets.
//
// Start it under the shared docker lock (plans-7day/scratch/dlock.sh); never beside the owner's api-* containers.

export const LOCALSTACK_IMAGE = "localstack/localstack:4.14.0";
const EDGE_PORT = 4566;

export interface LocalstackFixture {
  readonly endpoint: string;
  readonly container: StartedTestContainer;
  stop(): Promise<void>;
}

export async function startLocalstack(): Promise<LocalstackFixture> {
  const initScript = resolve(import.meta.dirname, "../../docker/localstack/init-buckets.sh");
  const container = await new GenericContainer(LOCALSTACK_IMAGE)
    .withEnvironment({ SERVICES: "s3", DEBUG: "0", S3_SKIP_SIGNATURE_VALIDATION: "0" })
    .withExposedPorts(EDGE_PORT)
    .withBindMounts([{ source: initScript, target: "/etc/localstack/init/ready.d/10-buckets.sh", mode: "ro" }])
    // `completed: true` = the ready.d scripts have finished, i.e. the buckets exist.
    .withWaitStrategy(
      Wait.forHttp("/_localstack/init/ready", EDGE_PORT).forResponsePredicate((body) => {
        try {
          return (JSON.parse(body) as { completed?: boolean }).completed === true;
        } catch {
          return false;
        }
      }),
    )
    .withStartupTimeout(180_000)
    .start();
  return {
    endpoint: `http://${container.getHost()}:${String(container.getMappedPort(EDGE_PORT))}`,
    container,
    stop: async (): Promise<void> => {
      await container.stop();
    },
  };
}
