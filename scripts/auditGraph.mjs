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
import { buildGraph, findRiskyIntersections, findShallowForks, findMissingConnections } from '../src/mapUtils.js'
import { CONFIG } from '../src/config.js'

const SEGMENTS_PATH = path.resolve('public/data/QBC/segments.json')
const OUTPUT_DIR = path.resolve('scripts/output')

function withinBbox(polyline) {
  const { south, west, north, east } = CONFIG.bbox
  return polyline.some(([lat, lng]) => lat >= south && lat <= north && lng >= west && lng <= east)
}

const data = JSON.parse(fs.readFileSync(SEGMENTS_PATH, 'utf8'))
const segments = data.filter((s) => s.city === 'Québec' && withinBbox(s.polyline))
const graph = buildGraph(segments)
const allEdges = Array.from(graph.edges.values())

console.log(`Loaded ${segments.length} street segments -> ${graph.nodes.size} intersections, ${graph.edges.size} drivable street pieces.\n`)

// --- Issue 1: missing connections -------------------------------------------------------------

const missingConnections = findMissingConnections(graph, { bbox: CONFIG.bbox })

console.log(`ISSUE 1 - Missing connections: ${missingConnections.length} spots where a street stops short of another nearby street it should probably join.`)
console.log('(Genuine real-world dead-ends are excluded from this list.)\n')
for (const m of missingConnections.slice(0, 30)) {
  console.log(`  "${m.streetName}" doesn't connect to nearby "${m.gap.edgeName}" (${Math.round(m.gap.distance)}m gap)  [${m.coord[0].toFixed(5)}, ${m.coord[1].toFixed(5)}]`)
}
if (missingConnections.length > 30) console.log(`  ...and ${missingConnections.length - 30} more (see the GeoJSON file).`)

// --- Issue 2: wrong-turn intersections ----------------------------------------------------------

const risky = findRiskyIntersections(graph)
console.log(`\nISSUE 2 - Wrong-turn intersections (raw geometry, pre-mitigation): ${risky.length} spots where the smallest-angle candidate isn't the same street.`)
console.log('chooseNextSegment now prefers a same-named continuation within 40deg over a smaller-angle')
console.log('stranger, so these should no longer actually misturn in-game - this list is a lower bound')
console.log('on where that mitigation is doing real work, not a live bug list anymore.\n')
for (const r of risky) {
  console.log(`  On "${r.streetName}", going straight can wrongly divert onto "${r.divertsToName}"  [${r.coord[0].toFixed(5)}, ${r.coord[1].toFixed(5)}]`)
}
const highwayRisky = risky.filter((r) => /autoroute/i.test(r.streetName) || /autoroute/i.test(r.divertsToName))
console.log(`\n  -> ${highwayRisky.length} of those involve a highway (matches the "highways are the most glitchy" pattern).`)

// --- Issue 3: shallow forks (turn-signal <10deg fix, other spots with the same shape) ----------
//
// Fixed live for one exact case (Autoroute Henri-IV / Bretelle Aut. 73 Nord, Henri IV Nord) - a
// real, differently-named fork existed but split off at such a shallow angle that neither it nor
// the mainline cleared chooseNextSegment's +-10deg "clearly left/right" threshold, so an explicit
// turn signal was silently ignored. The fix (any other-named candidate wins over doing nothing) is
// now general, but this list surfaces every OTHER spot with the same shallow-angle shape so they can
// be spot-checked directly instead of waiting for more live reports.

const shallowForks = findShallowForks(graph)
console.log(`\nISSUE 3 - Shallow forks: ${shallowForks.length} spots where a real, differently-named fork splits off within 10deg of straight ahead.`)
console.log('(The turn-signal fix now handles these generally - this list is for spot-checking, not a live bug list.)\n')
for (const f of shallowForks.slice(0, 30)) {
  console.log(`  On "${f.streetName}", "${f.forkName}" forks off just ${Math.abs(f.angleDeg)}deg away  [${f.coord[0].toFixed(5)}, ${f.coord[1].toFixed(5)}]`)
}
if (shallowForks.length > 30) console.log(`  ...and ${shallowForks.length - 30} more (see the GeoJSON file).`)
const highwayShallow = shallowForks.filter((f) => /autoroute/i.test(f.streetName) || /autoroute/i.test(f.forkName))
console.log(`\n  -> ${highwayShallow.length} of those involve a highway.`)

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
console.log(`\nISSUE 4 - Short blocks (risk indicator, not a confirmed bug): ${shortBlocks.length} street pieces shorter than a tapped turn signal's 1.2s window at Turbo speed.`)
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

fs.writeFileSync(path.join(OUTPUT_DIR, 'shallow-forks.geojson'), JSON.stringify({
  type: 'FeatureCollection',
  features: shallowForks.map((f) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [f.coord[1], f.coord[0]] },
    properties: { streetName: f.streetName, forkName: f.forkName, angleDeg: f.angleDeg }
  }))
}, null, 2))

console.log(`\nWrote scripts/output/missing-connections.geojson, wrong-turn-intersections.geojson and shallow-forks.geojson`)
