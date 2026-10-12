/**
 * orders.ts — server-only order + entitlement store for Divine Insight.
 *
 * This is the trust boundary. Before this file existed, fulfilment was
 * honor-based: the CTA opened a Stripe payment link in a new tab and the draw
 * was never gated, so a paid reading was free to anyone who found the page.
 *
 * The rule now: an order becomes `paid` in exactly one place — the Stripe
 * webhook, after Stripe's own signature has been verified. Nothing the browser
 * sends can mark an order paid, and the price of each SKU is read from the
 * table below rather than from the request, so a tampered client can only ever
 * buy what it actually paid for.
 *
 * Never import this from a component. It is for `createServerFn()` handlers and
 * `src/routes/api/*` routes only.
 */
import { sql } from "~/db";

/** The four paid SKUs. Keys match PAYMENT_LINKS in ~/lib/payments. */
export type Sku =
  | "singleInsight"
  | "extendedReading"
  | "readingBundle"
  | "giftReading";

type SkuSpec = {
  /** Amount in cents, as configured on the Stripe payment link. Server-side truth. */
  amountCents: number;
  /** How many readings this SKU entitles. The bundle is the only multi-credit SKU. */
  credits: number;
  /** Which draw the credit unlocks — the client uses this to pick the view. */
  kind: "single" | "extended" | "gift";
};

/**
 * Server-side price and entitlement table. The client never supplies a price;
 * it supplies a SKU key and gets whatever this table says that key costs.
 * These amounts must match the Stripe payment links in ~/lib/payments — the
 * webhook asserts the two agree and refuses to fulfil an order if they drift.
 */
export const SKUS: Record<Sku, SkuSpec> = {
  singleInsight: { amountCents: 299, credits: 1, kind: "single" },
  extendedReading: { amountCents: 999, credits: 1, kind: "extended" },
  readingBundle: { amountCents: 1999, credits: 3, kind: "extended" },
  giftReading: { amountCents: 500, credits: 1, kind: "gift" },
};

export function isSku(value: unknown): value is Sku {
  return typeof value === "string" && value in SKUS;
}

export type OrderStatus = "pending" | "paid" | "void";

export type Order = {
  id: string;
  sku: Sku;
  status: OrderStatus;
  credits: number;
  kind: SkuSpec["kind"];
};

/**
 * Create the tables on first use. Cheap enough to call per request (every
 * statement is `if not exists`) and it keeps the site deployable without a
 * separate migration step, which this template has no runner for.
 */
export async function ensureSchema(): Promise<void> {
  const db = sql();
  await db`
    create table if not exists orders (
      id                     uuid primary key,
      sku                    text not null,
      status                 text not null default 'pending',
      credits                integer not null default 0,
      amount_cents           integer not null,
      stripe_session_id      text,
      stripe_payment_intent  text,
      recipient_email        text,
      sender_name            text,
      note                   text,
      created_at             timestamptz not null default now(),
      paid_at                timestamptz
    )`;
  await db`
    create table if not exists readings (
      id          uuid primary key,
      order_id    uuid not null references orders(id) on delete cascade,
      payload     jsonb not null,
      created_at  timestamptz not null default now()
    )`;
  await db`
    create index if not exists readings_order_id_idx on readings (order_id)`;
  // Stripe retries webhooks. Recording every event id we have already applied
  // makes fulfilment idempotent: a replayed event is a no-op, not a second
  // batch of credits.
  await db`
    create table if not exists stripe_events (
      id           text primary key,
      received_at  timestamptz not null default now()
    )`;
}

/** Open a pending order. Returns the id we hand to Stripe as client_reference_id. */
export async function createOrder(
  sku: Sku,
  gift?: { recipientEmail?: string; senderName?: string; note?: string },
): Promise<string> {
  await ensureSchema();
  const spec = SKUS[sku];
  const id = crypto.randomUUID();
  await sql()`
    insert into orders (id, sku, status, credits, amount_cents, recipient_email, sender_name, note)
    values (
      ${id}, ${sku}, 'pending', ${spec.credits}, ${spec.amountCents},
      ${gift?.recipientEmail ?? null}, ${gift?.senderName ?? null}, ${gift?.note ?? null}
    )`;
  return id;
}

/** Read an order. Returns null for an unknown id — never throws on a bad id. */
export async function getOrder(id: string): Promise<Order | null> {
  if (!isUuid(id)) return null;
  await ensureSchema();
  const rows = await sql()`
    select id, sku, status, credits from orders where id = ${id} limit 1`;
  const row = rows[0] as
    | { id: string; sku: string; status: string; credits: number }
    | undefined;
  if (!row || !isSku(row.sku)) return null;
  return {
    id: row.id,
    sku: row.sku,
    status: row.status as OrderStatus,
    credits: Number(row.credits),
    kind: SKUS[row.sku].kind,
  };
}

/**
 * Mark an order paid. Called only from the verified webhook.
 *
 * Idempotent on two levels: the paid write only fires `where status =
 * 'pending'`, and applied event ids are remembered so retries become no-ops.
 */
export async function markPaid(args: {
  eventId: string;
  orderId: string;
  paymentIntent: string | null;
  sessionId: string | null;
  amountCents: number | null;
}): Promise<"applied" | "duplicate" | "unknown-order" | "amount-mismatch"> {
  await ensureSchema();
  const db = sql();

  const duplicate = await db`
    select id from stripe_events where id = ${args.eventId} limit 1`;
  const hasSeenEvent = duplicate.length > 0;

  const order = await getOrder(args.orderId);
  if (!order) return "unknown-order";

  // Defence in depth: if the amount Stripe charged does not match the SKU's
  // server-side price, something is misconfigured (a payment link edited in the
  // dashboard, a reused link). Leave the order pending rather than fulfil it.
  const expected = SKUS[order.sku].amountCents;
  if (args.amountCents !== null && args.amountCents !== expected) {
    return "amount-mismatch";
  }

  if (order.status === "pending") {
    const updated = await db`
      update orders
         set status = 'paid',
             paid_at = now(),
             stripe_payment_intent = ${args.paymentIntent},
             stripe_session_id = ${args.sessionId}
       where id = ${args.orderId}
         and status = 'pending'
      returning id`;

    if (updated.length === 0) {
      const latest = await getOrder(args.orderId);
      if (!latest || latest.status !== "paid") return "unknown-order";
    }
  } else if (order.status !== "paid") {
    return "unknown-order";
  }

  // Claim only after we know the order is paid (now or already). This keeps
  // retries viable when we reject a webhook before fulfilment applies.
  if (hasSeenEvent) return "duplicate";

  const claimed = await db`
    insert into stripe_events (id) values (${args.eventId})
    on conflict (id) do nothing
    returning id`;
  if (claimed.length === 0) return "duplicate";
  return "applied";
}

/**
 * Spend one credit and store the reading against the order.
 *
 * Returns null when the order is unpaid or out of credits, so the caller can
 * answer 402 without a second lookup. The decrement and the insert run as one
 * SQL statement so they succeed or fail together, and two tabs cannot spend
 * the same last credit twice.
 */
export async function saveReading(
  orderId: string,
  payload: unknown,
): Promise<{ readingId: string; creditsLeft: number } | null> {
  if (!isUuid(orderId)) return null;
  await ensureSchema();
  const db = sql();

  const readingId = crypto.randomUUID();
  const result = await db`
    with spent as (
      update orders
         set credits = credits - 1
       where id = ${orderId}
         and status = 'paid'
         and credits > 0
      returning credits
    ),
    saved as (
      insert into readings (id, order_id, payload)
      select ${readingId}, ${orderId}, ${JSON.stringify(payload)}::jsonb
        from spent
      returning id
    )
    select
      (select id from saved) as reading_id,
      (select credits from spent) as credits_left`;

  const row = result[0] as
    | { reading_id: string | null; credits_left: number | null }
    | undefined;
  if (!row?.reading_id || row.credits_left === null) return null;
  return { readingId: row.reading_id, creditsLeft: Number(row.credits_left) };
}

/** Every reading bought on this order, newest first. This is the journal view. */
export async function listReadings(
  orderId: string,
): Promise<{ id: string; payload: unknown; createdAt: string }[]> {
  if (!isUuid(orderId)) return [];
  await ensureSchema();
  const rows = await sql()`
    select id, payload, created_at
      from readings
     where order_id = ${orderId}
     order by created_at desc`;
  return rows.map((r) => {
    const row = r as { id: string; payload: unknown; created_at: unknown };
    return { id: row.id, payload: row.payload, createdAt: String(row.created_at) };
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}
