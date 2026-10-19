-- Pro P2: Better Auth (magic link, DB rate limit) + entitlements.
-- Generated from better-auth 1.7.10 getMigrations() for core tables + magicLink
-- + rateLimit(storage: database). Apply with the UNPOOLED Neon URL:
--   psql "$DATABASE_URL_UNPOOLED" -f migrations/0001_pro_auth.sql
-- Must be applied before deploying the code (Better Auth validates its schema).
begin;

create table if not exists "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table if not exists "session" ("id" text not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);

-- Required by Better Auth even with magic link only; no passwords are stored.
create table if not exists "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null);

-- Magic link tokens (stored hashed, 15 min expiry).
create table if not exists "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table if not exists "rateLimit" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);

create index if not exists "session_userId_idx" on "session" ("userId");
create index if not exists "account_userId_idx" on "account" ("userId");
create index if not exists "verification_identifier_idx" on "verification" ("identifier");

create table if not exists entitlements (
  user_id text not null references "user" ("id") on delete cascade,
  plan text not null,
  status text not null,
  current_period_end timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, plan)
);

commit;
