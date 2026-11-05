// STORY-180 - the API environment that points the reports bucket at a LocalStack (S3 only) started with startLocalstack().
export const REPORT_STORAGE_KEY_ENV = "inttest";

export function reportStorageEnv(endpoint: string): Record<string, string> {
  return {
    STORAGE_ENDPOINT: endpoint,
    STORAGE_BUCKET_RAW: "nominara-raw",
    STORAGE_BUCKET_REPORTS: "nominara-reports",
    STORAGE_ACCESS_KEY_ID: "test",
    STORAGE_SECRET_ACCESS_KEY: "test",
    STORAGE_FORCE_PATH_STYLE: "true",
    STORAGE_SSE: "AES256",
    STORAGE_KEY_ENV: REPORT_STORAGE_KEY_ENV,
  };
}

/**
 * Downloads a presigned URL the way a browser would, retrying while the object is not there yet: the upload runs after the
 * request commits, so the first fetch can beat it by a few milliseconds.
 */
export async function fetchStored(url: string, timeoutMs = 10_000): Promise<Buffer> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(url);
    if (res.status === 200) return Buffer.from(await res.arrayBuffer());
    await res.arrayBuffer();
    if (Date.now() > deadline) throw new Error(`stored file not downloadable (status ${String(res.status)})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
