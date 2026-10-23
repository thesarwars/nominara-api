// STORY-068 RED stub — replaced by the implementation.
export interface AlertRule { readonly code: string; readonly severity: string; readonly cooldownDays: number | null; readonly generates: string | null; readonly internal: boolean; readonly route: string; readonly postLaunch: boolean }
export const ALERT_CATALOG: readonly AlertRule[] = [];
export function alertRule(code: string): AlertRule { throw new Error(`not implemented: ${code}`); }
export function alertRuleForTask(_taskRuleCode: string): AlertRule | undefined { return undefined; }
