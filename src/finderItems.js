// The 10 official Finder-Keeper collectibles - real plush-toy photos (converted to SVG) will
// eventually replace `iconId`, one at a time, without touching anything that reads this list -
// callers only ever see `{ id, label, iconId }` and never care where the icon comes from.
// Placeholder icons are reused from the existing AVATAR_ICONS set (see avatarIcons.js) since the
// exact glyph doesn't matter yet, only the name shown on the label.
export const FINDER_ITEMS = [
  { id: 'grand-nacho', label: 'Grand Nacho', iconId: 'cat' },
  { id: 'nacho', label: 'Nacho', iconId: 'dog' },
  { id: 'simon', label: 'Simon', iconId: 'rabbit' },
  { id: 'flora', label: 'Flora', iconId: 'bird' },
  { id: 'tuffy', label: 'Tuffy', iconId: 'bug' },
  { id: 'jasper', label: 'Jasper', iconId: 'ghost' },
  { id: 'daffodil', label: 'Daffodil', iconId: 'sun' },
  { id: 'tyler', label: 'Tyler', iconId: 'trophy' },
  { id: 'bun-bun', label: 'Bun-bun', iconId: 'gem' },
  { id: 'grenouche', label: 'Grenouche', iconId: 'star' }
]
