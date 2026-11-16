// STORY-049 AC11 — "crawled content is treated as untrusted: size caps, no script execution in the plain fetch, and
// sanitisation before storage".
//
// WHAT "SANITISATION" IS HERE, AND WHAT IT IS NOT. A page's bytes are stored exactly as fetched, gzipped, in object
// storage, under a content type that is never HTML. Stripping scripts from them would destroy the evidence the render-mode
// rules need (AUX-R-027: JSON-LD injected client-side only exists in the script a site ships), and an audit that
// rewrote its own evidence could not be reproduced from storage. The bytes are inert there: nothing serves them to a
// browser, and the plain fetch never executed them.
//
// What IS sanitised is every piece of crawled TEXT that reaches Postgres or a log line: the robots.txt snapshot, a page
// URL, a failure reason. Those go through this function, because a NUL character makes a Postgres `text` insert fail
// (one hostile robots.txt would fail the whole audit write), and a lone surrogate is not valid UTF-8.

/** The default ceiling for one stored crawled string. robots.txt past 500 KB is itself an AUX-R-003 finding, so this clears it. */
export const MAX_STORED_TEXT_CHARS = 1_000_000;

// C0 except TAB, LF, CR; DEL; C1. NUL is in the C0 range.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

export function sanitiseText(value: string, max: number = MAX_STORED_TEXT_CHARS): string {
  let out = value.replace(CONTROL, "").replace(LONE_SURROGATE, "�");
  if (out.length > max) {
    out = out.slice(0, max);
    const last = out.charCodeAt(out.length - 1);
    // A cut that lands between the halves of a pair would leave a lone high surrogate: drop it whole.
    if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  }
  return out;
}

/**
 * STORY-049 AC4 - the robots.txt snapshot, VERBATIM, beside the hash taken over the same bytes.
 *
 * "Verbatim" is what lets a finding quote the exact matching line rather than a paraphrase, and what lets anyone check the snapshot
 * against `robots_hash`: the stored text's UTF-8 bytes hash to the stored hash. So the text is stored exactly as decoded, with NO
 * sanitising and no length cut (a robots.txt past 500 KB is an AUX-R-003 finding, and the fetch itself is capped by the 5 MB response limit),
 * whenever that is possible.
 *
 * It is not possible in two cases, and ONLY those fall back to `sanitiseText`: the file holds a NUL byte (Postgres `text` cannot store one,
 * and a single hostile robots.txt would fail the whole audit write), or it is not valid UTF-8 (a decode replaces the bad bytes, so the text
 * no longer re-encodes to what was fetched). There the hash over the raw bytes is still what proves what was fetched. Any other control
 * character is stored as it came: it is inert in a text column, and rendering it safely is the reader's job, as for any crawled text.
 */
export function robotsSnapshotOf(raw: Buffer, decoded: string): string {
  const storable = !decoded.includes("\u0000") && Buffer.from(decoded, "utf8").equals(raw);
  return storable ? decoded : sanitiseText(decoded);
}
