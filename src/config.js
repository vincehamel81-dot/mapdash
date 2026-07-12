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
  // Esri's free World Imagery service - aerial/satellite photography, no separate "no labels"
  // variant exists for it so both fields point at the same tile set.
  satellite: {
    name: 'Satellite',
    baseNoLabels: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    baseWithLabels: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics'
  }
}
