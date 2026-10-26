/**
 * Postgres pool used only by Better Auth (users, sessions, verification
 * tokens, rate limits) and the entitlements lookup.
 *
 * Neon + Vercel Fluid compute: node-postgres Pool on the *pooled* DATABASE_URL
 * (the `-pooler` host), a small pool, and attachDatabasePool so idle clients are
 * released before the function suspends. The app's own queries keep using the
 * HTTP `neon()` driver in src/db.ts; Better Auth can't use that one.
 *
 * Created lazily, so builds and tests never need a database.
 */
import { attachDatabasePool } from "@vercel/functions";
import { Pool } from "pg";

const g = globalThis as unknown as { __authPool?: Pool };

export function getAuthPool(): Pool {
  if (g.__authPool) return g.__authPool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set — auth needs the Neon pooled connection string.");
  }
  const pool = new Pool({ connectionString, max: 2, idleTimeoutMillis: 5000 });
  attachDatabasePool(pool);
  g.__authPool = pool;
  return pool;
}
