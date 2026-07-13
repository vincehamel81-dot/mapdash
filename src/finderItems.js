// The full Finder-Keeper collectible catalog. Each has its own standalone SVG file in
// src/finderIcons/ - to swap in the real plush-toy artwork, just replace that one file (keep the
// same filename convention) and nothing else in the app needs to change. Only 10 of these spawn in
// any given round (see pickRoundFinderItems in App.jsx) - the catalog is expected to keep growing
// past 10 as more plush toys get their own icon, with each round drawing a random subset.
import grandNacho from './finderIcons/grand-nacho.svg?raw'
import nacho from './finderIcons/nacho.svg?raw'
import simon from './finderIcons/simon.svg?raw'
import flora from './finderIcons/flora.svg?raw'
import tuffy from './finderIcons/tuffy.svg?raw'
import jasper from './finderIcons/jasper.svg?raw'
import daffodil from './finderIcons/daffodil.svg?raw'
import tyler from './finderIcons/tyler.svg?raw'
import bunBun from './finderIcons/bun-bun.svg?raw'
import grenouche from './finderIcons/grenouche.svg?raw'
import huskynouche from './finderIcons/huskynouche.svg?raw'

export const FINDER_ITEMS = [
  { id: 'grand-nacho', label: 'Grand Nacho', svg: grandNacho },
  { id: 'nacho', label: 'Nacho', svg: nacho },
  { id: 'simon', label: 'Simon', svg: simon },
  { id: 'flora', label: 'Flora', svg: flora },
  { id: 'tuffy', label: 'Tuffy', svg: tuffy },
  { id: 'jasper', label: 'Jasper', svg: jasper },
  { id: 'daffodil', label: 'Daffodil', svg: daffodil },
  { id: 'tyler', label: 'Tyler', svg: tyler },
  { id: 'bun-bun', label: 'Bun-bun', svg: bunBun },
  { id: 'grenouche', label: 'Grenouche', svg: grenouche },
  { id: 'huskynouche', label: 'Huskynouche', svg: huskynouche }
]

export function getFinderItemSvg(itemId) {
  return (FINDER_ITEMS.find((i) => i.id === itemId) || FINDER_ITEMS[0]).svg
}
