/**
 * gifts.ts — claim links for the Gift Reading.
 *
 * A gift is an order someone else paid for. The buyer never sees the card:
 * the recipient gets an email with a claim link, opens it, and draws their
 * own. The token in that link is the recipient's only credential, so it is
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

async function ensureGiftSchema(): Promise<void> {
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
 */
export async function createGiftClaim(orderId: string): Promise<string> {
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
    select token from inserted
    union all
    select token from gift_claims where order_id = ${orderId}
    limit 1`;
  return (rows[0] as { token: string }).token;
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

  const burned = await db`
    update gift_claims
       set claimed = true, claimed_at = now()
     where token = ${token}
       and claimed = false
    returning order_id`;
  if (burned.length === 0) {
    const exists = await db`select 1 from gift_claims where token = ${token} limit 1`;
    return {
      ok: false,
      reason: exists.length > 0 ? "already_claimed" : "not_found",
    };
  }

  const orderId = (burned[0] as { order_id: string }).order_id;
  await db`
    update orders set credits = greatest(credits - 1, 0)
     where id = ${orderId} and status = 'paid'`;
  await db`
    insert into readings (id, order_id, payload)
    values (${crypto.randomUUID()}, ${orderId}, ${JSON.stringify(reading)}::jsonb)`;

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
