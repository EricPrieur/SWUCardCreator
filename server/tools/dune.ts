// What the game tools share: the DUNE set as the simulator loads it, its Featured Decks, and
// actions put in words (which the Admin panel shares too)
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { cardDef } from '../engine/cards.ts'
import type { DeckList } from '../engine/game.ts'
import type { CardDef } from '../engine/types.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const setDir = `${root}public/showcase/DUNE/`

// The set's cards, a two-sided base's back as a card of its own (id#back), as in the simulator
export function loadDefs(): CardDef[] {
  const list: { image: string }[] = JSON.parse(readFileSync(`${setDir}showcase.json`, 'utf8')).cards
  const defs: CardDef[] = []
  for (const entry of list) {
    const file = `${setDir}${entry.image}.json`
    if (!existsSync(file)) continue
    const card = JSON.parse(readFileSync(file, 'utf8'))
    const def = cardDef(card)
    if (!def) continue
    defs.push(def)
    const back = def.type === 'base' && card.backFrameId && cardDef({ ...card, id: `${card.id}#back`, frameId: card.backFrameId })
    if (back) defs.push(back)
  }
  return defs
}

type Featured = { name: string; leader: string; base: string; cards: { id: string; count: number }[] }
export const featured: Featured[] = JSON.parse(readFileSync(`${root}public/sim/featured-decks.json`, 'utf8'))

// A Featured Deck as the engine takes it, by its name (any case, any part of it)
export function deckList(name: string, defs: CardDef[]): DeckList {
  const deck = featured.find((d) => d.name.toLowerCase().includes(name.toLowerCase()))
  if (!deck) throw new Error(`No Featured Deck named ${name}: ${featured.map((d) => d.name).join(', ')}`)
  const known = new Set(defs.map((d) => d.id))
  return {
    name: deck.name,
    leader: deck.leader,
    base: deck.base,
    deck: deck.cards.filter((c) => known.has(c.id)).flatMap((c) => Array<string>(c.count).fill(c.id)),
  }
}

export { describe, nameIn } from '../engine/describe.ts'
