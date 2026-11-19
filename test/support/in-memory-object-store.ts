import type { PrefixDeletingPort, StorageBucketName } from "../../src/lib/storage/storage.port.js";

/**
 * An in-memory model of the two buckets with VERSIONING ON: a key holds every version and delete marker, and a prefix delete removes all of them.
 * It implements the purge-side port with the same refusals the S3 adapter has (an empty prefix, one not ending in `/`), so a test that purges through
 * it exercises the real prefix wrapper (`workspace-purge.ts`) against a store that can be searched afterwards.
 */
export class InMemoryObjectStore implements PrefixDeletingPort {
  private readonly buckets: Record<StorageBucketName, Map<string, number>> = { raw: new Map(), reports: new Map() };

  /** Adds `versions` versions of `key` (a plain overwrite on a versioned bucket keeps the old ones). */
  put(bucket: StorageBucketName, key: string, versions = 1): void {
    this.buckets[bucket].set(key, (this.buckets[bucket].get(key) ?? 0) + versions);
  }

  deletePrefix(bucket: StorageBucketName, prefix: string): Promise<number> {
    if (prefix === "" || !prefix.endsWith("/")) return Promise.reject(new Error("prefix must be non-empty and end in /"));
    let removed = 0;
    for (const [key, versions] of [...this.buckets[bucket]]) {
      if (!key.startsWith(prefix)) continue;
      removed += versions;
      this.buckets[bucket].delete(key);
    }
    return Promise.resolve(removed);
  }

  deleteKeys(bucket: StorageBucketName, keys: readonly string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      removed += this.buckets[bucket].get(key) ?? 0;
      this.buckets[bucket].delete(key);
    }
    return Promise.resolve(removed);
  }

  /** Every key in a bucket, whatever its prefix. */
  keys(bucket: StorageBucketName): string[] {
    return [...this.buckets[bucket].keys()].sort();
  }

  /** Every `bucket/key` in BOTH buckets that names `needle` anywhere (a workspace id, a project id). The search the AC asks for. */
  search(needle: string): string[] {
    return (["raw", "reports"] as const).flatMap((bucket) => this.keys(bucket).filter((key) => key.includes(needle)).map((key) => `${bucket}/${key}`));
  }
}
