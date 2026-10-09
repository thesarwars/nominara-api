import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");
const out = mkdtempSync(join(tmpdir(), "nominara-build-assets-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("build ships the run-time assets tsc does not copy (E2E-B4)", () => {
  it("E2E-B4: the copier lays fonts, migration SQL and the OpenAPI document where the compiled code reads them", () => {
    execFileSync("node", [join(ROOT, "scripts/copy-build-assets.mjs"), out]);
    // Paths are those the compiled modules resolve from their own directory.
    for (const rel of [
      "src/lib/reports/fonts/Inter-Regular.ttf",
      "src/lib/reports/fonts/Inter-Bold.ttf",
      "src/db/migrations/sql/0006_generated_rls_policies.up.sql",
      "contracts/openapi.generated.json",
    ]) {
      expect(existsSync(join(out, rel)), rel).toBe(true);
    }
  });

  it("E2E-B4: `pnpm build` runs the copier after tsc", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.build).toMatch(/tsc .*&& node scripts\/copy-build-assets\.mjs/);
  });

  it("E2E-B4: the image build uses the same step", () => {
    const docker = readFileSync(join(ROOT, "Dockerfile"), "utf8");
    expect(docker).toMatch(/RUN pnpm build/);
  });
});
