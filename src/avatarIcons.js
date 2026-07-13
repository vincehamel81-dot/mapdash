// Real icon geometry from lucide-static (ISC licensed) rather than hand-authored SVG paths, to
// avoid subtly-wrong shapes. Each file is an outline icon using stroke="currentColor", so a
// wrapper's `color` CSS property recolors it without touching the markup - see carMarkerMarkup
// in App.jsx.
import cat from 'lucide-static/icons/cat.svg?raw'
import dog from 'lucide-static/icons/dog.svg?raw'
import bird from 'lucide-static/icons/bird.svg?raw'
import rabbit from 'lucide-static/icons/rabbit.svg?raw'
import fish from 'lucide-static/icons/fish.svg?raw'
import bug from 'lucide-static/icons/bug.svg?raw'
import pawPrint from 'lucide-static/icons/paw-print.svg?raw'
import apple from 'lucide-static/icons/apple.svg?raw'
import banana from 'lucide-static/icons/banana.svg?raw'
import cherry from 'lucide-static/icons/cherry.svg?raw'
import pizza from 'lucide-static/icons/pizza.svg?raw'
import coffee from 'lucide-static/icons/coffee.svg?raw'
import cookie from 'lucide-static/icons/cookie.svg?raw'
import iceCream from 'lucide-static/icons/ice-cream.svg?raw'
import heart from 'lucide-static/icons/heart.svg?raw'
import star from 'lucide-static/icons/star.svg?raw'
import crown from 'lucide-static/icons/crown.svg?raw'
import gem from 'lucide-static/icons/gem.svg?raw'
import flame from 'lucide-static/icons/flame.svg?raw'
import snowflake from 'lucide-static/icons/snowflake.svg?raw'
import moon from 'lucide-static/icons/moon.svg?raw'
import sun from 'lucide-static/icons/sun.svg?raw'
import cloud from 'lucide-static/icons/cloud.svg?raw'
import zap from 'lucide-static/icons/zap.svg?raw'
import umbrella from 'lucide-static/icons/umbrella.svg?raw'
import anchor from 'lucide-static/icons/anchor.svg?raw'
import key from 'lucide-static/icons/key.svg?raw'
import music from 'lucide-static/icons/music.svg?raw'
import camera from 'lucide-static/icons/camera.svg?raw'
import gift from 'lucide-static/icons/gift.svg?raw'
import rocket from 'lucide-static/icons/rocket.svg?raw'
import ghost from 'lucide-static/icons/ghost.svg?raw'
import skull from 'lucide-static/icons/skull.svg?raw'
import bomb from 'lucide-static/icons/bomb.svg?raw'
import puzzle from 'lucide-static/icons/puzzle.svg?raw'
import bike from 'lucide-static/icons/bike.svg?raw'
import plane from 'lucide-static/icons/plane.svg?raw'
import sailboat from 'lucide-static/icons/sailboat.svg?raw'
import smile from 'lucide-static/icons/smile.svg?raw'
import laugh from 'lucide-static/icons/laugh.svg?raw'
import trophy from 'lucide-static/icons/trophy.svg?raw'
import target from 'lucide-static/icons/target.svg?raw'
import glasses from 'lucide-static/icons/glasses.svg?raw'
import car from 'lucide-static/icons/car.svg?raw'
import carTaxi from 'lucide-static/icons/car-taxi-front.svg?raw'
import motorbike from 'lucide-static/icons/motorbike.svg?raw'
import bus from 'lucide-static/icons/bus.svg?raw'
import train from 'lucide-static/icons/train-front.svg?raw'
import helicopter from 'lucide-static/icons/helicopter.svg?raw'
import ambulance from 'lucide-static/icons/ambulance.svg?raw'
import truck from 'lucide-static/icons/truck.svg?raw'
import candy from 'lucide-static/icons/candy.svg?raw'

// The app's original marker shape, hand-kept here (not from lucide) using fill="currentColor" so
// it recolors the same way as every other avatar, plus a dark outline so it stays visible even
// when the chosen color is white.
const arrow = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none">
  <path d="M12 2.5L19.5 21L12 17L4.5 21L12 2.5Z" fill="currentColor" stroke="#3c4043" stroke-width="1" stroke-linejoin="round"/>
</svg>`

// First proof-of-concept batch of a "colored" category (fixed, hardcoded colors instead of
// currentColor - deliberately ignores the player's car-color choice) - if these look good, more
// get added the same way before deciding on any section/grouping in the picker UI.
const redHeart = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none">
  <path fill="#e53935" stroke="#8e1e1a" stroke-width="1" stroke-linejoin="round" d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5" />
</svg>`

const blueCar = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
  <path fill="#1e88e5" stroke="#0d47a1" stroke-width="1" stroke-linejoin="round" d="M4 14l1.4-4.6A2 2 0 0 1 7.3 8h9.4a2 2 0 0 1 1.9 1.4L20 14v3a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-.5H7v.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1Z"/>
  <rect x="8" y="4" width="8" height="4.5" rx="1" fill="#90caf9" stroke="#0d47a1" stroke-width="1"/>
  <circle cx="7" cy="17" r="2" fill="#263238"/>
  <circle cx="17" cy="17" r="2" fill="#263238"/>
</svg>`

const goldenStar = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
  <path fill="#fdd835" stroke="#f57f17" stroke-width="0.6" stroke-linejoin="round" d="M12 2 L14.7 8.6 L22 9.2 L16.4 13.8 L18.2 21 L12 17 L5.8 21 L7.6 13.8 L2 9.2 L9.3 8.6 Z"/>
</svg>`

// First proof-of-concept batch of an "animated" category - these are injected as live DOM markup
// (see carMarkerMarkup's dangerouslySetInnerHTML/innerHTML usage), so plain CSS @keyframes inside
// an inline <style> genuinely runs, same as it would in a regular page. Kept on currentColor so
// they still combine with the player's chosen car color like the classic set does - only the
// "colored" category above deliberately ignores it. Class/keyframe names are prefixed mdr- and
// scoped per-icon to avoid any risk of colliding with unrelated page styles.
const jumpingBunny = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
  <style>
    .mdr-bunny-body { animation: mdr-bunny-hop 0.6s ease-in-out infinite; }
    @keyframes mdr-bunny-hop { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
  </style>
  <g class="mdr-bunny-body" fill="currentColor">
    <ellipse cx="12" cy="17" rx="6" ry="5"/>
    <circle cx="12" cy="9" r="4.5"/>
    <path d="M8 6 L6.5 1 Q6 -0.5 8 0.5 L10 5Z"/>
    <path d="M16 6 L17.5 1 Q18 -0.5 16 0.5 L14 5Z"/>
    <circle cx="10.3" cy="8.5" r="0.8" fill="#222"/>
    <circle cx="13.7" cy="8.5" r="0.8" fill="#222"/>
  </g>
</svg>`

const runningDog = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
  <style>
    .mdr-dog-legs-a { animation: mdr-dog-run-a 0.4s steps(1) infinite; }
    .mdr-dog-legs-b { animation: mdr-dog-run-b 0.4s steps(1) infinite; }
    @keyframes mdr-dog-run-a { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
    @keyframes mdr-dog-run-b { 0%, 49% { opacity: 0; } 50%, 100% { opacity: 1; } }
  </style>
  <g fill="currentColor">
    <ellipse cx="12" cy="10" rx="8" ry="4"/>
    <circle cx="19" cy="8" r="3.2"/>
    <path d="M21 6 L23 4.5 L22 7.5Z"/>
  </g>
  <g class="mdr-dog-legs-a" fill="currentColor">
    <rect x="6" y="13" width="2" height="6" rx="1"/>
    <rect x="16" y="13" width="2" height="6" rx="1"/>
  </g>
  <g class="mdr-dog-legs-b" fill="currentColor">
    <rect x="8.5" y="13" width="2" height="6" rx="1" transform="rotate(20 9.5 13)"/>
    <rect x="13.5" y="13" width="2" height="6" rx="1" transform="rotate(-20 14.5 13)"/>
  </g>
</svg>`

const spinningStar = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
  <style>
    .mdr-star-spin { animation: mdr-star-spin 1.6s linear infinite; transform-origin: 12px 12px; }
    @keyframes mdr-star-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  </style>
  <path class="mdr-star-spin" fill="currentColor" d="M12 2 L14.5 9 L22 9.3 L16 14 L18 21.5 L12 17.3 L6 21.5 L8 14 L2 9.3 L9.5 9 Z"/>
</svg>`

export const AVATAR_ICONS = [
  { id: 'arrow', label: 'Arrow', svg: arrow },
  { id: 'cat', label: 'Cat', svg: cat },
  { id: 'dog', label: 'Dog', svg: dog },
  { id: 'bird', label: 'Bird', svg: bird },
  { id: 'rabbit', label: 'Rabbit', svg: rabbit },
  { id: 'fish', label: 'Fish', svg: fish },
  { id: 'bug', label: 'Bug', svg: bug },
  { id: 'paw-print', label: 'Paw', svg: pawPrint },
  { id: 'apple', label: 'Apple', svg: apple },
  { id: 'banana', label: 'Banana', svg: banana },
  { id: 'cherry', label: 'Cherry', svg: cherry },
  { id: 'pizza', label: 'Pizza', svg: pizza },
  { id: 'coffee', label: 'Coffee', svg: coffee },
  { id: 'cookie', label: 'Cookie', svg: cookie },
  { id: 'ice-cream', label: 'Ice cream', svg: iceCream },
  { id: 'heart', label: 'Heart', svg: heart },
  { id: 'star', label: 'Star', svg: star },
  { id: 'crown', label: 'Crown', svg: crown },
  { id: 'gem', label: 'Gem', svg: gem },
  { id: 'flame', label: 'Flame', svg: flame },
  { id: 'snowflake', label: 'Snowflake', svg: snowflake },
  { id: 'moon', label: 'Moon', svg: moon },
  { id: 'sun', label: 'Sun', svg: sun },
  { id: 'cloud', label: 'Cloud', svg: cloud },
  { id: 'zap', label: 'Bolt', svg: zap },
  { id: 'umbrella', label: 'Umbrella', svg: umbrella },
  { id: 'anchor', label: 'Anchor', svg: anchor },
  { id: 'key', label: 'Key', svg: key },
  { id: 'music', label: 'Music', svg: music },
  { id: 'camera', label: 'Camera', svg: camera },
  { id: 'gift', label: 'Gift', svg: gift },
  { id: 'rocket', label: 'Rocket', svg: rocket },
  { id: 'ghost', label: 'Ghost', svg: ghost },
  { id: 'skull', label: 'Skull', svg: skull },
  { id: 'bomb', label: 'Bomb', svg: bomb },
  { id: 'puzzle', label: 'Puzzle', svg: puzzle },
  { id: 'bike', label: 'Bike', svg: bike },
  { id: 'plane', label: 'Plane', svg: plane },
  { id: 'sailboat', label: 'Sailboat', svg: sailboat },
  { id: 'smile', label: 'Smile', svg: smile },
  { id: 'laugh', label: 'Laugh', svg: laugh },
  { id: 'trophy', label: 'Trophy', svg: trophy },
  { id: 'target', label: 'Target', svg: target },
  { id: 'glasses', label: 'Glasses', svg: glasses },
  { id: 'car', label: 'Car', svg: car },
  { id: 'car-taxi', label: 'Taxi', svg: carTaxi },
  { id: 'motorbike', label: 'Motorbike', svg: motorbike },
  { id: 'bus', label: 'Bus', svg: bus },
  { id: 'train', label: 'Train', svg: train },
  { id: 'helicopter', label: 'Helicopter', svg: helicopter },
  { id: 'ambulance', label: 'Ambulance', svg: ambulance },
  { id: 'truck', label: 'Truck', svg: truck },
  { id: 'candy', label: 'Gummy candy', svg: candy },
  { id: 'red-heart', label: 'Red heart', svg: redHeart, category: 'colored' },
  { id: 'blue-car', label: 'Blue car', svg: blueCar, category: 'colored' },
  { id: 'golden-star', label: 'Golden star', svg: goldenStar, category: 'colored' },
  { id: 'jumping-bunny', label: 'Jumping bunny', svg: jumpingBunny, category: 'animated' },
  { id: 'running-dog', label: 'Running dog', svg: runningDog, category: 'animated' },
  { id: 'spinning-star', label: 'Spinning star', svg: spinningStar, category: 'animated' }
]

export const DEFAULT_AVATAR_ID = 'arrow'

export function getAvatarSvg(avatarId) {
  return (AVATAR_ICONS.find((a) => a.id === avatarId) || AVATAR_ICONS[0]).svg
}
