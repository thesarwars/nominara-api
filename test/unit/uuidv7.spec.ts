import { describe, expect, it } from "vitest";
import { createUuidV7Generator } from "../../src/lib/ids/uuidv7.js";

describe("STORY-006 · uuidv7 monotonicity", () => {
  it("produces monotonically increasing values within the same millisecond", () => {
    const generate = createUuidV7Generator(
      () => 1_700_000_000_000,
      (size) => Buffer.alloc(size, 0),
    );

    // Stay under the 4096-value (12-bit) counter ceiling documented on
    // createUuidV7Generator — beyond that the counter wraps by design.
    const batch = Array.from({ length: 4000 }, () => generate());

    for (let i = 1; i < batch.length; i++) {
      expect(batch[i]! > batch[i - 1]!).toBe(true);
    }
  });

  it("produces monotonically increasing values across advancing timestamps", () => {
    let ms = 1_700_000_000_000;
    const generate = createUuidV7Generator(
      () => ms,
      (size) => Buffer.alloc(size, 0),
    );

    const batch = [generate()];
    for (let i = 0; i < 10; i++) {
      ms += 1;
      batch.push(generate());
    }

    for (let i = 1; i < batch.length; i++) {
      expect(batch[i]! > batch[i - 1]!).toBe(true);
    }
  });

  it("is a well-formed UUID with version 7 and variant bits set", () => {
    const generate = createUuidV7Generator();
    const id = generate();

    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
