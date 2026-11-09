/**
 * POST /api/reading — spends one credit and stores the drawn reading.
 *
 * Called once the cards are down. The server re-checks that the order is paid
 * and has a credit left, so the spend can never be faked into existence; the
 * reading itself is composed client-side from the Core deck, which is public
 * data, so there is nothing secret to protect in the payload.
 *
 * This is what makes the Reading Bundle a real product: three paid draws
 * tracked server-side, each one saved and re-readable later.
 *
 * Access: like GET /api/order/:id, the caller must send the order's access
 * token in `x-order-token` (pre-token orders are grandfathered). A missing or
 * wrong token gets the same 402 as an unknown or exhausted order.
 *
 * Request:  { "orderId": "<uuid>", "reading": { ...cards, question, summary } }
 * Response: { "readingId": "<uuid>", "creditsLeft": 2 }
 *           402 when the order is unpaid or exhausted.
 */
import { createFileRoute } from "@tanstack/react-router";
import {
  checkOrderAccess,
  isMissingSchemaError,
  orderTokenFrom,
  schemaNotMigratedResponse,
} from "~/lib/order-access";
import { saveReading } from "~/lib/orders";

/** Guard rail: a reading payload is small. Anything larger is not one. */
const MAX_PAYLOAD_BYTES = 64 * 1024;

export const Route = createFileRoute("/api/reading")({
  server: {
    handlers: {
      POST: async ({ request }) => handleReadingPost(request),
    },
  },
});

export async function handleReadingPost(request: Request): Promise<Response> {
  const raw = await request.text();
  if (raw.length > MAX_PAYLOAD_BYTES) {
    return json({ error: "payload_too_large" }, 413);
  }

  let body: { orderId?: unknown; reading?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const orderId = body.orderId;
  if (typeof orderId !== "string") return json({ error: "missing_order" }, 400);
  if (body.reading === undefined)
    return json({ error: "missing_reading" }, 400);

  try {
    const access = await checkOrderAccess(orderId, orderTokenFrom(request));
    if (access === "denied") return json({ error: "not_entitled" }, 402);
    const spent = await saveReading(orderId, body.reading);
    // Null means unpaid, unknown, or out of credits. One answer for all
    // three: an unpaid caller learns nothing about which it was.
    if (!spent) return json({ error: "not_entitled" }, 402);
    return json(spent);
  } catch (err) {
    if (isMissingSchemaError(err))
      return schemaNotMigratedResponse("POST /api/reading", err);
    console.error("saving reading failed", err);
    return json({ error: "unavailable" }, 503);
  }
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
