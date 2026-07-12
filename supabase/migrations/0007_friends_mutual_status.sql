-- Friendship becomes a request/accept flow instead of a one-directional auto-follow, and chat
-- becomes one merged feed of messages from yourself + mutually-accepted friends instead of
-- separate per-person "walls". Existing rows default to 'accepted' so pre-existing follows keep
-- working rather than silently breaking chat for anyone already using it.
alter table friends add column if not exists status text not null default 'accepted';
