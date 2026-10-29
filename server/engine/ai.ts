import { hpOf, legalActions, playCost, powerOf } from './game.ts'
import type { Action, GameState, PlayerId, UnitState } from './types.ts'

// A first opponent to play against: it looks only at what its player could see, plays its
// best card, makes the trades that favour it and otherwise hits the base. It reads the
// printed values only, as the engine does.
export function chooseAction(state: GameState, p: PlayerId): Action | undefined {
  const actions = legalActions(state, p)
  if (!actions.length) return undefined
  const player = state.players[p]
  const defOf = (id: string) => state.defs[player.hand.find((c) => c.id === id)?.def ?? '']
  const cost = (id: string) => defOf(id)?.cost ?? 0

  switch (state.phase) {
    // Going first is nearly always better: the first action, and the initiative to keep
    case 'first':
      return { type: 'first', goFirst: true }
    // Keep a hand that has something cheap to play
    case 'mulligan': {
      const cheap = player.hand.some((c) => state.defs[c.def].type === 'unit' && state.defs[c.def].cost <= 3)
      return { type: 'mulligan', take: !cheap }
    }
    // Resource the dearest cards, keeping the ones it can play soon
    case 'resource': {
      const cards = [...player.hand].sort((a, b) => cost(b.id) - cost(a.id)).slice(0, 2)
      return { type: 'resource', cards: cards.map((c) => c.id) }
    }
    case 'regroup': {
      const dearest = [...player.hand].sort((a, b) => cost(b.id) - cost(a.id))[0]
      const enough = player.resources.length >= 8 || player.hand.length < 2
      return { type: 'resource', cards: dearest && !enough ? [dearest.id] : [] }
    }
  }

  if (actions.some((a) => a.type === 'deploy')) return { type: 'deploy' }

  // The dearest unit it can pay for; an upgrade on its strongest unit
  const plays = actions.filter((a) => a.type === 'play')
  const own = new Set(player.units.map((u) => u.id))
  const units = plays
    .filter((a) => !a.attachTo)
    .sort((a, b) => playCost(state, p, defOf(b.card)) - playCost(state, p, defOf(a.card)))
  if (units.length) return units[0]
  const upgrades = plays.filter((a) => a.attachTo && own.has(a.attachTo))
  const strongest = (a: Action) =>
    a.type === 'play' && a.attachTo ? powerOf(state, player.units.find((u) => u.id === a.attachTo) as UnitState) : 0
  if (upgrades.length) return upgrades.sort((a, b) => strongest(b) - strongest(a))[0]

  // Attacks: defeat a unit and survive, then an even trade, then the base
  const enemy = state.players[p === 0 ? 1 : 0]
  const unitById = (id: string) => [...player.units, ...enemy.units].find((u) => u.id === id) as UnitState
  const left = (u: UnitState) => hpOf(state, u) - u.damage
  const score = (a: Action) => {
    if (a.type !== 'attack') return -1
    const attacker = unitById(a.attacker)
    const power = powerOf(state, attacker, true)
    if (a.target === 'base') return 10 + power
    const defender = unitById(a.target)
    const kills = power >= left(defender)
    const dies = powerOf(state, defender) >= left(attacker)
    const worth = defender.leader ? 8 : state.defs[defender.def].cost
    const mine = attacker.leader ? 8 : state.defs[attacker.def].cost
    if (kills && !dies) return 20 + worth
    if (kills && worth >= mine) return 15 + worth - mine
    return -1
  }
  const attacks = actions.filter((a) => score(a) >= 0).sort((a, b) => score(b) - score(a))
  if (attacks.length) return attacks[0]

  return actions.find((a) => a.type === 'initiative') ?? { type: 'pass' }
}
