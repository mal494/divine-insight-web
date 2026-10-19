import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

export type SessionUser = { id: string; email: string };

/** Current signed-in user or null. Never throws (getSession throws if the DB is down). */
export const getSessionUser = createServerFn({ method: "GET" }).handler(
  async (): Promise<SessionUser | null> => {
    if (!process.env.DATABASE_URL || !process.env.BETTER_AUTH_SECRET) return null;
    try {
      const { getAuth } = await import("./auth");
      const session = await getAuth().api.getSession({ headers: getRequestHeaders() });
      return session ? { id: session.user.id, email: session.user.email } : null;
    } catch (err) {
      console.error("getSession failed", err);
      return null;
    }
  },
);
