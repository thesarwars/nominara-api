import { describe, expect, it } from "vitest";
import {
  decryptGraceSuccessor,
  encryptGraceSuccessor,
  generateRefreshToken,
  hashRefreshToken,
  parseGraceSlot,
  serializeGraceSlot,
} from "../../src/lib/auth/refresh-token.js";

// STORY-170 — the refresh-token grace window keeps the successor encrypted
// under a key derived from the PREDECESSOR token (security-and-tenancy.md §5).
// These are written from the hazard: the stored slot must be useless to
// anyone who does not hold the token the rotation consumed.
const SESSION = "01a0ec14-03d0-72f7-bb6f-4d6f2afcfa54";
const OTHER_SESSION = "01a0ec14-03d0-72f7-bb6f-4d6f2afcfa55";

describe("STORY-170 · grace-window successor encryption", () => {
  it("the caller presenting the predecessor recovers the exact successor", () => {
    const predecessor = generateRefreshToken();
    const successor = generateRefreshToken();
    const sealed = encryptGraceSuccessor(SESSION, predecessor, successor);
    expect(decryptGraceSuccessor(SESSION, predecessor, sealed)).toBe(successor);
  });

  it("⚠ a leaked row is useless without the predecessor — any other token fails", () => {
    const sealed = encryptGraceSuccessor(SESSION, generateRefreshToken(), generateRefreshToken());
    expect(() => decryptGraceSuccessor(SESSION, generateRefreshToken(), sealed)).toThrow();
  });

  it("⚠ a slot copied onto another session's row cannot be opened there, even with the right token", () => {
    const predecessor = generateRefreshToken();
    const sealed = encryptGraceSuccessor(SESSION, predecessor, generateRefreshToken());
    expect(() => decryptGraceSuccessor(OTHER_SESSION, predecessor, sealed)).toThrow();
  });

  it("a tampered ciphertext fails authentication instead of yielding a different token", () => {
    const predecessor = generateRefreshToken();
    const sealed = encryptGraceSuccessor(SESSION, predecessor, generateRefreshToken());
    const lastColon = sealed.lastIndexOf(":");
    const body = Buffer.from(sealed.slice(lastColon + 1), "base64");
    body[0] = body[0]! ^ 0xff;
    const tampered = `${sealed.slice(0, lastColon + 1)}${body.toString("base64")}`;
    expect(() => decryptGraceSuccessor(SESSION, predecessor, tampered)).toThrow();
  });

  it("the stored value never contains the successor or the predecessor in the clear", () => {
    const predecessor = generateRefreshToken();
    const successor = generateRefreshToken();
    const sealed = encryptGraceSuccessor(SESSION, predecessor, successor);
    expect(sealed).not.toContain(successor);
    expect(sealed).not.toContain(predecessor);
  });

  it("two rotations of the same successor produce different ciphertexts (random IV)", () => {
    const predecessor = generateRefreshToken();
    const successor = generateRefreshToken();
    expect(encryptGraceSuccessor(SESSION, predecessor, successor)).not.toBe(encryptGraceSuccessor(SESSION, predecessor, successor));
  });
});

describe("STORY-170 · the grace slot's stored form", () => {
  const slot = () => ({
    predecessorHash: hashRefreshToken(generateRefreshToken()),
    successorCiphertext: encryptGraceSuccessor(SESSION, generateRefreshToken(), generateRefreshToken()),
  });

  it("round-trips exactly the predecessor hash and the sealed successor", () => {
    const stored = slot();
    expect(parseGraceSlot(serializeGraceSlot(stored))).toEqual(stored);
  });

  it.each([
    ["not JSON", "v1:refresh-grace-v1:abc:def"],
    ["JSON that is not an object", "\"a string\""],
    ["an object missing the successor", JSON.stringify({ predecessorHash: "abc" })],
    ["an object missing the predecessor hash", JSON.stringify({ successorCiphertext: "abc" })],
    ["an empty field", JSON.stringify({ predecessorHash: "", successorCiphertext: "abc" })],
    ["a field of the wrong type", JSON.stringify({ predecessorHash: 1, successorCiphertext: "abc" })],
    ["an object carrying an unknown key", JSON.stringify({ ...slot(), expiresAt: "2099-01-01" })],
  ])("a value that is %s is NOT a slot — an absent one, never a partial grant", (_label, raw) => {
    expect(parseGraceSlot(raw)).toBeUndefined();
  });

  it("carries no expiry of its own — the cache's TTL is the only clock", () => {
    expect(Object.keys(JSON.parse(serializeGraceSlot(slot())) as object).sort()).toEqual(["predecessorHash", "successorCiphertext"]);
  });
});
