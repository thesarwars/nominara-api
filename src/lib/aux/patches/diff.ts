// STORY-053 — a minimal unified diff for the text a patch changes (robots.txt, llms.txt, a page's markdown). Line-based LCS over the
// part between the common prefix and suffix. Bounded: a patch is a small edit to a small file, and a quadratic table over a
// huge one is not worth stating; the caller then stores no diff (null), never an empty one.

export const MAX_DIFF_LINES = 5000;
const MAX_TABLE_CELLS = 4_000_000;
const CONTEXT = 3;

const linesOf = (text: string): string[] => {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
};

type Op = { readonly t: " " | "-" | "+"; readonly line: string };

/** "" when the texts are identical, null when too large to diff. */
export function unifiedDiff(path: string, before: string, after: string): string | null {
  const a = linesOf(before);
  const b = linesOf(after);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return null;

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  if (midA.length === 0 && midB.length === 0) return "";
  if (midA.length * midB.length > MAX_TABLE_CELLS) return null;

  // lcs[i][j] = length of the LCS of midA[i..] and midB[j..]
  const width = midB.length + 1;
  const lcs = new Uint32Array((midA.length + 1) * width);
  for (let i = midA.length - 1; i >= 0; i -= 1) {
    for (let j = midB.length - 1; j >= 0; j -= 1) {
      lcs[i * width + j] = midA[i] === midB[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  const ops: Op[] = a.slice(0, prefix).map((line) => ({ t: " ", line }));
  let i = 0;
  let j = 0;
  while (i < midA.length || j < midB.length) {
    if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
      ops.push({ t: " ", line: midA[i]! });
      i += 1;
      j += 1;
    } else if (i < midA.length && (j === midB.length || lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!)) {
      // Deletions first: a replacement reads as "-old" then "+new".
      ops.push({ t: "-", line: midA[i]! });
      i += 1;
    } else {
      ops.push({ t: "+", line: midB[j]! });
      j += 1;
    }
  }
  for (const line of a.slice(a.length - suffix)) ops.push({ t: " ", line });

  const changed: number[] = [];
  ops.forEach((op, index) => {
    if (op.t !== " ") changed.push(index);
  });
  // Group changes whose context would touch.
  const ranges: [number, number][] = [];
  for (const index of changed) {
    const from = Math.max(0, index - CONTEXT);
    const to = Math.min(ops.length - 1, index + CONTEXT);
    const last = ranges[ranges.length - 1];
    if (last !== undefined && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  }

  let out = `--- a/${path}\n+++ b/${path}\n`;
  for (const [from, to] of ranges) {
    let oldBefore = 0;
    let newBefore = 0;
    for (let k = 0; k < from; k += 1) {
      if (ops[k]!.t !== "+") oldBefore += 1;
      if (ops[k]!.t !== "-") newBefore += 1;
    }
    const slice = ops.slice(from, to + 1);
    const oldLen = slice.filter((o) => o.t !== "+").length;
    const newLen = slice.filter((o) => o.t !== "-").length;
    out += `@@ -${oldBefore + (oldLen > 0 ? 1 : 0)},${oldLen} +${newBefore + (newLen > 0 ? 1 : 0)},${newLen} @@\n`;
    for (const op of slice) out += `${op.t}${op.line}\n`;
  }
  return out;
}
