// The per-project competitor cap has two writers: `CompetitorTrackingService.track`
// (NEW-C-2) and `ProjectsService.confirmDiscovery` (STORY-044 AC5). Each counts
// the live competitors and then inserts, so under READ COMMITTED two
// concurrent writers both see room for one and leave the project over its cap.
// Both take THIS lock before counting; it is transaction-scoped and released
// at COMMIT or ROLLBACK. One helper, so the two cannot name different keys.
export async function lockProjectCompetitors(
  tx: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  projectId: string,
): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [`competitors:${projectId}`]);
}
