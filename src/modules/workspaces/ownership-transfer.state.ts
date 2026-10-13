import { OWNERSHIP_TRANSFER_TTL_DAYS, type OwnershipTransfer } from "../../../contracts/workspaces/ownership-transfer.schema.js";

// STORY-021 (core slice) — RED stub: the pure state rules are specified by
// ownership-transfer.state.spec.ts and implemented in the next commit.
export const OWNERSHIP_TRANSFER_TTL_MS = OWNERSHIP_TRANSFER_TTL_DAYS * 24 * 60 * 60 * 1000;
type Doc = NonNullable<OwnershipTransfer>;
const notImplemented = (): never => {
  throw new Error("not implemented");
};
export function parseTransfer(_raw: unknown): Doc | null {
  return notImplemented();
}
export function expiresAtOf(_doc: Doc): Date {
  return notImplemented();
}
export function isExpired(_doc: Doc | null, _now: Date): boolean {
  return notImplemented();
}
export function isPending(_doc: Doc | null, _now: Date): boolean {
  return notImplemented();
}
