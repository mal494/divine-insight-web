/**
 * GET /api/health/payments — readiness of the one-time payments schema.
 *
 * 200 { ok: true } when every table/column from
 * migrations/0004_payments_schema.sql exists; 503 with the missing names and
 * the migration to apply otherwise. Read-only (information_schema), no DDL,
 * no secrets. Check this on a deployment before sending traffic or testers.
 */
import { createFileRoute } from "@tanstack/react-router";
import { PAYMENTS_MIGRATION, checkPaymentsSchema } from "~/lib/payments-schema";

export const Route = createFileRoute("/api/health/payments")({
  server: {
    handlers: {
      GET: async () => handlePaymentsHealth(),
    },
  },
});

export async function handlePaymentsHealth(): Promise<Response> {
  try {
    const { ok, missing } = await checkPaymentsSchema();
    if (ok) return json({ ok: true }, 200);
    console.error(
      `payments schema not ready: apply ${PAYMENTS_MIGRATION}`,
      missing,
    );
    return json(
      {
        ok: false,
        error: "schema_not_migrated",
        migration: PAYMENTS_MIGRATION,
        missing,
      },
      503,
    );
  } catch (err) {
    console.error("payments health check failed", err);
    return json({ ok: false, error: "unavailable" }, 503);
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
