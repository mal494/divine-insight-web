/**
 * POST /api/checkout — opens a pending order and hands back the Stripe URL.
 *
 * The browser posts a SKU key, never a price. We create the order row, then
 * append its id to the configured Stripe payment link as `client_reference_id`,
 * which is the thread Stripe hands back to us in the webhook. That id is the
 * only thing tying a payment to an entitlement.
 *
 * Request:  { "sku": "extendedReading" }
 *           { "sku": "giftReading", "recipientEmail": "...", "senderName": "...", "note": "..." }
 * Response: { "orderId": "<uuid>", "url": "https://buy.stripe.com/...?client_reference_id=<uuid>" }
 *
 * Paused (PAID_CHECKOUT_ENABLED is not "true"): 503 { "error": "checkout_paused" },
 * checked before any order row is written.
 */
import { createFileRoute } from "@tanstack/react-router";
import { createOrder, isSku } from "~/lib/orders";
import { serverPaidCheckoutEnabled } from "~/lib/paid-checkout";
import { PAYMENT_LINKS } from "~/lib/payments";

export const Route = createFileRoute("/api/checkout")({
  server: {
    handlers: {
      POST: async ({ request }) => handleCheckout(request),
    },
  },
});

export async function handleCheckout(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const input = (body ?? {}) as Record<string, unknown>;
  const sku = input.sku;
  if (!isSku(sku)) return json({ error: "unknown_sku" }, 400);

  // Paid checkout is paused unless PAID_CHECKOUT_ENABLED=true (see
  // ~/lib/paid-checkout). Every SKU this route accepts is paid (tips never
  // come through here), so a paused site writes no pending order.
  if (!serverPaidCheckoutEnabled(env)) return json({ error: "checkout_paused" }, 503);

  const gift =
    sku === "giftReading"
      ? {
          recipientEmail: str(input.recipientEmail, 320),
          senderName: str(input.senderName, 120),
          note: str(input.note, 2000),
        }
      : undefined;

  try {
    const orderId = await createOrder(sku, gift);
    const url = new URL(PAYMENT_LINKS[sku]);
    url.searchParams.set("client_reference_id", orderId);
    return json({ orderId, url: url.toString() });
  } catch (err) {
    // A missing DATABASE_URL lands here. Fail loudly rather than falling
    // back to an ungated draw — the whole point of this route is that an
    // unverified purchase never unlocks anything.
    console.error("checkout failed", err);
    return json({ error: "checkout_unavailable" }, 503);
  }
}

function str(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed.slice(0, max);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
