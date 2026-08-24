import type { CursorPayload } from "../../../contracts/common/cursor.schema.js";

// STORY-024 task T11's job, deliberately NOT implemented here. Exported with
// the real signatures the RED-step spec files already commit to
// (test/unit/cursor.spec.ts, test/integration/cursor-pagination-stability.spec.ts)
// so `pnpm typecheck` stays a meaningful gate through the RED phase — the
// same shape STORY-023 used for generateClient(). Calling either throws,
// which is the correct, expected failure until T11 lands.
export type CursorKeyElement = CursorPayload["k"][number];

const NOT_IMPLEMENTED = "cursor helpers are not implemented yet — STORY-024 task T11.";

export function encodeCursor(_key: readonly CursorKeyElement[]): string {
  throw new Error(NOT_IMPLEMENTED);
}

export function decodeCursor(_cursor: string): CursorKeyElement[] {
  throw new Error(NOT_IMPLEMENTED);
}
