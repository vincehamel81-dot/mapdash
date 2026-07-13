// One-time (re-run as needed) import of Lévis street data from the gumballquiz sibling project.
// Lévis has no data of its own in this project's segments.json (Ville de Québec's open-data
// portal only ever covers Québec proper) - gumballquiz happens to already have a much broader
// regional sync (Lévis + ~50 other Capitale-Nationale/Chaudière-Appalaches municipalities) in the
// exact same post-processed schema (id/name/city/arrondissement/quartier/polyline/pictureId), so
// this just filters out the Lévis rows and writes them to their own file here rather than
// re-deriving anything from scratch. Confirmed no id collisions with this project's own segments
// (Lévis ids are in the 13M-1.45B range; this project's own are sequential 100001-212996ish).
import fs from 'fs'

const SOURCE = '../../gumballquiz/public/data/segments.json'
const OUT = '../public/data/QBC/segments-levis.json'

const data = JSON.parse(fs.readFileSync(new URL(SOURCE, import.meta.url), 'utf8'))
const levis = data.filter((s) => s.city === 'Lévis')

fs.writeFileSync(new URL(OUT, import.meta.url), JSON.stringify(levis))
console.log(`Wrote ${levis.length} Lévis segments to ${OUT}`)
