-- OPTIONAL backfill: replace legacy PLAINTEXT gift claim tokens with their
-- SHA-256 hash, so no working link is readable from the database.
--
-- NOT applied automatically. No schema change: gift_claims.token keeps its
-- type; hashed values are 64 hex chars, legacy plaintext values are 32, and
-- the app (>= the "hashed single-use tokens" PR) looks a link up by
-- sha256(token) first and by the plaintext token second.
--
-- Rollout order (see the PR description):
--   1. Deploy the hashed-token code. New gifts are stored hashed from then on;
--      legacy links keep working via the plaintext fallback.
--   2. Leave it running until you are sure you will not roll back: code older
--      than step 1 can NOT read hashed rows.
--   3. Only then, optionally, run this script. If #32's mint backfill
--      (2026-11-gift-claim-tokens.sql) is run at any point, run this AFTER it
--      (again, if needed): that script writes plaintext tokens.
--
-- Trade-off: legacy tokens were random (not derived from the server secret),
-- so after this runs the buyer confirmation view can no longer re-display the
-- link for those older UNCLAIMED gifts. The recipient's link still works.
-- If that matters, run it only for claimed rows by adding `and claimed`.
--
-- Dry run first:
--   select count(*) filter (where claimed)     as legacy_claimed,
--          count(*) filter (where not claimed) as legacy_unclaimed
--     from gift_claims
--    where token ~ '^[0-9a-f]{32}$';
--
-- Requires Postgres 11+ (built-in sha256). Idempotent: the filter only ever
-- matches 32-hex plaintext rows, and a hashed row never matches again.

begin;

update gift_claims
   set token = encode(sha256(convert_to(token, 'UTF8')), 'hex')
 where token ~ '^[0-9a-f]{32}$';

commit;
