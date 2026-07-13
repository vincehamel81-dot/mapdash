export const CONFIG = {
  // Turns out shrinking this repeatedly was chasing the wrong lever: this bbox only ever filtered
  // which STREET DATA loads - it never actually stopped the camera from panning/zooming out far
  // enough to reveal real neighbouring places (Lévis, Île d'Orléans) on the base map tiles. That's
  // now fixed properly with maxBounds on the map itself (see MapView.jsx), which is the real fix.
  // Tightened a bit further here too, pulled in from the west (a multi-slice scan of the real data
  // found legitimate Québec-tagged streets extend much further south around -71.30, likely
  // Sainte-Foy - sacrificed to keep the box centered tighter on downtown).
  bbox: {
    south: 46.79647881362492,
    west: -71.39947527908767,
    north: 46.87402689541307,
    east: -71.19891865935556
  },
  // The full extent of the synced street network (every segment already tagged city==='Québec',
  // no additional trimming) - roughly 3x the tight bbox's latitude span and 2x its longitude span,
  // reaching all the way to Cap-Rouge. Used by modes that want a much bigger playable area (see
  // MODE_CONFIG's wideBbox flag in App.jsx) without needing a separate data sync - this data was
  // always there, just filtered out at runtime for the tighter modes.
  bboxWide: {
    south: 46.7351463596,
    west: -71.5370310453,
    north: 46.9717669608,
    east: -71.1426341151
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
  }
}
