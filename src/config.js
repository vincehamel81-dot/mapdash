export const CONFIG = {
  // Half the area of the box that just replaced the original ~60km-wide region (itself derived
  // from `city === 'Québec'` segments' full extent - see git history for that math), shrunk
  // toward the same center per direct user feedback that even "Quebec City proper" was still too
  // big. Some real Quebec City streets near the old edges now fall outside this and are filtered
  // out (see App.jsx) - accepted tradeoff, not a bug.
  bbox: {
    south: 46.7663,
    west: -71.4850,
    north: 46.9417,
    east: -71.1950
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
