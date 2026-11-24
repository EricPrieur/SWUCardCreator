// Temporary: the "pool gauntlet": each DUNE card in no Featured Deck swapped into the Featured Deck
// that fits it best, in place of its most similar card, so each deck keeps its shell. Writes the
// 12 decks plus the swapped ones (named "Pool <deck>") to the file given, for FEATURED.
//   node tools/pool-swaps.ts <out.json>          (ONLY="Name A|Name B" for just those cards)
import { readFileSync, writeFileSync } from 'node:fs'
import { loadDefs } from './dune.ts'
import type { CardDef } from '../engine/types.ts'

const MAX_SWAPS = 6
const defs = loadDefs()
const byId = new Map(defs.map((d) => [d.id, d]))
type Deck = { name: string; leader: string; base: string; cards: { id: string; count: number }[] }
const decks: Deck[] = JSON.parse(readFileSync('../public/sim/featured-decks.json', 'utf8'))
const used = new Set(decks.flatMap((d) => [d.leader, d.base, ...d.cards.map((c) => c.id)]))
const aspectsOf = (deck: Deck) => [...(byId.get(deck.leader)?.aspects ?? []), ...(byId.get(deck.base)?.aspects ?? [])]
const fits = (card: CardDef, deck: Deck) => {
  const have = [...aspectsOf(deck)]
  return card.aspects.every((a) => {
    const i = have.indexOf(a)
    if (i < 0) return false
    have.splice(i, 1)
    return true
  })
}
// Traits too common to say a card belongs in a deck
const COMMON = new Set(['Vehicle', 'Fighter', 'Transport', 'Capital Ship', 'Item', 'Weapon', 'Armor', 'Official', 'Trick', 'Disaster', 'Supply', 'Learned'])
const keyTraits = (d: CardDef) => d.traits.filter((t) => !COMMON.has(t))
const synergy = (card: CardDef, deck: Deck) => {
  const traits = keyTraits(card)
  const leader = byId.get(deck.leader)!
  const shared = deck.cards.filter((c) => keyTraits(byId.get(c.id)!).some((t) => traits.includes(t))).reduce((n, c) => n + c.count, 0)
  return shared + (keyTraits(leader).some((t) => traits.includes(t)) ? 6 : 0)
}

// ONLY="Name A|Name B": just those cards (a quick test of new ones)
const only = process.env.ONLY?.split('|').map((n) => n.trim())
const unplayed = defs.filter(
  (d) => !d.token && !used.has(d.id) && !d.id.includes('#') && d.type !== 'leader' && d.type !== 'base' && (!only || only.includes(d.name)),
)
const swaps = new Map<string, { add: string; remove: string; count: number }[]>()
const skipped: string[] = []
// The cards with fewest decks to go to are placed first
const options = (card: CardDef) => decks.filter((d) => fits(card, d))
for (const card of [...unplayed].sort((a, b) => options(a).length - options(b).length)) {
  const ranked = options(card)
    .filter((d) => (swaps.get(d.name)?.length ?? 0) < MAX_SWAPS)
    .sort((a, b) => synergy(card, b) - synergy(card, a))
  let placed = false
  for (const deck of ranked) {
    const taken = new Set((swaps.get(deck.name) ?? []).map((s) => s.remove))
    // The most similar card: same type, then the same aspects, then the closest cost
    const candidates = deck.cards
      .map((c) => ({ c, d: byId.get(c.id)! }))
      .filter(({ c, d }) => d.type === card.type && !taken.has(c.id) && Math.abs(d.cost - card.cost) <= 2)
      .sort(
        (x, y) =>
          Number(y.d.aspects.join() === card.aspects.join()) - Number(x.d.aspects.join() === card.aspects.join()) ||
          Math.abs(x.d.cost - card.cost) - Math.abs(y.d.cost - card.cost) ||
          // A card sharing a trait with it, then the arena
          Number(keyTraits(y.d).some((t) => keyTraits(card).includes(t))) - Number(keyTraits(x.d).some((t) => keyTraits(card).includes(t))) ||
          Number(y.d.arena === card.arena) - Number(x.d.arena === card.arena),
      )
    const out = candidates[0]
    if (!out) continue
    swaps.set(deck.name, [...(swaps.get(deck.name) ?? []), { add: card.id, remove: out.c.id, count: out.c.count }])
    placed = true
    break
  }
  if (!placed) skipped.push(card.name)
}

const name = (id: string) => {
  const d = byId.get(id)!
  return `${d.name}${d.subtitle ? `, ${d.subtitle}` : ''} (${d.cost})`
}
const out: Deck[] = [...decks]
for (const deck of decks) {
  const list = swaps.get(deck.name)
  if (!list) continue
  console.log(`Pool ${deck.name}:`)
  for (const s of list) console.log(`  ${s.count}x ${name(s.add)}  in place of  ${name(s.remove)}`)
  const cards = deck.cards.map((c) => {
    const s = list.find((x) => x.remove === c.id)
    return s ? { id: s.add, count: c.count } : c
  })
  out.push({ ...deck, name: `Pool ${deck.name}`, cards })
}
console.log(`\nNot placed (no deck fits, or no similar card within 2 cost): ${skipped.join(', ') || 'none'}`)
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(out, null, 2))
