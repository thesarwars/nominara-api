import { inflateSync } from "node:zlib";

// NEW-E-100b — test helper: the text a PDF shows, read back from an
// UNCOMPRESSED pdfkit file. pdfkit's standard fonts write each run as
// `[<hex> kern <hex> ...] TJ`, with WinAnsi codes; this decodes them, joins the
// runs with a space and collapses whitespace so a wrapped line reads as one.
export function pdfText(pdf: Buffer): string {
  const source = inflatedSource(pdf);
  const runs: string[] = [];
  for (const op of source.matchAll(/\[((?:<[0-9a-fA-F]*>|\s|-?\d+(?:\.\d+)?)*)\]\s*TJ/g)) {
    const pieces = [...op[1]!.matchAll(/<([0-9a-fA-F]*)>/g)].map((m) => Buffer.from(m[1]!, "hex").toString("latin1"));
    runs.push(pieces.join(""));
  }
  return runs.join(" ").replace(/\s+/g, " ").replace(/\u0097/g, "—").trim();
}

/** The document-information dictionary and every other literal string (plain text in an uncompressed file). */
export function pdfRaw(pdf: Buffer): string {
  return pdf.toString("latin1");
}

/** The file's own text plus every FlateDecode stream inflated, so a COMPRESSED export can be read back too. */
export function inflatedSource(pdf: Buffer): string {
  const raw = pdf.toString("latin1");
  const parts = [raw];
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try {
      parts.push(inflateSync(Buffer.from(match[1]!, "latin1")).toString("latin1"));
    } catch {
      // not a Flate stream (an image, an already-plain stream): its bytes are in `raw`
    }
  }
  return parts.join("\n");
}
