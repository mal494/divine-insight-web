/** GET /api/pro/status — the signed-in user's real Pro entitlement (hasPro). See src/lib/pro/status.ts. */
import { createFileRoute } from "@tanstack/react-router";
import { handleProStatus } from "~/lib/pro/status";

export const Route = createFileRoute("/api/pro/status")({
  server: {
    handlers: {
      GET: async ({ request }) => handleProStatus(request),
    },
  },
});
