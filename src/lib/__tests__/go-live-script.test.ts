/**
 * Guards for go-live.sh (QA rounds 4-6). Nothing here talks to Vercel or a
 * database: most checks read the file; one runs the DB-identity block alone
 * with `bun` stubbed out.
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
    expect(code).toMatch(/could not read the project's \$TARGET DATABASE_URL/);
  });

  test("GO_LIVE_EXPECTED_DB_HOST is a fallback only when the project's URL is unreadable (exit 3)", () => {
    const start = code.indexOf("same-project-db");
    const block = code.slice(start, code.indexOf("Type 'apply' to continue"));
    // The fallback branch is gated on exit code 3, and needs the db name too.
    expect(block).toMatch(/elif \[ "\$DB_CHECK" -eq 3 \] && \[ -n "\$\{GO_LIVE_EXPECTED_DB_HOST:-\}" \] &&\s*\n\s*\[ -n "\$\{GO_LIVE_EXPECTED_DB_NAME:-\}" \]/);
    expect(block).toMatch(/EXPECTED_DB_NAME="\$GO_LIVE_EXPECTED_DB_NAME"/);
    // same-host is only reachable from that branch.
    const fallback = block.indexOf('"$DB_CHECK" -eq 3 ] && [ -n');
    expect(block.indexOf("same-host")).toBeGreaterThan(fallback);
    expect(block).toMatch(/GO_LIVE_EXPECTED_DB_HOST is only consulted when the project's value cannot be read/);
  });

  test("the DB check, run for real: mismatch is fatal even with GO_LIVE_EXPECTED_DB_HOST set", () => {
    // Execute just the verification block with stubbed `bun` exit codes.
    const start = code.indexOf("  DB_CHECK=0");
    const end = code.indexOf('  rm -rf "$PULL_DIR"\n  trap - EXIT');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const block = code.slice(start, end);
    const harness = (projectRc: number, hostRc: number, env: Record<string, string>) =>
      spawnSync(
        "bash",
        [
          "-c",
          `set -euo pipefail
die() { echo "DIE: $*"; exit 9; }
bun() { if [ "$2" = same-project-db ]; then return ${projectRc}; else return ${hostRc}; fi; }
PG_URL_HELPER=x; PULL_DIR=$(mktemp -d); TARGET=production; DATABASE_URL_UNPOOLED=u
${block}
echo PASSED`,
        ],
        { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } },
      );
    const fb = { GO_LIVE_EXPECTED_DB_HOST: "ep-x.neon.tech", GO_LIVE_EXPECTED_DB_NAME: "neondb" };
    expect(harness(0, 1, {}).stdout).toMatch(/PASSED/);
    // Real mismatch: fatal, fallback never consulted even though it would match.
    const mismatch = harness(1, 0, fb);
    expect(mismatch.status).toBe(9);
    expect(mismatch.stdout).toMatch(/does not match the project's/);
    // Unreadable project value: fallback decides.
    expect(harness(3, 0, fb).stdout).toMatch(/PASSED/);
    expect(harness(3, 1, fb).status).toBe(9);
    // Unreadable and no (complete) fallback: fatal.
    expect(harness(3, 0, {}).status).toBe(9);
    expect(harness(3, 0, { GO_LIVE_EXPECTED_DB_HOST: "ep-x.neon.tech" }).status).toBe(9);
  });

  test("GIFT_TOKEN_SECRET is a runtime var and allowed in the env file", () => {
    const optional = /OPTIONAL_RUNTIME_VARS=\(([^)]*)\)/.exec(code)![1].split(/\s+/);
    expect(optional).toContain("GIFT_TOKEN_SECRET");
    expect(code).toMatch(/ENV_FILE_ALLOWLIST=\([^)]*"\$\{OPTIONAL_RUNTIME_VARS\[@\]\}"/);
    expect(code).toMatch(/warning: GIFT_TOKEN_SECRET is not set/);
  });

  test("the DB URL is parsed by the strict helper, not ad hoc", () => {
    expect(code).toMatch(/PG_URL="\$DATABASE_URL_UNPOOLED" bun "\$PG_URL_HELPER" libpq-env/);
    expect(code).not.toMatch(/new URL\(process\.env\.DATABASE_URL/);
  });
});
