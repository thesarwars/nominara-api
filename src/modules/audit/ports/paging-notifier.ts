// STORY-020 D-2 — port for daily-verifier paging. Real target is PagerDuty;
// no paging client exists in this repo yet, so production wiring is a
// disclosed gap (STORY-020-E-4). The alert carries only enough to locate the
// row — never row content (before_state/after_state), matching the
// no-raw-content-in-logs rule.

export interface ChainMismatchAlert {
  readonly workspaceId: string;
  readonly seq: string;
  readonly reason: string;
}

export interface PagingNotifier {
  page(alert: ChainMismatchAlert): Promise<void>;
}
