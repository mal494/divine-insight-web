/**
 * Pro subscription billing: Checkout (subscription mode), Customer Portal and
 * the webhook-driven entitlement sync. One-time orders (lib/orders.ts,
 * /api/stripe-webhook) are intentionally not touched.
 *
 * Stripe is the source of truth: on every relevant event we re-fetch the
 * subscription rather than trusting event payload order.
 */
import { stripeRequest, type FetchLike } from "./stripe-api";

export type Queryable = { query: (text: string, values: unknown[]) => Promise<{ rows: any[] }> };

export type StripeSubscription = {
  id: string;
  status: string;
  customer: string;
  current_period_end?: number;
  metadata?: Record<string, string>;
  items?: { data?: Array<{ current_period_end?: number; price?: { id?: string; currency?: string } }> };
};

export function proPriceId(): string {
  const id = process.env.STRIPE_PRO_PRICE_ID;
  if (!id) throw new Error("STRIPE_PRO_PRICE_ID is not set");
  return id;
}

export async function getStripeCustomerId(userId: string, db: Queryable): Promise<string | null> {
  const { rows } = await db.query(
    `select stripe_customer_id from entitlements
      where user_id = $1 and plan = 'pro' and stripe_customer_id is not null limit 1`,
    [userId],
  );
  return rows[0]?.stripe_customer_id ?? null;
}

export async function createProCheckoutSession(
  args: { userId: string; email: string; origin: string; db: Queryable },
  fetchImpl?: FetchLike,
): Promise<string> {
  const customer = await getStripeCustomerId(args.userId, args.db);
  const session = await stripeRequest<{ url: string }>(
    "POST",
    "/checkout/sessions",
    {
      mode: "subscription",
      line_items: { 0: { price: proPriceId(), quantity: 1 } },
      client_reference_id: args.userId,
      customer: customer ?? undefined,
      customer_email: customer ? undefined : args.email,
      metadata: { user_id: args.userId, plan: "pro" },
      subscription_data: { metadata: { user_id: args.userId, plan: "pro" } },
      success_url: `${args.origin}/?pro=activating`,
      cancel_url: `${args.origin}/?pro=canceled`,
    },
    fetchImpl,
  );
  return session.url;
}

export async function createPortalSession(
  args: { userId: string; origin: string; db: Queryable },
  fetchImpl?: FetchLike,
): Promise<string | null> {
  const customer = await getStripeCustomerId(args.userId, args.db);
  if (!customer) return null;
  const portal = await stripeRequest<{ url: string }>(
    "POST",
    "/billing_portal/sessions",
    { customer, return_url: `${args.origin}/` },
    fetchImpl,
  );
  return portal.url;
}

export function fetchSubscription(id: string, fetchImpl?: FetchLike) {
  return stripeRequest<StripeSubscription>("GET", `/subscriptions/${encodeURIComponent(id)}`, {}, fetchImpl);
}

/** Returns false when the subscription isn't for the Pro price (ignored). */
export async function syncSubscription(
  sub: StripeSubscription,
  db: Queryable,
  userIdHint?: string | null,
): Promise<"synced" | "wrong-price" | "no-user"> {
  const item = sub.items?.data?.[0];
  if (item?.price?.id !== proPriceId()) return "wrong-price";

  let userId = sub.metadata?.user_id || userIdHint || null;
  if (!userId) {
    const { rows } = await db.query(
      `select user_id from entitlements where stripe_customer_id = $1 or stripe_subscription_id = $2 limit 1`,
      [sub.customer, sub.id],
    );
    userId = rows[0]?.user_id ?? null;
  }
  if (!userId) return "no-user";

  const periodEnd = sub.current_period_end ?? item?.current_period_end;
  await db.query(
    `insert into entitlements
       (user_id, plan, status, current_period_end, stripe_customer_id, stripe_subscription_id, stripe_price_id, updated_at)
     values ($1, 'pro', $2, $3, $4, $5, $6, now())
     on conflict (user_id, plan) do update set
       status = excluded.status,
       current_period_end = excluded.current_period_end,
       stripe_customer_id = excluded.stripe_customer_id,
       stripe_subscription_id = excluded.stripe_subscription_id,
       stripe_price_id = excluded.stripe_price_id,
       updated_at = now()`,
    [
      userId,
      sub.status,
      periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
      sub.customer,
      sub.id,
      item?.price?.id ?? null,
    ],
  );
  return "synced";
}
