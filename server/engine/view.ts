import { abilityLabel, hpOf, keywordsOf, legalActions, powerOf, waitingFor } from './game.ts'
import { scriptStatus } from './scripts.ts'
import type { Action, CardDef, GameState, Inst, Keywords, LogEntry, Phase, PlayerId, Prompt, UnitState } from './types.ts'

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
  // With their power, HP and keywords as they are now, upgrades and all
  units: (UnitState & { power: number; hp: number; keywords: Keywords })[]
  spice: Inst[]
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
  // A question an ability asks you, in full; one it asks your opponent, without its choices
  prompt: Prompt | { player: PlayerId; text: string } | null
  players: [SideView, SideView]
  log: LogEntry[]
  // What you may do now
  actions: Action[]
  // The Action abilities among them, with what each says
  abilities: { source: string; index: number; label: string }[]
  // The cards named anywhere in this view, and whether each one's text does anything yet
  defs: Record<string, CardDef & { script: ReturnType<typeof scriptStatus> }>
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
      units: player.units.map((u) => ({ ...structuredClone(u), power: powerOf(state, u), hp: hpOf(state, u), keywords: keywordsOf(state, u) })),
      spice: player.spice.map((t) => ({ ...t })),
    }
  }) as [SideView, SideView]

  const prompt = state.prompt
  const asked = prompt && prompt.player === you ? prompt : prompt && { player: prompt.player, text: prompt.text }

  const named = new Set<string>()
  if (asked && 'options' in asked) for (const option of asked.options) if (option.def) named.add(option.def)
  if (asked && 'source' in asked && asked.source) named.add(asked.source)
  if (asked && 'card' in asked && asked.card) named.add(asked.card)
  for (const side of players) {
    named.add(side.leader.def)
    named.add(side.base.def)
    for (const c of [...(side.hand ?? []), ...side.discard, ...side.spice]) named.add(c.def)
    for (const r of side.resources) if (r.card) named.add(r.card.def)
    for (const u of side.units) {
      named.add(u.def)
      for (const up of u.upgrades) named.add(up.def)
    }
  }

  const actions = legalActions(state, you)
  return {
    you,
    round: state.round,
    phase: state.phase,
    active: state.active,
    initiative: state.initiative,
    initiativeTaken: state.initiativeTaken,
    winner: state.winner,
    waitingFor: waitingFor(state),
    prompt: asked,
    players,
    log: state.log.slice(),
    actions,
    abilities: actions.flatMap((a) =>
      a.type === 'ability' ? [{ source: a.source, index: a.index, label: abilityLabel(state, you, a.source, a.index) }] : [],
    ),
    defs: Object.fromEntries([...named].map((id) => [id, { ...state.defs[id], script: scriptStatus(state.defs[id]) }])),
  }
}
