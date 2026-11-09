/**
 * POST /api/stripe-webhook — the ONLY place an order becomes paid.
 *
 * Stripe posts here when a checkout completes (or later settles for delayed
 * methods). We verify the signature against STRIPE_WEBHOOK_SECRET, pull
 * `client_reference_id` (the order id we appended to the payment link), check
 * the amount against our own price table, and flip the order to paid. Nothing
 * else in the codebase may write `status = 'paid'`.
 *
 * Point a Stripe endpoint at https://<site>/api/stripe-webhook subscribed to
 * `checkout.session.completed` and `checkout.session.async_payment_succeeded`,
 * and put its signing secret in STRIPE_WEBHOOK_SECRET. See PAYMENTS.md.
 *
 * Always answer 200 once the signature is good, even when we decide not to
 * fulfil — a non-2xx makes Stripe retry for days over something a retry will
 * never fix. Refusals are logged instead.
 */
import { createFileRoute } from "@tanstack/react-router";
import { claimUrlFor, sendGiftEmail } from "~/lib/gift-email";
import { createGiftClaim, getGiftDetails } from "~/lib/gifts";
import { markPaid } from "~/lib/orders";
import { recordOrphanPayment, type OrphanReason } from "~/lib/orphan-payments";
import { verifyStripeSignature } from "~/lib/stripe-signature";

export const Route = createFileRoute("/api/stripe-webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => handleStripeWebhook(request),
    },
  },
});

export async function handleStripeWebhook(request: Request): Promise<Response> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("STRIPE_WEBHOOK_SECRET is not set — refusing webhook");
    return new Response("not configured", { status: 500 });
  }

  // Raw body, byte for byte. Parsing before verifying would break the
  // signature; see lib/stripe-signature.ts.
  const payload = await request.text();
  const verdict = await verifyStripeSignature({
    payload,
    header: request.headers.get("stripe-signature"),
    secret,
  });
  if (!verdict.ok) {
    console.warn("stripe webhook rejected:", verdict.reason);
    return new Response("invalid signature", { status: 400 });
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(payload) as StripeEvent;
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  if (
    event.type !== "checkout.session.completed" &&
    event.type !== "checkout.session.async_payment_succeeded"
  ) {
    return new Response("ignored", { status: 200 });
  }

  const session = event.data?.object ?? {};
  const orderId = session.client_reference_id;
  if (!orderId) {
    // A payment link opened directly, without going through /api/checkout.
    // Real money, no order (for a gift: no recipient, no claim link). Record
    // it for support instead of dropping it; see ~/lib/orphan-payments.
    console.warn("paid session with no client_reference_id:", session.id);
    if (session.payment_status === "paid") {
      return orphan(event, "no-order-reference", "no order reference");
    }
    return new Response("no order reference", { status: 200 });
  }

  // Fail closed. If Stripe did not explicitly mark this session paid with an
  // amount and currency, do not fulfil it.
  if (session.payment_status !== "paid") {
    console.warn("session not paid:", session.id, session.payment_status);
    return new Response("not paid", { status: 200 });
  }
  if (typeof session.amount_total !== "number" || !Number.isFinite(session.amount_total)) {
    console.warn("session missing amount_total:", session.id, session.amount_total);
    return new Response("invalid amount", { status: 200 });
  }
  if (typeof session.currency !== "string" || session.currency.trim().length === 0) {
    console.warn("session missing currency:", session.id, session.currency);
    return new Response("invalid currency", { status: 200 });
  }

  const result = await markPaid({
    eventId: event.id,
    orderId,
    paymentIntent: session.payment_intent ?? null,
    sessionId: session.id ?? null,
    amountCents: session.amount_total,
    currency: session.currency.toLowerCase(),
  });

  if (result !== "applied" && result !== "duplicate" && result !== "already-paid") {
    console.error("fulfilment refused:", result, orderId, session.id);
    return orphan(event, result, result);
  }

  // A paid gift is the one SKU with something to deliver. Mint the claim
  // token and email the recipient only on the first paid transition.
  if (result === "applied") {
    try {
      const gift = await getGiftDetails(orderId);
      if (gift?.recipientEmail) {
        const token = await createGiftClaim(orderId);
        await sendGiftEmail({
          to: gift.recipientEmail,
          senderName: gift.senderName,
          note: gift.note,
          claimUrl: claimUrlFor(token, request.url),
        });
      }
    } catch (err) {
      console.error("gift delivery failed for order", orderId, err);
    }
  }

  return new Response(result, { status: 200 });
}

/**
 * Paid but unfulfillable: persist it for manual reissue/refund. 200 once
 * recorded (a retry can never fix it); 500 if the record could not be written,
 * so Stripe retries until it is.
 */
async function orphan(event: StripeEvent, reason: OrphanReason, body: string): Promise<Response> {
  const s = event.data?.object ?? {};
  try {
    await recordOrphanPayment({
      sessionId: s.id ?? event.id,
      eventId: event.id,
      reason,
      orderRef: s.client_reference_id ?? null,
      paymentLink: s.payment_link ?? null,
      paymentIntent: s.payment_intent ?? null,
      amountCents: typeof s.amount_total === "number" ? s.amount_total : null,
      currency: s.currency ?? null,
      customerEmail: s.customer_details?.email ?? null,
    });
  } catch (err) {
    console.error("could not record orphan payment", s.id, err);
    return new Response("orphan record failed", { status: 500 });
  }
  return new Response(body, { status: 200 });
}

/** The slice of Stripe's event shape this endpoint reads. */
type StripeEvent = {
  id: string;
  type: string;
  data?: {
    object?: {
      id?: string;
      client_reference_id?: string;
      payment_intent?: string;
      payment_status?: string;
      amount_total?: number;
      currency?: string;
      payment_link?: string | null;
      customer_details?: { email?: string | null } | null;
    };
  };
};
