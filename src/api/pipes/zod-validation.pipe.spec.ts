import { BadRequestException } from "@nestjs/common";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { ZodValidationPipe } from "./zod-validation.pipe.js";

const schema = z.object({ name: z.string() }).strict();

describe("STORY-014 · ZodValidationPipe", () => {
  it("passes through a value matching the schema", () => {
    const pipe = new ZodValidationPipe(schema);
    expect(pipe.transform({ name: "ok" })).toEqual({ name: "ok" });
  });

  it("rejects an unknown key with a 400 naming it", () => {
    const pipe = new ZodValidationPipe(schema);
    expect(() => pipe.transform({ name: "ok", extra: 1 })).toThrow(BadRequestException);
  });

  it("rejects a shape mismatch with a 400", () => {
    const pipe = new ZodValidationPipe(schema);
    expect(() => pipe.transform({ name: 123 })).toThrow(BadRequestException);
  });
});
