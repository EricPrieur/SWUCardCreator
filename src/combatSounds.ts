import { asset } from './asset'
import type { CardDef, GameState } from '../server/engine/types.ts'

// The sounds of the game's moves. Each unit fights with its weapon, the defender a moment after
// the attacker: a strike that defeats the other unit sounds of its weapon cutting (or of an
// explosion, for a ship), one that doesn't of a block, an attack on a base of the weapon hitting
// it. A gun fires first. A unit coming into play sounds of its weapon drawn or its engine.
// Some events and upgrades have a sound as they are played, a Shield token as it stops damage.
// Blades from CCG Quest's Weapons sounds; guns, explosions, engines and shields from Kenney's
// Sci-Fi Sounds (CC0). Units with no weapon here, by name or as a Vehicle, are silent.
type Weapon = 'dagger' | 'sword' | 'heavy' | 'fighter' | 'transport' | 'capital' | 'vehicle' | 'artillery'

const WEAPONS: Record<string, Weapon> = {
  // Knives and crysknives
  'Paul Atreides': 'dagger',
  'Feyd-Rautha Harkonnen': 'dagger',
  'Alia Atreides': 'dagger',
  Fremen: 'dagger',
  'Fremen Warrior': 'dagger',
  'Fremen Saboteurs': 'dagger',
  'Fedaykin Death Commando': 'dagger',
  'Sietch Raiders': 'dagger',
  'Spice Hunter': 'dagger',
  'Shadout Mapes': 'dagger',
  Stilgar: 'dagger',
  Chani: 'dagger',
  'Spice-Sworn Blade': 'dagger',
  'Count Hasimir Fenring': 'dagger',
  'Imperial Spy': 'dagger',
  'Tleilaxu Face Dancer': 'dagger',
  // Swords
  'Duncan Idaho': 'sword',
  'Gurney Halleck': 'sword',
  'Duke Leto Atreides': 'sword',
  'Atreides Swordsman': 'sword',
  'Atreides Troops': 'sword',
  'Atreides House Guard': 'sword',
  'Atreides Shield Trooper': 'sword',
  'Ginaz Swordmaster': 'sword',
  'Ginaz Mercenary': 'sword',
  'Harkonnen Troops': 'sword',
  'Harkonnen Sergeant': 'sword',
  'Sardaukar Levenbrech': 'sword',
  'Sardaukar Bashar': 'sword',
  // Heavy blades
  'Glossu Rabban': 'heavy',
  'Sardaukar Trooper': 'heavy',
  'Sardaukar Legion': 'heavy',
  // Guns
  'Old Artillery': 'artillery',
}

// A Vehicle with no weapon of its own: by what kind of craft it is
function vehicle(d: CardDef): Weapon | undefined {
  if (!d.traits.includes('Vehicle')) return undefined
  if (d.arena !== 'space') return 'vehicle'
  if (d.traits.includes('Capital Ship')) return 'capital'
  return d.traits.includes('Fighter') ? 'fighter' : 'transport'
}

type Sound = { file: string; cut?: number }
const blade = (name: string): Sound => ({ file: asset(`/sim/sounds/weapons/${name}.ogg`) })
const scifi = (name: string, cut?: number): Sound => ({ file: asset(`/sim/sounds/scifi/${name}.ogg`), cut })
// An engine's sound is a loop of a few seconds: only its start is heard
const ENGINE = 1300
const explosion = [scifi('explosionCrunch_000'), scifi('explosionCrunch_001'), scifi('explosionCrunch_002')]
const deepExplosion = [scifi('lowFrequency_explosion_000'), scifi('lowFrequency_explosion_001')]
const metal = [scifi('impactMetal_000'), scifi('impactMetal_001')]

// shot: a gun fires before its strike lands; enter: as the unit comes into play (played,
// deployed or created)
const SOUNDS: Record<Weapon, { shot?: Sound[]; kill: Sound[]; block: Sound[]; base: Sound[]; enter: Sound[] }> = {
  dagger: { kill: [blade('dagger_gore_flesh_01')], block: [blade('shield_hit_01')], base: [blade('dagger_stab_01')], enter: [blade('dagger_stab_01')] },
  sword: {
    kill: [blade('sword_light_1h_flesh_01')],
    block: [blade('sword_clang_01'), blade('sword_clang_02')],
    base: [blade('sword_rock_wall_01')],
    enter: [blade('sword_clang_02')],
  },
  heavy: {
    kill: [blade('sword_heavy_2h_flesh_01')],
    block: [blade('sword_heavy_2h_hit_01')],
    base: [blade('sword_axe_heavy_whoosh_impact_01')],
    enter: [blade('sword_axe_heavy_whoosh_impact_01')],
  },
  fighter: {
    shot: [scifi('laserSmall_000'), scifi('laserSmall_001'), scifi('laserSmall_002')],
    kill: explosion,
    block: metal,
    base: explosion,
    enter: [scifi('spaceEngineSmall_000', ENGINE)],
  },
  transport: {
    shot: [scifi('laserRetro_000'), scifi('laserRetro_001')],
    kill: explosion,
    block: metal,
    base: explosion,
    enter: [scifi('spaceEngine_000', ENGINE)],
  },
  capital: {
    shot: [scifi('laserLarge_000'), scifi('laserLarge_001')],
    kill: deepExplosion,
    block: metal,
    base: deepExplosion,
    enter: [scifi('spaceEngineLarge_000', ENGINE)],
  },
  vehicle: { kill: explosion, block: metal, base: metal, enter: [scifi('engineCircular_000', ENGINE)] },
  artillery: { shot: deepExplosion, kill: explosion, block: metal, base: explosion, enter: [scifi('engineCircular_000', ENGINE)] },
}

// Events and upgrades, as they are played
const PLAYED: Record<string, Sound[]> = {
  'Lasgun Volley': [scifi('laserLarge_000'), scifi('laserLarge_001')],
  Lasgun: [scifi('laserSmall_000')],
  'Family Atomics': deepExplosion,
  Sabotage: explosion,
  "The Baron's Wrath": explosion,
  'Personal Shield': [scifi('forceField_000')],
}
// Units as they are defeated: the Flamer's tanks go up
const DEFEATED: Record<string, Sound[]> = {
  'Harkonnen Flamer': [scifi('thrusterFire_000', 1400)],
}
const SHIELD = [scifi('forceField_000'), scifi('forceField_001')]

// A gun's strike lands this long after it fires (ms)
const SHOT = 140
// The defender strikes back this long after the attacker
const STRIKE_BACK = 280
// Fights one after another in a move (an ability that attacks twice) are this far apart
const NEXT_FIGHT = 650
// Other sounds one after another in a move (a Drop Ship's Troopers coming in) are this far apart
const NEXT = 220

const fight = / attacks (.+) with (.+)$/

// The sounds of a move: the units it brought into play, then what the log lines it added tell,
// in order: cards played, fights ("<player> attacks <defender> with <attacker>", and which of
// them were then defeated), Shield tokens stopping damage, units defeated
export function combatSounds(before: GameState, after: GameState, play: (sound: string, delay: number, cut?: number) => void) {
  const lines = after.log.slice(before.log.length).map((l) => l.text)
  const bases = new Set(after.players.map((p) => after.defs[p.base.def].name))
  const byName = new Map(Object.values(after.defs).map((d) => [d.name, d]))
  const weaponOf = (name: string) => WEAPONS[name] ?? (byName.has(name) ? vehicle(byName.get(name)!) : undefined)
  let at = 0
  const sound = (list: Sound[], delay = at) => {
    const s = pick(list)
    play(s.file, delay, s.cut)
  }
  // The units that came into play
  const was = new Set(before.players.flatMap((p) => p.units.map((u) => u.id)))
  for (const unit of after.players.flatMap((p) => p.units)) {
    const weapon = !was.has(unit.id) && weaponOf(after.defs[unit.def].name)
    if (!weapon) continue
    sound(SOUNDS[weapon].enter)
    at += NEXT
  }
  lines.forEach((line, i) => {
    const played = line.match(/ plays (.+?)(?: using .+| from .+)?$/)
    if (played && PLAYED[played[1]]) {
      sound(PLAYED[played[1]])
      at += NEXT
      return
    }
    if (line.startsWith('A Shield token prevents the damage')) {
      sound(SHIELD)
      at += NEXT
      return
    }
    const gone = line.match(/^(.+) is defeated$/)
    if (gone && DEFEATED[gone[1]]) {
      sound(DEFEATED[gone[1]])
      at += NEXT
      return
    }
    const attack = line.match(fight)
    if (!attack) return
    const [, defender, attacker] = attack
    // What came of this attack: the lines up to the next one
    const next = lines.findIndex((l, j) => j > i && fight.test(l))
    const result = lines.slice(i + 1, next < 0 ? undefined : next)
    const defeated = (name: string) => result.includes(`${name} is defeated`)
    const strikes = weaponOf(attacker)
    let landed = at
    if (strikes) {
      const s = SOUNDS[strikes]
      if (s.shot) {
        sound(s.shot)
        landed += SHOT
      }
      sound(bases.has(defender) ? s.base : defeated(defender) ? s.kill : s.block, landed)
    }
    const back = !bases.has(defender) && weaponOf(defender)
    if (back) {
      const s = SOUNDS[back]
      let hit = landed + (strikes ? STRIKE_BACK : 0)
      if (s.shot) {
        sound(s.shot, hit)
        hit += SHOT
      }
      sound(defeated(attacker) ? s.kill : s.block, hit)
    }
    if (strikes || back) at += NEXT_FIGHT
  })
}

const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)]
