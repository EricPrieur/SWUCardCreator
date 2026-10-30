// Actions put in words, for the game tools and the Admin panel's games
import type { Action, GameState, PlayerId } from './types.ts'

// What a card id in a game is: its name
export function nameIn(state: GameState, id: string): string {
  if (id === 'base' || id === 'base0' || id === 'base1') return id === 'base' ? 'the base' : `${state.players[Number(id.slice(4))].name}'s base`
  for (const player of state.players) {
    const cards = [
      ...player.units,
      ...player.hand,
      ...player.deck,
      ...player.discard,
      ...player.spice,
      ...player.resources.map((r) => r.card),
      ...player.units.flatMap((u) => u.upgrades),
      ...(player.base.upgrades ?? []),
    ]
    const card = cards.find((c) => c.id === id)
    if (card) return state.defs[card.def].name
  }
  if (id === 'leader') return 'leader'
  return id
}

// An action in words, as the player taking it would say it
export function describe(state: GameState, p: PlayerId, action: Action): string {
  switch (action.type) {
    case 'attack':
      return `attack ${action.target === 'base' ? 'the base' : nameIn(state, action.target)} with ${nameIn(state, action.attacker)}`
    case 'play': {
      const how = [action.smuggle && 'using Smuggle', action.discard && 'from the discard pile', action.spice && 'for a Spice token'].filter(Boolean)
      const onto = action.attachTo ? ` on ${nameIn(state, action.attachTo)}` : ''
      return `play ${nameIn(state, action.card)}${onto}${how.length ? ` (${how.join(', ')})` : ''}`
    }
    case 'ability':
      return `use ${action.source === 'leader' ? `${state.defs[state.players[p].leader.def].name} (leader)` : nameIn(state, action.source)}'s ability ${action.index + 1}`
    case 'answer': {
      const prompt = state.prompt
      const labels = action.picks.map((id) => prompt?.options.find((o) => o.id === id)?.label ?? nameIn(state, id))
      return `answer "${prompt?.text ?? '?'}": ${labels.join(', ') || 'nothing'}`
    }
    case 'resource':
      return action.cards.length ? `resource ${action.cards.map((id) => nameIn(state, id)).join(', ')}` : 'resource nothing'
    case 'mulligan':
      return action.take ? 'mulligan' : 'keep the hand'
    case 'first':
      return action.goFirst ? 'go first' : 'go second'
    default:
      return action.type
  }
}
