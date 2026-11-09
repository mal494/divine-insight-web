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
   (`SKUS` in `src/lib/orders.ts`), and returns the Stripe payment link for the
   current environment (`src/lib/payment-links.ts`) with
   `?client_reference_id=<order id>` appended. It also returns a one-time
   `accessToken` for the order (only its SHA-256 hash is stored); the browser
   keeps it in localStorage and sends it as `x-order-token`.
3. Visitor pays. Stripe POSTs either `checkout.session.completed` (most
   methods) or `checkout.session.async_payment_succeeded` (delayed methods) to
   `/api/stripe-webhook` with that `client_reference_id`.
4. The webhook verifies the signature, checks `amount_total` against the SKU's
   price, and flips the order to `paid`.
5. The section has been polling `/api/order/<id>` (with `x-order-token`); it
   sees `paid` and unlocks the draw.
6. When the cards are down, the page POSTs the reading to `/api/reading`, which
   spends one credit and stores it. The Reading Bundle is simply an order with
   three credits, and it unlocks the Extended Reading.

## Gift Readings

A gift is the one SKU with something to deliver, so it has an extra leg:

1. Checkout requires a valid recipient email (checked in the form and again in
   `/api/checkout`, which answers 400 `invalid_recipient_email`), plus the
   sender's name and an optional note, and stores them on the order.
2. When the webhook sees a gift order paid, it ALWAYS mints the single-use
   claim token (`gift_claims`), with or without a recipient email. Minting is
   idempotent; if it fails the webhook answers 500 so Stripe retries. The call
   that creates the token emails the recipient a link to `/claim/<token>` (when
   there is an address) and sends the buyer a gift receipt carrying the same
   link ("Share this link with the person you're gifting").
   The buyer is also always shown the link on the gift confirmation view:
   `/api/order/<id>` returns `claimUrl` for a paid gift once the webhook has
   minted it. That route is read-only and never mints; the webhook is the only
   minter. Gift emails are delivered **at least once until recorded, then
   never again** (migration `0005_gift_claim_email_flags.sql`, apply before
   deploy):
   - A delivery takes a short send lease (`*_email_lease_until`, 120 s).
     `*_emailed_at` is set only after Resend accepted the email.
   - A transient failure releases the lease, counts an attempt
     (`*_email_attempts`) and the webhook answers 500, so Stripe retries.
     Transient means: network error, timeout, 5xx, 429, 408, 401/403 (a wrong
     or restricted `RESEND_API_KEY` or an unverified sender domain), and every
     409 except `invalid_idempotent_request` (`concurrent_idempotent_requests`,
     `resource_locked`, unknown or unparseable). The cap below bounds all of
     them, so a misclassification costs a few retries, never a loop.
   - Only the lease holder can release a lease: `reserveGiftEmail` returns the
     exact `*_email_lease_until` it wrote as a fencing token, and every release
     matches on it. A delivery that stalled past its lease and was overtaken
     cannot clear the new holder's lease or count an attempt.
   - Retries are bounded: after `GIFT_EMAIL_MAX_ATTEMPTS` failed sends
     (default 5) or once the order has been paid for longer than
     `GIFT_EMAIL_GIVE_UP_HOURS` (default 6), `*_email_failed_at` is set, the
     failure is logged ("gift email retries exhausted"), and the webhook answers
     200. A long Resend outage therefore never gets the Stripe endpoint
     disabled. The buyer still sees the claim link on the confirmation view.
     Support can list stuck emails with `select order_id from gift_claims where
     recipient_email_failed_at is not null or buyer_email_failed_at is not null`.
   - **Recovering emails that gave up** (e.g. after fixing a wrong
     `RESEND_API_KEY`, an unverified domain, or after an outage). This is a
     production write, so get the owner's OK first:
     1. Fix the configuration (env vars, then redeploy) and confirm with one
        test gift in preview or a single real order.
     2. List the affected orders (query above) and reset only those rows,
        leaving anything already sent alone:
        ```sql
        update gift_claims
           set recipient_email_failed_at = null, recipient_email_attempts = 0,
               recipient_email_lease_until = null
         where order_id = any($1) and recipient_emailed_at is null;
        update gift_claims
           set buyer_email_failed_at = null, buyer_email_attempts = 0,
               buyer_email_lease_until = null
         where order_id = any($1) and buyer_emailed_at is null;
        ```
     3. Re-run delivery by resending each order's `checkout.session.completed`
        event from Stripe (Dashboard → Developers → Events → Resend, events up
        to 15 days old; `stripe events resend <evt_id>` up to 30 days). The
        webhook sees the order as already paid and only sends the missing
        emails. Each resend counts against the age cap from `paid_at`, so
        raise `GIFT_EMAIL_GIVE_UP_HOURS` (max 72) for the re-run if the orders
        are older than the cap. Otherwise the first failure gives up again
        (a successful send is unaffected).
     4. Check `*_emailed_at` is now set for those rows. Orders past Stripe's
        resend window need a hand-sent email with the claim link from the
        buyer's confirmation view (see the make-whole plan).
   - Each Resend call has a 12 s timeout (AbortController); a timeout counts as
     a transient failure.
   - A crash mid-send leaves only the lease. It expires and a later retry sends.
     While a lease is held, other deliveries answer 500 rather than send twice.
   - Every send carries a Resend `Idempotency-Key` (`gift-<kind>-<orderId>`), so
     the narrow "accepted but not yet recorded" crash is de-duplicated by Resend.
   - A permanent 4xx (e.g. an invalid address), including Resend's 409
     `invalid_idempotent_request` (key reused with a different body), is logged,
     recorded in `*_email_failed_at`, and not retried. The request body is
     built deterministically from the order, so a retry under the same key is
     byte-identical and should never hit that 409.
   - If `RESEND_API_KEY` / `GIFT_FROM_EMAIL` are unset, emails are skipped with a
     2xx, because a retry can't fix configuration. The buyer still sees the link.
   - **Accepted risk (N4):** Resend keeps an `Idempotency-Key` for 24 h. If a
     send was accepted but the process died before `*_emailed_at` was written,
     and the next attempt comes more than 24 h later, the email can go out
     twice. With the 6 h give-up default that only happens if
     `GIFT_EMAIL_GIVE_UP_HOURS` is raised past 24 or support re-sends by hand;
     a duplicate gift email is harmless (same link).
   - **Accepted risk (N5):** if `RESEND_API_KEY` / `GIFT_FROM_EMAIL` are unset,
     no gift email is sent and nothing is recorded for a later re-send.
     `go-live.sh` refuses to deploy without them, and the buyer still sees the
     link to forward by hand.
   - Without 0005 the webhook answers 500 for paid gifts after minting (Stripe
     retries), and `GET /api/health/payments` lists the missing 0005 columns. Gifts with no recipient email are logged
   (order id only, never the token) for support.
3. The recipient opens the link, turns one card, and that POST burns the token,
   spends the credit, and stores the reading.
4. Re-opening the link shows the same card again rather than drawing a new one,
   so it keeps working as a keepsake.

The token is the recipient's only credential - no account, no sign-in. It is
128 bits, derived as HMAC-SHA256(`GIFT_TOKEN_SECRET`, falling back to
`BETTER_AUTH_SECRET`, over the order id), so it is not guessable from the order
id. The database stores only its SHA-256 hash; the server re-derives the link
to show the buyer. Legacy rows that still hold a plaintext token keep working
(lookups try the hash first, then the plaintext). With no secret at all the
mint FAILS CLOSED: the webhook answers 500 and Stripe retries, so no fresh
plaintext token is ever stored.
`scripts/backfills/2026-11-gift-claim-token-hashing.sql` optionally hashes the
legacy rows (run by hand, only after the hashed-token code is stable).

**`BETTER_AUTH_SECRET` fallback: risk.** Set a dedicated `GIFT_TOKEN_SECRET`.
When it is unset, gift links are derived from `BETTER_AUTH_SECRET`, which
couples gifts to sign-in:
- **Rotating the auth secret** (routine, or after a sign-in incident) does
  *not* break links that were already sent: the database stores the hash of
  the link actually issued. What it does break, for every unclaimed gift
  minted before the rotation:
  - the buyer's confirmation view can no longer re-show the link (`claimUrl`
    is omitted);
  - a webhook retry can no longer re-send the emails (logged as "not
    re-derivable"; support must resend by hand).

  Rotating `GIFT_TOKEN_SECRET` has the same effect, so set it once, before
  the first hashed gift is minted, and don't rotate it casually.
- **A leaked auth secret** would let anyone derive the claim link of any gift
  whose order id they know. Order ids appear in Stripe redirect URLs and the
  buyer's browser storage. A dedicated secret limits that blast radius to
  gifts.
- Switching from the fallback to a new `GIFT_TOKEN_SECRET` later is itself a
  rotation (see above). The cheapest moment is before go-live.

**Legacy plaintext links: plan and window.** Rows minted before this change
store the 32-hex token in plain text.
- **Window:** from deploying this code until the hashing backfill runs, those
  links work via the plaintext fallback in `findClaim`, and anyone with read
  access to `gift_claims` can use them. That includes DB backups and Neon
  preview branches copied from production.
- **Plan:**
  1. Deploy this code. Every new gift is stored hashed.
  2. Wait until a rollback is off the table (suggest 7 days): older code can't
     read hashed rows.
  3. If #32's mint backfill (`2026-11-gift-claim-tokens.sql`) is needed, run
     it first, because it writes plaintext.
  4. Run `2026-11-gift-claim-token-hashing.sql` (dry-run counts first). Legacy
     links **keep working** afterwards, because lookup hashes the token in the
     link. Only the buyer view stops re-showing older unclaimed links.
  5. Confirm `select count(*) from gift_claims where token ~ '^[0-9a-f]{32}$'`
     is 0, then remove the plaintext fallback (`or c.token = ${token}`) in a
     follow-up PR, which closes the window for good.
- **Optional:** `GIFT_TOKEN_TTL_DAYS` also expires old unclaimed legacy
  links.
- Steps 3–5 need Michael's OK. Nothing is run automatically.

Expiry is OFF by default. `GIFT_TOKEN_TTL_DAYS` (a positive number of days)
turns it on: an UNCLAIMED link then expires that many days after purchase and
shows "This gift link has expired" with a contact-support prompt
(`GIFT_SUPPORT_EMAIL`, optional, adds a mailto button). Claimed gifts never
expire. Expired or problem gifts are handled by support manually (reissue or
refund); there is no automated refund.

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
| `GIFT_EMAIL_MAX_ATTEMPTS` | Optional. Failed gift-email sends before giving up (integer 1-100, default 5). |
| `GIFT_EMAIL_GIVE_UP_HOURS` | Optional. Stop retrying gift emails this many hours after payment (0-72, default 6). |
| `PUBLIC_SITE_URL` | Optional. The origin used to build claim links; falls back to the request's own origin. |
| `GIFT_TOKEN_SECRET` | Strongly recommended (dedicated, >= 32 chars). Secret for deriving gift claim tokens; falls back to `BETTER_AUTH_SECRET` (see the fallback risk above). Rotating either one does not break links already sent, but the buyer view and webhook retries can no longer re-show or re-send unclaimed ones. |
| `GIFT_TOKEN_TTL_DAYS` | Optional. Unset = gift links never expire (current policy). A positive number = unclaimed links expire that many days after purchase. |
| `GIFT_SUPPORT_EMAIL` | Optional. Shown as a contact button on the expired-gift page. |

`go-live.sh` now fails fast if `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, or
`GIFT_FROM_EMAIL` is missing, and injects those values into the deployment with
`-e` so production deploys cannot silently omit payment/email secrets.

Without `STRIPE_WEBHOOK_SECRET` the webhook refuses every request, which means
no order ever becomes paid. That is the intended failure direction: a
misconfigured site sells nothing rather than giving everything away.

Without `RESEND_API_KEY` and `GIFT_FROM_EMAIL`, gift orders still complete and
are still claimable - the emails just never go out, the failure is logged, and
the buyer can still copy the link from the confirmation view.
Set both before selling gifts.

Paid gift orders created before every paid gift got a token are backfilled
with `scripts/backfills/2026-11-gift-claim-tokens.sql` (idempotent, run by
hand). It mints the legacy plaintext token format, so run it BEFORE the
hashed-token change and its hashing backfill, never after (see that script).

Claim URLs are bearer credentials: `/claim/*` and `/api/claim/*` responses get
`Referrer-Policy: no-referrer` (set in vercel-entry.ts / serve.ts, plus a meta
tag on the page), the analytics loader never runs on a claim path, and no log
line includes a token. Claiming is one atomic SQL statement (burn + credit +
reading).

The buyer's `claimUrl` is only returned by `/api/order/<id>` past the
per-order `x-order-token` check, so the order id alone does not reveal it.
A purchase made straight from a Stripe Payment Link (no `client_reference_id`)
has no order or recipient; it is recorded in `orphan_payments` for support.

**A webhook endpoint in Stripe**

- URL: `https://<your site>/api/stripe-webhook`
- Events (all three are required):
  - `checkout.session.completed`
  - `checkout.session.async_payment_succeeded` (fulfilled exactly like `completed` once paid)
  - `checkout.session.async_payment_failed` (moves the pending order to `failed`;
    never grants credits or creates a gift link; idempotent; the order update
    and the event record are one atomic statement, so a crash can't leave the
    event "seen" with the order still pending; 2xx unless the DB errors)

**Payment links (per environment)**

The four one-time SKUs open Stripe Payment Links chosen on the server by
`src/lib/payment-links.ts`:

| Variable | SKU | Price |
| --- | --- | --- |
| `STRIPE_PAYMENT_LINK_SINGLE_INSIGHT` | `singleInsight` | 2.99 USD |
| `STRIPE_PAYMENT_LINK_EXTENDED_READING` | `extendedReading` | 9.99 USD |
| `STRIPE_PAYMENT_LINK_READING_BUNDLE` | `readingBundle` | 19.99 USD |
| `STRIPE_PAYMENT_LINK_GIFT_READING` | `giftReading` | 5.00 USD |

- **Production** (`VERCEL_ENV=production` only; `PAYMENT_LINKS_MODE=live`
  anywhere else is refused with a 503, and `go-live.sh`'s non-`--prod` deploy
  counts as a preview): the env var if set (must be a
  live-mode `https://buy.stripe.com/…` link), otherwise the existing live link
  baked into `LIVE_PAYMENT_LINK_DEFAULTS`.
- **Preview, development, local**: the env var is required and must be a
  TEST-mode link (`https://buy.stripe.com/test_…`). Unset or live-mode makes
  `/api/checkout` answer 503 `checkout_unavailable` (and log which variable is
  wrong) before any order is written. It never falls back to a live link.

Tips are client-side links. Production builds use the live tip links; other
builds read `VITE_STRIPE_TIP_LINK_3`, `VITE_STRIPE_TIP_LINK_5` and
`VITE_STRIPE_TIP_LINK_10` (build-time, test-mode only) and hide the tip rail
if any is missing. The build learns its environment from `VERCEL_ENV` via
`vite.config.ts`.

Appending
`?client_reference_id=<uuid>` works on them out of the box - no dashboard change
needed. Just do not edit a link's price in the dashboard without updating
`SKUS`, because the webhook compares the two and refuses to fulfil on a
mismatch.

**Paid but unfulfillable sessions (orphan payments)**

A Payment Link is a public URL, so someone can pay without going through
`/api/checkout` (no `client_reference_id`). For a Gift Reading that means no
order, no recipient email and no claim link. The webhook never drops these: a
**paid** session with no order reference, an unknown order id, or an
amount/currency mismatch is written to `orphan_payments` (idempotent on the
Stripe session id; reason, payment link, amount, currency, buyer email) and
logged as `ORPHAN_PAYMENT`. If that write fails the webhook answers 500 so
Stripe retries. Per product policy these go to support for a manual reissue or
refund; nothing is refunded automatically. Support query:
`select * from orphan_payments where resolved_at is null order by created_at desc;`

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
answer 404, and `/api/reading` with that id must answer 402. The same must hold
for a real order id sent without its `x-order-token` (orders created before
access tokens existed have no stored hash and are still readable by id until
`LEGACY_ORDER_ACCESS_UNTIL`, an ISO date/time; unset = open, past or invalid =
closed). `/claim/<junk>`
must show the expired-link page.

### Unit tests

`bun run test` covers the fulfilment decisions without Stripe or Postgres. See the table in `README.md`. The cases that matter here:

- `markPaid` is idempotent on `stripe_events`. A second delivery of the same event id does not overwrite the stored payment intent.
- A charged amount that disagrees with `SKUS[sku].amountCents` returns `amount-mismatch` and leaves the order `pending`.
- `verifyStripeSignature` rejects timestamps more than 300 seconds from `now`, and accepts any `v1` candidate that matches during secret rotation.

These tests mock `~/db`. They do not boot the dev server or hit `/api/stripe-webhook`.

## Database

The one-time payments schema comes **only** from
`migrations/0004_payments_schema.sql` (no request runs DDL any more):

- `orders` - one row per checkout attempt, with status (`pending`, `paid`,
  `failed`) and remaining credits; `access_token_hash` is the SHA-256 of the
  per-order access token
- `readings` - every stored reading, keyed to its order (this is the journal)
- `stripe_events` - applied webhook event ids, so a Stripe retry is a no-op
- `gift_claims` - single-use claim tokens for Gift Readings
- `orphan_payments` - paid Stripe sessions the webhook could not fulfil (see above)

Apply it (with the unpooled URL) **before** deploying code that needs it. On
Vercel, merging to `main` deploys production, so for production that means
before merging. It is idempotent and safe to run while older code is live.

Without it the code fails closed: checkout, order, reading and claim answer
503 (`schema_not_migrated` where detectable), the webhook answers 5xx so Stripe
retries, and `GET /api/health/payments` returns 503 listing what is missing
(200 `{ ok: true }` when ready; read-only, no DDL). It is public, so it is
rate-limited by caching: a 200 is cached per instance for 60 s, a 503 for 5 s,
concurrent requests share one query, and errors are not cached.

## Divine Insight Pro

Pro is a separate $5/month subscription **scaffold**. It is not a key in
`SKUS`, and `/api/stripe-webhook` does not grant it. The one-time ladder above
is unchanged.

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
from `src/routes/__root.tsx`. Status is resolved by
`resolvePremiumStatus` (`src/lib/pro/resolve-status.ts`):

1. **DEV builds only:** an explicit `localStorage["di.subscription.isPremium"]`
   of `"true"` / `"false"` (set by `PremiumDevToggle`, bottom-right
   **Pro: On / Off**) wins. Production builds never read it.
2. **`VITE_PRO_UI_ENABLED` off (default):** `isPremium` is false and
   `GET /api/pro/status` is never called. This is how production keeps Pro
   hidden. Only the exact string `"true"` turns it on; Vite inlines it at
   build time, so changing it needs a rebuild.
3. **Flag on:** the provider calls `GET /api/pro/status` (same-origin, with the
   session cookie). `isPremium` is true only for a 200 with `pro: true`.
   Signed out (401), errors and malformed bodies are all false.

During SSR `isPremium` is false and `loading` is true, so gated markup is never
server-rendered.

### Server-side enforcement

The UI flag is presentation only. Access is enforced on the server:

- `GET /api/pro/status` returns `{ signedIn, pro }` from `hasPro(user.id)`:
  401 signed out, 200 signed in, 503 if the lookup fails (fails closed).
- `requirePro(request)` / `withPro(handler)` in `src/lib/auth/require-pro.ts`
  is the guard every Pro-only API route must use: 401 `sign_in_required`
  when signed out, 403 `pro_required` when not Pro, 503
  `session_unavailable` if the session lookup throws (DB/auth outage), and 503
  `entitlement_unavailable` if the entitlement lookup throws.
  `userFromRequest` throws on lookup errors rather than returning null, so an
  outage is never reported as "sign in".
- `src/lib/pro/__tests__/pro-route-inventory.test.ts` classifies every API
  route, including what it imports directly from `~/lib`, and every
  `createServerFn` module. Each one is Pro-gated, Pro-aware (reads `hasPro` but
  isn't gated: checkout and status), or never gated (paid one-time readings,
  gifts, webhooks, auth, portal, the Gemini proxy). Any unclassified entry
  point, or a `requirePro`/`withPro`/`hasPro` reference that doesn't match its
  classification, fails CI.

There are no Pro-only server operations yet: Celtic Cross and vector scoring
are not built, the Journal is client-only sample entries, and the three-card
spread is drawn client-side with no endpoint. `PRO_GATED_ROUTES` is empty
until one of those gets a server endpoint.

### Checkout scaffold

`src/lib/stripe-checkout.ts` still exports `redirectToProCheckout`, which loads
Stripe.js with the placeholder key `pk_test_placeholder_divine_insight_pro`,
logs `price_placeholder_divine_insight_pro_monthly`, and alerts instead of
creating a Checkout Session. Nothing in the UI calls it. Do not create
Sessions with the publishable key alone.

A real Pro subscription needs its own server check. The existing webhook only
fulfils rows in `SKUS`.

### Trying the gate locally

```sh
bun run dev
```

Use **Pro: On** in the corner to preview the three-card section and Journal.
The choice persists in this browser under `di.subscription.isPremium` for dev
builds only. A production build has no toggle and no upgrade button.

To exercise the real entitlement path locally, clear that key and run with
`VITE_PRO_UI_ENABLED=true bun run dev` while signed in.

## Still to do

- Readings are composed client-side and posted back, so the server decides
  *access* while the client decides *when a credit is spent*. Worst case a
  visitor under-spends their own credits. Closing it means generating readings
  server-side, which is a much larger refactor.
- The Journal tab is a Pro-gated preview of sample entries. Stored readings
  are still only `GET /api/order/<id>?include=readings`.
- Tips stay honor-based on purpose. A tip unlocks nothing, so there is nothing
  to verify.
- Pro is hidden in production and is not sold. The dev toggle is the only way
  to preview it. It does not write `orders`.

## Pro subscription (P3)

Server-created Stripe Checkout (subscription mode) via `POST /api/pro/checkout`
and Customer Portal via `POST /api/pro/portal` (both require a signed-in user).
Entitlements are written only by `POST /api/stripe-subscription-webhook`
(own signing secret, `STRIPE_PRO_WEBHOOK_SECRET`), which handles
`checkout.session.completed` (mode=subscription), `customer.subscription.created|updated|deleted`,
`invoice.paid` and `invoice.payment_failed`, dedupes by event id, and re-fetches the
subscription from Stripe. Apply `migrations/0002_pro_subscriptions.sql` first.
One-time orders and `/api/stripe-webhook` are unchanged.

### Double-subscription protection

- `POST /api/pro/checkout` returns **409** `{ error: "already_subscribed", manage: "/api/pro/portal" }`
  when the user already has Pro (`hasPro`: active / trialing / past_due within
  the period), so no second Checkout Session is created.
- `syncSubscription` only lets an event for a subscription that is *not* the one
  stored on the entitlement row overwrite it if that event grants access, or
  the stored one has already lapsed. Otherwise it returns `"superseded"` and
  leaves the row alone.
- When a subscription stops granting access, the webhook first asks Stripe
  (`GET /v1/subscriptions?customer=…&status=all`) for another active Pro
  subscription on the same customer and syncs that one instead of revoking.
  If that lookup fails, the revoke still proceeds (the DB guard above still applies).
- **One Stripe Customer per user, created before the first Checkout.**
  `ensureStripeCustomer` creates the customer server-side (`POST /v1/customers`
  with a per-user `Idempotency-Key`) and stores it on the entitlement row with
  status `incomplete`, which does not grant Pro. Every Checkout passes
  `customer=`. Concurrent tabs therefore share one customer, so the webhook's
  "other active subscription for this customer" check and the Customer Portal
  both see every subscription.
- Remaining edge: two Checkout tabs opened *before* either completes can still
  both be paid. Pro stays correct, and the customer can cancel the extra one in
  the Portal, because both subscriptions sit on the same customer.
