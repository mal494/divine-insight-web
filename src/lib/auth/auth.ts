/**
 * Better Auth instance: email magic link only (no passwords), users and
 * sessions in Neon Postgres, hashed 15-minute tokens, DB-backed rate limit.
 *
 * Server-only. Reads BETTER_AUTH_SECRET, DATABASE_URL and BETTER_AUTH_URL from env.
 */
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { magicLink } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { authAllowedHosts, MAGIC_LINK_EXPIRES_IN_SECONDS, toConfirmUrl } from "./config";
import { getAuthPool } from "./db";
import { sendMagicLinkEmail } from "./email";

export function buildAuthOptions(
  database: BetterAuthOptions["database"],
  env: Record<string, string | undefined> = process.env,
) {
  return {
    secret: env.BETTER_AUTH_SECRET,
    baseURL: {
      allowedHosts: authAllowedHosts(env),
      protocol: env.NODE_ENV === "production" ? "https" : "http",
    },
    database,
    emailAndPassword: { enabled: false },
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    // In-memory limits are per instance on serverless; keep them in Postgres.
    rateLimit: { enabled: true, storage: "database" },
    plugins: [
      magicLink({
        expiresIn: MAGIC_LINK_EXPIRES_IN_SECONDS,
        storeToken: "hashed",
        sendMagicLink: async ({ email, url }) => {
          await sendMagicLinkEmail(email, toConfirmUrl(url));
        },
      }),
      tanstackStartCookies(), // must stay last
    ],
  } satisfies BetterAuthOptions;
}

function createAuth() {
  return betterAuth(buildAuthOptions(getAuthPool()));
}

let instance: ReturnType<typeof createAuth> | undefined;

/** Lazily created so importing this module never touches env or the DB. */
export function getAuth() {
  instance ??= createAuth();
  return instance;
}
