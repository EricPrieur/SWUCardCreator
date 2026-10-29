import type { Arena, Aspect, CardDef, Keywords } from './types.ts'

// A card as the Creator saves it (one of a set's exported .json files), as far as the engine
// reads it
export type SavedCard = {
  id: string
  frameId: string
  backFrameId?: string
  name: string
  subtitle?: string
  trait?: string
  text?: string
  backText?: string
  unique?: boolean
  cost?: number
  power?: number
  hp?: number
}

const aspectNames: Aspect[] = ['Vigilance', 'Command', 'Aggression', 'Cunning', 'Heroism', 'Villainy']
const typeNames = { unit: 'unit', leader: 'leader', base: 'base', event: 'event', upgrade: 'upgrade' } as const

// A frame's id names what it is: unit-vigilance-villainy-space, leader-cunning-heroism-unit,
// base-command-text. Tokens and fortifications are not cards a deck plays yet.
function frameFacts(frameId: string) {
  const words = frameId.split('-')
  const type = typeNames[words[0] as keyof typeof typeNames]
  const aspects = words.flatMap((w) => aspectNames.filter((a) => a.toLowerCase() === w))
  const arena: Arena = words.includes('space') ? 'space' : 'ground'
  return { type, aspects, arena }
}

// The keywords printed on a side: each stands on a line of its own, as "[Sentinel]" or
// "[Raid 2]". One a unit only gains on a condition is part of a sentence and not read.
export function printedKeywords(text = ''): Keywords {
  const keywords: Keywords = {}
  for (const line of text.split('\n')) {
    const words = line.trim().match(/^\[([A-Za-z]+)(?: (\d+))?\]$/)
    if (!words) continue
    const [, name, amount] = words
    switch (name.toLowerCase()) {
      case 'sentinel':
        keywords.sentinel = true
        break
      case 'overwhelm':
        keywords.overwhelm = true
        break
      case 'grit':
        keywords.grit = true
        break
      case 'saboteur':
        keywords.saboteur = true
        break
      // Numbered keywords stack (7.5.4)
      case 'raid':
        keywords.raid = (keywords.raid ?? 0) + Number(amount ?? 1)
        break
      case 'restore':
        keywords.restore = (keywords.restore ?? 0) + Number(amount ?? 1)
        break
    }
  }
  return keywords
}

// The engine's card for a saved one, or nothing for a card no deck plays (a token, a
// fortification). A leader's Leader side keeps the deploy cost; its back is the unit.
export function cardDef(card: SavedCard): CardDef | undefined {
  const front = frameFacts(card.frameId)
  if (!front.type) return undefined
  const traits = (card.trait ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  const def: CardDef = {
    id: card.id,
    name: card.name,
    subtitle: card.subtitle?.trim() || undefined,
    type: front.type,
    cost: card.cost ?? 0,
    power: front.type === 'leader' ? 0 : (card.power ?? 0),
    hp: front.type === 'leader' ? 0 : (card.hp ?? 0),
    aspects: front.aspects,
    traits,
    unique: front.type === 'leader' || !!card.unique,
    keywords: printedKeywords(card.text),
  }
  if (front.type === 'unit') def.arena = front.arena
  if (front.type === 'leader') {
    def.unit = {
      power: card.power ?? 0,
      hp: card.hp ?? 0,
      arena: card.backFrameId ? frameFacts(card.backFrameId).arena : 'ground',
      keywords: printedKeywords(card.backText),
    }
  }
  return def
}

// "Create a Random Deck": a random leader, a random base of another aspect than the leader's
// (an aspect twice gains nothing in DUNE), and 50 cards from the set chosen at random
// among those their aspects pay for in full, 1 to 3 copies each (a unique card once), then
// among cards that miss one aspect. Events are left out while their text does nothing.
export function randomDeck(defs: CardDef[], random: () => number = Math.random, size = 50) {
  const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)]
  const shuffled = <T>(list: T[]) => {
    const copy = [...list]
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      ;[copy[i], copy[j]] = [copy[j], copy[i]]
    }
    return copy
  }
  const leader = pick(defs.filter((d) => d.type === 'leader'))
  const bases = defs.filter((d) => d.type === 'base')
  const other = bases.filter((d) => !d.aspects.some((a) => leader.aspects.includes(a)))
  const base = pick(other.length ? other : bases)
  const provided = [...leader.aspects, ...base.aspects]
  const missing = (card: CardDef) =>
    [...new Set(card.aspects)].reduce(
      (sum, aspect) =>
        sum + Math.max(0, card.aspects.filter((a) => a === aspect).length - provided.filter((a) => a === aspect).length),
      0,
    )
  const playable = defs.filter((d) => d.type === 'unit' || d.type === 'upgrade')
  const pool = [...shuffled(playable.filter((d) => missing(d) === 0)), ...shuffled(playable.filter((d) => missing(d) === 1))]
  const copies = new Map<string, number>()
  const add = (card: CardDef, wanted: number) => {
    const max = card.unique ? 1 : 3
    while ((copies.get(card.id) ?? 0) < Math.min(wanted, max) && [...copies.values()].reduce((a, b) => a + b, 0) < size)
      copies.set(card.id, (copies.get(card.id) ?? 0) + 1)
  }
  for (const card of pool) add(card, 1 + Math.floor(random() * 3))
  // Too few cards that fit: each goes up to 3 copies
  for (const card of pool) add(card, 3)
  return { leader: leader.id, base: base.id, deck: [...copies].flatMap(([id, count]) => Array(count).fill(id) as string[]) }
}
