-- Gift delivery bookkeeping (PR #32). NOT applied automatically. Apply BEFORE
-- deploying the code that reads it (additive, safe to run on the old code):
--   psql "$DATABASE_URL_UNPOOLED" -f migrations/0005_gift_claim_email_flags.sql
-- Run AFTER 0004_payments_schema.sql (which creates gift_claims; there is no
-- runtime DDL any more). For production: apply BEFORE merging #32 (Vercel
-- deploys main). Idempotent: every statement is `if not exists`.
--
-- recipient_emailed_at / buyer_emailed_at make the gift emails exactly-once no
-- matter which code path minted the claim token: the webhook reserves each
-- email with `update ... set x_emailed_at = now() where x_emailed_at is null`
-- and only the call that wins the reservation sends it (a failed send clears
-- the flag again). Without these columns the webhook answers 500 for paid
-- gifts (Stripe retries) after minting the token; the claim link itself
-- still works and the buyer still sees it.
--
-- Rollback (only after reverting the code):
--   alter table gift_claims drop column if exists recipient_emailed_at;
--   alter table gift_claims drop column if exists buyer_emailed_at;
begin;

-- Same definition as 0004, repeated (no-op when present) so this file is
-- safe even if run on its own.
create table if not exists gift_claims (
  token       text primary key,
  order_id    uuid not null references orders(id) on delete cascade,
  claimed     boolean not null default false,
  claimed_at  timestamptz,
  created_at  timestamptz not null default now()
);
create unique index if not exists gift_claims_order_id_uidx on gift_claims (order_id);

alter table gift_claims add column if not exists recipient_emailed_at timestamptz;
alter table gift_claims add column if not exists buyer_emailed_at timestamptz;

-- Existing rows are left NULL on purpose: production never had Resend
-- configured, so no gift email has ever actually been sent. Stripe does not
-- redeliver old events, so this cannot cause surprise emails.

commit;
