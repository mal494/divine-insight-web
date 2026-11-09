-- Payments hardening (PR #35). NOT applied automatically. Apply BEFORE deploying
-- the code that reads it (it is additive and safe to run on the old code):
--   psql "$DATABASE_URL_UNPOOLED" -f migrations/0004_order_access_and_orphans.sql
-- Independent of 0001-0003. Idempotent: every statement is `if not exists`.
--
-- Without it, the new code fails closed: /api/checkout and the order/reading
-- endpoints answer 503, and the Stripe webhook answers 500 for unfulfillable
-- paid sessions (Stripe retries). No request ever runs this DDL itself.
--
-- Rollback (only after reverting the code):
--   alter table orders drop column if exists access_token_hash;
--   drop table if exists orphan_payments;  -- pg_dump -t orphan_payments first
begin;

-- The one-time orders table normally self-creates on first checkout; create it
-- here too so this file also works on an empty database (e.g. a fresh QA branch).
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

-- SHA-256 (hex) of the per-order access token issued at checkout. NULL for
-- orders created before tokens existed (legacy; see LEGACY_ORDER_ACCESS_UNTIL).
alter table orders add column if not exists access_token_hash text;

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
