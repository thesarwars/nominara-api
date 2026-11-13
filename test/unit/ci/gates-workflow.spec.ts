import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MIGRATION_OWNER_ROLE, RUNTIME_ROLES } from "../../../src/db/conventions.js";

// ⚠ STORY-155 — THE CI WORKFLOW, HELD AGAINST WHAT IT CLAIMS TO RUN.
//
// `.github/workflows/gates.yml` names its gates by hand, and a hand-written
// list is the shape this codebase keeps paying for: complete for the world as
// it stood, silent about the next entry. The first version of this spec
// repeated the mistake one level down — it read the workflow with LINE
// REGEXES, so a review walked `continue-on-error`, a job-level `needs:`, a
// flow-style `- { uses: x@v1 }` and a renamed install step straight past it,
// and it classified scripts by a naming convention that missed half the
// plausible gate names. It also never looked at test FILES, and five contract
// test files (70 tests — an earlier count of 62 was a grep that missed it.each
// expansions) had never run in CI.
//
// ⚠ AND A SECOND REVIEW FOUND THE SAME SHAPE ONE LEVEL UP. The parsed version
// closed every step-level bypass and left the levels above open: a
// workflow-level `env` or `defaults.run.shell`, a job `env` line setting
// pnpm's script shell to `true`, an action input, or a gate script's BODY in
// package.json (`--shard=1/2`, `-t`, `|| true`) each turned gates into no-ops
// with this spec green. So now every level is pinned by VALUE, not by shape:
// the workflow's top-level keys, each job's settings, each action's inputs,
// and each gate script's exact body. A change to any of them is a change to
// what a gate runs, and has to change this file in the same diff.
//
// So everything here works on the PARSED workflow, and the default is to
// REPORT: an unrecognised step, an unrecognised job setting, an unclassified
// script or an uncollected test file fails, naming itself.

const GUARD = "${{ !cancelled() && steps.install.outcome == 'success' }}";
const INSTALL = "pnpm install --frozen-lockfile";
const PINNED_ACTION = /^actions\/[a-z0-9-]+@[0-9a-f]{40}$/u;

interface Step {
  readonly [key: string]: unknown;
  readonly id?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly if?: string;
  readonly with?: Record<string, unknown>;
}
interface Job {
  readonly [key: string]: unknown;
  readonly steps: Step[];
}
interface Workflow {
  readonly on: Record<string, unknown>;
  readonly permissions: unknown;
  readonly concurrency: Record<string, unknown>;
  readonly jobs: Record<string, Job>;
}

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const workflow = parse(readFileSync(`${ROOT}.github/workflows/gates.yml`, "utf8")) as Workflow;
const pkg = JSON.parse(readFileSync(`${ROOT}package.json`, "utf8")) as { scripts: Record<string, string>; packageManager?: string };
const scripts = pkg.scripts;
const allSteps = Object.values(workflow.jobs).flatMap((job) => job.steps);

/** A gate step is exactly `pnpm <script>` — no arguments, no chaining, nothing that could narrow or excuse it. */
const gateScriptOf = (step: Step): string | null => {
  const match = typeof step.run === "string" ? /^pnpm ([a-z][\w:.-]*)$/u.exec(step.run.trim()) : null;
  return match && match[1] !== "install" ? match[1]! : null;
};
const gateSteps = allSteps.filter((step) => gateScriptOf(step) !== null);
const invoked = new Set(gateSteps.map((step) => gateScriptOf(step)!));

/** Scripts that are not gates, each with the reason. A new script that is not here and not run fails the suite. */
const NOT_A_GATE: Readonly<Record<string, string>> = {
  build: "compiles for deployment; typecheck covers the same sources",
  start: "runs the API",
  "start:gateway": "runs the realtime gateway",
  "start:worker": "runs the queue workers",
  test: "developer convenience over the default config; the census below proves every file it collects is collected by a script CI runs",
  "db:generate": "writes a migration scaffold",
  "db:migrate": "mutates a database",
  "db:rollback": "mutates a database",
  "db:reembed": "operator command (STORY-186, decision 104b): enqueues paid re-embed jobs and promotes projects; off by default",
  "db:reset": "mutates a database",
  "db:dev-credentials": "provisions local role passwords",
  "db:rls-generate": "writes generated RLS artifacts; db:rls-check is the gate over them",
  "db:schema-generate": "writes the generated Drizzle schema; db:schema-check is the gate over it",
  "db:studio": "an interactive UI",
  "db:seed": "a dev-only CLI; writes the three synthetic tenants (behind its own NODE_ENV/local-host/opt-in guard — see src/db/seed/synthetic/guard.ts)",
  "dev:up": "the local one-command stack (install, .env, docker compose up, seed); needs Docker (STORY-004)",
  "dev:api": "an alias of dev:up (STORY-004)",
  "db:seed-demo": "a dev-only operator CLI; mutates a database (behind its own NODE_ENV/local-host/opt-in guard — see src/db/seed/demo/guard.ts)",
  "db:maintenance:run": "an operational job",
  "db:maintenance:sweep": "an operational job",
  "db:maintenance:catch-up": "an operator-only job that moves rows out of a _default partition under lock; deliberately never scheduled (STORY-142)",
  "identity:sweep-unverified": "an operational job that deletes stale unverified accounts; not yet on a queue schedule (STORY-173)",
  "credits:verify": "an operational job against a live ledger",
  "credits:reconcile": "an operational job against a live ledger",
  "plan:set": "the operator CLI; it changes a workspace's plan",
  "email:unsuppress": "the operator CLI; it lifts an email suppression on the owner connection (STORY-178)",
  "rollup:rebuild": "the operator CLI; it audits and enqueues a metric_daily rebuild for one project and date range (STORY-042)",
  "billing:invoices-resync": "the operator CLI; it re-fetches recorded invoices from live Stripe",
  "support:grant": "the operator CLI; it issues a time-boxed support access grant",
  "support:revoke": "the operator CLI; it revokes a support access grant",
  "db:subject:export": "the operator CLI (STORY-111, decision 68a); it exports one person's data from the owner connection",
  "db:subject:erase": "the operator CLI (STORY-111, decision 68a); it erases one person, irreversibly, from the owner connection",
  "db:hold:place": "the operator CLI (STORY-111, decision 70e); it places a legal hold from the owner connection",
  "db:hold:release": "the operator CLI (STORY-111, decision 70e); it releases a legal hold and runs the erasures it delayed, from the owner connection",
  "audit:verify": "an operational job against a live audit chain",
  "audit:export": "an operational export",
  "contracts:generate": "writes the generated OpenAPI document; contracts:check is the gate over it",
  "contracts:diff": "a developer report between two documents",
  "client:generate": "writes the generated client; the app's CI builds and type-checks against it",
};

/**
 * Gate-shaped scripts CI deliberately does not run. Each reason is CHECKED
 * below, because the first version's reasons were both false — each described
 * the other script's behaviour, and a review measured it.
 */
const EXEMPT_GATE: Readonly<Record<string, string>> = {
  "db:role-check":
    "asserts the connection is not the migration owner. CI connects as the image's superuser, which is neither the owner " +
    "nor a runtime role, so it would PASS VACUOUSLY; it only means something against a deploy URL.",
  "db:purge-check":
    "reads production's purge_failures table. CI's service database is never migrated (the shadow-database gates build " +
    "their own), so the table does not exist and it would ERROR; it only means something against production.",
};

/**
 * Each gate script's EXACT body. Pinned because the census below asks vitest
 * which files a body COLLECTS, and `vitest list` ignores `--shard` and `-t` —
 * so a narrowed body looked complete — and because `|| true` or an extra flag
 * on any gate excuses or narrows it.
 *
 * The one edit this cannot catch is one that stops THIS file running (an
 * `--exclude` of test/unit/ci on test:unit): nothing checks a check that does
 * not run. That edit has to change the body pinned here too, so it cannot be
 * made without the diff saying so.
 */
const GATE_BODIES: Readonly<Record<string, string>> = {
  lint: "eslint .",
  typecheck: "tsc --noEmit",
  "contracts:check": "tsx src/contracts/check.ts",
  "test:unit": "vitest run test/unit src contracts",
  "db:drift-check": "tsx src/db/drift-check.ts",
  "db:rls-check": "tsx src/db/rls/rls-check.ts",
  "db:schema-check": "tsx src/db/schema/schema-check.ts",
  // STORY-006 AC 7 — apply every migration forward, roll every one back, re-apply, on a shadow database.
  "db:roundtrip-check": "tsx src/db/roundtrip-check.ts",
  "test:integration": "vitest run --config vitest.integration.config.ts",
  "test:isolation": 'vitest run --config vitest.isolation.config.ts --exclude "test/isolation/breakers/**"',
  "test:isolation:breakers": "vitest run --config vitest.isolation.config.ts test/isolation/breakers",
};

/** The only actions this workflow may use, with the exact inputs each may take. */
const ACTION_INPUTS: Readonly<Record<string, Record<string, unknown>>> = {
  "actions/checkout": { "persist-credentials": false },
  "actions/setup-node": { "node-version-file": ".nvmrc", "package-manager-cache": false },
};

describe("STORY-155 · the CI workflow, parsed, runs every gate this repository declares", () => {
  it("⚠ the workflow has exactly the top-level keys this spec knows — no `env`, no `defaults`", () => {
    // Workflow-level `defaults.run.shell: "true {0}"` or `env` carrying
    // pnpm_config_script_shell made every gate a no-op, one level above
    // everything the previous version checked.
    expect(Object.keys(workflow).sort()).toEqual(["concurrency", "jobs", "name", "on", "permissions"]);
  });

  it("⚠ each job's settings are pinned by VALUE, not just by key", () => {
    const [staticJob, containers] = [workflow.jobs["static-and-database"], workflow.jobs.containers];
    expect(Object.keys(workflow.jobs).sort()).toEqual(["containers", "static-and-database"]);
    // One env line is enough to neutralise every step in a job, so the job env
    // is exactly the database URL — a plain URL, no query string, no options.
    expect(staticJob!.env).toEqual({ DATABASE_URL: "postgres://nominara:nominara@localhost:5432/nominara" });
    expect(containers!.env).toBeUndefined();
    expect(staticJob!.services).toEqual({
      postgres: {
        image: "pgvector/pgvector:pg18",
        env: { POSTGRES_USER: "nominara", POSTGRES_PASSWORD: "nominara", POSTGRES_DB: "nominara" },
        ports: ["5432:5432"],
        options: '--health-cmd "pg_isready -U nominara -d nominara" --health-interval 5s --health-timeout 3s --health-retries 20',
      },
    });
    for (const [name, job] of Object.entries(workflow.jobs)) {
      expect(job["runs-on"], name).toBe("ubuntu-24.04");
      expect(typeof job["timeout-minutes"], name).toBe("number");
    }
  });

  it("⚠ every gate script's body is exactly the pinned one — no flag, operator or narrowing", () => {
    // `vitest list --filesOnly` ignores --shard and -t, so a narrowed body
    // passed the census; `|| true` excused a gate outright.
    const bodies = Object.fromEntries([...invoked].map((name) => [name, scripts[name]]));
    expect(bodies).toEqual(GATE_BODIES);
  });

  it("the parse found what it should — the checks below are not running over nothing", () => {
    expect(Object.keys(workflow.jobs).length).toBeGreaterThanOrEqual(2);
    expect(gateSteps.length, "no gate steps parsed").toBeGreaterThanOrEqual(10);
    expect(invoked.has("test:integration")).toBe(true);
    expect(gateScriptOf({ run: "pnpm lint" })).toBe("lint");
    expect(gateScriptOf({ run: "pnpm lint --quiet" }), "an argument can narrow a gate").toBeNull();
    expect(gateScriptOf({ run: "pnpm lint || true" }), "a chained gate can be excused").toBeNull();
    expect(gateScriptOf({ run: INSTALL })).toBeNull();
  });

  it("⚠ triggers on every push to every branch, with no path filter that could skip a change", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(workflow.on.push).toEqual({ branches: ["**"] });
  });

  it("⚠ no job carries a setting that could skip it, excuse it, or make it wait on another job", () => {
    // `needs:` is the job-level form of the hiding the per-step guard fixed:
    // a job that needs a failed job is skipped. `if:` and `continue-on-error:`
    // skip or excuse outright. The allowed set is closed; anything else reports.
    const ALLOWED = new Set(["name", "runs-on", "timeout-minutes", "services", "env", "steps"]);
    for (const [name, job] of Object.entries(workflow.jobs)) {
      const extra = Object.keys(job).filter((key) => !ALLOWED.has(key));
      expect(extra, `job ${name} has settings this spec does not recognise`).toEqual([]);
    }
  });

  it("⚠ every step is one this spec recognises — anything else could run before a gate and change what it sees", () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      for (const step of job.steps) {
        const keys = Object.keys(step).sort();
        const kind =
          gateScriptOf(step) !== null
            ? "gate"
            : step.run === INSTALL
              ? "install"
              : step.run === "corepack enable"
                ? "corepack"
                : typeof step.uses === "string"
                  ? "action"
                  : "unknown";
        expect(kind, `job ${name}: unrecognised step ${JSON.stringify(step)}`).not.toBe("unknown");
        const allowed: Record<string, string[]> = {
          gate: ["if", "run"],
          install: ["id", "run"],
          corepack: ["run"],
          action: ["uses", "with"],
        };
        expect(keys, `job ${name}: ${kind} step carries unexpected keys — continue-on-error, shell and the like can neutralise it`).toEqual(
          allowed[kind],
        );
      }
    }
  });

  it("⚠ every gate step runs whenever install succeeded, whatever happened to the gates before it", () => {
    // The first CI run failed test:unit and SKIPPED all three database gates.
    for (const step of gateSteps) expect(step.if, `pnpm ${gateScriptOf(step)!}`).toBe(GUARD);
    // The guard names `steps.install`, so every job with gates has exactly one
    // install step with that id, BEFORE its first gate.
    for (const [name, job] of Object.entries(workflow.jobs)) {
      const firstGate = job.steps.findIndex((step) => gateScriptOf(step) !== null);
      if (firstGate === -1) continue;
      const installs = job.steps.map((step, index) => ({ step, index })).filter(({ step }) => step.id === "install");
      expect(installs.length, `job ${name}`).toBe(1);
      expect(installs[0]!.step.run).toBe(INSTALL);
      expect(installs[0]!.index, `job ${name}: install must precede the gates`).toBeLessThan(firstGate);
    }
  });

  it("⚠ every script is run by CI or classified with a reason — an unknown name is reported, not guessed", () => {
    const unclassified = Object.keys(scripts).filter((name) => !invoked.has(name) && !(name in NOT_A_GATE) && !(name in EXEMPT_GATE));
    expect(unclassified, "classify each: run it in gates.yml, or add it to NOT_A_GATE / EXEMPT_GATE with a reason").toEqual([]);
    expect([...invoked].filter((name) => !(name in scripts)), "a step names a script that does not exist").toEqual([]);
    for (const name of [...Object.keys(NOT_A_GATE), ...Object.keys(EXEMPT_GATE)]) {
      expect(name in scripts, `${name} is classified but no longer a script`).toBe(true);
      expect(invoked.has(name), `${name} is classified as not run, but CI runs it — delete the entry`).toBe(false);
    }
  });

  it("⚠ each exemption's reason is true of this workflow, not just written down", () => {
    const url = new URL(String((workflow.jobs["static-and-database"]!.env as Record<string, string>).DATABASE_URL));
    // db:role-check passes vacuously: CI's role is neither the owner it looks for nor a runtime role.
    expect(url.username).not.toBe(MIGRATION_OWNER_ROLE);
    expect(RUNTIME_ROLES as readonly string[]).not.toContain(url.username);
    // db:purge-check would error: nothing migrates CI's service database — no
    // step, and (the review's case) no gate script BODY either.
    expect(invoked.has("db:migrate")).toBe(false);
    expect(allSteps.some((step) => typeof step.run === "string" && step.run.includes("migrat"))).toBe(false);
    expect([...invoked].filter((name) => /migrat/iu.test(scripts[name]!))).toEqual([]);
    // And the role is fixed by the URL alone — no query string, no options.
    expect(url.search).toBe("");
  });

  it("⚠ every tracked test file is collected by a test script CI runs", { timeout: 120_000 }, () => {
    // The census that found five contract test files (70 tests) CI never ran:
    // `test:unit`'s positional filters were `test/unit src`, and nothing else
    // collected `contracts/`. Asked of vitest itself, not re-implemented.
    const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .filter((file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST")));
    const collected = new Set<string>();
    for (const name of invoked) {
      const body = scripts[name]!;
      if (!body.startsWith("vitest run")) continue;
      const listed = execFileSync("sh", ["-c", `./node_modules/.bin/${body.replace(/^vitest run/u, "vitest list --filesOnly")}`], {
        cwd: ROOT,
        encoding: "utf8",
        env,
      });
      for (const line of listed.split("\n")) if (line.trim()) collected.add(line.trim());
    }
    expect(tracked.length, "git ls-files found no test files — the census would be vacuous").toBeGreaterThan(300);
    expect(collected.size, "no CI script collected anything — the listing is broken").toBeGreaterThan(300);
    expect(
      tracked.filter((file) => !collected.has(file)),
      "tracked test files no CI-run script collects. Widen that script's filters, or move the file.",
    ).toEqual([]);
  });

  it("⚠ every action is GitHub-owned and pinned to a full commit SHA, and checkout keeps no token", () => {
    const uses = allSteps.filter((step) => step.uses !== undefined);
    expect(uses.length).toBeGreaterThanOrEqual(2);
    for (const step of uses) {
      expect(step.uses, "a tag can be re-pointed; a third-party action is a dependency (§6)").toMatch(PINNED_ACTION);
      // An allow-list of actions, each with EXACT inputs: a GitHub-owned action
      // such as github-script can write GITHUB_ENV and neutralise every later
      // step, and a checkout `ref: main` would test main instead of the push.
      const action = step.uses!.split("@")[0]!;
      expect(Object.keys(ACTION_INPUTS), `${action} is not an action this workflow may use`).toContain(action);
      expect(step.with, action).toEqual(ACTION_INPUTS[action]);
    }
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  it("⚠ main runs are never cancelled — neither in progress nor pending — and branches supersede", () => {
    // A shared group on main still let GitHub cancel the PENDING run when a
    // third arrived; each main commit now gets a group of its own.
    expect(workflow.concurrency).toEqual({
      group: "${{ github.ref == 'refs/heads/main' && format('gates-main-{0}', github.sha) || format('gates-{0}', github.ref) }}",
      "cancel-in-progress": "${{ github.ref != 'refs/heads/main' }}",
    });
  });

  it("the toolchain has one source: .nvmrc for Node, packageManager with integrity for pnpm", () => {
    expect(existsSync(`${ROOT}.nvmrc`)).toBe(true);
    const setupNode = allSteps.filter((step) => step.uses?.startsWith("actions/setup-node@"));
    expect(setupNode.length).toBeGreaterThan(0);
    for (const step of setupNode) expect(step.with?.["node-version-file"]).toBe(".nvmrc");
    expect(pkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/u);
  });
});
