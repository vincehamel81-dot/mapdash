import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import MapView from './MapView'
import { CONFIG, THEMES } from './config'
import { version as APP_VERSION } from '../package.json'
import { AVATAR_ICONS, DEFAULT_AVATAR_ID, getAvatarSvg } from './avatarIcons'
import { FINDER_ITEMS, getFinderItemSvg } from './finderItems'
import { supabase, isSupabaseConfigured } from './supabaseClient'
import { useRoomSync, generateRoomCode } from './roomSync'
import {
  buildGraph,
  chooseNextSegment,
  findNearestSegment,
  pointToSegmentDistance,
  getSegmentHeading,
  getLocalHeadingAtDistance,
  getSegmentPosition,
  normalizeAngle,
  signedAngleBetween,
  toCompassBearing,
  resolveEdgeEntry,
  offsetLatLng,
  haversine,
  pickRandomStreetPoint,
  findRiskyIntersections,
  pickRandomNextSegment,
  pickStraightBiasedNextSegment,
  pickLeftBiasedNextSegment,
  pickOscillatingNextSegment,
  pickHomeAnchoredNextSegment
} from './mapUtils'
import { pickNpcName } from './npcNames'
import './App.css'

const CAR_COLORS = ['#4285F4', '#DB4437', '#F4B400', '#0F9D58', '#9C27B0', '#FF6D00', '#202124']
const CARDINAL_ANGLES = {
  N: 0,
  NE: 45,
  E: 90,
  SE: 135,
  S: 180,
  SW: 225,
  W: 270,
  NW: 315
}

// Cap how fast the map's bearing can rotate so a heading change at a turn eases in smoothly
// (Android Auto style) instead of snapping instantly to the new segment's direction.
const MAX_BEARING_DEG_PER_SEC = 220

// Survival's wind is 10x the base value, capped at a max - uncapped it could hit ~1400 km/h at
// the top of the base 40-140 range, which direct feedback called "epic" rather than useful. Used
// for both the actual drift-distance math and the matching on-screen label, so what's displayed
// always matches what's actually happening.
const SURVIVAL_WIND_MAX_KMH = 1000
function survivalWindSpeedKmh(baseSpeed) {
  return Math.min(baseSpeed * 10, SURVIVAL_WIND_MAX_KMH)
}
const CLOUD_MOVE_INTERVAL_MS = 7000
// Survival's movement tick runs 3x as often per direct feedback ("refresh rate x3") - clouds felt
// nearly stationary otherwise. Also doubles as the guaranteed-growth cadence: Survival's tick adds
// one extra cloud every call (see topUp's `guaranteed` param) - over a 10-minute round at ~2.3s
// per tick that's roughly +250-260 on top of the 200 seeded at start.
const SURVIVAL_CLOUD_MOVE_INTERVAL_MS = Math.round(CLOUD_MOVE_INTERVAL_MS / 3)
// Raised from the original 5/8 floor/ceiling - clouds now spread across the whole bbox instead of
// clustering near one player, so a higher count is needed to keep the field feeling populated.
const CLOUD_MIN_COUNT = 10
const CLOUD_MAX_COUNT = 20
// Survival specifically needs a much denser field to actually be a threat - 12 small clouds
// scattered over the whole bbox meant a player could drive for a full 10-minute round barely ever
// overlapping one, health sitting at 1000 the entire time. Doubled from 100 to 200 per direct
// feedback - with 50-player rooms, half the bots were still surviving a full round untouched.
// The ceiling is deliberately way above the floor now (600 vs 200) - the dedicated 2s spawn
// effect is expected to grow the real count toward ~500 over a round, and this cap exists only as
// a safety backstop (e.g. an extended debug round), not something a normal 10-minute round hits.
const CLOUD_MIN_COUNT_SURVIVAL = 200
const CLOUD_MAX_COUNT_SURVIVAL = 600
// Degrees of slack applied to CONFIG.bbox when deciding a drifting cloud has left the playable
// area (~3km) - generous enough that wind drift only prunes clouds that have genuinely blown well
// clear of the map, not ones still hovering near its edge.
const CLOUD_BBOX_MARGIN_DEG = 0.03

// Read once at module load - a `?debugRoundMs=` query param overrides Survival/Tag's round
// duration so verification doesn't require waiting out a real 5-10 minute round. Inert in normal
// play (no query param = no effect).
const DEBUG_ROUND_MS = (() => {
  if (typeof window === 'undefined') return null
  const raw = new URLSearchParams(window.location.search).get('debugRoundMs')
  const parsed = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
})()

// wideBbox: true opts a mode into CONFIG.bboxWide (the full synced street network, ~3x/~2x the
// tight bbox's lat/lng span) instead of CONFIG.bbox - Single/Team have no items or clouds to worry
// about spawning sensibly across a bigger area, so they get the whole city; modes with spawning
// logic (Survival's clouds, Finder's items) stay on the curated tight box for now.
export const MODE_CONFIG = {
  single: { label: 'Single', roomBased: false, hostGatedStart: false, minPlayers: 1, maxPlayers: 1, roundDurationMs: null, wideBbox: true },
  team: { label: 'Team', roomBased: true, hostGatedStart: false, minPlayers: 2, maxPlayers: 50, roundDurationMs: null, wideBbox: true },
  // fixedPlayerCount: every Survival round is auto-filled with NPCs at start to reach exactly
  // this many total (minPlayers 1 - a solo host can start, then gets 99 bots). maxPlayers must be
  // at least fixedPlayerCount so a full-human lobby isn't blocked from starting.
  survival: { label: 'Survival', roomBased: true, hostGatedStart: true, minPlayers: 1, maxPlayers: 100, fixedPlayerCount: 100, roundDurationMs: DEBUG_ROUND_MS ?? 10 * 60 * 1000 },
  'finder-easy': { label: 'Finder (Easy)', roomBased: true, hostGatedStart: true, minPlayers: 2, maxPlayers: 50, roundDurationMs: null },
  'finder-roaming': { label: 'Finder (Roaming)', roomBased: true, hostGatedStart: true, minPlayers: 2, maxPlayers: 50, roundDurationMs: null },
  'finder-hard': { label: 'Finder (Hard)', roomBased: true, hostGatedStart: true, minPlayers: 2, maxPlayers: 50, roundDurationMs: null },
  tag: { label: 'Tag', roomBased: true, hostGatedStart: true, minPlayers: 2, maxPlayers: 50, roundDurationMs: DEBUG_ROUND_MS ?? 10 * 60 * 1000 }
}

// Every Finder variant shares the same pickup mechanic/roster fields (found-item count, "first to
// 10" win); Easy and Roaming additionally both show item icons+labels on the map (Hard is
// distance-list only) - these two predicates are what every finder-specific check below branches
// on, instead of repeating the mode-name list at each call site.
function isFinderMode(mode) {
  return mode === 'finder-easy' || mode === 'finder-roaming' || mode === 'finder-hard'
}
function showsItemIcons(mode) {
  return mode === 'finder-easy' || mode === 'finder-roaming'
}

// Ambient NPC drivers (v1): real simulated movement on the street graph (see
// pickRandomNextSegment), but deliberately don't affect win conditions - can't be tagged/become
// It, can't find items, don't take damage. Host's client alone simulates + broadcasts every NPC's
// position, same ephemeral broadcast channel as a real player's own position (never persisted).
const NPC_TICK_MS = 200

// Roaming Finder items (Finder (Roaming) mode only): each of the 10 items has its own movement
// personality instead of sitting still. Same host-only-simulates-and-broadcasts model as NPCs -
// see the item tick effect below. Anchors (home point + radius) are resolved once per round from
// the real street graph/quartier data, not hardcoded coordinates.
const ITEM_TICK_MS = 200
const ITEM_BEHAVIORS = {
  'grand-nacho': { type: 'ambient' },
  daffodil: { type: 'ambient' },
  tyler: { type: 'ambient' },
  grenouche: { type: 'ambient' },
  // Oscillates the length of 1re Avenue, bouncing at its real ends.
  nacho: { type: 'oscillate', streetNamePrefix: '1re Avenue', speedMultiplier: 1 },
  // Fast, straight-line-biased, always "Turbo".
  tuffy: { type: 'straight', speedMultiplier: 2 },
  // Turns left ~75% of the time a real left exists - tends toward looping/circling.
  simon: { type: 'left-biased', leftProbability: 0.75, speedMultiplier: 1 },
  // Stays within the Sainte-Foy-Sillery-Cap-Rouge arrondissement, napping 15-30s at a time.
  flora: { type: 'home-anchor', anchorArrondissement: 'Sainte-Foy–Sillery–Cap-Rouge', radiusMeters: 1400, napMinMs: 15000, napMaxMs: 30000 },
  // Stays close to Rue des Meuniers, never straying far from it.
  jasper: { type: 'home-anchor', anchorStreetName: 'Rue des Meuniers', radiusMeters: 500 },
  // Hides for the whole round near one of the 4 corners of the playable area - never moves.
  'bun-bun': { type: 'hidden-corner' },
  // Turns randomly like a normal ambient NPC (falls through pickNextForBehavior's default case),
  // but its speed multiplier is re-rolled from speedTiers on a random cadence instead of staying
  // fixed - 0 genuinely means stopped dead (metersPerSecond becomes 0), no separate nap/freeze
  // logic needed for that.
  huskynouche: { type: 'variable-speed', speedTiers: [0, 0.4, 1, 2.5], speedChangeMinMs: 4000, speedChangeMaxMs: 10000 }
}

// Only 10 items spawn per Finder (Roaming/Easy/Hard) round even as the catalog grows past 10 -
// Fisher-Yates-ish partial shuffle, picks without replacement.
function pickRoundFinderItems(count) {
  const pool = [...FINDER_ITEMS]
  const picked = []
  while (picked.length < count && pool.length) {
    const i = Math.floor(Math.random() * pool.length)
    picked.push(pool.splice(i, 1)[0])
  }
  return picked
}

const CLOUD_DAMAGE_PER_SEC = { white: 30, gray: 100, black: 250 }
const FINDER_PICKUP_RADIUS_METERS = 15
const TAG_CONTACT_RADIUS_METERS = 8

// A finished room just sits there until whoever's in it leaves (no auto-restart - see the
// round-finish report panel) - one that's stayed 'finished' this long is almost certainly
// abandoned (host disconnected without anyone leaving), so hide it from the join list.
function isRoomStale(room) {
  return room.status === 'finished' && Date.now() - (room.updatedAt || 0) > 60000
}

function randomCloudTier() {
  const r = Math.random()
  return r < 1 / 3 ? 'white' : r < 2 / 3 ? 'gray' : 'black'
}

// Builds the per-player fields a fresh round needs for the given mode; called at both room
// creation and every restart so a re-run round always starts from a clean slate.
function resetPlayersForRound(players, mode) {
  let itName = null
  const next = players.map((p) => ({ ...p, eliminated: false }))
  if (mode === 'survival') {
    return { players: next.map((p) => ({ ...p, health: 1000 })), itName }
  }
  if (isFinderMode(mode)) {
    return { players: next.map((p) => ({ ...p, foundItems: [] })), itName }
  }
  if (mode === 'tag') {
    // NPCs are ambient-only (v1) - they can't chase or be caught, so picking one as It would
    // leave the round with no way to win. Only real players are eligible.
    const eligible = next.filter((p) => !p.isNpc)
    itName = eligible[Math.floor(Math.random() * eligible.length)]?.name ?? null
    return { players: next.map((p) => ({ ...p, isIt: p.name === itName })), itName }
  }
  return { players: next, itName }
}

// Resolves a roaming item's home-anchor personality (Flora/Jasper) to a real coordinate, once per
// round - by arrondissement (a whole neighborhood, for Flora) or by a specific street name (for
// Jasper). Falls back to any real point rather than crashing if the configured area/street isn't
// found in the current graph (e.g. after a future street-data resync renames something).
function resolveAnchorCoord(graph, behavior) {
  const edges = Array.from(graph.edges.values())
  const pickFrom = (candidates) => {
    const edge = candidates[Math.floor(Math.random() * candidates.length)]
    return edge.polyline[Math.floor(Math.random() * edge.polyline.length)]
  }
  if (behavior.anchorArrondissement) {
    const candidates = edges.filter((e) => e.arrondissement === behavior.anchorArrondissement)
    if (candidates.length) return pickFrom(candidates)
  }
  if (behavior.anchorStreetName) {
    const candidates = edges.filter((e) => e.name === behavior.anchorStreetName)
    if (candidates.length) return pickFrom(candidates)
  }
  return pickFrom(edges)
}

// Dispatches to whichever mapUtils picker matches this item's personality - the roaming item tick
// effect below stays the same for every item regardless of which one this returns.
function pickNextForBehavior(graph, nodeKey, currentEdge, behavior, sim) {
  switch (behavior.type) {
    case 'straight':
      return pickStraightBiasedNextSegment(graph, nodeKey, currentEdge)
    case 'left-biased':
      return pickLeftBiasedNextSegment(graph, nodeKey, currentEdge, behavior.leftProbability ?? 0.75)
    case 'oscillate':
      return pickOscillatingNextSegment(graph, nodeKey, currentEdge, behavior.streetNamePrefix)
    case 'home-anchor':
      return pickHomeAnchoredNextSegment(graph, nodeKey, currentEdge, sim.anchorCoord, behavior.radiusMeters)
    default:
      return pickRandomNextSegment(graph, nodeKey, currentEdge)
  }
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function carMarkerMarkup(avatarId, color, label, turnSignal) {
  const safeLabel = escapeHtml(label || '')
  // Every avatar (the default arrow included) recolors via currentColor, so this wrapper is the
  // only place that needs to know the chosen color - the SVG markup itself is never rewritten.
  // The marker never rotates with heading (rotationAlignment: 'viewport' at creation), so
  // "signaling left/right" is always simple screen-left/screen-right - no compass math needed.
  const signalHtml = turnSignal === 'left' || turnSignal === 'right'
    ? `<div class="car-marker-signal car-marker-signal-${turnSignal}">${turnSignal === 'left' ? '◀' : '▶'}</div>`
    : ''
  return `${safeLabel ? `<div class="car-marker-label">${safeLabel}</div>` : ''}<div class="car-marker-glyph" style="color:${color}">${getAvatarSvg(avatarId)}</div>${signalHtml}`
}

// "Radar" off-screen indicator: given a target's screen PIXEL position (which may be negative or
// exceed the container, i.e. off-screen) and the container's size, returns null if it's already
// on-screen (its own marker is visible, no indicator needed), or a clamped point on an inset
// rectangle around the screen center plus the angle to rotate an arrow glyph to point at it -
// classic "edge radar" technique from other games (Fortnite's compass, Katamari Damacy's cousin
// arrows, etc).
function computeEdgeIndicator(px, py, width, height, margin) {
  const onScreen = px >= 0 && px <= width && py >= 0 && py <= height
  if (onScreen) return null
  const cx = width / 2
  const cy = height / 2
  const dx = px - cx
  const dy = py - cy
  const angleRad = Math.atan2(dy, dx)
  const halfW = Math.max(1, width / 2 - margin)
  const halfH = Math.max(1, height / 2 - margin)
  const cosA = Math.cos(angleRad)
  const sinA = Math.sin(angleRad)
  const scaleX = Math.abs(cosA) > 1e-6 ? halfW / Math.abs(cosA) : Infinity
  const scaleY = Math.abs(sinA) > 1e-6 ? halfH / Math.abs(sinA) : Infinity
  const scale = Math.min(scaleX, scaleY)
  return {
    x: cx + cosA * scale,
    y: cy + sinA * scale,
    // +90 because the arrow glyph points "up" (north) at rotate(0) - atan2's 0deg is due east.
    angleDeg: (angleRad * 180) / Math.PI + 90
  }
}

function polylineToGeoJSON(polyline) {
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: (polyline || []).map(([lat, lng]) => [lng, lat]) }
  }
}

// Debug view: every real drivable edge in the graph, drawn directly over the base map tiles so
// "this open space looks drivable" vs "this is an actual street the game knows about" stops being
// a guessing game - see PROJECT_OVERVIEW.md's navigation section for why that ambiguity is
// suspected to be the biggest root cause of "navigation feels broken" complaints.
function graphEdgesToGeoJSON(graph) {
  const edges = graph ? Array.from(graph.edges.values()) : []
  return {
    type: 'FeatureCollection',
    features: edges.map((edge) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: edge.polyline.map(([lat, lng]) => [lng, lat]) },
      properties: { name: edge.name || '' }
    }))
  }
}

function riskyIntersectionsToGeoJSON(riskyIntersections) {
  return {
    type: 'FeatureCollection',
    features: (riskyIntersections || []).map((r) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r.coord[1], r.coord[0]] },
      properties: { streetName: r.streetName, divertsToName: r.divertsToName }
    }))
  }
}

// Deterministic per-cloud PRNG (mulberry32) seeded from the cloud's own id, so its blob shape
// stays stable across re-renders/drift instead of re-randomizing (and thus visibly flickering)
// every time cloud state updates.
function seededRandom(seedStr) {
  let h = 0
  for (let i = 0; i < seedStr.length; i++) h = (Math.imul(31, h) + seedStr.charCodeAt(i)) | 0
  return () => {
    h |= 0
    h = (h + 0x6d2b79f5) | 0
    let t = Math.imul(h ^ (h >>> 15), 1 | h)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Chaikin's corner-cutting: replaces every edge of a closed polygon with two points 25%/75%
// along it, which rounds off every corner without needing bezier/spline math. A few iterations
// turn a small irregular polygon into a smooth wavy closed curve - real clouds' lumpy-but-round
// silhouette, not a perfect circle (too uniform) and not a raw many-cornered polygon (too spiky).
function chaikinSmooth(points, iterations) {
  let pts = points
  for (let iter = 0; iter < iterations; iter++) {
    const next = []
    const n = pts.length
    for (let i = 0; i < n; i++) {
      const p0 = pts[i]
      const p1 = pts[(i + 1) % n]
      next.push([p0[0] * 0.75 + p1[0] * 0.25, p0[1] * 0.75 + p1[1] * 0.25])
      next.push([p0[0] * 0.25 + p1[0] * 0.75, p0[1] * 0.25 + p1[1] * 0.75])
    }
    pts = next
  }
  return pts
}

// Real clouds aren't circles, and shouldn't render as one: build an irregular blob polygon in
// real lat/lng meters around the cloud's center. Because it's genuine geometry (not a pixel
// radius), it scales correctly with zoom for free through MapLibre's normal projection - no
// zoom-expression math needed at all, unlike the circle-radius approach this replaces.
function cloudPolygonCoords(cloud) {
  const rand = seededRandom(cloud.id)
  // A handful of irregular "lobe" points (real variance, not just tiny jitter) run through
  // Chaikin smoothing - this is purely visual (collision is a separate, simple radius check
  // against cloud.radiusMeters in the tick loop, never the polygon's exact vertices).
  const lobeCount = 8 + Math.floor(rand() * 4)
  const base = []
  for (let i = 0; i < lobeCount; i++) {
    const angle = (360 * i) / lobeCount + (rand() - 0.5) * 15
    const radiusFactor = 0.75 + rand() * 0.4
    const [lat, lng] = offsetLatLng([cloud.lat, cloud.lng], angle, cloud.radiusMeters * radiusFactor)
    base.push([lng, lat])
  }
  const points = chaikinSmooth(base, 3)
  points.push(points[0])
  return points
}

function cloudsToGeoJSON(clouds) {
  return {
    type: 'FeatureCollection',
    features: clouds.map((cloud) => ({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [cloudPolygonCoords(cloud)] },
      properties: { id: cloud.id, tier: cloud.tier || null }
    }))
  }
}

// MapLibre's source.setData() has no built-in tweening - a raw position change is an instant
// jump-cut, which at Survival's fast tick rate reads as clouds "teleporting" rather than drifting.
// Rather than raising tick frequency further (each tick is also a Supabase write), this smoothly
// slides each cloud (matched by id) from its position at the START of the current tick interval to
// its new tick position, over the interval's own duration - the authoritative tick stays exactly
// as infrequent as before, only the client-side rendering is interpolated. New clouds (no prior
// position to interpolate from) just appear at their spawn point; removed clouds vanish instantly.
function interpolateClouds(fromList, toList, t) {
  const fromById = new Map(fromList.map((c) => [c.id, c]))
  const clamped = Math.max(0, Math.min(1, t))
  return toList.map((cloud) => {
    const prev = fromById.get(cloud.id)
    if (!prev) return cloud
    return {
      ...cloud,
      lat: prev.lat + (cloud.lat - prev.lat) * clamped,
      lng: prev.lng + (cloud.lng - prev.lng) * clamped
    }
  })
}

function bboxOutlineGeoJSON(box) {
  const { south, west, north, east } = box
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: [[west, south], [east, south], [east, north], [west, north], [west, south]] }
  }
}

// Split into two deliberate categories instead of one mixed-probability roll: the ambient spawner
// (round start + ongoing tick maintenance) only ever produces small clouds now - with 100+ of them
// in Survival, a 15% chance of also being huge made the field feel chaotic rather than threatening.
// Big clouds are now exclusively what the "Add cloud" button places, on purpose, one at a time.
function randomSmallCloudRadius(sizeMultiplier = 1) {
  return (20 + Math.random() * 70) * sizeMultiplier
}

function randomBigCloudRadius(sizeMultiplier = 1) {
  return (220 + Math.random() * 780) * sizeMultiplier
}

// Clouds should persist for most of a round rather than being pruned after drifting a fixed
// distance - 7-15 minutes per direct feedback (Survival rounds run 10 minutes total).
function randomCloudLifetimeMs() {
  return 7 * 60000 + Math.random() * 8 * 60000
}

// Spawns are spread uniformly across the whole playable bbox, not anchored to any one player's
// position - a room has multiple players scattered across the map, so anchoring to whichever
// client happened to run the spawn tick (the host) clustered every cloud around just them.
function randomPointInBbox() {
  return {
    lat: CONFIG.bbox.south + Math.random() * (CONFIG.bbox.north - CONFIG.bbox.south),
    lng: CONFIG.bbox.west + Math.random() * (CONFIG.bbox.east - CONFIG.bbox.west)
  }
}

function isWithinPaddedBbox(lat, lng) {
  return (
    lat >= CONFIG.bbox.south - CLOUD_BBOX_MARGIN_DEG &&
    lat <= CONFIG.bbox.north + CLOUD_BBOX_MARGIN_DEG &&
    lng >= CONFIG.bbox.west - CLOUD_BBOX_MARGIN_DEG &&
    lng <= CONFIG.bbox.east + CLOUD_BBOX_MARGIN_DEG
  )
}

const defaultPosition = {
  lat: CONFIG.startPosition.lat,
  lng: CONFIG.startPosition.lng,
  speed: 0
}

function useDrivingControls(started, onControlsChange, onZoomChange, onReverseTap, northUpMode) {
  useEffect(() => {
    if (!started) return

    // reverseKeyDown is purely internal edge-detection (so holding S doesn't repeat-fire the
    // flip on the browser's keydown auto-repeat) - it's never exposed via onControlsChange, since
    // S/ArrowDown is a one-shot action in the normal (rotating-map) mode, not a held control. In
    // north-up "Pac-Man style" mode (by direct request - a deliberately different mechanism from
    // the rotating map, where S is a held absolute-south command, not a facing flip), S/ArrowDown
    // behaves like forward/left/right instead: held = go, released = stop.
    const pressed = { forward: false, left: false, right: false, turbo: false, backward: false, reverseKeyDown: false }
    const update = () => onControlsChange({ forward: pressed.forward, left: pressed.left, right: pressed.right, turbo: pressed.turbo, backward: pressed.backward })

    const down = (e) => {
      const key = e.key
      // prevent arrow keys from scrolling the page
      if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight') e.preventDefault()

      if (key === 'ArrowUp' || key === 'w' || key === 'W') {
        if (!pressed.forward) {
          pressed.forward = true
          update()
        }
      }
      if (key === 'ArrowDown' || key === 's' || key === 'S') {
        if (northUpMode) {
          if (!pressed.backward) {
            pressed.backward = true
            update()
          }
        } else if (!pressed.reverseKeyDown) {
          pressed.reverseKeyDown = true
          onReverseTap()
        }
      }
      if (key === 'ArrowLeft' || key === 'a' || key === 'A') {
        if (!pressed.left) {
          pressed.left = true
          update()
        }
      }
      if (key === 'ArrowRight' || key === 'd' || key === 'D') {
        if (!pressed.right) {
          pressed.right = true
          update()
        }
      }
      if (key === 'Shift') {
        if (!pressed.turbo) {
          pressed.turbo = true
          update()
        }
      }
      if (key === 'b') onZoomChange(-1)
      if (key === 'v') onZoomChange(1)
    }

    const up = (e) => {
      const key = e.key
      if (key === 'ArrowUp' || key === 'w' || key === 'W') {
        pressed.forward = false
        update()
      }
      if (key === 'ArrowDown' || key === 's' || key === 'S') {
        pressed.reverseKeyDown = false
        if (pressed.backward) {
          pressed.backward = false
          update()
        }
      }
      if (key === 'ArrowLeft' || key === 'a' || key === 'A') {
        pressed.left = false
        update()
      }
      if (key === 'ArrowRight' || key === 'd' || key === 'D') {
        pressed.right = false
        update()
      }
      if (key === 'Shift') {
        pressed.turbo = false
        update()
      }
    }

    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [started, onControlsChange, onZoomChange, onReverseTap, northUpMode])
}

function ScreenOverlay({ wind, players = [], items = [], radarTargets = [], started, name, speedKmh, turboActive, compassRef, gameMessage }) {
  return (
    <div className="screen-overlay">
      {started && gameMessage ? <div className="overlay-top-title">{gameMessage}</div> : null}
      <div className="overlay-top-left">
        {started ? <div className="mode-pill">{name}</div> : null}
        <div className="mode-pill">Wind: {wind.direction} · {wind.speed} km/h</div>
        {started ? (
          <div className="mode-pill compass-pill">
            <svg ref={compassRef} className="compass-arrow" viewBox="0 0 24 24" width="22" height="22">
              <path d="M12 2 L16 12 L12 9.5 Z" fill="#e53935" />
              <path d="M12 22 L16 12 L12 14.5 Z" fill="#9aa0a6" />
              <path d="M12 2 L8 12 L12 9.5 Z" fill="#e53935" />
              <path d="M12 22 L8 12 L12 14.5 Z" fill="#9aa0a6" />
            </svg>
          </div>
        ) : null}
      </div>
      {started ? (
        <div className="overlay-bottom-left">
          <div className={`mode-pill${turboActive ? ' turbo-active' : ''}`}>{speedKmh} km/h{turboActive ? ' ⚡ Turbo' : ''}</div>
        </div>
      ) : null}
      {players.map((p) => (
        <div key={p.name} className="player-dot" style={{ left: `${p.screenX}%`, top: `${p.screenY}%`, color: p.color }}>
          <div className="car-marker-label">{p.name}</div>
          <div className="player-dot-icon" dangerouslySetInnerHTML={{ __html: getAvatarSvg(p.avatarId) }} />
          {p.nextTurn === 'left' || p.nextTurn === 'right' ? (
            <div className={`car-marker-signal car-marker-signal-${p.nextTurn}`}>{p.nextTurn === 'left' ? '◀' : '▶'}</div>
          ) : null}
        </div>
      ))}
      {items.map((item) => (
        <div key={item.id} className="item-marker" style={{ left: `${item.screenX}%`, top: `${item.screenY}%` }}>
          {item.label ? (
            <div className={`item-marker-label${item.screenY < 12 ? ' item-marker-label-below' : ''}`}>{item.label}</div>
          ) : null}
          <div className="item-marker-icon" dangerouslySetInnerHTML={{ __html: getFinderItemSvg(item.iconId) }} />
        </div>
      ))}
      {radarTargets.map((t) => (
        <div
          key={t.key}
          className={`radar-indicator radar-${t.kind}`}
          style={{ left: `${t.screenX}%`, top: `${t.screenY}%`, ...(t.color ? { color: t.color } : {}) }}
        >
          <div className="radar-arrow" style={{ transform: `rotate(${t.angleDeg}deg)` }} />
          {t.kind === 'item' ? (
            <div className="radar-icon" dangerouslySetInnerHTML={{ __html: getFinderItemSvg(t.iconId) }} />
          ) : t.kind === 'it' ? (
            <div className="radar-icon radar-icon-it">!</div>
          ) : null}
        </div>
      ))}
    </div>
  )
}

export default function App({ playerName, renameName, joinRequest }) {
  const [mode, setMode] = useState('single')
  const [started, setStarted] = useState(false)
  const [zoom, setZoom] = useState(CONFIG.defaultZoom)
  const [position, setPosition] = useState(defaultPosition)
  const [rawSegments, setRawSegments] = useState(null)
  const [segments, setSegments] = useState([])
  const [graph, setGraph] = useState(null)
  const graphCacheRef = useRef({})
  const [currentEdgeId, setCurrentEdgeId] = useState(null)
  const [activeStreet, setActiveStreet] = useState('Rue inconnue')
  const [activeArrondissement, setActiveArrondissement] = useState('')
  const [activeQuartier, setActiveQuartier] = useState('')
  const [controls, setControls] = useState({ forward: false, left: false, right: false, turbo: false, backward: false })
  const [turnPreference, setTurnPreference] = useState('straight')
  const [nextTurnSignal, setNextTurnSignal] = useState('straight')
  const turnPreferenceRef = useRef('straight')
  // eslint-disable-next-line no-unused-vars
  const [mapViewTick, setMapViewTick] = useState(0)
  const [clouds, setClouds] = useState([])
  const [wind, setWind] = useState({ direction: 'NE', speed: 20, angle: CARDINAL_ANGLES.NE })
  const [roomCode, setRoomCode] = useState('')
  const name = playerName || 'Player'
  const [selectedColor, setSelectedColor] = useState(CAR_COLORS[0])
  const [selectedAvatarId, setSelectedAvatarId] = useState(DEFAULT_AVATAR_ID)
  const [appearanceLoaded, setAppearanceLoaded] = useState(!isSupabaseConfigured)
  const [cloudCooldown, setCloudCooldown] = useState(false)
  const [rooms, setRooms, roomsRef, deleteRoom] = useRoomSync()
  const [joinedRoomCode, setJoinedRoomCode] = useState(null)
  const [eliminated, setEliminated] = useState(false)
  const [gameMessage, setGameMessage] = useState('')
  const [mapReady, setMapReady] = useState(false)
  const [showStreetNames, setShowStreetNames] = useState(true)
  const [showRouteLine, setShowRouteLine] = useState(false)
  const [showDebugGraph, setShowDebugGraph] = useState(false)
  const [northUpMode, setNorthUpMode] = useState(false)
  const [themeId, setThemeId] = useState('voyager')
  const [turboButtonOn, setTurboButtonOn] = useState(false)
  const [renamingOpen, setRenamingOpen] = useState(false)
  const [renameInput, setRenameInput] = useState('')
  const [renameError, setRenameError] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [pickedSpawn, setPickedSpawn] = useState(null)
  const [pickingSpawn, setPickingSpawn] = useState(false)
  const mapBearingRef = useRef(0)
  const startedRef = useRef(false)
  const positionRef = useRef(defaultPosition)
  const carMarkerRef = useRef(null)
  const carMarkerElRef = useRef(null)
  const spawnMarkerRef = useRef(null)
  const compassRef = useRef(null)
  const northUpModeRef = useRef(false)
  const activeZoomGestureRef = useRef(false)
  const showDebugGraphRef = useRef(false)

  useEffect(() => {
    northUpModeRef.current = northUpMode
  }, [northUpMode])

  useEffect(() => {
    showDebugGraphRef.current = showDebugGraph
  }, [showDebugGraph])

  const handleMapReady = useCallback((map) => {
    mapRef.current = map
    // screenPlayers/screenItems project lat/lng to screen % using the map's CURRENT
    // center/zoom/bearing at compute time - without this, panning or zooming the map (a plain
    // MapLibre-internal transform, not React state) left those projections stale until something
    // else happened to trigger a re-render, which is exactly why item/player markers used to
    // visibly drift or vanish while panning/zooming instead of tracking the map.
    map.on('move', () => setMapViewTick((t) => t + 1))
    // The movement tick loop calls map.jumpTo(...) every frame while driving - jumpTo cancels any
    // in-progress camera animation, which was silently killing MapLibre's own scroll-wheel zoom
    // easing on the very next frame (looked like scroll-zoom "tries but blocks"). Skip the
    // per-frame jumpTo while a zoom gesture is active so it can complete uninterrupted.
    map.on('zoomstart', () => { activeZoomGestureRef.current = true })
    map.on('zoomend', () => { activeZoomGestureRef.current = false })
    map.addSource('route', { type: 'geojson', data: polylineToGeoJSON([]) })
    map.addLayer({
      id: 'route',
      type: 'line',
      source: 'route',
      layout: { visibility: 'none' },
      paint: { 'line-color': '#ffb400', 'line-width': 6, 'line-opacity': 0.9 }
    })
    map.addSource('clouds', { type: 'geojson', data: cloudsToGeoJSON([]) })
    map.addLayer({
      id: 'clouds',
      type: 'fill',
      source: 'clouds',
      paint: {
        'fill-color': ['match', ['get', 'tier'], 'black', '#353232', 'gray', '#969191', '#FFFFFF'],
        'fill-opacity': 0.9,
        'fill-outline-color': 'rgba(90,110,135,0.55)'
      }
    })
    // An outline of the playable area - the boundary itself isn't driveable-past-blocked, but
    // it's now genuinely the edge of the street network, so seeing it coming is the whole point.
    // Kept in sync with the active mode's bbox (tight vs wide) by the effect further below;
    // initialized with the tight box here as a placeholder, overwritten immediately once mapReady.
    map.addSource('bbox-boundary', {
      type: 'geojson',
      data: bboxOutlineGeoJSON(CONFIG.bbox)
    })
    map.addLayer({
      id: 'bbox-boundary',
      type: 'line',
      source: 'bbox-boundary',
      paint: { 'line-color': '#e53935', 'line-width': 3, 'line-dasharray': [2, 2], 'line-opacity': 0.85 }
    })
    // Debug overlay ("Debug: street graph" checkbox) - draws every edge the car can actually
    // drive on, Pac-Man-maze-wall style, plus red dots at intersections where the game's
    // straight-ahead default can wrongly divert onto a different street (see
    // findRiskyIntersections in mapUtils.js). Off by default; hidden until toggled on.
    map.addSource('debug-graph-edges', { type: 'geojson', data: graphEdgesToGeoJSON(null) })
    map.addLayer({
      id: 'debug-graph-edges',
      type: 'line',
      source: 'debug-graph-edges',
      layout: { visibility: 'none' },
      paint: { 'line-color': '#00e5ff', 'line-width': 4, 'line-opacity': 0.75 }
    })
    map.addSource('debug-risky-nodes', { type: 'geojson', data: riskyIntersectionsToGeoJSON([]) })
    map.addLayer({
      id: 'debug-risky-nodes',
      type: 'circle',
      source: 'debug-risky-nodes',
      layout: { visibility: 'none' },
      paint: { 'circle-color': '#ff1744', 'circle-radius': 9, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 }
    })
    setMapReady(true)
  }, [])

  const handleMapClick = useCallback((lngLat) => {
    setPickingSpawn((picking) => {
      if (!picking) return picking
      setPickedSpawn({ lat: lngLat.lat, lng: lngLat.lng })
      return false
    })
  }, [])

  useEffect(() => {
    startedRef.current = started
  }, [started])

  useEffect(() => {
    positionRef.current = position
  }, [position])

  // Load any previously-saved color/avatar for this name, once per name claim. Guarded by
  // appearanceLoaded so the save effect below doesn't fire (and overwrite the saved row with
  // defaults) before this finishes.
  useEffect(() => {
    if (!isSupabaseConfigured) {
      setAppearanceLoaded(true)
      return
    }
    let cancelled = false
    setAppearanceLoaded(false)
    supabase
      .from('online_players')
      .select('color, avatar_id')
      .eq('name_lower', name.toLowerCase())
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) console.error('Failed to load saved appearance:', error.message)
        if (data?.color) setSelectedColor(data.color)
        if (data?.avatar_id) setSelectedAvatarId(data.avatar_id)
        setAppearanceLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [name])

  useEffect(() => {
    if (!isSupabaseConfigured || !appearanceLoaded) return
    supabase
      .from('online_players')
      .update({ color: selectedColor, avatar_id: selectedAvatarId })
      .eq('name_lower', name.toLowerCase())
      .then(({ error }) => {
        if (error) console.error('Failed to save appearance:', error.message)
      })
  }, [selectedColor, selectedAvatarId, appearanceLoaded, name])

  const currentRoom = useMemo(
    () => rooms.find((room) => room.code === joinedRoomCode) || null,
    [rooms, joinedRoomCode]
  )

  // A player already sitting in a room only ever gets `started` set at the moment they
  // create/join it. Without this, someone waiting in a host-gated lobby never learns the host
  // clicked Start (or Stop) - this keeps `started` in sync with the room's actual status for the
  // whole time they're in it, not just the initial join.
  useEffect(() => {
    if (!currentRoom) return
    // Staying "started" through 'finished' (not just 'playing') keeps the map/HUD visible with a
    // results panel on top when a round ends, instead of yanking everyone straight back to the
    // full create/join lobby screen the instant the timer hits zero - there's no rush, the room
    // stays open until whoever's still in it chooses to leave or the host restarts.
    const shouldBeStarted = (currentRoom.status === 'playing' || currentRoom.status === 'finished') &&
      !currentRoom.players.find((p) => p.name === name)?.eliminated
    setStarted((prev) => (prev === shouldBeStarted ? prev : shouldBeStarted))
  }, [currentRoom, name])

  const currentPlayer = useMemo(
    () => currentRoom?.players.find((player) => player.name === name) || null,
    [currentRoom, name]
  )

  const isRoomHost = useMemo(() => currentRoom?.host === name, [currentRoom, name])

  const roomChannelRef = useRef(null)
  const lastBroadcastRef = useRef(0)
  const [livePositions, setLivePositions] = useState({})
  // Roaming Finder items' live positions (Finder (Roaming) only) - same ephemeral-broadcast model
  // as livePositions above, keyed by item id instead of player name. Never touches the database;
  // room.items' own lat/lng stays as each item's round-start spawn point only.
  const [liveItemPositions, setLiveItemPositions] = useState({})

  // Survival health - changes every frame, so (like position) it never touches Postgres per-tick;
  // it rides the same throttled broadcast and is only persisted once, by the host, at round end.
  const [health, setHealth] = useState(1000)
  const healthRef = useRef(1000)

  // A live-round timer readout (survival/tag) needs *something* to re-render on a schedule since
  // remaining time isn't itself React state - a 1s ticking counter is the cheapest way to do that.
  // eslint-disable-next-line no-unused-vars
  const [clockTick, setClockTick] = useState(0)
  useEffect(() => {
    if (!currentRoom?.roundStartedAt || currentRoom.status !== 'playing') return
    const interval = window.setInterval(() => setClockTick((t) => t + 1), 1000)
    return () => window.clearInterval(interval)
  }, [currentRoom?.roundStartedAt, currentRoom?.status])

  // Reset local health whenever a new Survival round starts.
  useEffect(() => {
    if (currentRoom?.mode === 'survival' && currentRoom.roundStartedAt) {
      healthRef.current = 1000
      setHealth(1000)
    }
  }, [currentRoom?.mode, currentRoom?.roundStartedAt])

  // One consolidated snapshot the animation tick loop (and the cloud-spawn interval) read from -
  // both run on their own timers with narrow dependency arrays, so rather than adding half a
  // dozen individual ref mirrors, everything they need to read (but not react to) lives here and
  // is refreshed after every render.
  const liveRef = useRef({})
  useEffect(() => {
    liveRef.current = {
      currentRoom,
      livePositions,
      liveItemPositions,
      clouds,
      eliminated,
      foundItems: currentPlayer?.foundItems || [],
      updateRoom,
      name
    }
  })

  // Live position travels over an ephemeral Realtime Broadcast channel per room, never the
  // database - only room structure (roster/status/clouds) is persisted via useRoomSync.
  useEffect(() => {
    setLivePositions({})
    setLiveItemPositions({})
    if (!isSupabaseConfigured || !joinedRoomCode) {
      roomChannelRef.current = null
      return
    }
    const channel = supabase.channel(`room:${joinedRoomCode}`)
    // A real player's own position - one broadcast per player, never batched (nothing to batch,
    // there's only ever one).
    channel.on('broadcast', { event: 'position' }, ({ payload }) => {
      if (!payload || payload.name === name) return
      setLivePositions((prev) => ({ ...prev, [payload.name]: payload }))
    })
    // NPCs: one batched broadcast per tick (see the ambient NPC tick effect) instead of one per
    // NPC - Survival's 99-bot rooms made one-message-per-NPC blow through Supabase's realtime
    // rate limit (up to ~500 sends/second), which also degraded unrelated concurrent rooms since
    // the limit is project-wide, not per-room.
    channel.on('broadcast', { event: 'positions-batch' }, ({ payload }) => {
      if (!Array.isArray(payload)) return
      setLivePositions((prev) => {
        const next = { ...prev }
        for (const p of payload) {
          if (p?.name && p.name !== name) next[p.name] = p
        }
        return next
      })
    })
    // Roaming Finder items: same batching fix, one message per tick for all items instead of one
    // per item. Every client (not just the host simulating them) needs these to render the items'
    // actual current position and to check pickups against where they really are.
    channel.on('broadcast', { event: 'item-positions-batch' }, ({ payload }) => {
      if (!Array.isArray(payload)) return
      setLiveItemPositions((prev) => {
        const next = { ...prev }
        for (const p of payload) {
          if (p?.itemId) next[p.itemId] = p
        }
        return next
      })
    })
    channel.subscribe()
    roomChannelRef.current = channel
    return () => {
      supabase.removeChannel(channel)
      roomChannelRef.current = null
    }
  }, [joinedRoomCode, name])

  useEffect(() => {
    if (!currentRoom) {
      setGameMessage('')
      return
    }

    if (currentRoom.status === 'finished') {
      const names = currentRoom.winners || []
      if (!names.length) {
        setGameMessage('Round finished with no winner.')
      } else {
        setGameMessage(names.includes(name) ? 'You won!' : `${names.join(' & ')} won!`)
      }
      return
    }

    if (currentRoom.mode === 'survival') {
      setGameMessage(currentRoom.status === 'waiting' ? 'Waiting for another player to join...' : 'Dodge clouds! Most health after 10 minutes wins.')
      return
    }

    if (isFinderMode(currentRoom.mode)) {
      if (currentRoom.status === 'waiting') {
        setGameMessage('Waiting for another player to join...')
      } else {
        setGameMessage(
          currentRoom.mode === 'finder-easy'
            ? 'Find all 10 items - watch for their icons on the map!'
            : currentRoom.mode === 'finder-roaming'
            ? 'Find all 10 items - they move, so watch for their icons on the map!'
            : 'Find all 10 items - only the distance list can help you.'
        )
      }
      return
    }

    if (currentRoom.mode === 'tag') {
      if (currentRoom.status === 'waiting') {
        setGameMessage('Waiting for another player to join...')
      } else if (currentRoom.itName === name) {
        setGameMessage("You're It! Catch everyone before time runs out.")
      } else if (currentPlayer?.eliminated) {
        setGameMessage('Tagged! Watch for the next round.')
      } else {
        setGameMessage(`Run from ${currentRoom.itName}!`)
      }
      return
    }

    setGameMessage('')
  }, [currentRoom, currentPlayer, name])

  const mapRef = useRef(null)
  const movementRef = useRef({ distanceAlong: 0, direction: 1 })
  const animationRef = useRef(null)
  const pendingTurnRef = useRef(null)
  // North-up mode only: the last compass target direction/forward-vs-backward was actually
  // decided for. See the tick loop below - without this, the decision re-ran every single frame
  // using the LOCAL heading at the car's exact current position, and on a street that curves even
  // a little, that local heading can briefly favor "backward" over "forward" while the player is
  // steadily holding the same key the whole time, causing an unintended reversal mid-block.
  const lastAbsoluteTargetRef = useRef(null)
  // Drives the cloud-position smoothing described at interpolateClouds - `from`/`to` are the
  // cloud lists bracketing the current tick interval, `startTime`/`durationMs` say how far through
  // it we are. Updated whenever `clouds` state changes; read every animation frame by the render
  // loop below, entirely separate from the (infrequent, Supabase-writing) authoritative tick.
  const cloudsAnimRef = useRef({ from: [], to: [], startTime: 0, durationMs: CLOUD_MOVE_INTERVAL_MS })
  const prevCloudsForAnimRef = useRef([])
  const cloudsRenderFrameRef = useRef(null)
  // Host-only local simulation state for every ambient NPC currently in the room: name ->
  // { edgeId, distanceAlong, direction }. Never persisted or broadcast itself - only the resulting
  // lat/lng gets broadcast (see the NPC tick effect below), same as a real player's own position.
  const npcSimRef = useRef({})
  // Host-only local simulation state for every roaming Finder item (Finder (Roaming) mode only):
  // item id -> { edgeId, distanceAlong, direction, anchorCoord?, napUntil? }. anchorCoord is
  // resolved once (on first tick) and cached here for home-anchor personalities (Flora, Jasper) -
  // re-resolving it every tick would be wasted work since the anchor never moves.
  const itemSimRef = useRef({})
  // Always holds the freshest leaveRoom (synced by an effect right after it's declared below) -
  // quitGame calls through this instead of leaveRoom directly, since a real bug was traced to
  // exactly this staleness: quitGame's own deps deliberately exclude leaveRoom (it's declared
  // later in this component, so listing it would throw "Cannot access before initialization" on
  // first render), which meant quitGame could call a stale leaveRoom closure holding a `rooms`
  // snapshot from before a 2nd player had even joined - it saw an "empty" room and deleted it
  // outright instead of reassigning host, which is what silently vanished a room out from under
  // a remaining player. This ref indirection keeps quitGame safe to create early (no TDZ crash)
  // while still always invoking the current leaveRoom.
  const leaveRoomRef = useRef(null)

  const currentSegment = useMemo(() => graph?.edges.get(currentEdgeId) || null, [graph, currentEdgeId])
  const riskyIntersections = useMemo(() => (graph ? findRiskyIntersections(graph) : []), [graph])

  useEffect(() => {
    if (!mapReady) return
    const map = mapRef.current
    if (!map) return
    map.getSource('debug-graph-edges')?.setData(graphEdgesToGeoJSON(showDebugGraph ? graph : null))
    map.getSource('debug-risky-nodes')?.setData(riskyIntersectionsToGeoJSON(showDebugGraph ? riskyIntersections : []))
    map.setLayoutProperty('debug-graph-edges', 'visibility', showDebugGraph ? 'visible' : 'none')
    map.setLayoutProperty('debug-risky-nodes', 'visibility', showDebugGraph ? 'visible' : 'none')
  }, [showDebugGraph, graph, riskyIntersections, mapReady])
  // North-up mode: each of W/A/S/D independently causes movement (an absolute compass command),
  // not just W as the accelerator - matches every other mode's "hold W to go" everywhere else.
  const movementKeyHeld = northUpMode ? controls.forward || controls.backward || controls.left || controls.right : controls.forward
  const displayedSpeed = useMemo(() => {
    // Doubled from the street's raw value across the board - a 50 km/h street plays at 100
    // normal, 200 under Turbo. S/ArrowDown is an instant facing-flip now (see the tick loop),
    // not a held reverse gear, so there's no separate reverse speed tier anymore.
    const base = (movementKeyHeld ? currentSegment?.speedKmh ?? 50 : 0) * 2
    // Tag's "It" drives 2x everyone else's speed.
    const isIt = currentRoom?.mode === 'tag' && currentRoom.itName === name
    if (isIt) return base * 2
    // Turbo (hold Shift or the on-screen button): unlimited use, doubles speed in every mode
    // except Tag - It's 2x above is the only speed buff Tag allows.
    const turboActive = (controls.turbo || turboButtonOn) && currentRoom?.mode !== 'tag'
    return turboActive ? base * 2 : base
  }, [controls, movementKeyHeld, currentSegment, currentRoom, name, turboButtonOn])

  const turboActive = (controls.turbo || turboButtonOn) && movementKeyHeld && currentRoom?.mode !== 'tag'

  // Throttled to ~8Hz so cross-device position sync stays well within the realtime message
  // budget - this never touches Supabase's database, only the ephemeral broadcast channel.
  const syncPlayerState = useCallback(
    (pos, headingVal, speedVal) => {
      if (!joinedRoomCode || !roomChannelRef.current) return
      const nowMs = Date.now()
      if (nowMs - lastBroadcastRef.current < 120) return
      lastBroadcastRef.current = nowMs
      roomChannelRef.current.send({
        type: 'broadcast',
        event: 'position',
        payload: {
          name,
          lat: pos.lat,
          lng: pos.lng,
          heading: headingVal,
          speed: speedVal,
          eliminated,
          health: healthRef.current,
          foundCount: (currentPlayer?.foundItems || []).length,
          nextTurn: nextTurnSignal
        }
      })
    },
    [joinedRoomCode, name, eliminated, currentPlayer, nextTurnSignal]
  )

  const zoomIn = () => setZoom((z) => Math.min(CONFIG.maxZoom, z + 1))
  const zoomOut = () => setZoom((z) => Math.max(CONFIG.minZoom, z - 1))

  const submitRename = useCallback(async () => {
    if (!renameName) return
    setRenaming(true)
    setRenameError('')
    const result = await renameName(renameInput)
    setRenaming(false)
    if (result?.success) {
      setRenamingOpen(false)
      setRenameInput('')
    } else {
      setRenameError(result?.error || 'Could not rename right now.')
    }
  }, [renameName, renameInput])

  const quitGame = useCallback(() => {
    // Quitting out of a room needs the same cleanup as clicking "Leave room" - just clearing
    // joinedRoomCode locally left the player as a ghost member other clients still saw. Goes
    // through leaveRoomRef (see its declaration above) rather than calling leaveRoom directly -
    // that's the fix for a real bug where a stale closure caused the room to be deleted instead
    // of just losing the departing host.
    if (joinedRoomCode) {
      leaveRoomRef.current?.()
    } else {
      setStarted(false)
    }
    setEliminated(false)
    setPosition(defaultPosition)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joinedRoomCode])

  // Lets ChatPanel show a "Join" button (and an in-game indicator + mode label) next to a friend
  // who's currently in a room - it has no other way to know that, since rooms/online_players are
  // otherwise unrelated tables.
  useEffect(() => {
    if (!isSupabaseConfigured) return
    supabase
      .from('online_players')
      .update({
        room_code: joinedRoomCode || null,
        room_mode: joinedRoomCode ? mode : null,
        room_status: joinedRoomCode ? currentRoom?.status || null : null
      })
      .eq('name_lower', name.toLowerCase())
      .then(({ error }) => {
        if (error) console.error('Failed to sync room_code:', error.message)
      })
  }, [joinedRoomCode, mode, name, currentRoom?.status])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        quitGame()
        return
      }
      // e.repeat is true for the OS's own key-repeat keydown events fired while a key is held,
      // not just the initial press - without this guard, simply holding A/D for normal steering
      // (not a deliberate tap) kept re-arming a fresh 3s window on every repeat tick, so the
      // pending turn effectively never expired while held and could still be lingering nearly 3s
      // after release. In dense urban blocks with intersections closer together than that, a turn
      // signal meant for one intersection was firing at the NEXT one instead - a very plausible
      // root cause for "it turns somewhere I didn't ask it to" reports. Also shortened the window
      // itself (3s -> 1.2s) so even a genuine tap doesn't linger across multiple close intersections.
      if ((e.key === 'a' || e.key === 'ArrowLeft') && !e.repeat) {
        pendingTurnRef.current = 'left'
        setNextTurnSignal('left')
        window.setTimeout(() => {
          if (pendingTurnRef.current === 'left') {
            pendingTurnRef.current = null
            setNextTurnSignal(turnPreferenceRef.current)
          }
        }, 1200)
      }
      if ((e.key === 'd' || e.key === 'ArrowRight') && !e.repeat) {
        pendingTurnRef.current = 'right'
        setNextTurnSignal('right')
        window.setTimeout(() => {
          if (pendingTurnRef.current === 'right') {
            pendingTurnRef.current = null
            setNextTurnSignal(turnPreferenceRef.current)
          }
        }, 1200)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [quitGame])

  const handleControlsChange = useCallback((nextControls) => {
    setControls(nextControls)
    if (nextControls.left) setTurnPreference('left')
    else if (nextControls.right) setTurnPreference('right')
    else setTurnPreference('straight')
  }, [])

  // Turn-signal readout: reflects an explicit tap (pendingTurnRef, set/cleared in the keydown
  // effect below) if one's active, otherwise falls back to the live steering lean. turnPreference
  // is mirrored into a ref too since the keydown effect's timeout and the tick loop both need the
  // freshest value without being recreated every time it changes.
  useEffect(() => {
    turnPreferenceRef.current = turnPreference
    if (!pendingTurnRef.current) setNextTurnSignal(turnPreference)
  }, [turnPreference])

  const handleZoomChange = useCallback((delta) => {
    setZoom((current) => Math.min(CONFIG.maxZoom, Math.max(CONFIG.minZoom, current + delta)))
  }, [])

  // S/ArrowDown: instant 180° facing flip in place, replacing the old hold-to-reverse/hold-1s-
  // for-a-U-turn model (which glitched around its own timing threshold). No animation needed here
  // - the existing bearing-easing in the tick loop below already turns this instant logical flip
  // into a smooth visual spin, exactly like it already smooths every other turn.
  const flipDirection = useCallback(() => {
    movementRef.current.direction *= -1
  }, [])

  useDrivingControls(started, handleControlsChange, handleZoomChange, flipDirection, northUpMode)

  useEffect(() => {
    // Two files: Québec's own synced data (city==='Québec' throughout - Ville de Québec's
    // open-data portal never covered Lévis), and Lévis's separately imported from the gumballquiz
    // sibling project (see scripts/importLevisData.mjs) in the exact same schema. Only the wide
    // bbox (Single/Team) ever needs Lévis - merged here regardless since it's cheap to carry the
    // extra ~3800 rows and filter them out for the tight-bbox modes below.
    Promise.all([
      fetch('/data/QBC/segments.json').then((res) => res.json()),
      fetch('/data/QBC/segments-levis.json').then((res) => res.json())
    ])
      .then(([quebec, levis]) => setRawSegments([...quebec, ...levis]))
      .catch(() => {
        console.error('Unable to load street data')
      })
  }, [])

  const wideBboxMode = Boolean(MODE_CONFIG[mode]?.wideBbox)

  useEffect(() => {
    if (!rawSegments) return
    // Two bbox variants share one raw fetch: the tight curated box (most modes, Québec only) and
    // the wide full-region box (Single/Team, see MODE_CONFIG - Québec + Lévis). Each is
    // filtered+built once and cached here - switching modes back and forth in the setup screen
    // shouldn't rebuild a 20k+ segment graph every time.
    const cacheKey = wideBboxMode ? 'wide' : 'tight'
    const cached = graphCacheRef.current[cacheKey]
    if (cached) {
      setSegments(cached.segments)
      setGraph(cached.graph)
      return
    }
    const box = wideBboxMode ? CONFIG.bboxWide : CONFIG.bbox
    const withinBbox = (poly) => poly.every(([lat, lng]) => lat >= box.south && lat <= box.north && lng >= box.west && lng <= box.east)
    const allowedCities = wideBboxMode ? ['Québec', 'Lévis'] : ['Québec']
    const filtered = rawSegments.filter((s) => allowedCities.includes(s.city) && withinBbox(s.polyline))
    const builtGraph = buildGraph(filtered)
    graphCacheRef.current[cacheKey] = { segments: filtered, graph: builtGraph }
    setSegments(filtered)
    setGraph(builtGraph)
  }, [rawSegments, wideBboxMode])

  useEffect(() => {
    if (!graph) return
    if (currentEdgeId) return

    const startPoint = pickedSpawn || CONFIG.startPosition
    const start = [startPoint.lat, startPoint.lng]
    const nearest = findNearestSegment(Array.from(graph.edges.values()), start)
    if (!nearest?.segment) return

    setCurrentEdgeId(nearest.segment.id)
    movementRef.current = { distanceAlong: nearest.distanceAlong, direction: 1 }
    setPosition({ lat: nearest.point[0], lng: nearest.point[1], speed: 0 })
    // The segment's stored polyline direction is arbitrary (unrelated to any "natural" facing),
    // so using it for the pre-drive preview bearing means every pick lands at a essentially
    // random rotation - readable maybe a quarter of the time, and disorienting the rest. Default
    // to north-up instead; the instant the player actually starts driving, the map's bearing is
    // recomputed correctly from real movement (verified separately) and eases to match it.
    setActiveStreet(nearest.segment.name || 'Rue inconnue')
    setActiveArrondissement(nearest.segment.arrondissement || '')
    setActiveQuartier(nearest.segment.quartier || '')
    mapBearingRef.current = 0
    if (mapRef.current) {
      mapRef.current.jumpTo({ center: [nearest.point[1], nearest.point[0]], bearing: 0 })
    }
  }, [graph, currentEdgeId, pickedSpawn])

  // Picking a new spawn point before driving starts should re-run the spawn effect above.
  useEffect(() => {
    if (started) return
    setCurrentEdgeId(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedSpawn])

  useEffect(() => {
    if (animationRef.current) cancelAnimationFrame(animationRef.current)
    const lastTimeRef = { current: null }
    const tick = (time) => {
      if (!currentSegment) {
        animationRef.current = requestAnimationFrame(tick)
        return
      }

      let dt = 1 / 60
      if (lastTimeRef.current != null && typeof time === 'number') dt = Math.max(1/120, Math.min(1/30, (time - lastTimeRef.current) / 1000))
      lastTimeRef.current = time

      const speedKmh = displayedSpeed
      const metersPerSecond = speedKmh / 3.6

      // North-up "Pac-Man style" mode (by direct request): W/A/S/D each mean a fixed absolute
      // compass direction, decoupled entirely from the rotating-map mode's "turn relative to
      // current facing" model - hold one to translate that way along whatever real street allows
      // it. Figure out the target compass direction from held keys, then (a) flip which way along
      // the CURRENT segment counts as "forward" if the other end now matches better, and (b) feed
      // it into chooseNextSegment as an absolute target at the next intersection, instead of the
      // rotating mode's relative turnPreference.
      let absoluteTargetMathDeg = null
      if (northUpModeRef.current) {
        const compassTarget = controls.backward ? 180
          : controls.forward ? 0
          : controls.left ? 270
          : controls.right ? 90
          : null
        if (compassTarget !== null) absoluteTargetMathDeg = normalizeAngle(90 - compassTarget)
      }

      // `direction` is which way travel moves distanceAlong along the stored polyline (±1).
      // S/ArrowDown flips it instantly (see the keydown handler near pendingTurnRef) instead of
      // reverse being a held gear - so unlike the old model, this is always the car's true
      // current travel direction, nothing else combines with it per-frame. In north-up mode,
      // forward-vs-backward is decided fresh only when the held compass key actually CHANGES, not
      // every single frame while the same key stays held - re-deciding continuously used the
      // LOCAL heading at the car's exact current position, and on any street that curves even a
      // little, that local heading can briefly favor "backward" over "forward" mid-block even
      // though the player never let go of the key, causing an unintended reversal. Freezing the
      // decision at entry (re-run again only at the next real intersection, via chooseNextSegment)
      // matches how a real driver thinks: keep going the way you're already going until there's an
      // actual choice to make.
      if (absoluteTargetMathDeg !== null && absoluteTargetMathDeg !== lastAbsoluteTargetRef.current) {
        const forwardHeading = normalizeAngle(getLocalHeadingAtDistance(currentSegment, movementRef.current.distanceAlong, 1))
        const backwardHeading = normalizeAngle(getLocalHeadingAtDistance(currentSegment, movementRef.current.distanceAlong, -1))
        const forwardDelta = Math.abs(signedAngleBetween(absoluteTargetMathDeg, forwardHeading))
        const backwardDelta = Math.abs(signedAngleBetween(absoluteTargetMathDeg, backwardHeading))
        movementRef.current.direction = forwardDelta <= backwardDelta ? 1 : -1
      }
      lastAbsoluteTargetRef.current = absoluteTargetMathDeg
      const direction = movementRef.current.direction
      const travelDelta = metersPerSecond * dt * direction
      let nextDistanceAlong = movementRef.current.distanceAlong + travelDelta
      let nextDirection = direction
      let nextEdgeId = currentEdgeId
      let nextSegment = currentSegment

      const overflowing = direction === 1
        ? nextDistanceAlong > currentSegment.lengthMeters
        : nextDistanceAlong < 0
      if (overflowing) {
        const remainder = direction === 1 ? nextDistanceAlong - currentSegment.lengthMeters : -nextDistanceAlong
        const exitNodeKey = direction === 1 ? currentSegment.endKey : currentSegment.startKey
        const turnChoice = pendingTurnRef.current || turnPreference
        const exitDistance = direction === 1 ? currentSegment.lengthMeters : 0
        const currentHeading = normalizeAngle(getLocalHeadingAtDistance(currentSegment, exitDistance, direction))
        const nextEdge = chooseNextSegment(
          graph,
          exitNodeKey,
          currentSegment,
          currentHeading,
          turnChoice,
          absoluteTargetMathDeg
        )
        // Debug-only: prints the exact decision made at every real intersection crossing (entering
        // street, every candidate considered with its angle, which one won, and whether a pending
        // turn signal was active) - gated behind the "Debug: street graph" checkbox since it fires
        // on every corner. Exists to get ground truth from a live repro instead of guessing, after
        // an offline simulation of every real Rue Dalhousie intersection found the per-node angle
        // logic behaving correctly there, which means whatever's causing "holding straight turns me
        // onto a cross street anyway" reports needs to be caught live, not re-derived from the map
        // data alone.
        if (showDebugGraphRef.current) {
          const node = graph.nodes.get(exitNodeKey)
          const candidates = (node?.edges || [])
            .filter((e) => e.id !== currentSegment.id)
            .map((e) => {
              const enteringAtStart = e.startKey === exitNodeKey
              const angle = getLocalHeadingAtDistance(e, enteringAtStart ? 0 : e.lengthMeters, enteringAtStart ? 1 : -1)
              return `${e.name || '(unnamed)'} [${e.id}] delta=${Math.round(signedAngleBetween(currentHeading, angle))}`
            })
          console.log(
            `[nav] at intersection: entering="${currentSegment.name}" heading=${Math.round(currentHeading)} ` +
            `turnChoice="${turnChoice}" pendingTurn=${pendingTurnRef.current || 'none'} candidates=[${candidates.join(', ')}] ` +
            `picked="${nextEdge?.name || 'NONE'}"[${nextEdge?.id || '-'}]`
          )
        }

        if (nextEdge) {
          nextEdgeId = nextEdge.id
          nextSegment = nextEdge
          const entry = resolveEdgeEntry(nextEdge, exitNodeKey, remainder)
          nextDistanceAlong = entry.distanceAlong
          nextDirection = entry.direction
          // consume pending turn if it was used
          if (pendingTurnRef.current) {
            pendingTurnRef.current = null
            setNextTurnSignal(turnPreferenceRef.current)
          }
        } else {
          nextDistanceAlong = direction === 1 ? currentSegment.lengthMeters : 0
        }
      }

      movementRef.current = { distanceAlong: nextDistanceAlong, direction: nextDirection }
      if (nextEdgeId !== currentEdgeId) {
        setCurrentEdgeId(nextEdgeId)
      }

      if (nextSegment) {
        const nextPosition = getSegmentPosition(nextSegment, nextDistanceAlong)
        const posObj = { lat: nextPosition[0], lng: nextPosition[1] }
        setPosition({ lat: posObj.lat, lng: posObj.lng, speed: displayedSpeed })
        const headingBase = getLocalHeadingAtDistance(nextSegment, nextDistanceAlong, nextDirection)
        const facingMathAngle = normalizeAngle(headingBase)
        // Compass bearing (0=N, clockwise) from here on - what the map's `bearing`, the status
        // panel's "Heading" readout, and other players' future directional markers all expect.
        // The turn-choice math above intentionally stays in math-angle convention throughout.
        const displayedHeading = toCompassBearing(facingMathAngle)
        setActiveStreet(nextSegment.name || 'Rue inconnue')
        setActiveArrondissement(nextSegment.arrondissement || '')
        setActiveQuartier(nextSegment.quartier || '')
        // Sync this player's state into the shared room so other tabs see it
        syncPlayerState(posObj, displayedHeading, displayedSpeed)

        // Mode-specific per-frame effects (Survival damage/regen, Finder-Keeper pickups, Tag
        // contact-elimination). None of currentRoom/clouds/livePositions/eliminated are deps of
        // this effect, so everything here reads from liveRef instead of a stale closure.
        const live = liveRef.current
        const room = live.currentRoom
        if (room?.status === 'playing') {
          if (room.mode === 'survival') {
            const hitClouds = live.clouds.filter(
              (c) => c.tier && haversine([posObj.lat, posObj.lng], [c.lat, c.lng]) <= c.radiusMeters
            )
            if (hitClouds.length) {
              // Worst tier only - overlapping clouds don't stack damage.
              const worst = hitClouds.reduce((a, b) => (CLOUD_DAMAGE_PER_SEC[b.tier] > CLOUD_DAMAGE_PER_SEC[a.tier] ? b : a))
              healthRef.current = Math.max(0, healthRef.current - CLOUD_DAMAGE_PER_SEC[worst.tier] * dt)
            } else {
              healthRef.current = Math.min(1000, healthRef.current + (1 / 3) * dt) // "+1 every 3s"
            }
            setHealth(healthRef.current)
          } else if (isFinderMode(room.mode) && !live.eliminated) {
            const unfound = (room.items || []).filter((item) => !live.foundItems.includes(item.id))
            // Roaming items' real position is wherever they've actually walked to (broadcast, like
            // a player's own position) - the item's stored lat/lng is just its round-start spawn,
            // stale the moment it starts moving, so prefer the live one when there is one.
            const found = unfound.find((item) => {
              const liveItemPos = live.liveItemPositions?.[item.id]
              const lat = liveItemPos?.lat ?? item.lat
              const lng = liveItemPos?.lng ?? item.lng
              return haversine([posObj.lat, posObj.lng], [lat, lng]) <= FINDER_PICKUP_RADIUS_METERS
            })
            if (found) {
              const nextFoundItems = [...live.foundItems, found.id]
              // Against this round's actual spawned item count, not the full catalog - only 10 of
              // the (growing) FINDER_ITEMS collection get spawned per round (see buildRoundState).
              const wonRound = nextFoundItems.length >= (room.items || []).length
              live.updateRoom(room.code, (r) => ({
                ...r,
                items: r.items.map((i) => (i.id === found.id ? { ...i, foundBy: live.name } : i)),
                players: r.players.map((p) => (p.name === live.name ? { ...p, foundItems: nextFoundItems } : p)),
                // First to 10 wins - guard against clobbering an already-recorded winner in the
                // rare case two players finish within the same round-trip.
                ...(wonRound && !r.winners?.length ? { status: 'finished', winners: [live.name] } : {})
              }))
            }
          } else if (room.mode === 'tag' && !live.eliminated && room.itName !== live.name) {
            const itPos = live.livePositions[room.itName]
            if (itPos && haversine([posObj.lat, posObj.lng], [itPos.lat, itPos.lng]) <= TAG_CONTACT_RADIUS_METERS) {
              setEliminated(true)
              setStarted(false)
              live.updateRoom(room.code, (r) => ({
                ...r,
                players: r.players.map((p) => (p.name === live.name ? { ...p, eliminated: true } : p))
              }))
            }
          }
        }

        // Drive the map imperatively rather than through a React-effect-triggered setView:
        // one call per frame here instead of a full render+effect cycle, and the bearing eases
        // toward the target at a capped angular speed instead of snapping every turn. Skip this
        // entirely before driving starts, so picking a custom spawn point can freely pan/zoom
        // without the camera snapping back to the default spawn on every animation frame.
        const map = mapRef.current
        if (map && startedRef.current) {
          if (northUpModeRef.current) {
            // "Pac-Man style" by direct request: map stays pinned north-up AND the car sprite
            // always points up too, completely decoupled from its real travel heading (which
            // still drives the underlying street-graph movement/absoluteTargetMathDeg above,
            // just never shown visually) - deliberately different from the rotating-map mode,
            // where the marker rotates to show real facing. No label counter-rotation needed
            // since the marker itself never rotates here.
            mapBearingRef.current = 0
            if (!activeZoomGestureRef.current) map.jumpTo({ center: [posObj.lng, posObj.lat], bearing: 0, pitch: 0 })
            carMarkerRef.current?.setRotationAlignment('viewport')
            carMarkerRef.current?.setRotation(0)
          } else {
            const currentBearing = mapBearingRef.current
            const rawDelta = ((displayedHeading - currentBearing + 540) % 360) - 180
            const maxStep = MAX_BEARING_DEG_PER_SEC * dt
            const step = Math.max(-maxStep, Math.min(maxStep, rawDelta))
            mapBearingRef.current = normalizeAngle(currentBearing + step)
            // Center car is no longer optional - it's the only supported behavior now. Skipped
            // while a scroll-wheel zoom gesture is in progress (see the zoomstart/zoomend
            // listeners in handleMapReady) so it doesn't cancel MapLibre's own zoom easing.
            if (!activeZoomGestureRef.current) {
              map.jumpTo({ center: [posObj.lng, posObj.lat], bearing: mapBearingRef.current, pitch: 0 })
            }
            carMarkerRef.current?.setRotationAlignment('viewport')
            carMarkerRef.current?.setRotation(0)
          }
          carMarkerRef.current?.setLngLat([posObj.lng, posObj.lat])
          if (compassRef.current) compassRef.current.style.transform = `rotate(${-mapBearingRef.current}deg)`
          const routeSource = map.getSource?.('route')
          if (routeSource) routeSource.setData(polylineToGeoJSON(nextSegment.polyline))
        }
      }

      animationRef.current = requestAnimationFrame(tick)
    }
    animationRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(animationRef.current)
  }, [currentSegment, displayedSpeed, currentEdgeId, controls, graph, turnPreference])

  // Position + bearing are driven imperatively every frame from inside the movement tick loop
  // above; this effect only needs to react to the zoom buttons/keys, which change far less often.
  // Guarded by a threshold so it doesn't fight mouse-wheel zooming, which changes the map's own
  // zoom directly without touching this state.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    if (Math.abs(map.getZoom() - zoom) > 0.01) map.setZoom(zoom)
  }, [zoom, mapReady])

  // Keep the +/- buttons and b/v keys working from the map's actual current zoom, including
  // whatever the user last set by scrolling, instead of a separate value that can drift from it.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const handleZoomEnd = () => setZoom(map.getZoom())
    map.on('zoomend', handleZoomEnd)
    return () => map.off('zoomend', handleZoomEnd)
  }, [mapReady])

  // Captures a new drift transition every time the authoritative `clouds` tick lands - actual
  // rendering happens in the separate rAF loop below, which reads this ref every frame regardless
  // of how infrequently this effect itself fires.
  useEffect(() => {
    const durationMs = currentRoom?.mode === 'survival' ? SURVIVAL_CLOUD_MOVE_INTERVAL_MS : CLOUD_MOVE_INTERVAL_MS
    cloudsAnimRef.current = { from: prevCloudsForAnimRef.current, to: clouds, startTime: Date.now(), durationMs }
    prevCloudsForAnimRef.current = clouds
  }, [clouds, currentRoom?.mode])

  useEffect(() => {
    if (!mapReady) return
    let lastRenderedAnim = null
    let settledAnim = null
    let lastRenderTime = 0
    const renderFrame = () => {
      const map = mapRef.current
      const source = map?.getSource('clouds')
      const anim = cloudsAnimRef.current
      if (source) {
        const now = Date.now()
        const t = anim.durationMs > 0 ? (now - anim.startTime) / anim.durationMs : 1
        const isNewTransition = anim !== lastRenderedAnim
        const settling = t >= 1
        const alreadySettled = settling && settledAnim === anim
        // Throttled to ~12fps instead of the raw 60fps rAF cadence - full-rate setData() on a
        // few-hundred-polygon GeoJSON turned out to be heavy enough to visibly stutter unrelated
        // map interaction (reported: mousewheel zoom). Still far smoother than the pre-interpolation
        // jump-cut, just not literally every frame. Always renders immediately on a brand new
        // transition (so motion starts right away) and exactly once on settling (so the final
        // position is exact, not whatever the throttle happened to land on) - then skips every
        // subsequent frame for that same transition once settled, same as before.
        if (!alreadySettled && (isNewTransition || settling || now - lastRenderTime >= 80)) {
          source.setData(cloudsToGeoJSON(interpolateClouds(anim.from, anim.to, t)))
          lastRenderTime = now
          lastRenderedAnim = anim
          if (settling) settledAnim = anim
        }
      }
      cloudsRenderFrameRef.current = requestAnimationFrame(renderFrame)
    }
    cloudsRenderFrameRef.current = requestAnimationFrame(renderFrame)
    return () => {
      if (cloudsRenderFrameRef.current) cancelAnimationFrame(cloudsRenderFrameRef.current)
    }
  }, [mapReady])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const source = map.getSource('bbox-boundary')
    if (source) source.setData(bboxOutlineGeoJSON(wideBboxMode ? CONFIG.bboxWide : CONFIG.bbox))
  }, [wideBboxMode, mapReady])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    map.setLayoutProperty('route', 'visibility', showRouteLine ? 'visible' : 'none')
  }, [showRouteLine, mapReady])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || carMarkerRef.current) return
    const el = document.createElement('div')
    el.className = 'car-marker-icon'
    el.innerHTML = carMarkerMarkup(selectedAvatarId, selectedColor, name, nextTurnSignal)
    carMarkerElRef.current = el
    carMarkerRef.current = new maplibregl.Marker({ element: el, rotationAlignment: 'viewport', pitchAlignment: 'viewport' })
      .setLngLat([position.lng, position.lat])
      .addTo(map)
    // position/color/avatar are intentionally not deps - creation only happens once map is ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady])

  useEffect(() => {
    if (!carMarkerElRef.current) return
    carMarkerElRef.current.innerHTML = carMarkerMarkup(selectedAvatarId, selectedColor, name, nextTurnSignal)
  }, [selectedAvatarId, selectedColor, name, nextTurnSignal])

  // A temporary marker preview while choosing a custom start point before driving begins.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    if (!pickedSpawn || started) {
      spawnMarkerRef.current?.remove()
      spawnMarkerRef.current = null
      return
    }
    if (!spawnMarkerRef.current) {
      const el = document.createElement('div')
      el.className = 'spawn-marker-icon'
      spawnMarkerRef.current = new maplibregl.Marker({ element: el })
        .setLngLat([pickedSpawn.lng, pickedSpawn.lat])
        .addTo(map)
    } else {
      spawnMarkerRef.current.setLngLat([pickedSpawn.lng, pickedSpawn.lat])
    }
  }, [pickedSpawn, started, mapReady])

  // Snap to current segment if position drifts too far off
  useEffect(() => {
    if (!graph || !currentSegment || !position) return
    try {
      const res = pointToSegmentDistance([position.lat, position.lng], currentSegment.polyline)
      if (res && typeof res.distance === 'number' && res.distance > 20) {
        // snap to nearest point on current segment, but only if it's meaningfully different
        const np = res.nearestPoint
        if (np && (Math.abs(np[0] - position.lat) > 1e-5 || Math.abs(np[1] - position.lng) > 1e-5)) {
          movementRef.current.distanceAlong = Math.min(Math.max(res.distanceAlong, 0), currentSegment.lengthMeters)
          setPosition({ lat: np[0], lng: np[1], speed: position.speed })
        }
      }
    } catch {}
  }, [position, currentSegment, graph])

  useEffect(() => {
    const updateWind = () => {
      const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
      const direction = directions[Math.floor(Math.random() * directions.length)]
      // Bumped up from 20-80 - faster-moving clouds per direct feedback ("make sure to... make
      // players move").
      const speed = Math.floor(40 + Math.random() * 100)
      setWind({ direction, speed, angle: CARDINAL_ANGLES[direction] })
    }

    updateWind()
    const interval = window.setInterval(updateWind, 20000)
    return () => window.clearInterval(interval)
  }, [])

  // Checked against radiusMeters + a flat 50m safety margin, not just a flat 50m from the center
  // point - a big cloud (up to ~1000m radius in survival) spawning 51m from a player would
  // otherwise cover them instantly even though the center point "passed" a flat check. Shared by
  // the ambient tick spawner and the manual "Add cloud" button, not effect-local, since both need
  // the same anti-instakill check.
  const isTooCloseToAnyPlayer = useCallback((lat, lng, radiusMeters) => {
    const live = liveRef.current
    const self = positionRef.current
    const threshold = radiusMeters + 50
    if (self && haversine([lat, lng], [self.lat, self.lng]) < threshold) return true
    return Object.values(live.livePositions || {}).some((p) => haversine([lat, lng], [p.lat, p.lng]) < threshold)
  }, [])

  // Hoisted out of the movement-tick effect (was effect-local) so the separate "guaranteed spawn
  // every 2s in Survival" effect below can use the exact same spawn logic instead of duplicating it.
  const spawnCloud = useCallback(() => {
    const isSurvival = liveRef.current.currentRoom?.mode === 'survival'
    // Exactly 2x for Survival per direct feedback (an earlier "almost twice, 1.75x" tuning was
    // superseded - Survival was still too easy, and bigger clouds (not more of them) was judged
    // the more logical fix). Always small - see randomSmallCloudRadius's comment for why big
    // clouds are now "Add cloud"-only.
    const radiusMeters = randomSmallCloudRadius(isSurvival ? 2 : 1)
    // Retry a few times to avoid spawning right on top of a player; unlike before, give up on
    // this spawn entirely if every attempt is still too close, rather than forcing a bad spawn -
    // a cloud landing directly on a player instantly stripped their health with no way to react.
    for (let attempt = 0; attempt < 10; attempt++) {
      const { lat, lng } = randomPointInBbox()
      if (!isTooCloseToAnyPlayer(lat, lng, radiusMeters)) {
        return {
          id: crypto.randomUUID(),
          lat,
          lng,
          radiusMeters,
          // Every mode's clouds get a visual tier now, not just Survival's - it only *drives
          // damage* in Survival (gated separately, in the tick loop), elsewhere purely cosmetic.
          tier: randomCloudTier(),
          createdAt: Date.now(),
          lifetimeMs: randomCloudLifetimeMs()
        }
      }
    }
    return null
  }, [isTooCloseToAnyPlayer])

  useEffect(() => {
    const isSurvivalRoom = currentRoom?.mode === 'survival'
    // Refresh rate x3 and wind x10 for Survival specifically, per direct feedback that clouds
    // barely moved - both read fresh per-call via liveRef (not the closed-over currentRoom) so a
    // room transitioning into/out of Survival mid-session doesn't need to wait for this effect to
    // restart to pick up the right multiplier.
    const moveIntervalMs = isSurvivalRoom ? SURVIVAL_CLOUD_MOVE_INTERVAL_MS : CLOUD_MOVE_INTERVAL_MS

    const driftAndPrune = (list) => {
      const survivalNow = liveRef.current.currentRoom?.mode === 'survival'
      const windSpeed = survivalNow ? survivalWindSpeedKmh(wind.speed) : wind.speed
      const distanceMeters = (windSpeed / 3.6) * (moveIntervalMs / 1000)
      const driftBearing = wind.angle ?? 0
      const now = Date.now()
      return list
        .map((cloud) => {
          const [lat, lng] = offsetLatLng([cloud.lat, cloud.lng], driftBearing, distanceMeters)
          return { ...cloud, lat, lng }
        })
        .filter((cloud) => {
          // Survival's 10x wind covers CLOUD_BBOX_MARGIN_DEG's ~3.3km margin in as little as
          // 9-30 seconds (259-907m per tick) - pruning on bbox-exit there meant clouds were dying
          // almost as fast as they spawned, capping the population far below the intended ~500
          // instead of actually accumulating over the round. Survival relies on the lifetime timer
          // (7-15min) and the CLOUD_MAX_COUNT_SURVIVAL safety cap alone; every other mode keeps
          // the bbox-exit prune since their normal-speed wind doesn't have this problem.
          if (!(survivalNow || isWithinPaddedBbox(cloud.lat, cloud.lng))) return false
          return now - (cloud.createdAt ?? 0) < (cloud.lifetimeMs ?? randomCloudLifetimeMs())
        })
    }

    // Tops up with a while loop (not a single conditional push) so a big shortfall - many clouds
    // expiring around the same time, or Survival's much higher floor - closes quickly instead of
    // trickling in at ~1 per tick. `guaranteed` forces one extra spawn every call (Survival) rather
    // than the normal 40%-chance single add - this used to be a second independent setInterval,
    // but that raced against this same tick's own updateRoom call (both read roomsRef.current,
    // which is only synced on React's next render, not synchronously - whichever call's setRooms
    // landed second silently clobbered the other's clouds). Folding it into this one tick removes
    // the race by construction: there's only ever one writer now.
    const topUp = (list, minCount, maxCount, guaranteed) => {
      const next = list
      while (next.length < minCount) {
        const spawned = spawnCloud()
        if (!spawned) break
        next.push(spawned)
      }
      if (guaranteed || Math.random() < 0.4) {
        const spawned = spawnCloud()
        if (spawned) next.push(spawned)
      }
      if (next.length > maxCount) next.splice(0, next.length - maxCount)
      return next
    }

    const moveClouds = () => {
      const isSurvival = liveRef.current.currentRoom?.mode === 'survival'
      const minCount = isSurvival ? CLOUD_MIN_COUNT_SURVIVAL : CLOUD_MIN_COUNT
      const maxCount = isSurvival ? CLOUD_MAX_COUNT_SURVIVAL : CLOUD_MAX_COUNT
      // Host computes authoritative cloud state and writes it to the room
      if (isRoomHost && currentRoom) {
        const base = Array.isArray(currentRoom.clouds) && currentRoom.clouds.length ? currentRoom.clouds : clouds
        const next = topUp(driftAndPrune(base), minCount, maxCount, isSurvival)
        updateRoom(currentRoom.code, (room) => ({ ...room, clouds: next }))
        setClouds(next)
      } else {
        // Non-host clients will receive cloud updates from the room; fallback to local behavior if none exists
        if (!currentRoom?.clouds || !currentRoom.clouds.length) {
          setClouds((prev) => topUp(driftAndPrune(prev), minCount, maxCount, isSurvival))
        }
      }
    }

    const interval = window.setInterval(moveClouds, moveIntervalMs)
    return () => window.clearInterval(interval)
    // currentRoom?.mode (not the whole currentRoom object, which changes reference on every cloud
    // write) is the only new dependency - it needs to restart the interval with the right period
    // when a room transitions into/out of Survival, same looseness the rest of this effect already
    // had toward currentRoom/isRoomHost/clouds/updateRoom (all read via closure, not listed here).
  }, [wind, currentRoom?.mode])

  useEffect(() => {
    // Initialize default clouds for solo usage; room-host will overwrite when appropriate
    const anchor = pickedSpawn || CONFIG.startPosition
    const spawn = (bearing, distance) => {
      const [lat, lng] = offsetLatLng([anchor.lat, anchor.lng], bearing, distance)
      return {
        id: crypto.randomUUID(),
        lat,
        lng,
        radiusMeters: randomSmallCloudRadius(),
        tier: randomCloudTier(),
        createdAt: Date.now(),
        lifetimeMs: randomCloudLifetimeMs()
      }
    }
    setClouds([spawn(40, 350), spawn(200, 500)])
  }, [])

  // Non-host clients should mirror the room's cloud list when available
  useEffect(() => {
    if (!currentRoom) return
    if (!isRoomHost && Array.isArray(currentRoom.clouds)) {
      setClouds(currentRoom.clouds)
    }
  }, [currentRoom, isRoomHost])

  

  const getRoomCapacity = (roomMode) => MODE_CONFIG[roomMode]?.maxPlayers ?? 4

  // Reads from roomsRef (kept synchronously fresh by useRoomSync on every updateRooms call, not
  // just on the next render) instead of the closed-over `rooms` state - confirmed as the actual
  // root cause of a real data-loss bug: two Finder items found close together (well within a
  // single animation frame, before React had re-rendered with the first find's result) could
  // race, with the second updateRoom call computing its diff from a rooms snapshot that predated
  // the first item's find, silently overwriting it (seen live as "found 2 items, then a few
  // seconds later it reverted to 1"). This also makes updateRoom referentially stable forever
  // (roomsRef and setRooms never change identity), which is the deeper fix - nothing holding a
  // reference to it (liveRef included) can ever go stale in the first place.
  const updateRoom = useCallback(
    (roomCodeToUpdate, roomUpdater) => {
      const nextRooms = roomsRef.current.map((room) => (room.code === roomCodeToUpdate ? roomUpdater(room) : room))
      setRooms(nextRooms)
    },
    [setRooms, roomsRef]
  )


  // Builds the fresh per-round fields (players reset, items, It, round start timestamp) - used by
  // startRoom, keyed off MODE_CONFIG so it generalizes to whichever mode the room is running
  // instead of special-casing survival.
  const buildRoundState = useCallback(
    (players, roomMode) => {
      const { players: nextPlayers, itName } = resetPlayersForRound(players, roomMode)
      const isFinder = isFinderMode(roomMode)
      // Uniform across the whole playable bbox (not anchored to any one player's spawn) - a room
      // has multiple players starting at different points, so biasing toward a single anchor
      // unfairly favored whoever's position happened to trigger the round build. Bun-bun is the
      // one exception even here: it hides near a random corner of the play area for the whole
      // round (see ITEM_BEHAVIORS) and never moves once placed, unlike every other roaming item.
      const items = isFinder && graph
        ? pickRoundFinderItems(10).map((def, i) => {
            const behavior = ITEM_BEHAVIORS[def.id]
            let pt = null
            if (behavior?.type === 'hidden-corner') {
              const corners = [
                [CONFIG.bbox.north, CONFIG.bbox.west],
                [CONFIG.bbox.north, CONFIG.bbox.east],
                [CONFIG.bbox.south, CONFIG.bbox.west],
                [CONFIG.bbox.south, CONFIG.bbox.east]
              ]
              const corner = corners[Math.floor(Math.random() * corners.length)]
              pt = pickRandomStreetPoint(graph, { near: corner, maxDistanceMeters: 4000 })
            }
            pt = pt || pickRandomStreetPoint(graph) || defaultPosition
            return { id: `item-${i}-${crypto.randomUUID()}`, iconId: def.id, label: def.label, lat: pt.lat, lng: pt.lng, foundBy: null }
          })
        : []
      // Survival starts with a dense swarm of small clouds scattered across the bbox instead of
      // waiting for the ambient spawner to slowly build up from empty - matches
      // CLOUD_MIN_COUNT_SURVIVAL so the round is immediately as dense as it'll stay all round,
      // rather than feeling sparse for the first couple minutes while the tick spawner catches up.
      const clouds =
        roomMode === 'survival'
          ? Array.from({ length: CLOUD_MIN_COUNT_SURVIVAL }, () => {
              const { lat, lng } = randomPointInBbox()
              return {
                id: crypto.randomUUID(),
                lat,
                lng,
                radiusMeters: randomSmallCloudRadius(2),
                tier: randomCloudTier(),
                createdAt: Date.now(),
                lifetimeMs: randomCloudLifetimeMs()
              }
            })
          : []
      return { players: nextPlayers, itName, items, roundStartedAt: Date.now(), clouds }
    },
    [graph]
  )

  // Survival round resolution (host-only): once the 10-minute mark passes, tally each player's
  // last-known health (self from healthRef, others from their last broadcast) and resolve the
  // winner(s) by max health - ties are explicitly allowed ("double winners").
  useEffect(() => {
    if (!isRoomHost || currentRoom?.mode !== 'survival' || currentRoom.status !== 'playing' || !currentRoom.roundStartedAt) return
    const durationMs = MODE_CONFIG.survival.roundDurationMs
    const interval = window.setInterval(() => {
      if (Date.now() - currentRoom.roundStartedAt < durationMs) return
      const live = liveRef.current
      const finalHealth = {}
      // NPCs now take real cloud damage/regen too (see the ambient NPC tick effect), but still
      // can't WIN - a bot getting randomly lucky and coasting at high health shouldn't beat a real
      // player who actually played well, so they're excluded here regardless of their health.
      for (const p of currentRoom.players.filter((p) => !p.isNpc)) {
        finalHealth[p.name] = p.name === name ? healthRef.current : live.livePositions[p.name]?.health ?? p.health ?? 0
      }
      const maxHealth = Math.max(...Object.values(finalHealth))
      updateRoom(currentRoom.code, (room) => ({
        ...room,
        status: 'finished',
        winners: room.players.filter((p) => finalHealth[p.name] === maxHealth).map((p) => p.name),
        players: room.players.map((p) => (p.isNpc ? p : { ...p, health: finalHealth[p.name] }))
      }))
    }, 1000)
    return () => window.clearInterval(interval)
  }, [isRoomHost, currentRoom, name, updateRoom])

  // Survival deadline eliminations (host-only): forces the round to actually end for stragglers
  // instead of everyone idling to 10 minutes untouched (with 100 players and thick cloud cover,
  // literal idling was still winnable without this). Thresholds tighten over time - 50 HP at
  // 2min, 100 at 5min, 200 at 8min - checked continuously against CURRENT health every tick, not
  // just a one-time snapshot at the exact minute mark, so dropping below the active threshold at
  // any point during its window gets you cut, not just exactly at :00. NPCs are eliminated the
  // same as real players now that they take real cloud damage too.
  useEffect(() => {
    if (!isRoomHost || currentRoom?.mode !== 'survival' || currentRoom.status !== 'playing' || !currentRoom.roundStartedAt) return
    const interval = window.setInterval(() => {
      const elapsedMs = Date.now() - currentRoom.roundStartedAt
      const threshold = elapsedMs >= 8 * 60000 ? 200 : elapsedMs >= 5 * 60000 ? 100 : elapsedMs >= 2 * 60000 ? 50 : null
      if (threshold == null) return
      const live = liveRef.current
      const healthFor = (p) => (p.name === name ? healthRef.current : live.livePositions[p.name]?.health ?? p.health ?? 1000)
      let changed = false
      const nextPlayers = currentRoom.players.map((p) => {
        if (p.eliminated || healthFor(p) >= threshold) return p
        changed = true
        return { ...p, eliminated: true }
      })
      if (changed) updateRoom(currentRoom.code, (room) => ({ ...room, players: nextPlayers }))
    }, 1000)
    return () => window.clearInterval(interval)
  }, [isRoomHost, currentRoom, name, updateRoom])

  // Tag round resolution (host-only): either It eliminates every other player ("It won") or the
  // 10-minute mark passes first ("It lost", every still-alive non-It player wins).
  useEffect(() => {
    if (!isRoomHost || currentRoom?.mode !== 'tag' || currentRoom.status !== 'playing' || !currentRoom.roundStartedAt) return
    // NPCs are ambient-only (v1) and never eligible to be It (see resetPlayersForRound), so they're
    // excluded here too - an ambient bot just wandering around shouldn't count as a "survivor".
    const others = currentRoom.players.filter((p) => p.name !== currentRoom.itName && !p.isNpc)
    if (others.length && others.every((p) => p.eliminated)) {
      updateRoom(currentRoom.code, (room) => (room.status === 'finished' ? room : { ...room, status: 'finished', winners: [room.itName] }))
      return
    }
    const durationMs = MODE_CONFIG.tag.roundDurationMs
    const interval = window.setInterval(() => {
      if (Date.now() - currentRoom.roundStartedAt < durationMs) return
      updateRoom(currentRoom.code, (room) => {
        if (room.status === 'finished') return room
        const survivors = room.players.filter((p) => p.name !== room.itName && !p.eliminated && !p.isNpc)
        return { ...room, status: 'finished', winners: survivors.map((p) => p.name) }
      })
    }, 1000)
    return () => window.clearInterval(interval)
  }, [isRoomHost, currentRoom, updateRoom])

  const startRoom = useCallback(() => {
    if (!currentRoom || !isRoomHost) return
    const cfg = MODE_CONFIG[currentRoom.mode]
    // Survival auto-fills with NPCs up to a fixed total instead of requiring them to be added
    // manually ("Add NPC" is disabled for this mode - see its button below) - a solo host gets 99
    // bots, a host + 5 friends gets 94, etc.
    let basePlayers = currentRoom.players
    if (cfg.fixedPlayerCount) {
      const fillCount = Math.max(0, cfg.fixedPlayerCount - basePlayers.length)
      const usedNames = basePlayers.map((p) => p.name)
      const filled = []
      for (let i = 0; i < fillCount; i++) {
        const npcName = pickNpcName(usedNames)
        usedNames.push(npcName)
        filled.push({
          name: npcName,
          color: CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)],
          avatarId: AVATAR_ICONS[Math.floor(Math.random() * AVATAR_ICONS.length)].id,
          eliminated: false,
          isNpc: true
        })
      }
      basePlayers = [...basePlayers, ...filled]
    }
    const enoughPlayers = basePlayers.length >= cfg.minPlayers
    const roundExtras = enoughPlayers ? buildRoundState(basePlayers, currentRoom.mode) : null
    const nextRoom = {
      ...currentRoom,
      status: enoughPlayers ? 'playing' : 'waiting',
      players: roundExtras ? roundExtras.players : basePlayers,
      itName: roundExtras ? roundExtras.itName : null,
      items: roundExtras ? roundExtras.items : [],
      clouds: roundExtras ? roundExtras.clouds : currentRoom.clouds,
      roundStartedAt: roundExtras ? roundExtras.roundStartedAt : null,
      winners: []
    }
    updateRoom(currentRoom.code, () => nextRoom)
    setEliminated(false)
    setStarted(nextRoom.status === 'playing')
  }, [currentRoom, isRoomHost, updateRoom, buildRoundState])

  const stopRoom = useCallback(() => {
    if (!currentRoom || !isRoomHost) return
    const nextRoom = {
      ...currentRoom,
      status: MODE_CONFIG[currentRoom.mode]?.hostGatedStart ? 'finished' : 'waiting'
    }
    updateRoom(currentRoom.code, () => nextRoom)
    setStarted(false)
  }, [currentRoom, isRoomHost, updateRoom])

  const leaveRoom = useCallback(() => {
    if (!joinedRoomCode) return

    const room = roomsRef.current.find((r) => r.code === joinedRoomCode)
    if (!room) {
      setJoinedRoomCode(null)
      setStarted(false)
      setRoomCode('')
      return
    }
    const remainingPlayers = room.players.filter((player) => player.name !== name)
    // NPCs can never be host (only a real player's own client ever simulates them, so an
    // NPC-only room has no one left to run anything anyway) - the actual "is anyone left"
    // check is about remaining HUMANS, not the raw players array.
    const remainingHumans = remainingPlayers.filter((player) => !player.isNpc)
    if (!remainingHumans.length) {
      // Explicit delete for the one room actually being emptied - updateRooms/setRooms no longer
      // infers deletion from omission (see roomSync.js), so this can't accidentally take any
      // other room down with it.
      deleteRoom(joinedRoomCode)
    } else {
      const cfg = MODE_CONFIG[room.mode]
      const nextRoom = {
        ...room,
        players: remainingPlayers,
        status: !cfg?.hostGatedStart
          ? remainingPlayers.length >= cfg?.minPlayers
            ? 'playing'
            : 'waiting'
          : remainingPlayers.length >= cfg.minPlayers
          ? room.status
          : 'finished'
      }
      if (room.host === name) {
        nextRoom.host = remainingHumans[0].name
      }
      setRooms(roomsRef.current.map((r) => (r.code === joinedRoomCode ? nextRoom : r)))
    }

    setJoinedRoomCode(null)
    setStarted(false)
    // Otherwise the Room Code field still shows the room you just left, so clicking "Create room"
    // immediately after reuses that same code and just alerts "already exists" - clearing it back
    // to blank means Create room auto-generates a fresh one by default, matching how it behaves
    // the very first time (see createRoom's `roomCode.trim() || generateRoomCode()`).
    setRoomCode('')
  }, [joinedRoomCode, name, setRooms, roomsRef, deleteRoom])

  useEffect(() => {
    leaveRoomRef.current = leaveRoom
  }, [leaveRoom])

  const createRoom = useCallback(() => {
    const sanitizedName = name.trim() || 'Player'
    const code = roomCode.trim().toUpperCase() || generateRoomCode()
    // Reads roomsRef (synchronously fresh, see updateRoom above) instead of the closed-over
    // `rooms` state - confirmed as the likely cause of "create twice, kicks everyone out": if
    // Create was clicked again before React had re-rendered with the first click's result, the
    // closed-over `rooms` was still the PRE-create snapshot, and `[...stale_rooms, newRoom]`
    // silently dropped whatever the first create (or any other room) had just added.
    const existing = roomsRef.current.find((room) => room.code === code)
    if (existing) {
      alert('Room code already exists. Pick another code or join this room.')
      return
    }

    const newRoom = {
      code,
      mode,
      host: sanitizedName,
      status: MODE_CONFIG[mode]?.hostGatedStart ? 'waiting' : 'playing',
      createdAt: Date.now(),
      players: [{ name: sanitizedName, color: selectedColor, avatarId: selectedAvatarId, eliminated: false }],
      clouds: [],
      items: [],
      itName: null,
      roundStartedAt: null,
      winners: [],
      maxPlayers: getRoomCapacity(mode)
    }

    setRooms([...roomsRef.current, newRoom])
    setJoinedRoomCode(code)
    setRoomCode(code)
    setStarted(!MODE_CONFIG[mode]?.hostGatedStart)
  }, [mode, name, roomCode, selectedColor, selectedAvatarId, setRooms, roomsRef])

  const joinRoom = useCallback(
    (codeToJoin) => {
      const code = codeToJoin?.trim().toUpperCase() || roomCode.trim().toUpperCase()
      if (!code) {
        alert('Enter a room code to join.')
        return
      }
      // roomsRef instead of the closed-over `rooms` state, same reasoning/fix as createRoom above
      // - confirmed as the likely cause of "join twice, kicks you out": a stale `rooms` snapshot
      // here could compute nextRooms from before some other pending update landed, dropping it.
      const room = roomsRef.current.find((item) => item.code === code)
      if (!room) {
        alert('Room not found.')
        return
      }
      const sanitizedName = name.trim() || 'Player'
      if (room.players.some((player) => player.name === sanitizedName)) {
        setJoinedRoomCode(code)
        setMode(room.mode)
        setStarted((room.status === 'playing' || room.status === 'finished') && !currentPlayer?.eliminated)
        return
      }
      if (MODE_CONFIG[room.mode]?.hostGatedStart && room.status === 'playing') {
        alert('This round has already started.')
        return
      }
      if (MODE_CONFIG[room.mode]?.hostGatedStart && room.status === 'finished') {
        alert('This round has already finished.')
        return
      }
      if (room.players.length >= room.maxPlayers) {
        alert('This room is full.')
        return
      }

      const newPlayer = {
        name: sanitizedName,
        color: selectedColor,
        avatarId: selectedAvatarId,
        eliminated: false
      }

      const nextRoom = {
        ...room,
        players: [...room.players, newPlayer],
        // Host-gated modes (survival/finder/tag) stay whatever they already were - only the host's
        // Start click should flip 'waiting' to 'playing'. Team has no host gate, so joining always
        // drops straight into the drive.
        status: MODE_CONFIG[room.mode]?.hostGatedStart ? room.status : 'playing'
      }

      const nextRooms = roomsRef.current.map((item) => (item.code === code ? nextRoom : item))
      setRooms(nextRooms)
      setJoinedRoomCode(code)
      setMode(room.mode)
      setStarted(nextRoom.status === 'playing')
    },
    [roomCode, selectedColor, selectedAvatarId, name, currentPlayer, setRooms, roomsRef]
  )

  // Host-only: adds one ambient NPC driver to the room roster. Reads roomsRef (not the closed-over
  // `currentRoom`) for the same reason createRoom/joinRoom do - see their comments above.
  const addNpc = useCallback(() => {
    if (!joinedRoomCode) return
    const room = roomsRef.current.find((r) => r.code === joinedRoomCode)
    if (!room || room.host !== name) return
    // Matches the same restriction real players already have (joinRoom blocks joining a
    // host-gated round mid-play) - Team has no lobby gate at all, so it's exempt, same as humans.
    if (MODE_CONFIG[room.mode]?.hostGatedStart && room.status === 'playing') {
      alert("Can't add players once the round has started.")
      return
    }
    if (room.players.length >= room.maxPlayers) {
      alert('This room is full.')
      return
    }
    const newNpc = {
      name: pickNpcName(room.players.map((p) => p.name)),
      color: CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)],
      avatarId: AVATAR_ICONS[Math.floor(Math.random() * AVATAR_ICONS.length)].id,
      eliminated: false,
      isNpc: true
    }
    const nextRoom = { ...room, players: [...room.players, newNpc] }
    setRooms(roomsRef.current.map((r) => (r.code === joinedRoomCode ? nextRoom : r)))
  }, [joinedRoomCode, name, setRooms, roomsRef])

  const removeNpc = useCallback(
    (npcName) => {
      if (!joinedRoomCode) return
      const room = roomsRef.current.find((r) => r.code === joinedRoomCode)
      if (!room || room.host !== name) return
      const nextRoom = { ...room, players: room.players.filter((p) => p.name !== npcName) }
      setRooms(roomsRef.current.map((r) => (r.code === joinedRoomCode ? nextRoom : r)))
      delete npcSimRef.current[npcName]
      setLivePositions((prev) => {
        if (!(npcName in prev)) return prev
        const next = { ...prev }
        delete next[npcName]
        return next
      })
    },
    [joinedRoomCode, name, setRooms, roomsRef]
  )

  // Host-only ambient NPC movement (v1: real graph-based driving, random turn at every
  // intersection, no effect on scoring - see the mode-config/win-condition NPC exclusions above).
  // Reads the room roster from liveRef (not the closed-over `currentRoom`) so this effect doesn't
  // need to restart on every room update - same pattern the movement/cloud-spawn loops already use.
  useEffect(() => {
    if (!isRoomHost || !joinedRoomCode || !graph) return
    const interval = window.setInterval(() => {
      const room = liveRef.current.currentRoom
      if (!room) return
      const npcs = room.players.filter((p) => p.isNpc)
      const activeNames = new Set(npcs.map((p) => p.name))
      for (const key of Object.keys(npcSimRef.current)) {
        if (!activeNames.has(key)) delete npcSimRef.current[key]
      }
      if (!npcs.length) return

      const dt = NPC_TICK_MS / 1000
      const isSurvival = room.mode === 'survival'
      // Batched into ONE broadcast per tick instead of one per NPC - with Survival's 99-bot rooms,
      // one message per NPC at a 200ms tick meant up to ~500 broadcast sends/second, which blew
      // through Supabase's realtime rate limit (429s) and, since that limit is project-wide rather
      // than per-room, was degrading every other concurrent game too (reported: Finder sessions
      // hitting the same 429s from an entirely different room).
      const batch = []
      for (const npc of npcs) {
        let sim = npcSimRef.current[npc.name]
        if (!sim) {
          const edges = Array.from(graph.edges.values())
          if (!edges.length) continue
          const edge = edges[Math.floor(Math.random() * edges.length)]
          sim = {
            edgeId: edge.id,
            distanceAlong: Math.random() * edge.lengthMeters,
            direction: Math.random() < 0.5 ? 1 : -1,
            health: npc.health ?? 1000
          }
        }
        const edge = graph.edges.get(sim.edgeId)
        if (!edge) {
          delete npcSimRef.current[npc.name]
          continue
        }

        const metersPerSecond = (edge.speedKmh * 2) / 3.6
        let nextDistanceAlong = sim.distanceAlong + metersPerSecond * dt * sim.direction
        let nextDirection = sim.direction
        let nextEdge = edge

        const overflowing = sim.direction === 1 ? nextDistanceAlong > edge.lengthMeters : nextDistanceAlong < 0
        if (overflowing) {
          const remainder = sim.direction === 1 ? nextDistanceAlong - edge.lengthMeters : -nextDistanceAlong
          const exitNodeKey = sim.direction === 1 ? edge.endKey : edge.startKey
          const picked = pickRandomNextSegment(graph, exitNodeKey, edge)
          if (picked) {
            nextEdge = picked
            const entry = resolveEdgeEntry(picked, exitNodeKey, remainder)
            nextDistanceAlong = entry.distanceAlong
            nextDirection = entry.direction
          } else {
            // True dead end (rare) - bounce back the way it came rather than getting stuck.
            nextDistanceAlong = sim.direction === 1 ? edge.lengthMeters : 0
            nextDirection = -sim.direction
          }
        }

        const [lat, lng] = getSegmentPosition(nextEdge, nextDistanceAlong)
        // Same cloud damage/regen rules as a real player (see the mode-specific tick effect
        // above) - NPCs used to just drive straight through clouds with no effect, which broke
        // the "50 bots to beat" premise since they'd always sit at full health regardless.
        let nextHealth = sim.health ?? 1000
        if (isSurvival) {
          const hitClouds = (liveRef.current.clouds || []).filter(
            (c) => c.tier && haversine([lat, lng], [c.lat, c.lng]) <= c.radiusMeters
          )
          if (hitClouds.length) {
            const worst = hitClouds.reduce((a, b) => (CLOUD_DAMAGE_PER_SEC[b.tier] > CLOUD_DAMAGE_PER_SEC[a.tier] ? b : a))
            nextHealth = Math.max(0, nextHealth - CLOUD_DAMAGE_PER_SEC[worst.tier] * dt)
          } else {
            nextHealth = Math.min(1000, nextHealth + (1 / 3) * dt)
          }
        }

        npcSimRef.current[npc.name] = { edgeId: nextEdge.id, distanceAlong: nextDistanceAlong, direction: nextDirection, health: nextHealth }
        batch.push({ name: npc.name, lat, lng, health: nextHealth })
      }
      if (!batch.length) return
      // One broadcast for every other client, and update this (the host's) own local view
      // directly - Realtime broadcast channels don't echo back to the sender by default, and NPCs
      // have no other rendering path (unlike the host's own car, which renders straight from
      // local state).
      roomChannelRef.current?.send({ type: 'broadcast', event: 'positions-batch', payload: batch })
      setLivePositions((prev) => {
        const next = { ...prev }
        for (const p of batch) next[p.name] = p
        return next
      })
    }, NPC_TICK_MS)
    return () => window.clearInterval(interval)
  }, [isRoomHost, joinedRoomCode, graph])

  // Host-only roaming Finder item movement (Finder (Roaming) only) - each item drives using
  // whichever personality ITEM_BEHAVIORS gives it (see pickNextForBehavior). Bun-bun is excluded
  // entirely (type 'hidden-corner') - it never moves once placed at round start, so it never needs
  // a broadcast at all; its round-start spawn point in room.items already is its final position.
  useEffect(() => {
    if (!isRoomHost || !joinedRoomCode || !graph) return
    const interval = window.setInterval(() => {
      const room = liveRef.current.currentRoom
      if (!room || room.mode !== 'finder-roaming' || room.status !== 'playing') return
      const items = (room.items || []).filter((item) => ITEM_BEHAVIORS[item.iconId]?.type !== 'hidden-corner')
      const activeIds = new Set(items.map((item) => item.id))
      for (const key of Object.keys(itemSimRef.current)) {
        if (!activeIds.has(key)) delete itemSimRef.current[key]
      }
      if (!items.length) return

      const dt = ITEM_TICK_MS / 1000
      // Batched into ONE broadcast per tick instead of one per item, same fix as the NPC tick
      // effect above (up to 10 items every 200ms was still 50 sends/second, contributing to the
      // same Supabase realtime rate-limit problem).
      const batch = []
      for (const item of items) {
        const behavior = ITEM_BEHAVIORS[item.iconId] || { type: 'ambient' }
        let sim = itemSimRef.current[item.id]
        if (!sim) {
          // Home-anchor items (Flora, Jasper) must SPAWN near their anchor too, not anywhere in
          // the city - picking a fully random starting edge first (then trying to walk it home
          // over time) let them start many kilometers away, which the radius-containment logic
          // then spent the whole round just walking back from instead of actually staying put.
          let edges = Array.from(graph.edges.values())
          let anchorCoord = null
          if (behavior.type === 'home-anchor') {
            anchorCoord = resolveAnchorCoord(graph, behavior)
            const nearby = edges.filter((e) => {
              const farNode = graph.nodes.get(e.endKey)
              return farNode && haversine(anchorCoord, farNode.coord) <= behavior.radiusMeters
            })
            if (nearby.length) edges = nearby
          }
          if (!edges.length) continue
          const edge = edges[Math.floor(Math.random() * edges.length)]
          sim = { edgeId: edge.id, distanceAlong: Math.random() * edge.lengthMeters, direction: Math.random() < 0.5 ? 1 : -1 }
          if (anchorCoord) sim.anchorCoord = anchorCoord
          itemSimRef.current[item.id] = sim
        }

        // Napping (Flora): frozen in place until napUntil passes, but still broadcasts its current
        // spot so it doesn't just vanish from other players' screens while asleep.
        if (sim.napUntil && Date.now() < sim.napUntil) {
          const edge = graph.edges.get(sim.edgeId)
          if (edge) {
            const [lat, lng] = getSegmentPosition(edge, sim.distanceAlong)
            batch.push({ itemId: item.id, lat, lng })
          }
          continue
        }

        const edge = graph.edges.get(sim.edgeId)
        if (!edge) {
          delete itemSimRef.current[item.id]
          continue
        }

        // Huskynouche re-rolls its speed tier on a random cadence instead of holding one fixed
        // multiplier - 0 genuinely stops it dead (metersPerSecond becomes 0 below), no separate
        // freeze/nap logic needed for that.
        let speedMultiplier = behavior.speedMultiplier ?? 1
        let speedChangeAt = sim.speedChangeAt
        if (behavior.type === 'variable-speed') {
          if (!speedChangeAt || Date.now() >= speedChangeAt) {
            const tiers = behavior.speedTiers ?? [1]
            speedMultiplier = tiers[Math.floor(Math.random() * tiers.length)]
            speedChangeAt = Date.now() + behavior.speedChangeMinMs + Math.random() * (behavior.speedChangeMaxMs - behavior.speedChangeMinMs)
          } else {
            speedMultiplier = sim.speedMultiplier ?? 1
          }
        }
        const metersPerSecond = (edge.speedKmh * 2 * speedMultiplier) / 3.6
        let nextDistanceAlong = sim.distanceAlong + metersPerSecond * dt * sim.direction
        let nextDirection = sim.direction
        let nextEdge = edge
        let nextNapUntil = sim.napUntil

        const overflowing = sim.direction === 1 ? nextDistanceAlong > edge.lengthMeters : nextDistanceAlong < 0
        if (overflowing) {
          const remainder = sim.direction === 1 ? nextDistanceAlong - edge.lengthMeters : -nextDistanceAlong
          const exitNodeKey = sim.direction === 1 ? edge.endKey : edge.startKey
          const picked = pickNextForBehavior(graph, exitNodeKey, edge, behavior, sim)
          if (picked) {
            nextEdge = picked
            const entry = resolveEdgeEntry(picked, exitNodeKey, remainder)
            nextDistanceAlong = entry.distanceAlong
            nextDirection = entry.direction
          } else {
            nextDistanceAlong = sim.direction === 1 ? edge.lengthMeters : 0
            nextDirection = -sim.direction
          }
          if (behavior.type === 'home-anchor' && behavior.napMinMs) {
            nextNapUntil = Date.now() + behavior.napMinMs + Math.random() * (behavior.napMaxMs - behavior.napMinMs)
          }
        }

        itemSimRef.current[item.id] = {
          ...sim,
          edgeId: nextEdge.id,
          distanceAlong: nextDistanceAlong,
          direction: nextDirection,
          napUntil: nextNapUntil,
          speedMultiplier,
          speedChangeAt
        }
        const [lat, lng] = getSegmentPosition(nextEdge, nextDistanceAlong)
        batch.push({ itemId: item.id, lat, lng })
      }
      if (!batch.length) return
      roomChannelRef.current?.send({ type: 'broadcast', event: 'item-positions-batch', payload: batch })
      setLiveItemPositions((prev) => {
        const next = { ...prev }
        for (const p of batch) next[p.itemId] = p
        return next
      })
    }, ITEM_TICK_MS)
    return () => window.clearInterval(interval)
  }, [isRoomHost, joinedRoomCode, graph])

  // "Join" from ChatPanel: App and ChatPanel are sibling components with no shared state, so
  // main.jsx lifts one small piece of cross-component command state - `joinRequest` - and this
  // effect just forwards it into the existing joinRoom flow (which already applies every normal
  // join rule: full-room/already-started checks, etc).
  const lastJoinRequestRef = useRef(null)
  useEffect(() => {
    if (!joinRequest || joinRequest.ts === lastJoinRequestRef.current) return
    lastJoinRequestRef.current = joinRequest.ts
    joinRoom(joinRequest.code)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joinRequest])

  const addCloud = () => {
    if (cloudCooldown || eliminated) return
    // Deliberately a big cloud (see randomBigCloudRadius) placed randomly across the whole bbox,
    // not anchored near whoever clicked - "add cloud should add a pretty big cloud too somewhere
    // in the bbox" per direct feedback, distinct from the small ambient field.
    const isSurvival = currentRoom?.mode === 'survival'
    const radiusMeters = randomBigCloudRadius(isSurvival ? 2 : 1)
    let lat, lng
    for (let attempt = 0; attempt < 10; attempt++) {
      ;({ lat, lng } = randomPointInBbox())
      if (!isTooCloseToAnyPlayer(lat, lng, radiusMeters)) break
    }
    const newCloud = {
      id: crypto.randomUUID(),
      lat,
      lng,
      radiusMeters,
      tier: randomCloudTier(),
      createdAt: Date.now(),
      lifetimeMs: randomCloudLifetimeMs()
    }
    const maxCount = isSurvival ? CLOUD_MAX_COUNT_SURVIVAL : CLOUD_MAX_COUNT
    // Any room member can add one - not just the host. Non-host clients used to only update their
    // own local `clouds` state, which the very next room sync (mirroring the host's authoritative
    // list) silently overwrote, making the button appear to do nothing.
    if (currentRoom) {
      updateRoom(currentRoom.code, (room) => ({ ...room, clouds: [...(room.clouds || []), newCloud].slice(-maxCount) }))
    } else {
      setClouds((prev) => [...prev, newCloud].slice(-maxCount))
    }
    setCloudCooldown(true)
    window.setTimeout(() => setCloudCooldown(false), 10000)
  }

  // Roster fields (color/eliminated) come from the persisted room; live lat/lng comes from the
  // broadcast channel above - a player has no dot until their first broadcast arrives.
  const screenPlayers = useMemo(() => {
    if (!currentRoom || !mapRef.current) return []
    try {
      const map = mapRef.current
      const container = map.getContainer()
      const width = container.clientWidth
      const height = container.clientHeight
      // Eliminated players (caught in Tag) are removed from the map entirely, not just dimmed -
      // once you're out, you're out, same as how a Tag round already treats you (see
      // "Tagged! Watch for the next round.").
      return currentRoom.players
        .filter((p) => p.name !== name && !p.eliminated && livePositions[p.name])
        .map((p) => {
          const live = livePositions[p.name]
          const point = map.project([live.lng, live.lat])
          return {
            name: p.name,
            color: p.color,
            avatarId: p.avatarId,
            nextTurn: live.nextTurn,
            screenX: (point.x / width) * 100,
            screenY: (point.y / height) * 100
          }
        })
    } catch {
      return []
    }
    // mapViewTick has no value of its own - it exists purely to re-run this on every map
    // move/zoom/pan, not just when the underlying room/player data changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentRoom, name, livePositions, mapViewTick])

  // Survival's old "touch a cloud = instant out" collision check lived here; it's replaced by the
  // continuous health damage/regen loop in the movement tick effect below, which also drives the
  // 10-minute win-by-health resolution instead of a last-survivor check.

  // Finder (Easy) only - item markers on the map, same project-to-% recipe as screenPlayers above.
  // Hard mode simply never computes this, which is the entire easy/hard visibility difference.
  const screenItems = useMemo(() => {
    if (!showsItemIcons(currentRoom?.mode) || !mapRef.current) return []
    try {
      const map = mapRef.current
      const container = map.getContainer()
      const width = container.clientWidth
      const height = container.clientHeight
      const foundIds = currentPlayer?.foundItems || []
      return (currentRoom.items || [])
        .filter((item) => !foundIds.includes(item.id))
        .map((item) => {
          // Roaming items' real position is wherever they've actually walked to (broadcast) - the
          // stored lat/lng is just the round-start spawn, stale the instant a roaming item moves.
          const live = liveItemPositions[item.id]
          const lat = live?.lat ?? item.lat
          const lng = live?.lng ?? item.lng
          const point = map.project([lng, lat])
          return { id: item.id, iconId: item.iconId, label: item.label, screenX: (point.x / width) * 100, screenY: (point.y / height) * 100 }
        })
    } catch {
      return []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentRoom, currentPlayer, liveItemPositions, mapViewTick])

  // Off-screen "radar" indicators - Finder (Easy) items not currently on-screen, and in Tag
  // whichever direction actually matters for the player driving right now: It sees every other
  // real (non-eliminated, non-NPC) player as prey, everyone else sees only It as the threat to
  // avoid. Reuses the same map.project() pixel projection screenItems/screenPlayers already do.
  const radarTargets = useMemo(() => {
    if (!currentRoom || !mapRef.current) return []
    const showsIcons = showsItemIcons(currentRoom.mode)
    const isTag = currentRoom.mode === 'tag'
    if (!showsIcons && !isTag) return []
    try {
      const map = mapRef.current
      const container = map.getContainer()
      const width = container.clientWidth
      const height = container.clientHeight
      const margin = 44
      const targets = []

      if (showsIcons) {
        const foundIds = currentPlayer?.foundItems || []
        for (const item of currentRoom.items || []) {
          if (foundIds.includes(item.id)) continue
          const live = liveItemPositions[item.id]
          const point = map.project([live?.lng ?? item.lng, live?.lat ?? item.lat])
          const edge = computeEdgeIndicator(point.x, point.y, width, height, margin)
          if (!edge) continue
          targets.push({
            key: `item-${item.id}`,
            kind: 'item',
            iconId: item.iconId,
            screenX: (edge.x / width) * 100,
            screenY: (edge.y / height) * 100,
            angleDeg: edge.angleDeg
          })
        }
      }

      if (isTag) {
        const amIt = currentRoom.itName === name
        if (amIt) {
          for (const p of currentRoom.players) {
            if (p.name === name || p.isNpc || p.eliminated) continue
            const pos = livePositions[p.name]
            if (!pos) continue
            const point = map.project([pos.lng, pos.lat])
            const edge = computeEdgeIndicator(point.x, point.y, width, height, margin)
            if (!edge) continue
            targets.push({
              key: `prey-${p.name}`,
              kind: 'prey',
              color: p.color,
              screenX: (edge.x / width) * 100,
              screenY: (edge.y / height) * 100,
              angleDeg: edge.angleDeg
            })
          }
        } else if (!eliminated) {
          const itPos = livePositions[currentRoom.itName]
          if (itPos) {
            const point = map.project([itPos.lng, itPos.lat])
            const edge = computeEdgeIndicator(point.x, point.y, width, height, margin)
            if (edge) {
              targets.push({
                key: 'it',
                kind: 'it',
                screenX: (edge.x / width) * 100,
                screenY: (edge.y / height) * 100,
                angleDeg: edge.angleDeg
              })
            }
          }
        }
      }

      return targets
    } catch {
      return []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentRoom, currentPlayer, name, eliminated, livePositions, liveItemPositions, mapViewTick])

  const itemDistances = useMemo(() => {
    if (!isFinderMode(currentRoom?.mode)) return []
    const foundIds = currentPlayer?.foundItems || []
    return (currentRoom.items || [])
      .map((item) => {
        const live = liveItemPositions[item.id]
        const lat = live?.lat ?? item.lat
        const lng = live?.lng ?? item.lng
        return { ...item, found: foundIds.includes(item.id), distanceMeters: haversine([position.lat, position.lng], [lat, lng]) }
      })
      .sort((a, b) => (a.found === b.found ? a.distanceMeters - b.distanceMeters : a.found ? 1 : -1))
  }, [currentRoom, currentPlayer, position, liveItemPositions])

  const roundRemainingLabel = useMemo(() => {
    const durationMs = currentRoom ? MODE_CONFIG[currentRoom.mode]?.roundDurationMs : null
    if (!durationMs || !currentRoom?.roundStartedAt || currentRoom.status !== 'playing') return null
    const remainingMs = Math.max(0, durationMs - (Date.now() - currentRoom.roundStartedAt))
    const totalSeconds = Math.ceil(remainingMs / 1000)
    const mm = Math.floor(totalSeconds / 60)
    const ss = String(totalSeconds % 60).padStart(2, '0')
    return `${mm}:${ss}`
    // clockTick has no value of its own - it exists purely to re-trigger this memo every second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentRoom?.roundStartedAt, currentRoom?.status, currentRoom?.mode, clockTick])

  // Survival's wind is 10x (capped) what's actually stored in `wind` state (see the cloud-drift
  // effect and survivalWindSpeedKmh) - this is purely the matching display value so the on-screen
  // label doesn't undersell how fast clouds are actually moving.
  const displayWind = useMemo(
    () => (currentRoom?.mode === 'survival' ? { ...wind, speed: survivalWindSpeedKmh(wind.speed) } : wind),
    [wind, currentRoom?.mode]
  )

  // Room status/roster/items - shown both inside the pre-drive setup modal (so the host's Start
  // button is actually reachable while waiting for players, not hidden behind the modal) and in
  // the normal sidebar position once driving. Built once, referenced in whichever of those two
  // mutually-exclusive spots applies.
  const roomMinPlayers = currentRoom ? MODE_CONFIG[currentRoom.mode]?.minPlayers ?? 2 : 2
  // Highest score first (found-item count for Finder, HP for Survival) - other modes keep roster
  // order as-is, there's no single "score" to rank Tag/Team by.
  const sortedRosterPlayers = useMemo(() => {
    if (!currentRoom?.players?.length) return currentRoom?.players || []
    const rankable = currentRoom.mode === 'survival' || isFinderMode(currentRoom.mode)
    if (!rankable) return currentRoom.players
    const scoreFor = (p) => {
      if (currentRoom.mode === 'survival') {
        return p.name === name ? health : livePositions[p.name]?.health ?? p.health ?? 1000
      }
      return p.name === name ? (p.foundItems || []).length : livePositions[p.name]?.foundCount ?? 0
    }
    return [...currentRoom.players].sort((a, b) => scoreFor(b) - scoreFor(a))
  }, [currentRoom, name, health, livePositions])
  // Survival rooms run up to 100 players - showing every row would make the panel unusable, so
  // only the top 5 plus your own row (wherever it falls) are shown, each tagged with its real
  // rank so "I'm 64th" is still legible even though rows 6-63 aren't rendered.
  const survivalRosterView = useMemo(() => {
    if (currentRoom?.mode !== 'survival') return null
    const ranked = sortedRosterPlayers.map((player, i) => ({ player, rank: i + 1 }))
    const top5 = ranked.slice(0, 5)
    const selfEntry = ranked.find((r) => r.player.name === name)
    const scoreFor = (p) => (p.name === name ? health : livePositions[p.name]?.health ?? p.health ?? 1000)
    const perfectCount = ranked.filter((r) => scoreFor(r.player) >= 1000).length
    return {
      top5,
      selfEntry: selfEntry && selfEntry.rank > 5 ? selfEntry : null,
      survivors: ranked.filter((r) => !r.player.eliminated).length,
      total: ranked.length,
      // Only worth showing once there's more perfect scores than top5 already displays - otherwise
      // it'd just be restating what's already visible.
      perfectCount: perfectCount > 5 ? perfectCount : null
    }
  }, [currentRoom, sortedRosterPlayers, name, health, livePositions])
  const renderPlayerRow = (player, rank) => {
    const isSelf = player.name === name
    const live = livePositions[player.name]
    return (
      <div key={player.name} className={`room-player-item${isSelf ? ' room-player-self' : ''}`}>
        <span className="room-player-identity" style={{ color: player.color }}>
          {rank ? <span className="room-player-rank">{String(rank).padStart(2, '0')}.</span> : null}
          {player.name === currentRoom.host ? <span className="host-badge" title="Host - can add/remove NPCs">👑</span> : null}
          <span className="room-player-avatar" dangerouslySetInnerHTML={{ __html: getAvatarSvg(player.avatarId) }} />
          {player.name}
          {player.isNpc ? ' (Bot)' : ''}
          {currentRoom.itName === player.name ? ' (It)' : ''}
        </span>
        <span className="room-player-actions">
          {currentRoom.mode === 'survival' ? (
            <span className="player-status active">{Math.round(isSelf ? health : live?.health ?? player.health ?? 1000)} HP</span>
          ) : isFinderMode(currentRoom.mode) ? (
            <span className="player-status active">{isSelf ? (player.foundItems || []).length : live?.foundCount ?? 0}/{(currentRoom.items || []).length}</span>
          ) : player.eliminated ? (
            <span className="player-status">{currentRoom.mode === 'tag' ? 'Caught' : 'Eliminated'}</span>
          ) : (
            <span className="player-status active">Alive</span>
          )}
          {player.isNpc && isRoomHost ? (
            <button className="room-meta-btn" onClick={() => removeNpc(player.name)} title="Remove NPC">x</button>
          ) : null}
        </span>
      </div>
    )
  }

  // Round-finish report: no restart option (host or otherwise) and no auto-restart countdown -
  // whoever's still around just sees how it went and leaves whenever they're ready, no rush.
  // Wanting to play again means creating/joining a fresh room, same as any other new round.
  const roundReportPanel = currentRoom && currentRoom.status === 'finished' ? (
    <div className="room-finished">
      <div className="room-finished-title">{currentRoom.winners?.length ? `${currentRoom.winners.join(' & ')} won!` : 'Round finished'}</div>
      {currentRoom.roundStartedAt ? (
        <div className="room-finished-time">Round time: {formatDuration((currentRoom.updatedAt || Date.now()) - currentRoom.roundStartedAt)}</div>
      ) : null}
      <button className="leave-room" onClick={leaveRoom}>Leave room</button>
    </div>
  ) : null
  const roomStatusPanels = currentRoom ? (
    <>
      <div className="room-meta">
        <div className="room-meta-row">
          <span>Room <strong>{currentRoom.code}</strong> · {currentRoom.status}</span>
          {isRoomHost ? (
            currentRoom.status !== 'playing' ? (
              <button className="room-meta-btn" onClick={startRoom} disabled={currentRoom.players.length < roomMinPlayers} title={currentRoom.players.length < roomMinPlayers ? `Need ${roomMinPlayers}+ players` : 'Start round'}>
                Start
              </button>
            ) : (
              <button className="room-meta-btn room-meta-btn-stop" onClick={stopRoom}>Stop</button>
            )
          ) : null}
        </div>
        <div className="room-meta-sub">
          Host {currentRoom.host || 'Host'} · {currentRoom.players.length}/{currentRoom.maxPlayers}{roundRemainingLabel ? ` · ${roundRemainingLabel}` : ''}
        </div>
      </div>
      <div className="room-player-list">
        <div className="room-player-title">
          Players
          {isRoomHost ? (
            <button
              className="room-meta-btn"
              onClick={addNpc}
              disabled={currentRoom.mode === 'survival' || currentRoom.players.length >= currentRoom.maxPlayers}
              title={
                currentRoom.mode === 'survival'
                  ? 'Survival auto-fills to 100 players at start'
                  : currentRoom.players.length >= currentRoom.maxPlayers
                  ? 'Room is full'
                  : 'Add an ambient NPC driver'
              }
            >
              + Add NPC
            </button>
          ) : null}
        </div>
        {currentRoom.mode === 'survival' && survivalRosterView ? (
          <>
            <div className="survivor-count">
              {survivalRosterView.survivors}/{survivalRosterView.total} survivors · {clouds.length} clouds active
            </div>
            {survivalRosterView.top5.map(({ player, rank }) => renderPlayerRow(player, rank))}
            {survivalRosterView.perfectCount ? (
              <div className="perfect-score-divider">Perfect scores ({survivalRosterView.perfectCount})</div>
            ) : null}
            {survivalRosterView.selfEntry ? (
              <>
                {survivalRosterView.perfectCount ? null : <div className="roster-gap-divider" />}
                {renderPlayerRow(survivalRosterView.selfEntry.player, survivalRosterView.selfEntry.rank)}
              </>
            ) : null}
          </>
        ) : (
          sortedRosterPlayers.map((player) => renderPlayerRow(player, null))
        )}
      </div>
      {isFinderMode(currentRoom.mode) ? (
        <div className="item-tracker">
          <div className="room-player-title">Items ({(currentPlayer?.foundItems || []).length}/{(currentRoom.items || []).length})</div>
          {itemDistances.map((item) => (
            <div key={item.id} className={`item-tracker-item${item.found ? ' item-tracker-found' : ''}`}>
              <span className="item-tracker-icon" style={{ color: selectedColor }} dangerouslySetInnerHTML={{ __html: getFinderItemSvg(item.iconId) }} />
              <span>{item.label ? `${item.label} — ` : ''}{item.found ? 'Found!' : `${Math.round(item.distanceMeters)} m`}</span>
            </div>
          ))}
        </div>
      ) : null}
    </>
  ) : null

  return (
    <div className="app-shell">
      <div className="app-sidebar">
        <div className="app-brand">MapDashRun <span className="app-brand-version">v{APP_VERSION}</span></div>
        {!started && !pickingSpawn ? (
          <div className="setup-modal-backdrop">
            <div className="setup-modal-card">
              <div className="mode-select">
                {Object.entries(MODE_CONFIG).map(([key, cfg]) => (
                  <button key={key} className={mode === key ? 'active' : ''} onClick={() => { setMode(key); setStarted(false) }}>{cfg.label}</button>
                ))}
              </div>
              <div className="lobby-panel">
                <div className="lobby-name-display">
                  Driving as <strong>{name}</strong>
                  {renameName && !joinedRoomCode ? (
                    <button
                      className="rename-pencil"
                      title="Change name"
                      onClick={() => { setRenamingOpen((o) => !o); setRenameInput(name); setRenameError('') }}
                    >
                      ✎
                    </button>
                  ) : null}
                </div>
                {renamingOpen ? (
                  <div className="rename-form">
                    <input value={renameInput} onChange={(e) => setRenameInput(e.target.value)} maxLength={20} autoFocus />
                    <div className="rename-actions">
                      <button onClick={submitRename} disabled={renaming}>{renaming ? 'Saving...' : 'Save'}</button>
                      <button className="leave-room" onClick={() => { setRenamingOpen(false); setRenameError('') }}>Cancel</button>
                    </div>
                    {renameError ? <div className="rename-error">{renameError}</div> : null}
                  </div>
                ) : null}
                <label>Car color</label>
                <div className="color-picks">
                  {CAR_COLORS.map((color) => (
                    <button key={color} style={{ backgroundColor: color }} className={selectedColor === color ? 'selected' : ''} onClick={() => setSelectedColor(color)} />
                  ))}
                </div>
                <label>Avatar</label>
                <div className="avatar-picks">
                  {AVATAR_ICONS.map((avatar) => (
                    <button
                      key={avatar.id}
                      className={selectedAvatarId === avatar.id ? 'selected' : ''}
                      title={avatar.label}
                      style={{ color: selectedColor }}
                      onClick={() => setSelectedAvatarId(avatar.id)}
                      dangerouslySetInnerHTML={{ __html: avatar.svg }}
                    />
                  ))}
                </div>
                <label>Start point</label>
                <div className="start-point-picker">
                  <button
                    className={pickingSpawn ? 'selected' : ''}
                    onClick={() => setPickingSpawn((p) => !p)}
                  >
                    {pickingSpawn ? 'Click the map...' : pickedSpawn ? 'Change start point' : 'Pick start on map'}
                  </button>
                  {pickedSpawn ? (
                    <button onClick={() => { setPickedSpawn(null); setPickingSpawn(false) }}>Reset to default</button>
                  ) : null}
                </div>
                {MODE_CONFIG[mode]?.roomBased ? (
                  <>
                    <label>Room code</label>
                    <input value={roomCode} onChange={(e) => setRoomCode(e.target.value.toUpperCase())} placeholder="ROOM123" maxLength={10} />
                    <div className="room-actions">
                      <button onClick={() => joinRoom()}>Join room</button>
                      <button onClick={createRoom}>Create room</button>
                    </div>
                  </>
                ) : (
                  <button onClick={() => setStarted(true)}>Start driving</button>
                )}
                {joinedRoomCode && currentRoom && !started && currentRoom.status === 'waiting' ? (
                  <div className="room-waiting">
                    Waiting for another player to join room <strong>{joinedRoomCode}</strong>...
                    <button className="leave-room" onClick={leaveRoom}>Leave</button>
                  </div>
                ) : null}
                {roundReportPanel}
                {MODE_CONFIG[mode]?.roomBased && !joinedRoomCode ? (
                  <div className="room-list">
                    <div className="room-list-title">Available rooms</div>
                    {rooms.filter((room) => room.mode === mode && room.status !== 'closed' && !isRoomStale(room)).length ? (
                      rooms
                        .filter((room) => room.mode === mode && room.status !== 'closed' && !isRoomStale(room))
                        .map((room) => {
                          const inProgress = MODE_CONFIG[room.mode]?.hostGatedStart && room.status === 'playing'
                          const finished = room.status === 'finished'
                          const full = room.players.length >= room.maxPlayers
                          const unjoinable = inProgress || finished || full
                          return (
                            <div key={room.code} className="room-item">
                              <div>
                                <strong>{room.code}</strong> · {room.players.length}/{room.maxPlayers}
                              </div>
                              <button
                                disabled={unjoinable}
                                onClick={() => { setRoomCode(room.code); joinRoom(room.code) }}
                              >
                                {inProgress ? 'In-game' : finished ? 'Finished' : full ? 'Full' : 'Join'}
                              </button>
                            </div>
                          )
                        })
                    ) : (
                      <div className="room-empty">No rooms available yet.</div>
                    )}
                  </div>
                ) : null}
                {roomStatusPanels}
              </div>
            </div>
          </div>
        ) : null}
        {started ? roomStatusPanels : null}
        {started ? roundReportPanel : null}
        {started ? (
          <div className="status-panel">
            <div className="center-toggle">
              <label>
                <input type="checkbox" checked={showStreetNames} onChange={(e) => setShowStreetNames(e.target.checked)} /> Street names
              </label>
            </div>
            <div className="center-toggle">
              <label>
                <input type="checkbox" checked={showRouteLine} onChange={(e) => setShowRouteLine(e.target.checked)} /> Show route line
              </label>
            </div>
            <div className="center-toggle">
              <label>
                <input type="checkbox" checked={northUpMode} onChange={(e) => setNorthUpMode(e.target.checked)} /> North-up fixed map
              </label>
            </div>
            <div className="center-toggle">
              <label>
                <input type="checkbox" checked={showDebugGraph} onChange={(e) => setShowDebugGraph(e.target.checked)} /> Debug: street graph
              </label>
            </div>
            <div className="center-toggle">
              <label>
                Map style:{' '}
                <select value={themeId} onChange={(e) => setThemeId(e.target.value)}>
                  {Object.keys(THEMES).map((id) => (
                    <option key={id} value={id}>{THEMES[id].name}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="action-button-row">
              <button className={`cloud-button${turboButtonOn ? ' turbo-toggle-on' : ''}`} onClick={() => setTurboButtonOn((t) => !t)}>
                {turboButtonOn ? 'Turbo: ON' : 'Turbo'}
              </button>
              {currentRoom?.mode === 'survival' ? null : (
                <button className="cloud-button" onClick={addCloud} disabled={cloudCooldown}>Add cloud</button>
              )}
              {joinedRoomCode ? (
                <button className="leave-room" onClick={leaveRoom}>Leave room</button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
      <div className="map-panel">
        <MapView
          tileUrls={showStreetNames ? THEMES[themeId].baseWithLabels : THEMES[themeId].baseNoLabels}
          attribution={THEMES[themeId].attribution}
          center={{ lat: position.lat, lng: position.lng }}
          zoom={zoom}
          onReady={handleMapReady}
          onClick={handleMapClick}
        />
        <div className="active-street-banner">
          <div className="active-street-name">{activeStreet}</div>
          {activeArrondissement || activeQuartier ? (
            <div className="active-street-location">
              {[activeArrondissement, activeQuartier].filter(Boolean).join(' · ')}
            </div>
          ) : null}
        </div>
        {pickingSpawn ? <div className="picking-spawn-banner">Click the map to choose your start point</div> : null}
        <div className="overlay-top-right">
          <button className="cloud-button" onClick={zoomIn}>+</button>
          <button className="cloud-button" onClick={zoomOut}>−</button>
          <button className="leave-room" onClick={quitGame}>Quit</button>
        </div>
        <ScreenOverlay wind={displayWind} players={screenPlayers} items={screenItems} radarTargets={radarTargets} started={started} name={name} speedKmh={displayedSpeed} turboActive={turboActive} compassRef={compassRef} gameMessage={gameMessage} />
      </div>
    </div>
  )
}
