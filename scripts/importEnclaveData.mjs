// Wendake and L'Ancienne-Lorette are separate incorporated municipalities entirely surrounded by
// Ville de Québec (Wendake a First Nations reserve, L'Ancienne-Lorette an enclave city), so Ville
// de Québec's own open-data portal never covered them - same root cause as Lévis (see
// importLevisData.mjs), but unlike Lévis these two are small enough to fit inside the existing
// tight bbox (used by Survival/Tag/Finder, not just the wide Single/Team box), so they're loaded
// for every mode rather than gated behind wideBbox. Same source (gumballquiz sibling project),
// same already-matching schema.
import fs from 'fs'

const SOURCE = '../../gumballquiz/public/data/segments.json'
const OUT = '../public/data/QBC/segments-enclaves.json'
const CITIES = ["L'Ancienne-Lorette", 'Wendake']

const data = JSON.parse(fs.readFileSync(new URL(SOURCE, import.meta.url), 'utf8'))
const enclaves = data.filter((s) => CITIES.includes(s.city))

fs.writeFileSync(new URL(OUT, import.meta.url), JSON.stringify(enclaves))
console.log(`Wrote ${enclaves.length} enclave segments to ${OUT}`)
for (const city of CITIES) {
  console.log(`  ${city}: ${enclaves.filter((s) => s.city === city).length}`)
}
