// Hand-drawn perimeter for the tight play area (Survival/Tag/Finder) - river to the south, east
// past the city, up north, then back down the west side - replacing the old lat/lng rectangle so
// the playable shape actually follows the city instead of a box around it. Excludes Wendake (the
// small enclave northwest of downtown, ~46.88/-71.368) on purpose: it fell inside the old
// rectangle's bounds but is outside this drawn shape, so its streets are no longer part of the
// tight area (still included in bboxWide below via allowedCities).
const TIGHT_PLAY_AREA_POLYGON = [
  [46.7287120169986, -71.35862672507919],
  [46.75529795434113, -71.26009310961916],
  [46.80502312822129, -71.19778003921499],
  [46.87113457504163, -71.1479982418608],
  [46.893310058172005, -71.1498865109615],
  [46.93247606525985, -71.19829501193664],
  [46.88615389338014, -71.35759676254446],
  [46.81717878857192, -71.4052967114355]
]

function polygonBounds(polygon) {
  const lats = polygon.map((p) => p[0])
  const lngs = polygon.map((p) => p[1])
  return { south: Math.min(...lats), north: Math.max(...lats), west: Math.min(...lngs), east: Math.max(...lngs) }
}

export const CONFIG = {
  // Kept as the polygon's bounding envelope - still used as a cheap pre-check/rejection-sampling
  // range in a few places (see bboxPolygon for the actual shape gameplay is constrained to).
  bbox: polygonBounds(TIGHT_PLAY_AREA_POLYGON),
  bboxPolygon: TIGHT_PLAY_AREA_POLYGON,
  // The full extent of Québec city's synced street network unioned with Lévis's (imported
  // separately - see scripts/importLevisData.mjs - since Ville de Québec's own open-data portal
  // never covered Lévis at all, a distinct municipality with its own data). Used by modes that
  // want a much bigger playable area (see MODE_CONFIG's wideBbox flag in App.jsx).
  bboxWide: {
    south: 46.5818712,
    west: -71.5370310453,
    north: 46.9717669608,
    east: -70.9839365
  },
  defaultZoom: 15,
  minZoom: 12,
  maxZoom: 20,
  startPosition: { lat: 46.8139, lng: -71.2082, speed: 0 }
}

// MapLibre raster sources take an explicit `tiles` array rather than Leaflet's `{s}` subdomain
// placeholder, so each theme lists the lettered CDN hosts directly.
const cartoSubdomains = ['a', 'b', 'c', 'd']
const cartoTiles = (variant) => cartoSubdomains.map((s) => `https://${s}.basemaps.cartocdn.com/rastertiles/${variant}/{z}/{x}/{y}.png`)

export const THEMES = {
  voyager: {
    name: 'Voyager',
    baseNoLabels: cartoTiles('voyager_nolabels'),
    baseWithLabels: cartoTiles('voyager'),
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
  },
  googleLike: {
    name: 'Google-like',
    baseNoLabels: cartoTiles('light_nolabels'),
    baseWithLabels: cartoTiles('light_all'),
    attribution: '&copy; OpenStreetMap contributors'
  },
  // Esri's free World Street Map service - same provider as the (now-removed) satellite imagery,
  // so no API key needed, same as the sibling gumballquiz project already proved out. Esri doesn't
  // publish its own label-free variant of this one, so - reusing that same project's trick -
  // "no labels" falls back to CARTO's voyager_nolabels instead.
  esriStreets: {
    name: 'Esri Streets',
    baseNoLabels: cartoTiles('voyager_nolabels'),
    baseWithLabels: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}'],
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, HERE, Garmin, USGS, EPA, NPS, and others'
  },
  // Esri's free National Geographic style - warm terrain-shaded cartography, same keyless
  // server.arcgisonline.com service as the two Esri themes above (verified the tile endpoint
  // actually resolves before adding it, same as Esri Streets). No separate label-free variant
  // exists for this one either, so it uses the same CARTO-nolabels substitution trick.
  esriNatGeo: {
    name: 'Esri NatGeo',
    baseNoLabels: cartoTiles('voyager_nolabels'),
    baseWithLabels: ['https://server.arcgisonline.com/ArcGIS/rest/services/NatGeo_World_Map/MapServer/tile/{z}/{y}/{x}'],
    attribution: 'Tiles &copy; Esri &mdash; National Geographic, Esri, DeLorme, NAVTEQ, UNEP-WCMC, USGS, NASA, ESA, METI, NRCAN, GEBCO, NOAA, iPC'
  }
}
