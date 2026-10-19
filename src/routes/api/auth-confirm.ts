/** POST /api/auth-confirm — the button on /auth/confirm submits here. */
import { createFileRoute } from "@tanstack/react-router";
import { getAuth } from "~/lib/auth/auth";
import { handleConfirmPost } from "~/lib/auth/confirm";

export const Route = createFileRoute("/api/auth-confirm")({
  server: {
    handlers: {
      POST: ({ request }) =>
        handleConfirmPost(request, (token, headers) =>
          getAuth().api.magicLinkVerify({ query: { token }, headers, asResponse: true }),
        ),
    },
  },
});
