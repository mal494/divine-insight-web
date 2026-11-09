/**
 * order-access.ts — server-only: who may read or spend a one-time order.
 *
 * Order ids are random v4 UUIDs (122 bits), so they cannot be guessed — but
 * they are not secret either: the id travels to Stripe as
 * `client_reference_id` (it is in the checkout URL, browser history, the
 * Stripe dashboard and every webhook payload). Before this module, knowing the
 * id was enough to read the order's stored readings and spend its credits.
 *
 * Now /api/checkout also mints a per-order access token: 32 random bytes,
 * base64url. Only its SHA-256 hash is stored (orders.access_token_hash, added
 * by migrations/0004_payments_schema.sql), and the token itself never
 * goes to Stripe. The buyer's browser keeps it next to the order id and sends
 * it as the `x-order-token` header to GET /api/order/:id and POST /api/reading.
 *
 * Orders created before this change have no hash ("legacy"). They keep the
 * old id-only access until LEGACY_ORDER_ACCESS_UNTIL (an ISO date/time); unset
 * means open, a past date means legacy orders need a token they can't have
 * (support reissues or refunds), and an unparseable value fails closed.
 *
 * If the migration has not been applied, the lookup throws
 * OrderSchemaMissingError and the routes answer 503 — never a grant.
 *
 * Gift recipients are unaffected: they use their own single-use claim token
 * on /api/claim/:token and never see the order id or this token.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "~/db";

export const ORDER_TOKEN_HEADER = "x-order-token";
export const ORDER_ACCESS_MIGRATION = "migrations/0004_payments_schema.sql";

/** "granted": token matches. "legacy": pre-token order, id is enough. "denied": anything else. */
export type OrderAccess = "granted" | "legacy" | "denied";

export class OrderSchemaMissingError extends Error {
  constructor(cause: unknown) {
    super(`order access schema missing: apply ${ORDER_ACCESS_MIGRATION}`, {
      cause,
    });
    this.name = "OrderSchemaMissingError";
  }
}

/** Postgres undefined_column / undefined_table, raw or wrapped. */
export function isMissingSchemaError(err: unknown): boolean {
  if (err instanceof OrderSchemaMissingError) return true;
  const code = (err as { code?: unknown } | null)?.code;
  return code === "42703" || code === "42P01";
}

/** The 503 every one-time route gives when migration 0004 is missing. */
export function schemaNotMigratedResponse(
  route: string,
  err: unknown,
): Response {
  console.error(
    `${route}: payments schema missing, apply ${ORDER_ACCESS_MIGRATION}`,
    err,
  );
  return new Response(JSON.stringify({ error: "schema_not_migrated" }), {
    status: 503,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

export function hashOrderToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function newOrderAccessToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashOrderToken(token) };
}

/** 32 bytes base64url, unpadded = 43 chars. */
export function isOrderToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function orderTokenFrom(request: Request): string | null {
  return request.headers.get(ORDER_TOKEN_HEADER);
}

/**
 * Strict ISO 8601 date-time with an explicit zone: `YYYY-MM-DDTHH:MM[:SS[.fff]]`
 * followed by `Z` or `±HH:MM`. Date-only or zone-less values are rejected
 * because they would be read in whatever timezone the server happens to use.
 */
const STRICT_ISO_WITH_ZONE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-](\d{2}):(\d{2}))$/;

/** Parse LEGACY_ORDER_ACCESS_UNTIL; null if it is not strict ISO 8601 with a zone. */
export function parseStrictIsoInstant(raw: string): number | null {
  const m = STRICT_ISO_WITH_ZONE.exec(raw);
  if (!m) return null;
  const [, , mo, d, h, mi, sec, zone, zh, zm] = m;
  const inRange =
    +mo >= 1 &&
    +mo <= 12 &&
    +d >= 1 &&
    +d <= 31 &&
    +h <= 23 &&
    +mi <= 59 &&
    (sec === undefined || +sec <= 59) &&
    (zone === "Z" || (+zh <= 23 && +zm <= 59));
  if (!inRange) return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  // Reject calendar overflow such as 2027-02-31 (Date.parse would roll over).
  const shifted = new Date(
    t +
      (zone === "Z"
        ? 0
        : (zone[0] === "-" ? -1 : 1) * (+zh * 60 + +zm) * 60_000),
  );
  if (shifted.getUTCDate() !== +d) return null;
  return t;
}

/**
 * Whether id-only access for pre-token orders is still allowed.
 * Unset/blank → open (default). Strict ISO 8601 instant with a zone in the
 * future → open; now or past → closed. Anything else (date-only, no zone,
 * garbage) → closed with a warning (fail closed on a typo).
 */
export function legacyAccessOpen(
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date(),
): boolean {
  const raw = env.LEGACY_ORDER_ACCESS_UNTIL?.trim();
  if (!raw) return true;
  const until = parseStrictIsoInstant(raw);
  if (until === null) {
    console.warn(
      "LEGACY_ORDER_ACCESS_UNTIL must be ISO 8601 with a timezone (e.g. 2027-01-31T00:00:00Z); treating it as invalid, legacy order access closed",
    );
    return false;
  }
  return now.getTime() < until;
}

/** Pure decision, separated for testing. */
export function decideOrderAccess(
  storedHash: string | null | undefined,
  presented: string | null,
  legacyOpen = true,
): OrderAccess {
  if (storedHash === undefined) return "denied"; // no such order
  if (storedHash === null) return legacyOpen ? "legacy" : "denied";
  if (!isOrderToken(presented)) return "denied";
  const a = Buffer.from(hashOrderToken(presented), "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length || a.length === 0) return "denied";
  return timingSafeEqual(a, b) ? "granted" : "denied";
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

export async function checkOrderAccess(
  orderId: string,
  presented: string | null,
  env: Record<string, string | undefined> = process.env,
): Promise<OrderAccess> {
  if (!isUuid(orderId)) return "denied";
  let rows: unknown[];
  try {
    rows = await sql()`
      select access_token_hash
        from orders
       where id = ${orderId}
       limit 1`;
  } catch (err) {
    if (isMissingSchemaError(err)) throw new OrderSchemaMissingError(err);
    throw err;
  }
  const row = rows[0] as { access_token_hash: string | null } | undefined;
  return decideOrderAccess(
    row ? row.access_token_hash : undefined,
    presented,
    legacyAccessOpen(env),
  );
}
