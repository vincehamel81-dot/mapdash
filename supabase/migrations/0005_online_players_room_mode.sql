-- Lets ChatPanel show which game mode a friend is currently playing, not just that they're in a room.
alter table online_players add column if not exists room_mode text;
