// Re-downloads Ville de Québec's official "Voies publiques" open dataset (Données Québec) and
// converts it into public/data/QBC/segments.json's schema. Run with: npm run sync:street-data
//
// This replaced the old segments.json (which was a much smaller, staler, multi-municipality
// extract) after live testing kept finding real streets that visually exist on the map tiles but
// had no graph edge at all - most notably the Fontaine de Tourny roundabout and several "4e
// Avenue"-area gaps. This official dataset is actively maintained (updated within days of this
// script being written) and is Ville de Québec only, which is smaller AND more complete than the
// old file for the area that actually matters (everything outside city limits was dead weight -
// already filtered out client-side by the `city === 'Québec'` check in App.jsx).
//
// Known gap: this source has no arrondissement/quartier fields (the old file did, for Québec-city
// rows), so the in-game "active street" banner's arrondissement/quartier line just won't render
// (App.jsx already handles empty values gracefully - not a crash, just a lost cosmetic detail).
// Fixing that would need a second Données Québec dataset (administrative-boundary polygons) joined
// by point-in-polygon - not done here, flagged as a possible follow-up.

import fs from 'fs'
import path from 'path'

const DATASET_URL = 'https://www.donneesquebec.ca/recherche/dataset/e4915d10-9c33-47a8-8e06-cf39306ef583/resource/af782966-3ec4-4ad5-b3b7-630c27165f01/download/vdq-voiepublique.geojson'
const OUTPUT_PATH = path.resolve('public/data/QBC/segments.json')

// Real, physically-driveable road categories only - excludes bike infrastructure, pedestrian
// links, sidewalks, parking lots, stairs, and a handful of building/facility name artifacts in the
// source data (École, Bibliothèque, CHSLD, etc. - clearly not streets despite being in this file).
const DRIVABLE_GENERIQUE = new Set([
  'Rue', 'Avenue', 'Boulevard', 'Chemin', 'Bretelle', 'Autoroute', 'Côte', 'Route', 'Place',
  'Carré', 'Rang', 'Ruelle', 'Impasse', 'Montée', 'Concession', 'Voie service', 'Quai',
  'Promenade', 'Allée', 'Terrasse', 'Cours', 'Chaussée', 'Domaine', 'Trait-carré', 'Passage',
  'Pont', 'Pont-tunnel', 'Entrée-Sortie', 'Accès', 'Le'
])

const EXCLUDED_TYPE = new Set([
  'Lien piétonnier', 'Bande cyclable', 'Piste cyclable', 'Trottoir hors rue', 'Lien piétonnier (privé)'
])

console.log('Downloading', DATASET_URL)
const res = await fetch(DATASET_URL)
if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`)
const data = await res.json()
console.log('Downloaded', data.features.length, 'raw features')

let kept = 0, skippedType = 0, skippedGeneric = 0
const converted = []
for (const f of data.features) {
  const p = f.properties
  if (EXCLUDED_TYPE.has(p.TYPE)) { skippedType++; continue }
  if (!DRIVABLE_GENERIQUE.has(p.GENERIQUE)) { skippedGeneric++; continue }
  if (f.geometry.type !== 'LineString' || f.geometry.coordinates.length < 2) continue

  converted.push({
    id: p.ID,
    name: p.NOM_TOPOGRAPHIE,
    city: 'Québec',
    arrondissement: null,
    quartier: null,
    polyline: f.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
    pictureId: null
  })
  kept++
}

console.log('kept:', kept, '- skipped (non-drivable type):', skippedType, '- skipped (non-drivable category):', skippedGeneric)
fs.writeFileSync(OUTPUT_PATH, JSON.stringify(converted))
console.log('Wrote', OUTPUT_PATH)
console.log('\nRun `npm run audit:graph` next to sanity-check the rebuilt street graph.')
