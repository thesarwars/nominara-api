import { Injectable, type PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod";
import { ValidationFailedError } from "../errors/domain-errors.js";

// STORY-014 — first request body this repo validates against a `.strict()`
// contracts/ schema over real HTTP. Declarative (`@Body(new
// ZodValidationPipe(schema))`), so the controller stays a plain delegation
// with no conditional (coding-standards.md §1). An unknown key or a shape
// mismatch is a 400 naming the offending path, never silently dropped.
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const detail = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");

      // STORY-024 T9 — §2: "zod failure; `details.issues[]` carries path and
      // message". The human `detail` string is unchanged, so everything that
      // already asserts on it keeps passing; the STRUCTURED issues are what a
      // client needs to highlight the offending field without re-parsing prose.
      //
      // A path element stays a NUMBER when it is an array index. Flattening
      // ["prompts", 3, "text"] to a string would make the index
      // indistinguishable from a key literally named "3", which is the one
      // thing a form binding cannot recover from.
      throw new ValidationFailedError({
        message: detail,
        details: {
          issues: result.error.issues.map((issue) => ({
            path: issue.path.map((segment) => (typeof segment === "number" ? segment : String(segment))),
            message: issue.message,
          })),
        },
      });
    }
    return result.data;
  }
}
