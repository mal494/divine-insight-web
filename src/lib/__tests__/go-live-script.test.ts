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
});
