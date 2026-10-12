# Payments

How a paid reading on Divine Insight actually becomes paid, and what you have
to configure before it works.

## The rule

An order becomes `paid` in exactly one place: `src/routes/api/stripe-webhook.ts`,
after Stripe's signature has been verified. Nothing else in the codebase may
write that status, and the browser is never believed about entitlement - it
holds an order id, and the server says what that id is worth.

Before this, fulfilment was honor-based: the unlock CTA opened a Stripe payment
link and the draw was never gated, so every paid reading was free to anyone who
scrolled past the CTA.

## The flow

1. Visitor clicks a CTA. The browser POSTs `{ sku }` to `/api/checkout` - a SKU
   key, never a price.
2. `/api/checkout` opens a `pending` order, looks the price up in its own table
   (`SKUS` in `src/lib/orders.ts`), and returns the Stripe payment link with
   `?client_reference_id=<order id>` appended.
3. Visitor pays. Stripe POSTs `checkout.session.completed` to
   `/api/stripe-webhook` with that `client_reference_id`.
4. The webhook verifies the signature, checks `amount_total` against the SKU's
   price, and flips the order to `paid`.
5. The section has been polling `/api/order/<id>`; it sees `paid` and unlocks
   the draw.
6. When the cards are down, the page POSTs the reading to `/api/reading`, which
   spends one credit and stores it. The Reading Bundle is simply an order with
   three credits, and it unlocks the Extended Reading.

## Gift Readings

A gift is the one SKU with something to deliver, so it has an extra leg:

1. Checkout captures the recipient's email, the sender's name, and an optional
   note, and stores them on the order.
2. When the webhook marks a gift order paid, it mints a single-use claim token
   (`gift_claims`) and emails the recipient a link to `/claim/<token>`.
3. The recipient opens the link, turns one card, and that POST burns the token,
   spends the credit, and stores the reading.
4. Re-opening the link shows the same card again rather than drawing a new one,
   so it keeps working as a keepsake.

The token is the recipient's only credential - no account, no sign-in. It is
128 bits of randomness and is not derivable from the order id.

Email delivery failures are logged, never thrown. The payment is already good
by that point, and a non-2xx would make Stripe retry the charge event for days
over an email problem.

## What you have to set up

| Variable | Where it comes from |
| --- | --- |
| `DATABASE_URL` | Already handled - the Neon database card injects it. Re-run `bun run go-live` after connecting so production picks it up. |
| `STRIPE_WEBHOOK_SECRET` | Stripe Dashboard, Developers, Webhooks, your endpoint, Signing secret (`whsec_...`). |
| `RESEND_API_KEY` | Resend dashboard. Only needed for Gift Readings. |
| `GIFT_FROM_EMAIL` | A sender verified in Resend, e.g. `Divine Insight <readings@yourdomain>`. |
| `PUBLIC_SITE_URL` | Optional. The origin used to build claim links; falls back to the request's own origin. |

`go-live.sh` now fails fast if `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, or
`GIFT_FROM_EMAIL` is missing, and injects those values into the deployment with
`-e` so production deploys cannot silently omit payment/email secrets.

Without `STRIPE_WEBHOOK_SECRET` the webhook refuses every request, which means
no order ever becomes paid. That is the intended failure direction: a
misconfigured site sells nothing rather than giving everything away.

Without `RESEND_API_KEY` and `GIFT_FROM_EMAIL`, gift orders still complete and
are still claimable - the email just never goes out, and the failure is logged.
Set both before selling gifts.

**A webhook endpoint in Stripe**

- URL: `https://<your site>/api/stripe-webhook`
- Event: `checkout.session.completed` (that one event is enough)

**Payment links**

The four links in `src/lib/payments.ts` are Stripe Payment Links. Appending
`?client_reference_id=<uuid>` works on them out of the box - no dashboard change
needed. Just do not edit a link's price in the dashboard without updating
`SKUS`, because the webhook compares the two and refuses to fulfil on a
mismatch.

## Testing it

```sh
stripe listen --forward-to localhost:3000/api/stripe-webhook
stripe trigger checkout.session.completed
```

`stripe listen` prints its own `whsec_...` - use that one locally.

End to end: open a reading, click the CTA, and pay with the
`4242 4242 4242 4242` test card. The draw should unlock on its own within a few
seconds of the receipt, without a refresh.

To check the gate actually holds, open `/api/order/<a made-up uuid>` - it must
answer 404, and `/api/reading` with that id must answer 402. `/claim/<junk>`
must show the expired-link page.

## Database

Four tables, created on first use (this template has no migration runner, so
the schema bootstraps itself):

- `orders` - one row per checkout attempt, with status and remaining credits
- `readings` - every stored reading, keyed to its order (this is the journal)
- `stripe_events` - applied webhook event ids, so a Stripe retry is a no-op
- `gift_claims` - single-use claim tokens for Gift Readings

## Still to do

- Readings are composed client-side and posted back, so the server decides
  *access* while the client decides *when a credit is spent*. Worst case a
  visitor under-spends their own credits. Closing it means generating readings
  server-side, which is a much larger refactor.
- The stored readings have no UI yet beyond the bundle's own section. The
  journal is `/api/order/<id>?include=readings` waiting for a page.
- Tips stay honor-based on purpose. A tip unlocks nothing, so there is nothing
  to verify.
