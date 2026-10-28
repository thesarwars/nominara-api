import { CORPUS } from "./constants.js";

// STORY-058 AC5 / step 4 - chunk a readable document: 512 tokens, 64-token overlap, splitting on heading and paragraph boundaries
// FIRST and falling back to sentences, then words, only for a block that cannot fit on its own.
//
//  - A heading line (`#`...) always opens a new chunk: a chunk never spans two sections, so a passage is about one thing.
//  - Whole paragraphs are packed into a chunk while they fit.
//  - Overlap is applied only where a chunk boundary falls INSIDE one section (a long section carried over); a heading boundary is a
//    change of subject, and repeating the previous section's tail under the new heading would blur it.
//  - The counter is a PORT. The real one is the embedding model's tokenizer (STORY-050's cl100k); every chunk's tokenCount is what
//    that counter said, and no chunk exceeds the size by that same counter.

export interface TokenCounter {
  count(text: string): number;
}

export interface Chunk {
  readonly index: number;
  readonly text: string;
  readonly tokenCount: number;
}

export interface ChunkOptions {
  readonly size?: number;
  readonly overlap?: number;
}

/** Splits `text` into pieces that each fit `size`, on sentence ends then on whitespace. A single unbreakable word is cut by characters. */
function splitToFit(text: string, size: number, counter: TokenCounter): string[] {
  if (counter.count(text) <= size) return [text];
  const sentences = text.split(/(?<=[.!?])\s+/);
  const units = sentences.length > 1 ? sentences : text.split(/\s+/);
  if (units.length === 1) {
    // One unit (a word with no whitespace) larger than the size: cut by characters, halving until each piece fits.
    const half = Math.max(1, Math.floor(text.length / 2));
    return [...splitToFit(text.slice(0, half), size, counter), ...splitToFit(text.slice(half), size, counter)];
  }
  const out: string[] = [];
  let current = "";
  for (const unit of units) {
    const joined = current === "" ? unit : `${current} ${unit}`;
    if (counter.count(joined) <= size) {
      current = joined;
      continue;
    }
    if (current !== "") out.push(current);
    if (counter.count(unit) <= size) current = unit;
    else {
      const pieces = splitToFit(unit, size, counter);
      current = pieces.pop() ?? "";
      out.push(...pieces);
    }
  }
  if (current !== "") out.push(current);
  return out;
}

/** The longest whole-word suffix of `text` that is at most `overlap` tokens. */
function overlapTail(text: string, overlap: number, counter: TokenCounter): string {
  if (overlap <= 0) return "";
  const words = text.split(/\s+/);
  let lo = 0;
  let hi = words.length - 1; // never the whole chunk: that would not advance
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (counter.count(words.slice(-mid).join(" ")) <= overlap) lo = mid;
    else hi = mid - 1;
  }
  return words.slice(words.length - lo).join(" ");
}

export function chunkDocument(document: string, counter: TokenCounter, options: ChunkOptions = {}): Chunk[] {
  const size = options.size ?? CORPUS.chunkTokens;
  const overlap = Math.min(options.overlap ?? CORPUS.chunkOverlapTokens, Math.floor(size / 2));
  const blocks = document.split(/\n{2,}/).map((block) => block.trim()).filter((block) => block !== "");

  // Sections: a heading block opens one.
  const sections: string[][] = [];
  for (const block of blocks) {
    if (block.startsWith("#") || sections.length === 0) sections.push([block]);
    else sections[sections.length - 1]!.push(block);
  }

  const chunks: Chunk[] = [];
  const push = (text: string): void => {
    chunks.push({ index: chunks.length, text, tokenCount: counter.count(text) });
  };

  for (const section of sections) {
    // Every unit below fits `size` on its own. A block too big for one chunk is cut to `size - overlap`, so the overlap carried from
    // the previous piece still fits beside it.
    const units = section.flatMap((block) => (counter.count(block) <= size ? [block] : splitToFit(block, size - overlap, counter)));
    let current = "";
    let carried = false; // current is nothing but overlap
    for (const unit of units) {
      const joined = current === "" ? unit : `${current}\n\n${unit}`;
      if (counter.count(joined) <= size) {
        current = joined;
        carried = false;
        continue;
      }
      if (current !== "" && !carried) push(current);
      const tail = current === "" ? "" : overlapTail(current, overlap, counter);
      const withTail = tail === "" ? unit : `${tail}\n\n${unit}`;
      if (tail !== "" && counter.count(withTail) <= size) {
        current = withTail;
      } else {
        current = unit;
      }
      carried = false;
    }
    if (current !== "") push(current);
  }
  return chunks;
}
