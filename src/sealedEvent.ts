// A Sealed event on paper: what to print for so many players, and what goes in each pack.
// Each player opens 6 packs of 15 cards: a leader (rare one pack in 6, as the Deck Builder's
// Sealed opens them) and a base (each player gets every common base once, the Arrakis base of
// each aspect, and two-sided rare ones in the packs left: see playerBases), 8 commons, 3 uncommons, a rare or legendary (each one
// once, legendaries in their share of the set; with near enough packs for all, every one of
// them) and a wild card, of any rarity as often as each is in a pack, printed as its Prescient
// (full-art) version, a legendary too. One leader in 6 is Prescient as well, both sides, and one
// base in 6, and so is the token on its back. The print run is exactly what the packs take.

export type EventCard = { name: string; type: string; rarity?: string }
export type EventSlot = 'Leader' | 'Base' | 'Common' | 'Uncommon' | 'Rare' | 'Legendary' | 'Wild'
// prescient: printed in full art, as the wild cards always are and a leader and a base one pack in 6
export type EventPack<T> = { player: number; pack: number; cards: { card: T; slot: EventSlot; prescient?: boolean }[] }
// copies: the cards printed as they are; prescient: those printed in full art
export type EventPlan<T> = { packs: EventPack<T>[]; copies: Map<T, number>; prescient: Map<T, number> }

export const EVENT_PACKS = 6
export const EVENT_PACK_SIZE = 15
const RARE_LEADER_ODDS = 1 / 6
const LEGENDARY_ODDS = 1 / 6
const PRESCIENT_SIDE_ODDS = 1 / 6
// So many deals tried, the fairest kept
const DEALS = 40

// The same seed always deals the same packs (from the same cards), so a print run can be made
// again, or picked up where it was cut off. Mulberry32 over a hash of the seed.
export function seededRandom(seed: string): () => number {
  let state = 2166136261
  for (let i = 0; i < seed.length; i++) state = Math.imul(state ^ seed.charCodeAt(i), 16777619)
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle<T>(list: T[], random: () => number) {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

// A player's bases, one a pack, in the order the packs give them: every common base once (as
// many as there are packs, two kept for rare ones), then rare ones, each a different one as long
// as there are enough. rares: the rare ones to give, in order.
export function playerBases<T>(commons: T[], rares: T[], packs: number, random: () => number): T[] {
  const commonCount = Math.min(commons.length, Math.max(0, packs - Math.min(2, rares.length)))
  const picked = [...shuffle(commons, random).slice(0, commonCount), ...rares.slice(0, packs - commonCount)]
  return shuffle(picked, random)
}

// count cards from the list, each as often as the others give or take one (which ones get one
// more is left to chance)
function spread<T>(list: T[], count: number, random: () => number) {
  if (list.length === 0) return []
  const order = shuffle(list, random)
  return Array.from({ length: count }, (_, i) => order[i % order.length])
}

export function planSealedEvent<T extends EventCard>(cards: T[], players: number, random: () => number = Math.random): EventPlan<T> {
  const packCount = players * EVENT_PACKS
  const of = (kind: 'Leader' | 'Base' | 'Other', rarity: string) =>
    cards.filter(
      (card) => (kind === 'Other' ? card.type !== 'Leader' && card.type !== 'Base' && card.type !== 'Token' : card.type === kind) && card.rarity === rarity,
    )
  // The rarity wanted, or another when the set has none of it
  const firstOf = (...lists: T[][]) => lists.find((list) => list.length) ?? []

  // Leaders and bases: rare in one pack of 6
  const sides = (kind: 'Leader' | 'Base') => {
    const rare = firstOf(of(kind, 'R'), of(kind, 'C'))
    const common = firstOf(of(kind, 'C'), of(kind, 'R'))
    const rareCount = Math.round(packCount * RARE_LEADER_ODDS)
    return [...spread(common, packCount - rareCount, random), ...spread(rare, rareCount, random)]
  }
  // Legendaries in their share of the rare slot; all of them when that share is within 2 of it
  const legendaries = of('Other', 'L')
  const rares = of('Other', 'R')
  const share = Math.round((packCount * legendaries.length) / Math.max(1, legendaries.length + rares.length))
  const legendaryCount = Math.min(packCount, share >= legendaries.length - 2 ? legendaries.length : share)
  const tops = [
    ...shuffle(legendaries, random).slice(0, legendaryCount),
    ...spread(firstOf(rares, legendaries), packCount - legendaryCount, random),
  ]
  const groups: { slot: EventSlot; per: number; pool: T[] }[] = [
    { slot: 'Leader', per: 1, pool: sides('Leader') },
    { slot: 'Common', per: 8, pool: spread(of('Other', 'C'), packCount * 8, random) },
    { slot: 'Uncommon', per: 3, pool: spread(firstOf(of('Other', 'U'), of('Other', 'C')), packCount * 3, random) },
    { slot: 'Rare', per: 1, pool: tops },
  ]
  // The wild cards: a rarity as often as it is in a pack (9 commons to 3 uncommons to 1 rare or
  // legendary), and of it the card printed least so far, so the copies stay even
  const printed = new Map<T, number>()
  for (const group of groups) for (const card of group.pool) printed.set(card, (printed.get(card) ?? 0) + 1)
  const wild: T[] = []
  for (let i = 0; i < packCount; i++) {
    const roll = random() * 13
    const rarity = roll < 9 ? 'C' : roll < 12 ? 'U' : random() < LEGENDARY_ODDS ? 'L' : 'R'
    const list = shuffle(firstOf(of('Other', rarity), of('Other', 'C')), random)
    const least = list.reduce<T | undefined>((best, card) => (best === undefined || (printed.get(card) ?? 0) < (printed.get(best) ?? 0) ? card : best), undefined)
    if (!least) continue
    wild.push(least)
    printed.set(least, (printed.get(least) ?? 0) + 1)
  }
  groups.push({ slot: 'Wild', per: 1, pool: wild })

  // Dealt: never twice the same card in a pack, and as few repeats in a player's pool as can be
  const deal = () => {
    const packs: EventPack<T>[] = Array.from({ length: packCount }, (_, i) => ({
      player: Math.floor(i / EVENT_PACKS) + 1,
      pack: (i % EVENT_PACKS) + 1,
      cards: [],
    }))
    const playerHas = new Map<number, Set<string>>()
    for (const group of groups) {
      const pool = shuffle(group.pool, random)
      for (const pack of shuffle(packs, random)) {
        const mine = playerHas.get(pack.player) ?? new Set<string>()
        playerHas.set(pack.player, mine)
        for (let k = 0; k < group.per && pool.length; k++) {
          const inPack = new Set(pack.cards.map(({ card }) => card.name))
          let at = pool.findIndex((card) => !inPack.has(card.name) && !mine.has(card.name))
          if (at < 0) at = pool.findIndex((card) => !inPack.has(card.name))
          if (at < 0) at = 0
          const [card] = pool.splice(at, 1)
          mine.add(card.name)
          const slot = group.slot === 'Rare' && card.rarity === 'L' ? 'Legendary' : group.slot
          pack.cards.push({ card, slot, ...(slot === 'Wild' && { prescient: true }) })
        }
      }
    }
    return packs
  }
  // A twice in a pack weighs far more than a repeat in a pool; the worst player's repeats count too
  const score = (packs: EventPack<T>[]) => {
    const twice = packs.filter((pack) => new Set(pack.cards.map(({ card }) => card.name)).size < pack.cards.length).length
    const repeats = Array.from({ length: players }, (_, i) => {
      const names = packs.filter((pack) => pack.player === i + 1).flatMap((pack) => pack.cards.map(({ card }) => card.name))
      return names.length - new Set(names).size
    })
    return twice * 1000 + Math.max(0, ...repeats) * 10 + repeats.reduce((sum, n) => sum + n, 0)
  }
  let packs = deal()
  for (let tries = 1; tries < DEALS && score(packs) > 0; tries++) {
    const next = deal()
    if (score(next) < score(packs)) packs = next
  }
  // The bases, after each leader: every player has each common base, and rare ones in the packs
  // left, as many of each rare one printed as of the others, a player's two never the same
  const commonBases = of('Base', 'C')
  const rareBases = of('Base', 'R')
  const rareCount = Math.max(0, EVENT_PACKS - Math.min(commonBases.length, EVENT_PACKS - Math.min(2, rareBases.length)))
  const rareRun = spread(rareBases, players * rareCount, random)
  for (let player = 1; player <= players; player++) {
    const rares = rareRun.slice((player - 1) * rareCount, player * rareCount)
    const bases = playerBases(commonBases.length ? commonBases : rareBases, rares, EVENT_PACKS, random)
    packs
      .filter((pack) => pack.player === player)
      .forEach((pack, i) => bases[i] && pack.cards.splice(1, 0, { card: bases[i], slot: 'Base' }))
  }
  // Prescient bases, then leaders: as many as one pack in 6, in packs left to chance (the bases
  // first, so a print run dealt before leaders were Prescient keeps its bases)
  for (const slot of ['Base', 'Leader'] as const) {
    const count = Math.round(packCount * PRESCIENT_SIDE_ODDS)
    for (const pack of shuffle(packs, random).slice(0, count)) {
      const side = pack.cards.find((card) => card.slot === slot)
      if (side) side.prescient = true
    }
  }
  const copies = new Map<T, number>()
  const prescient = new Map<T, number>()
  for (const pack of packs)
    for (const { card, prescient: full } of pack.cards) {
      const run = full ? prescient : copies
      run.set(card, (run.get(card) ?? 0) + 1)
    }
  return { packs, copies, prescient }
}
