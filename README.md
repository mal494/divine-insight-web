# Divine Insight — Web

The **Web** branch of the Divine Insight platform: a browser tarot-reading site
built with [TanStack Start](https://tanstack.com/start) (React 19 + Vite 7 +
Tailwind 4), served on **port 3000**.

Card data comes from [Divine Insight Core](https://github.com/mal494/divine-insight-core)
— this repo never edits card copy directly. See `CORE.md` for the pinned-version
rules.

Paid one-time readings and Divine Insight Pro are different systems. One-time
orders are fulfilled only by `/api/stripe-webhook`. Pro sign-in, Checkout, and
the `entitlements` row are server-side; the pages still gate Pro with a
dev-only flag and do not read that row. See `PAYMENTS.md` before changing a
gate, a price, or a Stripe call.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.1 (`bun --version`)
- Node is optional — Bun ships its own runtime; `node` only matters if you use
  `node scripts/generate-deck.mjs` explicitly (Bun can run it too:
  `bun scripts/generate-deck.mjs`).

## Quick start

```bash
cd divine-insight-web
bun install          # installs deps (also done automatically by publish.sh)
bun run dev          # dev server on http://localhost:3000
```

## Common commands

| Task | Command |
|------|---------|
| Dev server (HMR) | `bun run dev` → http://localhost:3000 |
| Production build | `bun run build` → emits `dist/client` + `dist/server` |
| Serve the built site | `bun run start` (requires `bun run build` first) |
| Build + serve (deploy) | `bun run publish` → `publish.sh` |
| Deploy to Vercel | `bun run go-live` → `go-live.sh` (needs `VERCEL_TOKEN`) |
| Format | `bun run format` (Prettier, `--write .`) |
| Type-check | `bun run typecheck` |
| Unit tests | `bun run test` (Vitest, once) |
| Watch tests | `bun run test:watch` |

## Checks

`bun run typecheck` runs `tsr generate` and then `tsc --noEmit -p tsconfig.typecheck.json`. That project includes `src/**/*.ts` and `src/**/*.tsx` except `src/routes/api/**/*.ts`, so a green type-check does not cover the API route files. `bunx tsc --noEmit` is not the CI command: it skips route-tree generation and uses the default project.

`bun run test` runs Vitest once. There is no `vitest.config`, so Vitest's default include applies: every `*.test.ts` under the repo, including `src/lib/__tests__/`, `src/lib/auth/__tests__/`, and `src/lib/billing/__tests__/`.

| File | What it locks |
| --- | --- |
| `entitlement.test.ts` | `resolveEntitlementFromOrders`: a paid order with credits wins over a spent paid order (`unlocked`); only spent paid orders are `spent`; a pending order is `awaiting-payment`; any other status is `locked` |
| `orders.test.ts` | `markPaid` compares the charged amount and currency with the order row captured at checkout, not with the live `SKUS` table. A repeated event id is `duplicate`. An order id this server never created is `unknown-order`. A new event for an order that is already paid is `already-paid` |
| `stripe-signature.test.ts` | `verifyStripeSignature`: a valid `v1` signature, any matching `v1` candidate while a secret is rotating, a timestamp more than 300 seconds off (`timestamp`), a bad signature (`mismatch`), and a header with no `t=` (`malformed`) |
| `stripe-webhook-route.test.ts` | The one-time webhook accepts `checkout.session.completed` and `checkout.session.async_payment_succeeded` only when `payment_status` is `paid` and both amount and currency are present |
| `gemini-proxy-route.test.ts`, `gemini-proxy-security.test.ts` | App-token auth, production fail-closed when Redis is missing, the in-memory limiter outside production, and `UPSTASH_REDIS_REST_*` preferred over `KV_REST_API_*` |
| `auth-config.test.ts`, `confirm.test.ts`, `has-pro.test.ts` | Magic-link options (15-minute hashed tokens), confirm POST (GET does not verify the token), and which entitlement statuses count as Pro |
| `pro-billing.test.ts`, `subscription-webhook.test.ts` | Checkout session shape, a non-Pro price left unsynced, portal with no customer, webhook signature, duplicate events, and releasing the event claim when processing throws |

`.github/workflows/ci.yml` runs on pull requests and on pushes to `main`. The job uses Node 22, `npm ci` (so `package-lock.json` is the CI lockfile; `bun.lock` is not), then `npm run typecheck`, `npm run test`, and `npm run build`. The `ci` script in `package.json` calls `npm run` for those three steps, so it needs npm on `PATH` even when you start it with Bun.

> **Note:** `publish.sh` / `go-live.sh` / `serve.ts` assume a Linux-style sandbox
> (`bash`, `setsid`, `lsof`, `sudo`, `curl`). On a plain Windows shell use
> `bun run dev` / `bun run build` instead — the sandbox-only takeover logic in
> `serve.ts` won't run outside that environment.

## Vercel

`vercel.json` sets the project build command to `bash ./build-vercel.sh`.
`bun run go-live` runs that script, then `vercel deploy --prebuilt`.

`build-vercel.sh` does three things:

1. `bun install` and `bun run build` (Vite emits `dist/client` and `dist/server`).
2. Copies `dist/client` to `.vercel/output/static` and deletes `index.html`
   there, so `/` is rendered by SSR rather than a static shell.
3. Bundles `vercel-entry.ts` into
   `.vercel/output/functions/render.func/index.mjs` (Node.js 22.x). Every other
   path falls through to that function (`config.json` route `/(.*) → /render`).

TanStack Start's server entry dynamic-imports its own chunks. The script
inlines those into one file so Vercel does not have to trace them.

## Environment variables

None are required to build or run the dev server. These matter at deploy time:

| Variable | Required by | Purpose |
|----------|-------------|---------|
| `VERCEL_TOKEN` | `bun run go-live` | Vercel deploy token (collected from the owner) |
| `DATABASE_URL` | runtime queries via `src/db.ts` | Neon Postgres connection string — resolved lazily, so the site builds & serves without it; only actual queries throw |
| `STRIPE_WEBHOOK_SECRET` | `/api/stripe-webhook` | Stripe signing secret (`whsec_...`). Required for paid orders to flip to `paid` |
| `RESEND_API_KEY` + `GIFT_FROM_EMAIL` | gift emails via `src/lib/gift-email.ts` | Required to send Gift Reading claim emails |
| `PUBLIC_SITE_URL` | gift claim-link builder | Optional origin override for `/claim/<token>` links in email |
| `SITE_URL` | optional, og:url/og:image/canonical tags | The real production origin. Falls back to `VERCEL_PROJECT_PRODUCTION_URL` on Vercel, then to a relative path. **Never hardcode a sandbox domain here** |
| `GEMINI_API_KEY` | `/api/gemini/v1beta/models/{model}:{operation}` | Server-only Gemini API key used by the proxy |
| `GEMINI_PROXY_APP_TOKEN` | Gemini proxy auth gate | Shared app token expected in the `x-divine-app-token` request header |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (preferred), or `KV_REST_API_URL` + `KV_REST_API_TOKEN` (Vercel Upstash integration defaults) | Gemini proxy durable limiter | Shared Redis limiter backend for Vercel/serverless instances |
| `GEMINI_ALLOWED_OPERATIONS` | Gemini proxy allow-list | Comma-separated operation allow-list (`generateContent` by default) |
| `GEMINI_ALLOWED_MODELS` | Gemini proxy allow-list | Optional comma-separated model allow-list (empty = any model) |
| `GEMINI_PROXY_MAX_REQUEST_BYTES` | Gemini proxy payload guard | Max JSON payload bytes (default `65536`) |
| `GEMINI_PROXY_RATE_LIMIT_MAX` | Gemini proxy limiter | Max requests per window (default `20`) |
| `GEMINI_PROXY_RATE_LIMIT_WINDOW_MS` | Gemini proxy limiter | Window size in ms (default `60000`) |
| `GEMINI_PROXY_RATE_LIMIT_PREFIX` | Gemini proxy limiter | Optional Redis key namespace (`gemini-proxy:v1` default) |
| `STRIPE_SECRET_KEY` | `POST /api/pro/checkout`, `POST /api/pro/portal` | Server-only Stripe secret. A missing key surfaces as 503 `checkout_unavailable` or `portal_unavailable` |
| `STRIPE_PRO_PRICE_ID` | Pro Checkout | Recurring price id. `syncSubscription` leaves any other price unsynced (`wrong-price`) |
| `STRIPE_PRO_WEBHOOK_SECRET` | `/api/stripe-subscription-webhook` | Separate from `STRIPE_WEBHOOK_SECRET`. Missing secret: HTTP 500 and no entitlement write |
| `BETTER_AUTH_SECRET` | magic-link sessions | Signing secret (`.env.example` asks for at least 32 characters). Session lookup returns null when this or `DATABASE_URL` is unset |
| `BETTER_AUTH_URL` | auth and Pro return URLs | Optional canonical origin. Checkout success, cancel, and the portal return URL use it when set, otherwise the request origin |
| `VERCEL_SCOPE` / `VERCEL_TEAM_ID` / `VERCEL_PROJECT_NAME` | optional | Overrides for `go-live.sh` team/project resolution |

`go-live.sh` fails fast when `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, or
`GIFT_FROM_EMAIL` is missing, and passes them to Vercel with `-e` so a deploy
cannot silently go out without payment/gift-email configuration. `DATABASE_URL`
is forwarded the same way when it is set, and `PUBLIC_SITE_URL` when it is set.
A local `.env` is not read by the deploy; export the variables in the shell
that runs `bun run go-live`.

That script does not forward `STRIPE_SECRET_KEY`, `STRIPE_PRO_PRICE_ID`,
`STRIPE_PRO_WEBHOOK_SECRET`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, or the
Gemini variables. Set those in the Vercel project. A go-live deploy will not
add them, and Pro Checkout or sign-in will fail closed at runtime without them.

Create a local `.env` (gitignored) if you need any of these during development:

```bash
cp .env.example .env   # if present; otherwise create .env manually
```

## Accounts (magic link sign-in)

Better Auth, email magic links only (`emailAndPassword` is disabled). Users,
sessions, hashed verification tokens, and the database rate limiter live in
Neon (`pg` Pool on the pooled `DATABASE_URL`). Apply both SQL files before
deploy, against each Neon branch, using the unpooled URL. Neither file runs
on first query:

```sh
psql "$DATABASE_URL_UNPOOLED" -f migrations/0001_pro_auth.sql
psql "$DATABASE_URL_UNPOOLED" -f migrations/0002_pro_subscriptions.sql
```

`0001` creates `"user"`, `"session"`, `"account"` (the table exists; no
password is stored), `"verification"`, `"rateLimit"`, and `entitlements`.
`0002` adds the Stripe columns on `entitlements` and the
`stripe_subscription_events` table. One-time `orders` still bootstrap
themselves; see `PAYMENTS.md`.

Sign-in page: `/signin`. The email links to `/auth/confirm`, a page with one
button that POSTs `/api/auth-confirm`, so a scanner prefetch cannot burn the
token. Emails use `RESEND_API_KEY` and `GIFT_FROM_EMAIL` and throw when either
is missing, so the form reports the failure. Gift emails log and continue;
sign-in emails do not. Sessions last 30 days and refresh when older than a
day.

`AuthIndicator` on the home page calls `getSessionUser`. When `DATABASE_URL`
or `BETTER_AUTH_SECRET` is unset, that function returns null and the header
stays "Sign in". `POST /api/pro/checkout` then answers 401 `sign_in_required`
for the same reason.

`hasPro(userId)` in `src/lib/auth/entitlements.ts` is true only for
`plan = 'pro'` with status `active`, `trialing`, or `past_due`, and
`current_period_end` null or still in the future. The subscription webhook is
what upserts that row. No route calls `hasPro`, and `SubscriptionContext` does
not read it, so a production page still treats every visitor as free.

Node 22 is pinned (`engines`, `.nvmrc`).

## Gemini proxy contract (Android)

Endpoint:

- `POST /api/gemini/v1beta/models/{model}:{operation}`
- Currently allowed operation defaults to `generateContent`

Required request headers:

- `content-type: application/json`
- `x-divine-app-token: <GEMINI_PROXY_APP_TOKEN>`

Behavior:

- Proxy forwards the JSON body to Gemini using server-side `GEMINI_API_KEY`
- Requests are rate limited per `token + client IP`
- In production, a durable Redis limiter is required (`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`, or Vercel Upstash integration defaults `KV_REST_API_URL` + `KV_REST_API_TOKEN`); the endpoint fails closed when missing
- In local dev/test (`NODE_ENV != production`), it safely falls back to an in-memory limiter

Error contract:

- `401 {"error":"unauthorized"}`: missing or wrong `x-divine-app-token`
- `429 {"error":"rate_limited","retryAfterSeconds":<n>}` (+ `retry-after` header): over limit
- `503 {"error":"gemini_proxy_not_configured"}`: missing `GEMINI_API_KEY`
- `503 {"error":"gemini_proxy_auth_not_configured"}`: missing `GEMINI_PROXY_APP_TOKEN`
- `503 {"error":"gemini_proxy_rate_limit_not_configured"}`: production limiter backend missing/unavailable
- `403 {"error":"operation_not_allowed"}` / `{"error":"model_not_allowed"}`: blocked by allow-list
- `415 {"error":"unsupported_media_type"}`: non-JSON body
- `413 {"error":"payload_too_large"}`: payload exceeds configured max size
- `400 {"error":"invalid_model_or_operation"}` / `{"error":"invalid_json"}`: invalid route/body input

### Security tradeoffs and upgrade path

`x-divine-app-token` is the most practical immediate control for Android integration and server-side fail-closed behavior, but a shared secret embedded in an app can be extracted by a determined attacker. That is why the proxy also enforces shared, durable rate limits and strict operation/model allow-lists.

Planned hardening path: add an attestation layer (Play Integrity) and/or per-request signatures (device or app-instance key) so possession of a static token alone is insufficient.

## Project layout

```
src/
  routes/
    __root.tsx     # HTML shell: <head>, fonts, canonical/og tags, SubscriptionProvider
    index.tsx      # the landing page ("/")
    api/           # checkout, webhooks, order, reading, gemini, auth, pro
  components/      # card-face, reading-panel, pricing, PremiumGate, Journal, …
  context/
    SubscriptionContext.tsx  # Pro flag; production always off, dev localStorage only
  data/
    deck.generated.ts   # GENERATED — do not hand-edit (see CORE.md)
    deck.ts             # deck accessors
    artwork.ts          # which card ids have real artwork (all 78)
  lib/             # analytics, payments, orders, stripe-checkout, random, synthesis
  styles/app.css   # Tailwind entrypoint + base styles
  db.ts            # Neon serverless Postgres helper (server-only)
scripts/
  generate-deck.mjs     # rebuilds src/data/deck.generated.ts from Core
  deck-presentation.json# hand-maintained glyphs + numerology notes
public/
  cards/           # 78 card artworks (.webp)
  hero/            # hero image used for og:image
site.json          # { "businessName": "…" } — read at request time
vite.config.ts     # dev server on 0.0.0.0:3000
```

## Adding a page

Create a new file under `src/routes/` — e.g. `about.tsx` becomes `/about`.
Files are routes; the router tree (`src/routeTree.gen.ts`) is generated
automatically (it's gitignored).

## Regenerating the deck

The dataset is fetched from Core at the tag in `core.version`:

```bash
bun scripts/generate-deck.mjs
```

It fails loudly on a wrong card count, duplicate id, or a card missing meaning,
keywords, glyph or numerology note. Never hand-edit
`src/data/deck.generated.ts` — see `CORE.md` for the full rules.

## Styling / formatting

Prettier is wired up (`bun run format`). The repo currently uses LF line
endings; Windows checkouts with `core.autocrlf=true` may show a large
format-only diff after `bun run format` — that's expected, review with
`git diff --ignore-cr-at-eol`.
