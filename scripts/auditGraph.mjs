// Finds likely navigation bugs in the street graph up front, in one pass, instead of waiting to
// hit them one at a time while play-testing. Run with: npm run audit:graph
//
// Two issue types, matching the two real complaints:
//   1. Missing connections - a street stops short of another nearby street that it should
//      physically join (excludes real dead-ends/culs-de-sac, which are fine and not reported).
//   2. Wrong-turn intersections - holding straight ahead diverts you off your own street onto a
//      different one (very often a highway ramp merging in at a shallow angle), even though your
//      street genuinely continues through the intersection.
//
// Also writes scripts/output/*.geojson for both issue types - drop either file into
// https://geojson.io to see every flagged spot on a real map.

import fs from 'fs'
import path from 'path'
import { buildGraph, haversine, pointToSegmentDistance, findRiskyIntersections } from '../src/mapUtils.js'
import { CONFIG } from '../src/config.js'

const SEGMENTS_PATH = path.resolve('public/data/QBC/segments.json')
const OUTPUT_DIR = path.resolve('scripts/output')

const BBOX_MARGIN_DEG = 0.0005 // ~50m - a dead-end this close to the play area's edge just runs off the map, not a bug
const NEARBY_SEARCH_RADIUS_METERS = 60 // how far to look for "this should probably connect" candidates

function withinBbox(polyline) {
  const { south, west, north, east } = CONFIG.bbox
  return polyline.some(([lat, lng]) => lat >= south && lat <= north && lng >= west && lng <= east)
}

function isNearBboxEdge([lat, lng]) {
  const { south, west, north, east } = CONFIG.bbox
  return lat <= south + BBOX_MARGIN_DEG || lat >= north - BBOX_MARGIN_DEG ||
    lng <= west + BBOX_MARGIN_DEG || lng >= east - BBOX_MARGIN_DEG
}

const data = JSON.parse(fs.readFileSync(SEGMENTS_PATH, 'utf8'))
const segments = data.filter((s) => s.city === 'Québec' && withinBbox(s.polyline))
const graph = buildGraph(segments)
const allEdges = Array.from(graph.edges.values())

console.log(`Loaded ${segments.length} street segments -> ${graph.nodes.size} intersections, ${graph.edges.size} drivable street pieces.\n`)

// --- Issue 1: missing connections -------------------------------------------------------------

function nearestOtherEdgeGap(node) {
  const ownEdgeIds = new Set(node.edges.map((e) => e.id))
  let best = null
  for (const edge of allEdges) {
    if (ownEdgeIds.has(edge.id)) continue
    const roughlyClose = edge.polyline.some((pt) => haversine(node.coord, pt) <= NEARBY_SEARCH_RADIUS_METERS * 3)
    if (!roughlyClose) continue
    const result = pointToSegmentDistance(node.coord, edge.polyline)
    if (result.distance <= NEARBY_SEARCH_RADIUS_METERS && (!best || result.distance < best.distance)) {
      best = { distance: result.distance, edgeName: edge.name }
    }
  }
  return best
}

const danglingNodes = Array.from(graph.nodes.values()).filter((n) => n.edges.length === 1)
const interiorDangling = danglingNodes.filter((n) => !isNearBboxEdge(n.coord))
const missingConnections = interiorDangling
  .map((node) => ({ streetName: node.edges[0].name, coord: node.coord, gap: nearestOtherEdgeGap(node) }))
  .filter((n) => n.gap)
  .sort((a, b) => a.gap.distance - b.gap.distance)

console.log(`ISSUE 1 - Missing connections: ${missingConnections.length} spots where a street stops short of another nearby street it should probably join.`)
console.log('(Genuine real-world dead-ends are excluded from this list.)\n')
for (const m of missingConnections.slice(0, 30)) {
  console.log(`  "${m.streetName}" doesn't connect to nearby "${m.gap.edgeName}" (${Math.round(m.gap.distance)}m gap)  [${m.coord[0].toFixed(5)}, ${m.coord[1].toFixed(5)}]`)
}
if (missingConnections.length > 30) console.log(`  ...and ${missingConnections.length - 30} more (see the GeoJSON file).`)

// --- Issue 2: wrong-turn intersections ----------------------------------------------------------

const risky = findRiskyIntersections(graph)
console.log(`\nISSUE 2 - Wrong-turn intersections: ${risky.length} spots where going straight can wrongly divert you onto a different street.`)
console.log('(This is the "pressed W, it turned me onto a ramp/side street anyway" bug.)\n')
for (const r of risky) {
  console.log(`  On "${r.streetName}", going straight can wrongly divert onto "${r.divertsToName}"  [${r.coord[0].toFixed(5)}, ${r.coord[1].toFixed(5)}]`)
}
const highwayRisky = risky.filter((r) => /autoroute/i.test(r.streetName) || /autoroute/i.test(r.divertsToName))
console.log(`\n  -> ${highwayRisky.length} of those involve a highway (matches the "highways are the most glitchy" pattern).`)

// --- Issue 3: very short blocks (turn-signal timing risk) --------------------------------------
//
// NOT a confirmed bug list - a risk indicator. A tapped turn stays "pending" for 1.2s, meant to be
// used at the very next intersection reached. On a very short block, that intersection arrives
// almost immediately, which is fine on its own - the actual risk this flags is dense chains of
// short blocks in historic-grid neighborhoods (like Vieux-Québec), where the margin for error on
// timing gets tight. A specific real report (Rue Dalhousie) traced clean at the per-intersection
// angle level - every candidate there was correctly scored - so this alone doesn't explain that
// report; live console logging (gated behind the "Debug: street graph" checkbox in the app) was
// added instead to catch the real turnChoice/pendingTurn state next time it's reproduced.

const TURBO_MULTIPLIER = 2 // Turbo doubles the already-doubled display speed (see App.jsx)
const PENDING_TURN_WINDOW_SEC = 1.2

function dangerZoneMeters(speedKmh, turbo) {
  const displaySpeedKmh = speedKmh * 2 * (turbo ? TURBO_MULTIPLIER : 1)
  return (displaySpeedKmh / 3.6) * PENDING_TURN_WINDOW_SEC
}

const shortBlocks = allEdges.filter((e) => e.name && e.lengthMeters < dangerZoneMeters(e.speedKmh, true))
console.log(`\nISSUE 3 - Short blocks (risk indicator, not a confirmed bug): ${shortBlocks.length} street pieces shorter than a tapped turn signal's 1.2s window at Turbo speed.`)
console.log('(A single short block is fine; chains of them are the actual risk - see the streetName groupings below.)\n')
const byStreet = new Map()
for (const e of shortBlocks) {
  if (!byStreet.has(e.name)) byStreet.set(e.name, [])
  byStreet.get(e.name).push(e)
}
const chains = Array.from(byStreet.entries()).filter(([, edges]) => edges.length >= 3).sort((a, b) => b[1].length - a[1].length)
for (const [name, edges] of chains.slice(0, 15)) {
  console.log(`  "${name}": ${edges.length} short blocks in a row (avg ${Math.round(edges.reduce((s, e) => s + e.lengthMeters, 0) / edges.length)}m each)`)
}

// --- Write GeoJSON for visual inspection --------------------------------------------------------

fs.mkdirSync(OUTPUT_DIR, { recursive: true })

fs.writeFileSync(path.join(OUTPUT_DIR, 'missing-connections.geojson'), JSON.stringify({
  type: 'FeatureCollection',
  features: missingConnections.map((m) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [m.coord[1], m.coord[0]] },
    properties: { streetName: m.streetName, nearestStreetName: m.gap.edgeName, gapMeters: Math.round(m.gap.distance) }
  }))
}, null, 2))

fs.writeFileSync(path.join(OUTPUT_DIR, 'wrong-turn-intersections.geojson'), JSON.stringify({
  type: 'FeatureCollection',
  features: risky.map((r) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [r.coord[1], r.coord[0]] },
    properties: { streetName: r.streetName, divertsToName: r.divertsToName }
  }))
}, null, 2))

console.log(`\nWrote scripts/output/missing-connections.geojson and wrong-turn-intersections.geojson`)
