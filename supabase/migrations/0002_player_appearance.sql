-- Adds persisted color + avatar choice to online_players, so returning under the same name
-- restores your look. Run once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).
-- Nullable: a player who hasn't picked yet (or a row that existed before this migration) simply
-- falls back to the client's defaults - see the load effect in src/App.jsx.

alter table online_players add column if not exists color text;
alter table online_players add column if not exists avatar_id text;
