/** Resolve the signed-in user from a raw Request (API routes). */
export async function userFromRequest(request: Request): Promise<{ id: string; email: string } | null> {
  if (!process.env.DATABASE_URL || !process.env.BETTER_AUTH_SECRET) return null;
  try {
    const { getAuth } = await import("~/lib/auth/auth");
    const s = await getAuth().api.getSession({ headers: request.headers });
    return s ? { id: s.user.id, email: s.user.email } : null;
  } catch (err) {
    console.error("getSession failed", err);
    return null;
  }
}

export function originOf(request: Request): string {
  return (process.env.BETTER_AUTH_URL || new URL(request.url).origin).replace(/\/$/, "");
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
