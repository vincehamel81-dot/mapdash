const METERS_PER_DEGREE_LAT = 111132.92
const METERS_PER_DEGREE_LNG_AT_LAT = (lat) => 111412.84 * Math.cos(lat * Math.PI / 180) - 93.5 * Math.cos(3 * lat * Math.PI / 180)

export function haversine([lat1, lng1], [lat2, lng2]) {
  const toRad = (deg) => deg * Math.PI / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)))
}

export function roundCoord(coord, digits = 6) {
  return `${coord[0].toFixed(digits)}|${coord[1].toFixed(digits)}`
}

// Move a point by `distanceMeters` along a compass bearing (0=N, 90=E, 180=S, 270=W, clockwise -
// matching CARDINAL_ANGLES/wind direction convention, NOT the counter-clockwise-from-east
// convention headingAngle() uses for street-facing headings).
export function offsetLatLng([lat, lng], bearingDeg, distanceMeters) {
  const rad = bearingDeg * Math.PI / 180
  const dLat = (distanceMeters * Math.cos(rad)) / METERS_PER_DEGREE_LAT
  const dLng = (distanceMeters * Math.sin(rad)) / METERS_PER_DEGREE_LNG_AT_LAT(lat)
  return [lat + dLat, lng + dLng]
}

export function segmentLengthMeters(polyline) {
  if (!Array.isArray(polyline) || polyline.length < 2) return 0
  let total = 0
  for (let i = 1; i < polyline.length; i++) {
    total += haversine(polyline[i - 1], polyline[i])
  }
  return total
}

export function assignSegmentSpeed(segment) {
  const name = (segment.name || '').toLowerCase()
  if (/autoroute|aut\b/.test(name)) return 100
  if (/route\s*\d+/.test(name)) return 90
  if (/boulevard|boul|avenue|av\b/.test(name)) return 70
  if (/chemin|rue|rte|road|drive|dr|place|cote|promenade|quai/.test(name)) return 50
  return 50
}

// Some source segments have consecutive duplicate (or near-duplicate) points - confirmed as the
// actual root cause of a "turns the wrong way no matter what" report at Rue Saint-Antoine/Rue
// Dalhousie: getLocalHeadingAtDistance computed the local heading from the FIRST two polyline
// points, and when those two points are identical the direction vector is (0,0), which resolves
// to a heading of exactly 0deg - a bogus "due north" value that has nothing to do with the
// street's real direction, silently corrupting chooseNextSegment's angle comparison for that
// candidate. Deduping here, once, up front, means every downstream consumer (heading calc, length,
// point-at-distance) just never sees a degenerate zero-length leg.
function dedupeConsecutivePoints(polyline) {
  if (!Array.isArray(polyline) || polyline.length < 2) return polyline
  const deduped = [polyline[0]]
  for (let i = 1; i < polyline.length; i++) {
    if (haversine(deduped[deduped.length - 1], polyline[i]) > 0.01) deduped.push(polyline[i])
  }
  return deduped.length >= 2 ? deduped : polyline
}

export function packageSegment(segment) {
  const polyline = dedupeConsecutivePoints(segment.polyline)
  const lengthMeters = segmentLengthMeters(polyline)
  return {
    ...segment,
    polyline,
    lengthMeters,
    speedKmh: assignSegmentSpeed(segment),
    startKey: roundCoord(polyline[0]),
    endKey: roundCoord(polyline[polyline.length - 1])
  }
}

// Real street data is extracted per-named-street, not "noded" at every real intersection, so
// two segments that physically meet often don't share an exact polyline endpoint. Merge nodes
// that are within `toleranceMeters` of each other into one logical intersection so the movement
// graph is actually navigable, using a grid-bucketed union-find to keep this fast at ~27k nodes.
const DEFAULT_NODE_MERGE_TOLERANCE_METERS = 12

function createUnionFind(size) {
  const parent = new Array(size)
  for (let i = 0; i < size; i++) parent[i] = i
  function find(i) {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  function union(a, b) {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }
  return { find, union }
}

function mergeNearbyNodes(rawNodes, toleranceMeters) {
  const keys = Array.from(rawNodes.keys())
  const nodeList = keys.map((key) => rawNodes.get(key))
  if (!nodeList.length) return new Map()

  const { find, union } = createUnionFind(nodeList.length)
  const refLat = nodeList[0].coord[0]
  const cellSizeMeters = Math.max(toleranceMeters, 15)
  const cellFor = ([lat, lng]) => [
    Math.floor((lng * METERS_PER_DEGREE_LNG_AT_LAT(refLat)) / cellSizeMeters),
    Math.floor((lat * METERS_PER_DEGREE_LAT) / cellSizeMeters)
  ]

  const buckets = new Map()
  nodeList.forEach((node, i) => {
    const [cx, cy] = cellFor(node.coord)
    const bucketKey = `${cx}|${cy}`
    if (!buckets.has(bucketKey)) buckets.set(bucketKey, [])
    buckets.get(bucketKey).push(i)
  })

  nodeList.forEach((node, i) => {
    const [cx, cy] = cellFor(node.coord)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const neighbors = buckets.get(`${cx + dx}|${cy + dy}`)
        if (!neighbors) continue
        for (const j of neighbors) {
          if (j <= i) continue
          if (haversine(node.coord, nodeList[j].coord) <= toleranceMeters) union(i, j)
        }
      }
    }
  })

  const merged = new Map()
  nodeList.forEach((node, i) => {
    const rootKey = keys[find(i)]
    if (!merged.has(rootKey)) {
      merged.set(rootKey, { key: rootKey, coord: rawNodes.get(rootKey).coord, edges: [] })
    }
    const target = merged.get(rootKey)
    for (const edge of node.edges) {
      // Snap the edge's own polyline endpoint to the merged coordinate too, not just the key,
      // so there's no leftover real-world gap (up to toleranceMeters) at this node.
      let moved = false
      if (edge.startKey === node.key && node.key !== rootKey) {
        edge.startKey = rootKey
        edge.polyline[0] = target.coord
        moved = true
      }
      if (edge.endKey === node.key && node.key !== rootKey) {
        edge.endKey = rootKey
        edge.polyline[edge.polyline.length - 1] = target.coord
        moved = true
      }
      if (moved) edge.lengthMeters = segmentLengthMeters(edge.polyline)
      if (!target.edges.includes(edge)) target.edges.push(edge)
    }
  })

  return merged
}

// The much bigger connectivity problem: most dead ends aren't near-duplicate endpoints, they're
// real intersections the source data never noded — one street's endpoint physically touches a
// second street somewhere along ITS length, not at that second street's own endpoint (a classic
// T-intersection). Fix that by snapping each dangling endpoint to the nearest touch point on any
// other polyline within tolerance, splitting the touched polyline there so the graph gains a real
// shared node. A grid index over polyline vertices keeps the nearest-edge search fast at scale.
const INTERSECTION_SNAP_TOLERANCE_METERS = 15
const VERTEX_GRID_CELL_METERS = 40

function gridCellCoords([lat, lng], refLat, cellSize) {
  return [
    Math.floor((lng * METERS_PER_DEGREE_LNG_AT_LAT(refLat)) / cellSize),
    Math.floor((lat * METERS_PER_DEGREE_LAT) / cellSize)
  ]
}

function buildVertexGrid(edgeList, refLat, cellSize) {
  const grid = new Map()
  for (const edge of edgeList) {
    const seenKeys = new Set()
    for (const vertex of edge.polyline) {
      const [cx, cy] = gridCellCoords(vertex, refLat, cellSize)
      const key = `${cx}|${cy}`
      if (seenKeys.has(key)) continue
      seenKeys.add(key)
      if (!grid.has(key)) grid.set(key, [])
      grid.get(key).push(edge)
    }
  }
  return grid
}

function nearbyEdgesFromGrid(grid, coord, refLat, cellSize) {
  const [cx, cy] = gridCellCoords(coord, refLat, cellSize)
  const found = new Map()
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const bucket = grid.get(`${cx + dx}|${cy + dy}`)
      if (!bucket) continue
      for (const edge of bucket) found.set(edge.id, edge)
    }
  }
  return Array.from(found.values())
}

// Cut `polyline` at each distance-along in `sortedDistances` (already deduped, strictly between
// 0 and the polyline's length), returning the resulting sub-polylines in order.
function splitPolylineAtDistances(polyline, sortedDistances) {
  if (!sortedDistances.length) return [polyline]
  const pieces = []
  let currentPiece = [polyline[0]]
  let accumulated = 0
  let cutIndex = 0
  for (let i = 1; i < polyline.length; i++) {
    const a = polyline[i - 1]
    const b = polyline[i]
    const segLen = haversine(a, b)
    const segStart = accumulated
    while (cutIndex < sortedDistances.length && sortedDistances[cutIndex] <= segStart + segLen) {
      const target = sortedDistances[cutIndex]
      const localT = segLen === 0 ? 0 : Math.max(0, Math.min(1, (target - segStart) / segLen))
      const cutPoint = [a[0] + localT * (b[0] - a[0]), a[1] + localT * (b[1] - a[1])]
      currentPiece.push(cutPoint)
      pieces.push(currentPiece)
      currentPiece = [cutPoint]
      cutIndex++
    }
    currentPiece.push(b)
    accumulated += segLen
  }
  pieces.push(currentPiece)
  return pieces
}

// Detects TRUE mid-polyline crossings - two streets whose polylines cross where NEITHER one ends,
// like a real X-intersection - and splits both crossing edges there, wiring in a shared node so
// the graph gains a real, navigable intersection. This is distinct from mergeNearbyNodes'
// endpoint-to-endpoint case and snapDanglingEndpoints' dead-end-touches-an-interior case above;
// runs first (see buildGraph) so anything it creates participates correctly in those two passes.
//
// No elevation data exists anywhere in the source data, so there's no way to distinguish a real
// at-grade intersection from a highway overpass crossing a street below it - a highway-crosses-
// highway pair (the same /autoroute|aut\b/ convention assignSegmentSpeed already uses to identify
// them) is excluded as a pragmatic guard against inventing a phantom turn between two stacked
// highways, almost certainly grade-separated. A highway crossing anything else (a ramp, a local
// street) is NOT excluded - that's very often a genuine at-grade merge/interchange connection,
// and on/off-ramps frequently cross the mainline's polyline without sharing an endpoint.
const CROSSING_GRID_CELL_METERS = 40

function isHighwaySegment(edge) {
  return /autoroute|aut\b/.test((edge.name || '').toLowerCase())
}

// Standard parametric line-segment intersection test in a shared local meter-space (see
// localXY). p1/p2 describe one segment, p3/p4 the other. Returns the parametric position along
// each (t for p1->p2, u for p3->p4) if they truly cross in both segments' interiors, or null for
// parallel/non-crossing/endpoint-touching pairs - endpoint touches are deliberately excluded here
// since mergeNearbyNodes/snapDanglingEndpoints already own that case.
function segmentIntersection(p1, p2, p3, p4) {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y
  const denom = d1x * d2y - d1y * d2x
  if (Math.abs(denom) < 1e-9) return null
  const dx = p3.x - p1.x, dy = p3.y - p1.y
  const t = (dx * d2y - dy * d2x) / denom
  const u = (dx * d1y - dy * d1x) / denom
  if (t <= 1e-6 || t >= 1 - 1e-6 || u <= 1e-6 || u >= 1 - 1e-6) return null
  return { t, u }
}

function splitCrossingEdges(rawNodes, edges) {
  // Highway segments still participate here - only a highway-crosses-highway pair is skipped
  // below (almost certainly a grade-separated stack interchange, not a real connection). A
  // highway crossing a ramp or local street is very often a genuine at-grade merge/interchange
  // connection - excluding those entirely was the actual cause of "can't get on/off the
  // highway" reports, since on/off-ramps frequently cross the mainline's polyline without
  // sharing an endpoint.
  const edgeList = Array.from(edges.values())
  if (!edgeList.length) return
  const refLat = edgeList[0].polyline[0][0]
  const cellSize = CROSSING_GRID_CELL_METERS

  // Flatten every edge into its individual line-pieces (consecutive vertex pairs), bucketed by
  // both endpoints' grid cells - same 40m-cell approach as buildVertexGrid above, just indexing
  // pieces instead of whole polylines' vertices.
  const pieces = []
  const grid = new Map()
  for (const edge of edgeList) {
    let accumulated = 0
    for (let i = 1; i < edge.polyline.length; i++) {
      const a = edge.polyline[i - 1]
      const b = edge.polyline[i]
      const piece = { index: pieces.length, edge, a, b, segStart: accumulated }
      pieces.push(piece)
      const [cxA, cyA] = gridCellCoords(a, refLat, cellSize)
      const [cxB, cyB] = gridCellCoords(b, refLat, cellSize)
      const keyA = `${cxA}|${cyA}`
      if (!grid.has(keyA)) grid.set(keyA, [])
      grid.get(keyA).push(piece)
      if (cxA !== cxB || cyA !== cyB) {
        const keyB = `${cxB}|${cyB}`
        if (!grid.has(keyB)) grid.set(keyB, [])
        grid.get(keyB).push(piece)
      }
      accumulated += haversine(a, b)
    }
  }

  const cutsByEdge = new Map() // edgeId -> [{ distanceAlong, nodeKey }]
  const seenPairs = new Set()

  for (const piece of pieces) {
    const [cx, cy] = gridCellCoords(piece.a, refLat, cellSize)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(`${cx + dx}|${cy + dy}`)
        if (!bucket) continue
        for (const other of bucket) {
          if (other.edge.id === piece.edge.id || other.index === piece.index) continue
          const pairKey = piece.index < other.index ? `${piece.index}#${other.index}` : `${other.index}#${piece.index}`
          if (seenPairs.has(pairKey)) continue
          seenPairs.add(pairKey)
          if (isHighwaySegment(piece.edge) && isHighwaySegment(other.edge)) continue

          // Project all four points relative to piece.a - any shared reference point works, this
          // one's just convenient since it's already at hand.
          const [refPtLat, refPtLng] = piece.a
          const p1 = { x: 0, y: 0 }
          const p2 = localXY(piece.b, refPtLat, refPtLng)
          const p3 = localXY(other.a, refPtLat, refPtLng)
          const p4 = localXY(other.b, refPtLat, refPtLng)
          const hit = segmentIntersection(p1, p2, p3, p4)
          if (!hit) continue

          const distA = piece.segStart + hit.t * haversine(piece.a, piece.b)
          const distB = other.segStart + hit.u * haversine(other.a, other.b)
          const crossPoint = [piece.a[0] + hit.t * (piece.b[0] - piece.a[0]), piece.a[1] + hit.t * (piece.b[1] - piece.a[1])]
          const nodeKey = roundCoord(crossPoint)

          if (!cutsByEdge.has(piece.edge.id)) cutsByEdge.set(piece.edge.id, [])
          cutsByEdge.get(piece.edge.id).push({ distanceAlong: distA, nodeKey })
          if (!cutsByEdge.has(other.edge.id)) cutsByEdge.set(other.edge.id, [])
          cutsByEdge.get(other.edge.id).push({ distanceAlong: distB, nodeKey })
        }
      }
    }
  }

  // Apply the collected cuts - same split-and-rewire shape as snapDanglingEndpoints' cutsByEdge
  // loop below, just keyed by a precomputed crossing-point node instead of a dangling endpoint.
  for (const [edgeId, rawCuts] of cutsByEdge) {
    const edge = edges.get(edgeId)
    if (!edge) continue

    const sorted = rawCuts.slice().sort((a, b) => a.distanceAlong - b.distanceAlong)
    const dedupedCuts = []
    for (const cut of sorted) {
      const last = dedupedCuts[dedupedCuts.length - 1]
      if (last && Math.abs(cut.distanceAlong - last.distanceAlong) < 1) continue
      if (cut.distanceAlong <= 1 || cut.distanceAlong >= edge.lengthMeters - 1) continue
      dedupedCuts.push(cut)
    }
    if (!dedupedCuts.length) continue

    const pieces2 = splitPolylineAtDistances(edge.polyline, dedupedCuts.map((c) => c.distanceAlong))
    if (pieces2.length < 2) continue

    edges.delete(edgeId)
    const newEdges = pieces2.map((piece, i) => packageSegment({ ...edge, id: `${edgeId}~x${i}`, polyline: piece }))
    newEdges[0].startKey = edge.startKey
    newEdges[newEdges.length - 1].endKey = edge.endKey
    dedupedCuts.forEach((cut, i) => {
      newEdges[i].endKey = cut.nodeKey
      newEdges[i + 1].startKey = cut.nodeKey
    })
    newEdges.forEach((e) => edges.set(e.id, e))

    const startNode = rawNodes.get(edge.startKey)
    const endNode = rawNodes.get(edge.endKey)
    if (startNode) {
      const idx = startNode.edges.indexOf(edge)
      if (idx !== -1) startNode.edges[idx] = newEdges[0]
    }
    if (endNode) {
      const idx = endNode.edges.indexOf(edge)
      if (idx !== -1) endNode.edges[idx] = newEdges[newEdges.length - 1]
    }

    dedupedCuts.forEach((cut, i) => {
      if (!rawNodes.has(cut.nodeKey)) {
        rawNodes.set(cut.nodeKey, { key: cut.nodeKey, coord: newEdges[i].polyline[newEdges[i].polyline.length - 1], edges: [] })
      }
      const node = rawNodes.get(cut.nodeKey)
      if (!node.edges.includes(newEdges[i])) node.edges.push(newEdges[i])
      if (!node.edges.includes(newEdges[i + 1])) node.edges.push(newEdges[i + 1])
    })
  }
}

function snapDanglingEndpoints(rawNodes, edges, toleranceMeters) {
  const edgeList = Array.from(edges.values())
  if (!edgeList.length) return

  const refLat = edgeList[0].polyline[0][0]
  const cellSize = Math.max(toleranceMeters * 2, VERTEX_GRID_CELL_METERS)
  const grid = buildVertexGrid(edgeList, refLat, cellSize)
  const danglingNodes = Array.from(rawNodes.values()).filter((node) => node.edges.length === 1)

  const cutsByEdge = new Map() // edgeId -> [{ distanceAlong, danglingNodeKey }]
  const directMerges = [] // [danglingNodeKey, targetNodeKey]

  for (const node of danglingNodes) {
    const ownEdgeId = node.edges[0].id
    const candidates = nearbyEdgesFromGrid(grid, node.coord, refLat, cellSize).filter((e) => e.id !== ownEdgeId)
    let best = null
    for (const candidate of candidates) {
      const result = pointToSegmentDistance(node.coord, candidate.polyline)
      if (result.distance <= toleranceMeters && (!best || result.distance < best.result.distance)) {
        best = { candidate, result }
      }
    }
    if (!best) continue

    const { candidate, result } = best
    // pointToSegmentDistance clamps t within whichever mini-segment (pair of consecutive
    // vertices) is closest, so a clamped t=0/1 only means "true polyline start/end" when that
    // mini-segment is actually the candidate's first/last one — otherwise it's an internal
    // vertex and belongs in the split path below, not a same-point merge.
    const nearStart = result.segmentIndex === 0 && result.t <= 1e-6
    const nearEnd = result.segmentIndex === candidate.polyline.length - 2 && result.t >= 1 - 1e-6

    if (nearStart) {
      directMerges.push([node.key, candidate.startKey])
    } else if (nearEnd) {
      directMerges.push([node.key, candidate.endKey])
    } else {
      if (!cutsByEdge.has(candidate.id)) cutsByEdge.set(candidate.id, [])
      cutsByEdge.get(candidate.id).push({ distanceAlong: result.distanceAlong, danglingNodeKey: node.key })
    }
  }

  for (const [danglingKey, targetKey] of directMerges) {
    const danglingNode = rawNodes.get(danglingKey)
    const targetNode = rawNodes.get(targetKey)
    if (!danglingNode || !targetNode) continue
    for (const edge of danglingNode.edges) {
      // Reassigning just the key would leave this edge's own polyline still ending at its
      // original (up to toleranceMeters-away) coordinate, so the car would visibly jump the
      // gap the instant it crosses into/out of this edge. Snap the actual geometry too.
      let moved = false
      if (edge.startKey === danglingKey) {
        edge.startKey = targetKey
        edge.polyline[0] = targetNode.coord
        moved = true
      }
      if (edge.endKey === danglingKey) {
        edge.endKey = targetKey
        edge.polyline[edge.polyline.length - 1] = targetNode.coord
        moved = true
      }
      if (moved) edge.lengthMeters = segmentLengthMeters(edge.polyline)
      if (!targetNode.edges.includes(edge)) targetNode.edges.push(edge)
    }
    rawNodes.delete(danglingKey)
  }

  for (const [edgeId, rawCuts] of cutsByEdge) {
    const edge = edges.get(edgeId)
    if (!edge) continue

    rawCuts.sort((a, b) => a.distanceAlong - b.distanceAlong)
    const mergedCuts = []
    for (const cut of rawCuts) {
      const last = mergedCuts[mergedCuts.length - 1]
      if (last && cut.distanceAlong - last.distanceAlong < 1) {
        last.danglingKeys.push(cut.danglingNodeKey)
      } else {
        mergedCuts.push({ distanceAlong: cut.distanceAlong, danglingKeys: [cut.danglingNodeKey] })
      }
    }

    const pieces = splitPolylineAtDistances(edge.polyline, mergedCuts.map((c) => c.distanceAlong))
    if (pieces.length < 2) continue

    edges.delete(edgeId)
    const newEdges = pieces.map((piece, i) => packageSegment({ ...edge, id: `${edgeId}~${i}`, polyline: piece }))
    // packageSegment always recomputes startKey/endKey from the raw polyline coordinates, which
    // would silently discard a key remap this same `edge` already picked up from an earlier
    // directMerge in this pass (e.g. its own dangling end merging into some other intersection).
    // Re-apply the original edge's current (possibly remapped) outer keys onto the outer pieces.
    newEdges[0].startKey = edge.startKey
    newEdges[newEdges.length - 1].endKey = edge.endKey
    newEdges.forEach((e) => edges.set(e.id, e))

    const startNode = rawNodes.get(edge.startKey)
    const endNode = rawNodes.get(edge.endKey)
    if (startNode) {
      const idx = startNode.edges.indexOf(edge)
      if (idx !== -1) startNode.edges[idx] = newEdges[0]
    }
    if (endNode) {
      const idx = endNode.edges.indexOf(edge)
      if (idx !== -1) endNode.edges[idx] = newEdges[newEdges.length - 1]
    }

    mergedCuts.forEach((cut, i) => {
      const splitKey = newEdges[i].endKey // === newEdges[i + 1].startKey by construction
      if (!rawNodes.has(splitKey)) {
        rawNodes.set(splitKey, { key: splitKey, coord: newEdges[i].polyline[newEdges[i].polyline.length - 1], edges: [] })
      }
      const splitNode = rawNodes.get(splitKey)
      if (!splitNode.edges.includes(newEdges[i])) splitNode.edges.push(newEdges[i])
      if (!splitNode.edges.includes(newEdges[i + 1])) splitNode.edges.push(newEdges[i + 1])

      for (const danglingKey of cut.danglingKeys) {
        const danglingNode = rawNodes.get(danglingKey)
        if (!danglingNode) continue
        for (const dEdge of danglingNode.edges) {
          let moved = false
          if (dEdge.startKey === danglingKey) {
            dEdge.startKey = splitKey
            dEdge.polyline[0] = splitNode.coord
            moved = true
          }
          if (dEdge.endKey === danglingKey) {
            dEdge.endKey = splitKey
            dEdge.polyline[dEdge.polyline.length - 1] = splitNode.coord
            moved = true
          }
          if (moved) dEdge.lengthMeters = segmentLengthMeters(dEdge.polyline)
          if (!splitNode.edges.includes(dEdge)) splitNode.edges.push(dEdge)
        }
        if (danglingKey !== splitKey) rawNodes.delete(danglingKey)
      }
    })
  }
}

// The gap neither splitCrossingEdges nor snapDanglingEndpoints covers: two DIFFERENT streets each
// have an INTERIOR polyline vertex (not either street's own endpoint) sitting a few meters from
// the other street's line, without the lines actually crossing (so it's not a true X-intersection)
// and without either vertex being a dangling dead-end (so snapDanglingEndpoints never looks at it).
// Confirmed against real reported cases (Rue Ferland / Rue Couillard) via direct data tracing: both
// streets place a vertex at what a human would call "the intersection", just not close enough to
// literally coincide - a very common shape for real-world street-network extractions where each
// street was digitized independently. Tolerance is intentionally tighter than
// INTERSECTION_SNAP_TOLERANCE_METERS since this pass considers every interior vertex of every edge
// (not just already-dangling ones), so a looser tolerance risks false connections between distinct
// parallel streets that merely run close together without truly meeting.
const VERTEX_PROXIMITY_TOLERANCE_METERS = 10

function connectInteriorVertices(rawNodes, edges, toleranceMeters) {
  const edgeList = Array.from(edges.values())
  if (!edgeList.length) return

  const refLat = edgeList[0].polyline[0][0]
  const cellSize = Math.max(toleranceMeters * 2, VERTEX_GRID_CELL_METERS)
  const grid = buildVertexGrid(edgeList, refLat, cellSize)

  const cutsByEdge = new Map() // edgeId -> [{ distanceAlong, nodeKey }]
  const seenPairs = new Set()

  for (const edge of edgeList) {
    let accumulated = 0
    for (let i = 0; i < edge.polyline.length; i++) {
      if (i > 0) accumulated += haversine(edge.polyline[i - 1], edge.polyline[i])
      // Only interior vertices - the polyline's own first/last point IS already a real node,
      // already handled by mergeNearbyNodes/snapDanglingEndpoints.
      if (i === 0 || i === edge.polyline.length - 1) continue

      const vertex = edge.polyline[i]
      const candidates = nearbyEdgesFromGrid(grid, vertex, refLat, cellSize).filter((e) => e.id !== edge.id)
      let best = null
      for (const candidate of candidates) {
        const result = pointToSegmentDistance(vertex, candidate.polyline)
        if (result.distance <= toleranceMeters && (!best || result.distance < best.result.distance)) {
          best = { candidate, result }
        }
      }
      if (!best) continue

      const { candidate, result } = best
      const pairKey = `${edge.id}#${i}#${candidate.id}`
      if (seenPairs.has(pairKey)) continue
      seenPairs.add(pairKey)

      const nearCandidateStart = result.segmentIndex === 0 && result.t <= 1e-6
      const nearCandidateEnd = result.segmentIndex === candidate.polyline.length - 2 && result.t >= 1 - 1e-6
      const nodeKey = nearCandidateStart ? candidate.startKey : nearCandidateEnd ? candidate.endKey : roundCoord(vertex)

      if (!cutsByEdge.has(edge.id)) cutsByEdge.set(edge.id, [])
      cutsByEdge.get(edge.id).push({ distanceAlong: accumulated, nodeKey })

      // If the close point on the candidate is itself mid-polyline (not the candidate's own
      // endpoint), the candidate needs splitting too so both streets share the new node - an
      // endpoint match instead just reuses the node that already exists there.
      if (!nearCandidateStart && !nearCandidateEnd) {
        if (!cutsByEdge.has(candidate.id)) cutsByEdge.set(candidate.id, [])
        cutsByEdge.get(candidate.id).push({ distanceAlong: result.distanceAlong, nodeKey })
      }
    }
  }

  // Apply cuts - same split-and-rewire shape as splitCrossingEdges/snapDanglingEndpoints above.
  for (const [edgeId, rawCuts] of cutsByEdge) {
    const edge = edges.get(edgeId)
    if (!edge) continue

    const sorted = rawCuts.slice().sort((a, b) => a.distanceAlong - b.distanceAlong)
    const deduped = []
    for (const cut of sorted) {
      const last = deduped[deduped.length - 1]
      if (last && Math.abs(cut.distanceAlong - last.distanceAlong) < 1) continue
      if (cut.distanceAlong <= 1 || cut.distanceAlong >= edge.lengthMeters - 1) continue
      deduped.push(cut)
    }
    if (!deduped.length) continue

    const pieces = splitPolylineAtDistances(edge.polyline, deduped.map((c) => c.distanceAlong))
    if (pieces.length < 2) continue

    edges.delete(edgeId)
    const newEdges = pieces.map((piece, i) => packageSegment({ ...edge, id: `${edgeId}~v${i}`, polyline: piece }))
    newEdges[0].startKey = edge.startKey
    newEdges[newEdges.length - 1].endKey = edge.endKey
    deduped.forEach((cut, i) => {
      newEdges[i].endKey = cut.nodeKey
      newEdges[i + 1].startKey = cut.nodeKey
    })
    newEdges.forEach((e) => edges.set(e.id, e))

    const startNode = rawNodes.get(edge.startKey)
    const endNode = rawNodes.get(edge.endKey)
    if (startNode) {
      const idx = startNode.edges.indexOf(edge)
      if (idx !== -1) startNode.edges[idx] = newEdges[0]
    }
    if (endNode) {
      const idx = endNode.edges.indexOf(edge)
      if (idx !== -1) endNode.edges[idx] = newEdges[newEdges.length - 1]
    }

    deduped.forEach((cut, i) => {
      if (!rawNodes.has(cut.nodeKey)) {
        rawNodes.set(cut.nodeKey, { key: cut.nodeKey, coord: newEdges[i].polyline[newEdges[i].polyline.length - 1], edges: [] })
      }
      const node = rawNodes.get(cut.nodeKey)
      if (!node.edges.includes(newEdges[i])) node.edges.push(newEdges[i])
      if (!node.edges.includes(newEdges[i + 1])) node.edges.push(newEdges[i + 1])
    })
  }
}

export function buildGraph(segments, {
  toleranceMeters = DEFAULT_NODE_MERGE_TOLERANCE_METERS,
  dangleToleranceMeters = INTERSECTION_SNAP_TOLERANCE_METERS
} = {}) {
  const rawNodes = new Map()
  const edges = new Map()

  function ensureNode(key, coord) {
    if (!rawNodes.has(key)) {
      rawNodes.set(key, { key, coord, edges: [] })
    }
    return rawNodes.get(key)
  }

  for (const segment of segments) {
    const edge = packageSegment(segment)
    edges.set(edge.id, edge)

    const startNode = ensureNode(edge.startKey, edge.polyline[0])
    const endNode = ensureNode(edge.endKey, edge.polyline[edge.polyline.length - 1])

    startNode.edges.push(edge)
    endNode.edges.push(edge)
  }

  splitCrossingEdges(rawNodes, edges)
  snapDanglingEndpoints(rawNodes, edges, dangleToleranceMeters)
  connectInteriorVertices(rawNodes, edges, VERTEX_PROXIMITY_TOLERANCE_METERS)

  const nodes = mergeNearbyNodes(rawNodes, toleranceMeters)

  // splitPolylineAtDistances (used by both splitCrossingEdges and snapDanglingEndpoints) can
  // itself introduce a duplicate leading/trailing point when a cut falls exactly on - or very
  // near - an existing vertex: the interpolated cut point and that vertex end up (almost)
  // identical, back to back, in the new piece. Confirmed as the actual root cause of a "turns the
  // wrong way no matter what" report at Rue Saint-Antoine/Rue Dalhousie - the duplicate point made
  // getLocalHeadingAtDistance compute a heading from a zero-length first leg (a bogus exact 0deg
  // "due north"), silently corrupting chooseNextSegment's left/right comparison for that
  // candidate. packageSegment already dedupes the ORIGINAL polyline up front, but this catches
  // duplicates introduced by splitting afterward too.
  for (const edge of edges.values()) {
    const deduped = dedupeConsecutivePoints(edge.polyline)
    if (deduped !== edge.polyline) {
      edge.polyline = deduped
      edge.lengthMeters = segmentLengthMeters(deduped)
    }
  }

  // mergeNearbyNodes can produce degenerate zero/near-zero-length edges when both of an edge's
  // endpoints happen to land on the same merged node - confirmed against the real dataset for a
  // handful of tiny duplicate-point "Rue Sainte-Ursule" polyline fragments (a few source segments
  // only ~1-3m long). Left in, these are phantom "streets" with an undefined heading that
  // chooseNextSegment can still pick as a turn choice, which gets a car stuck unable to progress
  // (0m of travel, no matter which way you steer) - exactly matching reports of mid-segment
  // turning being "impossible" at a specific intersection. No real street is this short.
  const MIN_EDGE_LENGTH_METERS = 2
  for (const [id, edge] of edges) {
    if (edge.lengthMeters < MIN_EDGE_LENGTH_METERS) edges.delete(id)
  }
  for (const node of nodes.values()) {
    node.edges = node.edges.filter((edge) => edge.lengthMeters >= MIN_EDGE_LENGTH_METERS)
  }

  mergeCollinearSameNameEdges(nodes, edges)

  return { nodes, edges }
}

// Collapses any node with exactly 2 edges that share the same street name into one longer edge -
// a 2-degree node never offered a real turn choice in the first place (chooseNextSegment only ever
// had one candidate there), so this can never remove a real decision point. Confirmed live as the
// fix for a real regression: dense intersections (multiple streets all meeting within a few
// meters) can end up with several short same-name fragments in a row after splitting - each one's
// local heading is computed from just its own short span, and that heading noise was occasionally
// bad enough to send chooseNextSegment straight back onto the fragment the car had just arrived
// from (a phantom U-turn). It also directly addresses the reported "camera feels sea-sick"
// jitter - fewer, longer edges means fewer local-heading recalculations per second of driving.
function mergeCollinearSameNameEdges(nodes, edges) {
  let mergedAny = true
  let safety = 0
  while (mergedAny && safety < 50) {
    mergedAny = false
    safety++
    // Snapshot before the pass - nodes/edges mutate as merges are applied within this same pass,
    // so every candidate is re-validated against the live maps before use.
    for (const node of Array.from(nodes.values())) {
      if (!nodes.has(node.key)) continue // removed by an earlier merge this pass
      if (node.edges.length !== 2) continue
      const [a, b] = node.edges
      if (!a.name || a.name !== b.name || a.id === b.id) continue
      if (!edges.has(a.id) || !edges.has(b.id)) continue // stale reference from an earlier merge this pass

      const otherKeyA = a.startKey === node.key ? a.endKey : a.startKey
      const otherKeyB = b.startKey === node.key ? b.endKey : b.startKey
      if (otherKeyA === node.key || otherKeyB === node.key) continue // degenerate self-loop, skip

      // Build one continuous polyline: otherEndOfA -> node -> otherEndOfB.
      const toNode = a.endKey === node.key ? a.polyline : a.polyline.slice().reverse()
      const fromNode = b.startKey === node.key ? b.polyline : b.polyline.slice().reverse()
      const mergedPolyline = dedupeConsecutivePoints(toNode.concat(fromNode.slice(1)))

      const merged = packageSegment({ ...a, id: `${a.id}+${b.id}`, polyline: mergedPolyline })
      merged.startKey = otherKeyA
      merged.endKey = otherKeyB

      edges.delete(a.id)
      edges.delete(b.id)
      edges.set(merged.id, merged)
      nodes.delete(node.key)

      for (const key of new Set([otherKeyA, otherKeyB])) {
        const other = nodes.get(key)
        if (!other) continue
        other.edges = other.edges.map((e) => (e.id === a.id || e.id === b.id ? merged : e))
      }

      mergedAny = true
    }
  }
}

// Coordinates relative to (refLat, refLng), in meters. The caller must pass the SAME reference
// point to every localXY() call within one computation, or the resulting vectors live in
// different frames and comparisons between them (distances, dot products) become meaningless.
function localXY(point, refLat, refLng) {
  const [lat, lng] = point
  const dy = (lat - refLat) * METERS_PER_DEGREE_LAT
  const dx = (lng - refLng) * METERS_PER_DEGREE_LNG_AT_LAT(refLat)
  return { x: dx, y: dy }
}

export function pointToSegmentDistance(point, polyline) {
  if (!Array.isArray(polyline) || polyline.length < 2) {
    return { distance: Infinity }
  }

  const [lat0, lng0] = point
  let best = { distance: Infinity, nearestPoint: null, distanceAlong: 0, segmentIndex: 0 }
  let accumulated = 0

  for (let i = 1; i < polyline.length; i++) {
    const a = polyline[i - 1]
    const b = polyline[i]
    // Everything relative to the query point itself, so the point sits at local (0, 0).
    const aXY = localXY(a, lat0, lng0)
    const bXY = localXY(b, lat0, lng0)

    const vx = bXY.x - aXY.x
    const vy = bXY.y - aXY.y
    const wx = -aXY.x
    const wy = -aXY.y
    const len2 = vx * vx + vy * vy
    let t = 0
    if (len2 > 0) {
      t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2))
    }

    const projX = aXY.x + t * vx
    const projY = aXY.y + t * vy
    const dist = Math.hypot(projX, projY)
    const pointOnSegment = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]
    const distanceAlong = accumulated + t * haversine(a, b)

    if (dist < best.distance) {
      best = {
        distance: dist,
        nearestPoint: pointOnSegment,
        distanceAlong,
        segmentIndex: i - 1,
        t
      }
    }

    accumulated += haversine(a, b)
  }

  return best
}

export function closestSegment(point, segments) {
  let best = { distance: Infinity, segment: null, distanceAlong: 0, nearestPoint: null }
  for (const segment of segments) {
    const result = pointToSegmentDistance(point, segment.polyline)
    if (result.distance < best.distance) {
      best = { ...result, segment }
    }
  }
  return best
}

export function getPointAtDistanceAlongPolyline(polyline, distance) {
  if (!Array.isArray(polyline) || polyline.length < 2) return polyline?.[0] || [0, 0]
  if (distance <= 0) return polyline[0]

  let remaining = distance
  for (let i = 1; i < polyline.length; i++) {
    const from = polyline[i - 1]
    const to = polyline[i]
    const segLen = haversine(from, to)
    if (remaining <= segLen) {
      const fraction = segLen === 0 ? 0 : remaining / segLen
      return [from[0] + (to[0] - from[0]) * fraction, from[1] + (to[1] - from[1]) * fraction]
    }
    remaining -= segLen
  }
  return polyline[polyline.length - 1]
}

export function headingVector([latA, lngA], [latB, lngB]) {
  const refLat = (latA + latB) / 2
  const x = (lngB - lngA) * METERS_PER_DEGREE_LNG_AT_LAT(refLat)
  const y = (latB - latA) * METERS_PER_DEGREE_LAT
  const length = Math.hypot(x, y)
  if (length === 0) return { x: 0, y: 0 }
  return { x: x / length, y: y / length }
}

export function headingAngle([latA, lngA], [latB, lngB]) {
  const vec = headingVector([latA, lngA], [latB, lngB])
  return Math.atan2(vec.y, vec.x) * 180 / Math.PI
}

export function normalizeAngle(angle) {
  let a = angle % 360
  if (a < 0) a += 360
  return a
}

// headingAngle()/getSegmentHeading() return math-convention angles (0=East, counter-clockwise -
// standard atan2 output). Compass bearing (0=North, clockwise - what MapLibre's `bearing`,
// CARDINAL_ANGLES, and wind direction all use) is a 90-degree-offset mirror image of that, not
// just a shift, since one winds clockwise and the other counter-clockwise.
export function toCompassBearing(mathAngleDeg) {
  return normalizeAngle(90 - mathAngleDeg)
}

export function signedAngleBetween(a, b) {
  const diff = normalizeAngle(b - a)
  return diff > 180 ? diff - 360 : diff
}

// absoluteTargetDeg (math-angle convention, same as currentHeadingDeg/candidateAngle) is for
// north-up "Pac-Man style" mode: instead of turning relative to which way the car is currently
// facing, pick whichever real candidate points closest to a fixed compass direction (whatever W/
// A/S/D means there) regardless of current heading - by direct request, since the rotating-map
// mode's "turn relative to facing" model is deliberately NOT what that mode wants.
// When going straight (no explicit turn signal), a candidate sharing the CURRENT street's name is
// preferred over a smaller-angle-but-differently-named one - real driving logic is "stay on the
// street I'm on unless I choose to turn off it", not "take whichever option requires the least
// steering", and a real street can curve a fair amount through an intersection and still be the
// obvious "keep going" choice. Originally gated to within 40deg of straight (matching
// findRiskyIntersections' detection threshold), but live feedback confirmed that was too strict -
// same-name-street should win outright, with only a generous sanity bound to avoid ever picking a
// near-U-turn as "continuing". Confirmed against 18 detected intersections plus multiple live
// reports (Rue Dalhousie-adjacent, Côte d'Abraham) where holding straight wrongly diverted off the
// current street.
const SAME_STREET_CONTINUE_MAX_ANGLE_DEG = 150

export function chooseNextSegment(graph, nodeKey, currentEdge, currentHeadingDeg, turnPreference = 'straight', absoluteTargetDeg = null) {
  const node = graph.nodes.get(nodeKey)
  if (!node) return null

  const referenceHeading = absoluteTargetDeg !== null ? absoluteTargetDeg : currentHeadingDeg
  const choices = []
  for (const edge of node.edges) {
    if (edge.id === currentEdge.id) continue
    const otherKey = edge.startKey === nodeKey ? edge.endKey : edge.startKey
    const otherNode = graph.nodes.get(otherKey)
    if (!otherNode) continue
    // The candidate's angle must be its LOCAL departure heading from this node, not a straight
    // line to its far endpoint - for anything longer than a short straight urban block (a curving
    // ramp, a bridge, a highway segment that bends over its length), those two can differ a lot,
    // which is exactly what made the "smallest turn" heuristic below pick a genuinely curving
    // option over a road that actually continues straight, or vice versa.
    const candidateAngle = departureHeadingFromNode(edge, nodeKey)
    const angleDelta = signedAngleBetween(referenceHeading, candidateAngle)
    choices.push({ edge, angleDelta, absAngle: Math.abs(angleDelta) })
  }

  if (!choices.length) return null

  let filtered = choices
  if (absoluteTargetDeg === null) {
    if (turnPreference === 'left' || turnPreference === 'right') {
      const directional = turnPreference === 'left'
        ? choices.filter((choice) => choice.angleDelta > 10)
        : choices.filter((choice) => choice.angleDelta < -10)
      // Continuing on the SAME street the player is already on is never what an explicit
      // left/right press means, even when its angle technically clears the threshold above - real
      // streets are rarely perfectly straight, so "continue on Rue Couillard" can register as a
      // few degrees "right" too, and being the smallest angle in that bucket was winning over a
      // real, sharply-angled turn onto a genuinely different street at the same intersection.
      // Falls back to the unfiltered directional set (then to every choice) so a real dead end or
      // a same-named fork as the only option in that direction still works.
      const otherStreet = directional.filter((choice) => choice.edge.name !== currentEdge.name)
      filtered = otherStreet.length ? otherStreet : directional.length ? directional : choices
    } else if (currentEdge.name) {
      // Among same-named options that are at least plausibly "continuing" (within the angle
      // bound), prefer the LONGEST one rather than the smallest angle. A short stub's local
      // heading is measured from just a few meters of polyline and is noisy enough to occasionally
      // look "straighter" than the real, longer continuation - confirmed live as the cause of a
      // back-and-forth oscillation at a crowded intersection where the same street name touched
      // one node from two separate short fragments (Rue Saint-Vallier Est / Rue de la Couronne):
      // picking by smallest angle kept bouncing onto a 4.6m stub instead of the real ~87m
      // continuation.
      const plausible = choices.filter((choice) => choice.edge.name === currentEdge.name && choice.absAngle <= SAME_STREET_CONTINUE_MAX_ANGLE_DEG)
      const sameStreet = plausible.sort((a, b) => b.edge.lengthMeters - a.edge.lengthMeters)[0]
      if (sameStreet) {
        filtered = [sameStreet]
      }
    }
  }
  // In absolute mode, angleDelta is already measured against the fixed compass target, so sorting
  // by absAngle alone picks whichever real street points closest to it - no left/right filtering,
  // and no same-street preference either (an explicit compass command should win outright).

  filtered.sort((a, b) => a.absAngle - b.absAngle)
  return filtered[0]?.edge || choices[0]?.edge || null
}

export function getSegmentHeading(segment, direction = 1) {
  if (!segment?.polyline?.length) return 0
  const base = headingAngle(segment.polyline[0], segment.polyline[segment.polyline.length - 1])
  return direction === -1 ? normalizeAngle(base + 180) : base
}

// Heading of just the polyline vertex-pair the car currently sits within, rather than the
// whole segment's start-to-end chord. On a multi-vertex (curved) street this makes heading
// change gradually as the car crosses each internal vertex instead of only snapping once at
// segment boundaries.
export function getLocalHeadingAtDistance(segment, distanceAlong, direction = 1) {
  const polyline = segment?.polyline
  if (!polyline || polyline.length < 2) return 0
  const clamped = Math.min(Math.max(distanceAlong, 0), segment.lengthMeters)
  let accumulated = 0
  for (let i = 1; i < polyline.length; i++) {
    const a = polyline[i - 1]
    const b = polyline[i]
    const segLen = haversine(a, b)
    if (clamped <= accumulated + segLen || i === polyline.length - 1) {
      const base = headingAngle(a, b)
      return direction === -1 ? normalizeAngle(base + 180) : base
    }
    accumulated += segLen
  }
  return getSegmentHeading(segment, direction)
}

// Heading a car would depart `nodeKey` with if it turned onto `edge` there - the same convention
// chooseNextSegment uses to score every candidate at an intersection.
export function departureHeadingFromNode(edge, nodeKey) {
  const enteringAtStart = edge.startKey === nodeKey
  return getLocalHeadingAtDistance(edge, enteringAtStart ? 0 : edge.lengthMeters, enteringAtStart ? 1 : -1)
}

// Heading a car is already traveling with, having just arrived at `nodeKey` via `edge` - the
// mirror image of departureHeadingFromNode (a car arriving via an edge points the opposite way
// from a car about to depart back down that same edge).
function arrivalHeadingAtNode(edge, nodeKey) {
  const arrivingAtEnd = edge.endKey === nodeKey
  return getLocalHeadingAtDistance(edge, arrivingAtEnd ? edge.lengthMeters : 0, arrivingAtEnd ? 1 : -1)
}

// Finds intersections where holding straight ahead would NOT keep the car on the street it's
// already on, even though that same-named street genuinely continues through the intersection at
// a plausible "straight ahead" angle - some other, differently-named edge (very often a highway
// ramp merging in at a shallow angle) has an even smaller angle to the arriving heading, so
// chooseNextSegment's smallest-angle rule would divert onto it instead. This is the concrete shape
// of "I pressed W and it turned me onto a ramp/side street anyway" - a wrong default choice at a
// real, correctly-connected intersection, not a missing connection (see the dead-end/gap checks in
// scripts/auditGraph.mjs for that separate problem).
export function findRiskyIntersections(graph, { sameNameMaxAngleDeg = 40 } = {}) {
  const risky = []
  for (const node of graph.nodes.values()) {
    if (node.edges.length < 3) continue
    for (const enteringEdge of node.edges) {
      if (!enteringEdge.name) continue
      const refHeading = arrivalHeadingAtNode(enteringEdge, node.key)
      const scored = node.edges
        .filter((edge) => edge.id !== enteringEdge.id)
        .map((edge) => ({
          edge,
          absAngle: Math.abs(signedAngleBetween(refHeading, departureHeadingFromNode(edge, node.key)))
        }))
        .sort((a, b) => a.absAngle - b.absAngle)

      const winner = scored[0]
      const sameName = scored.find((s) => s.edge.name === enteringEdge.name)
      if (!sameName || sameName.edge.id === winner.edge.id || sameName.absAngle > sameNameMaxAngleDeg) continue

      risky.push({
        coord: node.coord,
        streetName: enteringEdge.name,
        divertsToName: winner.edge.name || '(unnamed street)',
        straightAngle: Math.round(sameName.absAngle),
        divertAngle: Math.round(winner.absAngle)
      })
    }
  }
  return risky
}

// NPC driving (ambient traffic, ~v1): picks a uniformly random real candidate at the intersection,
// deliberately NOT angle-scored like chooseNextSegment - a bot doesn't have a heading preference to
// honor, it just needs to keep moving somewhere real. Kept separate from chooseNextSegment so this
// never affects real-player turn logic.
export function pickRandomNextSegment(graph, nodeKey, currentEdge) {
  const node = graph.nodes.get(nodeKey)
  if (!node) return null
  const choices = node.edges.filter((edge) => edge.id !== currentEdge.id)
  if (!choices.length) return null
  return choices[Math.floor(Math.random() * choices.length)]
}

// Resolve where the car ends up on `edge` when entering it at `entryNodeKey` after
// traveling `remainder` meters past the end of the previous segment. Segments store an
// arbitrary polyline direction (unrelated to travel direction), so entering at the edge's
// end means distanceAlong must count down from the edge's length, not up from zero.
export function resolveEdgeEntry(edge, entryNodeKey, remainder) {
  const clamped = Math.min(Math.max(remainder, 0), edge.lengthMeters)
  if (edge.startKey === entryNodeKey) {
    return { distanceAlong: clamped, direction: 1 }
  }
  return { distanceAlong: edge.lengthMeters - clamped, direction: -1 }
}

export function findNearestSegment(segments, point) {
  const closest = closestSegment(point, segments)
  if (!closest.segment) return null
  return {
    segment: closest.segment,
    distanceAlong: Math.min(Math.max(closest.distanceAlong, 0), closest.segment.lengthMeters),
    point: closest.nearestPoint || point
  }
}

export function getSegmentPosition(segment, distanceAlong) {
  return getPointAtDistanceAlongPolyline(segment.polyline, Math.min(Math.max(distanceAlong, 0), segment.lengthMeters))
}

// Picks a uniformly-random point somewhere along the street graph - used to place Finder-Keeper
// items. With `near`/`maxDistanceMeters`, first restricts to edges with at least one endpoint
// within that radius (a rough but cheap proximity filter, not exact edge-to-point distance) -
// without this, items landed anywhere across the whole playable bbox regardless of where the
// round actually starts, which is what made them feel scattered/unreachable. Falls back to the
// unrestricted pool if too few edges qualify (e.g. a tiny radius near the edge of the map).
export function pickRandomStreetPoint(graph, { near, maxDistanceMeters } = {}) {
  let edges = Array.from(graph.edges.values()).filter((e) => e.lengthMeters > 0)
  if (!edges.length) return null
  if (near && maxDistanceMeters) {
    const nearby = edges.filter(
      (e) => haversine(near, e.polyline[0]) <= maxDistanceMeters || haversine(near, e.polyline[e.polyline.length - 1]) <= maxDistanceMeters
    )
    if (nearby.length >= 10) edges = nearby
  }
  const edge = edges[Math.floor(Math.random() * edges.length)]
  const distanceAlong = Math.random() * edge.lengthMeters
  const [lat, lng] = getSegmentPosition(edge, distanceAlong)
  return { lat, lng }
}
