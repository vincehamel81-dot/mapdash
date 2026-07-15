-- Auto-wipes rooms nobody is actually driving in anymore. Every mode-config effect (cloud ticks,
-- NPC ticks, round resolution) is HOST-CLIENT-driven, not server-driven - if the host's tab
-- crashes or closes without leaveRoom running, nothing ever marks that room 'finished' or deletes
-- it, and it just sits there forever showing as "In-game" in the join list. updated_at is a
-- reliable staleness signal regardless of status: a genuinely active Survival room gets it touched
-- every ~2s by the cloud tick alone, so 30 minutes of silence means whoever was running it is gone,
-- not mid-round.
--
-- Requires the pg_cron extension. On most Supabase projects this needs enabling once via the
-- Dashboard (Database -> Extensions -> pg_cron) before this migration will apply cleanly - if the
-- `create extension` line below errors with a permissions issue, enable it there first and re-run
-- just this file.
create extension if not exists pg_cron with schema extensions;

select cron.schedule(
  'cleanup-stale-rooms',
  '*/10 * * * *', -- every 10 minutes
  $$ delete from rooms where updated_at < now() - interval '30 minutes' $$
);
