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
 *
 * `created` is true only for the call that actually inserted the row, which is
 * how callers send the recipient/buyer emails exactly once even when Stripe
 * retries or the buyer's confirmation view mints the token first.
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
 * The claim link for a PAID gift order, minting it if it is missing. This is
 * the self-healing path for gifts paid before the webhook always minted a
 * token (or whose mint failed): the buyer's confirmation view calls it, so a
 * paid gift always has a claim path. Returns null for unpaid / non-gift orders.
 */
export async function ensureClaimForPaidGift(
  orderId: string,
): Promise<{ token: string; created: boolean; gift: GiftDetails } | null> {
  const gift = await getGiftDetails(orderId);
  if (!gift) return null;
  const paid = await sql()`
    select 1 from orders where id = ${orderId} and status = 'paid' limit 1`;
  if (paid.length === 0) return null;
  const claim = await createGiftClaim(orderId);
  return { ...claim, gift };
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
