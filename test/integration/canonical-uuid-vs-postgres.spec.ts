import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalUuid, isNonCanonicalUuidSpelling } from "../../src/api/canonical-uuid.js";

// STORY-150 review — the JS and the real parser, checked against each other.
//
// ⚠ THIS EXISTS BECAUSE THE FIRST VERSION OF `isNonCanonicalUuidSpelling` WAS
// A SECOND UUID PARSER AND IT LOST. It matched an optional-hyphen 8-4-4-4-12
// shape, which reads plausible and is not what Postgres does: hyphens are
// accepted in the wrong places, missing entirely, and 32 bare hex digits are a
// uuid. Two of the five spellings below slipped straight through it.
//
// STORY-149 made the rule for this codebase — "asking Postgres is the point; a
// Node-side canonicaliser is a second implementation to keep in step forever,
// and drift is precisely the bug". Asking Postgres per request is not viable
// on a path parameter, so the discipline it leaves is this: pin the JS against
// the real database in a test that runs, rather than against a comment.
describe("STORY-150 · canonical-uuid agrees with Postgres about what a uuid is", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
  }, 180_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  /** What Postgres makes of `value`: the canonical uuid, or null when it refuses. */
  async function postgresUuid(value: string): Promise<string | null> {
    try {
      const result = await db.query<{ id: string }>("SELECT $1::uuid AS id", [value]);
      return result.rows[0]!.id;
    } catch {
      return null;
    }
  }

  const CANONICAL = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

  // Every one of these is the SAME ROW to Postgres, and a different string to
  // us — which is how two of them claimed two idempotency records and spent
  // two debits under one key.
  const ACCEPTED_BY_POSTGRES = [
    CANONICAL,
    CANONICAL.toUpperCase(),
    `{${CANONICAL}}`,
    "a0eebc999c0b4ef8bb6d6bb9bd380a11",
    "a0ee-bc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    "a0eebc99-9c0b4ef8-bb6d-6bb9bd380a11",
    "a0eebc99-9c0b-4ef8-bb6d6bb9bd380a11",
  ] as const;

  it.each(ACCEPTED_BY_POSTGRES)("Postgres reads %s as one uuid, and we either canonicalise it or refuse it", async (spelling) => {
    expect(await postgresUuid(spelling), "the premise: Postgres accepts this").toBe(CANONICAL);

    // The invariant. Exactly one of two things must be true of a spelling
    // Postgres accepts: either we hand on the canonical form, or we refuse it.
    // Handing on a NON-canonical form is the failure — that is two strings
    // naming one row, which is the whole defect.
    if (isNonCanonicalUuidSpelling(spelling)) return;
    expect(canonicalUuid(spelling), "accepted, so it must come out canonical").toBe(CANONICAL);
  });

  // ⚠ THE DANGEROUS DIRECTION IS UNDER-APPROXIMATION, so it gets its own
  // assertion rather than riding on the loop above: a spelling Postgres
  // accepts that we neither canonicalise nor refuse is a silent second name
  // for a row.
  it("refuses or canonicalises EVERY spelling Postgres accepts — none slips through as a second name", async () => {
    const slippedThrough: string[] = [];
    for (const spelling of ACCEPTED_BY_POSTGRES) {
      if (isNonCanonicalUuidSpelling(spelling)) continue;
      if (canonicalUuid(spelling) !== CANONICAL) slippedThrough.push(spelling);
    }
    expect(slippedThrough).toEqual([]);
  });

  // Over-approximating only ever refuses something Postgres would have refused
  // too, so it costs a caller nothing they could have used.
  it.each([
    "a-0-e-e-b-c-9-9-9c0b4ef8bb6d6bb9bd380a11",
    "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a1",
    "urn:uuid:a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    `{${CANONICAL}`,
  ])("refusing %s costs nothing, because Postgres refuses it too", async (spelling) => {
    expect(await postgresUuid(spelling)).toBeNull();
  });

  it("leaves an ordinary slug alone, and Postgres would not have taken it either", async () => {
    for (const slug of ["acme-corp", "google", "deadbeef", "Acme-Corp"]) {
      expect(isNonCanonicalUuidSpelling(slug), slug).toBe(false);
      expect(canonicalUuid(slug), slug).toBe(slug);
      expect(await postgresUuid(slug), slug).toBeNull();
    }
  });
});
