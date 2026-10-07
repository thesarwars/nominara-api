import { exportRequestSchema } from "../../../contracts/reports/index.js";

// NEW-E-100b — the condition `@Meter` carries on the export route.
/**
 * Which requests QuotaGuard reserves a `pdf_exports` unit for: a PDF, with a
 * body the route will accept and an Idempotency-Key to settle the reservation
 * under. Anything else (a CSV, a malformed body, a missing key) is refused or
 * served without touching the cap - a reservation made for a request that is
 * then rejected would be a unit nothing could ever settle.
 */
export function isMeteredPdfExport(request: unknown): boolean {
  const { body, headers } = request as { body?: unknown; headers?: Record<string, unknown> };
  const key = headers?.["idempotency-key"];
  const parsed = exportRequestSchema.safeParse(body);
  return parsed.success && parsed.data.format === "pdf" && typeof key === "string" && key.length > 0 && key.length <= 255;
}
