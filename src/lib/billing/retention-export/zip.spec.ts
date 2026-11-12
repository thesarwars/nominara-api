import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createZip, ZipLimitError } from "./zip.js";

// STORY-185 - the archive writer. Read back with an independent reader written here (the central directory, then inflate), and with the
// system `unzip -t` when it exists: a writer verified only by its own reader would prove nothing.

const AT = new Date("2026-11-12T10:00:00Z");

function read(zip: Buffer): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThan(-1);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const packed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLen = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const body = inflateRawSync(zip.subarray(dataAt, dataAt + packed));
    expect(body.length).toBe(size);
    out.set(name, body);
    at += 46 + nameLen;
  }
  return out;
}

describe("STORY-185 · the zip writer", () => {
  it("round-trips every entry, in a folder, byte for byte, including non-ASCII names and empty files", () => {
    const entries = [
      { name: "manifest.json", data: Buffer.from('{"a":1}') },
      { name: "proj-1/answers.jsonl", data: Buffer.from("x".repeat(100_000)) },
      { name: "proj-é/empty.csv", data: Buffer.alloc(0) },
    ];
    const got = read(createZip(entries, AT));
    expect([...got.keys()]).toEqual(entries.map((e) => e.name));
    for (const e of entries) expect(got.get(e.name)!.equals(Buffer.from(e.data))).toBe(true);
  });

  it("is deterministic for the same input and timestamp", () => {
    const e = [{ name: "a.txt", data: Buffer.from("hello") }];
    expect(createZip(e, AT).equals(createZip(e, AT))).toBe(true);
  });

  it("is a valid archive to the system unzip (skipped where unzip is absent)", () => {
    let has = true;
    try {
      execFileSync("unzip", ["-v"], { stdio: "ignore" });
    } catch {
      has = false;
    }
    if (!has) return;
    const dir = mkdtempSync(path.join(tmpdir(), "zipspec-"));
    const file = path.join(dir, "t.zip");
    writeFileSync(file, createZip([{ name: "p/a.csv", data: Buffer.from("a,b\n1,2\n") }, { name: "manifest.json", data: Buffer.from("{}") }], AT));
    expect(execFileSync("unzip", ["-t", file]).toString()).toContain("No errors detected");
  });

  it("refuses an unsafe or duplicate name rather than writing it", () => {
    for (const name of ["", "/abs", "../up", "a//b", "a/./b", "a\\b"]) {
      expect(() => createZip([{ name, data: Buffer.from("x") }], AT), name).toThrow();
    }
    expect(() => createZip([{ name: "a", data: Buffer.from("x") }, { name: "a", data: Buffer.from("y") }], AT)).toThrow(/duplicate/);
  });

  it("refuses more entries than a non-ZIP64 archive can name, with a typed error", () => {
    const many = Array.from({ length: 65_536 }, (_, i) => ({ name: `f${String(i)}`, data: Buffer.alloc(0) }));
    expect(() => createZip(many, AT)).toThrow(ZipLimitError);
  });
});
