import { createHash } from "node:crypto";
import {
  EmbeddingProviderError,
  type EmbeddingBatchResult,
  type EmbeddingProvider,
} from "../ports/embedding-provider.js";

// STORY-133 - owner decision 2026-10-28 #1: until the real key arrives, the port is filled by a deterministic stand-in.
//
// What it is: feature-hashed bag of words, L2-normalised. Two texts sharing most of their words get a high cosine, so the
// suppression layers behave plausibly against it; two unrelated texts get a cosine near zero. It is NOT semantic - synonyms do not
// match - and that is the whole difference from the real model.
//
// What it must never be: a vector of zeros (every pair at cosine 1.0, so L2 suppresses everything and a run reports a 100% cache
// hit rate while capturing nothing). An empty text hashes its literal marker, so no input yields a zero vector.
//
// It names itself `stand-in-bow-1536`, so rows it wrote are visibly not a real model's (EC-23) and a later re-embed can find them.
// Usage is the whitespace word count - a deterministic figure standing in for the provider's report, labelled by the model name.

export const STAND_IN_EMBEDDING_MODEL = "stand-in-bow-1536";
const DIMENSIONS = 1536;

function hashedVector(text: string): number[] {
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);
  const tokens = words.length > 0 ? words : ["\u0000empty"];
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const token of tokens) {
    const digest = createHash("sha256").update(token).digest();
    const slot = digest.readUInt32BE(0) % DIMENSIONS;
    vector[slot] = (vector[slot] ?? 0) + ((digest[4]! & 1) === 0 ? 1 : -1);
  }
  let length = Math.hypot(...vector);
  if (length === 0) {
    // Opposite-signed tokens landed on one slot and cancelled. Never hand back a zero vector: pin the first axis.
    vector[0] = 1;
    length = 1;
  }
  return vector.map((component) => component / length);
}

export class StandInEmbeddingProvider implements EmbeddingProvider {
  readonly model = STAND_IN_EMBEDDING_MODEL;
  readonly dimensions = DIMENSIONS;

  async embed(texts: readonly string[]): Promise<EmbeddingBatchResult> {
    if (texts.length === 0 || texts.length > 96) {
      throw new EmbeddingProviderError("a batch is 1 to 96 texts", { retryable: false });
    }
    const totalTokens = texts.reduce((sum, text) => sum + Math.max(1, text.split(/\s+/).filter(Boolean).length), 0);
    return { vectors: texts.map(hashedVector), model: this.model, totalTokens };
  }
}
