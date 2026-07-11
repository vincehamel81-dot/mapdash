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

// The app's original marker shape, hand-kept here (not from lucide) using fill="currentColor" so
// it recolors the same way as every other avatar, plus a dark outline so it stays visible even
// when the chosen color is white.
const arrow = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none">
  <path d="M12 2.5L19.5 21L12 17L4.5 21L12 2.5Z" fill="currentColor" stroke="#3c4043" stroke-width="1" stroke-linejoin="round"/>
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
  { id: 'truck', label: 'Truck', svg: truck }
]

export const DEFAULT_AVATAR_ID = 'arrow'

export function getAvatarSvg(avatarId) {
  return (AVATAR_ICONS.find((a) => a.id === avatarId) || AVATAR_ICONS[0]).svg
}
