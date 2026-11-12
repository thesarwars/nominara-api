import { crc32, deflateRawSync } from "node:zlib";

// STORY-185 - a minimal ZIP writer over node:zlib (no dependency: owner decision 100(c) and the no-new-dependency rule; the
// repository has no zip library of its own, only transitive ones behind testcontainers and pdfkit).
//
// What it writes: the classic ZIP container, one local header + data per entry, a central directory, an end-of-central-directory record.
// DEFLATE (method 8) for everything, UTF-8 file names (general-purpose flag bit 11), a fixed DOS timestamp supplied by the caller (so the
// same input is the same bytes). What it refuses rather than doing wrongly: ZIP64. A total over 4 GiB, an entry over 4 GiB, or more than
// 65,535 entries throws `ZipLimitError`; the export job turns that into a failed export with a stable code, never a corrupt archive.

export class ZipLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipLimitError";
  }
}

export interface ZipEntry {
  /** A relative path with `/` separators; no leading slash, no `..`, no empty segment. */
  readonly name: string;
  readonly data: Uint8Array;
}

const MAX_32 = 0xffff_ffff;
const MAX_ENTRIES = 0xffff;

function dosDateTime(at: Date): { time: number; date: number } {
  const year = Math.max(1980, at.getUTCFullYear());
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

function assertName(name: string): void {
  if (name === "" || name.startsWith("/") || name.split("/").some((segment) => segment === "" || segment === "." || segment === "..") || name.includes("\\")) {
    throw new Error("zip entry name must be a relative path of non-empty segments");
  }
}

export function createZip(entries: readonly ZipEntry[], modifiedAt: Date): Buffer {
  if (entries.length > MAX_ENTRIES) throw new ZipLimitError("too many entries for a non-ZIP64 archive");
  const { time, date } = dosDateTime(modifiedAt);
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const seen = new Set<string>();

  for (const entry of entries) {
    assertName(entry.name);
    if (seen.has(entry.name)) throw new Error("duplicate zip entry name");
    seen.add(entry.name);
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength);
    const packed = deflateRawSync(raw);
    const sum = crc32(raw);
    if (raw.length > MAX_32 || packed.length > MAX_32 || offset > MAX_32) throw new ZipLimitError("entry or archive over 4 GiB needs ZIP64");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // made by
    dir.writeUInt16LE(20, 6); // needed
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(sum, 16);
    dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);

    parts.push(local, name, packed);
    central.push(dir, name);
    offset += local.length + name.length + packed.length;
  }

  const centralSize = central.reduce((n, b) => n + b.length, 0);
  if (offset + centralSize > MAX_32) throw new ZipLimitError("archive over 4 GiB needs ZIP64");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}
