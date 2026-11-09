/**
 * orphan-payments.ts — server-only: paid Stripe sessions we could not fulfil.
 *
 * A Payment Link is a public URL. Someone can open it directly (or strip the
 * `client_reference_id` we append), pay, and arrive at the webhook with no
 * order to attach the money to. For a Gift Reading that also means no
 * recipient email and no claim link. The same is true when the reference is
 * not one of our orders, or the charged amount/currency disagrees with it.
 *
 * Product policy (PM, Nov 9): problem gifts go to support for a manual reissue
 * or refund; nothing is refunded automatically. So the webhook never silently
 * drops such a payment: it records it here (idempotent on the session id) and
 * logs an ORPHAN_PAYMENT line. If the write fails (including the table not
 * existing yet: it comes from migrations/0004_order_access_and_orphans.sql),
 * the webhook answers 500 so Stripe retries until the record lands.
 *
 * Support query:  select * from orphan_payments order by created_at desc;
 */
import { sql } from "~/db";

export type OrphanReason =
  | "no-order-reference"
  | "unknown-order"
  | "amount-mismatch"
  | "currency-mismatch";

export type OrphanPayment = {
  sessionId: string;
  eventId: string;
  reason: OrphanReason;
  orderRef: string | null;
  paymentLink: string | null;
  paymentIntent: string | null;
  amountCents: number | null;
  currency: string | null;
  customerEmail: string | null;
};

/** Record an unfulfilled paid session. Returns false when it was already recorded. */
export async function recordOrphanPayment(p: OrphanPayment): Promise<boolean> {
  const db = sql();
  const inserted = await db`
    insert into orphan_payments (
      stripe_session_id, stripe_event_id, reason, order_ref, stripe_payment_link,
      stripe_payment_intent, amount_cents, currency, customer_email
    )
    values (
      ${p.sessionId}, ${p.eventId}, ${p.reason}, ${p.orderRef}, ${p.paymentLink},
      ${p.paymentIntent}, ${p.amountCents}, ${p.currency}, ${p.customerEmail}
    )
    on conflict (stripe_session_id) do nothing
    returning stripe_session_id`;
  // One greppable line for alerting; amounts and ids only, no email in logs.
  console.error(
    "ORPHAN_PAYMENT",
    JSON.stringify({
      reason: p.reason,
      session: p.sessionId,
      paymentLink: p.paymentLink,
      amountCents: p.amountCents,
      currency: p.currency,
      new: inserted.length > 0,
    }),
  );
  return inserted.length > 0;
}
