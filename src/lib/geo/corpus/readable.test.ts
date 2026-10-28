import { describe, expect, it } from "vitest";
import { extractReadable } from "./readable.js";

// STORY-058 AC4 - "readable extraction": the page's substance, headings kept as boundaries, boilerplate dropped.
describe("extractReadable", () => {
  const page = `<html><head><title>t</title><script>var x = 'SECRET_SCRIPT';</script><style>.a{}</style></head>
  <body><nav><a href="/">Home</a><a href="/p">Pricing</a></nav>
  <header>Site header</header>
  <main><h1>Reporting basics</h1><p>Teams compare   reporting tools.</p><h2>Exports</h2><p>CSV and PDF exports.</p><ul><li>one</li><li>two</li></ul></main>
  <aside>Related links</aside><footer>Copyright footer</footer></body></html>`;

  it("AC4 - headings become marker lines and blocks are blank-line separated", () => {
    const text = extractReadable(page);
    expect(text).toBe("# Reporting basics\n\nTeams compare reporting tools.\n\n## Exports\n\nCSV and PDF exports.\n\none\n\ntwo");
  });
  it("AC4 - script, style, nav, header, aside and footer text never reaches the output", () => {
    const text = extractReadable(page);
    for (const gone of ["SECRET_SCRIPT", "Home", "Pricing", "Site header", "Related links", "Copyright"]) expect(text).not.toContain(gone);
  });
  it("AC4 - without main or article the body's own text is used", () => {
    expect(extractReadable("<body><p>Just a paragraph.</p></body>")).toBe("Just a paragraph.");
  });
  it("AC4 - empty and non-html input give an empty string", () => {
    expect(extractReadable("")).toBe("");
    expect(extractReadable("<body><script>x</script></body>")).toBe("");
  });
  it("AC4 - NUL and control characters are removed before storage", () => {
    expect(extractReadable("<body><p>ab\u0000c</p></body>")).toBe("abc");
  });
});
