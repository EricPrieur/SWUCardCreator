import { hpOf, legalActions, playCost, powerOf, smuggleCost } from './game.ts'
import type { Action, GameState, PlayerId, Prompt, UnitState } from './types.ts'

// A first opponent to play against: it looks only at what its player could see, plays its
// best card, makes the trades that favour it and otherwise hits the base. It reads the
// printed values only, as the engine does.
export function chooseAction(state: GameState, p: PlayerId): Action | undefined {
  if (state.prompt) return state.prompt.player === p ? answer(state, p) : undefined
  const actions = legalActions(state, p)
  if (!actions.length) return undefined
  const player = state.players[p]
  // A card it may play: in its hand, among its resources with Smuggle, in its discard pile
  const cards = [...player.hand, ...player.resources.map((r) => r.card), ...player.discard]
  const defOf = (id: string) => state.defs[cards.find((c) => c.id === id)?.def ?? '']
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
  const price = (a: Action) =>
    a.type !== 'play' || a.spice ? 0 : a.smuggle ? smuggleCost(state, p, defOf(a.card)) : playCost(state, p, defOf(a.card))
  const units = plays.filter((a) => !a.attachTo).sort((a, b) => price(b) - price(a))
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

  // A leader's or a unit's Action ability, before giving up the turn; a Spice token's only while
  // it has more than the cards in its hand will cost
  const needed = Math.max(0, ...player.hand.map((c) => state.defs[c.def].spiceCost ?? 0))
  const spice = new Set(player.spice.map((t) => t.id))
  const ability = actions.find((a) => a.type === 'ability' && (!spice.has(a.source) || player.spice.length > needed))
  if (ability) return ability

  return actions.find((a) => a.type === 'initiative') ?? { type: 'pass' }
}

// Answering an ability's question, as its script hints: 'harm' picks what hurts the opponent
// most, 'help' what helps itself, 'cheap' its cheapest cards, 'best' the dearest card it can
// soon pay for, an option's id that option, 'none' nothing. Anything else picks as little as it
// may.
function answer(state: GameState, p: PlayerId): Action {
  const prompt = state.prompt as Prompt
  const ids = prompt.options.map((o) => o.id)
  if (prompt.kind === 'option') {
    return { type: 'answer', picks: [ids.includes(prompt.ai ?? '') ? (prompt.ai as string) : ids[0]] }
  }
  if (ids.includes(prompt.ai ?? '')) return { type: 'answer', picks: [prompt.ai as string] }
  if (prompt.ai === 'none') return { type: 'answer', picks: ids.slice(0, prompt.min) }
  const foe = p === 0 ? 1 : 0
  const unit = (id: string) => [...state.players[0].units, ...state.players[1].units].find((u) => u.id === id)
  const mine = (id: string) => {
    const u = unit(id)
    if (u) return state.players[p].units.includes(u)
    if (id === `base${p}`) return true
    if (id === `base${foe}`) return false
    return [...state.players[p].hand, ...state.players[p].deck, ...state.players[p].discard].some((c) => c.id === id)
  }
  // How much a pick is worth to the AI: an enemy unit by its cost, a leader as much as a big
  // unit, the enemy base a little; its own things the other way round
  const worth = (id: string) => {
    const u = unit(id)
    const value = u ? (u.leader ? 6 : state.defs[u.def].cost) + 1 : id.startsWith('base') ? 2 : 1
    return mine(id) ? -value : value
  }
  const cardCost = (id: string) => {
    const option = prompt.options.find((o) => o.id === id)
    return option?.def ? state.defs[option.def].cost : 0
  }
  let ranked: string[] = []
  if (prompt.ai === 'harm') ranked = ids.filter((id) => worth(id) > 0).sort((a, b) => worth(b) - worth(a))
  else if (prompt.ai === 'help') ranked = ids.filter((id) => worth(id) < 0).sort((a, b) => worth(a) - worth(b))
  else if (prompt.ai === 'cheap') ranked = [...ids].sort((a, b) => cardCost(a) - cardCost(b))
  else if (prompt.ai === 'best') {
    const soon = state.players[p].resources.length + 1
    ranked = [...ids].sort((a, b) => {
      const [x, y] = [cardCost(a), cardCost(b)]
      return x <= soon && y <= soon ? y - x : x <= soon ? -1 : y <= soon ? 1 : x - y
    })
  }
  // Short of picks it likes, it takes what it must from the rest
  const rest = ids.filter((id) => !ranked.includes(id))
  const wanted = prompt.ai === 'harm' || prompt.ai === 'help' ? Math.min(prompt.max, ranked.length) : prompt.ai === 'best' ? 1 : prompt.min
  const picks = [...ranked, ...rest].slice(0, Math.max(prompt.min, wanted))
  return { type: 'answer', picks }
}
