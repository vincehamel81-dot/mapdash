export const CONFIG = {
  // South edge pulled up again, this time checked against the real data rather than eyeballed:
  // a direct scan of segments.json found the southernmost city==='Québec'-tagged point right at
  // the old-town/riverfront longitude band (-71.195 to -71.225) sits at lat 46.7936 - anything
  // south of there in that band is the St. Lawrence itself or Lévis on the far shore. South is now
  // 46.8000, a comfortable ~1.5km north of that measured point, instead of a guessed value. North/
  // west/east unchanged. Some real Quebec City streets near the old edges now fall outside this
  // and are filtered out - accepted tradeoff, not a bug.
  bbox: {
    south: 46.8000,
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
