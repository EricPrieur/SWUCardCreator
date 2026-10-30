import { applyAction, createGame, type DeckList } from './game.ts'
import type { Weighed } from './ai.ts'
import type { Action, CardDef, GameState, PlayerId } from './types.ts'

// A game as it is kept: the engine being seeded, its seed, its decks and the actions taken in
// order are the whole game, which replaying rebuilds exactly, at any moment. The AI's moves
// keep the moves it weighed, best first, so a record also says why.
export type GameRecord = {
  version: 1
  seed: number
  decks: [DeckList, DeckList]
  // Who played each side: a person, or the AI (and which, when versions are compared)
  players: [Seat, Seat]
  actions: Step[]
  result?: { winner: PlayerId | 'draw' | null; rounds: number }
  // When it was played, and anything a tool wants to note (a matchup's name)
  at?: string
  note?: string
}
export type Seat = { kind: 'human' } | { kind: 'ai'; version?: string }
// A card played names its card too, which its id in the game alone doesn't
export type Step = { p: PlayerId; action: Action; why?: Weighed[]; card?: string }

export function startRecord(seed: number, decks: [DeckList, DeckList], players: [Seat, Seat], note?: string): GameRecord {
  return { version: 1, seed, decks, players, actions: [], at: new Date().toISOString(), ...(note && { note }) }
}

// The action taken added to the record, and the game it makes
export function recordAction(record: GameRecord, state: GameState, p: PlayerId, action: Action, why?: Weighed[]) {
  const played = action.type === 'play' ? instanceDef(state, p, action.card) : undefined
  record.actions.push({ p, action, ...(why?.length && { why }), ...(played && { card: played }) })
  const next = applyAction(state, p, action)
  if (next.phase === 'over') record.result = { winner: next.winner ?? null, rounds: next.round }
  return next
}

// The game rebuilt from its record: as it began, then after each action up to `upTo` (all of
// them when not given). `each` sees the game before each action is taken.
export function replay(
  record: GameRecord,
  defs: CardDef[],
  upTo = record.actions.length,
  each?: (state: GameState, step: Step, index: number) => void,
): GameState {
  let state = createGame({ seed: record.seed, defs, decks: record.decks })
  record.actions.slice(0, upTo).forEach((step, i) => {
    each?.(state, step, i)
    state = applyAction(state, step.p, step.action)
  })
  return state
}

// The card a player's card in the game is: in the hand, the resources or the discard pile
function instanceDef(state: GameState, p: PlayerId, id: string) {
  const side = state.players[p]
  return [...side.hand, ...side.discard, ...side.resources.map((r) => r.card)].find((c) => c.id === id)?.def
}

// A game as the stats count it: how it went, and each side's leader, base and cards, those in
// its deck and those it played, by name too (a card's name today may not be its name later)
export type SideSummary = {
  name: string
  // The deck played, as named where it was saved ("Random" for one made at random)
  deck: string
  seat: Seat['kind']
  leader: string
  base: string
  cards: Record<string, number>
  played: string[]
}
export type GameSummary = {
  status: 'playing' | 'finished' | 'conceded' | 'left'
  winner: PlayerId | 'draw' | null
  rounds: number
  sides: [SideSummary, SideSummary]
  names: Record<string, string>
}

export function summarize(record: GameRecord, state: GameState, options: { left?: boolean; decks?: [string, string] } = {}): GameSummary {
  const { left = false, decks = record.decks.map((d) => d.name) } = options
  const over = state.phase === 'over'
  const conceded = over && record.actions.at(-1)?.action.type === 'concede'
  const sides = record.decks.map((deck, p): SideSummary => {
    const cards: Record<string, number> = {}
    for (const id of deck.deck) cards[id] = (cards[id] ?? 0) + 1
    const played = [...new Set(record.actions.filter((s) => s.p === p && s.card).map((s) => s.card!))]
    return { name: deck.name, deck: decks[p], seat: record.players[p].kind, leader: deck.leader, base: deck.base, cards, played }
  }) as [SideSummary, SideSummary]
  const names: Record<string, string> = {}
  for (const deck of record.decks)
    for (const id of [deck.leader, deck.base, ...deck.deck]) {
      const d = state.defs[id]
      if (d) names[id] = d.subtitle ? `${d.name}, ${d.subtitle}` : d.name
    }
  return {
    status: over ? (conceded ? 'conceded' : 'finished') : left ? 'left' : 'playing',
    winner: over ? (state.winner ?? null) : null,
    rounds: state.round,
    sides,
    names,
  }
}
