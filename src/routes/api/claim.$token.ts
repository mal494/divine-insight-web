/**
 * /api/claim/$token — the recipient's side of a Gift Reading.
 *
 * GET  returns who it is from and whether it has been turned yet (plus the
 *      card itself once it has, so the link keeps working as a keepsake).
 * POST turns the card: burns the token, spends the order's credit, and stores
 *      the drawn reading.
 *
 * The token is the recipient's only credential and it is single-use, so this
 * route never requires an account and never exposes the order id.
 */
import { createFileRoute } from "@tanstack/react-router";
import { claimGift, getClaim } from "~/lib/gifts";

export const Route = createFileRoute("/api/claim/$token")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        try {
          const claim = await getClaim(params.token);
          if (!claim) return json({ error: "not_found" }, 404);
          return json(claim);
        } catch (err) {
          console.error("claim lookup failed", err);
          return json({ error: "unavailable" }, 503);
        }
      },

      POST: async ({ params, request }) => {
        let body: { reading?: unknown };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return json({ error: "invalid_json" }, 400);
        }
        if (body.reading === undefined) return json({ error: "missing_reading" }, 400);

        try {
          const result = await claimGift(params.token, body.reading);
          if (!result.ok) {
            return json({ error: result.reason }, result.reason === "not_found" ? 404 : 409);
          }
          return json({ ok: true });
        } catch (err) {
          console.error("claim failed", err);
          return json({ error: "unavailable" }, 503);
        }
      },
    },
  },
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
