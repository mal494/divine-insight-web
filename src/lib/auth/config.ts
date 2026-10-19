/**
 * Pure Better Auth option pieces, kept apart from the instance so they can be
 * unit-tested without a database.
 */

export const MAGIC_LINK_EXPIRES_IN_SECONDS = 60 * 15;

/** Hosts Better Auth will accept as its base URL (and as trusted origins). */
export function authAllowedHosts(env: Record<string, string | undefined> = process.env): string[] {
  const hosts = [
    "localhost:*",
    "127.0.0.1:*",
    // Vercel production alias and per-deployment / per-branch preview hosts,
    // scoped to this project (never a bare *.vercel.app).
    "divine-insight-web.vercel.app",
    "divine-insight-web-*.vercel.app",
  ];
  for (const raw of [env.BETTER_AUTH_URL, env.VERCEL_URL, env.VERCEL_BRANCH_URL, env.VERCEL_PROJECT_PRODUCTION_URL]) {
    const host = hostOf(raw);
    if (host && !hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

function hostOf(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).host;
  } catch {
    return null;
  }
}

/** Only same-site relative paths may be used as a post-sign-in destination. */
export function safeCallbackPath(value: unknown): string {
  if (typeof value !== "string") return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  return value;
}

/**
 * Rewrites Better Auth's GET verify link to our /auth/confirm interstitial,
 * so link scanners that prefetch the email URL can't burn the one-time token.
 */
export function toConfirmUrl(verifyUrl: string): string {
  const u = new URL(verifyUrl);
  const confirm = new URL("/auth/confirm", u.origin);
  confirm.searchParams.set("token", u.searchParams.get("token") ?? "");
  confirm.searchParams.set("callbackURL", safeCallbackPath(u.searchParams.get("callbackURL")));
  return confirm.toString();
}
