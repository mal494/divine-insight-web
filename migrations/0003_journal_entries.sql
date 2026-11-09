-- Pro Journal: user-scoped entries. NOT applied automatically. Apply after 0001/0002:
--   psql "$DATABASE_URL_UNPOOLED" -f migrations/0003_journal_entries.sql
-- Every query in src/lib/journal/store.ts filters by user_id, so a user can
-- only ever read or change their own rows.
begin;

create table if not exists journal_entries (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references "user" ("id") on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  spread text check (spread is null or char_length(spread) <= 40),
  note text not null default '' check (char_length(note) <= 4000),
  reading jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists journal_entries_user_created_idx
  on journal_entries (user_id, created_at desc);

commit;
