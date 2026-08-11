import { connect, requireDatabaseUrl } from "./client.js";
import { rollbackLast } from "./migrate-runner.js";

const client = await connect(requireDatabaseUrl());
try {
  const rolledBack = await rollbackLast(client);
  console.log(rolledBack ? `rolled back ${rolledBack}` : "nothing to roll back");
} finally {
  await client.end();
}
