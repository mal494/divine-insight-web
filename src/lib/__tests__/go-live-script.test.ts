/**
 * Static guards for go-live.sh (QA round 4). Nothing here runs the script or
 * talks to Vercel; it only reads the file and asks bash to parse it.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const PATH = join(process.cwd(), "go-live.sh");
const src = readFileSync(PATH, "utf8");
const code = src
  .split("\n")
  .filter((l) => !/^\s*#/.test(l))
  .join("\n");

describe("go-live.sh", () => {
  test("parses (bash -n)", () => {
    const r = spawnSync("bash", ["-n", PATH], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  });

  test("production deploys pass --prod", () => {
    expect(code).toMatch(/production\)\s*TARGET_ARGS=\(--prod\)/);
    expect(code).toMatch(/deploy --prebuilt --yes "\$\{TARGET_ARGS\[@\]\}"/);
  });

  test("pins the Vercel CLI (no @latest)", () => {
    expect(code).not.toMatch(/vercel@latest/);
    expect(code).toMatch(/VERCEL_CLI_VERSION="\d+\.\d+\.\d+"/);
    expect(code).toMatch(/vercel@\$\{VERCEL_CLI_VERSION\}/);
  });

  test("never disables deployment protection", () => {
    expect(code).not.toMatch(/"ssoProtection"\s*:\s*null/);
    expect(code).not.toMatch(/"passwordProtection"\s*:\s*null/);
  });

  test("passes no secret on a command line", () => {
    expect(code).not.toMatch(/--token\b/);
    expect(code).not.toMatch(/\s-e\s+"[A-Z_]+=/); // vercel deploy -e NAME=value
    expect(code).not.toMatch(/--value\b/);
    expect(code).not.toMatch(/Authorization: Bearer \$VERCEL_TOKEN"\s/); // curl -H with token
    expect(code).not.toMatch(/psql\s+"\$DATABASE_URL/);
    // Uploads go through stdin.
    expect(code).toMatch(/printf '%s' "\$\{!name\}" \|\s*\n?\s*"\$\{VERCEL\[@\]\}" env add/);
  });

  test("does not source the env file", () => {
    expect(code).not.toMatch(/(^|\s)(source|\.)\s+"?\$GO_LIVE_ENV_FILE/m);
  });

  test("production requires an explicit migration step or schema confirmation", () => {
    expect(code).toMatch(/GO_LIVE_MIGRATIONS/);
    expect(code).toMatch(/GO_LIVE_SCHEMA_CONFIRMED/);
    expect(code).toMatch(/Type 'apply' to continue/);
    expect(code).toMatch(/psql -X -v ON_ERROR_STOP=1/);
  });

  test("env file keys are allowlisted", () => {
    expect(code).toMatch(/ENV_FILE_ALLOWLIST=\(/);
    expect(code).toMatch(/GO_LIVE_ENV_FILE key not allowed/);
    const allow = /ENV_FILE_ALLOWLIST=\(([^)]*)\)/.exec(code)![1];
    for (const dangerous of ["PATH", "BASH_ENV", "LD_PRELOAD", "NODE_OPTIONS", "GO_LIVE_"]) {
      expect(allow).not.toContain(dangerous);
    }
  });

  test("no silent --force: every --force follows an explicit 'overwrite' confirmation", () => {
    const forces = [...code.matchAll(/--force/g)].map((m) => m.index!);
    expect(forces.length).toBeGreaterThan(0);
    const confirm = code.indexOf("Type 'overwrite' to replace them");
    expect(confirm).toBeGreaterThan(0);
    for (const f of forces) expect(f).toBeGreaterThan(confirm);
    expect(code).toMatch(/GO_LIVE_SYNC_OVERWRITE/);
    // Existing vars are skipped by default.
    expect(code).toMatch(/skipping existing/);
  });

  test("migrations verify the target DB belongs to the project before psql runs", () => {
    const verify = code.indexOf("same-project-db");
    const host = code.indexOf("same-host");
    const confirm = code.indexOf("Type 'apply' to continue");
    const psql = code.indexOf("psql -X");
    expect(verify).toBeGreaterThan(0);
    expect(host).toBeGreaterThan(0);
    expect(verify).toBeLessThan(confirm);
    expect(confirm).toBeLessThan(psql);
    expect(code).toMatch(/env pull "\$PULL_DIR\/project\.env" --environment "\$TARGET"/);
    expect(code).toMatch(/trap 'rm -rf "\$PULL_DIR"' EXIT/);
    expect(code).toMatch(/does not match \(or could not be checked against\)/);
  });

  test("the DB URL is parsed by the strict helper, not ad hoc", () => {
    expect(code).toMatch(/PG_URL="\$DATABASE_URL_UNPOOLED" bun "\$PG_URL_HELPER" libpq-env/);
    expect(code).not.toMatch(/new URL\(process\.env\.DATABASE_URL/);
  });
});
