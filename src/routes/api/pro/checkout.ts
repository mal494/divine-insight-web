/** POST /api/pro/checkout — signed-in only; returns { url } for Stripe Checkout (subscription). */
import { createFileRoute } from "@tanstack/react-router";
import { getAuthPool } from "~/lib/auth/db";
import { createProCheckoutSession } from "~/lib/billing/pro";
import { json, originOf, userFromRequest } from "~/lib/billing/session-user";

export const Route = createFileRoute("/api/pro/checkout")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const user = await userFromRequest(request);
        if (!user) return json({ error: "sign_in_required" }, 401);
        try {
          const url = await createProCheckoutSession({ userId: user.id, email: user.email, origin: originOf(request), db: getAuthPool() });
          return json({ url });
        } catch (err) {
          console.error("pro checkout failed", err);
          return json({ error: "checkout_unavailable" }, 503);
        }
      },
    },
  },
});
