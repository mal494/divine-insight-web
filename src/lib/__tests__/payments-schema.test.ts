import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";

const m = vi.hoisted(() => ({
  rows: [] as { table_name: string; column_name: string }[],
  queries: [] as string[],
}));
vi.mock("~/db", () => ({
  sql: () => async (strings: TemplateStringsArray) => {
    const q = strings.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
    m.queries.push(q);
    if (/^(create|alter|drop)\b/.test(q)) throw new Error(`runtime DDL: ${q}`);
    return m.rows;
  },
}));

import { REQUIRED_PAYMENTS_SCHEMA, missingSchema } from "~/lib/payments-schema";
import { handlePaymentsHealth } from "~/routes/api/health/payments";

const full = () =>
  Object.entries(REQUIRED_PAYMENTS_SCHEMA).flatMap(([table_name, cols]) =>
    cols.map((column_name) => ({ table_name, column_name })),
  );

beforeEach(() => {
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
      missing: ["orphan_payments"],
    });
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
