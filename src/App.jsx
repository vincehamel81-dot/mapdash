import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import MapView from './MapView'
import { CONFIG, THEMES } from './config'
import { AVATAR_ICONS, DEFAULT_AVATAR_ID, getAvatarSvg } from './avatarIcons'
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
  toCompassBearing,
  resolveEdgeEntry,
  offsetLatLng,
  haversine,
  pickRandomStreetPoint
} from './mapUtils'
import './App.css'

const CAR_COLORS = ['#4285F4', '#DB4437', '#F4B400', '#0F9D58', '#9C27B0', '#FF6D00', '#202124', '#FFFFFF']
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

const MODE_CONFIG = {
  single: { label: 'Single', roomBased: false, hostGatedStart: false, minPlayers: 1, maxPlayers: 1, roundDurationMs: null },
  team: { label: 'Team', roomBased: true, hostGatedStart: false, minPlayers: 2, maxPlayers: 4, roundDurationMs: null },
  survival: { label: 'Survival', roomBased: true, hostGatedStart: true, minPlayers: 2, maxPlayers: 6, roundDurationMs: DEBUG_ROUND_MS ?? 10 * 60 * 1000 },
  'finder-easy': { label: 'Finder (Easy)', roomBased: true, hostGatedStart: true, minPlayers: 2, maxPlayers: 6, roundDurationMs: null },
  'finder-hard': { label: 'Finder (Hard)', roomBased: true, hostGatedStart: true, minPlayers: 2, maxPlayers: 6, roundDurationMs: null },
  tag: { label: 'Tag', roomBased: true, hostGatedStart: true, minPlayers: 2, maxPlayers: 6, roundDurationMs: DEBUG_ROUND_MS ?? 5 * 60 * 1000 }
}

const CLOUD_DAMAGE_PER_SEC = { white: 30, gray: 100, black: 250 }
const FINDER_ITEM_ICON_IDS = ['cat', 'dog', 'apple', 'banana', 'cherry', 'gift', 'puzzle', 'heart', 'star', 'crown']
const FINDER_PICKUP_RADIUS_METERS = 15
const TAG_CONTACT_RADIUS_METERS = 8

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
    itName = next[Math.floor(Math.random() * next.length)]?.name ?? null
    return { players: next.map((p) => ({ ...p, isIt: p.name === itName })), itName }
  }
  return { players: next, itName }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function carMarkerMarkup(avatarId, color, label) {
  const safeLabel = escapeHtml(label || '')
  // Every avatar (the default arrow included) recolors via currentColor, so this wrapper is the
  // only place that needs to know the chosen color - the SVG markup itself is never rewritten.
  return `${safeLabel ? `<div class="car-marker-label">${safeLabel}</div>` : ''}<div class="car-marker-glyph" style="color:${color}">${getAvatarSvg(avatarId)}</div>`
}

function polylineToGeoJSON(polyline) {
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: (polyline || []).map(([lat, lng]) => [lng, lat]) }
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

// Real clouds aren't circles, and shouldn't render as one: build an irregular blob polygon in
// real lat/lng meters around the cloud's center. Because it's genuine geometry (not a pixel
// radius), it scales correctly with zoom for free through MapLibre's normal projection - no
// zoom-expression math needed at all, unlike the circle-radius approach this replaces.
function cloudPolygonCoords(cloud) {
  const rand = seededRandom(cloud.id)
  // More vertices + tighter jitter/radius variance than a minimal blob reads as a soft, rounded
  // shape instead of a jagged/pointy polygon.
  const vertexCount = 18 + Math.floor(rand() * 6)
  const points = []
  for (let i = 0; i < vertexCount; i++) {
    const angle = (360 * i) / vertexCount + (rand() - 0.5) * 6
    const radiusFactor = 0.82 + rand() * 0.3
    const [lat, lng] = offsetLatLng([cloud.lat, cloud.lng], angle, cloud.radiusMeters * radiusFactor)
    points.push([lng, lat])
  }
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
// street blocks, per the "clouds should feel epic sometimes, not uniformly small" request.
// Survival clouds are twice this size per the mode's rules (sizeMultiplier = 2).
function randomCloudRadius(sizeMultiplier = 1) {
  const base = Math.random() < 0.15 ? 220 + Math.random() * 280 : 20 + Math.random() * 70
  return base * sizeMultiplier
}

const defaultPosition = {
  lat: CONFIG.startPosition.lat,
  lng: CONFIG.startPosition.lng,
  speed: 0
}

function useDrivingControls(started, onControlsChange, onZoomChange) {
  useEffect(() => {
    if (!started) return

    const pressed = { forward: false, reverse: false, left: false, right: false, turbo: false }
    const update = () => onControlsChange({ ...pressed })

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
        if (!pressed.reverse) {
          pressed.reverse = true
          update()
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
        pressed.reverse = false
        update()
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
  }, [started, onControlsChange, onZoomChange])
}

function ScreenOverlay({ wind, players = [], items = [], started, name, speedKmh, turboActive }) {
  return (
    <div className="screen-overlay">
      <div className="overlay-top-left">
        {started ? <div className="mode-pill">{name}</div> : null}
        <div className="mode-pill">Wind: {wind.direction} · {wind.speed} km/h</div>
      </div>
      {started ? (
        <div className="overlay-bottom-left">
          <div className={`mode-pill${turboActive ? ' turbo-active' : ''}`}>{speedKmh} km/h{turboActive ? ' ⚡ Turbo' : ''}</div>
        </div>
      ) : null}
      {players.map((p) => (
        <div key={p.name} className={`player-dot ${p.eliminated ? 'eliminated' : ''}`} style={{ left: `${p.screenX}%`, top: `${p.screenY}%`, background: p.color }} title={p.name} />
      ))}
      {items.map((item) => (
        <div
          key={item.id}
          className="item-marker"
          style={{ left: `${item.screenX}%`, top: `${item.screenY}%` }}
          dangerouslySetInnerHTML={{ __html: getAvatarSvg(item.iconId) }}
        />
      ))}
    </div>
  )
}

export default function App({ playerName, renameName }) {
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
  const [controls, setControls] = useState({ forward: false, reverse: false, left: false, right: false, turbo: false })
  const [turnPreference, setTurnPreference] = useState('straight')
  const [clouds, setClouds] = useState([])
  const [wind, setWind] = useState({ direction: 'NE', speed: 20, angle: CARDINAL_ANGLES.NE })
  const [roomCode, setRoomCode] = useState('')
  const name = playerName || 'Player'
  const [selectedColor, setSelectedColor] = useState(CAR_COLORS[0])
  const [selectedAvatarId, setSelectedAvatarId] = useState(DEFAULT_AVATAR_ID)
  const [appearanceLoaded, setAppearanceLoaded] = useState(!isSupabaseConfigured)
  const [cloudCooldown, setCloudCooldown] = useState(false)
  const [rooms, setRooms] = useRoomSync()
  const [joinedRoomCode, setJoinedRoomCode] = useState(null)
  const [eliminated, setEliminated] = useState(false)
  const [gameMessage, setGameMessage] = useState('')
  const [countdown, setCountdown] = useState(0)
  const countdownRef = useRef(null)
  const [mapReady, setMapReady] = useState(false)
  const [showStreetNames, setShowStreetNames] = useState(true)
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

  const handleMapReady = useCallback((map) => {
    mapRef.current = map
    map.addSource('route', { type: 'geojson', data: polylineToGeoJSON([]) })
    map.addLayer({
      id: 'route',
      type: 'line',
      source: 'route',
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
    const shouldBeStarted = currentRoom.status === 'playing' && !currentRoom.players.find((p) => p.name === name)?.eliminated
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
  const reverseHoldStartRef = useRef(null)

  const currentSegment = useMemo(() => graph?.edges.get(currentEdgeId) || null, [graph, currentEdgeId])
  const displayedSpeed = useMemo(() => {
    // Doubled from the street's/reverse's raw value across the board - a 50 km/h street plays at
    // 100 normal, 200 under Turbo.
    const base = (controls.forward ? currentSegment?.speedKmh ?? 50 : controls.reverse ? 50 : 0) * 2
    // Tag's "It" drives 1.5x everyone else's speed - applied uniformly (including the fixed
    // reverse speed) so there's no exploit in reversing to dodge the buff.
    const isIt = currentRoom?.mode === 'tag' && currentRoom.itName === name
    if (isIt) return base * 1.5
    // Turbo (hold Shift or the on-screen button): unlimited use, doubles speed in every mode
    // except Tag - It's 1.5x above is the only speed buff Tag allows.
    const turboActive = (controls.turbo || turboButtonOn) && currentRoom?.mode !== 'tag'
    return turboActive ? base * 2 : base
  }, [controls, currentSegment, currentRoom, name, turboButtonOn])

  const turboActive = (controls.turbo || turboButtonOn) && (controls.forward || controls.reverse) && currentRoom?.mode !== 'tag'

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
          foundCount: (currentPlayer?.foundItems || []).length
        }
      })
    },
    [joinedRoomCode, name, eliminated, currentPlayer]
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
    // joinedRoomCode locally left the player as a ghost member other clients still saw.
    // leaveRoom is intentionally not in the deps array below: it's declared later in this
    // component, so referencing it there (evaluated eagerly, unlike a callback body) would throw
    // "Cannot access before initialization" on first render.
    if (joinedRoomCode) {
      leaveRoom()
    } else {
      setStarted(false)
    }
    setEliminated(false)
    setPosition(defaultPosition)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joinedRoomCode])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        quitGame()
        return
      }
      if (e.key === 'a' || e.key === 'ArrowLeft') {
        pendingTurnRef.current = 'left'
        // clear after 3s
        window.setTimeout(() => { if (pendingTurnRef.current === 'left') pendingTurnRef.current = null }, 3000)
      }
      if (e.key === 'd' || e.key === 'ArrowRight') {
        pendingTurnRef.current = 'right'
        window.setTimeout(() => { if (pendingTurnRef.current === 'right') pendingTurnRef.current = null }, 3000)
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

  const handleZoomChange = useCallback((delta) => {
    setZoom((current) => Math.min(CONFIG.maxZoom, Math.max(CONFIG.minZoom, current + delta)))
  }, [])

  useDrivingControls(started, handleControlsChange, handleZoomChange)

  useEffect(() => {
    fetch('/data/QBC/segments.json')
      .then((res) => res.json())
      .then((data) => {
        setSegments(data)
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

      // Holding reverse for a full second performs an instant U-turn in place instead of
      // requiring the player to time backing all the way through an intersection perfectly.
      // Flipping `direction` alone would reverse the car's physical travel direction too (since
      // it's still combined with the held reverse key below) - it would back up for a second,
      // then instantly retrace that same ground forward instead of continuing on. Suppressing
      // reverse's sign flip until the key is released keeps the car moving the same physical way
      // through the turn, so it reads as "spun around and kept going" rather than a bounce-back.
      const now = typeof time === 'number' ? time : performance.now()
      if (controls.reverse) {
        if (reverseHoldStartRef.current == null) reverseHoldStartRef.current = now
        else if (now - reverseHoldStartRef.current >= 1000) {
          movementRef.current.direction *= -1
          reverseHoldStartRef.current = 'consumed'
        }
      } else {
        reverseHoldStartRef.current = null
      }
      const reverseSuppressedByUturn = reverseHoldStartRef.current === 'consumed'

      const speedKmh = displayedSpeed
      const metersPerSecond = speedKmh / 3.6
      const direction = movementRef.current.direction
      // `direction` records which way FORWARD (non-reversed) travel moves distanceAlong along
      // the stored polyline. Reversing flips the ACTUAL direction of travel without changing
      // that stored value, so every boundary/exit check below must use this combined sign, not
      // `direction` alone - otherwise reversing back toward distanceAlong=0 is never recognized
      // as approaching a boundary and the car sticks there forever.
      const effectiveDirection = direction * (controls.reverse && !reverseSuppressedByUturn ? -1 : 1)
      const travelDelta = metersPerSecond * dt * effectiveDirection
      let nextDistanceAlong = movementRef.current.distanceAlong + travelDelta
      let nextDirection = direction
      let nextEdgeId = currentEdgeId
      let nextSegment = currentSegment

      const overflowing = effectiveDirection === 1
        ? nextDistanceAlong > currentSegment.lengthMeters
        : nextDistanceAlong < 0
      if (overflowing) {
        const remainder = effectiveDirection === 1 ? nextDistanceAlong - currentSegment.lengthMeters : -nextDistanceAlong
        const exitNodeKey = effectiveDirection === 1 ? currentSegment.endKey : currentSegment.startKey
        const turnChoice = pendingTurnRef.current || turnPreference
        const exitDistance = effectiveDirection === 1 ? currentSegment.lengthMeters : 0
        const baseHeading = getLocalHeadingAtDistance(currentSegment, exitDistance, direction)
        const currentHeading = normalizeAngle(controls.reverse && !reverseSuppressedByUturn ? baseHeading + 180 : baseHeading)
        const nextEdge = chooseNextSegment(
          graph,
          exitNodeKey,
          currentSegment,
          currentHeading,
          turnChoice
        )
        if (nextEdge) {
          nextEdgeId = nextEdge.id
          nextSegment = nextEdge
          const entry = resolveEdgeEntry(nextEdge, exitNodeKey, remainder)
          nextDistanceAlong = entry.distanceAlong
          // entry.direction is the new edge's effective (continued-travel) direction; convert
          // back to a forward-travel direction so the invariant above still holds next tick.
          nextDirection = controls.reverse ? -entry.direction : entry.direction
          // consume pending turn if it was used
          if (pendingTurnRef.current) pendingTurnRef.current = null
        } else {
          nextDistanceAlong = effectiveDirection === 1 ? currentSegment.lengthMeters : 0
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
        const facingMathAngle = normalizeAngle(controls.reverse && !reverseSuppressedByUturn ? headingBase + 180 : headingBase)
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
              const wonRound = nextFoundItems.length >= FINDER_ITEM_ICON_IDS.length
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
          const currentBearing = mapBearingRef.current
          const rawDelta = ((displayedHeading - currentBearing + 540) % 360) - 180
          const maxStep = MAX_BEARING_DEG_PER_SEC * dt
          const step = Math.max(-maxStep, Math.min(maxStep, rawDelta))
          mapBearingRef.current = normalizeAngle(currentBearing + step)
          // Center car is no longer optional - it's the only supported behavior now.
          map.jumpTo({ center: [posObj.lng, posObj.lat], bearing: mapBearingRef.current })
          carMarkerRef.current?.setLngLat([posObj.lng, posObj.lat])
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
    if (!map || !mapReady || carMarkerRef.current) return
    const el = document.createElement('div')
    el.className = 'car-marker-icon'
    el.innerHTML = carMarkerMarkup(selectedAvatarId, selectedColor, name)
    carMarkerElRef.current = el
    carMarkerRef.current = new maplibregl.Marker({ element: el, rotationAlignment: 'viewport', pitchAlignment: 'viewport' })
      .setLngLat([position.lng, position.lat])
      .addTo(map)
    // position/color/avatar are intentionally not deps - creation only happens once map is ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady])

  useEffect(() => {
    if (!carMarkerElRef.current) return
    carMarkerElRef.current.innerHTML = carMarkerMarkup(selectedAvatarId, selectedColor, name)
  }, [selectedAvatarId, selectedColor, name])

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
      const speed = Math.floor(10 + Math.random() * 30)
      setWind({ direction, speed, angle: CARDINAL_ANGLES[direction] })
    }

    updateWind()
    const interval = window.setInterval(updateWind, 20000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    const isTooCloseToAnyPlayer = (lat, lng) => {
      const live = liveRef.current
      const self = positionRef.current
      if (self && haversine([lat, lng], [self.lat, self.lng]) < 50) return true
      return Object.values(live.livePositions || {}).some((p) => haversine([lat, lng], [p.lat, p.lng]) < 50)
    }

    const spawnCloudNear = (anchor) => {
      const isSurvival = liveRef.current.currentRoom?.mode === 'survival'
      let lat, lng
      // For survival, retry a few times to avoid spawning right on top of a player; accept the
      // last candidate even if still close rather than spawning nothing.
      for (let attempt = 0; attempt < (isSurvival ? 10 : 1); attempt++) {
        const bearing = Math.random() * 360
        const distance = 250 + Math.random() * 650
        ;[lat, lng] = offsetLatLng([anchor.lat, anchor.lng], bearing, distance)
        if (!isSurvival || !isTooCloseToAnyPlayer(lat, lng)) break
      }
      return {
        id: crypto.randomUUID(),
        lat,
        lng,
        radiusMeters: randomCloudRadius(isSurvival ? 2 : 1),
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

  const updateRoom = useCallback(
    (roomCodeToUpdate, roomUpdater) => {
      const nextRooms = rooms.map((room) => {
        if (room.code !== roomCodeToUpdate) return room
        return roomUpdater(room)
      })
      setRooms(nextRooms)
    },
    [rooms, setRooms]
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
      const items = isFinder && graph
        ? FINDER_ITEM_ICON_IDS.map((iconId, i) => {
            const pt = pickRandomStreetPoint(graph) || defaultPosition
            return { id: `item-${i}-${crypto.randomUUID()}`, iconId, lat: pt.lat, lng: pt.lng, foundBy: null }
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
      for (const p of currentRoom.players) {
        finalHealth[p.name] = p.name === name ? healthRef.current : live.livePositions[p.name]?.health ?? p.health ?? 0
      }
      const maxHealth = Math.max(...Object.values(finalHealth))
      updateRoom(currentRoom.code, (room) => ({
        ...room,
        status: 'finished',
        winners: room.players.filter((p) => finalHealth[p.name] === maxHealth).map((p) => p.name),
        players: room.players.map((p) => ({ ...p, health: finalHealth[p.name] }))
      }))
    }, 1000)
    return () => window.clearInterval(interval)
  }, [isRoomHost, currentRoom, name, updateRoom])

  // Tag round resolution (host-only): either It eliminates every other player ("It won") or the
  // 5-minute mark passes first ("It lost", every still-alive non-It player wins).
  useEffect(() => {
    if (!isRoomHost || currentRoom?.mode !== 'tag' || currentRoom.status !== 'playing' || !currentRoom.roundStartedAt) return
    const others = currentRoom.players.filter((p) => p.name !== currentRoom.itName)
    if (others.length && others.every((p) => p.eliminated)) {
      updateRoom(currentRoom.code, (room) => (room.status === 'finished' ? room : { ...room, status: 'finished', winners: [room.itName] }))
      return
    }
    const durationMs = MODE_CONFIG.tag.roundDurationMs
    const interval = window.setInterval(() => {
      if (Date.now() - currentRoom.roundStartedAt < durationMs) return
      updateRoom(currentRoom.code, (room) => {
        if (room.status === 'finished') return room
        const survivors = room.players.filter((p) => p.name !== room.itName && !p.eliminated)
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

  const closeRoom = useCallback(() => {
    if (!currentRoom) return
    setRooms(rooms.filter((room) => room.code !== currentRoom.code))
    setJoinedRoomCode(null)
    setStarted(false)
  }, [currentRoom, rooms, setRooms])

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

    const nextRooms = rooms
      .map((room) => {
        if (room.code !== joinedRoomCode) return room
        const remainingPlayers = room.players.filter((player) => player.name !== name)
        if (!remainingPlayers.length) return null
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
          nextRoom.host = remainingPlayers[0].name
        }
        return nextRoom
      })
      .filter(Boolean)

    setRooms(nextRooms)
    setJoinedRoomCode(null)
    setStarted(false)
  }, [joinedRoomCode, name, rooms, setRooms])

  const createRoom = useCallback(() => {
    const sanitizedName = name.trim() || 'Player'
    const code = roomCode.trim().toUpperCase() || generateRoomCode()
    const existing = rooms.find((room) => room.code === code)
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
      players: [{ name: sanitizedName, color: selectedColor, eliminated: false }],
      clouds: [],
      items: [],
      itName: null,
      roundStartedAt: null,
      winners: [],
      maxPlayers: getRoomCapacity(mode)
    }

    setRooms([...rooms, newRoom])
    setJoinedRoomCode(code)
    setRoomCode(code)
    setStarted(!MODE_CONFIG[mode]?.hostGatedStart)
  }, [mode, name, roomCode, selectedColor, rooms, setRooms])

  const joinRoom = useCallback(
    (codeToJoin) => {
      const code = codeToJoin?.trim().toUpperCase() || roomCode.trim().toUpperCase()
      if (!code) {
        alert('Enter a room code to join.')
        return
      }
      const room = rooms.find((item) => item.code === code)
      if (!room) {
        alert('Room not found.')
        return
      }
      const sanitizedName = name.trim() || 'Player'
      if (room.players.some((player) => player.name === sanitizedName)) {
        setJoinedRoomCode(code)
        setMode(room.mode)
        setStarted(room.status === 'playing' && !currentPlayer?.eliminated)
        return
      }
      if (room.players.length >= room.maxPlayers) {
        alert('This room is full.')
        return
      }

      const newPlayer = {
        name: sanitizedName,
        color: selectedColor,
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

      const nextRooms = rooms.map((item) => (item.code === code ? nextRoom : item))
      setRooms(nextRooms)
      setJoinedRoomCode(code)
      setMode(room.mode)
      setStarted(nextRoom.status === 'playing')
    },
    [roomCode, rooms, selectedColor, name, currentPlayer, setRooms]
  )

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
      return currentRoom.players
        .filter((p) => p.name !== name && livePositions[p.name])
        .map((p) => {
          const live = livePositions[p.name]
          const point = map.project([live.lng, live.lat])
          return {
            name: p.name,
            color: p.color,
            eliminated: !!p.eliminated,
            screenX: (point.x / width) * 100,
            screenY: (point.y / height) * 100
          }
        })
    } catch {
      return []
    }
  }, [currentRoom, name, livePositions])

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
          return { id: item.id, iconId: item.iconId, screenX: (point.x / width) * 100, screenY: (point.y / height) * 100 }
        })
    } catch {
      return []
    }
  }, [currentRoom, currentPlayer])

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
                    <input value={roomCode} onChange={(e) => setRoomCode(e.target.value.toUpperCase())} placeholder="ROOM123" />
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
                    <button className="leave-room" onClick={closeRoom}>Leave room</button>
                  </div>
                ) : null}
                {MODE_CONFIG[mode]?.roomBased && !joinedRoomCode ? (
                  <div className="room-list">
                    <div className="room-list-title">Available rooms</div>
                    {rooms.filter((room) => room.mode === mode && room.status !== 'closed').length ? (
                      rooms
                        .filter((room) => room.mode === mode && room.status !== 'closed')
                        .map((room) => (
                          <div key={room.code} className="room-item">
                            <div>
                              <strong>{room.code}</strong> · {room.players.length}/{room.maxPlayers}
                            </div>
                            <button onClick={() => { setRoomCode(room.code); joinRoom(room.code) }}>Join</button>
                          </div>
                        ))
                    ) : (
                      <div className="room-empty">No rooms available yet.</div>
                    )}
                  </div>
                ) : null}
                <label>Options</label>
                <div className="center-toggle">
                  <label>
                    <input type="checkbox" checked={showStreetNames} onChange={(e) => setShowStreetNames(e.target.checked)} /> Street names
                  </label>
                </div>
                <button className="cloud-button" onClick={addCloud} disabled={cloudCooldown}>Add cloud</button>
              </div>
            </div>
          </div>
        ) : null}
        {currentRoom ? (
          <div className="room-meta">
            <div>Room <strong>{currentRoom.code}</strong></div>
            <div>Status: <strong>{currentRoom.status}</strong></div>
            <div>Host: <strong>{currentRoom.host || 'Host'}</strong></div>
            {roundRemainingLabel ? <div>Time left: <strong>{roundRemainingLabel}</strong></div> : null}
            {isRoomHost ? (
              <div className="host-controls">
                {currentRoom.status !== 'playing' ? (
                  <button className="cloud-button" onClick={startRoom}>Start round</button>
                ) : (
                  <button className="leave-room" onClick={stopRoom}>Stop round</button>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
        {gameMessage ? <div className="game-message">{gameMessage}</div> : null}
        {currentRoom ? (
          <div className="room-player-list">
            <div className="room-player-title">Players</div>
            {currentRoom.players.map((player) => {
              const isSelf = player.name === name
              const live = livePositions[player.name]
              return (
                <div key={player.name} className="room-player-item">
                  <span style={{ color: player.color }}>
                    {player.name}
                    {currentRoom.itName === player.name ? ' (It)' : ''}
                  </span>
                  {currentRoom.mode === 'survival' ? (
                    <span className="player-status active">{Math.round(isSelf ? health : live?.health ?? player.health ?? 1000)} HP</span>
                  ) : currentRoom.mode === 'finder-easy' || currentRoom.mode === 'finder-hard' ? (
                    <span className="player-status active">{isSelf ? (player.foundItems || []).length : live?.foundCount ?? 0}/{FINDER_ITEM_ICON_IDS.length}</span>
                  ) : player.eliminated ? (
                    <span className="player-status">Eliminated</span>
                  ) : (
                    <span className="player-status active">Alive</span>
                  )}
                </div>
              )
            })}
          </div>
        ) : null}
        {currentRoom && (currentRoom.mode === 'finder-easy' || currentRoom.mode === 'finder-hard') ? (
          <div className="item-tracker">
            <div className="room-player-title">Items ({(currentPlayer?.foundItems || []).length}/{FINDER_ITEM_ICON_IDS.length})</div>
            {itemDistances.map((item) => (
              <div key={item.id} className={`item-tracker-item${item.found ? ' item-tracker-found' : ''}`}>
                <span className="item-tracker-icon" style={{ color: selectedColor }} dangerouslySetInnerHTML={{ __html: getAvatarSvg(item.iconId) }} />
                <span>{item.found ? 'Found!' : `${Math.round(item.distanceMeters)} m`}</span>
              </div>
            ))}
          </div>
        ) : null}
        {started ? (
          <div className="status-panel">
            <div className="center-toggle">
              <label>
                <input type="checkbox" checked={showStreetNames} onChange={(e) => setShowStreetNames(e.target.checked)} /> Street names
              </label>
            </div>
            <div className="turbo-hint">Hold Shift for Turbo</div>
            <button className={`cloud-button${turboButtonOn ? ' turbo-toggle-on' : ''}`} onClick={() => setTurboButtonOn((t) => !t)}>
              {turboButtonOn ? 'Turbo: ON' : 'Turbo'}
            </button>
            <button className="cloud-button" onClick={addCloud} disabled={cloudCooldown}>Add cloud</button>
            {joinedRoomCode ? (
              <button className="leave-room" onClick={leaveRoom}>Leave room</button>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="map-panel">
        <MapView
          tileUrls={showStreetNames ? THEMES.voyager.baseWithLabels : THEMES.voyager.baseNoLabels}
          attribution={THEMES.voyager.attribution}
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
        <ScreenOverlay wind={wind} players={screenPlayers} items={screenItems} started={started} name={name} speedKmh={displayedSpeed} turboActive={turboActive} />
      </div>
    </div>
  )
}
