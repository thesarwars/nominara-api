// STORY-012 ISO-14 scanner self-test fixture — NOT real application code,
// same purpose as ./cache-keys.ts. One correctly-prefixed object key
// ({env}/{workspace_id}/...) and one with the segments in the wrong order.

export function goodObjectKey(env: string, workspaceId: string, reportId: string): string {
  return `${env}/${workspaceId}/reports/${reportId}.pdf`;
}

export function badObjectKey(env: string, workspaceId: string, reportId: string): string {
  return `${workspaceId}/${env}/reports/${reportId}.pdf`;
}
