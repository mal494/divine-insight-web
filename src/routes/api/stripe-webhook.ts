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
import { verifyStripeSignature } from "~/lib/stripe-signature";

export const Route = createFileRoute("/api/stripe-webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
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
          // Real money, no order to attach it to — worth a log line.
          console.warn("paid session with no client_reference_id:", session.id);
          return new Response("no order reference", { status: 200 });
        }

        // Only count a session that actually collected the money.
        if (session.payment_status && session.payment_status !== "paid") {
          console.warn("session not paid:", session.id, session.payment_status);
          return new Response("not paid", { status: 200 });
        }

        const result = await markPaid({
          eventId: event.id,
          orderId,
          paymentIntent: session.payment_intent ?? null,
          sessionId: session.id ?? null,
          amountCents:
            typeof session.amount_total === "number" ? session.amount_total : null,
        });

        if (result !== "applied" && result !== "duplicate") {
          console.error("fulfilment refused:", result, orderId, session.id);
          return new Response(result, { status: 200 });
        }

        // A paid gift is the one SKU with something to deliver. Mint the claim
        // token and email the recipient. Failures here are logged, never
        // thrown: the payment is already good, and a non-2xx would make Stripe
        // retry the charge event for days over an email problem.
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
      },
    },
  },
});

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
    };
  };
};
