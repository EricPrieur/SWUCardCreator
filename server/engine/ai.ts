import { applyAction, hpOf, keywordsOf, legalActions, playCost, powerOf, waitingFor } from './game.ts'
import type { Action, CardDef, GameState, PlayerId, Prompt, UnitState } from './types.ts'

// The opponent to play against. Before the action phase it follows a few rules of thumb. In it,
// it looks ahead: each move it may make is played out on a copy of the game, the questions the
// move asks answered by rule of thumb (quickAnswer), and the board it leaves is scored
// (evaluate). Its best few moves are then played on with the opponent's best reply among what
// it can see. It makes the move that holds up best, and gives up the turn once no move gains
// anything. Its own questions are answered the way its moves are chosen first.
// `why`, if given, gets the moves it weighed in the action phase, best first, with what each
// gains: what a game's record keeps of its reasons.
// rank, when given, orders the moves worth making (those that gain enough) instead of their gain.
export type Weighed = { action: Action; gain: number; rank?: number }
export function chooseAction(state: GameState, p: PlayerId, why?: Weighed[]): Action | undefined {
  if (state.prompt) return state.prompt.player === p ? bestAnswer(state, p) : undefined
  // Pressure is judged on the board as it is, not on each move played out
  pressed[p] = underPressure(state, p)
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

  // A Spice token's ability only while it has more tokens than its cards will want: those in its
  // hand, all of them together (up to SPICE_KEPT), and, with a deck of cards that spend Spice, a
  // token kept for those still to come (none on a base that pays off for each token spent)
  const reserve = spicePays(state, p) ? 0 : deckPlan(state, p).spiceReserve
  const inHand = player.hand.reduce((sum, c) => sum + spiceFor(state, p, state.defs[c.def]), 0)
  const needed = Math.max(reserve, Math.min(SPICE_KEPT, inHand))
  const spice = new Set(player.spice.map((t) => t.id))
  // Taking the initiative ends its turn, so it is never a move among the others: it is what the
  // AI does once done (below). In danger itself, it plays its cards first: while it has resources
  // ready, the opponent can't count on the first attack next round (a bluff, too).
  const moves = actions.filter(
    (a) => a.type !== 'pass' && a.type !== 'initiative' && !(a.type === 'ability' && spice.has(a.source) && player.spice.length <= needed),
  )
  // But it claims at once when a single attack next round defeats the opponent's base: only the
  // first action of a round is sure to be its own. (Lethal that takes the whole board, the
  // opponent acting between the attacks, isn't worth its turn now.)
  const claim = actions.find((a) => a.type === 'initiative')
  if (claim && state.phase === 'action' && oneActionLethal(state, p) && !lethalNow(state, p)) {
    why?.push({ action: claim, gain: 0 })
    return claim
  }
  // Attacks before cards, and the base first when the units that can reach it this round have
  // the power for what it has left. What an attack opens up (a unit traded away) the replies
  // below still weigh, so a Sentinel played first to cover it can still come out ahead.
  const racing = lethalNow(state, p)
  const bias = (move: Action) =>
    move.type !== 'attack' ? 0 : ATTACK_FIRST + (racing && move.target === 'base' ? LETHAL_RACE + 0.1 * powerOf(state, state.players[p].units.find((u) => u.id === move.attacker)!) : 0)
  // Past its time budget, it judges the moves left without trying its later answers
  const start = performance.now()
  const tried = moves.map((move) => {
    const deep = performance.now() - start < BUDGET
    const after = outcome(state, p, move, p, deep)
    const single = after ? evaluate(after, p) : -Infinity
    return {
      move,
      after,
      single,
      best: Math.max(single, deep ? combo(state, p, move) : -Infinity, after ? awakened(after, p) : -Infinity) + leaderPlays(state, p, move, after) + searchPlays(state, p, move),
      // Kept apart, so a reason to wait (a negative) isn't lost below
      extra: timing(state, p, move, actions),
    }
  })
  // A move that wins is made at once: playing on first may look better, a win still in reach
  // next action, but the opponent acts in between, with the cards in their hand it doesn't see
  const win = tried.find((t) => t.after?.phase === 'over' && t.after.winner === p)
  if (win) {
    why?.push({ action: win.move, gain: Math.round((win.single - evaluate(state, p)) * 100) / 100 })
    return win.move
  }
  const ending = actions.find((a) => a.type === 'initiative') ?? { type: 'pass' }
  // Rather than end its turn with resources enough for a card ready and no card in hand it can
  // play, it digs for one with a Spice token it keeps, unless a card it can play this round or
  // the next will spend that token (a Sardaukar unit's additional cost)
  const dig = actions.find((a) => a.type === 'ability' && spice.has(a.source))
  const canPlay = actions.some((a) => a.type === 'play' && player.hand.some((c) => c.id === a.card))
  const ready = player.resources.filter((r) => !r.exhausted).length
  const digs = dig && !canPlay && ready >= DIG_READY && player.spice.length > spiceKept(state, p) && state.phase === 'action'
  const done: Action = digs ? dig : ending
  // Then its most promising moves again, each after the opponent's best reply, and passing
  // the same way, so as not to leave a unit open to an easy attack. A follow-up attack it
  // planned keeps its worth. Short of time, it goes by the first look.
  const promising = tried.filter((t) => t.after && t.best > -Infinity).sort((a, b) => b.best + b.extra - (a.best + a.extra)).slice(0, REPLY_WIDTH)
  if (promising.length && performance.now() - start < BUDGET) {
    // Doing nothing gives the opponent their turn as it is now. (Passing may end the phase,
    // but what they could do then, such as deploying their leader, they still will.)
    const stay = afterReply({ ...state, active: p === 0 ? 1 : 0 }, p)
    const weighed: Weighed[] = promising.map((t) => {
      const gain = afterReply(t.after!, p) + Math.max(0, t.best - t.single) + t.extra - stay
      return { action: t.move, gain: gain > MIN_GAIN ? gain + bias(t.move) : gain }
    })
    // Among the moves worth making, the order matters: each is played on to its next move too,
    // as long as time allows. A card in hand can still be played after an attack, but an
    // attack put off may be lost, its unit traded away first.
    // Short of time, none is ranked: they go by their gain.
    const worth = weighed.filter((w) => w.gain > MIN_GAIN)
    for (const w of worth.length > 1 ? worth : []) {
      if (performance.now() - start >= BUDGET * 2) {
        for (const x of worth) delete x.rank
        break
      }
      const t = promising.find((x) => x.move === w.action)!
      w.rank = afterReply(t.after!, p, (s) => Math.max(evaluate(s, p), followUp(s, p, needed))) + Math.max(0, t.best - t.single) + t.extra + bias(w.action)
    }
    return pick(weighed, done, why)
  }
  const now = evaluate(state, p)
  return pick(
    tried.map((t) => ({ action: t.move, gain: t.best + t.extra - now > MIN_GAIN ? t.best + t.extra - now + bias(t.move) : t.best + t.extra - now })),
    done,
    why,
  )
}

// A leader's action that plays a card (Shaddam IV's): it comes back each round, so a card played
// with it costs little more than the resources it takes. Worth this much more than the board shows.
const LEADER_PLAY = 1.5
function leaderPlays(state: GameState, p: PlayerId, move: Action, after: GameState | undefined) {
  if (move.type !== 'ability' || move.source !== 'leader' || !after) return 0
  return after.players[p].hand.length < state.players[p].hand.length ? LEADER_PLAY : 0
}

// The Sleeper Has Awakened: a friendly unit defeated, then played again from the discard pile for
// free and ready (or another of the same name: Paul Atreides). Worth what the board is once that
// play is made, a little less, the opponent acting between.
const AWAKEN_COST = 0.4
function awakened(after: GameState, p: PlayerId) {
  if (after.phase !== 'action') return -Infinity
  let best = -Infinity
  const again = { ...after, active: p }
  for (const play of legalActions(again, p)) {
    if (play.type !== 'play' || !play.awakened) continue
    try {
      best = Math.max(best, evaluate(settle(applyAction(again, p, play), p, false), p) - AWAKEN_COST)
    } catch {
      // a play the engine refuses
    }
  }
  return best
}

// When a card is worth playing, beyond what the board shows right after:
// - one that counts the enemy base's hits this phase (Fedaykin Strike Leader) waits while
//   attacks are left to make, so they count;
// - an upgrade goes on a sturdy unit, the leader unit above all (cards rarely remove it), not
//   one an enemy unit can attack and defeat, taking 2 cards for 1 (less so if it attacks now,
//   the upgrade paying off first); one that protects its unit (Litany Against Fear) is worth
//   more on a dear one
const HOLD_FOR_HITS = 2.5
const UPGRADE_ON_LEADER = 1
const PROTECT_PER_COST = 0.2
const UPGRADE_PER_HP = 0.1
const UPGRADE_AT_RISK = 1.5
// A leader that discards the top card of its deck for a unit side that uses units from the
// discard pile (Paul Atreides): a unit on top is fuel, worth discarding, unless it's the card the
// AI wants to draw (one it can play next round, near the top of its curve); but not at the cost
// of the initiative, while it's still there to take
const DISCARD_FUEL = 1
const DISCARD_WANTED = 1.5
function fuel(state: GameState, p: PlayerId, move: Action, actions: Action[]) {
  if (move.type !== 'ability' || move.source !== 'leader') return 0
  const player = state.players[p]
  const leader = state.defs[player.leader.def]
  if (player.leader.deployed || !/Discard the top card of your deck/.test(leader.text ?? '') || !/from your discard pile/.test(leader.backText ?? '')) return 0
  if (actions.some((a) => a.type === 'initiative')) return 0
  const top = player.deck[0] && state.defs[player.deck[0].def]
  if (!top) return 0
  const next = player.resources.length + 1
  if ((top.cost ?? 0) <= next && (top.cost ?? 0) >= next - 2) return -DISCARD_WANTED
  return top.type === 'unit' ? DISCARD_FUEL : 0
}

function timing(state: GameState, p: PlayerId, move: Action, actions: Action[]) {
  if (move.type === 'ability') return fuel(state, p, move, actions)
  if (move.type !== 'play') return 0
  const card = state.players[p].hand.find((c) => c.id === move.card)
  if (!card) return 0
  const d = state.defs[card.def]
  let worth = 0
  if (/for each time an enemy base was dealt damage this phase/.test(d.text ?? '') && actions.some((a) => a.type === 'attack')) worth -= HOLD_FOR_HITS
  const unit = d.type === 'upgrade' && move.attachTo ? state.players[p].units.find((u) => u.id === move.attachTo) : undefined
  if (unit) {
    if (unit.leader) worth += UPGRADE_ON_LEADER
    if (/can't be defeated by enemy card abilities/.test(d.text ?? '')) worth += PROTECT_PER_COST * (state.defs[unit.def].cost ?? 0)
    const left = hpOf(state, unit) - unit.damage + (d.hp ?? 0)
    worth += UPGRADE_PER_HP * left
    const foe = state.players[p === 0 ? 1 : 0]
    const threat = Math.max(0, ...foe.units.filter((u) => u.arena === unit.arena).map((u) => powerOf(state, u, true)))
    if (threat >= left) worth -= (UPGRADE_AT_RISK + 0.3 * (d.cost ?? 0)) * (unit.exhausted ? 1 : 0.5)
  }
  return worth
}

// A card that searches the deck for a kind of card (Thumper: a Creature card, and those cost 1
// less): the AI doesn't see its deck, so the search is worth no card to it. Worth a card found,
// more with none of that kind in hand, and more again as its resources near what the dearest of
// that kind costs (a Worm Rider on 6 with the Thumper's 1 less)
const SEARCH_WORTH = 1.5
const SEARCH_NONE_IN_HAND = 1.5
const SEARCH_SOON = 1
function searchPlays(state: GameState, p: PlayerId, move: Action) {
  if (move.type !== 'play') return 0
  const player = state.players[p]
  const card = player.hand.find((c) => c.id === move.card)
  if (!card) return 0
  const text = state.defs[card.def].text ?? ''
  const kind = text.match(/Search the top \d+ cards of your deck for an? \[\{?(\w+)\}?\] (?:card|unit)/)?.[1]
  if (!kind) return 0
  const ofKind = (c: { def: string }) => state.defs[c.def].traits?.includes(kind)
  const inHand = player.hand.filter((c) => c.id !== card.id && ofKind(c))
  const dearest = Math.max(0, ...[...player.deck, ...inHand].filter(ofKind).map((c) => state.defs[c.def].cost ?? 0))
  const less = /cost \[1\] less/.test(text) ? 1 : 0
  const have = player.resources.length
  const soon = dearest - less - have <= 2 && dearest - less >= have ? SEARCH_SOON : 0
  return (inHand.length ? 0 : SEARCH_WORTH + SEARCH_NONE_IN_HAND) + soon + (inHand.length && less ? SEARCH_WORTH * 0.5 : 0)
}

// The move that gains the most, if any gains enough; else it is done for now
function pick(weighed: Weighed[], done: Action, why?: Weighed[]) {
  const worth = (w: Weighed) => w.gain > MIN_GAIN
  weighed.sort((a, b) => Number(worth(b)) - Number(worth(a)) || (b.rank ?? b.gain) - (a.rank ?? a.gain) || b.gain - a.gain)
  why?.push(...weighed.filter((w) => w.gain > -Infinity).map((w) => ({ action: w.action, gain: Math.round(w.gain * 100) / 100 })))
  return weighed[0] && worth(weighed[0]) ? weighed[0].action : done
}

// How many of its moves it tries against the opponent's replies
const REPLY_WIDTH = 8

// The score for `me` once the opponent has made the reply that is worst for it, among what
// they can do without the cards in their hand, which the AI doesn't see: attack, use their
// leader, their units' and Spice tokens' abilities, pass. None when it isn't their turn.
// `judge` scores the game each reply leaves (by default, as it stands).
function afterReply(state: GameState, me: PlayerId, judge = (s: GameState) => evaluate(s, me)) {
  const foe = me === 0 ? 1 : 0
  if (state.phase !== 'action' || state.prompt || !waitingFor(state).includes(foe)) return judge(state)
  let worst = Infinity
  for (const reply of legalActions(state, foe)) {
    if (reply.type === 'play') continue
    const after = outcome(state, foe, reply, me, false)
    if (after) worst = Math.min(worst, judge(after))
  }
  return worst === Infinity ? judge(state) : worst
}

// The score after its best next move, judged at first look (the Spice tokens it keeps left
// alone); none when it isn't its turn
function followUp(state: GameState, me: PlayerId, keepSpice: number) {
  if (state.phase !== 'action' || state.prompt || !waitingFor(state).includes(me)) return -Infinity
  const player = state.players[me]
  const spice = new Set(player.spice.map((t) => t.id))
  let best = -Infinity
  for (const move of legalActions(state, me)) {
    if (move.type === 'pass' || move.type === 'initiative') continue
    if (move.type === 'ability' && spice.has(move.source) && player.spice.length <= keepSpice) continue
    const after = outcome(state, me, move, me, false)
    if (after) best = Math.max(best, evaluate(after, me))
  }
  return best
}

// How long a move may take to choose (ms) before it thinks less of the rest, so the page never
// stalls
const BUDGET = 250

// The deck analysis the AI makes once a game: how many of its cards cost what (what it pays,
// aspects it lacks counted), their average, and the resources it aims for: enough to deploy its
// leader and to play its dearest card when it comes
// spiceReserve: the Spice tokens it keeps for the cards in its deck that spend them
export type DeckPlan = { curve: number[]; average: number; leader: number; top: number; target: number; spiceReserve: number }
const plans = new WeakMap<object, [DeckPlan?, DeckPlan?]>()
// Costs from 0 to this, the dearer ones counted with it
// Which AI this is, kept with each game it plays, to tell its versions apart in the stats
export const AI_VERSION = '2026-11-13 race'

export const CURVE_TOP = 8

// The Spice tokens a card wants: its additional cost and those its text may spend for more
// (Sardaukar Legion's up to 2), or those its text alone may spend (Lasgun Volley's one, The
// Baron's Wrath's or Shaddam IV's any number, counted as three)
export function spiceWanted(d: CardDef) {
  const upTo = (d.text ?? '').match(/may defeat up to (\d+) friendly Spice tokens/i)
  if (d.spiceCost) return d.spiceCost + (upTo ? Number(upTo[1]) : 0)
  if (/defeat any number of friendly Spice tokens/i.test(d.text ?? '')) return 3
  const may = (d.text ?? '').match(/may defeat (a|\d+) friendly Spice tokens?/i)
  return may ? (/^\d+$/.test(may[1]) ? Number(may[1]) : 1) : 0
}
// The Spice tokens a card in its hand wants, with its leader: a unit that pays off when a Spice
// token is defeated (Tuek's Lighter readies) wants one more under a leader that may defeat one
// as the unit is played (Duke Leto Atreides), so a token is kept for it rather than dug with
function spiceFor(state: GameState, p: PlayerId, d: CardDef) {
  const player = state.players[p]
  const leader = state.defs[player.leader.def]
  const combo =
    d.type === 'unit' &&
    /\[When you defeat a friendly Spice token:\]/.test(d.text ?? '') &&
    !player.leader.deployed &&
    /When you play a unit:\][^\n]*defeat a friendly Spice token/.test(leader.text ?? '')
  return spiceWanted(d) + (combo ? 1 : 0)
}
// A Spice token on the board: a card dug for later, and more when its base pays off for each
// one spent (Castle Caladan's heal): a little more there, but less than spending it brings
const spicePays = (state: GameState, p: PlayerId) => /When you defeat a friendly Spice token/i.test(state.defs[state.players[p].base.def].text ?? '')
const spiceWorth = (state: GameState, p: PlayerId) => SPICE_WORTH + (spicePays(state, p) ? SPICE_BASE_BONUS : 0)
const SPICE_WORTH = 1
const SPICE_BASE_BONUS = 0.5
// A deck with this many cards that spend Spice keeps a token for them
const SPICE_SPENDERS = 4
// The most Spice tokens it keeps for the cards in its hand
const SPICE_KEPT = 3
// A Spice token kept for a card in its hand it can soon pay for: worth more than one to spend
const SPICE_KEPT_WORTH = 1.5
// What each resource is worth more, up to those its plan aims for (a resource sooner is a turn
// gained: CHOAM Dividend for one Spice token, three turns in)
const RAMP = 2.5
// What its resources are worth more than one each, by how much sooner each makes its plays.
// Up to its leader's deploy cost, while the leader isn't deployed, a resource is a turn gained
// for the leader and the curve, the first ones most (CHOAM Dividend on turn 2 is worth more than
// a 3-cost unit). Past that, still undeployed, a little toward its plan; deployed, only toward
// the dearest card in its hand. (Deploying needs the resources, so the worth they had before
// it is still counted after.)
const RAMP_EARLY = 10
const RAMP_EARLY_UPTO = 4
const RAMP_LEADER = 6
const RAMP_LATE = 1
function rampWorth(state: GameState, p: PlayerId) {
  const player = state.players[p]
  const plan = deckPlan(state, p)
  const have = player.resources.length
  const early = Math.min(have, RAMP_EARLY_UPTO, plan.leader)
  const toLeader = Math.min(have, plan.leader) - early
  const past = Math.max(0, have - plan.leader)
  const dearest = Math.max(0, ...player.hand.map((c) => playCost(state, p, state.defs[c.def])))
  const later = player.leader.deployed ? Math.min(past, Math.max(0, dearest - plan.leader)) * RAMP_LATE : Math.min(past, Math.max(0, plan.target - plan.leader)) * RAMP
  return early * RAMP_EARLY + toLeader * (pressed[p] ? RAMP : RAMP_LEADER) + later
}
// Under pressure: the opponent's units outpower its own by this much, or its base is down to
// half its health. Ramping further then gives up the board, so only the first ramp counts in full.
const PRESSURE_POWER = 3
const pressed: Record<PlayerId, boolean> = { 0: false, 1: false }
function underPressure(state: GameState, p: PlayerId) {
  const foe = p === 0 ? 1 : 0
  const power = (q: PlayerId) => state.players[q].units.reduce((sum, u) => sum + powerOf(state, u), 0)
  const base = state.players[p].base
  const hp = state.defs[base.def].hp
  return power(foe) - power(p) >= PRESSURE_POWER || base.damage * 2 >= hp
}
// It digs with a Spice token it keeps only with this many resources ready, for the card it finds
const DIG_READY = 2
// The Spice tokens it keeps for the cards in its hand it can pay for this round or the next
function spiceKept(state: GameState, p: PlayerId) {
  const player = state.players[p]
  const soon = player.resources.length + 1
  const wanted = player.hand.reduce((sum, c) => sum + (playCost(state, p, state.defs[c.def]) <= soon ? spiceFor(state, p, state.defs[c.def]) : 0), 0)
  return Math.min(SPICE_KEPT, wanted)
}

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
  const spenders = cards.filter((d) => spiceWanted(d) > 0).length
  const plan = {
    curve,
    average: costs.reduce((a, b) => a + b, 0) / (costs.length || 1),
    leader,
    top,
    target: Math.min(9, Math.max(leader, top)),
    spiceReserve: spenders >= SPICE_SPENDERS ? 1 : 0,
  }
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
    // A card that ramps (CHOAM Dividend) once its leader is deployed: a resource and no more
    const d = state.defs[player.hand.find((c) => c.id === id)!.def]
    if (player.leader.deployed && /put this event into play as a resource/i.test(d.text ?? '')) return 4000
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
  const after = outcome(state, p, move, me, deep)
  return after ? evaluate(after, me) : -Infinity
}

// The game after a move and the questions it asks, or nothing for a move the engine refuses
function outcome(state: GameState, p: PlayerId, move: Action, me: PlayerId, deep: boolean): GameState | undefined {
  try {
    return settle(applyAction(lean(state), p, move), me, deep)
  } catch {
    return undefined
  }
}

// An attack on a unit that only pays off once other attacks finish it (a Sentinel no one unit
// can defeat): played on, its other units attacking it in turn, the best each time, as long as
// it stands. Each attack after the first counts a little less, the opponent acting between.
const COMBO_COST = 0.4
function combo(state: GameState, p: PlayerId, move: Action): number {
  if (move.type !== 'attack' || move.target === 'base') return -Infinity
  try {
    let game = settle(applyAction(lean(state), p, move), p, false)
    let best = -Infinity
    for (let step = 1; step <= 2; step++) {
      if (game.phase !== 'action' || !game.players[p === 0 ? 1 : 0].units.some((u) => u.id === move.target)) break
      const again = { ...game, active: p }
      let next: GameState | undefined
      let nextScore = -Infinity
      for (const attack of legalActions(again, p)) {
        if (attack.type !== 'attack' || attack.target !== move.target) continue
        try {
          const after = settle(applyAction(again, p, attack), p, false)
          const score = evaluate(after, p)
          if (score > nextScore) [next, nextScore] = [after, score]
        } catch {
          // a follow-up the engine refuses
        }
      }
      if (!next) break
      game = next
      best = Math.max(best, nextScore - COMBO_COST * step)
    }
    return best
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
// which. A game won or lost still counts the board, so with every move losing it still makes
// the one that does the most, in case the opponent doesn't see their win.
// The race: each side's damage a round against what the other's base has left. Removing an
// attacker slows their clock, base damage speeds up its own. Tested 2026-11-13 on 210 games
// each: Mohiam 44% to 50%, Paul 44% to 53% (a beatdown/control role on top did worse).
const RACE = 20
function raceRate(state: GameState, p: PlayerId) {
  const foe = state.players[p === 0 ? 1 : 0]
  const left = Math.max(1, state.defs[foe.base.def].hp - foe.base.damage)
  let power = 0
  for (const unit of state.players[p].units) {
    if (state.doomed.includes(unit.id)) continue
    power += (powerOf(state, unit) + (keywordsOf(state, unit).raid ?? 0)) * (blocked(state, p, unit) ? 0.5 : 1)
  }
  return power / left
}

export function evaluate(state: GameState, p: PlayerId) {
  const board = side(state, p, true) - side(state, p === 0 ? 1 : 0) + RACE * (raceRate(state, p) - raceRate(state, p === 0 ? 1 : 0))
  if (state.phase === 'over') return state.winner === p ? 1000 + board : state.winner === 'draw' ? board : -1000 + board
  return board
}

// own: the side of the player judging, whose hand and deck it knows: its Spice tokens kept for the
// cards in its hand it can soon pay for, and its resources short of its plan, count for more
function side(state: GameState, p: PlayerId, own = false) {
  const player = state.players[p]
  // The base's health left, each point dearer as it runs out
  const left = Math.max(0, state.defs[player.base.def].hp - player.base.damage)
  let score = left + Math.max(0, 10 - left) * 0.6
  // A unit taken until the regroup phase (Seduction) goes back to its owner: it counts on its
  // owner's side, so trading it away costs the taker nothing (what it does before then, its
  // attacks, the board shows)
  const borrowed = new Set(state.borrowed.map((b) => b.unit))
  for (const unit of player.units) if (!borrowed.has(unit.id)) score += unitWorth(state, unit, blocked(state, p, unit))
  for (const unit of state.players[p === 0 ? 1 : 0].units) if (borrowed.has(unit.id) && unit.owner === p) score += unitWorth(state, unit, false)
  const kept = own ? Math.min(player.spice.length, spiceKept(state, p)) : 0
  score +=
    player.hand.length * 1.5 +
    player.resources.length +
    (own ? rampWorth(state, p) : 0) +
    kept * SPICE_KEPT_WORTH +
    (player.spice.length - kept) * spiceWorth(state, p)
  // A Fortification keeps giving while its base stands
  score += (player.base.upgrades?.length ?? 0) * 1.5
  if (state.initiative === p) score += 0.5
  // Next round's first action goes to whoever has the initiative: in danger, that matters most
  if (inDanger(state, p)) score -= state.initiative === p ? DANGER_FIRST : DANGER
  return score
}

// One attack next round defeats the opponent's base: a unit not held off by a Sentinel, with its
// Raid, and what its leader adds to that same attack ("Then, attack with it. It gets [+1/+0]…,
// or [+2/+0] instead if it's a [{Harkonnen}] unit", on either side), but nothing a second action
// would add
function oneActionLethal(state: GameState, p: PlayerId) {
  const player = state.players[p]
  const foe = state.players[p === 0 ? 1 : 0]
  const left = state.defs[foe.base.def].hp - foe.base.damage
  const leader = state.defs[player.leader.def]
  const text = (player.leader.deployed ? leader.backText : leader.text) ?? ''
  // Only a boost sure to come with the attack (Paul's needs a cost to match; Irulan's is in the power)
  const sure = /Then, attack with it\.|When another friendly unit attacks:/.test(text)
  const boost = sure && text.match(/\[\+(\d+)\/\+0\](?:[^.]*?, or \[\+(\d+)\/\+0\] instead if it's a \[\{(\w+)\}\] unit)?/)
  return player.units.some((unit) => {
    if (blocked(state, p, unit)) return false
    let power = powerOf(state, unit) + (keywordsOf(state, unit).raid ?? 0)
    if (boost && !(unit.leader && player.leader.deployed)) power += boost[3] && state.defs[unit.def].traits?.includes(boost[3]) ? Number(boost[2]) : Number(boost[1])
    return power >= left
  })
}
// Attacks come before cards by this much, and base attacks this much more when racing for the win
const ATTACK_FIRST = 0.5
const LETHAL_RACE = 4
// Lethal this round: the units that can attack the opponent's base now have the power (Raid
// counted) for what it has left
function lethalNow(state: GameState, p: PlayerId) {
  if (state.phase !== 'action') return false
  const foe = state.players[p === 0 ? 1 : 0]
  const left = state.defs[foe.base.def].hp - foe.base.damage
  let power = 0
  for (const unit of state.players[p].units) {
    if (unit.exhausted || blocked(state, p, unit)) continue
    power += powerOf(state, unit) + (keywordsOf(state, unit).raid ?? 0)
  }
  return power >= left
}

// In danger: the opponent's units, readied next round, have the power to defeat this player's
// base (what this player's Sentinels hold off left out, Raid counted)
const DANGER = 10
const DANGER_FIRST = 1
function inDanger(state: GameState, p: PlayerId) {
  if (state.phase !== 'action') return false
  const foe = p === 0 ? 1 : 0
  const left = state.defs[state.players[p].base.def].hp - state.players[p].base.damage
  let power = 0
  for (const unit of state.players[foe].units) {
    if (state.doomed.includes(unit.id) || state.held?.includes(unit.id) || blocked(state, foe, unit)) continue
    power += powerOf(state, unit) + (keywordsOf(state, unit).raid ?? 0)
  }
  return power >= left
}

// Whether an enemy Sentinel stands in a unit's arena: its power can't reach the base until the
// Sentinel is gone
function blocked(state: GameState, p: PlayerId, unit: UnitState) {
  const foe = state.players[p === 0 ? 1 : 0]
  return foe.units.some((u) => u.arena === unit.arena && keywordsOf(state, u).sentinel)
}

// A unit by its power (less while a Sentinel blocks it), the health it has left, its keywords
// and what it cost; less when it will soon be gone (defeated, or back to its owner, at the
// regroup phase)
function unitWorth(state: GameState, unit: UnitState, isBlocked = false) {
  const keywords = keywordsOf(state, unit)
  const card = state.defs[unit.def]
  let worth =
    1 +
    (isBlocked ? 0.4 : 0.7) * powerOf(state, unit) +
    0.25 * (unit.leader ? 0 : card.cost) +
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

// The cards of a hand in the order to give them up (discard, put away): it keeps the best card
// it can play now and the best it can play next round, so a discard on turn 1 doesn't take its
// only early play. Of the rest, the cheapest goes first: a big card is still to come, a small
// one has had its moment. Its kept cards go last, the one for next round before the one for now.
function discardOrder(state: GameState, p: PlayerId, ids: string[]) {
  const player = state.players[p]
  const now = player.resources.filter((r) => !r.exhausted).length
  const next = player.resources.length + 1
  const cost = (id: string) => {
    const card = player.hand.find((c) => c.id === id)
    return card ? playCost(state, p, state.defs[card.def]) : Infinity
  }
  const dearestUpTo = (most: number, not?: string) =>
    ids.filter((id) => id !== not && cost(id) <= most).sort((a, b) => cost(b) - cost(a))[0]
  const keepNow = dearestUpTo(now)
  const keepNext = dearestUpTo(next, keepNow)
  const kept = [keepNext, keepNow].filter((id): id is string => id !== undefined)
  const rest = ids.filter((id) => !kept.includes(id)).sort((a, b) => cost(a) - cost(b))
  return [...rest, ...kept]
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
  else if (prompt.ai === 'discard') ranked = discardOrder(state, p, ids)
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
