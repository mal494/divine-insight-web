/**
 * gifts.ts — claim links for the Gift Reading.
 *
 * A gift is an order someone else paid for. Every paid gift gets exactly one
 * claim link: the recipient is emailed it (when an address and Resend are
 * configured) and the buyer is always shown it on their confirmation view and
 * in their gift receipt email, so a paid gift can never be stranded. The token in that link is the recipient's only credential, so it is
 * random, single-use, and never guessable from the order id.
 *
 * Server-only. Lives beside orders.ts. gift_claims comes from
 * migrations/0004_payments_schema.sql and its email flags from
 * migrations/0005_gift_claim_email_flags.sql (no runtime DDL).
 */
import { sql } from "~/db";

export type GiftDetails = {
  orderId: string;
  recipientEmail: string | null;
  senderName: string | null;
  note: string | null;
};

export type ClaimView = {
  senderName: string | null;
  note: string | null;
  claimed: boolean;
  /** The reading drawn when it was claimed, if it has been. */
  reading: unknown | null;
};

export const GIFT_EMAIL_MIGRATION = "migrations/0005_gift_claim_email_flags.sql";

export class GiftSchemaMissingError extends Error {
  constructor(cause: unknown) {
    super(`gift email flags missing: apply ${GIFT_EMAIL_MIGRATION}`, { cause });
    this.name = "GiftSchemaMissingError";
  }
}

export type GiftEmailKind = "recipient" | "buyer";

/**
 * How long one delivery attempt holds the right to send an email. A process
 * that dies mid-send (after reserving, before recording the result) loses the
 * lease when it expires, so a Stripe retry can send the email instead of it
 * being lost. Longer than any send attempt (fetch timeout + function limit).
 */
export const GIFT_EMAIL_LEASE_SECONDS = 120;

/**
 * Bounded retries (QA round 6, N1). During a long Resend outage the webhook
 * must not answer 500 forever: Stripe disables an endpoint that keeps failing
 * for days. After `maxAttempts` failed sends for one email, or once the order
 * has been paid for longer than `giveUpAfterSeconds`, we record
 * `*_email_failed_at` and stop (the webhook answers 200). The buyer still
 * sees the claim link on their confirmation view; support can resend by hand.
 *
 *   GIFT_EMAIL_MAX_ATTEMPTS   integer 1–100, default 5
 *   GIFT_EMAIL_GIVE_UP_HOURS  number (0, 72], default 6 (Stripe retries live
 *                             events for up to 3 days)
 * Invalid values fall back to the defaults.
 */
export const GIFT_EMAIL_DEFAULT_MAX_ATTEMPTS = 5;
export const GIFT_EMAIL_DEFAULT_GIVE_UP_HOURS = 6;

export type GiftEmailRetryPolicy = { maxAttempts: number; giveUpAfterSeconds: number };

export function giftEmailRetryPolicy(
  env: Record<string, string | undefined> = process.env,
): GiftEmailRetryPolicy {
  const rawAttempts = env.GIFT_EMAIL_MAX_ATTEMPTS?.trim() ?? "";
  const attempts = /^\d+$/.test(rawAttempts) ? Number(rawAttempts) : NaN;
  const maxAttempts =
    Number.isInteger(attempts) && attempts >= 1 && attempts <= 100
      ? attempts
      : GIFT_EMAIL_DEFAULT_MAX_ATTEMPTS;
  const rawHours = env.GIFT_EMAIL_GIVE_UP_HOURS?.trim() ?? "";
  const hours = /^\d+(\.\d+)?$/.test(rawHours) ? Number(rawHours) : NaN;
  const giveUpHours =
    Number.isFinite(hours) && hours > 0 && hours <= 72 ? hours : GIFT_EMAIL_DEFAULT_GIVE_UP_HOURS;
  return { maxAttempts, giveUpAfterSeconds: Math.round(giveUpHours * 3600) };
}

/**
 * Outcome of reserveGiftEmail. A "reserved" result carries `lease`, a fencing
 * token: the exact `*_email_lease_until` value this caller wrote (as text,
 * microsecond precision). releaseGiftEmail only acts while that value is still
 * in place, so a delivery whose lease expired and was taken over by another
 * delivery can never clear the new holder's lease or count its attempt.
 */
export type GiftEmailReservation =
  | { status: "reserved"; lease: string }
  | { status: "sent" | "busy" | "gave-up" };

/**
 * Claim the right to send one gift email (per order and kind).
 *   "reserved" — this caller must send, then call markGiftEmailSent on
 *                success or releaseGiftEmail(…, lease) on failure.
 *   "sent"     — already sent and recorded; nothing to do.
 *   "gave-up"  — retries were exhausted earlier (`*_email_failed_at` set);
 *                nothing to do, the buyer has the link.
 *   "busy"     — another delivery holds an unexpired lease (in flight, or it
 *                crashed less than GIFT_EMAIL_LEASE_SECONDS ago). The caller
 *                should answer non-2xx so Stripe retries later.
 * `x_emailed_at` is only ever set after a successful send, so a crash can
 * never mark an unsent email as sent.
 */
export async function reserveGiftEmail(
  orderId: string,
  kind: GiftEmailKind,
): Promise<GiftEmailReservation> {
  const db = sql();
  try {
    const won =
      kind === "recipient"
        ? await db`
            update gift_claims set recipient_email_lease_until = now() + make_interval(secs => ${GIFT_EMAIL_LEASE_SECONDS})
             where order_id = ${orderId}
               and recipient_emailed_at is null
               and recipient_email_failed_at is null
               and (recipient_email_lease_until is null or recipient_email_lease_until < now())
            returning recipient_email_lease_until::text as lease`
        : await db`
            update gift_claims set buyer_email_lease_until = now() + make_interval(secs => ${GIFT_EMAIL_LEASE_SECONDS})
             where order_id = ${orderId}
               and buyer_emailed_at is null
               and buyer_email_failed_at is null
               and (buyer_email_lease_until is null or buyer_email_lease_until < now())
            returning buyer_email_lease_until::text as lease`;
    const lease = (won[0] as { lease?: unknown } | undefined)?.lease;
    if (typeof lease === "string" && lease) return { status: "reserved", lease };
    const state =
      kind === "recipient"
        ? await db`
            select recipient_emailed_at is not null as sent, recipient_email_failed_at is not null as failed
              from gift_claims where order_id = ${orderId}`
        : await db`
            select buyer_emailed_at is not null as sent, buyer_email_failed_at is not null as failed
              from gift_claims where order_id = ${orderId}`;
    const row = state[0] as { sent?: boolean; failed?: boolean } | undefined;
    if (row?.sent) return { status: "sent" };
    if (row?.failed) return { status: "gave-up" };
    return { status: "busy" };
  } catch (err) {
    if (isMissingColumn(err)) throw new GiftSchemaMissingError(err);
    throw err;
  }
}

/** Record a successful send: the email is never sent again for this order. */
export async function markGiftEmailSent(orderId: string, kind: GiftEmailKind): Promise<void> {
  const db = sql();
  if (kind === "recipient") {
    await db`
      update gift_claims set recipient_emailed_at = now(), recipient_email_lease_until = null
       where order_id = ${orderId}`;
  } else {
    await db`
      update gift_claims set buyer_emailed_at = now(), buyer_email_lease_until = null
       where order_id = ${orderId}`;
  }
}

/**
 * Give the lease back after a failed send and count the attempt. Only the
 * lease holder can do this: every update matches `*_email_lease_until =
 * lease`. If the lease already expired and another delivery took it over,
 * nothing is changed and "retry" is returned (the new holder decides).
 *   "retry"   — the next delivery may try again at once (caller answers 500).
 *   "gave-up" — the attempt cap or the age cap was reached (or the failure was
 *               permanent): `*_email_failed_at` is now set and no delivery
 *               will send this email again; the caller answers 200.
 * Pass `permanent: true` for a send the provider rejected for good.
 */
export async function releaseGiftEmail(
  orderId: string,
  kind: GiftEmailKind,
  lease: string,
  opts: { permanent?: boolean; policy?: GiftEmailRetryPolicy } = {},
): Promise<"retry" | "gave-up"> {
  const db = sql();
  if (opts.permanent) {
    const held =
      kind === "recipient"
        ? await db`
            update gift_claims set recipient_email_failed_at = now(), recipient_email_lease_until = null
             where order_id = ${orderId} and recipient_emailed_at is null
               and recipient_email_lease_until = ${lease}::timestamptz
            returning order_id`
        : await db`
            update gift_claims set buyer_email_failed_at = now(), buyer_email_lease_until = null
             where order_id = ${orderId} and buyer_emailed_at is null
               and buyer_email_lease_until = ${lease}::timestamptz
            returning order_id`;
    return held.length > 0 ? "gave-up" : "retry";
  }
  const policy = opts.policy ?? giftEmailRetryPolicy();
  const held =
    kind === "recipient"
      ? await db`
          update gift_claims set recipient_email_lease_until = null,
                 recipient_email_attempts = recipient_email_attempts + 1
           where order_id = ${orderId} and recipient_emailed_at is null
             and recipient_email_lease_until = ${lease}::timestamptz
          returning order_id`
      : await db`
          update gift_claims set buyer_email_lease_until = null,
                 buyer_email_attempts = buyer_email_attempts + 1
           where order_id = ${orderId} and buyer_emailed_at is null
             and buyer_email_lease_until = ${lease}::timestamptz
          returning order_id`;
  // Not the holder any more: leave the new holder's lease and count alone.
  if (held.length === 0) return "retry";
  // Second, separate statement: decide whether to stop. Idempotent, so a
  // crash between the two only delays the decision to the next failure.
  const stopped =
    kind === "recipient"
      ? await db`
          update gift_claims set recipient_email_failed_at = now()
           where order_id = ${orderId}
             and recipient_emailed_at is null
             and recipient_email_failed_at is null
             and (recipient_email_attempts >= ${policy.maxAttempts}
                  or coalesce((select o.paid_at from orders o where o.id = gift_claims.order_id),
                              gift_claims.created_at)
                     < now() - make_interval(secs => ${policy.giveUpAfterSeconds}))
          returning order_id`
      : await db`
          update gift_claims set buyer_email_failed_at = now()
           where order_id = ${orderId}
             and buyer_emailed_at is null
             and buyer_email_failed_at is null
             and (buyer_email_attempts >= ${policy.maxAttempts}
                  or coalesce((select o.paid_at from orders o where o.id = gift_claims.order_id),
                              gift_claims.created_at)
                     < now() - make_interval(secs => ${policy.giveUpAfterSeconds}))
          returning order_id`;
  return stopped.length > 0 ? "gave-up" : "retry";
}

function isMissingColumn(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "42703" || code === "42P01";
}

/** Read the gift fields captured at checkout. Null when it is not a gift order. */
export async function getGiftDetails(orderId: string): Promise<GiftDetails | null> {
  const rows = await sql()`
    select id, recipient_email, sender_name, note
      from orders
     where id = ${orderId} and sku = 'giftReading'
     limit 1`;
  const row = rows[0] as
    | {
        id: string;
        recipient_email: string | null;
        sender_name: string | null;
        note: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    orderId: row.id,
    recipientEmail: row.recipient_email,
    senderName: row.sender_name,
    note: row.note,
  };
}

/**
 * Mint the claim token for a paid gift order. Idempotent: a Stripe retry that
 * slips past the event guard still yields the one token we already sent, so a
 * recipient never gets two different links for one gift.
 *
 * `created` is true only for the call that actually inserted the row, which is
 * used for the support log line. The emails themselves are exactly-once via
 * reserveGiftEmail (recipient_emailed_at / buyer_emailed_at), independent of
 * who minted. The webhook is still the only minter.
 */
export async function createGiftClaim(
  orderId: string,
): Promise<{ token: string; created: boolean }> {
  const db = sql();

  const token = randomToken();
  const rows = await db`
    with inserted as (
      insert into gift_claims (token, order_id)
      values (${token}, ${orderId})
      on conflict (order_id) do nothing
      returning token
    )
    select token, true as created from inserted
    union all
    select token, false as created from gift_claims where order_id = ${orderId}
    limit 1`;
  const row = rows[0] as { token: string; created: boolean } | undefined;
  if (!row) throw new Error(`gift claim could not be minted for order ${orderId}`);
  return { token: row.token, created: Boolean(row.created) };
}

/**
 * The claim link for a PAID gift order, READ-ONLY. Only the Stripe webhook
 * mints tokens, because the call that mints is the one that sends the
 * recipient and buyer emails: if the buyer's poll could mint first, the
 * webhook would see "already created" and skip both emails. A paid gift with
 * no token yet (webhook still in flight, or retrying after a mint failure)
 * returns token: null and the buyer view keeps polling. Gifts paid before the
 * webhook always minted are healed by scripts/backfills/2026-11-gift-claim-tokens.sql.
 * Returns null for unpaid / non-gift orders.
 */
export async function getClaimForPaidGift(
  orderId: string,
): Promise<{ token: string | null; gift: GiftDetails } | null> {
  const gift = await getGiftDetails(orderId);
  if (!gift) return null;
  const rows = await sql()`
    select c.token
      from orders o
      left join gift_claims c on c.order_id = o.id
     where o.id = ${orderId} and o.status = 'paid'
     limit 1`;
  const row = rows[0] as { token: string | null } | undefined;
  if (!row) return null;
  return { token: row.token ?? null, gift };
}

/** What the claim page may show before the recipient turns their card. */
export async function getClaim(token: string): Promise<ClaimView | null> {
  if (!isToken(token)) return null;
  const rows = await sql()`
    select o.sender_name, o.note, c.claimed, c.order_id
      from gift_claims c
      join orders o on o.id = c.order_id
     where c.token = ${token}
       and o.status = 'paid'
     limit 1`;
  const row = rows[0] as
    | { sender_name: string | null; note: string | null; claimed: boolean; order_id: string }
    | undefined;
  if (!row) return null;

  let reading: unknown = null;
  if (row.claimed) {
    const saved = await sql()`
      select payload from readings
       where order_id = ${row.order_id}
       order by created_at desc limit 1`;
    reading = (saved[0] as { payload: unknown } | undefined)?.payload ?? null;
  }

  return {
    senderName: row.sender_name,
    note: row.note,
    claimed: row.claimed,
    reading,
  };
}

/**
 * Claim a gift: spend the order's credit, store the drawn card, and burn the
 * token. The conditional update is the lock — a second tab racing the first
 * finds `claimed` already true and gets nothing.
 */
export async function claimGift(
  token: string,
  reading: unknown,
): Promise<{ ok: true } | { ok: false; reason: "not_found" | "already_claimed" }> {
  if (!isToken(token)) return { ok: false, reason: "not_found" };
  const db = sql();

  // One statement, so it is atomic: burn the token, spend the credit and store
  // the reading together, or not at all. The `claimed = false` condition is
  // the lock — a second tab racing the first burns nothing and gets nothing.
  const done = await db`
    with burned as (
      update gift_claims
         set claimed = true, claimed_at = now()
       where token = ${token}
         and claimed = false
      returning order_id
    ),
    spent as (
      update orders o
         set credits = greatest(o.credits - 1, 0)
        from burned b
       where o.id = b.order_id and o.status = 'paid'
      returning o.id
    ),
    saved as (
      insert into readings (id, order_id, payload)
      select ${crypto.randomUUID()}, b.order_id, ${JSON.stringify(reading)}::jsonb
        from burned b
      returning id
    )
    select (select order_id from burned) as order_id,
           (select id from saved) as reading_id`;
  const row = done[0] as { order_id: string | null; reading_id: string | null } | undefined;
  if (!row?.order_id) {
    const exists = await db`select 1 from gift_claims where token = ${token} limit 1`;
    return {
      ok: false,
      reason: exists.length > 0 ? "already_claimed" : "not_found",
    };
  }

  return { ok: true };
}

/** 32 hex chars — 128 bits, URL-safe, and not derivable from the order id. */
function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isToken(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value);
}
