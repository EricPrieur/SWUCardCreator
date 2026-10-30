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
  // The art, a file beside the card's image
  art?: { src?: string }
}

const aspectNames: Aspect[] = ['Vigilance', 'Command', 'Aggression', 'Cunning', 'Heroism', 'Villainy']
const typeNames = { unit: 'unit', leader: 'leader', base: 'base', event: 'event', upgrade: 'upgrade' } as const

// A frame's id names what it is: unit-vigilance-villainy-space, leader-cunning-heroism-unit,
// base-command-text; unit-token-text-neutral for a token unit, spice-token for the Spice token;
// fortification-cunning for a Fortification, an upgrade with Fortify.
function frameFacts(frameId: string) {
  const words = frameId.split('-')
  const type =
    words[0] === 'spice' ? ('token' as const) : words[0] === 'fortification' ? ('upgrade' as const) : typeNames[words[0] as keyof typeof typeNames]
  const aspects = words.flatMap((w) => aspectNames.filter((a) => a.toLowerCase() === w))
  const arena: Arena = words.includes('space') ? 'space' : 'ground'
  return { type, aspects, arena, token: words.includes('token') }
}

// One keyword as printed, "Sentinel" or "Raid 2", added to those a card has. Numbered keywords
// stack (7.5.4).
function addKeyword(keywords: Keywords, word: string) {
  const [, name, amount] = word.trim().match(/^([A-Za-z]+)(?: (\d+))?$/) ?? []
  switch (name?.toLowerCase()) {
    case 'sentinel':
    case 'overwhelm':
    case 'grit':
    case 'saboteur':
    case 'ambush':
    case 'hidden':
    case 'plot':
    case 'fortify':
      keywords[name.toLowerCase() as 'sentinel'] = true
      return true
    case 'raid':
    case 'restore':
      keywords[name.toLowerCase() as 'raid'] = (keywords[name.toLowerCase() as 'raid'] ?? 0) + Number(amount ?? 1)
      return true
  }
  return false
}

// The lines of text the engine plays itself, on any card, without a script
const keywordLine = /^\[([A-Za-z]+(?: \d+)?)\]$/
const smuggleLine = /^\[Smuggle\]?\s*\[\[(\d+)[^\]]*\]\]\]?$/i
const arrakisLine = /^While you control an \[\{?Arrakis\}?\] base, this unit gains (.+)\.$/i
const spiceCostLine = /^As an additional cost to play this unit, defeat (a|\d+) friendly Spice tokens?\.$/i
const startSpiceLine = /^You start the game with (a|\d+) \[?Spice Tokens?\]?\.$/i
const attachLine = /^Attach to an? ((?:(?:friendly|non-leader|non-\[\{?[^}\]]+\}?\]),? )*)unit\.$/i
const attachedGainsLine = /^Attached unit gains ((?:\[[^\]]+\](?:,? and |, )?)+)\.$/i
// "< >" and "<< >>" only box a line on the card
const unboxed = (line: string) => line.trim().replace(/^<<?\s*(.*?)\s*>>?$/, '$1')
const count = (word: string) => (/^\d+$/.test(word) ? Number(word) : 1)

// What a card's text says that the engine plays without a script: its keywords, those it gains
// with an Arrakis base, a Spice token to pay as it is played or to start the game with
export function readText(text = '') {
  const read: Pick<CardDef, 'keywords' | 'arrakisKeywords' | 'spiceCost' | 'startSpice' | 'attach' | 'attachedKeywords'> = {
    keywords: {},
  }
  for (const raw of text.split('\n')) {
    const line = unboxed(raw)
    let match
    if ((match = line.match(keywordLine))) addKeyword(read.keywords, match[1])
    else if ((match = line.match(smuggleLine))) read.keywords.smuggle = Number(match[1])
    else if ((match = line.match(arrakisLine))) {
      read.arrakisKeywords = {}
      for (const [, word] of match[1].matchAll(/\[([^\]]+)\]/g)) addKeyword(read.arrakisKeywords, word)
    } else if ((match = line.match(spiceCostLine))) read.spiceCost = count(match[1])
    else if ((match = line.match(startSpiceLine))) read.startSpice = count(match[1])
    else if ((match = line.match(attachLine))) {
      const words = match[1]
      const not = [...words.matchAll(/non-\[\{?([^}\]]+)\}?\]/gi)].map((m) => m[1])
      read.attach = {
        ...(/friendly/i.test(words) && { friendly: true }),
        ...(not.length && { not }),
        ...(/non-leader/i.test(words) && { nonLeader: true }),
      }
    }
    else if ((match = line.match(attachedGainsLine))) {
      read.attachedKeywords = {}
      for (const [, word] of match[1].matchAll(/\[([^\]]+)\]/g)) addKeyword(read.attachedKeywords, word)
    }
  }
  return read
}

// Whether the engine plays a line of text by itself (see readText)
export function enginePlays(line: string) {
  const text = unboxed(line)
  if (keywordLine.test(text)) return addKeyword({}, text.slice(1, -1))
  const gains = text.match(arrakisLine) ?? text.match(attachedGainsLine)
  if (gains) return [...gains[1].matchAll(/\[([^\]]+)\]/g)].every(([, word]) => addKeyword({}, word))
  return [smuggleLine, spiceCostLine, startSpiceLine, attachLine].some((pattern) => pattern.test(text))
}

// The keywords printed on a side: each stands on a line of its own, as "[Sentinel]" or
// "[Raid 2]". One a unit only gains on a condition is part of a sentence and read apart.
export function printedKeywords(text = ''): Keywords {
  return readText(text).keywords
}

// The engine's card for a saved one, or nothing for a frame it doesn't know.
// A leader's Leader side keeps the deploy cost; its back is the unit.
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
    ...readText(card.text),
    text: card.text,
  }
  if (front.token) {
    def.token = true
    def.cost = 0
  }
  if (front.type === 'unit') def.arena = front.arena
  if (front.type === 'leader') {
    const back = readText(card.backText)
    def.unit = {
      power: card.power ?? 0,
      hp: card.hp ?? 0,
      arena: card.backFrameId ? frameFacts(card.backFrameId).arena : 'ground',
      keywords: back.keywords,
      ...(back.arrakisKeywords && { arrakisKeywords: back.arrakisKeywords }),
    }
    def.backText = card.backText
  }
  return def
}

// The official tokens DUNE cards give (3.7.5-3.7.6), and the set's own Spice and Fremen tokens
// for a game whose cards don't include them
export const builtInTokens: CardDef[] = [
  { name: 'Experience', type: 'upgrade', power: 1, hp: 1, traits: ['Learned'] },
  { name: 'Shield', type: 'upgrade', power: 0, hp: 0, traits: ['Armor'] },
  { name: 'Weakness', type: 'upgrade', power: -1, hp: -1, traits: ['Condition'] },
  {
    name: 'Spice',
    type: 'token',
    power: 0,
    hp: 0,
    traits: ['Supply'],
    text: '[Action:] Defeat this token. Look at the top 3 cards of your deck. Draw 1 of them. Put each of the others on the top or bottom of your deck in any order, or discard it.',
  },
  {
    name: 'Fremen',
    type: 'unit',
    power: 2,
    hp: 1,
    arena: 'ground',
    traits: ['Fremen', 'Trooper'],
    text: 'While you control an [{Arrakis}] base, this unit gains [Raid 1].',
    arrakisKeywords: { raid: 1 },
  },
].map((token) => ({
  id: `token-${token.name.toLowerCase()}`,
  cost: 0,
  aspects: [],
  unique: false,
  keywords: {},
  token: true,
  ...(token as Partial<CardDef>),
})) as CardDef[]

// "Create a Random Deck": a random leader, a random base of another aspect than the leader's
// (an aspect twice gains nothing in DUNE), and 50 cards from the set chosen at random
// among those their aspects pay for in full, 1 to 3 copies each (a unique card once), then
// among cards that miss one aspect
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
  const playable = defs.filter((d) => (d.type === 'unit' || d.type === 'upgrade' || d.type === 'event') && !d.token)
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
