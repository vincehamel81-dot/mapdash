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

export function packageSegment(segment) {
  const lengthMeters = segmentLengthMeters(segment.polyline)
  return {
    ...segment,
    lengthMeters,
    speedKmh: assignSegmentSpeed(segment),
    startKey: roundCoord(segment.polyline[0]),
    endKey: roundCoord(segment.polyline[segment.polyline.length - 1])
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

  const nodes = mergeNearbyNodes(rawNodes, toleranceMeters)
  return { nodes, edges }
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

export function chooseNextSegment(graph, nodeKey, currentEdge, currentHeadingDeg, turnPreference = 'straight') {
  const node = graph.nodes.get(nodeKey)
  if (!node) return null

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
    const enteringAtStart = edge.startKey === nodeKey
    const candidateAngle = getLocalHeadingAtDistance(edge, enteringAtStart ? 0 : edge.lengthMeters, enteringAtStart ? 1 : -1)
    const angleDelta = signedAngleBetween(currentHeadingDeg, candidateAngle)
    choices.push({ edge, angleDelta, absAngle: Math.abs(angleDelta) })
  }

  if (!choices.length) return null

  let filtered = choices
  if (turnPreference === 'left') {
    const left = choices.filter((choice) => choice.angleDelta > 10)
    filtered = left.length ? left : choices
  } else if (turnPreference === 'right') {
    const right = choices.filter((choice) => choice.angleDelta < -10)
    filtered = right.length ? right : choices
  }

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
