// NEW-E-100b — test helper: the text a PDF shows, read back from an
// UNCOMPRESSED pdfkit file. pdfkit's standard fonts write each run as
// `[<hex> kern <hex> ...] TJ`, with WinAnsi codes; this decodes them, joins the
// runs with a space and collapses whitespace so a wrapped line reads as one.
export function pdfText(pdf: Buffer): string {
  const source = pdf.toString("latin1");
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
