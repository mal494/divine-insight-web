/** GET/POST /api/pro/journal — Pro-only, user-scoped Journal. See src/lib/journal/handlers.ts. */
import { createFileRoute } from "@tanstack/react-router";
import { getAuthPool } from "~/lib/auth/db";
import { journalHandlers } from "~/lib/journal/handlers";
import { sqlJournalStore } from "~/lib/journal/store";

const handlers = journalHandlers(() => sqlJournalStore(getAuthPool));

export const Route = createFileRoute("/api/pro/journal")({
  server: {
    handlers: {
      GET: ({ request }) => handlers.list({ request }),
      POST: ({ request }) => handlers.create({ request }),
    },
  },
});
