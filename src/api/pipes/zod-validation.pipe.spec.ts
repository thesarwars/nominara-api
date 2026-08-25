import { DomainError, ValidationFailedError } from "../errors/domain-errors.js";
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
    expect(() => pipe.transform({ name: "ok", extra: 1 })).toThrow(ValidationFailedError);
  });

  it("rejects a shape mismatch with a 400", () => {
    const pipe = new ZodValidationPipe(schema);
    expect(() => pipe.transform({ name: 123 })).toThrow(ValidationFailedError);
  });

  // STORY-024 T9 — §2: "zod failure; `details.issues[]` carries path and
  // message". An array INDEX stays a number, so a form can tell it from a key
  // literally named "3".
  it("carries structured issues, preserving array indices as numbers", () => {
    const schema = z.object({ items: z.array(z.object({ text: z.string() })) }).strict();
    const pipe = new ZodValidationPipe(schema);

    try {
      pipe.transform({ items: [{ text: "ok" }, { text: 7 }] });
      expect.unreachable("the pipe must reject a shape mismatch");
    } catch (error) {
      const details = (error as DomainError).details as { issues: { path: unknown[]; message: string }[] };
      expect(details.issues[0]!.path).toEqual(["items", 1, "text"]);
      expect(details.issues[0]!.message).toBeTruthy();
    }
  });
});
