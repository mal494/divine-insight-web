/**
 * gifts.ts — claim links for the Gift Reading.
 *
 * A gift is an order someone else paid for. Every paid gift gets exactly one
 * claim link: the recipient is emailed it (when an address and Resend are
 * configured) and the buyer is always shown it on their confirmation view and
 * in their gift receipt email, so a paid gift can never be stranded. The token in that link is the recipient's only credential, so it is
 * random, single-use, and never guessable from the order id.
 *
 * Server-only. Lives beside orders.ts and shares its schema bootstrap.
 */
import { sql } from "~/db";
import { ensureSchema } from "~/lib/orders";

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

/**
 * Create the original gift_claims table on first use, at most once per server
 * process (the dedupe + index statements are not free). New columns go in
 * migrations/ — the email flags come from GIFT_EMAIL_MIGRATION.
 */
async function ensureGiftSchema(): Promise<void> {
  giftSchemaReady ??= bootstrapGiftSchema().catch((err: unknown) => {
    giftSchemaReady = null;
    throw err;
  });
  return giftSchemaReady;
}

let giftSchemaReady: Promise<void> | null = null;

async function bootstrapGiftSchema(): Promise<void> {
  await ensureSchema();
  await sql()`
    create table if not exists gift_claims (
      token       text primary key,
      order_id    uuid not null references orders(id) on delete cascade,
      claimed     boolean not null default false,
      claimed_at  timestamptz,
      created_at  timestamptz not null default now()
    )`;
  // Migration: old builds could create more than one token per order under
  // races. Keep one row per order before adding the unique index.
  await sql()`
    with ranked as (
      select
        token,
        row_number() over (
          partition by order_id
          order by claimed desc, claimed_at desc nulls last, created_at asc, token asc
        ) as rn
      from gift_claims
    )
    delete from gift_claims g
     using ranked r
     where g.token = r.token
       and r.rn > 1`;
  await sql()`
    create unique index if not exists gift_claims_order_id_uidx
      on gift_claims (order_id)`;
}

export const GIFT_EMAIL_MIGRATION = "migrations/0005_gift_claim_email_flags.sql";

export class GiftSchemaMissingError extends Error {
  constructor(cause: unknown) {
    super(`gift email flags missing: apply ${GIFT_EMAIL_MIGRATION}`, { cause });
    this.name = "GiftSchemaMissingError";
  }
}

export type GiftEmailKind = "recipient" | "buyer";

/**
 * Reserve the one send of a gift email. Returns true for exactly one caller
 * per (order, kind), whichever code path minted the token and however many
 * times Stripe delivers the event. Call releaseGiftEmail if the send fails.
 */
export async function reserveGiftEmail(orderId: string, kind: GiftEmailKind): Promise<boolean> {
  await ensureGiftSchema();
  const db = sql();
  try {
    const rows =
      kind === "recipient"
        ? await db`
            update gift_claims set recipient_emailed_at = now()
             where order_id = ${orderId} and recipient_emailed_at is null
            returning order_id`
        : await db`
            update gift_claims set buyer_emailed_at = now()
             where order_id = ${orderId} and buyer_emailed_at is null
            returning order_id`;
    return rows.length > 0;
  } catch (err) {
    if (isMissingColumn(err)) throw new GiftSchemaMissingError(err);
    throw err;
  }
}

/** Undo a reservation after a failed send, so a later delivery may retry. */
export async function releaseGiftEmail(orderId: string, kind: GiftEmailKind): Promise<void> {
  const db = sql();
  if (kind === "recipient") {
    await db`update gift_claims set recipient_emailed_at = null where order_id = ${orderId}`;
  } else {
    await db`update gift_claims set buyer_emailed_at = null where order_id = ${orderId}`;
  }
}

function isMissingColumn(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "42703" || code === "42P01";
}

/** Read the gift fields captured at checkout. Null when it is not a gift order. */
export async function getGiftDetails(orderId: string): Promise<GiftDetails | null> {
  await ensureGiftSchema();
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
  await ensureGiftSchema();
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
  await ensureGiftSchema();
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
  await ensureGiftSchema();
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
