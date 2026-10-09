import { describe, expect, it } from "vitest";
import {
  PRECONDITION_UNMET_REASONS,
  errorDetailsSchemaByCode,
  preconditionUnmetDetailsSchema,
} from "../../contracts/common/error-details.schema.js";
import { errorCodeSchema } from "../../contracts/common/error-code.schema.js";
import {
  ConflictError,
  InsufficientCreditsError,
  NotFoundError,
  PreconditionUnmetError,
  StepUpRequiredError,
  domainErrorFor,
} from "../../src/api/errors/domain-errors.js";

// STORY-024 T12 — AC2: "Every error carries the detail a client needs to
// remediate without a second request."
//
// T7 shipped fourteen `.strict()` details shapes and T9's commit message
// said the typed domain errors "validate their own payloads against" them.
// They did not. `DomainErrorInit.details` was `unknown`,
// `errorDetailsSchemaByCode` had zero references anywhere in `src/`, and
// `new InsufficientCreditsError()` — a 402 carrying no remediation detail at
// all — compiled and was already being constructed by
// problem.filter.spec.ts, green. AC2 was asserted by nothing.
//
// This file is the gate. The compile-time half uses `@ts-expect-error`,
// which fails the BUILD when the line below it stops erroring — so a
// regression in the typing turns `pnpm typecheck` red rather than going
// unnoticed until a customer sees a bare 402.
describe("STORY-024 · AC2 — a code's details shape is enforced at compile time", () => {
  it("a required-details code cannot be constructed without them", () => {
    // @ts-expect-error AC2 — insufficient_credits requires details.{required, available, wallet, packs}
    expect(() => new InsufficientCreditsError()).toBeDefined();
    // @ts-expect-error AC2 — step_up_required requires details.{methods}
    expect(() => new StepUpRequiredError()).toBeDefined();
  });

  it("a required-details code cannot be constructed with the WRONG details", () => {
    // @ts-expect-error AC2 — `limit` is not part of insufficient_credits' shape
    expect(() => new InsufficientCreditsError({ details: { limit: 3 } })).toBeDefined();
    // @ts-expect-error AC2 — methods is string[], not a bare string
    expect(() => new StepUpRequiredError({ details: { methods: "passkey" } })).toBeDefined();
  });

  // The other half of T7's rule: model ONLY what §2 states. §2 gives no
  // details for these codes, so inventing one at a throw site would be an
  // unreviewed addition to a published contract.
  it("a code with no details shape in §2 cannot be given details at all", () => {
    // @ts-expect-error AC2 — §2 defines no details for not_found
    expect(() => new NotFoundError({ details: { id: "x" } })).toBeDefined();
    // @ts-expect-error AC2 — precondition_unmet's one committed member is `reason`, and "stale" is not one of its values
    expect(() => new PreconditionUnmetError({ details: { reason: "stale" } })).toBeDefined();
    // @ts-expect-error AC2 — and it commits nothing else: an invented member is still a type error
    expect(() => new PreconditionUnmetError({ details: { patch: "x" } })).toBeDefined();
  });

  // The positive controls. Without these the assertions above would be
  // satisfied by a type that rejects EVERYTHING, which enforces nothing.
  it("a correct payload compiles, and an all-optional shape stays optional", () => {
    expect(
      () => new InsufficientCreditsError({ details: { required: 10, available: 2, wallet: { included_balance: 0, purchased_balance: 2, reserved: 0, cycle_end: "2026-09-01T00:00:00.000Z" }, packs: [] } }),
    ).not.toThrow();
    // §2 gives `conflict` only an optional `current_state`, so requiring the
    // member would be noise — but it is still TYPED when supplied.
    expect(() => new ConflictError()).not.toThrow();
    expect(() => new ConflictError({ details: { current_state: "archived" } })).not.toThrow();
    expect(() => new NotFoundError()).not.toThrow();
  });

  // STORY-034 — `precondition_unmet` now covers two deep-scan refusals a client
  // must tell apart, and gets a shape for exactly that. `reason` is OPTIONAL
  // because four other throw sites (a missing If-Match, prompt generation not
  // ready, a result document with no parse, ...) belong to other stories and
  // commit no reason; they must keep compiling untouched.
  it("STORY-034 · precondition_unmet takes an optional `details.reason` of exactly the two deep-scan values", () => {
    expect(() => new PreconditionUnmetError()).not.toThrow();
    expect(() => new PreconditionUnmetError({ message: "no reason given" })).not.toThrow();
    expect(() => new PreconditionUnmetError({ details: { reason: "price_not_agreed" } })).not.toThrow();
    expect(() => new PreconditionUnmetError({ details: { reason: "no_capturable_scope" } })).not.toThrow();
    expect(PRECONDITION_UNMET_REASONS).toEqual(["price_not_agreed", "no_capturable_scope"]);
    expect(preconditionUnmetDetailsSchema.safeParse({}).success, "reason is optional").toBe(true);
    expect(preconditionUnmetDetailsSchema.safeParse({ reason: "stale" }).success).toBe(false);
    expect(errorDetailsSchemaByCode.precondition_unmet).toBe(preconditionUnmetDetailsSchema);
  });
});

// The runtime half. `domainErrorFor()` takes the code as DATA, so the
// per-code typing cannot reach it — it is the one door a wrong-shaped
// details could still walk through, and it is closed with the same schemas.
describe("STORY-024 · AC2 — domainErrorFor validates what the type system cannot see", () => {
  it("refuses details for a code §2 gives no shape", () => {
    expect(() => domainErrorFor("not_found", { details: { id: "x" } })).toThrow(/defines no details shape/);
  });

  it("refuses details that do not satisfy the code's own shape", () => {
    expect(() => domainErrorFor("insufficient_credits", { details: { limit: 3 } })).toThrow(/do not satisfy/);
  });

  it("accepts a correct payload and a details-free construction", () => {
    expect(() =>
      domainErrorFor("step_up_required", { details: { methods: ["passkey"] } }),
    ).not.toThrow();
    expect(() => domainErrorFor("not_found")).not.toThrow();
  });

  it("STORY-034 · refuses a precondition_unmet reason the shape does not commit, and accepts the two it does", () => {
    expect(() => domainErrorFor("precondition_unmet", { details: { reason: "stale" } })).toThrow(/do not satisfy/);
    expect(() => domainErrorFor("precondition_unmet", { details: { reason: "price_not_agreed" } })).not.toThrow();
    expect(() => domainErrorFor("precondition_unmet", { details: { reason: "no_capturable_scope" } })).not.toThrow();
    expect(() => domainErrorFor("precondition_unmet", { details: { reason: "no_capturable_scope", extra: 1 } })).toThrow(/do not satisfy/);
    expect(() => domainErrorFor("precondition_unmet")).not.toThrow();
  });

  // Guards the wiring itself: if a fifteenth shape is added to
  // errorDetailsSchemaByCode, it is automatically covered by both halves
  // above — but only if every key is still a real taxonomy code.
  it("every code carrying a details shape is a member of the taxonomy", () => {
    const codes = new Set<string>(errorCodeSchema.options);
    for (const code of Object.keys(errorDetailsSchemaByCode)) {
      expect(codes.has(code), `${code} has a details shape but is not in errorCodeSchema`).toBe(true);
    }
  });
});
