/**
 * Handler for POST /api/stripe-subscription-webhook (Pro only).
 *
 * Separate endpoint + signing secret (STRIPE_PRO_WEBHOOK_SECRET) so the
 * one-time order webhook stays exactly as it is. Events:
 *   checkout.session.completed (mode=subscription), customer.subscription.created,
 *   customer.subscription.updated, customer.subscription.deleted,
 *   invoice.paid, invoice.payment_failed.
 * Each event id is processed once (stripe_subscription_events). If processing
 * throws, the claim is released and we return 500 so Stripe retries.
 */
import { verifyStripeSignature } from "~/lib/stripe-signature";
import { fetchSubscription, syncSubscription, type Queryable, type StripeSubscription } from "./pro";
import type { FetchLike } from "./stripe-api";

type Obj = Record<string, any>;
const HANDLED = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
]);

export async function handleSubscriptionWebhook(
  request: Request,
  deps: { db: () => Queryable; fetchImpl?: FetchLike },
): Promise<Response> {
  const secret = process.env.STRIPE_PRO_WEBHOOK_SECRET;
  if (!secret) {
    console.error("STRIPE_PRO_WEBHOOK_SECRET is not set — refusing webhook");
    return new Response("not configured", { status: 500 });
  }
  const payload = await request.text();
  const verdict = await verifyStripeSignature({
    payload,
    header: request.headers.get("stripe-signature"),
    secret,
  });
  if (!verdict.ok) return new Response("invalid signature", { status: 400 });

  let event: { id: string; type: string; data?: { object?: Obj } };
  try {
    event = JSON.parse(payload);
  } catch {
    return new Response("invalid json", { status: 400 });
  }
  if (!event?.id || !HANDLED.has(event.type)) return new Response("ignored", { status: 200 });

  const obj = event.data?.object ?? {};
  let subscriptionId: string | null = null;
  let userIdHint: string | null = null;
  if (event.type === "checkout.session.completed") {
    if (obj.mode !== "subscription") return new Response("ignored", { status: 200 });
    subscriptionId = typeof obj.subscription === "string" ? obj.subscription : obj.subscription?.id ?? null;
    userIdHint = obj.client_reference_id ?? obj.metadata?.user_id ?? null;
  } else if (event.type.startsWith("customer.subscription.")) {
    subscriptionId = obj.id ?? null;
  } else {
    subscriptionId =
      typeof obj.subscription === "string"
        ? obj.subscription
        : obj.parent?.subscription_details?.subscription ?? null;
  }
  if (!subscriptionId) return new Response("no subscription", { status: 200 });

  const db = deps.db();
  const claim = await db.query(
    `insert into stripe_subscription_events (event_id, type) values ($1, $2)
     on conflict (event_id) do nothing returning event_id`,
    [event.id, event.type],
  );
  if (claim.rows.length === 0) return new Response("duplicate", { status: 200 });

  try {
    let sub: StripeSubscription;
    try {
      sub = await fetchSubscription(subscriptionId, deps.fetchImpl);
    } catch (err) {
      // A deleted subscription can still be fetched, but fall back to the
      // payload for deletions so a revoke is never lost.
      if (event.type !== "customer.subscription.deleted") throw err;
      sub = { ...(obj as StripeSubscription), status: "canceled" };
    }
    const result = await syncSubscription(sub, db, userIdHint);
    if (result !== "synced") console.warn("subscription not synced:", result, subscriptionId);
    return new Response(result, { status: 200 });
  } catch (err) {
    console.error("subscription webhook failed", event.id, err);
    await db.query(`delete from stripe_subscription_events where event_id = $1`, [event.id]).catch(() => {});
    return new Response("retry", { status: 500 });
  }
}
