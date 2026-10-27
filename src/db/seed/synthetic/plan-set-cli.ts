import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SYNTHETIC_PLAN_PROVENANCE, type SyntheticPaidPlan } from "./constants.js";
import type { SetPlan } from "./seed-tenants.js";

// STORY-004 AC5 / owner decision 2026-10-27 item 5 — "set through the real
// plan:set subscription path". The seed RUNS the operator CLI
// (`pnpm plan:set`, src/workers/billing/plan-set.ts) as a child process with
// every mandatory flag, exactly as an operator would type it. It never imports
// it: STORY-151's import-surface gate allows two importers of the plan write
// and no third, and a seed is not a reason to widen that.
//
// The child inherits `env` (the seed's own environment: the CLI loads the full
// config and connects through DATABASE_URL_POOLED). A non-zero exit throws with
// the CLI's own stderr, so a refusal (e.g. a Stripe-tracked workspace) is
// reported in its own words.

const API_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

export function planSetArgs(workspaceId: string, planKey: SyntheticPaidPlan): string[] {
  return [
    "--workspace",
    workspaceId,
    "--plan",
    planKey,
    "--operator",
    SYNTHETIC_PLAN_PROVENANCE.operator,
    "--ticket",
    SYNTHETIC_PLAN_PROVENANCE.ticket,
    "--reason",
    SYNTHETIC_PLAN_PROVENANCE.reason,
  ];
}

export function planSetViaCli(env: NodeJS.ProcessEnv): SetPlan {
  return (workspaceId, planKey) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn("pnpm", ["--silent", "plan:set", ...planSetArgs(workspaceId, planKey)], {
        cwd: API_ROOT,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.stdout.on("data", () => undefined);
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error("pnpm plan:set exited " + String(code) + " for workspace " + workspaceId + ": " + stderr.trim()));
      });
    });
}
