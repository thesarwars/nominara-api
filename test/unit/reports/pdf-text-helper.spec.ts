import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { pdfText } from "../../support/pdf-text.js";

// The test helper that reads an exported PDF back. A FlateDecode stream ends with the adler32
// checksum, whose last byte is content-dependent: when it is 0x0D the stream is "...\r\nendstream".
// The helper must not take that byte for a line ending, or the whole content stream fails to inflate
// and the document reads as EMPTY (a 1-in-256 failure that moves with the exported dates).

function pdfWith(content: string): Buffer {
  const body = deflateSync(Buffer.from(content, "latin1"));
  return Buffer.concat([
    Buffer.from(`%PDF-1.3\n5 0 obj\n<<\n/Length ${String(body.length)}\n/Filter /FlateDecode\n>>\nstream\n`, "latin1"),
    body,
    Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1"),
  ]);
}

/** A content stream whose deflate output ends in the byte `last`, found by padding with a comment. */
function contentEndingIn(last: number): string {
  for (let pad = 0; pad < 4096; pad += 1) {
    const content = `BT /F1 12 Tf [<4d6574686f646f6c6f6779>] TJ ET % ${String(pad)}`;
    const z = deflateSync(Buffer.from(content, "latin1"));
    if (z[z.length - 1] === last) return content;
  }
  throw new Error("no padding gave the wanted final byte");
}

describe("pdf-text helper", () => {
  it("reads a Flate stream whose final checksum byte is 0x0D (CR)", () => {
    expect(pdfText(pdfWith(contentEndingIn(0x0d)))).toBe("Methodology");
  });

  it("reads a Flate stream whose final checksum byte is 0x0A (LF)", () => {
    expect(pdfText(pdfWith(contentEndingIn(0x0a)))).toBe("Methodology");
  });

  it("reads an ordinary Flate stream", () => {
    expect(pdfText(pdfWith(contentEndingIn(0x41)))).toBe("Methodology");
  });
});
