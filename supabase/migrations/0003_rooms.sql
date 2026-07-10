-- Real cross-device Team/Survival rooms. Run once in the Supabase SQL editor.
-- Room roster/status/clouds are persisted here (change a few times a minute); live per-frame
-- player position is intentionally NOT stored - it travels over an ephemeral Realtime Broadcast
-- channel per room instead, to stay well within the realtime message budget.

create table if not exists rooms (
  code text primary key,
  mode text not null,
  status text not null,
  host_name text not null,
  max_players int not null,
  state jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table rooms enable row level security;
create policy "anon full access" on rooms for all to anon using (true) with check (true);

alter publication supabase_realtime add table rooms;
