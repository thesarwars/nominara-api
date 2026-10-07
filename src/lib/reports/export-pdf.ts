import PDFDocument from "pdfkit";
import type { ExportDocument, MetricSummary } from "./export-document.js";

// NEW-E-100b — the PDF rendering of an ExportDocument, with pdfkit (pure JS,
// no headless browser, no network).
//
// NOTHING HERE FETCHES. Colours come from the stored theme (via the palette); the font is
// pdfkit's built-in Helvetica, whose metrics ship inside the package, so no
// font file is read or embedded and nothing is requested at render time. The
// theme's `font_family` (Inter / Geist) is NOT drawn: the API ships no font
// file for either yet (see the ticket note) - the document is Helvetica until
// the curated files are added to the API.
//
// THE FOOTER IS DRAWN THREE WAYS, none conditional on the theme or the
// sections: a strip on EVERY page, a closing Methodology block, and the PDF
// information dictionary (plain text in the file, so the artifact describes
// itself even to a tool that never renders a page).

const MARGIN = 50;
const STRIP_HEIGHT = 46;
const DASH = "—";

export interface RenderPdfOptions {
  /** Content-stream compression. On in production; tests turn it off to read the text back. */
  compress?: boolean;
}

/** Standard-font safe text: WinAnsi covers Latin-1 and a few punctuation marks; everything else becomes `?`. */
function printable(value: string): string {
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
      .replace(/[^ -~¡-ÿ–—‘’“”•€…\n]/g, "?")
  );
}

function percent(value: number | null): string {
  return value === null ? DASH : `${String(Math.round(value * 100))}%`;
}

function score(value: number | null): string {
  return value === null ? DASH : String(Number(value.toFixed(1)));
}

function confidenceLabel(summary: MetricSummary): string {
  return summary.confidence === null ? DASH : summary.confidence === "low" ? "low confidence" : summary.confidence;
}

/** Black or white, whichever reads on `hex`. */
function onColour(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const luminance = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return luminance > 0.6 ? "#000000" : "#ffffff";
}

export function renderPdf(doc: ExportDocument, options: RenderPdfOptions = {}): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const { palette, footer } = doc;
    const pdf = new PDFDocument({
      size: "LETTER",
      margins: { top: MARGIN, left: MARGIN, right: MARGIN, bottom: MARGIN + STRIP_HEIGHT },
      bufferPages: true,
      compress: options.compress ?? true,
      info: {
        Title: printable(`${doc.projectName} - visibility report`),
        Subject: printable(footer.note),
        Keywords: printable(`scoring_version:${footer.scoring_version}; data_through:${footer.data_through ?? "none"}; timeframe:${footer.timeframe}`),
        CreationDate: new Date(doc.generatedAt),
      },
    });
    const chunks: Buffer[] = [];
    pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);

    try {
      const width = pdf.page.width - MARGIN * 2;
      const paintBackground = (): void => {
        pdf.save().rect(0, 0, pdf.page.width, pdf.page.height).fill(palette.background).restore();
      };
      paintBackground();
      pdf.on("pageAdded", paintBackground);

      const maxY = (): number => pdf.page.height - pdf.page.margins.bottom;
      const ensure = (height: number): void => {
        if (pdf.y + height > maxY()) pdf.addPage();
      };
      const text = (value: string, size: number, bold = false, color: string = palette.foreground): void => {
        pdf.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor(color).text(printable(value), MARGIN, pdf.y, { width });
      };

      // Header band
      pdf.save().rect(0, 0, pdf.page.width, 74).fill(palette.primary).restore();
      const onPrimary = onColour(palette.primary);
      pdf.font("Helvetica-Bold").fontSize(18).fillColor(onPrimary).text(printable(doc.projectName), MARGIN, 22, { width });
      pdf.font("Helvetica").fontSize(9).fillColor(onPrimary).text(
        printable(`Visibility report - ${doc.window.from} to ${doc.window.to} (${doc.timeframe})`),
        MARGIN,
        48,
        { width },
      );
      if (palette.showBrandLine) {
        pdf.font("Helvetica").fontSize(8).fillColor(onPrimary).text("Powered by Nominara", MARGIN, 48, { width, align: "right" });
      }
      pdf.y = 92;

      const heading = (value: string): void => {
        ensure(60);
        pdf.moveDown(0.6);
        text(value, 13, true, palette.primary);
        pdf.moveDown(0.3);
      };

      // A fixed-column table; cells never wrap, long ones are clipped by width.
      const table = (columns: ReadonlyArray<{ label: string; width: number }>, rows: string[][], boldLast = false): void => {
        const drawRow = (cells: readonly string[], bold: boolean, color: string): void => {
          ensure(16);
          const y = pdf.y;
          let x = MARGIN;
          pdf.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8).fillColor(color);
          columns.forEach((column, index) => {
            pdf.text(printable(cells[index] ?? ""), x, y, { width: column.width - 4, height: 11, lineBreak: false, ellipsis: true });
            x += column.width;
          });
          pdf.y = y + 14;
        };
        drawRow(columns.map((c) => c.label), true, palette.accent === palette.background ? palette.foreground : palette.primary);
        rows.forEach((cells, index) => drawRow(cells, boldLast && index === rows.length - 1, palette.foreground));
      };

      const summaryColumns = [
        { label: "Engine", width: 100 },
        { label: "Visibility", width: 60 },
        { label: "Presence", width: 55 },
        { label: "Share of voice", width: 70 },
        { label: "Sentiment", width: 55 },
        { label: "Citations", width: 55 },
        { label: "Cells", width: 35 },
        { label: "Confidence", width: 65 },
        { label: "Source", width: 40 },
      ];
      const summaryRow = (label: string, s: MetricSummary): string[] => [
        label,
        score(s.visibilityScore),
        percent(s.presenceRate),
        percent(s.shareOfVoice),
        score(s.sentimentScore),
        percent(s.citationShare),
        String(s.measuredCells),
        confidenceLabel(s),
        s.dataSource ?? DASH,
      ];

      for (const section of doc.sections) {
        if (section.kind === "overview") {
          heading("Overview");
          table(summaryColumns, [...section.engines.map((e) => summaryRow(e.engineKey, e)), summaryRow("All engines (blend)", section.blended)], true);
        } else if (section.kind === "growth_map") {
          heading("Growth map - visibility score by day");
          const keys = section.engineKeys;
          const each = Math.max(40, Math.floor((width - 70 - 50) / Math.max(keys.length, 1)));
          const columns = [{ label: "Date", width: 70 }, ...keys.map((key) => ({ label: key, width: each })), { label: "Blend", width: 50 }];
          if (section.days.length === 0) text(`${DASH} no days measured in this window`, 9);
          else table(columns, section.days.map((day) => [day.date, ...keys.map((key) => score(day.byEngine[key] ?? null)), score(day.blended)]));
        } else {
          heading("Competitors");
          if (section.competitors.length === 0) text(`${DASH} no competitor measured in this window`, 9);
          for (const competitor of section.competitors) {
            ensure(60);
            text(competitor.name, 10, true);
            table(summaryColumns, [...competitor.engines.map((e) => summaryRow(e.engineKey, e)), summaryRow("All engines (blend)", competitor.blended)], true);
            pdf.moveDown(0.5);
          }
        }
      }
      for (const name of doc.unavailableSections) {
        ensure(24);
        text(`The ${name} section is not available in this export version.`, 9);
      }

      // Methodology block (the footer, in full)
      ensure(150);
      pdf.moveDown(1);
      text("Methodology", 13, true, palette.primary);
      pdf.moveDown(0.3);
      const sources = footer.engine_data_sources.map((s) => `${s.engine_key} (${s.data_source ?? DASH})`).join(", ");
      const overrides = footer.weight_overrides === null ? "none" : Object.entries(footer.weight_overrides).map(([k, v]) => `${k} ${String(v)}`).join(", ");
      for (const line of [
        `Data through: ${footer.data_through ?? DASH}`,
        `Engines included: ${sources === "" ? DASH : sources}`,
        `Timeframe: ${footer.timeframe}`,
        `Sample size: ${String(footer.sample_size)}`,
        `Live capture ratio: ${percent(footer.live_capture_ratio)}`,
        `Scoring version: ${footer.scoring_version}`,
        `Weight overrides: ${overrides}`,
      ]) {
        text(line, 9);
      }
      pdf.moveDown(0.3);
      text(footer.note, 9);

      // The strip, on every page. Drawn last so the page count is final; the bottom margin
      // is lifted only for the strip itself so pdfkit does not add a page for it.
      const range = pdf.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i += 1) {
        pdf.switchToPage(i);
        const bottom = pdf.page.margins.bottom;
        pdf.page.margins.bottom = 0;
        pdf.save();
        pdf.moveTo(MARGIN, pdf.page.height - STRIP_HEIGHT).lineTo(pdf.page.width - MARGIN, pdf.page.height - STRIP_HEIGHT).lineWidth(0.5).stroke(palette.accent);
        pdf.font("Helvetica").fontSize(6.5).fillColor(palette.foreground).text(
          printable(`Methodology: ${footer.note} Scoring version ${footer.scoring_version}; data through ${footer.data_through ?? DASH}.`),
          MARGIN,
          pdf.page.height - STRIP_HEIGHT + 6,
          { width, lineBreak: true, height: STRIP_HEIGHT - 10 },
        );
        pdf.restore();
        pdf.page.margins.bottom = bottom;
      }
      pdf.end();
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
