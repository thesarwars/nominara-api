// STORY-004 AC5 — RED stub. Implemented in the next commit.
export interface SyntheticSeedGuardInput {
  readonly nodeEnv: string | undefined;
  readonly databaseUrl: string | undefined;
  readonly databaseUrlPooled: string | undefined;
  readonly optIn: string | undefined;
}
export function assertSyntheticSeedAllowed(_input: SyntheticSeedGuardInput): void {}
