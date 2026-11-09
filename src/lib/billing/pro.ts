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

/**
 * The user's single Stripe Customer, created server-side BEFORE their first
 * Checkout and stored on the entitlement row (status 'incomplete', which does
 * not grant Pro). Every Checkout then passes `customer`, so concurrent tabs
 * share one customer: the webhook's "other active subscription for this
 * customer" check and the Customer Portal both see every subscription.
 *
 * Concurrency: the Stripe call uses a per-user Idempotency-Key, so two tabs
 * racing within Stripe's 24h idempotency window get the same customer; the DB
 * write keeps whichever customer was stored first (coalesce) and we use that.
 */
export async function ensureStripeCustomer(
  args: { userId: string; email: string; db: Queryable },
  fetchImpl?: FetchLike,
): Promise<string> {
  const existing = await getStripeCustomerId(args.userId, args.db);
  if (existing) return existing;
  const created = await stripeRequest<{ id: string }>(
    "POST",
    "/customers",
    { email: args.email, metadata: { user_id: args.userId } },
    fetchImpl,
    { idempotencyKey: `di-pro-customer:${args.userId}` }, // user id only: no personal data in Stripe request metadata
  );
  const { rows } = await args.db.query(
    `insert into entitlements (user_id, plan, status, stripe_customer_id, updated_at)
     values ($1, 'pro', 'incomplete', $2, now())
     on conflict (user_id, plan) do update set
       stripe_customer_id = coalesce(entitlements.stripe_customer_id, excluded.stripe_customer_id),
       updated_at = now()
     returning stripe_customer_id`,
    [args.userId, created.id],
  );
  return rows[0]?.stripe_customer_id ?? created.id;
}

/**
 * Validates config BEFORE any side effect: a missing STRIPE_SECRET_KEY or
 * STRIPE_PRO_PRICE_ID throws here, so no Stripe customer is created and no
 * entitlements row is written for a checkout that could never start.
 */
export async function createProCheckoutSession(
  args: { userId: string; email: string; origin: string; db: Queryable },
  fetchImpl?: FetchLike,
): Promise<string> {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY is not set");
  const price = proPriceId();
  const customer = await ensureStripeCustomer(args, fetchImpl);
  const session = await stripeRequest<{ url: string }>(
    "POST",
    "/checkout/sessions",
    {
      mode: "subscription",
      line_items: { 0: { price, quantity: 1 } },
      client_reference_id: args.userId,
      customer,
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

export const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due"]);

/**
 * Another Pro subscription for the same customer that still grants access,
 * other than `excludeId`. Used so a cancelled/expired subscription never
 * revokes Pro while a second one keeps billing.
 */
export async function findOtherActiveProSubscription(
  customer: string,
  excludeId: string,
  fetchImpl?: FetchLike,
): Promise<StripeSubscription | null> {
  const list = await stripeRequest<{ data?: StripeSubscription[] }>(
    "GET",
    "/subscriptions",
    { customer, status: "all", limit: 20 },
    fetchImpl,
  );
  const price = proPriceId();
  return (
    (list.data ?? []).find(
      (s) =>
        s.id !== excludeId &&
        ACTIVE_SUBSCRIPTION_STATUSES.has(s.status) &&
        s.items?.data?.[0]?.price?.id === price,
    ) ?? null
  );
}

export function fetchSubscription(id: string, fetchImpl?: FetchLike) {
  return stripeRequest<StripeSubscription>("GET", `/subscriptions/${encodeURIComponent(id)}`, {}, fetchImpl);
}

/** Returns false when the subscription isn't for the Pro price (ignored). */
export async function syncSubscription(
  sub: StripeSubscription,
  db: Queryable,
  userIdHint?: string | null,
): Promise<"synced" | "wrong-price" | "no-user" | "superseded"> {
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
  // Guard against double subscriptions: an event for a subscription that is
  // NOT the one stored on the row may only overwrite it when it would grant
  // access, or when the stored one no longer grants access. So cancelling an
  // old subscription never revokes a newer one that is still billing.
  const { rows: applied } = await db.query(
    `insert into entitlements
       (user_id, plan, status, current_period_end, stripe_customer_id, stripe_subscription_id, stripe_price_id, updated_at)
     values ($1, 'pro', $2, $3, $4, $5, $6, now())
     on conflict (user_id, plan) do update set
       status = excluded.status,
       current_period_end = excluded.current_period_end,
       stripe_customer_id = excluded.stripe_customer_id,
       stripe_subscription_id = excluded.stripe_subscription_id,
       stripe_price_id = excluded.stripe_price_id,
       updated_at = now()
     where entitlements.stripe_subscription_id is null
        or entitlements.stripe_subscription_id = excluded.stripe_subscription_id
        or excluded.status in ('active', 'trialing', 'past_due')
        or not (entitlements.status in ('active', 'trialing', 'past_due')
                and (entitlements.current_period_end is null or entitlements.current_period_end > now()))
     returning user_id`,
    [
      userId,
      sub.status,
      periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
      sub.customer,
      sub.id,
      item?.price?.id ?? null,
    ],
  );
  if (applied.length === 0) return "superseded";
  return "synced";
}
