-- MapDash identity + chat foundation schema.
-- Run this once in the Supabase project's SQL editor (Dashboard -> SQL Editor -> New query).
-- No accounts/passwords by design (see project plan) - RLS is enabled but permissive, matching
-- the explicitly-accepted trust model rather than restricting access.

-- Presence + case-insensitive name uniqueness lock.
create table if not exists online_players (
  name_lower text primary key,
  display_name text not null,
  last_seen timestamptz not null default now()
);

-- One-directional "follow": follower can read followed's message feed. followed_display_name is
-- captured at add-time so a friend's name still shows correctly after they go offline.
create table if not exists friends (
  follower_name_lower text not null,
  followed_name_lower text not null,
  followed_display_name text not null,
  created_at timestamptz not null default now(),
  primary key (follower_name_lower, followed_name_lower)
);

-- One feed per sender; visibility is computed client-side from `friends`.
create table if not exists messages (
  id bigint generated always as identity primary key,
  sender_name_lower text not null,
  sender_display_name text not null,
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists messages_sender_created_idx on messages (sender_name_lower, created_at desc);

alter table online_players enable row level security;
alter table friends enable row level security;
alter table messages enable row level security;

create policy "anon full access" on online_players for all to anon using (true) with check (true);
create policy "anon full access" on friends for all to anon using (true) with check (true);
create policy "anon full access" on messages for all to anon using (true) with check (true);

-- Realtime needs each table explicitly added to the publication it streams changes through.
alter publication supabase_realtime add table online_players;
alter publication supabase_realtime add table friends;
alter publication supabase_realtime add table messages;
