export class SessionLookupError extends Error {
  constructor(cause: unknown) {
    super("session lookup failed");
    this.name = "SessionLookupError";
    (this as { cause?: unknown }).cause = cause;
  }
}

type GetSession = (headers: Headers) => Promise<{ user: { id: string; email: string } } | null>;

async function defaultGetSession(headers: Headers) {
  const { getAuth } = await import("~/lib/auth/auth");
  return getAuth().api.getSession({ headers });
}

/**
 * Resolve the signed-in user from a raw Request (API routes).
 *
 * Returns null only when there is genuinely no session (or auth isn't
 * configured). A DB/auth outage THROWS SessionLookupError so callers answer
 * 503, not a misleading 401 "sign in".
 */
export async function userFromRequest(
  request: Request,
  getSession: GetSession = defaultGetSession,
): Promise<{ id: string; email: string } | null> {
  if (!process.env.DATABASE_URL || !process.env.BETTER_AUTH_SECRET) return null;
  let s: Awaited<ReturnType<GetSession>>;
  try {
    s = await getSession(request.headers);
  } catch (err) {
    console.error("getSession failed", err);
    throw new SessionLookupError(err);
  }
  return s ? { id: s.user.id, email: s.user.email } : null;
}

export function originOf(request: Request): string {
  return (process.env.BETTER_AUTH_URL || new URL(request.url).origin).replace(/\/$/, "");
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
