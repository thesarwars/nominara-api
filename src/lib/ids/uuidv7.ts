import { randomBytes as nodeRandomBytes } from "node:crypto";

// KAD-15: all identifiers are application-generated UUIDv7 — time-ordered so
// B-tree inserts append instead of scattering across the index.
//
// Monotonicity within the same millisecond is maintained by incrementing the
// 12-bit rand_a field as a counter rather than re-randomizing it, per RFC
// 9562 §6.2 method 2. rand_b stays random on every call. A caller issuing
// more than 4096 IDs inside one millisecond wraps the counter and loses
// strict ordering for that burst — outside this platform's write volume.
export interface UuidV7State {
  lastMs: number;
  counter: number;
}

export function createUuidV7Generator(
  clock: () => number = Date.now,
  randomBytes: (size: number) => Buffer = nodeRandomBytes,
) {
  const state: UuidV7State = { lastMs: -1, counter: 0 };

  return function generateUuidV7(): string {
    const ms = clock();
    if (ms === state.lastMs) {
      state.counter = (state.counter + 1) & 0x0fff;
    } else {
      state.lastMs = ms;
      state.counter = randomBytes(2).readUInt16BE(0) & 0x0fff;
    }

    const bytes = Buffer.alloc(16);
    bytes.writeUIntBE(ms % 2 ** 48, 0, 6);

    bytes[6] = 0x70 | ((state.counter >> 8) & 0x0f);
    bytes[7] = state.counter & 0xff;

    const tail = randomBytes(8);
    bytes[8] = 0x80 | (tail[0]! & 0x3f);
    for (let i = 1; i < 8; i++) {
      bytes[8 + i] = tail[i]!;
    }

    const hex = bytes.toString("hex");
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20, 32),
    ].join("-");
  };
}

// The generator most call sites use. Tests that need determinism construct
// their own via createUuidV7Generator(fixedClock, fixedRandomBytes) instead
// of touching this shared instance.
export const uuidV7 = createUuidV7Generator();
