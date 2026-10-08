import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { z } from "zod";
import type { AutoTopupTriggerOutcome } from "../../../../contracts/billing/index.js";
import { StripeHttpGateway } from "../../billing/stripe/stripe-http.gateway.js";
import { AutoTopupService } from "../../../modules/billing/auto-topup.service.js";
import { selectEmailSender } from "../../../modules/identity/identity.module.js";
import type { QueueHandlerContext } from "../handlers.js";
import type { JobProcessor } from "../worker-factory.js";

// NEW-D-7 checkpoint-3 finding 4 / owner decision 4 — `billing.auto_topup`: evaluate one workspace's auto top-up.
//
// The job is a SIGNED TENANT job. `createJobProcessor` verified the signature before this ran and before any
// context was set, so `payload.workspaceId` is trustworthy and is the ONLY workspace this handler ever acts on.
// Nothing else in the payload is allowed (`.strict()`): an amount or a card never travels in a job; the pack,
// the threshold and the saved payment method are read from the database and from Stripe by `trigger`.
//
// ⚠ `tx` IS DELIBERATELY NOT USED. `AutoTopupService` runs three short tenant transactions of its own and awaits
// Stripe and the mail port BETWEEN them (KAD-06); the job's transaction is passed to every tenant handler by the
// processor and is held (idle, having run only `set_config`) until this returns. That is the same shape
// `crawl.audit` and `source.verify_presence` have, and it is flagged in docs/plans/evidence/NEW-D-7.md as an
// open decision (a "verify, release the connection, then run" processor mode would be a new pattern).
//
// A throw reaches the retry ladder; that is safe because `trigger` claims its slot with a conditional UPDATE
// under the wallet lock and never charges twice for one pending purchase.

const payloadSchema = z.object({ workspaceId: z.string().uuid(), kid: z.string() }).strict();

export interface BillingAutoTopupDeps {
  readonly service?: { trigger(workspaceId: string): Promise<AutoTopupTriggerOutcome> };
}

export function createBillingAutoTopupHandler(context: QueueHandlerContext, deps: BillingAutoTopupDeps = {}): JobProcessor {
  const logger = new Logger("billing.auto_topup");
  // Built on the first job, not at boot: a worker group whose Stripe key is absent must still boot.
  let service = deps.service;
  const serviceFor = (): { trigger(workspaceId: string): Promise<AutoTopupTriggerOutcome> } => {
    service ??= new AutoTopupService(
      new StripeHttpGateway({ secretKey: context.env.STRIPE_SECRET_KEY, webhookSecret: context.env.STRIPE_WEBHOOK_SECRET }),
      context.pool,
      selectEmailSender(),
    );
    return service;
  };

  return async (_tx: ClientBase, job: Job): Promise<AutoTopupTriggerOutcome> => {
    const payload = payloadSchema.parse((job.data as { payload: unknown }).payload);
    const outcome = await serviceFor().trigger(payload.workspaceId);
    logger.log({ event: "billing.auto_topup.job_done", workspace_id: payload.workspaceId, outcome });
    return outcome;
  };
}
