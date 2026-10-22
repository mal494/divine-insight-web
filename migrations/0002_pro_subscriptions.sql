-- Pro P3: Stripe subscriptions. NOT applied automatically. Apply after 0001:
--   psql "$DATABASE_URL_UNPOOLED" -f migrations/0002_pro_subscriptions.sql
begin;

alter table entitlements add column if not exists stripe_customer_id text;
alter table entitlements add column if not exists stripe_subscription_id text;
alter table entitlements add column if not exists stripe_price_id text;

create index if not exists entitlements_stripe_customer_idx on entitlements (stripe_customer_id);
create unique index if not exists entitlements_stripe_subscription_idx
  on entitlements (stripe_subscription_id) where stripe_subscription_id is not null;

-- Per-event idempotency for the subscription webhook (separate from the
-- one-time order webhook's bookkeeping, which is untouched).
create table if not exists stripe_subscription_events (
  event_id text primary key,
  type text not null,
  received_at timestamptz not null default now()
);

commit;
