import { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { CONFIG } from './config'

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
      // CONFIG.bbox only ever filtered which STREET DATA loads - it never actually stopped the
      // camera itself from panning/zooming out far enough to reveal real neighbouring cities
      // (Lévis, Île d'Orléans) on the base map tiles, which is what repeated bbox-shrinking never
      // actually fixed. maxBounds constrains the camera itself, not just the data.
      maxBounds: [
        [CONFIG.bbox.west, CONFIG.bbox.south],
        [CONFIG.bbox.east, CONFIG.bbox.north]
      ],
      dragRotate: false,
      touchZoomRotate: false,
      pitchWithRotate: false,
      // MapLibre's own Shift+Arrow rotate/pitch and arrow-key pan handling was still active here
      // (only drag/touch rotation was disabled above) - it binds its own keydown listener
      // directly on the map canvas, so it fired independently of/alongside the game's custom
      // controls whenever Shift was combined with an arrow key, fighting the bearing this app
      // already drives imperatively every frame. Fully disabled since the game has its own
      // complete keyboard scheme.
      keyboard: false,
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
