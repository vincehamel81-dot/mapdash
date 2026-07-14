-- Cross-game Survival leaderboard. Run once in the Supabase SQL editor.
-- name_lower/display_name split matches every other player-identity table in this schema
-- (online_players, friends, messages) - a single case-sensitive "playerName" column would let
-- "Vince" and "vince" accumulate as two separate leaderboard rows for the same person.
-- score is a running total, incremented (not overwritten) at the end of each Survival round by
-- that round's -100..+100 result (see computeSurvivalScores in App.jsx) - NPCs never get a row
-- here, only real players.

create table if not exists scores (
  name_lower text primary key,
  display_name text not null,
  score integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table scores enable row level security;
create policy "anon full access" on scores for all to anon using (true) with check (true);
