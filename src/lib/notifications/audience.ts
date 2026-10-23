// STORY-068 RED stub — replaced by the implementation.
export function defaultCadenceFor(_role: string): string { return "never"; }
export function effectiveCadence(_role: string, _stored: string | null): string { return "never"; }
export function visibleProjects(_role: string, _scope: readonly string[] | null): readonly string[] | null { return []; }
export function seesProject(_visible: readonly string[] | null, _projectId: string | null): boolean { return false; }
