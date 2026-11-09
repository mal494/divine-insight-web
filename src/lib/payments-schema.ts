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

export async function checkPaymentsSchema(): Promise<{
  ok: boolean;
  missing: string[];
}> {
  const tables = Object.keys(REQUIRED_PAYMENTS_SCHEMA);
  const rows = (await sql()`
    select table_name, column_name
      from information_schema.columns
     where table_schema = current_schema()
       and table_name = any(${tables})`) as {
    table_name: string;
    column_name: string;
  }[];
  const missing = missingSchema(rows);
  return { ok: missing.length === 0, missing };
}
