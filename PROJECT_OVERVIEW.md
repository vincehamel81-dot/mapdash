# MapDashRun — Project Overview

A browser-based street-driving game around Québec City. A car follows *real* street geometry
(Ville de Québec's own official open-data road-centerline dataset, not a grid or an abstraction)
while dodging/finding/racing other players in real time across devices. Originally named "MapRun", renamed to
"MapDashRun" after a name collision with Apple's "MapRun". The project folder on disk is still
physically `c:\sites\maprun` (VS Code holds it locked, hasn't been renamed).

- **Live**: https://mapdashrun.netlify.app
- **Repo**: https://github.com/vincehamel81-dot/mapdash (private)
- **Auto-deploy**: Netlify builds and deploys automatically on every push to `master`
  (`netlify.toml`: `npm run build` → publish `dist/`). There is no staging environment or CI test
  gate — a push to `master` goes live immediately.

## Confirmed design decisions (don't re-litigate without a real reason)

- Core loop is survival/avoidance — "a bit like Pac-Man" refers to the *feel* of dodging hazards,
  not to Pac-Man's grid movement or pellet-collecting.
- Desktop/keyboard simulation only. No real GPS/outdoor-walking mode.
- **No auth/SSO in the traditional sense — a player's typed display name *is* their identity.**
  There's no email, password, or token anywhere in the system. The honor system is an explicit,
  accepted design choice: nothing stops one person from typing a name someone else is already
  using elsewhere (name uniqueness is only enforced while that name is *currently claimed* — see
  below). This was a deliberate simplification, not an oversight.

## Player identity ("the SSO")

`NameGate.jsx` gates the whole app: before anything else renders, the player types a display name.
That name is:
1. Checked against `online_players` for case-insensitive uniqueness (a name already claimed by
   someone with a recent heartbeat can't be reused until it goes stale).
2. Upserted into `online_players` as that player's presence row.
3. Kept alive by a heartbeat (`supabase.from('online_players').update({ last_seen })`) every 20s
   for as long as the tab stays open.
4. Removed via a `beforeunload` handler on tab close (not fully reliable — see Known Bugs).
5. Stored in `sessionStorage` so a page refresh doesn't force re-entering it.

The name can be changed later via a pencil-icon rename flow (cascades across `online_players`,
`friends`, and `messages`), but is **blocked while inside a room** — room state has scattered
name references that a live rename would desync.

There is no password, no recovery, no "forgot my name" flow. If someone else is actively using
your name, you cannot claim it until their session goes stale (heartbeat older than the timeout).

## Stack

- **Frontend**: React 18 + Vite 5, no router (single-page, mode/room state entirely in React
  state). MapLibre GL JS (raster tiles) for the map — a from-scratch, non-Leaflet integration.
- **Backend**: Supabase (hosted Postgres + Realtime), accessed directly from the browser via the
  anon key (`@supabase/supabase-js`). No custom backend server, no API layer, no serverless
  functions — the client talks to Postgres directly, gated by permissive RLS policies (`for all to
  anon using (true) with check (true)` on every table — trust-based, matching the no-auth design).
- **Realtime transport**: two different mechanisms depending on how "live" the data needs to be:
  - **Postgres tables + `postgres_changes` subscriptions** for anything that should persist and
    doesn't change many times a second: room roster/status/clouds/items, friends, chat messages,
    presence.
  - **Supabase Realtime *Broadcast* channels** (ephemeral, never touches the database) for a
    player's own live position/heading/speed while driving, throttled to ~120ms per send to stay
    within the free-tier message budget. This is *not* stored anywhere — if everyone disconnects,
    live positions are gone; only room roster/state persists.
- **Icons**: `lucide-static` (ISC-licensed outline SVGs), recolored via `stroke="currentColor"`.
- **Hosting**: Netlify, auto-deploy from `master`, static build (no server-side rendering).
- **Env**: `.env.local` (gitignored) holds `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`. The app
  works locally without them too — `isSupabaseConfigured` gates every Supabase call, so chat/rooms
  just degrade to unavailable rather than crashing.

## Supabase schema (tables + migrations)

Base schema in `supabase/schema.sql`; incremental changes in `supabase/migrations/000N_*.sql`
(applied manually — paste into the Supabase SQL editor, there's no migration runner/CLI wired up).
As of this writing:

| Table | Purpose | Key columns |
|---|---|---|
| `online_players` | Presence + identity | `name_lower` (PK), `display_name`, `last_seen`, `color`, `avatar_id` (0002), `room_code`/`room_mode`/`room_status` (0004-0006, lets chat show what room/mode a friend is in) |
| `friends` | Friendship graph | `follower_name_lower`, `followed_name_lower`, `followed_display_name`, `status` (0007: `'pending'`/`'accepted'` — request/accept flow, not auto-follow) |
| `messages` | Chat feed (one shared timeline, not per-thread) | `sender_name_lower`, `sender_display_name`, `body`, `created_at`. No recipient column — visibility is computed client-side from the friends graph. Auto-pruned: each send also deletes that sender's messages older than 30 days. |
| `rooms` | Room roster/status/clouds/items (0003) | `code` (PK), `mode`, `status`, `host_name`, `max_players`, `state` (jsonb: players/clouds/items/roundStartedAt/itName/winners/createdAt), `updated_at` (bumped explicitly on every write — no DB trigger exists for this) |

No RLS restrictions beyond "must be a valid anon request" — anyone can read/write anyone else's
row. This is intentional given the no-auth trust model, not a gap to close.

## Game modes & rooms

Defined in `MODE_CONFIG` (`App.jsx`):

| Mode | Room-based | Host-gated start | Min/Max players | Round length |
|---|---|---|---|---|
| Single | No | — | 1 | untimed |
| Team | Yes | No (joining drops you straight in) | 2/10 | untimed |
| Survival | Yes | Yes | 2/10 | 10 min |
| Finder (Easy) | Yes | Yes | 2/10 | untimed (first to 10 wins) |
| Finder (Hard) | Yes | Yes | 2/10 | untimed |
| Tag | Yes | Yes | 2/10 | 10 min |

Max players raised from 4/6 to a uniform 10 across every room-based mode to make room for NPCs
(see below) — this applies even in an all-human room, not just NPC-filled ones. NPCs count toward
both `maxPlayers` and `minPlayers`, so a host can start a round solo-with-bots-for-company.

- **Host-gated** modes stay `'waiting'` until the host explicitly clicks Start; joining mid-lobby
  is fine, joining mid-*round* is blocked with an alert.
- **Survival**: 1000 HP, clouds deal tiered damage per second (white 30 / gray 100 / black 250,
  worst-tier-only, no stacking) while inside one, regen `+1/3s` while clear. Win = most HP left
  when the 10-minute timer ends.
- **Finder-Keeper** (Easy/Hard): find all 10 named collectible items scattered on the street graph.
  Easy shows item icons+labels on the map; Hard only shows a distance sidebar, no map markers.
  First to 10 wins.
- **Tag**: one random player starts as "It" (2x speed), eliminates others on contact
  (`TAG_CONTACT_RADIUS_METERS`), 10-minute timer.
- Turbo (hold Shift, or the on-screen button) doubles speed in every mode except Tag.
- **No auto-restart, no restart button at all** (by explicit design) — when a round ends, everyone
  still in the room sees a report (winner(s), total round time) and leaves at their own pace via an
  explicit "Leave room" button; wanting to play again means creating/joining a fresh room. A room
  with nobody in it drops to zero players and gets deleted (see Room lifecycle below); a finished
  room otherwise just sits `'finished'` and is hidden from the "Available rooms" browse list after
  60s of staleness (not deleted, just hidden — the row still exists).

### Room lifecycle / sync internals worth knowing before touching this code

`src/roomSync.js`'s `useRoomSync()` hook is the only thing that talks to the `rooms` table. It
returns `[rooms, updateRooms, roomsRef, deleteRoom]`:
- `updateRooms(nextRoomsArray)` **only ever upserts** — it diffs against `roomsRef.current` and
  writes whatever changed, but as of this round **never infers deletion from omission**. That used
  to be the behavior (anything present locally but missing from the array passed in got deleted
  from Supabase) and it was found, via a live 2-client race test, to be able to delete a room
  outright if one client's local view was even slightly stale. Don't reintroduce that pattern.
- `deleteRoom(code)` is the *only* way a room gets removed — explicit, one code at a time. Called
  by `closeRoom` and by `leaveRoom` when the last player leaves.
- `roomsRef` is kept **synchronously** fresh (`roomsRef.current = nextRooms` happens inside
  `updateRooms` itself, not just via the top-of-render assignment) specifically so that
  `App.jsx`'s room-mutating callbacks (`createRoom`/`joinRoom`/`leaveRoom`/`closeRoom`/`updateRoom`)
  can read the *latest* room list even when called from outside React's normal render cycle (e.g.
  the animation-frame movement loop). All five of those callbacks read from `roomsRef.current`,
  never from the closed-over `rooms` React state — this was a real, confirmed bug (see Known Bugs).

## Navigation system

The car moves along a **graph built from real street polylines**
(`public/data/QBC/segments.json`, filtered to `city === 'Québec'` and within `CONFIG.bbox`), not a
grid and not free-roam. `mapUtils.js`'s `buildGraph()` does the heavy lifting: splits mid-polyline
crossings that the source data didn't node, snaps dangling endpoints to nearby polylines within
~15m (real T-intersections the data doesn't explicitly connect), connects near-coincident interior
vertices that neither of those two passes catches (two streets each place a vertex a few meters
from the other's line without truly crossing — a very common shape in independently-digitized
data), merges near-duplicate nodes, collapses any 2-degree node whose two edges share the same
street name into one longer edge (reduces needless fragmentation — never removes a real decision
point), drops degenerate near-zero-length edges, and dedupes consecutive-duplicate points in every
polyline (all of these were real bugs found via live testing, not preemptive hardening — see Known
Bugs).

**Source data**: `public/data/QBC/segments.json` is generated by `npm run sync:street-data`
(`scripts/syncStreetData.mjs`) from Ville de Québec's official, actively-maintained **"Voies
publiques"** open dataset (Données Québec, ~28.7k road-centerline features citywide, filtered here
to physically-driveable categories only — excludes bike paths, sidewalks, parking lots, stairs).
Replaced an older, much smaller multi-municipality extract after live testing repeatedly found real
streets (a roundabout, several grid-street gaps) visible on the base map tiles with no graph edge
at all — confirmed as a genuine data-completeness gap, not a graph-algorithm bug, by cross-
referencing against this dataset directly.

`npm run assign:neighborhoods` (`scripts/assignNeighborhoods.mjs`) restores arrondissement/quartier
afterward via point-in-polygon (own small ray-casting + WKT parser, no new dependencies) against
`data-sources/district_delimiters.json` (the 6 Québec arrondissements, clean GeoJSON) and
`data-sources/quartiers-vdq.csv` (the 35 official Québec quartiers, WKT) — both reused as-is from a
sibling project (`C:\sites\gumballquiz\tools\fetchSegments.js`) that had already solved this exact
join against the same official sources. ~99.8% of segments matched on first run. Run this right
after `sync:street-data` any time the street data is refreshed.

At every intersection, `chooseNextSegment()` scores every real candidate edge by how close its
local departure heading is to either (a) your current heading, filtered by left/right preference
if you've signaled one (**rotating-map mode**), or (b) a fixed absolute compass target
(**north-up mode**) — see below. There is no "off-road" driving; you are always on some edge of
the graph, and turning only happens where a real street actually joins.

### Two genuinely different navigation modes (a checkbox toggle, "North-up fixed map")

- **Rotating map (default, "Android Auto style")**: the map rotates so your car always visually
  points "up"; the car marker itself never rotates (`rotationAlignment: 'viewport'`). W = go in
  whichever direction the car is currently facing (i.e. continue along the road). A/D lean the
  *turn preference* for the next intersection (relative: left/right of current heading). S is an
  instant 180° facing-flip (tap, not held) — no separate reverse gear/speed tier.
- **North-up ("Pac-Man style", by explicit design request)**: the map bearing is pinned to 0
  (true north always up) via `maxBounds`-independent `map.jumpTo({bearing:0})`, and the car sprite
  **never rotates at all** — it stays fixed pointing up regardless of real travel direction. W/A/S/D
  are each a fixed **absolute compass direction** (north/west/south/east), not relative to current
  facing, and S is a *held* control here (not the tap-flip of the rotating mode). At each
  intersection, `chooseNextSegment` is given an absolute target angle instead of a relative
  preference and picks whichever real street points closest to it. **Known, expected limitation**:
  real Québec streets rarely run cleanly N/S/E/W, so on a street that doesn't have an option close
  to your pressed direction, it falls back to whichever of that street's two directions is
  numerically closer — true grid-perfect response isn't achievable on non-grid geometry, and it
  self-corrects once a better-matching street becomes available at the next intersection.

### Turn-signal mechanism (applies to rotating mode)

Tapping A/D (or Arrow Left/Right) sets a *pending* turn (`pendingTurnRef`), shown as a small
blinking ◀/▶ next to the car (and broadcast to other players, visible on their dot too — useful in
Tag). It's consumed at the very next intersection reached, or auto-clears after 1.2s. **This had a
real, serious bug**: the keydown handler had no repeat-guard, so simply *holding* A/D for normal
continuous steering kept re-arming the clear timer on every OS key-repeat tick — a signal meant for
one intersection could fire at a much later one instead. Fixed with `e.repeat` detection; see
Known Bugs for why this mattered so much.

### The open, unresolved navigation problem (read this before doing more nav work)

Despite several rounds of fixing real bugs in the graph-building and turn-selection code (all
verified against the live ~21k-segment dataset, not guessed), navigation remains the #1 complaint.
**The latest, and possibly most important, insight from testing**: the *base map tiles* show real
Québec City geography exactly as it is — parking lots, plazas, pedestrian areas, and anything else
that looks like open drivable space but *isn't* a real street in the source data. A player has no
visual way to tell "this open area I can see is actually drivable" from "this looks the same but
there's no real street there, and I will never be able to turn into it." This is a strong candidate
for **the actual root cause of "navigation feels impossible/unfair"**, independent of whether the
underlying graph/turn-logic bugs are all fixed: even a mathematically perfect navigation system
will feel broken if the player can *see* a path forward that the graph doesn't actually contain.

**Proposed direction (not yet built)**: make the drivable street network visually unambiguous —
either highlight every real graph edge with a clear, high-contrast overlay (so "the colored line is
where you can go, everything else is not"), or the inverse (gray out/mute everything that isn't a
real drivable street, similar to how Pac-Man's maze walls are unambiguous). Whichever direction is
chosen, the goal stated directly by the person driving this project: *"if people manually see
streets they can't go, they will opt-out right away... something very easy to see on where it's
possible to go and where we can't."* This is flagged as high priority for the next navigation pass,
likely worth a visual/UX-focused investigation (screenshot a spot with a "phantom" non-drivable
area, cross-reference against the actual graph edges) rather than more algorithm tuning.

## Item placement (Finder-Keeper)

`pickRandomStreetPoint(graph)` (`mapUtils.js`) picks a uniformly random point along a real graph
edge — items can only ever land on an actual street, by construction (this was previously biased
toward one player's spawn point, reverted since a room's players start at different locations and
that biasing was unfair — see git history / memory for the back-and-forth on this). The 10 items
are defined in `src/finderItems.js`, each with its own standalone SVG in `src/finderIcons/`
(`grand-nacho.svg`, `nacho.svg`, `simon.svg`, `flora.svg`, `tuffy.svg`, `jasper.svg`,
`daffodil.svg`, `tyler.svg`, `bun-bun.svg`, `grenouche.svg`) — placeholder lucide icons for now;
swapping in real plush-toy artwork later is a one-file-per-item replacement, nothing else needs to
change. Each item shows its name as a label above its map icon (Easy mode) and next to its distance
in the sidebar tracker (both modes).

## In-map UI options (sidebar checkboxes/selectors while driving)

- **Street names** — toggles between labeled/unlabeled basemap tile variants (swaps the whole
  tile URL set, not a vector label layer).
- **Show route line** — toggles visibility of the orange line tracing your current segment's
  polyline (`map.setLayoutProperty('route', 'visibility', ...)`), default **off**.
- **North-up fixed map** — see Navigation above.
- **Map style** — Voyager (default CARTO), Google-like (CARTO light variant), Satellite (Esri
  World Imagery aerial photos — tilts the camera to ~60° while driving for a first-person feel,
  since there's no real 3D building data to extrude, just a flat photo tilted).
- **Turbo** (button) — hold Shift or click; doubles speed, unlimited use, disabled in Tag.
- **Add cloud** (button) — manually spawns one cloud near your own position (cooldown-gated).

## In-map controls / features

- **Movement**: WASD or arrow keys, semantics depend on rotating vs. north-up mode (see
  Navigation). `b`/`v` also zoom out/in.
- **Zoom**: on-screen +/− buttons, mouse scroll wheel (fixed this round — the driving loop's own
  per-frame `map.jumpTo()` was silently cancelling MapLibre's own scroll-zoom easing animation;
  now skipped while a zoom gesture is in progress), and `b`/`v` keys. Camera is hard-bounded to
  `CONFIG.bbox` via MapLibre `maxBounds` — this, not the bbox-based street-data filtering, is what
  actually stops you from panning/zooming out far enough to see Lévis/Île d'Orléans.
- **Speed readout**: bottom-left pill, doubled from the street's raw `speedKmh` value (a "50 km/h"
  street plays at 100 normal / 200 under Turbo).
- **Wind**: refreshes every 20s to a random direction + 20-80 km/h speed; drives cloud drift
  direction/speed.
- **Clouds**: procedurally generated organic blob shapes (Chaikin corner-cutting over a handful of
  irregular "lobe" points — deliberately not a circle or a spiky polygon), three visual/damage
  tiers (white/gray/black, only meaningfully damaging in Survival), spawn-avoid-player logic
  (checks the *candidate's radius* + 50m margin against every player, not just a flat distance from
  the center — a real bug fix, big clouds could otherwise spawn on top of you and instant-kill),
  applies in every mode now, not just Survival.
- **Compass widget**: small rotating needle (top-left, next to the wind pill) showing true north
  relative to the current (possibly rotated) map view.
- **Turn-signal arrow**: see Navigation.
- **Active street banner**: bottom-center, shows current street name + arrondissement/quartier.

## Chat (`ChatPanel.jsx`)

Rebuilt this round from a "one public wall per person, followable" model into **one merged
chronological feed**: friendship is a request/accept flow (not auto-follow), and once mutual, both
people's messages fold into the same single timeline — you never select a person to view a
separate wall. A friend of a friend you're *not* yourself mutually connected to is invisible to
you, even inside a thread they're part of; visibility is purely "am I mutually accepted with this
message's sender."

- **Requests** section: incoming pending friend requests, Accept/Decline.
- **Friends** section: mutually-accepted friends, with a status dot + text label (green "In-game
  (Mode)" / yellow "Lobby" or "Online" / red "Offline"), a **Join** button if they're currently in
  a joinable room, and a remove ("x") button.
- **Online** section: everyone else currently online (deduplicated against Friends — no one appears
  in both lists), with `+ add` (send a request) or `requested` (pending, already sent).
- **Unread badge**: on the floating Chat toggle button, counts messages from others that arrived
  since chat was last opened (baseline resets to "now" each time you open it, so old history never
  dumps in as unread on a fresh page load).
- Presence-based "online" filtering treats anyone whose heartbeat (`last_seen`) is older than 90s
  as offline, regardless of what their `online_players` row otherwise says.

## Known bugs (recently found & fixed — good context for anyone touching these areas again)

All of the following were **confirmed via direct graph-data scripts or live 2+ browser Playwright
testing**, not guessed:

- **Zero-length "phantom" graph edges**: node-merging could produce edges whose both endpoints
  landed on the same merged node (from tiny duplicate-point source fragments), giving them an
  undefined heading `chooseNextSegment` could still pick — the car would get stuck unable to
  progress. Fixed by dropping any edge under 2m after merging.
- **Duplicate-consecutive-polyline-point bug**: polyline splitting (crossing detection, dangling-
  endpoint snapping) could introduce a duplicate point exactly at a cut location, making
  `getLocalHeadingAtDistance` compute a bogus exact-0° heading from a zero-length first leg —
  silently corrupting turn-choice scoring (not stuck, just *wrong*, much harder to notice than the
  zero-length-edge bug). Fixed with a dedup pass both at initial packaging and as a final cleanup
  after all splitting in `buildGraph`.
- **Turn-signal key-repeat bug**: no `e.repeat` guard on the A/D tap handler meant holding a key
  for normal steering kept re-arming the 3s pending-turn timer on every OS repeat tick — very
  likely the single biggest remaining contributor to "it turns somewhere I didn't ask for" before
  this fix. Fixed with `!e.repeat` + shortened window (1.2s).
- **Room-state staleness race**: `createRoom`/`joinRoom`/`leaveRoom`/`closeRoom`/`updateRoom` all
  closed over the `rooms` React state at whatever point each was last created — two rapid actions
  (two Finder items found in the same frame, two quick join/create clicks) could race and the
  second would silently overwrite the first using a stale snapshot. Root cause of "found item
  reverts a few seconds later" and likely "join/create twice, kicks everyone out". Fixed by reading
  from a synchronously-fresh ref instead.
- **Implicit delete-by-omission**: `updateRooms` used to infer "this room was removed" from it
  being absent in whatever array a client happened to write, which could delete a room outright
  (not just lose one update) if a client's local view was even slightly stale — confirmed by a live
  race test. Fixed with explicit-only deletion (`deleteRoom(code)`).
- **`CONFIG.bbox` never actually constrained the camera** — only filtered street data. Four rounds
  of shrinking the bbox coordinates never fixed "I can still see Lévis" because that was never the
  real lever; `maxBounds` on the MapLibre instance was.
- **Item marker labels clipped at the top viewport edge** by `.map-panel`'s `overflow:hidden` — now
  flips below the icon instead of above when too close to the top.
- **Sidebar item list pushed below the fold**: fixed sidebar height + no flex distribution meant
  the Finder item tracker (the most important part of that mode) needed scrolling past everything
  else to see. Fixed with `.item-tracker { flex: 1 }` inside a flex-column sidebar.
- **`mergeNearbyNodes`/`updateRoom` staleness pattern** generally: this codebase has hit the same
  "closed-over React state read from outside the normal render cycle" bug shape multiple times
  (rAF loops, keydown handlers) — the fix pattern each time was either a synchronously-updated ref,
  or `e.repeat` for key-repeat cases. Worth checking for the same shape before adding new features
  that mutate shared state from a non-React-triggered callback.

### Known bugs not yet root-caused

- **Mouse-wheel zoom / rapid double-click races on Create/Join room**: partially addressed (the
  staleness race fix above should help significantly), but genuine *cross-client* simultaneous
  writes (two different people clicking Join at the literal same instant) can still race at the
  database level — this needs either a server-side transactional RPC or optimistic-concurrency
  versioning to fully close, which hasn't been built.
- **The core "streets I see but can't drive on" visual-clarity problem** described above under
  Navigation — not yet addressed at all, flagged as likely the highest-leverage remaining nav fix.

## NPC/bot players (v1: ambient traffic)

Host can click **+ Add NPC** in the room roster (any room-based mode, any time the room exists —
not gated to instead of only before a round starts, since Team has no real lobby to gate on) to add
a bot up to the room's capacity, now **10 for every room-based mode** (Single stays 1). Each NPC
gets a random name (`src/npcNames.js`, ~300 entries, retried on collision with anyone already in the
room), random color/avatar, and is stored in `room.players` alongside real players with an
`isNpc: true` flag — the same roster, so it renders on the map exactly like another player once its
position starts broadcasting, no separate rendering path needed.

- **Movement**: real graph-based driving (`pickRandomNextSegment` in `mapUtils.js`) — picks a
  uniformly random real candidate at every intersection, no pathfinding/goal-seeking. A true dead
  end (rare) makes it bounce back the way it came instead of getting stuck.
- **Host-only simulation**: only the room host's client runs the movement tick (`NPC_TICK_MS =
  200`) for every NPC and broadcasts each one's position on the same ephemeral per-room Realtime
  Broadcast channel a real player's own position uses — never persisted, matching the existing
  live-position architecture exactly. If the host leaves and a new host is reassigned, NPCs
  respawn at a fresh random position under the new host's simulation (no continuity across a host
  handoff — an accepted v1 simplification).
- **Deliberately ambient-only (v1 scope decision)**: NPCs do not affect win conditions. They can
  never be picked as Tag's It (`resetPlayersForRound` filters them out), never count toward
  Survival's health-based win tally, and never pick up Finder-Keeper items (nothing runs pickup
  detection for them). They exist purely as visual traffic/company. Full mechanical participation
  (taggable, item-seeking, damageable) is explicitly deferred, not yet built.
- **Removal**: host can remove one via the "x" next to its name in the roster; also silently pruned
  from the host's local simulation state the moment it's no longer in `room.players`.

## Deferred / backlog features

- **Spectator mode**: watch a room without playing. A "Join" button (jump into a friend's open room
  from chat) shipped; spectating specifically was deferred.
- **3D building extrusion**: satellite/aerial imagery shipped (Esri World Imagery + a first-person
  camera tilt), but true 3D buildings need a vector-tile data source with building-height data that
  isn't currently available — likely not feasible on a free tier without real research.
- **Mobile responsiveness**: not addressed, desktop/keyboard-only by design so far.
- **Cross-client join/create race** (see Known Bugs above).

## Testability notes

- `?debugRoundMs=<ms>` query param overrides Survival/Tag's round duration for fast testing without
  waiting out real 5-10 minute rounds.
- No automated test suite exists — verification throughout this project's history has been direct
  Playwright browser automation (usually 2+ browser contexts to test multiplayer sync) plus, for
  navigation bugs specifically, standalone Node scripts that import `mapUtils.js` directly and run
  `buildGraph()`/`chooseNextSegment()` against the real `segments.json` data to reproduce a
  reported intersection exactly. That direct-script approach has a strong track record — it found
  every real navigation bug fixed so far — but the *convention* used in a one-off verification
  script must exactly match the real call site's (arrival-heading vs. candidate-departure-heading
  are NOT the same formula) or it will produce a false lead.
