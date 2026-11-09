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
 * by migrations/0004_order_access_and_orphans.sql), and the token itself never
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
export const ORDER_ACCESS_MIGRATION =
  "migrations/0004_order_access_and_orphans.sql";

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

/** Postgres undefined_column / undefined_table. */
export function isMissingSchemaError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "42703" || code === "42P01";
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
 * Whether id-only access for pre-token orders is still allowed.
 * Unset/blank → open (default). Valid date in the future → open. Past → closed.
 * Unparseable → closed (fail closed on a typo).
 */
export function legacyAccessOpen(
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date(),
): boolean {
  const raw = env.LEGACY_ORDER_ACCESS_UNTIL?.trim();
  if (!raw) return true;
  const until = Date.parse(raw);
  if (Number.isNaN(until)) {
    console.error(
      "LEGACY_ORDER_ACCESS_UNTIL is not a valid date; legacy order access closed",
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
