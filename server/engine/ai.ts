import { applyAction, hpOf, keywordsOf, legalActions, playCost, powerOf } from './game.ts'
import type { Action, GameState, PlayerId, Prompt, UnitState } from './types.ts'

// The opponent to play against. Before the action phase it follows a few rules of thumb. In it,
// it looks one move ahead: each move it may make is played out on a copy of the game, the
// questions the move asks answered by rule of thumb (quickAnswer), and the board it leaves is
// scored (evaluate). It makes the move that scores best, and gives up the turn once no move
// gains anything. Its own questions are answered the same way.
export function chooseAction(state: GameState, p: PlayerId): Action | undefined {
  if (state.prompt) return state.prompt.player === p ? bestAnswer(state, p) : undefined
  const actions = legalActions(state, p)
  if (!actions.length) return undefined
  const player = state.players[p]

  switch (state.phase) {
    // Going first is nearly always better: the first action, and the initiative to keep
    case 'first':
      return { type: 'first', goFirst: true }
    // Keep a hand that has something cheap to play
    case 'mulligan': {
      const cheap = player.hand.some((c) => state.defs[c.def].type === 'unit' && state.defs[c.def].cost <= 3)
      return { type: 'mulligan', take: !cheap }
    }
    // Resources as its deck analysis plans: toward what its leader and its dearest cards need
    case 'resource':
      return { type: 'resource', cards: resourcePicks(state, p, 2) }
    case 'regroup': {
      const plan = deckPlan(state, p)
      const have = player.resources.length
      // Short of its leader's cost, any card goes; short of the plan, it keeps a card to play
      const wanted = have < plan.leader ? player.hand.length >= 1 : have < plan.target && player.hand.length >= 2
      return { type: 'resource', cards: wanted ? resourcePicks(state, p, 1) : [] }
    }
  }

  // A Spice token's ability only while it has more tokens than the cards in its hand will cost
  const needed = Math.max(0, ...player.hand.map((c) => state.defs[c.def].spiceCost ?? 0))
  const spice = new Set(player.spice.map((t) => t.id))
  const moves = actions.filter(
    (a) =>
      a.type !== 'pass' &&
      a.type !== 'initiative' &&
      !(a.type === 'ability' && spice.has(a.source) && player.spice.length <= needed),
  )
  const now = evaluate(state, p)
  let best: Action | undefined
  let bestGain = MIN_GAIN
  // Past its time budget, it judges the moves left without trying its later answers
  const start = performance.now()
  for (const move of moves) {
    const gain = scoreOf(state, p, move, p, performance.now() - start < BUDGET) - now
    if (gain > bestGain) [best, bestGain] = [move, gain]
  }
  if (best) return best
  return actions.find((a) => a.type === 'initiative') ?? { type: 'pass' }
}

// How long a move may take to choose (ms) before it thinks less of the rest, so the page never
// stalls
const BUDGET = 250

// The deck analysis the AI makes once a game: how many of its cards cost what (what it pays,
// aspects it lacks counted), their average, and the resources it aims for: enough to deploy its
// leader and to play its dearest card when it comes
export type DeckPlan = { curve: number[]; average: number; leader: number; top: number; target: number }
const plans = new WeakMap<object, [DeckPlan?, DeckPlan?]>()
// Costs from 0 to this, the dearer ones counted with it
export const CURVE_TOP = 8

export function deckPlan(state: GameState, p: PlayerId): DeckPlan {
  const known = plans.get(state.defs) ?? []
  if (known[p]) return known[p]
  const player = state.players[p]
  const cards = [...player.deck, ...player.hand, ...player.discard, ...player.resources.map((r) => r.card), ...player.units]
    .map((c) => state.defs[c.def])
    .filter((d) => !d.token && d.type !== 'leader')
  const costs = cards.map((d) => playCost(state, p, d))
  const curve = Array.from({ length: CURVE_TOP + 1 }, (_, i) => costs.filter((c) => Math.min(c, CURVE_TOP) === i).length)
  const leader = state.defs[player.leader.def].cost
  const top = Math.max(0, ...costs)
  // Past 9 resources a game is nearly always decided
  const plan = { curve, average: costs.reduce((a, b) => a + b, 0) / (costs.length || 1), leader, top, target: Math.min(9, Math.max(leader, top)) }
  known[p] = plan
  plans.set(state.defs, known)
  return plan
}

// The cards it resources: first those it can't play before the plan's target, then those it
// can't play soon unless they are its dearest (kept for later), then its cheapest, which matter
// least once the game goes on
function resourcePicks(state: GameState, p: PlayerId, count: number) {
  const player = state.players[p]
  const plan = deckPlan(state, p)
  const soon = player.resources.length + 2
  const price = (id: string) => playCost(state, p, state.defs[player.hand.find((c) => c.id === id)!.def])
  const rank = (id: string) => {
    const cost = price(id)
    if (cost > plan.target) return 3000 + cost
    if (cost > soon && cost < plan.target - 1) return 2000 + cost
    if (cost <= soon) return 1000 - cost
    return cost
  }
  return player.hand
    .map((c) => c.id)
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, count)
}

// A move worth making gains at least this much: less, and it keeps its cards for later
const MIN_GAIN = 0.25

// The score for `me` of the game after a move, played out to its end on a copy of the game; a
// move the engine refuses scores nothing. Its own questions on the way are each tried (once:
// those they lead to are answered by rule of thumb), the opponent's answered by rule of thumb.
function scoreOf(state: GameState, p: PlayerId, move: Action, me: PlayerId, deep = true): number {
  try {
    return evaluate(settle(applyAction(lean(state), p, move), me, deep), me)
  } catch {
    return -Infinity
  }
}

// The game without its log, which the copies the AI plays out don't need
const lean = (state: GameState): GameState => ({ ...state, log: [] })

// The questions a move asks, answered until it is done: the AI's own each by trying its
// answers, when `deep`, else by rule of thumb
function settle(state: GameState, me: PlayerId, deep: boolean) {
  for (let i = 0; i < 40 && state.prompt && state.phase !== 'over'; i++) {
    const who = state.prompt.player
    state = applyAction(state, who, deep && who === me ? bestAnswer(state, who, false) : quickAnswer(state, who))
  }
  return state
}

// Its own question: each answer played out and scored. The rule of thumb's answer stands
// unless another scores clearly better, as answers that change nothing on the board (which
// card to discard, say) score alike.
function bestAnswer(state: GameState, p: PlayerId, deep = true): Action {
  const quick = quickAnswer(state, p)
  const answers = legalActions(state, p)
  // Inside a move played out, only a short list of answers is worth trying
  if (answers.length < 2 || answers.length > (deep ? 40 : 10)) return quick
  let best = quick
  let bestScore = scoreOf(state, p, quick, p, deep) + 0.01
  for (const answer of answers) {
    const score = scoreOf(state, p, answer, p, deep)
    if (score > bestScore) [best, bestScore] = [answer, score]
  }
  return best
}

// How good a game is for a player: the win, else what each side has, theirs taken from
// its own. It counts only what both players can see: how many cards are in a hand, not
// which.
export function evaluate(state: GameState, p: PlayerId) {
  if (state.phase === 'over') return state.winner === p ? 1000 : state.winner === 'draw' ? 0 : -1000
  return side(state, p) - side(state, p === 0 ? 1 : 0)
}

function side(state: GameState, p: PlayerId) {
  const player = state.players[p]
  // The base's health left, each point dearer as it runs out
  const left = Math.max(0, state.defs[player.base.def].hp - player.base.damage)
  let score = left + Math.max(0, 10 - left) * 0.6
  for (const unit of player.units) score += unitWorth(state, unit)
  score += player.hand.length * 1.5 + player.resources.length + player.spice.length
  // A Fortification keeps giving while its base stands
  score += (player.base.upgrades?.length ?? 0) * 1.5
  if (state.initiative === p) score += 0.5
  return score
}

// A unit by its power, the health it has left and its keywords; less when it will soon be
// gone (defeated, or back to its owner, at the regroup phase)
function unitWorth(state: GameState, unit: UnitState) {
  const keywords = keywordsOf(state, unit)
  let worth =
    1 +
    0.7 * powerOf(state, unit) +
    0.5 * Math.max(0, hpOf(state, unit) - unit.damage) +
    (keywords.sentinel ? 1 : 0) +
    (keywords.overwhelm || keywords.saboteur || keywords.grit ? 0.5 : 0) +
    0.3 * (keywords.raid ?? 0) +
    0.5 * (keywords.restore ?? 0) +
    unit.upgrades.filter((u) => state.defs[u.def].name === 'Shield').length * 1.5 +
    (unit.leader ? 2 : 0)
  // Ready, it may still attack this phase
  if (unit.exhausted) worth -= 0.2
  if (state.doomed.includes(unit.id)) worth *= 0.2
  else if (state.borrowed.some((b) => b.unit === unit.id)) worth *= 0.5
  return worth
}

// Answering an ability's question, as its script hints: 'harm' picks what hurts the opponent
// most, 'help' what helps itself, 'cheap' its cheapest cards, 'best' the dearest card it can
// soon pay for, an option's id that option, 'none' nothing. Anything else picks as little as it
// may.
function quickAnswer(state: GameState, p: PlayerId): Action {
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
  // How much a pick is worth to the AI: an enemy unit by its worth on the board, the enemy base
  // a little; its own things the other way round
  const worth = (id: string) => {
    const u = unit(id)
    const value = u ? unitWorth(state, u) : id.startsWith('base') ? 2 : 1
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
