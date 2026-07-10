import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import MapView from './MapView'
import { CONFIG, THEMES } from './config'
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
  haversine
} from './mapUtils'
import './App.css'

const CAR_COLORS = ['#4285F4', '#DB4437', '#F4B400', '#0F9D58', '#9C27B0', '#FF6D00']
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

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function carMarkerMarkup(color, label) {
  const safeLabel = escapeHtml(label || '')
  return `${safeLabel ? `<div class="car-marker-label">${safeLabel}</div>` : ''}<svg width="26" height="26" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 2.5L19.5 21L12 17L4.5 21L12 2.5Z" fill="${color}" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/>
  </svg>`
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
  const vertexCount = 11 + Math.floor(rand() * 5)
  const points = []
  for (let i = 0; i < vertexCount; i++) {
    const angle = (360 * i) / vertexCount + (rand() - 0.5) * 14
    const radiusFactor = 0.62 + rand() * 0.65
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
      properties: { id: cloud.id }
    }))
  }
}

// Most clouds are modest, but occasionally (~15%) spawn a genuinely huge one spanning several
// street blocks, per the "clouds should feel epic sometimes, not uniformly small" request.
function randomCloudRadius() {
  if (Math.random() < 0.15) return 220 + Math.random() * 280
  return 20 + Math.random() * 70
}

const defaultPosition = {
  lat: CONFIG.startPosition.lat,
  lng: CONFIG.startPosition.lng,
  speed: 0
}

const ROOM_STORAGE_KEY = 'mapdash_rooms'
const ROOM_CHANNEL_NAME = 'mapdash_multiplayer'
const isBroadcastChannelSupported = typeof window !== 'undefined' && 'BroadcastChannel' in window
const roomChannel = isBroadcastChannelSupported ? new BroadcastChannel(ROOM_CHANNEL_NAME) : null

function readStoredRooms() {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(ROOM_STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function persistRooms(rooms) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(ROOM_STORAGE_KEY, JSON.stringify(rooms))
  } catch {}
}

function postRoomSync(rooms) {
  if (!roomChannel) return
  try {
    roomChannel.postMessage({ type: 'rooms', rooms })
  } catch {}
}

function useRoomSync() {
  const [rooms, setRooms] = useState([])

  useEffect(() => {
    const stored = readStoredRooms()
    setRooms(stored)

    const handleChannel = (event) => {
      if (event?.data?.type === 'rooms' && Array.isArray(event.data.rooms)) {
        persistRooms(event.data.rooms)
        setRooms(event.data.rooms)
      }
    }

    const handleStorage = (event) => {
      if (event.key !== ROOM_STORAGE_KEY) return
      if (!event.newValue) {
        setRooms([])
        return
      }
      try {
        const next = JSON.parse(event.newValue)
        if (Array.isArray(next)) setRooms(next)
      } catch {}
    }

    roomChannel?.addEventListener('message', handleChannel)
    window.addEventListener('storage', handleStorage)

    return () => {
      roomChannel?.removeEventListener('message', handleChannel)
      window.removeEventListener('storage', handleStorage)
    }
  }, [])

  const updateRooms = useCallback((nextRooms) => {
    setRooms(nextRooms)
    persistRooms(nextRooms)
    postRoomSync(nextRooms)
  }, [])

  return [rooms, updateRooms]
}

function generateRoomCode() {
  const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 5; i++) {
    code += letters[Math.floor(Math.random() * letters.length)]
  }
  return code
}

function useDrivingControls(started, onControlsChange, onZoomChange) {
  useEffect(() => {
    if (!started) return

    const pressed = { forward: false, reverse: false, left: false, right: false }
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
    }

    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [started, onControlsChange, onZoomChange])
}

function ScreenOverlay({ wind, players = [] }) {
  return (
    <div className="screen-overlay">
      <div className="overlay-top-left">
        <div className="mode-pill">Wind: {wind.direction} · {wind.speed} km/h</div>
      </div>
      {players.map((p) => (
        <div key={p.id} className={`player-dot ${p.eliminated ? 'eliminated' : ''}`} style={{ left: `${p.screenX}%`, top: `${p.screenY}%`, background: p.color }} title={p.name} />
      ))}
    </div>
  )
}

export default function App({ playerName }) {
  const [mode, setMode] = useState('single')
  const [started, setStarted] = useState(false)
  const [zoom, setZoom] = useState(CONFIG.defaultZoom)
  const [position, setPosition] = useState(defaultPosition)
  const [heading, setHeading] = useState(0)
  const [segments, setSegments] = useState([])
  const [graph, setGraph] = useState(null)
  const [currentEdgeId, setCurrentEdgeId] = useState(null)
  const [activeStreet, setActiveStreet] = useState('Rue inconnue')
  const [activeArrondissement, setActiveArrondissement] = useState('')
  const [activeQuartier, setActiveQuartier] = useState('')
  const [controls, setControls] = useState({ forward: false, reverse: false, left: false, right: false })
  const [turnPreference, setTurnPreference] = useState('straight')
  const [clouds, setClouds] = useState([])
  const [centerCar, setCenterCar] = useState(true)
  const [wind, setWind] = useState({ direction: 'NE', speed: 20, angle: CARDINAL_ANGLES.NE })
  const [roomCode, setRoomCode] = useState('')
  const name = playerName || 'Player'
  const [selectedColor, setSelectedColor] = useState(CAR_COLORS[0])
  const [cloudCooldown, setCloudCooldown] = useState(false)
  const [rooms, setRooms] = useRoomSync()
  const [joinedRoomCode, setJoinedRoomCode] = useState(null)
  const [eliminated, setEliminated] = useState(false)
  const [gameMessage, setGameMessage] = useState('')
  const [playerId] = useState(() => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)))
  const [countdown, setCountdown] = useState(0)
  const countdownRef = useRef(null)
  const [mapReady, setMapReady] = useState(false)
  const [showStreetNames, setShowStreetNames] = useState(true)
  const [pickedSpawn, setPickedSpawn] = useState(null)
  const [pickingSpawn, setPickingSpawn] = useState(false)
  const mapBearingRef = useRef(0)
  const centerCarRef = useRef(true)
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
        'fill-color': '#ffffff',
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
    centerCarRef.current = centerCar
  }, [centerCar])

  useEffect(() => {
    startedRef.current = started
  }, [started])

  useEffect(() => {
    positionRef.current = position
  }, [position])

  const currentRoom = useMemo(
    () => rooms.find((room) => room.code === joinedRoomCode) || null,
    [rooms, joinedRoomCode]
  )

  const currentPlayer = useMemo(
    () => currentRoom?.players.find((player) => player.id === playerId) || null,
    [currentRoom, playerId]
  )

  const isRoomHost = useMemo(() => currentRoom?.host === playerId, [currentRoom, playerId])

  useEffect(() => {
    if (!currentRoom) {
      setGameMessage('')
      return
    }

    if (currentRoom.status === 'finished') {
      const winner = currentRoom.players.find((player) => !player.eliminated)
      if (winner) {
        setGameMessage(winner.id === playerId ? 'You survived and won!' : `${winner.name} survived and won!`)
      } else {
        setGameMessage('All players were hit. Survival round ended.')
      }
      return
    }

    if (currentRoom.mode === 'survival') {
      if (currentPlayer?.eliminated) {
        setGameMessage('You were hit by a cloud! Watch for the next round.')
      } else if (currentRoom.status === 'waiting') {
        setGameMessage('Waiting for another player to join...')
      } else {
        setGameMessage('Dodge clouds! Last player remaining wins.')
      }
      return
    }

    setGameMessage('')
  }, [currentRoom, currentPlayer, playerId])

  const mapRef = useRef(null)
  const movementRef = useRef({ distanceAlong: 0, direction: 1 })
  const animationRef = useRef(null)
  const pendingTurnRef = useRef(null)
  const reverseHoldStartRef = useRef(null)

  const currentSegment = useMemo(() => graph?.edges.get(currentEdgeId) || null, [graph, currentEdgeId])
  const displayedSpeed = useMemo(() => {
    if (controls.forward) return currentSegment?.speedKmh ?? 50
    if (controls.reverse) return 25
    return 0
  }, [controls, currentSegment])

  const syncPlayerState = useCallback(
    (pos, headingVal, speedVal) => {
      if (!joinedRoomCode) return
      setRooms((prev) =>
        prev.map((room) => {
          if (room.code !== joinedRoomCode) return room
          const players = room.players.map((p) =>
            p.id === playerId ? { ...p, position: { lat: pos.lat, lng: pos.lng }, heading: headingVal, speed: speedVal, lastSeen: Date.now() } : p
          )
          return { ...room, players }
        })
      )
    },
    [joinedRoomCode, playerId, setRooms]
  )

  const zoomIn = () => setZoom((z) => Math.min(CONFIG.maxZoom, z + 1))
  const zoomOut = () => setZoom((z) => Math.max(CONFIG.minZoom, z - 1))

  const quitGame = useCallback(() => {
    setStarted(false)
    setJoinedRoomCode(null)
    setEliminated(false)
    // optional: reset position to default
    setPosition(defaultPosition)
  }, [setStarted, setJoinedRoomCode])

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
    // to north-up instead; the instant the player actually starts driving, heading is recomputed
    // correctly from real movement (verified separately) and the map eases to match it.
    setHeading(0)
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
        // Before driving starts this recomputes every frame from the spawn segment's arbitrary
        // polyline direction even though nothing is moving, which would immediately overwrite
        // the spawn effect's deliberate north-up default within a frame. Only take over once
        // driving has actually begun.
        if (startedRef.current) setHeading(displayedHeading)
        setActiveStreet(nextSegment.name || 'Rue inconnue')
        setActiveArrondissement(nextSegment.arrondissement || '')
        setActiveQuartier(nextSegment.quartier || '')
        // Sync this player's state into the shared room so other tabs see it
        syncPlayerState(posObj, displayedHeading, displayedSpeed)

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
          if (centerCarRef.current) {
            map.jumpTo({ center: [posObj.lng, posObj.lat], bearing: mapBearingRef.current })
          } else {
            map.setBearing(mapBearingRef.current)
          }
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
    el.innerHTML = carMarkerMarkup(selectedColor, name)
    carMarkerElRef.current = el
    carMarkerRef.current = new maplibregl.Marker({ element: el, rotationAlignment: 'viewport', pitchAlignment: 'viewport' })
      .setLngLat([position.lng, position.lat])
      .addTo(map)
    // position/color are intentionally not deps - creation only happens once map is ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady])

  useEffect(() => {
    if (!carMarkerElRef.current) return
    carMarkerElRef.current.innerHTML = carMarkerMarkup(selectedColor, name)
  }, [selectedColor, name])

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
    const spawnCloudNear = (anchor) => {
      const bearing = Math.random() * 360
      const distance = 250 + Math.random() * 650
      const [lat, lng] = offsetLatLng([anchor.lat, anchor.lng], bearing, distance)
      return { id: crypto.randomUUID(), lat, lng, radiusMeters: randomCloudRadius() }
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
      return { id: crypto.randomUUID(), lat, lng, radiusMeters: randomCloudRadius() }
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

  

  const getRoomCapacity = (roomMode) => (roomMode === 'survival' ? 2 : 4)

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


  const restartImmediate = useCallback(() => {
    if (!currentRoom) return
    const nextRoom = {
      ...currentRoom,
      status: currentRoom.mode === 'survival'
        ? currentRoom.players.length > 1
          ? 'playing'
          : 'waiting'
        : 'playing',
      players: currentRoom.players.map((player) => ({ ...player, eliminated: false })),
      winnerId: null
    }
    updateRoom(currentRoom.code, () => nextRoom)
    setEliminated(false)
    setStarted(nextRoom.status === 'playing')
  }, [currentRoom, updateRoom])

  // Auto-restart survival rounds when finished (host only)
  useEffect(() => {
    if (!currentRoom || !isRoomHost) return
    if (currentRoom.status === 'finished' && currentRoom.mode === 'survival') {
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
    const nextRoom = {
      ...currentRoom,
      status: currentRoom.mode === 'survival' ? (currentRoom.players.length > 1 ? 'playing' : 'waiting') : 'playing',
      players: currentRoom.players.map((p) => ({ ...p, eliminated: false }))
    }
    updateRoom(currentRoom.code, () => nextRoom)
    setEliminated(false)
    setStarted(nextRoom.status === 'playing')
  }, [currentRoom, isRoomHost, updateRoom])

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
      status: currentRoom.mode === 'survival' ? 'finished' : 'waiting'
    }
    updateRoom(currentRoom.code, () => nextRoom)
    setStarted(false)
  }, [currentRoom, isRoomHost, updateRoom])

  const leaveRoom = useCallback(() => {
    if (!joinedRoomCode) return

    const nextRooms = rooms
      .map((room) => {
        if (room.code !== joinedRoomCode) return room
        const remainingPlayers = room.players.filter((player) => player.id !== playerId)
        if (!remainingPlayers.length) return null
        const nextRoom = {
          ...room,
          players: remainingPlayers,
          status:
            room.mode === 'survival'
              ? remainingPlayers.length >= 2
                ? 'playing'
                : 'finished'
              : remainingPlayers.length >= 2
              ? 'playing'
              : 'waiting'
        }
        if (room.host === playerId) {
          nextRoom.host = remainingPlayers[0].id
        }
        if (room.mode === 'survival' && nextRoom.status === 'finished' && remainingPlayers.length === 1) {
          nextRoom.players = remainingPlayers.map((player) => ({ ...player, eliminated: player.eliminated || false }))
        }
        return nextRoom
      })
      .filter(Boolean)

    setRooms(nextRooms)
    setJoinedRoomCode(null)
    setStarted(false)
  }, [joinedRoomCode, playerId, rooms, setRooms])

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
      host: playerId,
      status: mode === 'survival' ? 'waiting' : 'playing',
      createdAt: Date.now(),
      players: [{ id: playerId, name: sanitizedName, color: selectedColor, eliminated: false, position: defaultPosition, heading: 0, speed: 0 }],
      clouds: [],
      winnerId: null,
      maxPlayers: getRoomCapacity(mode)
    }

    setRooms([...rooms, newRoom])
    setJoinedRoomCode(code)
    setRoomCode(code)
    setStarted(mode === 'team')
  }, [mode, name, roomCode, playerId, selectedColor, rooms, setRooms])

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
      if (room.players.some((player) => player.id === playerId)) {
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
        id: playerId,
        name: name.trim() || 'Player',
        color: selectedColor,
        eliminated: false
      }

      const nextRoom = {
        ...room,
        players: [...room.players, newPlayer],
        status: room.mode === 'survival' ? 'playing' : 'playing'
      }

      const nextRooms = rooms.map((item) => (item.code === code ? nextRoom : item))
      setRooms(nextRooms)
      setJoinedRoomCode(code)
      setMode(room.mode)
      setStarted(true)
    },
    [playerId, roomCode, rooms, selectedColor, name, setRooms]
  )

  const addCloud = () => {
    if (cloudCooldown || eliminated) return
    const anchor = positionRef.current || CONFIG.startPosition
    const bearing = Math.random() * 360
    const distance = 150 + Math.random() * 500
    const [lat, lng] = offsetLatLng([anchor.lat, anchor.lng], bearing, distance)
    const newCloud = { id: crypto.randomUUID(), lat, lng, radiusMeters: randomCloudRadius() }
    if (currentRoom && isRoomHost) {
      updateRoom(currentRoom.code, (room) => ({ ...room, clouds: [...(room.clouds || []), newCloud].slice(-8) }))
    } else {
      setClouds((prev) => [...prev, newCloud].slice(-8))
    }
    setCloudCooldown(true)
    window.setTimeout(() => setCloudCooldown(false), 10000)
  }

  const screenPlayers = useMemo(() => {
    if (!currentRoom || !mapRef.current) return []
    try {
      const map = mapRef.current
      const container = map.getContainer()
      const width = container.clientWidth
      const height = container.clientHeight
      return currentRoom.players
        .filter((p) => p.id !== playerId && p.position)
        .map((p) => {
          const point = map.project([p.position.lng, p.position.lat])
          return {
            id: p.id,
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
  }, [currentRoom, playerId])

  const checkCloudCollision = useCallback(() => {
    if (eliminated || !currentRoom || currentRoom.mode !== 'survival' || currentRoom.status !== 'playing') return false
    return clouds.some((cloud) => haversine([position.lat, position.lng], [cloud.lat, cloud.lng]) <= cloud.radiusMeters)
  }, [clouds, currentRoom, eliminated, position])

  const handleElimination = useCallback(() => {
    if (eliminated || !currentRoom) return

    setEliminated(true)
    setStarted(false)

    const updatedRoom = {
      ...currentRoom,
      players: currentRoom.players.map((player) =>
        player.id === playerId ? { ...player, eliminated: true } : player
      )
    }

    const survivors = updatedRoom.players.filter((player) => !player.eliminated)
    if (survivors.length === 1) {
      updatedRoom.status = 'finished'
      updatedRoom.winnerId = survivors[0].id
    } else if (survivors.length === 0) {
      updatedRoom.status = 'finished'
      updatedRoom.winnerId = null
    }

    updateRoom(updatedRoom.code, () => updatedRoom)
  }, [currentRoom, eliminated, playerId, updateRoom])

  useEffect(() => {
    if (!started || eliminated || !currentRoom) return
    if (checkCloudCollision()) {
      handleElimination()
    }
  }, [checkCloudCollision, currentRoom, eliminated, handleElimination, started])

  return (
    <div className="app-shell">
      <div className="app-sidebar">
        <div className="mode-select">
          <button className={mode === 'single' ? 'active' : ''} onClick={() => { setMode('single'); setStarted(false) }}>Single</button>
          <button className={mode === 'team' ? 'active' : ''} onClick={() => { setMode('team'); setStarted(false) }}>Team</button>
          <button className={mode === 'survival' ? 'active' : ''} onClick={() => { setMode('survival'); setStarted(false) }}>Survival</button>
        </div>
        {!started ? (
          <div className="lobby-panel">
            <div className="lobby-name-display">Driving as <strong>{name}</strong></div>
            <label>Car color</label>
            <div className="color-picks">
              {CAR_COLORS.map((color) => (
                <button key={color} style={{ backgroundColor: color }} className={selectedColor === color ? 'selected' : ''} onClick={() => setSelectedColor(color)} />
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
            {mode === 'team' || mode === 'survival' ? (
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
                <div>{currentRoom.winnerId ? `${currentRoom.players.find((p) => p.id === currentRoom.winnerId)?.name || 'Winner'} won` : 'Round finished'}</div>
                {isRoomHost ? (
                  <button className="cloud-button" onClick={restartRoom}>Restart round</button>
                ) : null}
                <button className="leave-room" onClick={closeRoom}>Leave room</button>
              </div>
            ) : null}
            {mode !== 'team' && mode !== 'survival' && started && null}
            {(mode === 'team' || mode === 'survival') && !joinedRoomCode ? (
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
          </div>
        ) : null}
        {currentRoom ? (
          <div className="room-meta">
            <div>Room <strong>{currentRoom.code}</strong></div>
            <div>Status: <strong>{currentRoom.status}</strong></div>
            <div>Host: <strong>{currentRoom.players.find((p) => p.id === currentRoom.host)?.name || 'Host'}</strong></div>
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
            {currentRoom.players.map((player) => (
              <div key={player.id} className="room-player-item">
                <span style={{ color: player.color }}>{player.name}</span>
                {player.eliminated ? <span className="player-status">Eliminated</span> : <span className="player-status active">Alive</span>}
              </div>
            ))}
          </div>
        ) : null}
        <div className="status-panel">
          <div>Active street</div>
          <div className="status-value">{activeStreet}</div>
          {activeArrondissement || activeQuartier ? (
            <div className="status-location">
              {[activeArrondissement, activeQuartier].filter(Boolean).join(' · ')}
            </div>
          ) : null}
          <div className="status-row">
            <span>Driver</span>
            <strong>{name || 'Player'}</strong>
          </div>
          <div className="status-row">
            <span>Speed</span>
            <strong>{displayedSpeed} km/h</strong>
          </div>
          <div className="status-row">
            <span>Heading</span>
            <strong>{Math.round(heading)}°</strong>
          </div>
          <div className="center-toggle">
            <label>
              <input type="checkbox" checked={centerCar} onChange={(e) => setCenterCar(e.target.checked)} /> Center car
            </label>
          </div>
          <div className="center-toggle">
            <label>
              <input type="checkbox" checked={showStreetNames} onChange={(e) => setShowStreetNames(e.target.checked)} /> Street names
            </label>
          </div>
          <button className="cloud-button" onClick={addCloud} disabled={cloudCooldown}>Add cloud</button>
          {joinedRoomCode ? (
            <button className="leave-room" onClick={leaveRoom}>Leave room</button>
          ) : null}
        </div>
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
        <ScreenOverlay wind={wind} players={screenPlayers} />
      </div>
    </div>
  )
}
