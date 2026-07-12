-- Lets ChatPanel show green (actively playing) vs yellow (in a room, not started yet) instead of
-- just a flat "in a game" dot.
alter table online_players add column if not exists room_status text;
