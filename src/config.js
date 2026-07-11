export const CONFIG = {
  // Quebec City proper only (all 6 real arrondissements - Les Rivières, La Cité-Limoilou,
  // Sainte-Foy-Sillery-Cap-Rouge, La Haute-Saint-Charles, Charlesbourg, Beauport), not the much
  // wider ~60km region the raw data also includes (Lévis across the river, plus ~50 smaller
  // outlying municipalities like Donnacona/Neuville/Château-Richer/Île d'Orléans towns that
  // were never really "the game," just along for the ride in the source file). Derived directly
  // from the actual extent of `city === 'Québec'` segments (10,914 of them) with a small margin,
  // not a hand-picked guess - segments.json is filtered to this box at load time (see App.jsx).
  bbox: {
    south: 46.730,
    west: -71.545,
    north: 46.978,
    east: -71.135
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
