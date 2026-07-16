-- Cross-device player preferences, starting with the picked start point - previously localStorage
-- only, which meant it never followed a player between devices/browsers (e.g. desktop testing,
-- then picking it up on mobile) and just looked like it kept forgetting the choice. name_lower PK
-- matches every other player-identity table in this schema.
create table if not exists player_prefs (
  name_lower text primary key,
  display_name text not null,
  spawn_lat double precision,
  spawn_lng double precision,
  updated_at timestamptz not null default now()
);

alter table player_prefs enable row level security;
create policy "anon full access" on player_prefs for all to anon using (true) with check (true);
