// Postgres URL helpers for go-live.sh. Secrets never travel through argv:
// URLs come from environment variables or from a file path, and nothing here
// prints a password except the `libpq-env` command, whose stdout go-live.sh
// captures and evals (never echoed).
//
//   bun scripts/pg-url.mjs libpq-env               # reads $PG_URL
//   bun scripts/pg-url.mjs same-project-db <file>  # $PG_URL vs DATABASE_URL in a dotenv file
//   bun scripts/pg-url.mjs same-host               # $PG_URL host vs $EXPECTED_DB_HOST
//
// Exit codes: 0 ok, 1 mismatch / invalid, 2 usage.
import { readFileSync } from "node:fs";

const ALLOWED_PROTOCOLS = new Set(["postgres:", "postgresql:"]);
const ALLOWED_SSLMODES = new Set(["require", "verify-ca", "verify-full"]);
const ALLOWED_PARAMS = new Set(["sslmode", "channel_binding", "options", "connect_timeout"]);

/** Strict parse. Throws Error with a message that never contains the URL or password. */
export function parsePgUrl(raw) {
  if (typeof raw !== "string" || raw.trim() === "") throw new Error("database URL is empty");
  const text = raw.trim();
  if (/\s/.test(text)) throw new Error("database URL contains whitespace");
  let u;
  try {
    u = new URL(text);
  } catch {
    throw new Error("database URL is not a valid URL");
  }
  if (!ALLOWED_PROTOCOLS.has(u.protocol)) throw new Error("database URL must start with postgres:// or postgresql://");
  if (!u.hostname) throw new Error("database URL has no host");
  if (u.hostname.includes(",")) throw new Error("multi-host database URLs are not supported");
  if (!u.username) throw new Error("database URL has no user");
  if (!u.password) throw new Error("database URL has no password");
  const path = u.pathname.replace(/^\//, "");
  if (!path || path.includes("/")) throw new Error("database URL must name exactly one database");
  if (u.hash) throw new Error("database URL must not contain a #fragment");
  for (const key of u.searchParams.keys()) {
    if (!ALLOWED_PARAMS.has(key)) throw new Error(`unsupported database URL parameter: ${key}`);
  }
  const sslmode = u.searchParams.get("sslmode") ?? "require";
  if (!ALLOWED_SSLMODES.has(sslmode)) throw new Error(`sslmode must be one of ${[...ALLOWED_SSLMODES].join(", ")}`);
  const port = u.port || "5432";
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("bad port");
  let user, password, database;
  try {
    user = decodeURIComponent(u.username);
    password = decodeURIComponent(u.password);
    database = decodeURIComponent(path);
  } catch {
    throw new Error("database URL has bad percent-encoding");
  }
  for (const v of [user, password, database]) {
    if (/[\0\r\n]/.test(v)) throw new Error("database URL contains control characters");
  }
  return {
    host: u.hostname.toLowerCase(),
    port,
    user,
    password,
    database,
    sslmode,
    channelBinding: u.searchParams.get("channel_binding"),
  };
}

/**
 * Identity of the database a URL points at, ignoring the Neon pooler:
 * ep-foo-123-pooler.us-east-2.aws.neon.tech and ep-foo-123.us-east-2.aws.neon.tech
 * are the same compute endpoint.
 */
export function dbIdentity(parsed) {
  const [first, ...rest] = parsed.host.split(".");
  const host = [first.replace(/-pooler$/, ""), ...rest].join(".");
  return { host, port: parsed.port, database: parsed.database };
}

export function sameDatabase(a, b) {
  const x = dbIdentity(a);
  const y = dbIdentity(b);
  return x.host === y.host && x.port === y.port && x.database === y.database;
}

/** Minimal dotenv reader (what `vercel env pull` writes). Data only, never evaluated. */
export function readDotenv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

export function libpqExports(parsed) {
  const env = {
    PGHOST: parsed.host,
    PGPORT: parsed.port,
    PGUSER: parsed.user,
    PGPASSWORD: parsed.password,
    PGDATABASE: parsed.database,
    PGSSLMODE: parsed.sslmode,
  };
  if (parsed.channelBinding) env.PGCHANNELBINDING = parsed.channelBinding;
  return Object.entries(env)
    .map(([k, v]) => `export ${k}=${shq(v)}`)
    .join("\n");
}

function main(argv, env) {
  const [cmd, file] = argv;
  try {
    if (cmd === "libpq-env") {
      const parsed = parsePgUrl(env.PG_URL);
      if (dbIdentity(parsed).host !== parsed.host) {
        // DDL through PgBouncer (transaction pooling) is unsafe; use the direct URL.
        console.error("error: migrations need the UNPOOLED (direct) URL, not a -pooler host");
        return 1;
      }
      process.stdout.write(libpqExports(parsed) + "\n");
      return 0;
    }
    if (cmd === "same-project-db") {
      if (!file) return 2;
      const project = readDotenv(readFileSync(file, "utf8"));
      const ref = project.DATABASE_URL_UNPOOLED || project.DATABASE_URL;
      if (!ref) {
        console.error("the project's env has no readable DATABASE_URL (sensitive vars cannot be pulled)");
        return 1;
      }
      const ok = sameDatabase(parsePgUrl(env.PG_URL), parsePgUrl(ref));
      const p = dbIdentity(parsePgUrl(ref));
      const q = dbIdentity(parsePgUrl(env.PG_URL));
      console.error(`project DB: ${p.host}/${p.database}; migration target: ${q.host}/${q.database}`);
      return ok ? 0 : 1;
    }
    if (cmd === "same-host") {
      const expected = String(env.EXPECTED_DB_HOST || "").toLowerCase().replace(/-pooler(?=\.)/, "");
      if (!expected) return 2;
      const q = dbIdentity(parsePgUrl(env.PG_URL));
      console.error(`expected host: ${expected}; migration target: ${q.host}/${q.database}`);
      return q.host === expected ? 0 : 1;
    }
    return 2;
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : "invalid input"}`);
    return 1;
  }
}

if (import.meta.main ?? process.argv[1]?.endsWith("pg-url.mjs")) {
  process.exit(main(process.argv.slice(2), process.env));
}
