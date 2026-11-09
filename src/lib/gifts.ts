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
  /** True when GIFT_TOKEN_TTL_DAYS is set and this unclaimed link is past it. */
  expired: boolean;
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
 * Claim the right to send one gift email (per order and kind).
 *   "reserved" — this caller must send, then call markGiftEmailSent on
 *                success or releaseGiftEmail on failure.
 *   "sent"     — already sent and recorded; nothing to do.
 *   "busy"     — another delivery holds an unexpired lease (in flight, or it
 *                crashed less than GIFT_EMAIL_LEASE_SECONDS ago). The caller
 *                should answer non-2xx so Stripe retries later.
 * `x_emailed_at` is only ever set after a successful send, so a crash can
 * never mark an unsent email as sent.
 */
export async function reserveGiftEmail(
  orderId: string,
  kind: GiftEmailKind,
): Promise<"reserved" | "sent" | "busy"> {
  const db = sql();
  try {
    const won =
      kind === "recipient"
        ? await db`
            update gift_claims
               set recipient_email_lease_until = now() + make_interval(secs => ${GIFT_EMAIL_LEASE_SECONDS})
             where order_id = ${orderId}
               and recipient_emailed_at is null
               and (recipient_email_lease_until is null or recipient_email_lease_until < now())
            returning order_id`
        : await db`
            update gift_claims
               set buyer_email_lease_until = now() + make_interval(secs => ${GIFT_EMAIL_LEASE_SECONDS})
             where order_id = ${orderId}
               and buyer_emailed_at is null
               and (buyer_email_lease_until is null or buyer_email_lease_until < now())
            returning order_id`;
    if (won.length > 0) return "reserved";
    const state =
      kind === "recipient"
        ? await db`
            select recipient_emailed_at is not null as sent
              from gift_claims where order_id = ${orderId}`
        : await db`
            select buyer_emailed_at is not null as sent
              from gift_claims where order_id = ${orderId}`;
    return (state[0] as { sent?: boolean } | undefined)?.sent ? "sent" : "busy";
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

/** Give the lease back after a failed send, so the next delivery retries at once. */
export async function releaseGiftEmail(orderId: string, kind: GiftEmailKind): Promise<void> {
  const db = sql();
  if (kind === "recipient") {
    await db`
      update gift_claims set recipient_email_lease_until = null
       where order_id = ${orderId} and recipient_emailed_at is null`;
  } else {
    await db`
      update gift_claims set buyer_email_lease_until = null
       where order_id = ${orderId} and buyer_emailed_at is null`;
  }
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
): Promise<{ token: string | null; created: boolean }> {
  const db = sql();

  const raw = await deriveToken(orderId);
  if (!raw) {
    // Fail closed: never store a usable plaintext token. The webhook answers
    // 500 and Stripe retries once the secret is configured.
    console.error(
      "gift claim NOT minted: set GIFT_TOKEN_SECRET (or BETTER_AUTH_SECRET) — refusing to store an unhashed token",
      { orderId },
    );
    throw new GiftTokenSecretMissingError();
  }
  const stored = await hashToken(raw);

  const rows = await db`
    with inserted as (
      insert into gift_claims (token, order_id)
      values (${stored}, ${orderId})
      on conflict (order_id) do nothing
      returning token
    )
    select token, true as created from inserted
    union all
    select token, false as created from gift_claims where order_id = ${orderId}
    limit 1`;
  const row = rows[0] as { token: string; created: boolean } | undefined;
  if (!row) throw new Error(`gift claim could not be minted for order ${orderId}`);
  if (row.created) return { token: raw, created: true };
  return { token: await displayableToken(row.token, orderId), created: false };
}

/**
 * The claim link for a PAID gift order, READ-ONLY. Only the Stripe webhook
 * mints tokens, because the call that mints is the one that sends the
 * recipient and buyer emails: if the buyer's poll could mint first, the
 * webhook would see "already created" and skip both emails. A paid gift with
 * no token yet (webhook still in flight, or retrying after a mint failure)
 * returns token: null and the buyer view keeps polling. token is also null if
 * a hashed token can no longer be re-derived (the secret was rotated); the
 * recipient's link still works and support can resend it. Gifts paid before the
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
  // Hashed rows are re-derived (the DB never holds the link); legacy rows
  // hold it directly. Null if the secret changed since minting.
  const token = row.token ? await displayableToken(row.token, orderId) : null;
  return { token, gift };
}

type ClaimRow = {
  stored_token: string;
  order_id: string;
  claimed: boolean;
  paid_at: unknown;
  claim_created_at: unknown;
  sender_name: string | null;
  note: string | null;
};

/** Find a claim by the token in the link: hashed rows first, legacy plaintext second. */
async function findClaim(token: string): Promise<ClaimRow | null> {
  const hashed = await hashToken(token);
  const rows = await sql()`
    select c.token as stored_token, c.order_id, c.claimed, o.paid_at,
           c.created_at as claim_created_at, o.sender_name, o.note
      from gift_claims c
      join orders o on o.id = c.order_id
     where (c.token = ${hashed} or c.token = ${token})
       and o.status = 'paid'
     order by (c.token = ${hashed}) desc
     limit 1`;
  return (rows[0] as ClaimRow | undefined) ?? null;
}

/**
 * GIFT_TOKEN_TTL_DAYS as days, or null for "no expiry". Anything that is not
 * a positive finite number is treated as unset (and logged), so a typo can
 * never expire every outstanding gift.
 */
export function giftTokenTtlDays(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env.GIFT_TOKEN_TTL_DAYS?.trim();
  if (!raw) return null;
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0) {
    console.warn("GIFT_TOKEN_TTL_DAYS is not a positive number — gift links will not expire", raw);
    return null;
  }
  return days;
}

/** Whether an UNCLAIMED gift link is past its window. Claimed gifts never expire. */
export function isClaimExpired(
  row: { claimed: boolean; paid_at: unknown; claim_created_at: unknown },
  now: Date = new Date(),
  ttlDays: number | null = giftTokenTtlDays(),
): boolean {
  if (row.claimed || ttlDays === null) return false;
  const from = toDate(row.paid_at) ?? toDate(row.claim_created_at);
  if (!from) return false; // No purchase time on record: fail open for a paid gift.
  return now.getTime() >= from.getTime() + ttlDays * 24 * 60 * 60 * 1000;
}

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** What the claim page may show before the recipient turns their card. */
export async function getClaim(token: string): Promise<ClaimView | null> {
  if (!isToken(token)) return null;
  const row = await findClaim(token);
  if (!row) return null;

  if (isClaimExpired(row)) {
    return {
      senderName: row.sender_name,
      note: row.note,
      claimed: false,
      reading: null,
      expired: true,
    };
  }

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
    expired: false,
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
): Promise<
  { ok: true } | { ok: false; reason: "not_found" | "already_claimed" | "expired" }
> {
  if (!isToken(token)) return { ok: false, reason: "not_found" };
  const db = sql();

  const row = await findClaim(token);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.claimed) return { ok: false, reason: "already_claimed" };
  if (isClaimExpired(row)) return { ok: false, reason: "expired" };

  // One statement, so it is atomic: burn the token, spend the credit and store
  // the reading together, or not at all. `claimed = false` is the lock (a
  // racing second tab burns nothing), and the expiry window is re-checked
  // inside the UPDATE so GET and POST can never disagree at the boundary.
  const ttlDays = giftTokenTtlDays();
  const done = await db`
    with burned as (
      update gift_claims c
         set claimed = true, claimed_at = now()
        from orders o
       where c.token = ${row.stored_token}
         and c.claimed = false
         and o.id = c.order_id
         and o.status = 'paid'
         and (${ttlDays}::double precision is null
              or coalesce(o.paid_at, c.created_at)
                 + make_interval(secs => ${ttlDays}::double precision * 86400) > now())
      returning c.order_id
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
  const burned = done[0] as { order_id: string | null } | undefined;
  if (!burned?.order_id) {
    // Lost a race to another tab, or crossed the expiry boundary just now.
    const again = await findClaim(token);
    if (again && !again.claimed && isClaimExpired(again)) return { ok: false, reason: "expired" };
    return { ok: false, reason: "already_claimed" };
  }

  return { ok: true };
}

/** Thrown when no gift token secret is configured. Never caught silently. */
export class GiftTokenSecretMissingError extends Error {
  constructor() {
    super("gift token secret missing: set GIFT_TOKEN_SECRET or BETTER_AUTH_SECRET");
    this.name = "GiftTokenSecretMissingError";
  }
}

/** SHA-256 of the link token, lowercase hex (64 chars). What new rows store. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toHex(new Uint8Array(digest));
}

/**
 * The link token for an order, derived with the server secret. Null when no
 * secret is configured. 128 bits (32 hex), the same shape as legacy tokens.
 */
export async function deriveToken(
  orderId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  const secret = env.GIFT_TOKEN_SECRET || env.BETTER_AUTH_SECRET;
  if (!secret) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`gift-claim:v1:${orderId}`),
  );
  return toHex(new Uint8Array(mac)).slice(0, 32);
}

/** Recover the link token from what a row stores, for the buyer's view. */
async function displayableToken(stored: string, orderId: string): Promise<string | null> {
  if (isToken(stored)) return stored; // Legacy plaintext row.
  const derived = await deriveToken(orderId);
  if (derived && (await hashToken(derived)) === stored) return derived;
  console.error("gift claim link cannot be re-derived for buyer (secret changed?)", { orderId });
  return null;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isToken(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value);
}
