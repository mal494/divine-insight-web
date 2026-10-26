import { createFileRoute } from "@tanstack/react-router";
import { getAuthPool } from "~/lib/auth/db";
import { handleSubscriptionWebhook } from "~/lib/billing/subscription-webhook";

export const Route = createFileRoute("/api/stripe-subscription-webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => handleSubscriptionWebhook(request, { db: getAuthPool }),
    },
  },
});
