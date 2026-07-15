-- Two fixes before real score data piles up on the old shape:
--
-- 1) Baseline/floor: everyone starts at 1000 points (not 0), and a running total can never drop
--    below 0 even after repeated losses - "you start at 1000 and min is 0, if you lose points
--    you're still at 0". The old increment_score() effectively started new players at 0 and let
--    the total go negative.
--
-- 2) game_type: Survival is getting company (Finder variants, Tag) - each needs its own score per
--    player rather than sharing one number, so the primary key becomes (name_lower, game_type).
--    Existing rows backfill to 'survival' via the column default, matching what they actually are.
alter table scores add column if not exists game_type text not null default 'survival';
alter table scores drop constraint if exists scores_pkey;
alter table scores add primary key (name_lower, game_type);
alter table scores alter column score set default 1000;

drop function if exists increment_score(text, text, integer);

create or replace function increment_score(p_name_lower text, p_display_name text, p_game_type text, p_delta integer)
returns void as $$
  insert into scores (name_lower, display_name, game_type, score, updated_at)
  values (p_name_lower, p_display_name, p_game_type, greatest(0, 1000 + p_delta), now())
  on conflict (name_lower, game_type) do update
    set score = greatest(0, scores.score + p_delta),
        display_name = excluded.display_name,
        updated_at = now();
$$ language sql;

grant execute on function increment_score(text, text, text, integer) to anon;
