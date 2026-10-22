/** POST /api/pro/portal — signed-in only; returns { url } for the Stripe Customer Portal. */
import { createFileRoute } from "@tanstack/react-router";
import { getAuthPool } from "~/lib/auth/db";
import { createPortalSession } from "~/lib/billing/pro";
import { json, originOf, userFromRequest } from "~/lib/billing/session-user";

export const Route = createFileRoute("/api/pro/portal")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const user = await userFromRequest(request);
        if (!user) return json({ error: "sign_in_required" }, 401);
        try {
          const url = await createPortalSession({ userId: user.id, origin: originOf(request), db: getAuthPool() });
          return url ? json({ url }) : json({ error: "no_subscription" }, 404);
        } catch (err) {
          console.error("portal failed", err);
          return json({ error: "portal_unavailable" }, 503);
        }
      },
    },
  },
});
