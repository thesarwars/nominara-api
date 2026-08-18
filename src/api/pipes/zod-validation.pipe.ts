import { BadRequestException, Injectable, type PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod";

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
      throw new BadRequestException(detail);
    }
    return result.data;
  }
}
