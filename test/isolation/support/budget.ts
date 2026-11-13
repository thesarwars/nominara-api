// STORY-012 AC12 / D-5 - the isolation suite's runtime bound, in ONE place. The suite blocks every pull request, so it must never be the reason someone
// skips CI: a run over this bound is a failure, not a warning. Both global-setup teardowns (the local container and the staging target) call
// `assertWithinBudget`; test/isolation/meta/budget.spec.ts is what proves an overrun fails.
export const ISOLATION_BUDGET_MS = 5 * 60 * 1000;

export class IsolationBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IsolationBudgetError";
  }
}

/** Throws when `elapsedMs` is over `budgetMs`. A clock reading that is not a finite, non-negative number fails closed: it cannot be shown to be inside. */
export function assertWithinBudget(elapsedMs: number, budgetMs: number = ISOLATION_BUDGET_MS): void {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new IsolationBudgetError(`STORY-012 D-5: the isolation suite's elapsed time is not a usable measurement (${String(elapsedMs)}), so the ${String(budgetMs)}ms budget cannot be shown to hold`);
  }
  if (elapsedMs > budgetMs) {
    throw new IsolationBudgetError(`STORY-012 D-5: isolation suite took ${String(elapsedMs)}ms, over the ${String(budgetMs)}ms budget`);
  }
}
