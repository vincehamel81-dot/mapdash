-- Tracks which room (if any) a player is currently in, so friends can see a "Join" option in chat.
alter table online_players add column if not exists room_code text;
