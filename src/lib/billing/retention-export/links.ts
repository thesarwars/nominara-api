import { API_VERSION_PREFIX } from "../../../api/configure-app.js";

/** The reports-bucket key of a built export, RELATIVE to the workspace prefix (the tenant store adds the environment and the workspace). One key per run. */
export function retentionExportRelativeKey(exportId: string, runId: string): string {
  return ["retention-exports", exportId, `${runId}.zip`].join("/");
}

/** The authenticated API route that mints a fresh presign for an export: the link in the email and in the app (the Location is never stored or mailed). */
export function retentionExportDownloadUrl(apiBaseUrl: string, exportId: string): string {
  return new URL(`/${API_VERSION_PREFIX}/billing/retention-export/${exportId}/download`, apiBaseUrl).href;
}

/** The download's file name. A date only: never the workspace or a project name. */
export function retentionExportFilename(at: Date): string {
  return `nominara-full-export-${at.toISOString().slice(0, 10)}.zip`;
}
