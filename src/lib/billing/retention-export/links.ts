import { API_VERSION_PREFIX } from "../../../api/configure-app.js";

/**
 * The reports-bucket key of a built export, RELATIVE to the workspace prefix (the tenant store adds the environment and the workspace). DETERMINISTIC per
 * export id (fix round, audit major 2): a retry or a duplicate delivery overwrites the same object, so nothing is orphaned under a key no row records,
 * and the cleanup can delete the object of any expired export, whatever its status, by id alone.
 */
export function retentionExportRelativeKey(exportId: string): string {
  return ["retention-exports", `${exportId}.zip`].join("/");
}

/** The authenticated API route that mints a fresh presign for an export: the link in the email and in the app (the Location is never stored or mailed). */
export function retentionExportDownloadUrl(apiBaseUrl: string, exportId: string): string {
  return new URL(`/${API_VERSION_PREFIX}/billing/retention-export/${exportId}/download`, apiBaseUrl).href;
}

/** The download's file name. A date only: never the workspace or a project name. */
export function retentionExportFilename(at: Date): string {
  return `nominara-full-export-${at.toISOString().slice(0, 10)}.zip`;
}
