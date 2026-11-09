import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";

const m = vi.hoisted(() => ({
  rows: [] as { table_name: string; column_name: string }[],
  queries: [] as string[],
  fail: false,
}));
vi.mock("~/db", () => ({
  sql: () => async (strings: TemplateStringsArray) => {
    const q = strings.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
    m.queries.push(q);
    if (/^(create|alter|drop)\b/.test(q)) throw new Error(`runtime DDL: ${q}`);
    if (m.fail) throw new Error("db down");
    return m.rows;
  },
}));

import { REQUIRED_PAYMENTS_SCHEMA, missingSchema } from "~/lib/payments-schema";
import {
  FAIL_TTL_MS,
  OK_TTL_MS,
  handlePaymentsHealth,
  resetPaymentsHealthCache,
} from "~/routes/api/health/payments";

const full = () =>
  Object.entries(REQUIRED_PAYMENTS_SCHEMA).flatMap(([table_name, cols]) =>
    cols.map((column_name) => ({ table_name, column_name })),
  );

beforeEach(() => {
  resetPaymentsHealthCache();
  m.fail = false;
  m.rows = [];
  m.queries = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("payments schema readiness", () => {
  test("missingSchema lists absent tables and columns", () => {
    expect(missingSchema(full())).toEqual([]);
    const noToken = full().filter(
      (r) =>
        !(r.table_name === "orders" && r.column_name === "access_token_hash"),
    );
    const noOrphans = noToken.filter((r) => r.table_name !== "orphan_payments");
    expect(missingSchema(noOrphans)).toEqual([
      "orders.access_token_hash",
      "orphan_payments",
    ]);
  });

  test("GET /api/health/payments is 200 when migrated", async () => {
    m.rows = full();
    const res = await handlePaymentsHealth();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(m.queries.every((q) => q.startsWith("select"))).toBe(true);
  });

  test("GET /api/health/payments is 503 with the migration to apply when not", async () => {
    m.rows = full().filter((r) => r.table_name !== "orphan_payments");
    const res = await handlePaymentsHealth();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      error: "schema_not_migrated",
      migration: "migrations/0004_payments_schema.sql",
      migrations: ["migrations/0004_payments_schema.sql"],
      missing: ["orphan_payments"],
    });
  });
});

describe("GET /api/health/payments load limits", () => {
  const T0 = 1_000_000;

  test("a positive result is cached for OK_TTL_MS, then re-checked", async () => {
    m.rows = full();
    expect((await handlePaymentsHealth(T0)).status).toBe(200);
    expect((await handlePaymentsHealth(T0 + 1_000)).status).toBe(200);
    expect(m.queries).toHaveLength(1);
    // The real clock sets the expiry; jump well past it.
    expect(
      (await handlePaymentsHealth(Date.now() + OK_TTL_MS + 1)).status,
    ).toBe(200);
    expect(m.queries).toHaveLength(2);
  });

  test("a negative result is cached only briefly (FAIL_TTL_MS)", async () => {
    m.rows = [];
    expect((await handlePaymentsHealth()).status).toBe(503);
    expect((await handlePaymentsHealth()).status).toBe(503);
    expect(m.queries).toHaveLength(1);
    m.rows = full(); // migration applied
    expect(
      (await handlePaymentsHealth(Date.now() + FAIL_TTL_MS + 1)).status,
    ).toBe(200);
    expect(m.queries).toHaveLength(2);
    expect(FAIL_TTL_MS).toBeLessThan(OK_TTL_MS);
  });

  test("concurrent requests share one query; still read-only", async () => {
    m.rows = full();
    const all = await Promise.all(
      Array.from({ length: 20 }, () => handlePaymentsHealth()),
    );
    expect(all.every((r) => r.status === 200)).toBe(true);
    expect(m.queries).toHaveLength(1);
    expect(m.queries.every((q) => q.startsWith("select"))).toBe(true);
  });

  test("database errors are not cached", async () => {
    m.rows = full();
    m.fail = true;
    expect((await handlePaymentsHealth()).status).toBe(503);
    m.fail = false;
    expect((await handlePaymentsHealth()).status).toBe(200);
  });
});

describe("no runtime DDL in application code", () => {
  test("no non-test source under src/ issues CREATE/ALTER/DROP", () => {
    const root = join(process.cwd(), "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name !== "__tests__") walk(p);
        } else if (/\.(ts|tsx)$/.test(name)) {
          const src = readFileSync(p, "utf8");
          if (
            /\b(create\s+(unique\s+)?(table|index)|alter\s+table|drop\s+(table|index))\b/i.test(
              src,
            )
          ) {
            offenders.push(relative(root, p));
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
