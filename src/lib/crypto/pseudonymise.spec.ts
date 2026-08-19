import { describe, expect, it } from "vitest";
import { pseudonymiseWorkspaceId } from "./pseudonymise.js";

// STORY-020 AC "on workspace deletion, rows are retained only in the
// immutable export, with the workspace identifier pseudonymised" — one-way,
// deterministic, no I/O.

describe("STORY-020 · pseudonymiseWorkspaceId", () => {
  it("is deterministic — the same input always pseudonymises to the same output", () => {
    const id = "0192a1b2-c3d4-7000-8000-abcdef123456";
    expect(pseudonymiseWorkspaceId(id)).toBe(pseudonymiseWorkspaceId(id));
  });

  it("is one-way — different workspace ids never collide to the same pseudonym", () => {
    const a = pseudonymiseWorkspaceId("0192a1b2-c3d4-7000-8000-abcdef123456");
    const b = pseudonymiseWorkspaceId("0192a1b2-c3d4-7000-8000-abcdef654321");
    expect(a).not.toBe(b);
  });

  it("never returns the original workspace id verbatim", () => {
    const id = "0192a1b2-c3d4-7000-8000-abcdef123456";
    expect(pseudonymiseWorkspaceId(id)).not.toBe(id);
  });

  it("is shaped like a UUID, so export consumers expecting a uuid-shaped column do not choke", () => {
    const result = pseudonymiseWorkspaceId("0192a1b2-c3d4-7000-8000-abcdef123456");
    expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
