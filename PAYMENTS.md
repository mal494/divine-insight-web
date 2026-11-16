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
3. Visitor pays. Stripe POSTs either `checkout.session.completed` (most
   methods) or `checkout.session.async_payment_succeeded` (delayed methods) to
   `/api/stripe-webhook` with that `client_reference_id`.
4. The webhook verifies the signature, checks `amount_total` and the currency
   against the amount and currency stored on that order at checkout (not
   against today's `SKUS` entry), and flips the order to `paid`.
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
- Events:
  - `checkout.session.completed`
  - `checkout.session.async_payment_succeeded`

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
stripe trigger checkout.session.async_payment_succeeded
```

`stripe listen` prints its own `whsec_...` - use that one locally.

End to end: open a reading, click the CTA, and pay with the
`4242 4242 4242 4242` test card. The draw should unlock on its own within a few
seconds of the receipt, without a refresh.

To check the gate actually holds, open `/api/order/<a made-up uuid>` - it must
answer 404, and `/api/reading` with that id must answer 402. `/claim/<junk>`
must show the expired-link page.

### Unit tests

`bun run test` covers the fulfilment decisions without Stripe or Postgres. See the table in `README.md`. The cases that matter here:

- `markPaid` is idempotent on `stripe_events`. A second delivery of the same event id does not overwrite the stored payment intent. A new event id for an order that is already `paid` returns `already-paid`.
- A charged amount that disagrees with the order row's captured `amountCents` returns `amount-mismatch` and leaves the order `pending`. A currency that disagrees returns `currency-mismatch`. Editing `SKUS` after the order exists does not change that comparison.
- `verifyStripeSignature` rejects timestamps more than 300 seconds from `now`, and accepts any `v1` candidate that matches during secret rotation.

These tests mock `~/db`. They do not boot the dev server or hit `/api/stripe-webhook`.

## Database

Four one-time tables, created on first use (`ensureSchema` / `ensureGiftSchema`).
Pro accounts do not use this path; apply `migrations/0001_pro_auth.sql` and
`migrations/0002_pro_subscriptions.sql` by hand.

- `orders` - one row per checkout attempt, with status, captured price, and remaining credits
- `readings` - every stored reading, keyed to its order (this is the journal)
- `stripe_events` - applied one-time webhook event ids, so a Stripe retry is a no-op
- `gift_claims` - one claim token per gift order (32 hex characters, 128 bits). The token is the primary key and is stored as issued. A second insert for the same order keeps the first token

## Divine Insight Pro

Pro is not a key in `SKUS`, and `/api/stripe-webhook` does not grant it. The
one-time ladder above is unchanged. Subscription state lives in
`entitlements`, written only by `/api/stripe-subscription-webhook`. The pages
do not read that table. A paid subscription does not flip the UI.

### What the UI gates

Pro surfaces are hidden, not blurred. `PremiumGate` returns `null` while
`loading` is true or `isPremium` is false, so free visitors do not get the
gated markup at all.

| Surface | What a free visitor sees |
| --- | --- |
| Three-card Past / Present / Future (`#reading`) | Hidden. `PremiumGate` does not mount the section. |
| Journal tab | Hidden. The tab renders only when `isPremium` is true, and the panel is still wrapped in `PremiumGate`. The list is the hardcoded `SAMPLE_ENTRIES` in `src/components/Journal.tsx`. |
| Hero | Two links: **See today's free card** (`#daily-card`) and **Browse paid readings** (`#paid-readings`). The three-card draw control is not shown. |
| Card of the Day | Always visible. Its CTA goes to `#paid-readings`. |
| Extended tab | Not wrapped in `PremiumGate`. `useEntitlement("extendedReading")` still unlocks a paid one-time reading, and a `readingBundle` order unlocks that draw too. |
| Pricing, Single Insight, Gift, tips, All Cards | Unchanged one-time SKU flow. No Pro upgrade copy. |

The Celtic Cross and 1-to-5 vector scoring screens are not built. The Extended
tab is still the five-card spread in `src/components/extended-reading.tsx`.

### Where the flag lives

`SubscriptionProvider` (`src/context/SubscriptionContext.tsx`) wraps the app
from `src/routes/__root.tsx`.

- Production builds never read `localStorage`. `verifyPremiumStatus` returns
  false, and `setIsPremium` / `togglePremium` leave the flag off.
- In `import.meta.env.DEV` only, the flag is `localStorage["di.subscription.isPremium"] === "true"`.
  During SSR (`window` is missing) it is false.
- `PremiumDevToggle` renders only in dev (bottom-right **Pro: On / Off**).
  Checkout does not call `setIsPremium`.

Setting the localStorage key in a production build does nothing. The flag is
only a dev preview. The home page has no upgrade button.

### Server subscription

`POST /api/pro/checkout` and `POST /api/pro/portal` require a session.
`userFromRequest` returns null when `DATABASE_URL` or `BETTER_AUTH_SECRET` is
unset, and both routes then answer 401 `sign_in_required`.

Checkout (`src/lib/billing/pro.ts`) creates a Stripe Checkout Session in
`subscription` mode with `STRIPE_SECRET_KEY` and `STRIPE_PRO_PRICE_ID`.
`client_reference_id` and the subscription metadata are the user id. Success
lands on `/?pro=activating` and cancel on `/?pro=canceled`, using
`BETTER_AUTH_URL` when it is set and the request origin otherwise. A missing
price id, a missing secret key, or any other thrown error becomes 503
`checkout_unavailable`.

The portal answers 404 `no_subscription` when that user has no
`stripe_customer_id` on an entitlements row. A missing secret key or a Stripe
error becomes 503 `portal_unavailable`.

`POST /api/stripe-subscription-webhook` uses `STRIPE_PRO_WEBHOOK_SECRET`
(a different endpoint and secret from `/api/stripe-webhook`). It handles:

- `checkout.session.completed` only when `mode` is `subscription` (a payment-mode session is ignored)
- `customer.subscription.created`, `updated`, and `deleted`
- `invoice.paid` and `invoice.payment_failed`

Each event id is inserted into `stripe_subscription_events` first. A repeat
returns 200 `duplicate`. The handler then re-fetches the subscription from
Stripe and upserts `entitlements` only when the price id equals
`STRIPE_PRO_PRICE_ID`. Any other price is `wrong-price` and is not written.
No user id on the subscription, and no existing row for that customer, is
`no-user`. On `customer.subscription.deleted`, a failed fetch falls back to
the event payload with status `canceled`. If processing throws, the claim row
is deleted and the response is 500 so Stripe retries. A missing signing
secret is 500 and writes nothing.

`hasPro` treats `active`, `trialing`, and `past_due` as entitled when
`current_period_end` is null or still in the future. Apply `migrations/0002_pro_subscriptions.sql` after
`0001` before relying on the Stripe columns. `go-live.sh` does not forward
`STRIPE_SECRET_KEY`, `STRIPE_PRO_PRICE_ID`, or `STRIPE_PRO_WEBHOOK_SECRET`.

`src/lib/stripe-checkout.ts` exports `redirectToProCheckout` and
`redirectToBillingPortal`. They POST the routes above and follow the returned
URL; a 401 sends the browser to `/signin`. No component imports them, and
`SubscriptionContext` does not read `?pro=activating`.

### Trying the gate locally

```sh
bun run dev
```

Use **Pro: On** in the corner to preview the three-card section and Journal.
The choice persists in this browser under `di.subscription.isPremium` for dev
builds only. A production build has no toggle and no upgrade button.

## Still to do

- Readings are composed client-side and posted back, so the server decides
  *access* while the client decides *when a credit is spent*. Worst case a
  visitor under-spends their own credits. Closing it means generating readings
  server-side, which is a much larger refactor.
- The Journal tab is a Pro-gated preview of sample entries. Stored readings
  are still only `GET /api/order/<id>?include=readings`.
- Tips stay honor-based on purpose. A tip unlocks nothing, so there is nothing
  to verify.
- The dev toggle is the only way the pages show Pro. Checkout and the
  entitlement row exist on the server, and no page calls `hasPro` or
  `redirectToProCheckout`. The toggle does not write `orders` or
  `entitlements`.
