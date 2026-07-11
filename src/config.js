export const CONFIG = {
  // Shrunk again (~80% of the previous span) and biased to extend less far south, per feedback
  // that the box still crossed the St. Lawrence toward Lévis (city===Quebec already excludes all
  // Lévis STREET data - see App.jsx - but the bbox rectangle itself, and hence how far the camera
  // can pan/what basemap labels are visible, still reached across the river). North edge held
  // fixed, south edge pulled up ~2.9km; east/west stay centered on CONFIG.startPosition. Some real
  // Quebec City streets near the old edges now fall outside this and are filtered out - accepted
  // tradeoff, not a bug.
  bbox: {
    south: 46.7744,
    west: -71.3007,
    north: 46.8800,
    east: -71.1158
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
