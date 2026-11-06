import { randomUUID } from "node:crypto";
import {
  purgeJournalAppendSchema,
  purgeJournalEntrySchema,
  type PurgeJournalAppend,
  type PurgeJournalEntry,
} from "../../../contracts/compliance/index.js";

// STORY-111 / NFR-CMP-08 - the purge journal, OUTSIDE the database.
//
// A journal stored in Postgres would be rolled back by the very restore it exists to correct: recovering a snapshot that predates a
// purge also recovers the record that the purge happened. Object storage is outside the restore's blast radius, so each entry is its own
// object (append-only by construction: a key is never reused, never overwritten, and this class has no delete). Entries hold identifiers,
// a timestamp and a closed-enum reason; the contract rejects anything else.
//
// RESTORE: `replayPurgeJournal(journal, snapshotAt, apply)` returns every entry recorded AFTER the snapshot, oldest first, and applies each
// before the instance accepts traffic (NFR-SEC-15). An entry that cannot be applied is REPORTED, never skipped: the caller refuses to start.

export type { PurgeJournalEntry };

/** The storage seam. The S3 implementation (journal-store.s3.ts) lives in the raw bucket outside any workspace prefix. */
export interface JournalStore {
  /** Writes a NEW object. Must fail rather than overwrite an existing key. */
  putNew(key: string, body: string): Promise<void>;
  list(prefix: string): Promise<readonly string[]>;
  get(key: string): Promise<string>;
}

export class InMemoryJournalStore implements JournalStore {
  readonly objects = new Map<string, string>();
  putNew(key: string, body: string): Promise<void> {
    if (this.objects.has(key)) return Promise.reject(new Error("journal key already exists"));
    this.objects.set(key, body);
    return Promise.resolve();
  }
  list(prefix: string): Promise<readonly string[]> {
    return Promise.resolve([...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort());
  }
  get(key: string): Promise<string> {
    const v = this.objects.get(key);
    return v === undefined ? Promise.reject(new Error("no such journal object")) : Promise.resolve(v);
  }
}

export class PurgeJournal {
  constructor(
    private readonly store: JournalStore,
    /** The `{env}` segment, so two environments sharing a bucket never read each other's purges. */
    private readonly env: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private get prefix(): string {
    return `purge-journal/${this.env}/`;
  }

  async append(input: PurgeJournalAppend): Promise<PurgeJournalEntry> {
    const parsed = purgeJournalAppendSchema.parse(input);
    const at = this.now();
    const entry = purgeJournalEntrySchema.parse({
      v: 1,
      id: randomUUID(),
      scope: parsed.scope,
      scope_id: parsed.scopeId,
      workspace_id: parsed.workspaceId,
      purged_at: at.toISOString(),
      reason: parsed.reason,
    });
    // ISO instants sort lexicographically; ":" is replaced because it is awkward in an object key.
    const key = `${this.prefix}${entry.purged_at.replaceAll(":", "-")}-${entry.id}.json`;
    await this.store.putNew(key, JSON.stringify(entry));
    return entry;
  }

  /** Every entry, oldest first. An unreadable or malformed object THROWS: a journal that cannot be read must not be treated as empty. */
  async entries(): Promise<PurgeJournalEntry[]> {
    const keys = await this.store.list(this.prefix);
    const out: PurgeJournalEntry[] = [];
    for (const key of keys) {
      const parsed = purgeJournalEntrySchema.safeParse(safeJson(await this.store.get(key)));
      if (!parsed.success) throw new Error(`purge journal object is unreadable: ${key}`);
      out.push(parsed.data);
    }
    return out.sort((a, b) => (a.purged_at < b.purged_at ? -1 : a.purged_at > b.purged_at ? 1 : 0));
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export interface ReplayResult {
  readonly replayed: number;
  readonly failed: readonly { readonly entry: PurgeJournalEntry; readonly error: string }[];
}

/** Re-applies every purge recorded after `snapshotAt`. `apply` must be idempotent (purging an already-absent subject succeeds). */
export async function replayPurgeJournal(
  journal: PurgeJournal,
  snapshotAt: Date,
  apply: (entry: PurgeJournalEntry) => Promise<void>,
): Promise<ReplayResult> {
  let replayed = 0;
  const failed: { entry: PurgeJournalEntry; error: string }[] = [];
  for (const entry of await journal.entries()) {
    if (new Date(entry.purged_at).getTime() <= snapshotAt.getTime()) continue;
    try {
      await apply(entry);
      replayed += 1;
    } catch (error) {
      failed.push({ entry, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return { replayed, failed };
}
