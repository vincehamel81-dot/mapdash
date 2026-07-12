import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import MapView from './MapView'
import { CONFIG, THEMES } from './config'
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
  pickRandomNextSegment
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
const CLOUD_MOVE_INTERVAL_MS = 7000

// Read once at module load - a `?debugRoundMs=` query param overrides Survival/Tag's round
// duration so verification doesn't require waiting out a real 5-10 minute round. Inert in normal
// play (no query param = no effect).
const DEBUG_ROUND_MS = (() => {
  if (typeof window === 'undefined') return null
  const raw = new URLSearchParams(window.location.search).get('debugRoundMs')
  const parsed = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
})()

export const MODE_CONFIG = {
  single: { label: 'Single', roomBased: false, hostGatedStart: false, minPlayers: 1, maxPlayers: 1, roundDurationMs: null },
  team: { label: 'Team', roomBased: true, hostGatedStart: false, minPlayers: 2, maxPlayers: 10, roundDurationMs: null },
  survival: { label: 'Survival', roomBased: true, hostGatedStart: true, minPlayers: 2, maxPlayers: 10, roundDurationMs: DEBUG_ROUND_MS ?? 10 * 60 * 1000 },
  'finder-easy': { label: 'Finder (Easy)', roomBased: true, hostGatedStart: true, minPlayers: 2, maxPlayers: 10, roundDurationMs: null },
  'finder-hard': { label: 'Finder (Hard)', roomBased: true, hostGatedStart: true, minPlayers: 2, maxPlayers: 10, roundDurationMs: null },
  tag: { label: 'Tag', roomBased: true, hostGatedStart: true, minPlayers: 2, maxPlayers: 10, roundDurationMs: DEBUG_ROUND_MS ?? 5 * 60 * 1000 }
}

// Ambient NPC drivers (v1): real simulated movement on the street graph (see
// pickRandomNextSegment), but deliberately don't affect win conditions - can't be tagged/become
// It, can't find items, don't take damage. Host's client alone simulates + broadcasts every NPC's
// position, same ephemeral broadcast channel as a real player's own position (never persisted).
const NPC_TICK_MS = 200

const CLOUD_DAMAGE_PER_SEC = { white: 30, gray: 100, black: 250 }
const FINDER_PICKUP_RADIUS_METERS = 15
const TAG_CONTACT_RADIUS_METERS = 8

// Finished rooms auto-restart within ~3s if the host is still around (see the auto-restart
// effect below) - one that's stayed 'finished' well past that is almost certainly abandoned
// (host disconnected), so hide it from the join list rather than leaving it joinable forever.
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
  if (mode === 'finder-easy' || mode === 'finder-hard') {
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

// Most clouds are modest, but occasionally (~15%) spawn a genuinely huge one spanning several
// street blocks, per the "clouds should feel epic sometimes, not uniformly small" request. The
// big-cloud ceiling is doubled (220-1000m instead of 220-500m) per direct feedback that even the
// biggest clouds should be bigger still - small-cloud range and the 15% rarity are unchanged.
// Survival clouds are twice this size per the mode's rules (sizeMultiplier = 2).
function randomCloudRadius(sizeMultiplier = 1) {
  const base = Math.random() < 0.15 ? 220 + Math.random() * 780 : 20 + Math.random() * 70
  return base * sizeMultiplier
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

function ScreenOverlay({ wind, players = [], items = [], started, name, speedKmh, turboActive, compassRef, gameMessage }) {
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
    </div>
  )
}

export default function App({ playerName, renameName, joinRequest }) {
  const [mode, setMode] = useState('single')
  const [started, setStarted] = useState(false)
  const [zoom, setZoom] = useState(CONFIG.defaultZoom)
  const [position, setPosition] = useState(defaultPosition)
  const [segments, setSegments] = useState([])
  const [graph, setGraph] = useState(null)
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
  const [countdown, setCountdown] = useState(0)
  const countdownRef = useRef(null)
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
  const themeIdRef = useRef('voyager')
  const showDebugGraphRef = useRef(false)

  useEffect(() => {
    northUpModeRef.current = northUpMode
  }, [northUpMode])

  useEffect(() => {
    showDebugGraphRef.current = showDebugGraph
  }, [showDebugGraph])

  useEffect(() => {
    themeIdRef.current = themeId
  }, [themeId])

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
    // A static outline of the playable area (CONFIG.bbox, which street data is filtered to) - the
    // boundary itself isn't driveable-past-blocked, but it's now genuinely the edge of the street
    // network, so seeing it coming is the whole point.
    const { south, west, north, east } = CONFIG.bbox
    map.addSource('bbox-boundary', {
      type: 'geojson',
      data: {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[west, south], [east, south], [east, north], [west, north], [west, south]] }
      }
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
    return () => {
      if (countdownRef.current) {
        clearInterval(countdownRef.current)
        countdownRef.current = null
      }
    }
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
    if (!isSupabaseConfigured || !joinedRoomCode) {
      roomChannelRef.current = null
      return
    }
    const channel = supabase.channel(`room:${joinedRoomCode}`)
    channel.on('broadcast', { event: 'position' }, ({ payload }) => {
      if (!payload || payload.name === name) return
      setLivePositions((prev) => ({ ...prev, [payload.name]: payload }))
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

    if (currentRoom.mode === 'finder-easy' || currentRoom.mode === 'finder-hard') {
      if (currentRoom.status === 'waiting') {
        setGameMessage('Waiting for another player to join...')
      } else {
        setGameMessage(currentRoom.mode === 'finder-easy' ? 'Find all 10 items - watch for their icons on the map!' : 'Find all 10 items - only the distance list can help you.')
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
  // Host-only local simulation state for every ambient NPC currently in the room: name ->
  // { edgeId, distanceAlong, direction }. Never persisted or broadcast itself - only the resulting
  // lat/lng gets broadcast (see the NPC tick effect below), same as a real player's own position.
  const npcSimRef = useRef({})
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
    // Tag's "It" drives 1.5x everyone else's speed.
    const isIt = currentRoom?.mode === 'tag' && currentRoom.itName === name
    if (isIt) return base * 1.5
    // Turbo (hold Shift or the on-screen button): unlimited use, doubles speed in every mode
    // except Tag - It's 1.5x above is the only speed buff Tag allows.
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

  const startCountdown = useCallback((seconds, onFinish) => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current)
      countdownRef.current = null
    }
    setCountdown(seconds)
    countdownRef.current = window.setInterval(() => {
      setCountdown((s) => {
        if (s <= 1) {
          clearInterval(countdownRef.current)
          countdownRef.current = null
          setCountdown(0)
          if (onFinish) onFinish()
          return 0
        }
        return s - 1
      })
    }, 1000)
  }, [])

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
    fetch('/data/QBC/segments.json')
      .then((res) => res.json())
      .then((data) => {
        // The raw file covers a much wider region (Lévis across the river, plus ~50 smaller
        // outlying municipalities that geographically interleave with Quebec City's own bounds -
        // a plain bbox-containment filter alone still let ~1800 Lévis segments through) than the
        // playable area, so first restrict to the source data's own `city` field (precise
        // regardless of geographic overlap), then further restrict to CONFIG.bbox (now
        // deliberately smaller than all of Quebec City proper, per feedback that even that felt
        // too big) so what's actually loaded exactly matches the visible boundary on the map.
        const { south, west, north, east } = CONFIG.bbox
        const withinBbox = (poly) => poly.every(([lat, lng]) => lat >= south && lat <= north && lng >= west && lng <= east)
        setSegments(data.filter((s) => s.city === 'Québec' && withinBbox(s.polyline)))
      })
      .catch(() => {
        console.error('Unable to load street data')
      })
  }, [])

  useEffect(() => {
    if (!segments.length) return
    setGraph(buildGraph(segments))
  }, [segments])

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
          } else if ((room.mode === 'finder-easy' || room.mode === 'finder-hard') && !live.eliminated) {
            const unfound = (room.items || []).filter((item) => !live.foundItems.includes(item.id))
            const found = unfound.find(
              (item) => haversine([posObj.lat, posObj.lng], [item.lat, item.lng]) <= FINDER_PICKUP_RADIUS_METERS
            )
            if (found) {
              const nextFoundItems = [...live.foundItems, found.id]
              const wonRound = nextFoundItems.length >= FINDER_ITEMS.length
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
          // Satellite is aerial photography, not a data-driven 3D scene (no building-height data
          // exists to extrude), so there's no true first-person view available - tilting the
          // camera over the flat photo is the closest approximation to "driving through the city"
          // rather than looking straight down at it, per direct feedback.
          const pitch = themeIdRef.current === 'satellite' ? 60 : 0
          if (northUpModeRef.current) {
            // "Pac-Man style" by direct request: map stays pinned north-up AND the car sprite
            // always points up too, completely decoupled from its real travel heading (which
            // still drives the underlying street-graph movement/absoluteTargetMathDeg above,
            // just never shown visually) - deliberately different from the rotating-map mode,
            // where the marker rotates to show real facing. No label counter-rotation needed
            // since the marker itself never rotates here.
            mapBearingRef.current = 0
            if (!activeZoomGestureRef.current) map.jumpTo({ center: [posObj.lng, posObj.lat], bearing: 0, pitch })
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
              map.jumpTo({ center: [posObj.lng, posObj.lat], bearing: mapBearingRef.current, pitch })
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

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const source = map.getSource('clouds')
    if (source) source.setData(cloudsToGeoJSON(clouds))
  }, [clouds, mapReady])

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
      const speed = Math.floor(20 + Math.random() * 60)
      setWind({ direction, speed, angle: CARDINAL_ANGLES[direction] })
    }

    updateWind()
    const interval = window.setInterval(updateWind, 20000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    // Checked against radiusMeters + a flat 50m safety margin, not just a flat 50m from the
    // center point - a big cloud (up to ~1000m radius in survival) spawning 51m from a player
    // would otherwise cover them instantly even though the center point "passed" a flat check.
    const isTooCloseToAnyPlayer = (lat, lng, radiusMeters) => {
      const live = liveRef.current
      const self = positionRef.current
      const threshold = radiusMeters + 50
      if (self && haversine([lat, lng], [self.lat, self.lng]) < threshold) return true
      return Object.values(live.livePositions || {}).some((p) => haversine([lat, lng], [p.lat, p.lng]) < threshold)
    }

    const spawnCloudNear = (anchor) => {
      const isSurvival = liveRef.current.currentRoom?.mode === 'survival'
      const radiusMeters = randomCloudRadius(isSurvival ? 2 : 1)
      let lat, lng
      // Retry a few times to avoid spawning right on top of a player - in every mode now, not
      // just survival (cosmetic clouds spawning on top of you were still an immersion-breaking
      // annoyance even without damage); accept the last candidate even if still close rather than
      // spawning nothing.
      for (let attempt = 0; attempt < 10; attempt++) {
        const bearing = Math.random() * 360
        const distance = 250 + Math.random() * 650
        ;[lat, lng] = offsetLatLng([anchor.lat, anchor.lng], bearing, distance)
        if (!isTooCloseToAnyPlayer(lat, lng, radiusMeters)) break
      }
      return {
        id: crypto.randomUUID(),
        lat,
        lng,
        radiusMeters,
        // Every mode's clouds get a visual tier now, not just Survival's - it only *drives damage*
        // in Survival (gated separately, in the tick loop), everywhere else it's purely cosmetic.
        tier: randomCloudTier()
      }
    }

    const driftAndPrune = (list, anchor) => {
      const distanceMeters = (wind.speed / 3.6) * (CLOUD_MOVE_INTERVAL_MS / 1000)
      const driftBearing = wind.angle ?? 0
      return list
        .map((cloud) => {
          const [lat, lng] = offsetLatLng([cloud.lat, cloud.lng], driftBearing, distanceMeters)
          return { ...cloud, lat, lng }
        })
        .filter((cloud) => haversine([cloud.lat, cloud.lng], [anchor.lat, anchor.lng]) <= 1800)
    }

    const moveClouds = () => {
      const anchor = positionRef.current || CONFIG.startPosition
      // Host computes authoritative cloud state and writes it to the room
      if (isRoomHost && currentRoom) {
        const base = Array.isArray(currentRoom.clouds) && currentRoom.clouds.length ? currentRoom.clouds : clouds
        const next = driftAndPrune(base, anchor)

        if (next.length < 5 || Math.random() < 0.4) {
          next.push(spawnCloudNear(anchor))
        }

        if (next.length > 8) next.splice(0, next.length - 8)
        updateRoom(currentRoom.code, (room) => ({ ...room, clouds: next }))
        setClouds(next)
      } else {
        // Non-host clients will receive cloud updates from the room; fallback to local behavior if none exists
        if (!currentRoom?.clouds || !currentRoom.clouds.length) {
          setClouds((prev) => {
            const next = driftAndPrune(prev, anchor)

            if (next.length < 5 || Math.random() < 0.4) {
              next.push(spawnCloudNear(anchor))
            }

            if (next.length > 8) next.splice(0, next.length - 8)
            return next
          })
        }
      }
    }

    const interval = window.setInterval(moveClouds, CLOUD_MOVE_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [wind])

  useEffect(() => {
    // Initialize default clouds for solo usage; room-host will overwrite when appropriate
    const anchor = pickedSpawn || CONFIG.startPosition
    const spawn = (bearing, distance) => {
      const [lat, lng] = offsetLatLng([anchor.lat, anchor.lng], bearing, distance)
      return { id: crypto.randomUUID(), lat, lng, radiusMeters: randomCloudRadius(), tier: randomCloudTier() }
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


  const restartRoom = useCallback(() => {
    if (!currentRoom) return
    // do a 3s countdown then restart
    startCountdown(3, () => {
      restartImmediate()
    })
  }, [currentRoom, updateRoom])


  // Builds the fresh per-round fields (players reset, items, It, round start timestamp) shared by
  // both the initial Start and every subsequent restart, keyed off MODE_CONFIG so it generalizes
  // to whichever mode the room is running instead of special-casing survival.
  const buildRoundState = useCallback(
    (players, roomMode) => {
      const { players: nextPlayers, itName } = resetPlayersForRound(players, roomMode)
      const isFinder = roomMode === 'finder-easy' || roomMode === 'finder-hard'
      // Uniform across the whole playable bbox (not anchored to any one player's spawn) - a room
      // has multiple players starting at different points, so biasing toward a single anchor
      // unfairly favored whoever's position happened to trigger the round build.
      const items = isFinder && graph
        ? FINDER_ITEMS.map((def, i) => {
            const pt = pickRandomStreetPoint(graph) || defaultPosition
            return { id: `item-${i}-${crypto.randomUUID()}`, iconId: def.id, label: def.label, lat: pt.lat, lng: pt.lng, foundBy: null }
          })
        : []
      return { players: nextPlayers, itName, items, roundStartedAt: Date.now() }
    },
    [graph]
  )

  const restartImmediate = useCallback(() => {
    if (!currentRoom) return
    const cfg = MODE_CONFIG[currentRoom.mode]
    const enoughPlayers = currentRoom.players.length >= cfg.minPlayers
    const roundExtras = enoughPlayers ? buildRoundState(currentRoom.players, currentRoom.mode) : null
    const nextRoom = {
      ...currentRoom,
      status: enoughPlayers ? 'playing' : 'waiting',
      players: roundExtras ? roundExtras.players : currentRoom.players.map((player) => ({ ...player, eliminated: false })),
      itName: roundExtras ? roundExtras.itName : null,
      items: roundExtras ? roundExtras.items : [],
      roundStartedAt: roundExtras ? roundExtras.roundStartedAt : null,
      winners: []
    }
    updateRoom(currentRoom.code, () => nextRoom)
    setEliminated(false)
    setStarted(nextRoom.status === 'playing')
  }, [currentRoom, updateRoom, buildRoundState])

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
      // NPCs are ambient-only (v1) - they never take damage, so including them here would let a
      // bot sitting at full health "win" Survival by default every time.
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

  // Tag round resolution (host-only): either It eliminates every other player ("It won") or the
  // 5-minute mark passes first ("It lost", every still-alive non-It player wins).
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

  // Auto-restart host-gated rounds when finished (host only) - generalizes what used to be
  // survival-only to every mode where the host controls when a round begins.
  useEffect(() => {
    if (!currentRoom || !isRoomHost) return
    if (currentRoom.status === 'finished' && MODE_CONFIG[currentRoom.mode]?.hostGatedStart) {
      startCountdown(3, () => {
        restartImmediate()
      })
    }
  }, [currentRoom, isRoomHost, startCountdown, restartImmediate])

  const startRoom = useCallback(() => {
    if (!currentRoom || !isRoomHost) return
    const cfg = MODE_CONFIG[currentRoom.mode]
    const enoughPlayers = currentRoom.players.length >= cfg.minPlayers
    const roundExtras = enoughPlayers ? buildRoundState(currentRoom.players, currentRoom.mode) : null
    const nextRoom = {
      ...currentRoom,
      status: enoughPlayers ? 'playing' : 'waiting',
      players: roundExtras ? roundExtras.players : currentRoom.players,
      itName: roundExtras ? roundExtras.itName : null,
      items: roundExtras ? roundExtras.items : [],
      roundStartedAt: roundExtras ? roundExtras.roundStartedAt : null,
      winners: []
    }
    updateRoom(currentRoom.code, () => nextRoom)
    setEliminated(false)
    setStarted(nextRoom.status === 'playing')
  }, [currentRoom, isRoomHost, updateRoom, buildRoundState])

  const stopRoom = useCallback(() => {
    if (!currentRoom || !isRoomHost) return
    // cancel pending countdowns
    if (countdownRef.current) {
      clearInterval(countdownRef.current)
      countdownRef.current = null
      setCountdown(0)
    }
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
      for (const npc of npcs) {
        let sim = npcSimRef.current[npc.name]
        if (!sim) {
          const edges = Array.from(graph.edges.values())
          if (!edges.length) continue
          const edge = edges[Math.floor(Math.random() * edges.length)]
          sim = { edgeId: edge.id, distanceAlong: Math.random() * edge.lengthMeters, direction: Math.random() < 0.5 ? 1 : -1 }
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

        npcSimRef.current[npc.name] = { edgeId: nextEdge.id, distanceAlong: nextDistanceAlong, direction: nextDirection }
        const [lat, lng] = getSegmentPosition(nextEdge, nextDistanceAlong)
        const payload = { name: npc.name, lat, lng }
        // Broadcast for every other client, and update this (the host's) own local view directly -
        // Realtime broadcast channels don't echo back to the sender by default, and NPCs have no
        // other rendering path (unlike the host's own car, which renders straight from local state).
        roomChannelRef.current?.send({ type: 'broadcast', event: 'position', payload })
        setLivePositions((prev) => ({ ...prev, [npc.name]: payload }))
      }
    }, NPC_TICK_MS)
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
    const anchor = positionRef.current || CONFIG.startPosition
    const bearing = Math.random() * 360
    const distance = 150 + Math.random() * 500
    const [lat, lng] = offsetLatLng([anchor.lat, anchor.lng], bearing, distance)
    const newCloud = { id: crypto.randomUUID(), lat, lng, radiusMeters: randomCloudRadius(), tier: randomCloudTier() }
    if (currentRoom && isRoomHost) {
      updateRoom(currentRoom.code, (room) => ({ ...room, clouds: [...(room.clouds || []), newCloud].slice(-8) }))
    } else {
      setClouds((prev) => [...prev, newCloud].slice(-8))
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
    if (currentRoom?.mode !== 'finder-easy' || !mapRef.current) return []
    try {
      const map = mapRef.current
      const container = map.getContainer()
      const width = container.clientWidth
      const height = container.clientHeight
      const foundIds = currentPlayer?.foundItems || []
      return (currentRoom.items || [])
        .filter((item) => !foundIds.includes(item.id))
        .map((item) => {
          const point = map.project([item.lng, item.lat])
          return { id: item.id, iconId: item.iconId, label: item.label, screenX: (point.x / width) * 100, screenY: (point.y / height) * 100 }
        })
    } catch {
      return []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentRoom, currentPlayer, mapViewTick])

  const itemDistances = useMemo(() => {
    if (!currentRoom || !(currentRoom.mode === 'finder-easy' || currentRoom.mode === 'finder-hard')) return []
    const foundIds = currentPlayer?.foundItems || []
    return (currentRoom.items || [])
      .map((item) => ({
        ...item,
        found: foundIds.includes(item.id),
        distanceMeters: haversine([position.lat, position.lng], [item.lat, item.lng])
      }))
      .sort((a, b) => (a.found === b.found ? a.distanceMeters - b.distanceMeters : a.found ? 1 : -1))
  }, [currentRoom, currentPlayer, position])

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

  // Room status/roster/items - shown both inside the pre-drive setup modal (so the host's Start
  // button is actually reachable while waiting for players, not hidden behind the modal) and in
  // the normal sidebar position once driving. Built once, referenced in whichever of those two
  // mutually-exclusive spots applies.
  const roomMinPlayers = currentRoom ? MODE_CONFIG[currentRoom.mode]?.minPlayers ?? 2 : 2
  // Highest score first (found-item count for Finder, HP for Survival) - other modes keep roster
  // order as-is, there's no single "score" to rank Tag/Team by.
  const sortedRosterPlayers = useMemo(() => {
    if (!currentRoom?.players?.length) return currentRoom?.players || []
    const rankable = currentRoom.mode === 'survival' || currentRoom.mode === 'finder-easy' || currentRoom.mode === 'finder-hard'
    if (!rankable) return currentRoom.players
    const scoreFor = (p) => {
      if (currentRoom.mode === 'survival') {
        return p.name === name ? health : livePositions[p.name]?.health ?? p.health ?? 1000
      }
      return p.name === name ? (p.foundItems || []).length : livePositions[p.name]?.foundCount ?? 0
    }
    return [...currentRoom.players].sort((a, b) => scoreFor(b) - scoreFor(a))
  }, [currentRoom, name, health, livePositions])
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
              disabled={currentRoom.players.length >= currentRoom.maxPlayers}
              title={currentRoom.players.length >= currentRoom.maxPlayers ? 'Room is full' : 'Add an ambient NPC driver'}
            >
              + Add NPC
            </button>
          ) : null}
        </div>
        {sortedRosterPlayers.map((player) => {
          const isSelf = player.name === name
          const live = livePositions[player.name]
          return (
            <div key={player.name} className="room-player-item">
              <span className="room-player-identity" style={{ color: player.color }}>
                {player.name === currentRoom.host ? <span className="host-badge" title="Host - can add/remove NPCs">👑</span> : null}
                <span className="room-player-avatar" dangerouslySetInnerHTML={{ __html: getAvatarSvg(player.avatarId) }} />
                {player.name}
                {player.isNpc ? ' (Bot)' : ''}
                {currentRoom.itName === player.name ? ' (It)' : ''}
              </span>
              <span className="room-player-actions">
                {currentRoom.mode === 'survival' ? (
                  <span className="player-status active">{Math.round(isSelf ? health : live?.health ?? player.health ?? 1000)} HP</span>
                ) : currentRoom.mode === 'finder-easy' || currentRoom.mode === 'finder-hard' ? (
                  <span className="player-status active">{isSelf ? (player.foundItems || []).length : live?.foundCount ?? 0}/{FINDER_ITEMS.length}</span>
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
        })}
      </div>
      {currentRoom.mode === 'finder-easy' || currentRoom.mode === 'finder-hard' ? (
        <div className="item-tracker">
          <div className="room-player-title">Items ({(currentPlayer?.foundItems || []).length}/{FINDER_ITEMS.length})</div>
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
                {currentRoom && currentRoom.status === 'finished' ? (
                  <div className="room-finished">
                    <div>{currentRoom.winners?.length ? `${currentRoom.winners.join(' & ')} won` : 'Round finished'}</div>
                    {isRoomHost ? (
                      <button className="cloud-button" onClick={restartRoom}>Restart round</button>
                    ) : null}
                    <button className="leave-room" onClick={leaveRoom}>Leave room</button>
                  </div>
                ) : null}
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
        {started && currentRoom?.status === 'finished' ? (
          <div className="room-finished">
            <div>{currentRoom.winners?.length ? `${currentRoom.winners.join(' & ')} won` : 'Round finished'}</div>
            {isRoomHost ? (
              <button className="cloud-button" onClick={restartRoom}>Restart round</button>
            ) : null}
            <button className="leave-room" onClick={leaveRoom}>Leave room</button>
          </div>
        ) : null}
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
              <button className="cloud-button" onClick={addCloud} disabled={cloudCooldown}>Add cloud</button>
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
        {countdown > 0 ? (
          <div className="countdown-overlay">{countdown}</div>
        ) : null}
        <ScreenOverlay wind={wind} players={screenPlayers} items={screenItems} started={started} name={name} speedKmh={displayedSpeed} turboActive={turboActive} compassRef={compassRef} gameMessage={gameMessage} />
      </div>
    </div>
  )
}
