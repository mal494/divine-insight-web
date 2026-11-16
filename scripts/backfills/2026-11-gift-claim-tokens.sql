-- Backfill: mint a claim token for every PAID gift order that has none.
--
-- NOT applied automatically and NOT a schema migration. Run by hand, once,
-- against the target database only after the "never strand a paid gift" code
-- is deployed (see the PR description for the rollout order).
--
-- ORDERING vs. hashed tokens (PR #33): this mints PLAINTEXT tokens (the
-- legacy format, still accepted by #33's lookup). Run it BEFORE #33's
-- optional hashing backfill (scripts/backfills/2026-11-gift-claim-token-hashing.sql),
-- so the rows it creates are hashed too. If #33 is already deployed, either
-- run that hashing backfill again afterwards, or skip this script: the
-- webhook mints hashed tokens for every new gift. Rows minted here are never
-- emailed; support shares the link from the buyer's confirmation view. It is safe to
-- run more than once: the unique index gift_claims_order_id_uidx plus
-- `on conflict do nothing` and the `not exists` filter make it idempotent.
--
-- Tokens are 32 lowercase hex chars (122 random bits from gen_random_uuid(),
-- core Postgres 13+), matching the format the claim routes accept. They are
-- not returned or printed: buyers see their link on the gift confirmation view
-- (/api/order/<id> returns claimUrl for paid gifts), and support can look a
-- row up by order id.
--
-- Dry run first:
--   select o.id, o.paid_at, o.recipient_email is null as no_recipient_email
--     from orders o
--    where o.sku = 'giftReading' and o.status = 'paid'
--      and not exists (select 1 from gift_claims c where c.order_id = o.id);

begin;

-- gift_claims is normally created lazily by the app; make sure it exists so
-- this script also works on a database that has never served a claim.
create table if not exists gift_claims (
  token       text primary key,
  order_id    uuid not null references orders(id) on delete cascade,
  claimed     boolean not null default false,
  claimed_at  timestamptz,
  created_at  timestamptz not null default now()
);
create unique index if not exists gift_claims_order_id_uidx on gift_claims (order_id);

insert into gift_claims (token, order_id)
select replace(gen_random_uuid()::text, '-', ''), o.id
  from orders o
 where o.sku = 'giftReading'
   and o.status = 'paid'
   and not exists (select 1 from gift_claims c where c.order_id = o.id)
on conflict (order_id) do nothing;

commit;
