-- One-time payments schema (PR #35). NOT applied automatically.
-- Apply to the target database BEFORE the code that needs it is deployed.
-- On Vercel, merging to main deploys production, so for production this means
-- BEFORE merging #35 (needs Michael's OK):
--   psql "$DATABASE_URL_UNPOOLED" -f migrations/0004_payments_schema.sql
-- Independent of 0001-0003. Idempotent (`if not exists` everywhere), additive,
-- and safe to run while the current code is live.
--
-- Until #35 these tables were created by the app on request (ensureSchema /
-- ensureGiftSchema). #35 removes all runtime DDL; this file is now the only
-- source of the schema. On a database the old code already bootstrapped it
-- only adds orders.access_token_hash and orphan_payments.
--
-- Without it the code fails closed: checkout/order/reading/claim answer 503,
-- the Stripe webhook answers 5xx (Stripe retries), and GET /api/health/payments
-- reports what is missing.
--
-- Rollback (only after reverting the code):
--   alter table orders drop column if exists access_token_hash;
--   drop table if exists orphan_payments;  -- pg_dump -t orphan_payments first
begin;

create table if not exists orders (
  id                     uuid primary key,
  sku                    text not null,
  status                 text not null default 'pending',
  credits                integer not null default 0,
  amount_cents           integer not null,
  amount_currency        text not null default 'usd',
  stripe_session_id      text,
  stripe_payment_intent  text,
  recipient_email        text,
  sender_name            text,
  note                   text,
  created_at             timestamptz not null default now(),
  paid_at                timestamptz
);
alter table orders add column if not exists amount_currency text not null default 'usd';

-- SHA-256 (hex) of the per-order access token issued at checkout. NULL for
-- orders created before tokens existed (legacy; see LEGACY_ORDER_ACCESS_UNTIL).
alter table orders add column if not exists access_token_hash text;

create table if not exists readings (
  id          uuid primary key,
  order_id    uuid not null references orders(id) on delete cascade,
  payload     jsonb not null,
  created_at  timestamptz not null default now()
);
create index if not exists readings_order_id_idx on readings (order_id);

-- Applied Stripe event ids: makes webhook fulfilment idempotent.
create table if not exists stripe_events (
  id           text primary key,
  received_at  timestamptz not null default now()
);

-- Gift Reading claim tokens (base table as on main; later gift PRs add their
-- own numbered migrations).
create table if not exists gift_claims (
  token       text primary key,
  order_id    uuid not null references orders(id) on delete cascade,
  claimed     boolean not null default false,
  claimed_at  timestamptz,
  created_at  timestamptz not null default now()
);
-- Old builds could create more than one token per order under races. Keep one
-- row per order before adding the unique index (same rule the app used).
with ranked as (
  select token,
         row_number() over (
           partition by order_id
           order by claimed desc, claimed_at desc nulls last, created_at asc, token asc
         ) as rn
    from gift_claims
)
delete from gift_claims g
 using ranked r
 where g.token = r.token
   and r.rn > 1;
create unique index if not exists gift_claims_order_id_uidx on gift_claims (order_id);

-- Paid Stripe sessions the webhook could not fulfil (direct Payment Link
-- purchases, unknown order, amount/currency mismatch). Support reissues or
-- refunds by hand and sets resolved_at.
create table if not exists orphan_payments (
  stripe_session_id      text primary key,
  stripe_event_id        text not null,
  reason                 text not null,
  order_ref              text,
  stripe_payment_link    text,
  stripe_payment_intent  text,
  amount_cents           integer,
  currency               text,
  customer_email         text,
  created_at             timestamptz not null default now(),
  resolved_at            timestamptz
);

commit;
