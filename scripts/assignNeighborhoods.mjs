// Fills in arrondissement/quartier for every Québec segment via point-in-polygon against Ville de
// Québec's real administrative boundaries - restores the data lost when segments.json was migrated
// to the official "Voies publiques" street dataset (see syncStreetData.mjs), which has no
// admin-area fields at all. Run with: npm run assign:neighborhoods (after sync:street-data).
//
// Source boundaries (data-sources/, not shipped to the browser - build-time only):
//   - district_delimiters.json: the 6 Québec arrondissements (already clean GeoJSON)
//   - quartiers-vdq.csv: the 35 official Québec quartiers (WKT, from Ville de Québec's own open
//     data), reused from a sibling project (C:\sites\gumballquiz\tools\fetchSegments.js) that
//     solved this exact join already - same source, no need to re-derive it.
//
// No new dependencies added (no turf/wellknown) - polygon-in-polygon overlaps are rare enough here
// (real administrative boundaries mostly partition cleanly) that a plain ray-casting point test and
// a small WKT parser cover this fully, without adding packages just for an occasional data script.

import fs from 'fs'
import path from 'path'

const SEGMENTS_PATH = path.resolve('public/data/QBC/segments.json')
const DISTRICTS_PATH = path.resolve('data-sources/district_delimiters.json')
const QUARTIERS_CSV_PATH = path.resolve('data-sources/quartiers-vdq.csv')

// --- minimal WKT POLYGON/MULTIPOLYGON parser (coords are lng,lat per WKT convention) -----------

function parseRing(text) {
  return text.split(',').map((pair) => {
    const [lng, lat] = pair.trim().split(/\s+/).map(Number)
    return [lng, lat]
  })
}

function parseWkt(wkt) {
  const trimmed = wkt.trim()
  const isMulti = /^MULTIPOLYGON/i.test(trimmed)
  const body = trimmed.replace(/^(MULTI)?POLYGON\s*/i, '')
  // A polygon is one or more parenthesized rings: ((ring1),(ring2)). A multipolygon is a list of
  // those: (((ring1)),((ring2))). Splitting on the ")),((" / "),(" boundaries by depth-tracking
  // avoids needing a real parser for this fairly simple, well-formed shape.
  const polygons = []
  let depth = 0
  let current = ''
  let rings = []
  let ringStart = -1
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === '(') {
      depth++
      if (depth === (isMulti ? 3 : 2)) ringStart = i + 1
    } else if (ch === ')') {
      if (depth === (isMulti ? 3 : 2)) {
        rings.push(parseRing(body.slice(ringStart, i)))
      }
      depth--
      if (depth === (isMulti ? 1 : 0) && rings.length) {
        polygons.push(rings)
        rings = []
      }
    }
  }
  return polygons // array of polygons, each an array of rings (first = outer), each ring an array of [lng,lat]
}

// Standard ray-casting point-in-ring test; a point is "in" the polygon if it's in the outer ring
// and not in any hole ring.
function pointInRing([px, py], ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    const intersects = ((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)
    if (intersects) inside = !inside
  }
  return inside
}

function pointInPolygon(pt, rings) {
  if (!pointInRing(pt, rings[0])) return false
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(pt, rings[i])) return false // inside a hole
  }
  return true
}

function ringArea(ring) {
  let sum = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
  }
  return Math.abs(sum / 2)
}

function polygonArea(rings) {
  return ringArea(rings[0])
}

function findContaining(pt, areas) {
  // Smallest-area match wins when boundaries slightly overlap (matches the approach the sibling
  // project's fetchSegments.js already used for this same kind of admin-boundary join).
  let best = null
  for (const area of areas) {
    for (const polygon of area.polygons) {
      if (pointInPolygon(pt, polygon)) {
        const a = polygonArea(polygon)
        if (!best || a < best.area) best = { name: area.name, area: a }
      }
    }
  }
  return best?.name ?? null
}

// --- load boundaries -----------------------------------------------------------------------

const districtsGeoJson = JSON.parse(fs.readFileSync(DISTRICTS_PATH, 'utf8'))
const arrondissements = districtsGeoJson.features
  .filter((f) => f.properties.city === 'Québec')
  .map((f) => ({
    name: f.properties.arrondissement,
    polygons: f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates
  }))
console.log('arrondissements loaded:', arrondissements.map((a) => a.name))

const quartiersCsv = fs.readFileSync(QUARTIERS_CSV_PATH, 'utf8').replace(/^﻿/, '').trim()
const csvLines = quartiersCsv.split(/\r?\n/)
const header = csvLines[0].match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g) || []
const idxNom = header.indexOf('NOM')
const idxGeom = header.indexOf('GEOMETRIE')
const quartiers = []
for (let i = 1; i < csvLines.length; i++) {
  const line = csvLines[i]
  if (!line.trim()) continue
  const cells = (line.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g) || []).map((c) => c.replace(/^"|"$/g, ''))
  const name = cells[idxNom]
  const wkt = cells[idxGeom]
  if (!name || !wkt) continue
  quartiers.push({ name, polygons: parseWkt(wkt) })
}
console.log('quartiers loaded:', quartiers.length)

// --- join ------------------------------------------------------------------------------------

const segments = JSON.parse(fs.readFileSync(SEGMENTS_PATH, 'utf8'))
let matchedArr = 0
let matchedQuartier = 0

for (const seg of segments) {
  if (seg.city !== 'Québec') continue
  // Centroid of the polyline's own points (same approach the sibling project used) - segments are
  // short enough that this is a good-enough representative point for a boundary lookup.
  let sumLat = 0, sumLng = 0
  for (const [lat, lng] of seg.polyline) { sumLat += lat; sumLng += lng }
  const lat = sumLat / seg.polyline.length
  const lng = sumLng / seg.polyline.length
  const pt = [lng, lat] // WKT/GeoJSON convention

  const arrondissement = findContaining(pt, arrondissements)
  if (arrondissement) { seg.arrondissement = arrondissement; matchedArr++ }

  const quartier = findContaining(pt, quartiers)
  if (quartier) { seg.quartier = quartier; matchedQuartier++ }
}

console.log(`matched arrondissement: ${matchedArr}/${segments.length}, quartier: ${matchedQuartier}/${segments.length}`)
fs.writeFileSync(SEGMENTS_PATH, JSON.stringify(segments))
console.log('Wrote', SEGMENTS_PATH)
