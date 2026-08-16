// STORY-012 ISO-13 scanner self-test fixture — NOT real application code,
// never imported by anything except the scanner's own self-test. One
// correctly-namespaced key, one using the single documented exception, and
// one un-namespaced (tenant-scoped but missing the workspace segment) —
// proves scanForKeyLiterals finds and the caller correctly classifies all
// three, so a genuinely empty result against src/ can be trusted rather than
// silently vacuous.

export function goodCacheKey(env: string, workspaceId: string, promptId: string): string {
  return `${env}:${workspaceId}:answers:${promptId}`;
}

export function exceptionCacheKey(env: string): string {
  return `${env}:global:capture:latest`;
}

export function badCacheKey(workspaceId: string, promptId: string): string {
  return `${workspaceId}:answers:${promptId}`;
}
