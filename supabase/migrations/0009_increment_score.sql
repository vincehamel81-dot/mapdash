-- Atomic score increment. A naive client-side "read score, add, write back" has the same
-- lost-update race already found and fixed once in this project (two concurrent Survival hosts'
-- cloud writes clobbering each other) - this does the add-and-upsert as a single SQL statement via
-- Postgres's own ON CONFLICT DO UPDATE, so it's safe even if multiple rounds finish around the
-- same time for the same player (e.g. two different rooms).
create or replace function increment_score(p_name_lower text, p_display_name text, p_delta integer)
returns void as $$
  insert into scores (name_lower, display_name, score, updated_at)
  values (p_name_lower, p_display_name, p_delta, now())
  on conflict (name_lower) do update
    set score = scores.score + excluded.score,
        display_name = excluded.display_name,
        updated_at = now();
$$ language sql;

-- No auth in this app (see schema.sql) - anon needs explicit execute rights, same trust model as
-- every table's "anon full access" RLS policy.
grant execute on function increment_score(text, text, integer) to anon;
