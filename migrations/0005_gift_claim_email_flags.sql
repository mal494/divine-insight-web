-- Gift delivery bookkeeping (PR #32). NOT applied automatically. Apply BEFORE
-- deploying the code that reads it (additive, safe to run on the old code):
--   psql "$DATABASE_URL_UNPOOLED" -f migrations/0005_gift_claim_email_flags.sql
-- Run AFTER 0004_payments_schema.sql (which creates gift_claims; there is no
-- runtime DDL any more). For production: apply BEFORE merging #32 (Vercel
-- deploys main). Idempotent: every statement is `if not exists`.
--
-- recipient_emailed_at / buyer_emailed_at record that a gift email WAS sent
-- (set only after the provider accepted it), so it is never sent twice; the
-- *_email_lease_until columns let exactly one delivery send at a time and
-- expire if that delivery crashes, so an email is never lost either. Without these columns the webhook answers 500 for paid
-- gifts (Stripe retries) after minting the token; the claim link itself
-- still works and the buyer still sees it.
--
-- Rollback (only after reverting the code):
--   alter table gift_claims drop column if exists recipient_emailed_at;
--   alter table gift_claims drop column if exists buyer_emailed_at;
--   alter table gift_claims drop column if exists recipient_email_lease_until;
--   alter table gift_claims drop column if exists buyer_email_lease_until;
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
-- Short send leases (QA round 5): a delivery holds the lease while it sends;
-- *_emailed_at is only set after the provider accepted the email. A crash
-- mid-send leaves just the lease, which expires, so a Stripe retry sends it.
alter table gift_claims add column if not exists recipient_email_lease_until timestamptz;
alter table gift_claims add column if not exists buyer_email_lease_until timestamptz;

-- Existing rows are left NULL on purpose: production never had Resend
-- configured, so no gift email has ever actually been sent. Stripe does not
-- redeliver old events, so this cannot cause surprise emails.

commit;
