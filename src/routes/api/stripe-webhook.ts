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
 * never fix. Refusals are logged instead. The exception is a paid gift whose
 * delivery is not finished (claim token not minted, a gift email failed
 * transiently or is held by an in-flight delivery, or a bookkeeping error):
 * that answers 500 so Stripe retries, and the retry, which markPaid reports
 * as "duplicate" or "already-paid", re-runs the idempotent gift steps until
 * the claim link exists and each email has been sent and recorded once.
 */
import { createFileRoute } from "@tanstack/react-router";
import {
  claimUrlFor,
  giftEmailConfigured,
  sendGiftBuyerEmail,
  sendGiftEmail,
  type GiftSendResult,
} from "~/lib/gift-email";
import {
  GIFT_EMAIL_MIGRATION,
  GiftSchemaMissingError,
  type GiftEmailKind,
  createGiftClaim,
  getGiftDetails,
  markGiftEmailSent,
  releaseGiftEmail,
  reserveGiftEmail,
} from "~/lib/gifts";
import { markPaid, markPaymentFailed } from "~/lib/orders";
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

  if (event.type === "checkout.session.async_payment_failed") {
    return handleAsyncPaymentFailed(event);
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
  if (
    typeof session.amount_total !== "number" ||
    !Number.isFinite(session.amount_total)
  ) {
    console.warn(
      "session missing amount_total:",
      session.id,
      session.amount_total,
    );
    return new Response("invalid amount", { status: 200 });
  }
  if (
    typeof session.currency !== "string" ||
    session.currency.trim().length === 0
  ) {
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

  if (
    result !== "applied" &&
    result !== "duplicate" &&
    result !== "already-paid"
  ) {
    console.error("fulfilment refused:", result, orderId, session.id);
    return orphan(event, result, result);
  }

  // A paid gift is the one SKU with something to deliver, and it must never
  // be paid without a claim path. Mint the claim token on every successful
  // outcome (minting is idempotent, so a retry re-uses the one token), and
  // send the emails only from the call that actually created it.
  let gift: Awaited<ReturnType<typeof getGiftDetails>> = null;
  try {
    gift = await getGiftDetails(orderId);
  } catch (err) {
    console.error("gift lookup failed for order", orderId, err);
    // Non-2xx so Stripe retries: the retry re-runs this block (markPaid
    // answers "duplicate"/"already-paid") and mints the token then.
    return new Response("gift delivery pending", { status: 500 });
  }

  if (gift) {
    let claim: Awaited<ReturnType<typeof createGiftClaim>>;
    try {
      claim = await createGiftClaim(orderId);
    } catch (err) {
      console.error("gift claim mint failed for order", orderId, err);
      return new Response("gift delivery pending", { status: 500 });
    }

    if (claim.created && !gift.recipientEmail) {
      // Support breadcrumb. Never log the token itself: the link is the
      // recipient's only credential.
      console.warn(
        "paid gift has no recipient email — claim link shown to buyer only",
        { orderId, sessionId: session.id ?? null },
      );
    }

    // Gift emails are AT-LEAST-ONCE until recorded, then never again:
    //  - each send holds a short lease (gift_claims.*_email_lease_until);
    //  - *_emailed_at is set only AFTER Resend accepted the email;
    //  - a failed send releases the lease and answers 500, so Stripe retries;
    //  - a crash mid-send leaves only the lease, which expires, so the retry
    //    sends it (Resend's Idempotency-Key de-duplicates the rare case where
    //    the crash came after Resend accepted it).
    // This block runs on EVERY paid outcome ("applied", "already-paid",
    // "duplicate"), so a retry after any crash finishes the job.
    if (!claim.token) {
      // Existing hashed token that can no longer be re-derived (secret
      // rotated): the recipient's link still works; support can resend.
      console.error("gift claim link not re-derivable; emails skipped", { orderId });
      return new Response(result, { status: 200 });
    }
    const claimUrl = claimUrlFor(claim.token, request.url);
    const buyerEmail = session.customer_details?.email ?? session.customer_email ?? null;
    if (!giftEmailConfigured()) {
      // A retry cannot fix configuration; the buyer sees the link on the
      // confirmation page. Do not reserve anything.
      console.error("gift emails not configured (RESEND_API_KEY / GIFT_FROM_EMAIL); skipped", {
        orderId,
      });
      return new Response(result, { status: 200 });
    }
    if (!buyerEmail && claim.created) {
      console.warn("paid gift has no buyer email for receipt", { orderId });
    }
    const pending: string[] = [];
    try {
      if (gift.recipientEmail) {
        const to = gift.recipientEmail;
        const outcome = await deliverOnce(orderId, "recipient", () =>
          sendGiftEmail({
            to,
            senderName: gift.senderName,
            note: gift.note,
            claimUrl,
            idempotencyKey: `gift-recipient-${orderId}`,
          }),
        );
        if (outcome === "retry") pending.push("recipient");
      }
      if (buyerEmail) {
        const outcome = await deliverOnce(orderId, "buyer", () =>
          sendGiftBuyerEmail({
            to: buyerEmail,
            recipientEmail: gift.recipientEmail,
            claimUrl,
            idempotencyKey: `gift-buyer-${orderId}`,
          }),
        );
        if (outcome === "retry") pending.push("buyer");
      }
    } catch (err) {
      if (err instanceof GiftSchemaMissingError) {
        // Fail closed like the order-access schema: Stripe retries until the
        // migration is applied. The claim token already exists.
        console.error("gift email flags missing — apply", GIFT_EMAIL_MIGRATION, { orderId });
      } else {
        console.error("gift email bookkeeping failed for order", orderId, err);
      }
      return new Response("gift delivery pending", { status: 500 });
    }
    if (pending.length > 0) {
      console.error("gift email not delivered yet; asking Stripe to retry", { orderId, pending });
      return new Response("gift delivery pending", { status: 500 });
    }
  }

  return new Response(result, { status: 200 });
}

/**
 * Send one gift email for (order, kind) unless it was already sent.
 *   "done"  — sent now or earlier, permanently rejected, or retries exhausted
 *             (attempt/age cap, see giftEmailRetryPolicy); all logged.
 *   "retry" — a send failed transiently, or another delivery holds the lease;
 *             the caller answers non-2xx so Stripe redelivers.
 * Bookkeeping errors propagate (the caller answers 500).
 */
async function deliverOnce(
  orderId: string,
  kind: GiftEmailKind,
  send: () => Promise<GiftSendResult>,
): Promise<"done" | "retry"> {
  const reservation = await reserveGiftEmail(orderId, kind);
  if (reservation.status === "sent" || reservation.status === "gave-up") return "done";
  if (reservation.status !== "reserved") return "retry";
  const { lease } = reservation;
  let result: GiftSendResult;
  try {
    result = await send();
  } catch (err) {
    console.error("gift email send threw for order", orderId, kind, err);
    result = "failed";
  }
  if (result === "sent") {
    await markGiftEmailSent(orderId, kind);
    return "done";
  }
  if (result === "rejected") {
    const outcome = await releaseGiftEmail(orderId, kind, lease, { permanent: true });
    if (outcome === "retry") return "retry"; // lease lost to another delivery
    console.error("gift email permanently rejected; not retrying", { orderId, kind });
    return "done";
  }
  const next = await releaseGiftEmail(orderId, kind, lease);
  if (next === "gave-up") {
    // Never let a long provider outage make Stripe disable the endpoint. The
    // buyer still has the claim link on their confirmation view.
    console.error("gift email retries exhausted; giving up (buyer still has the link)", {
      orderId,
      kind,
    });
    return "done";
  }
  return "retry";
}

/**
 * A delayed payment (bank debit etc.) failed. The order was never paid, so
 * there is nothing to revoke: move it from pending to failed so the buyer's
 * page stops waiting, and never grant credits or mint a gift link. Idempotent;
 * always 2xx (a retry cannot change the outcome).
 */
async function handleAsyncPaymentFailed(event: StripeEvent): Promise<Response> {
  const session = event.data?.object ?? {};
  const orderId = session.client_reference_id;
  if (!orderId) return new Response("no order reference", { status: 200 });
  const result = await markPaymentFailed({
    eventId: event.id,
    orderId,
    sessionId: session.id ?? null,
  });
  if (result !== "failed") {
    console.warn(
      "async payment failed, order not updated:",
      result,
      orderId,
      session.id,
    );
  }
  return new Response(`payment-failed:${result}`, { status: 200 });
}

/**
 * Paid but unfulfillable: persist it for manual reissue/refund. 200 once
 * recorded (a retry can never fix it); 500 if the record could not be written,
 * so Stripe retries until it is.
 */
async function orphan(
  event: StripeEvent,
  reason: OrphanReason,
  body: string,
): Promise<Response> {
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
      customer_email?: string | null;
      customer_details?: { email?: string | null } | null;
    };
  };
};
