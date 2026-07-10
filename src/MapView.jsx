import { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

// Thin imperative wrapper around a maplibre-gl Map. Unlike react-leaflet, this deliberately
// does not try to model map state declaratively - the game's rAF-driven movement loop needs to
// call setCenter/setBearing directly on the map instance every frame, so the parent gets the
// raw Map instance via onReady and drives it itself (mirrors the old mapRef.current pattern).
export default function MapView({ tileUrls, attribution, center, zoom, onReady, onClick }) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const onClickRef = useRef(onClick)
  onClickRef.current = onClick

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {
          base: { type: 'raster', tiles: tileUrls, tileSize: 256, attribution }
        },
        layers: [{ id: 'base', type: 'raster', source: 'base' }]
      },
      center: [center.lng, center.lat],
      zoom,
      dragRotate: false,
      touchZoomRotate: false,
      pitchWithRotate: false,
      attributionControl: { compact: true }
    })
    mapRef.current = map

    map.on('click', (e) => onClickRef.current?.(e.lngLat))
    map.on('load', () => onReady?.(map))

    return () => {
      map.remove()
      mapRef.current = null
    }
    // Only ever mounted once - all further updates go through the imperative map instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const source = map.getSource('base')
    if (source && typeof source.setTiles === 'function') {
      source.setTiles(tileUrls)
    }
  }, [tileUrls])

  return <div ref={containerRef} className="maplibre-container" />
}
