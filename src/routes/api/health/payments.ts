/**
 * GET /api/health/payments — readiness of the one-time payments schema.
 *
 * 200 { ok: true } when every table/column the payments code needs exists
 * (see PAYMENTS_SCHEMA_REQUIREMENTS); 503 with the missing names and the
 * migration(s) to apply otherwise. Read-only (information_schema), no DDL,
 * no secrets. Check this on a deployment before sending traffic or testers.
 *
 * Load limits (it is public and unauthenticated):
 *   - a positive result is cached in memory per instance for OK_TTL_MS
 *     (schemas don't un-migrate; a fresh instance re-checks);
 *   - a negative result is cached for FAIL_TTL_MS, so a missing migration is
 *     noticed quickly once applied but polling cannot hammer the database;
 *   - concurrent requests share one in-flight query;
 *   - errors (database unreachable) are not cached.
 */
import { createFileRoute } from "@tanstack/react-router";
import {
  PAYMENTS_MIGRATION,
  checkPaymentsSchema,
  type PaymentsSchemaStatus,
} from "~/lib/payments-schema";

export const OK_TTL_MS = 60_000;
export const FAIL_TTL_MS = 5_000;

let cached: { status: PaymentsSchemaStatus; until: number } | null = null;
let inflight: Promise<PaymentsSchemaStatus> | null = null;

/** Test hook: forget the cached result. */
export function resetPaymentsHealthCache(): void {
  cached = null;
  inflight = null;
}

export const Route = createFileRoute("/api/health/payments")({
  server: {
    handlers: {
      GET: async () => handlePaymentsHealth(),
    },
  },
});

async function schemaStatus(now: number): Promise<PaymentsSchemaStatus> {
  if (cached && now < cached.until) return cached.status;
  inflight ??= checkPaymentsSchema()
    .then((status) => {
      cached = {
        status,
        until: Date.now() + (status.ok ? OK_TTL_MS : FAIL_TTL_MS),
      };
      return status;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export async function handlePaymentsHealth(
  now: number = Date.now(),
): Promise<Response> {
  try {
    const { ok, missing, migrations } = await schemaStatus(now);
    if (ok) return json({ ok: true }, 200);
    console.error(
      `payments schema not ready: apply ${migrations.join(", ")}`,
      missing,
    );
    return json(
      {
        ok: false,
        error: "schema_not_migrated",
        migration: migrations[0] ?? PAYMENTS_MIGRATION,
        migrations,
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
