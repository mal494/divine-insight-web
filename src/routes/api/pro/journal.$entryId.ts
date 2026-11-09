/** PATCH/DELETE /api/pro/journal/:entryId — Pro-only, own entries only. See src/lib/journal/handlers.ts. */
import { createFileRoute } from "@tanstack/react-router";
import { getAuthPool } from "~/lib/auth/db";
import { journalHandlers } from "~/lib/journal/handlers";
import { sqlJournalStore } from "~/lib/journal/store";

const handlers = journalHandlers(() => sqlJournalStore(getAuthPool));

export const Route = createFileRoute("/api/pro/journal/$entryId")({
  server: {
    handlers: {
      PATCH: ({ request, params }) => handlers.update({ request, params }),
      DELETE: ({ request, params }) => handlers.remove({ request, params }),
    },
  },
});
