import { inflateSync } from "node:zlib";

// NEW-E-100b — test helper: the text a PDF shows, read back from a pdfkit file.
//
// pdfkit embeds a TrueType font as a SUBSET: each run is `/F<n> <size> Tf` followed by
// `[<gid> kern <gid> ...] TJ`, where a gid is a 2-byte glyph id in that font's subset. The subset's
// `/ToUnicode` CMap maps gid -> text, so this reads the map for the font in force and decodes through it.
// A run in a one-byte WinAnsi font (a built-in font) is decoded as latin1, as before.
// Whitespace is collapsed so a wrapped line reads as one.

/** The file as text, with every FlateDecode stream inflated IN PLACE, so a COMPRESSED export reads like a plain one. */
// The data ends at the LF before `endstream` and no earlier: a Flate stream's last byte (the adler32 checksum) can itself be 0x0D,
// and treating it as part of a CRLF drops it, the stream fails to inflate, and the page reads as empty.
export function inflatedSource(pdf: Buffer): string {
  return pdf.toString("latin1").replace(/stream\r?\n([\s\S]*?)\nendstream/g, (whole, data: string) => {
    try {
      return `stream\n${inflateSync(Buffer.from(data, "latin1")).toString("latin1")}\nendstream`;
    } catch {
      return whole; // not a Flate stream: left as it is
    }
  });
}

function objectBodies(source: string): Map<number, string> {
  const bodies = new Map<number, string>();
  for (const m of source.matchAll(/(?:^|\n)(\d+) 0 obj\b([\s\S]*?)\bendobj/g)) bodies.set(Number(m[1]), m[2]!);
  return bodies;
}

/** gid -> text, for the font object `fontObj`, from its /ToUnicode CMap. Undefined for a font without one. */
function toUnicodeOf(bodies: Map<number, string>, fontObj: number): Map<number, string> | undefined {
  const ref = /\/ToUnicode (\d+) 0 R/.exec(bodies.get(fontObj) ?? "");
  const cmap = ref === null ? undefined : bodies.get(Number(ref[1]));
  if (cmap === undefined) return undefined;
  const map = new Map<number, string>();
  const text = (hex: string): string => Buffer.from(hex, "hex").swap16().toString("utf16le");
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const e of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(e[1]!, 16), text(e[2]!));
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    // `<first> <last> [<text> <text> ...]` (pdfkit's form: one entry per glyph) or `<first> <last> <start-text>`
    for (const e of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:\[([^\]]*)\]|<([0-9a-fA-F]+)>)/g)) {
      const first = parseInt(e[1]!, 16);
      const last = parseInt(e[2]!, 16);
      if (e[3] !== undefined) {
        [...e[3].matchAll(/<([0-9a-fA-F]+)>/g)].forEach((entry, i) => map.set(first + i, text(entry[1]!)));
      } else {
        const start = Buffer.from(e[4]!, "hex").readUInt16BE(0);
        for (let g = first; g <= last; g += 1) map.set(g, String.fromCharCode(start + (g - first)));
      }
    }
  }
  return map;
}

export function pdfText(pdf: Buffer): string {
  const source = inflatedSource(pdf);
  const bodies = objectBodies(source);
  const fontObjByName = new Map<string, number>();
  for (const m of source.matchAll(/\/(F\d+) (\d+) 0 R/g)) fontObjByName.set(m[1]!, Number(m[2]));
  const maps = new Map<string, Map<number, string> | undefined>();
  const mapFor = (name: string): Map<number, string> | undefined => {
    if (!maps.has(name)) {
      const obj = fontObjByName.get(name);
      maps.set(name, obj === undefined ? undefined : toUnicodeOf(bodies, obj));
    }
    return maps.get(name);
  };

  const runs: string[] = [];
  let font = "";
  // Linear scan of the two operators that matter, in stream order.
  for (const op of source.matchAll(/\/(F\d+) [\d.]+ Tf|\[([^\]\n]*)\]\s*TJ/g)) {
    if (op[1] !== undefined) {
      font = op[1];
      continue;
    }
    const cmap = mapFor(font);
    const pieces = [...op[2]!.matchAll(/<([0-9a-fA-F]*)>/g)].map((m) => {
      const bytes = Buffer.from(m[1]!, "hex");
      if (cmap === undefined) return bytes.toString("latin1");
      let out = "";
      for (let i = 0; i + 1 < bytes.length; i += 2) out += cmap.get(bytes.readUInt16BE(i)) ?? "?";
      return out;
    });
    runs.push(pieces.join(""));
  }
  return runs.join(" ").replace(/\s+/g, " ").replace(/\u0097/g, "—").trim();
}

/** The document-information dictionary and every other literal string (plain text in an uncompressed file). */
export function pdfRaw(pdf: Buffer): string {
  return pdf.toString("latin1");
}
