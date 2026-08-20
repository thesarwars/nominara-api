import { describe, expect, it } from "vitest";
import { assertIso18ActorSelfScopedMultiActor } from "./assertions/iso-18-actor-self-scoped-multi-actor.js";
import { assertIso19NoGucsZeroRows } from "./assertions/iso-19-actor-scoped-no-context-zero-rows.js";
import { assertIso20ActorPolicyInertUnderTenantContext } from "./assertions/iso-20-actor-policy-inert-under-tenant-context.js";
import { assertIso21ActorOnlyWritesDenied } from "./assertions/iso-21-actor-only-writes-denied.js";
import { assertIso22ActorOnlyFuzzReplay } from "./assertions/iso-22-actor-only-fuzz-replay.js";
import { getAssertionContext } from "./support/context.js";
import { isRunnableForCurrentTarget } from "./support/target-guard.js";

// STORY-021 / ADR-0001 — the 5 isolation cases the ADR names for the
// actor-self-scoped RLS policy class (workspaces/workspace_members only).

describe("ISO-18 · actor-only context shows an actor only their own memberships/workspaces (multi-actor)", () => {
  it.skipIf(!isRunnableForCurrentTarget("ISO-18"))("excludes a removed/suspended membership's workspace, never leaks another actor's rows", async () => {
    await expect(assertIso18ActorSelfScopedMultiActor(getAssertionContext())).resolves.toBeUndefined();
  });
});

describe("ISO-19 · no GUCs set at all still yields zero rows (ISO-01 regression, actor-self-scoped tables)", () => {
  it.skipIf(!isRunnableForCurrentTarget("ISO-19"))("holds for workspaces and workspace_members", async () => {
    await expect(assertIso19NoGucsZeroRows(getAssertionContext())).resolves.toBeUndefined();
  });
});

describe("ISO-20 · the actor-self-scoped policy is inert under a normal tenant-scoped context", () => {
  it.skipIf(!isRunnableForCurrentTarget("ISO-20"))("contributes zero additional rows beyond ws_isolation", async () => {
    await expect(assertIso20ActorPolicyInertUnderTenantContext(getAssertionContext())).resolves.toBeUndefined();
  });
});

describe("ISO-21 · every write under an actor-only context is categorically denied", () => {
  it.skipIf(!isRunnableForCurrentTarget("ISO-21"))("raises SQLSTATE 25006 (read-only transaction) for INSERT/UPDATE/DELETE on both tables", async () => {
    await expect(assertIso21ActorOnlyWritesDenied(getAssertionContext())).resolves.toBeUndefined();
  });
});

describe("ISO-22 · 500 randomised actor-only replays yield only the actor's own workspace", () => {
  it.skipIf(!isRunnableForCurrentTarget("ISO-22"))("never returns a foreign workspaces/workspace_members row", async () => {
    await expect(assertIso22ActorOnlyFuzzReplay(getAssertionContext())).resolves.toBeUndefined();
  });
});
