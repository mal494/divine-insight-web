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
 * base64url. Only its SHA-256 hash is stored (orders.access_token_hash), and
 * the token itself never goes to Stripe. The buyer's browser keeps it next to
 * the order id and sends it as the `x-order-token` header to
 * GET /api/order/:id and POST /api/reading.
 *
 * Orders created before this change have no hash. They are "legacy" and keep
 * the old id-only behaviour so existing buyers don't lose unspent credits.
 *
 * Gift recipients are unaffected: they use their own single-use claim token
 * on /api/claim/:token and never see the order id or this token.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "~/db";
import { ensureSchema, isUuid } from "~/lib/orders";

export const ORDER_TOKEN_HEADER = "x-order-token";

/** "granted": token matches. "legacy": pre-token order, id is enough. "denied": anything else. */
export type OrderAccess = "granted" | "legacy" | "denied";

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

/** Pure decision, separated for testing. */
export function decideOrderAccess(
  storedHash: string | null | undefined,
  presented: string | null,
): OrderAccess {
  if (storedHash === undefined) return "denied"; // no such order
  if (storedHash === null) return "legacy";
  if (!isOrderToken(presented)) return "denied";
  const a = Buffer.from(hashOrderToken(presented), "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length || a.length === 0) return "denied";
  return timingSafeEqual(a, b) ? "granted" : "denied";
}

export async function checkOrderAccess(
  orderId: string,
  presented: string | null,
): Promise<OrderAccess> {
  if (!isUuid(orderId)) return "denied";
  await ensureSchema();
  const rows = await sql()`
    select access_token_hash
      from orders
     where id = ${orderId}
     limit 1`;
  const row = rows[0] as { access_token_hash: string | null } | undefined;
  return decideOrderAccess(row ? row.access_token_hash : undefined, presented);
}
