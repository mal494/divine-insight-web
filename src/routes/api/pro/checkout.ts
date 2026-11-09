/** POST /api/pro/checkout — signed-in only; returns { url } for Stripe Checkout (subscription). 409 if already Pro. */
import { createFileRoute } from "@tanstack/react-router";
import { handleProCheckout } from "~/lib/billing/checkout-route";

export const Route = createFileRoute("/api/pro/checkout")({
  server: {
    handlers: {
      POST: async ({ request }) => handleProCheckout(request),
    },
  },
});
