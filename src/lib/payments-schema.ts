/**
 * payments-schema.ts — server-only readiness check for the one-time payments
 * schema (migrations/0004_payments_schema.sql). Read-only: it only queries
 * information_schema and never runs DDL.
 */
import { sql } from "~/db";

export const PAYMENTS_MIGRATION = "migrations/0004_payments_schema.sql";

/** Tables and the columns the code reads or writes. */
export const REQUIRED_PAYMENTS_SCHEMA: Record<string, string[]> = {
  orders: [
    "id",
    "sku",
    "status",
    "credits",
    "amount_cents",
    "amount_currency",
    "stripe_session_id",
    "stripe_payment_intent",
    "recipient_email",
    "sender_name",
    "note",
    "created_at",
    "paid_at",
    "access_token_hash",
  ],
  readings: ["id", "order_id", "payload", "created_at"],
  stripe_events: ["id"],
  gift_claims: ["token", "order_id", "claimed", "claimed_at", "created_at"],
  orphan_payments: [
    "stripe_session_id",
    "stripe_event_id",
    "reason",
    "order_ref",
    "stripe_payment_link",
    "stripe_payment_intent",
    "amount_cents",
    "currency",
    "customer_email",
    "created_at",
    "resolved_at",
  ],
};

/**
 * Every migration the payments code depends on, with the tables/columns it
 * provides. Later PRs append their own entry (e.g. #32's 0005 email flags)
 * so the readiness check names exactly which file is missing.
 */
export const PAYMENTS_SCHEMA_REQUIREMENTS: {
  migration: string;
  schema: Record<string, string[]>;
}[] = [{ migration: PAYMENTS_MIGRATION, schema: REQUIRED_PAYMENTS_SCHEMA }];

/** Pure diff, separated for testing. Returns "table" or "table.column" entries. */
export function missingSchema(
  present: { table_name: string; column_name: string }[],
  required: Record<string, string[]> = REQUIRED_PAYMENTS_SCHEMA,
): string[] {
  const have = new Map<string, Set<string>>();
  for (const r of present) {
    if (!have.has(r.table_name)) have.set(r.table_name, new Set());
    have.get(r.table_name)!.add(r.column_name);
  }
  const missing: string[] = [];
  for (const [table, cols] of Object.entries(required)) {
    const got = have.get(table);
    if (!got) {
      missing.push(table);
      continue;
    }
    for (const c of cols) if (!got.has(c)) missing.push(`${table}.${c}`);
  }
  return missing;
}

export type PaymentsSchemaStatus = {
  ok: boolean;
  /** "table" or "table.column" entries, de-duplicated, in requirement order. */
  missing: string[];
  /** Migration files that would supply what is missing, in apply order. */
  migrations: string[];
};

/** Pure: evaluate every requirement against information_schema rows. */
export function evaluatePaymentsSchema(
  present: { table_name: string; column_name: string }[],
  requirements = PAYMENTS_SCHEMA_REQUIREMENTS,
): PaymentsSchemaStatus {
  const missing: string[] = [];
  const migrations: string[] = [];
  for (const req of requirements) {
    const gaps = missingSchema(present, req.schema).filter(
      (g) => !missing.includes(g),
    );
    if (gaps.length === 0) continue;
    missing.push(...gaps);
    if (!migrations.includes(req.migration)) migrations.push(req.migration);
  }
  return { ok: missing.length === 0, missing, migrations };
}

export async function checkPaymentsSchema(
  requirements = PAYMENTS_SCHEMA_REQUIREMENTS,
): Promise<PaymentsSchemaStatus> {
  const tables = [
    ...new Set(requirements.flatMap((r) => Object.keys(r.schema))),
  ];
  const rows = (await sql()`
    select table_name, column_name
      from information_schema.columns
     where table_schema = current_schema()
       and table_name = any(${tables})`) as {
    table_name: string;
    column_name: string;
  }[];
  return evaluatePaymentsSchema(rows, requirements);
}
