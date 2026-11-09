/** scripts/pg-url.mjs: strict URL parsing and project-DB matching for go-live.sh. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
// @ts-ignore -- plain ESM helper used by a shell script
import { libpqExports, parsePgUrl, readDotenv, sameDatabase } from "../../../scripts/pg-url.mjs";

const POOLED = "postgresql://app:s3cr%27et@ep-cool-name-123-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
const UNPOOLED = "postgresql://app:s3cr%27et@ep-cool-name-123.us-east-2.aws.neon.tech/neondb?sslmode=require";
const OTHER = "postgresql://app:pw@ep-other-999.us-east-2.aws.neon.tech/neondb?sslmode=require";
const HELPER = join(process.cwd(), "scripts/pg-url.mjs");

describe("parsePgUrl", () => {
  test("parses and decodes a Neon URL", () => {
    expect(parsePgUrl(UNPOOLED)).toMatchObject({
      host: "ep-cool-name-123.us-east-2.aws.neon.tech",
      port: "5432",
      user: "app",
      password: "s3cr'et",
      database: "neondb",
      sslmode: "require",
    });
  });

  test.each([
    ["", "empty"],
    ["mysql://a:b@h/db", "postgres"],
    ["postgresql://a:b@/db", "valid URL|host"],
    ["postgresql://a:b@h1,h2/db", "multi-host"],
    ["postgresql://:b@h/db", "user"],
    ["postgresql://a@h/db", "password"],
    ["postgresql://a:b@h/", "one database"],
    ["postgresql://a:b@h/db/x", "one database"],
    ["postgresql://a:b@h/db?sslmode=disable", "sslmode"],
    ["postgresql://a:b@h/db?host=/tmp", "unsupported"],
    ["postgresql://a:b@h/db#x", "fragment"],
    ["postgresql://a:%E0%A4%A@h/db", "percent"],
    ["postgresql://a:b@h/d b", "whitespace"],
    ["not a url", "whitespace"],
  ])("rejects %s (%s)", (url, why) => {
    expect(() => parsePgUrl(url)).toThrow(new RegExp(why, "i"));
  });

  test("error messages never contain the password", () => {
    try {
      parsePgUrl("postgresql://a:TOPSECRET@h/db?sslmode=disable");
    } catch (e) {
      expect(String(e)).not.toContain("TOPSECRET");
    }
  });
});

describe("sameDatabase", () => {
  test("pooled and unpooled URLs of one endpoint match", () => {
    expect(sameDatabase(parsePgUrl(POOLED), parsePgUrl(UNPOOLED))).toBe(true);
  });
  test("different endpoint or database does not", () => {
    expect(sameDatabase(parsePgUrl(OTHER), parsePgUrl(UNPOOLED))).toBe(false);
    expect(
      sameDatabase(parsePgUrl(UNPOOLED.replace("/neondb", "/otherdb")), parsePgUrl(UNPOOLED)),
    ).toBe(false);
  });
});

describe("libpqExports", () => {
  test("shell-quotes values so eval round-trips them", () => {
    const out = libpqExports(parsePgUrl(UNPOOLED));
    const r = spawnSync("bash", ["-c", `${out}\nprintf '%s' "$PGPASSWORD"`], { encoding: "utf8" });
    expect(r.stdout).toBe("s3cr'et");
  });
});

describe("CLI (as go-live.sh calls it)", () => {
  const run = (args: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, [HELPER, ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", ...env },
    });
  const dir = mkdtempSync(join(tmpdir(), "pgurl-"));
  const envFile = join(dir, "project.env");
  writeFileSync(envFile, `# Created by Vercel CLI\nDATABASE_URL="${POOLED}"\nOTHER="x"\n`);

  test("same-project-db: match exits 0, mismatch exits 1, no password in output", () => {
    const ok = run(["same-project-db", envFile], { PG_URL: UNPOOLED });
    expect(ok.status).toBe(0);
    const bad = run(["same-project-db", envFile], { PG_URL: OTHER });
    expect(bad.status).toBe(1);
    expect(ok.stderr + ok.stdout + bad.stderr + bad.stdout).not.toContain("s3cr");
  });

  test("same-project-db fails closed when the project's value is not readable", () => {
    const empty = join(dir, "empty.env");
    writeFileSync(empty, 'DATABASE_URL=""\n');
    expect(run(["same-project-db", empty], { PG_URL: UNPOOLED }).status).toBe(1);
  });

  test("same-host compares against GO_LIVE_EXPECTED_DB_HOST (pooler suffix ignored)", () => {
    const host = "ep-cool-name-123-pooler.us-east-2.aws.neon.tech";
    expect(run(["same-host"], { PG_URL: UNPOOLED, EXPECTED_DB_HOST: host }).status).toBe(0);
    expect(run(["same-host"], { PG_URL: OTHER, EXPECTED_DB_HOST: host }).status).toBe(1);
  });

  test("libpq-env rejects a bad URL with exit 1 and prints nothing to stdout", () => {
    const r = run(["libpq-env"], { PG_URL: "postgresql://a:SECRET@h/db?sslmode=disable" });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).not.toContain("SECRET");
  });

  test("libpq-env refuses a pooled (-pooler) host", () => {
    const r = run(["libpq-env"], { PG_URL: POOLED });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
  });

  test("readDotenv reads vercel env pull output", () => {
    expect(readDotenv('A="1"\nexport B=2\n# c\n')).toEqual({ A: "1", B: "2" });
  });
});
