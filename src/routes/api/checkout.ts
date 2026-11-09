/**
 * POST /api/checkout — opens a pending order and hands back the Stripe URL.
 *
 * The browser posts a SKU key, never a price. We create the order row, then
 * append its id to the configured Stripe payment link as `client_reference_id`,
 * which is the thread Stripe hands back to us in the webhook. That id is the
 * only thing tying a payment to an entitlement.
 *
 * The Stripe link is per-environment (~/lib/payment-links): preview/dev only
 * ever get TEST-mode links from env, and a missing link is a 503 before any
 * order row is written.
 *
 * The response also carries `accessToken`, the order's bearer secret for
 * /api/order/:id and /api/reading (~/lib/order-access). It is NOT added to the
 * Stripe URL; only the order id goes to Stripe.
 *
 * Request:  { "sku": "extendedReading" }
 *           { "sku": "giftReading", "recipientEmail": "...", "senderName": "...", "note": "..." }
 * Response: { "orderId": "<uuid>", "accessToken": "<43 chars>",
 *             "url": "https://buy.stripe.com/...?client_reference_id=<uuid>" }
 */
import { createFileRoute } from "@tanstack/react-router";
import { newOrderAccessToken } from "~/lib/order-access";
import { createOrder, isSku } from "~/lib/orders";
import {
  PaymentLinkConfigError,
  resolvePaymentLink,
} from "~/lib/payment-links";

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

  const gift =
    sku === "giftReading"
      ? {
          recipientEmail: str(input.recipientEmail, 320),
          senderName: str(input.senderName, 120),
          note: str(input.note, 2000),
        }
      : undefined;

  let link: string;
  try {
    link = resolvePaymentLink(sku, env);
  } catch (err) {
    if (!(err instanceof PaymentLinkConfigError)) throw err;
    // Misconfiguration, not a buyer error: say so loudly in the logs and
    // never fall back to a live link outside production.
    console.error("checkout misconfigured:", err.message);
    return json({ error: "checkout_unavailable" }, 503);
  }

  try {
    const access = newOrderAccessToken();
    const orderId = await createOrder(sku, gift, {
      accessTokenHash: access.hash,
    });
    const url = new URL(link);
    url.searchParams.set("client_reference_id", orderId);
    return json({ orderId, accessToken: access.token, url: url.toString() });
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
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
