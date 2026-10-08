import { Injectable, Logger } from "@nestjs/common";
import { desiredFromStripeInvoice } from "../../lib/billing/stripe/invoice-state.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { BillingInvoicesService } from "./billing-invoices.service.js";
import type { StripeEventContext, StripeEventHandler } from "./stripe-event-handler.js";

// STORY-075b / STORY-075 AC9 — invoices as a READ MODEL. The event only says
// "this invoice changed"; the record written is the one in the FRESH FETCH, in
// full, so two events in either order and a redelivery leave the same row.
// Nothing here computes a total: it is recorded as Stripe issued it.
@Injectable()
export class StripeInvoiceHandler implements StripeEventHandler {
  readonly types = ["invoice.created", "invoice.finalized", "invoice.paid", "invoice.payment_failed", "invoice.voided"] as const;

  private readonly logger = new Logger(StripeInvoiceHandler.name);

  constructor(private readonly invoices: BillingInvoicesService) {}

  async handle({ tx, workspaceId, event, object }: StripeEventContext): Promise<void> {
    if (object.kind !== "invoice") return;

    // The workspace row is the serialiser (as in the subscription handler): two
    // events for one invoice take turns instead of racing on ux_invoices_stripe.
    await tx.query("SELECT 1 FROM workspaces WHERE id = $1 FOR UPDATE", [workspaceId]);

    const desired = desiredFromStripeInvoice(object.raw);
    if (desired.kind === "ignore") {
      incrementCounter("nominara_billing_invoice_events_total", { outcome: "ignored" });
      this.logger.warn({ message: `stripe invoice not recorded: ${desired.reason}`, event_id: event.id, workspace_id: workspaceId });
      return;
    }

    const outcome = await this.invoices.record(tx, workspaceId, desired.invoice, { eventId: event.id, eventType: event.type });
    incrementCounter("nominara_billing_invoice_events_total", { outcome });
    this.logger.log({ message: "stripe invoice recorded", event_id: event.id, workspace_id: workspaceId, outcome, status: desired.invoice.status });
  }
}
