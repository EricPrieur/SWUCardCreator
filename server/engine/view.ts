import { hpOf, legalActions, powerOf, waitingFor } from './game.ts'
import type { Action, CardDef, GameState, Inst, LogEntry, Phase, PlayerId, UnitState } from './types.ts'

// What one player is shown of the game: the open information, their own hand and resources,
// and only the size of everything hidden (the opponent's hand and resources, both decks)
export type SideView = {
  name: string
  leader: GameState['players'][0]['leader']
  base: GameState['players'][0]['base']
  deckCount: number
  // null for the opponent's hand
  hand: Inst[] | null
  handCount: number
  // Every card drawn this game
  drawn: number
  discard: Inst[]
  // card is null for the opponent's: resources are facedown
  resources: { card: Inst | null; exhausted: boolean }[]
  // With their power and HP as they are now, upgrades and all
  units: (UnitState & { power: number; hp: number })[]
}

export type PlayerView = {
  you: PlayerId
  round: number
  phase: Phase
  active: PlayerId
  initiative: PlayerId
  initiativeTaken: boolean
  winner: PlayerId | 'draw' | null
  waitingFor: PlayerId[]
  players: [SideView, SideView]
  log: LogEntry[]
  // What you may do now
  actions: Action[]
  // The cards named anywhere in this view
  defs: Record<string, CardDef>
}

export function viewFor(state: GameState, you: PlayerId): PlayerView {
  const players = state.players.map((player, p) => {
    const mine = p === you
    return {
      name: player.name,
      leader: { ...player.leader },
      base: { ...player.base },
      deckCount: player.deck.length,
      hand: mine ? player.hand.map((c) => ({ ...c })) : null,
      handCount: player.hand.length,
      drawn: player.drawn,
      discard: player.discard.map((c) => ({ ...c })),
      resources: player.resources.map((r) => ({ card: mine ? { ...r.card } : null, exhausted: r.exhausted })),
      units: structuredClone(player.units).map((u) => ({ ...u, power: powerOf(state, u), hp: hpOf(state, u) })),
    }
  }) as [SideView, SideView]

  const named = new Set<string>()
  for (const side of players) {
    named.add(side.leader.def)
    named.add(side.base.def)
    for (const c of [...(side.hand ?? []), ...side.discard]) named.add(c.def)
    for (const r of side.resources) if (r.card) named.add(r.card.def)
    for (const u of side.units) {
      named.add(u.def)
      for (const up of u.upgrades) named.add(up.def)
    }
  }

  return {
    you,
    round: state.round,
    phase: state.phase,
    active: state.active,
    initiative: state.initiative,
    initiativeTaken: state.initiativeTaken,
    winner: state.winner,
    waitingFor: waitingFor(state),
    players,
    log: state.log.slice(),
    actions: legalActions(state, you),
    defs: Object.fromEntries([...named].map((id) => [id, state.defs[id]])),
  }
}
