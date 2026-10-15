import type { StorageBucketName, StorageNamespace } from "./storage.port.js";

// Group C item 3 — object key construction. This is the one place a key is built.
//
// LAYOUT (system-architecture.md sections 6 and 8)
//   raw      bucket raw      {env}/{workspace_id}/{relative}          e.g. production/<ws>/2026/10/<id>.json.gz
//   crawl    bucket raw      crawl/{env}/{workspace_id}/{relative}
//   reports  bucket reports  {env}/{workspace_id}/{relative}
// Every key carries the workspace id, and the workspace id is an argument the TENANT layer fills from the tenant
// context (never from a request), so no caller-supplied string can choose which workspace's prefix it lands in.

/** A programming or input error in the key: malformed, traversing, over-long. Never a user-visible message. */
export class StorageKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageKeyError";
  }
}

/** A key outside the current workspace's prefix. A security event, not a not-found. */
export class StorageTenancyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageTenancyError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENV_SEGMENT = /^[a-z0-9][a-z0-9-]{0,31}$/;
// A closed character set: anything outside it (spaces, percent escapes, backslashes, control and non-ASCII characters)
// is refused rather than escaped, so a key means the same thing to this code, to S3 and to a URL.
const RELATIVE_SEGMENT = /^[A-Za-z0-9._=-]+$/;
export const MAX_RELATIVE_KEY_LENGTH = 512;

export interface ObjectLocation {
  readonly bucket: StorageBucketName;
  readonly key: string;
}

function assertEnvAndWorkspace(keyEnv: string, workspaceId: string): void {
  if (!ENV_SEGMENT.test(keyEnv) || keyEnv === "crawl") throw new StorageKeyError("storage key environment is not a lowercase slug");
  if (!UUID.test(workspaceId)) throw new StorageKeyError("storage workspace id is not a lowercase uuid");
}

function assertRelative(relative: string): void {
  if (relative.length === 0 || relative.length > MAX_RELATIVE_KEY_LENGTH) throw new StorageKeyError("storage key length is out of range");
  for (const segment of relative.split("/")) {
    if (/^\.+$/.test(segment) || !RELATIVE_SEGMENT.test(segment)) {
      throw new StorageKeyError("storage key has an empty, dot-only or disallowed segment");
    }
  }
}

function prefixFor(keyEnv: string, workspaceId: string, namespace: StorageNamespace): string {
  assertEnvAndWorkspace(keyEnv, workspaceId);
  return namespace === "crawl" ? `crawl/${keyEnv}/${workspaceId}/` : `${keyEnv}/${workspaceId}/`;
}

function bucketFor(namespace: StorageNamespace): StorageBucketName {
  return namespace === "reports" ? "reports" : "raw";
}

/** The bucket and full key for `relative` inside `workspaceId`'s prefix of `namespace`. */
export function buildObjectLocation(keyEnv: string, workspaceId: string, namespace: StorageNamespace, relative: string): ObjectLocation {
  const prefix = prefixFor(keyEnv, workspaceId, namespace);
  assertRelative(relative);
  return { bucket: bucketFor(namespace), key: `${prefix}${relative}` };
}

/**
 * Maps a FULL key read back from the database (`answer_captures.raw_object_key`, `report_artifacts.object_key`) to the
 * relative part, and only if it lies inside `workspaceId`'s own prefix. Anything else is a StorageTenancyError: a stored
 * key naming another workspace, another environment or the wrong namespace is corruption or an attack, and is never
 * resolved.
 */
export function relativeKeyFromStored(keyEnv: string, workspaceId: string, namespace: StorageNamespace, stored: string): string {
  const prefix = prefixFor(keyEnv, workspaceId, namespace);
  if (!stored.startsWith(prefix)) throw new StorageTenancyError("stored object key is outside the current workspace prefix");
  const relative = stored.slice(prefix.length);
  try {
    assertRelative(relative);
  } catch {
    // Same class as a foreign prefix: a key that merely STARTS with ours but traverses out of it.
    throw new StorageTenancyError("stored object key is outside the current workspace prefix");
  }
  return relative;
}
