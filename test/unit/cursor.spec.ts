import { describe, expect, it } from "vitest";
import {
  PAGINATION_LIMIT_DEFAULT,
  PAGINATION_LIMIT_MAX,
  paginationRequestSchema,
} from "../../contracts/common/pagination.schema.js";
import { CURSOR_BASE64URL_PATTERN, cursorPayloadSchema } from "../../contracts/common/cursor.schema.js";
import { decodeCursor, encodeCursor } from "../../src/api/pagination/cursor.js";

// STORY-024 T8 (RED step) — story scenario 5 ("Request above the limit cap →
// **Clamped to the cap**") and AC6. Two separate reasons this file is red
// today, and they are different in kind:
//
//   1. `src/api/pagination/cursor.ts` does not exist — T11 creates it.
//   2. `paginationRequestSchema` REJECTS limit=500 rather than clamping it.
//      Measured, not assumed: safeParse({limit: 500}) fails with `too_big`
//      ("expected number to be <=200"). STORY-023 shipped `.max(200)` with a
//      comment claiming the value is "capped at PAGINATION_LIMIT_MAX", but
//      `.max()` validates, it does not clamp. The story's own scenario table
//      says "Clamped to the cap", so the schema is wrong, not this test.
describe("STORY-024 · scenario 5 — the limit cap CLAMPS, it does not reject", () => {
  it("a limit above the cap is clamped to the cap, not rejected", () => {
    const parsed = paginationRequestSchema.safeParse({ limit: 500 });

    expect(
      parsed.success,
      "limit=500 must be accepted and clamped — the story's assertion is \"Clamped to the cap\", not \"rejected\"",
    ).toBe(true);
    expect(parsed.success && parsed.data.limit).toBe(PAGINATION_LIMIT_MAX);
  });

  it("an absent limit takes the default", () => {
    const parsed = paginationRequestSchema.parse({});
    expect(parsed.limit).toBe(PAGINATION_LIMIT_DEFAULT);
  });

  it("a limit at the cap is unchanged, and one below it is respected", () => {
    expect(paginationRequestSchema.parse({ limit: PAGINATION_LIMIT_MAX }).limit).toBe(PAGINATION_LIMIT_MAX);
    expect(paginationRequestSchema.parse({ limit: 10 }).limit).toBe(10);
  });

  // Clamping must not become "accept anything numeric". Zero and negatives are
  // not a cap violation, they are nonsense, and must still fail.
  it("zero, negative and non-integer limits are still rejected outright", () => {
    for (const limit of [0, -1, 1.5]) {
      expect(paginationRequestSchema.safeParse({ limit }).success, `limit=${limit} must be rejected`).toBe(false);
    }
  });

  it("AC6 — no offset/page field is accepted on the request side", () => {
    for (const key of ["offset", "page", "page_number", "skip"]) {
      expect(paginationRequestSchema.safeParse({ [key]: 1 }).success, `${key} must not be accepted`).toBe(false);
    }
  });
});

describe("STORY-024 · AC6 — the cursor is an opaque, tamper-evident encoding of the sort-key tuple", () => {
  it("round-trips a sort-key tuple", () => {
    const key = ["2026-08-04T11:02:31Z", 42];
    expect(decodeCursor(encodeCursor("t", key), "t")).toEqual(key);
  });

  it("encodes to base64url only, so it survives a query string unescaped", () => {
    // A tuple whose JSON is long enough to force padding and non-alphanumeric
    // base64 output — the case where plain base64 would emit "+" or "/".
    const cursor = encodeCursor("t", ["ÿþý?>=<;:/+", 9007199254740991]);
    expect(cursor).toMatch(CURSOR_BASE64URL_PATTERN);
    expect(cursor).not.toContain("=");
  });

  it("carries the payload version, so a later sort-key change can reject a stale cursor", () => {
    const decodedRaw: unknown = JSON.parse(Buffer.from(encodeCursor("t", [1]), "base64url").toString("utf8"));
    expect(cursorPayloadSchema.safeParse(decodedRaw).success).toBe(true);
  });

  // Opaque means the server must not trust what comes back. A cursor is
  // client-supplied input on every page after the first.
  it("rejects a tampered, truncated, non-base64url or wrong-version cursor rather than decoding it to nonsense", () => {
    const valid = encodeCursor("t", ["a", 1]);
    const cases: [string, string][] = [
      ["truncated", valid.slice(0, Math.max(1, valid.length - 4))],
      ["not base64url", "not a cursor!!"],
      ["empty", ""],
      ["wrong version", Buffer.from(JSON.stringify({ v: 99, l: "t", k: ["a"] }), "utf8").toString("base64url")],
      ["not an object", Buffer.from(JSON.stringify(["a"]), "utf8").toString("base64url")],
      ["empty key tuple", Buffer.from(JSON.stringify({ v: 2, l: "t", k: [] }), "utf8").toString("base64url")],
    ];

    for (const [label, cursor] of cases) {
      expect(() => decodeCursor(cursor, "t"), `a ${label} cursor must be refused`).toThrow();
    }
  });

  it("a float sort key is refused — it cannot be compared exactly across a page boundary", () => {
    expect(() => encodeCursor("t", [1.5])).toThrow();
    // Guards against a VACUOUS pass. T11's stub throws for every input, so
    // "it threw" alone proves nothing; an integer key must NOT throw for the
    // assertion above to be about floats at all.
    expect(() => encodeCursor("t", [1])).not.toThrow();
  });
});

// STORY-117 AC6 / scenario 6 — a cursor names the list that issued it. Arity alone cannot tell two (timestamp, uuid)
// lists apart: a members cursor bound against invitations and rewound to the first row.
describe("STORY-117 · scenario 6 — a cursor is bound to its list", () => {
  const KEY = ["2026-09-07 00:00:00.000001+00", "0198f4f6-0000-7000-8000-000000000001"];

  it("STORY-117 scenario 6 — a cursor decodes for the list that issued it", () => {
    expect(decodeCursor(encodeCursor("workspaces.members", KEY), "workspaces.members", 2)).toEqual(KEY);
  });

  it("STORY-117 scenario 6 — a cursor of the SAME arity issued by another list is refused", () => {
    const members = encodeCursor("workspaces.members", KEY);
    try {
      decodeCursor(members, "workspaces.invitations", 2);
      expect.unreachable("a foreign cursor must be refused");
    } catch (error) {
      // The reason travels in details.issues; the message is the client-facing constant.
      expect(error).toMatchObject({ details: { issues: [{ message: "cursor was not issued for this list" }] } });
    }
  });

  it("STORY-117 scenario 6 — a refusal is a 400 validation_failed naming the cursor, not a silent first page", () => {
    const members = encodeCursor("workspaces.members", KEY);
    try {
      decodeCursor(members, "workspaces.invitations", 2);
      expect.unreachable("a foreign cursor must be refused");
    } catch (error) {
      expect(error).toMatchObject({ details: { issues: [{ path: ["cursor"] }] } });
    }
  });

  it("STORY-117 scenario 6 — a cursor issued before lists were tagged (no list member) is refused", () => {
    const legacy = Buffer.from(JSON.stringify({ v: 1, k: KEY }), "utf8").toString("base64url");
    expect(() => decodeCursor(legacy, "workspaces.members", 2)).toThrow();
  });

  it("STORY-117 scenario 6 — a payload with the tag stripped is refused, whatever its version", () => {
    const untagged = Buffer.from(JSON.stringify({ v: 2, k: KEY }), "utf8").toString("base64url");
    expect(() => decodeCursor(untagged, "workspaces.members", 2)).toThrow();
  });

  it("STORY-117 scenario 6 — the list tag is part of the wire payload contract", () => {
    const raw: unknown = JSON.parse(Buffer.from(encodeCursor("workspaces.members", KEY), "base64url").toString("utf8"));
    expect(cursorPayloadSchema.safeParse(raw).success).toBe(true);
    expect(raw).toMatchObject({ l: "workspaces.members" });
  });
});
