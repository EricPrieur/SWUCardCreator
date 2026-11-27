import { applyAction, blanked, hpOf, keywordsOf, legalActions, playCost, powerOf, raceTarget, racesBase, traitsOf, waitingFor } from './game.ts'
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
    // Keep a hand with a unit to play on turn 1 (2 resources)
    case 'mulligan': {
      // Every deck wants a unit for turn 1, a slow one too, and mulligans a hand without one (the
      // user, 2026-11-26). Lando Calrissian too: a 1-cost unit and his Credit token, or a 2-cost unit.
      const turnOne = (c: { def: string }) => state.defs[c.def].type === 'unit' && playCost(state, p, state.defs[c.def]) <= 2
      // An aggro deck with many 1-cost units (Wicket's 14) wants two on turn 1: one alone, it
      // mulligans (the user, 2026-11-26)
      if (deckPlan(state, p).ones >= DOUBLE_ONE) {
        const ones = player.hand.filter((c) => state.defs[c.def].type === 'unit' && playCost(state, p, state.defs[c.def]) <= 1).length
        return { type: 'mulligan', take: ones < 2 }
      }
      return { type: 'mulligan', take: !player.hand.some(turnOne) && !vehicleCombo(state, p).length }
    }
    // Resources as its deck analysis plans: toward what its leader and its dearest cards need
    case 'resource':
      return { type: 'resource', cards: resourcePicks(state, p, 2) }
    case 'regroup': {
      const plan = deckPlan(state, p)
      const have = player.resources.length
      // Short of its leader's cost, any card goes; short of the plan, it keeps a card to play
      const wanted =
        (have < plan.leader ? player.hand.length >= 1 : have < plan.target && player.hand.length >= 2) ||
        // Past the plan, a full hand still goes on: two cards a round, not one and the rest left
        // (Kylo Ren held 6 cards on 6 resources against Veiled Icons Mace's 9, 2026-11-26)
        (have < MAX_RESOURCES && player.hand.length >= FULL_HAND) ||
        player.hand.some((c) => plotWanted(state, p, state.defs[c.def]) || smuggleWanted(state, p, state.defs[c.def]))
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
  // Its beatdown leader unit (Luke Skywalker) attacks only the base, or the Sentinel it must
  const raceTo = new Map<string, string>()
  for (const unit of player.units) {
    if (!racesBase(state, unit)) continue
    const targets = actions.flatMap((a) => (a.type === 'attack' && a.attacker === unit.id ? [a.target] : []))
    if (targets.length) raceTo.set(unit.id, raceTarget(state, targets))
  }
  const moves = actions.filter(
    (a) =>
      !(a.type === 'attack' && raceTo.has(a.attacker) && raceTo.get(a.attacker) !== a.target) &&
      a.type !== 'pass' &&
      a.type !== 'initiative' &&
      !(a.type === 'ability' && spice.has(a.source) && player.spice.length <= needed),
  )
  // But it claims at once when a single attack next round defeats the opponent's base: only the
  // first action of a round is sure to be its own. (Lethal that takes the whole board, the
  // opponent acting between the attacks, isn't worth its turn now.)
  const claim = actions.find((a) => a.type === 'initiative')
  // Not while the opponent's ready units can still defeat its base this round, a pump from their
  // hand counted: its cards and attacks first (Piett, 7 base left, claimed with Moff Gideon, a
  // Sentinel, in hand; Sabine Wren with Figure of Unity hit for exactly 7, 2026-11-26)
  if (claim && state.phase === 'action' && oneActionLethal(state, p) && !lethalNow(state, p) && !foeCanFinish(state, p)) {
    why?.push({ action: claim, gain: 0 })
    return claim
  }
  // Attacks before cards, and the base first when the units that can reach it this round have
  // the power for what it has left. What an attack opens up (a unit traded away) the replies
  // below still weigh, so a Sentinel played first to cover it can still come out ahead.
  const racing = lethalNow(state, p)
  // The control player makes its trades before it plays its cards
  const r = role(state, p)
  // A card that doesn't help this round's attacks waits for them, while a unit can still hit the
  // base: a unit with no Ambush or Support, removal with no enemy Sentinel to clear
  const baseOpen = actions.some((a) => a.type === 'attack' && a.target === 'base')
  const sentinelUp = state.players[p === 0 ? 1 : 0].units.some((u) => keywordsOf(state, u).sentinel)
  const waits = (move: Action) => {
    if (!baseOpen || move.type !== 'play') return false
    const card = player.hand.find((c) => c.id === move.card)
    if (!card) return false
    const d = state.defs[card.def]
    const text = d.text ?? ''
    if (/\[Support\]|\[Ambush\]|attack with/i.test(text) || d.keywords.ambush) return false
    if (stripsBigPlay(state, p, d)) return false
    if (feedWorth(state, p, d)) return false
    // A When Played that weakens every enemy unit this phase (Bo-Katan Kryze's -3/-3, -7/-0) makes
    // the attacks after it better: it goes first (the user's game, 2026-11-26: Lando attacked
    // with Ahsoka Tano and Kanan Jarrus into a full-size Kylo Ren, then played Bo-Katan)
    if (/give each enemy unit -\d+\/-?\d+ for this phase/i.test(text)) return false
    // Unless it defeats an enemy unit that can still attack this round: that one hits first
    // otherwise (the user's game 16, 2026-11-24: Nothing Left to Fear waited for two base attacks
    // while Tantive IV, ready, took Han Solo on board and hit for 5)
    if (REMOVAL.test(text)) return !sentinelUp && !killsReady.has(move)
    return d.type === 'unit'
  }
  const killsReady = new Set<Action>()
  // A leader deployed with a card in the resources that Plot plays to attack (Cinta Kaz with Luke
  // Skywalker) deploys after its other units' attacks: they hit first, then the leader with
  // Cinta's attack (the user, 2026-11-24)
  const plotAttack = !player.leader.deployed && player.resources.some((r) => state.defs[r.card.def].keywords.plot && /attack with a unit/i.test(state.defs[r.card.def].text ?? ''))
  // A deck led by a beatdown leader (Luke Skywalker) races: all its units go for the base, a
  // trade only when it is clearly better (the user, 2026-11-24)
  const leaderDef = state.defs[player.leader.def]
  const racingDeck = /\[Overwhelm\]/.test(leaderDef.backText ?? '') && /this unit gets \+\d+\/\+0 for this attack/.test(leaderDef.backText ?? '')
  const othersAttack = actions.some((a) => a.type === 'attack' && !player.units.find((u) => u.id === a.attacker)?.leader)
  // A fragile leader (Kylo Ren, 3 HP), or one with Plot cards to play, waits it out: its units'
  // attacks, then it deploys, the opponent left fewer actions to answer it (the user,
  // 2026-11-25). Any leader uses its leader side's ability first: it deploys ready all the same
  // (4.4). Mother Talzin: -1/-1 with the Force, deployed, then -1/-1 again as she attacks (the
  // user, 2026-11-26)
  const fragile = (leaderDef.unit?.hp ?? 99) <= FRAGILE_LEADER
  const plotsWaiting = player.resources.some((r) => state.defs[r.card.def].keywords.plot)
  const leaderAbility = actions.some((a) => a.type === 'ability' && a.source === 'leader')
  const deployWaits = (move: Action) =>
    move.type === 'deploy' && ((plotAttack && othersAttack) || leaderAbility || ((fragile || plotsWaiting) && othersAttack))
  const holds = (move: Action) => move.type === 'attack' && move.target === 'base' && holdsForDeploy(state, p, move.attacker)
  // With Plot cards for the deploy, a card from hand waits until after it: the resources pay
  // for the Plot cards first (Kylo Ren planned Unveiled Might, then had spent them, 2026-11-25)
  const canDeploy = actions.some((a) => a.type === 'deploy')
  const forPlots = (move: Action) => move.type === 'play' && canDeploy && plotsWaiting && player.hand.some((c) => c.id === move.card)
  const bias = (move: Action) =>
    move.type !== 'attack'
      ? forPlots(move)
        ? -2 * AFTER_ATTACKS
        : waits(move) || deployWaits(move)
          ? -AFTER_ATTACKS
          : 0
      : ATTACK_FIRST -
        (holds(move) ? HOLD_FOR_DEPLOY : 0) +
        (r < 0 && move.target !== 'base' ? CONTROL_FIRST : 0) +
        (racingDeck && move.target === 'base' ? RACE_BASE : 0) +
        (racing && move.target === 'base' ? LETHAL_RACE + 0.1 * powerOf(state, state.players[p].units.find((u) => u.id === move.attacker)!) : 0)
  // Past its time budget, it judges the moves left without trying its later answers
  const start = performance.now()
  const tried = moves.map((move) => {
    const deep = performance.now() - start < BUDGET
    const after = outcome(state, p, move, p, deep)
    const single = after ? evaluate(after, p) : -Infinity
    const saved = readyKill(state, p, move, after)
    if (saved > 0) killsReady.add(move)
    return {
      move,
      after,
      single,
      best: Math.max(single, deep ? combo(state, p, move) : -Infinity, after ? awakened(after, p) : -Infinity) + leaderPlays(state, p, move, after) + searchPlays(state, p, move) - uniqueSpent(state, p, move),
      // Kept apart, so a reason to wait (a negative) isn't lost below
      extra: timing(state, p, move, actions) + saved + readyTokenOnDeath(state, p, move, after),
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
      // A card that waits is still worth making: it only comes after
      return { action: t.move, gain: gain > MIN_GAIN ? Math.max(MIN_GAIN + 0.01, gain + bias(t.move)) : gain }
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
    tried.map((t) => ({ action: t.move, gain: t.best + t.extra - now > MIN_GAIN ? Math.max(MIN_GAIN + 0.01, t.best + t.extra - now + bias(t.move)) : t.best + t.extra - now })),
    done,
    why,
  )
}

// A leader's action that plays a card (Shaddam IV's): it comes back each round, so a card played
// with it costs little more than the resources it takes. Worth this much more than the board shows.
const LEADER_PLAY = 1.5
// A unique card it already controls a copy of (8.30.3), as a unit or as an upgrade (Ramallo, attached
// when defeated): played, one copy is defeated at once. The board played out shows that, but not
// the resources and the card spent for no body: worth playing only for a strong When Played (Ramallo
// healing a base under pressure, which the race weighs: more in a long game than a short one)
const UNIQUE_SPENT = 2.5
// A copy played over one in play that is still healthy (under half its HP in damage) throws a
// whole card away: worth this much more (a second Gungi played for Obi-Wan Kenobi's Sentinel, the
// user's game 18, 2026-11-25)
const UNIQUE_HEALTHY = 6
const uniqueSpent = (state: GameState, p: PlayerId, move: Action) => {
  if (move.type !== 'play' || !uniqueHeld(state, p, move.card)) return 0
  const card = state.players[p].hand.find((c) => c.id === move.card)
  const name = card && state.defs[card.def].name
  const copy = state.players[p].units.find((u) => state.defs[u.def].name === name)
  return UNIQUE_SPENT + (copy && copy.damage * 2 < hpOf(state, copy) ? UNIQUE_HEALTHY : 0)
}
function uniqueHeld(state: GameState, p: PlayerId, card: string) {
  const player = state.players[p]
  const held = [...player.hand, ...player.discard, ...player.resources.map((r) => r.card)].find((c) => c.id === card)
  const d = held && state.defs[held.def]
  if (!d?.unique || d.token) return false
  const same = (def: string) => state.defs[def].name === d.name && (state.defs[def].subtitle ?? '') === (d.subtitle ?? '')
  return [...player.units, ...player.units.flatMap((u) => u.upgrades), ...(player.base.upgrades ?? [])].some((c) => same(c.def))
}

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
// A card that looks at the opponent's hand to discard from it (Mon Cal Cruiser) goes first while
// they have 6 or more resources and Credit tokens ready: their big play stripped before they make
// it (the user, 2026-11-25)
const STRIPS_HAND = /Look at an opponent's hand\. You may discard a card from it/
const STRIP_READY = 6
const STRIP_FIRST = 3
function stripsBigPlay(state: GameState, p: PlayerId, d: CardDef) {
  if (!STRIPS_HAND.test(d.text ?? '')) return false
  const foe = state.players[p === 0 ? 1 : 0]
  return foe.hand.length > 0 && foe.resources.filter((r) => !r.exhausted).length + (foe.credits?.length ?? 0) >= STRIP_READY
}
// A cheap card that discards an event from the opponent's hand (Jam Communications): for the
// matchups whose decks win with dear events, a board wipe or removal (Overgrowth, Lost and
// Forgotten), played just before they can afford one; against an aggro deck, a resource (the
// user, 2026-11-26: "better against other slow decks that play board wipes ... play it against
// Mace before Overgrowth is played"). The odds come from their decklist, not their hand: the
// simulation that judges the move sees the hand, so alone it plays the card only on a sure hit.
const DISCARDS_EVENT = /Look at an opponent's hand and discard an event from it/
// An event this dear is worth stripping
const JAM_KEY = 4
// The share of the opponent's deck such events must make up for the card to stay in hand
const JAM_KEEP = 0.08
const JAM_HIT = 4
function keyEvents(state: GameState, foe: PlayerId) {
  const player = state.players[foe]
  const cards = [...player.hand, ...player.deck, ...player.discard, ...player.resources.map((r) => r.card)]
  const key = cards.filter((c) => state.defs[c.def].type === 'event' && state.defs[c.def].cost >= JAM_KEY)
  return { share: key.length / Math.max(1, cards.length), cheapest: Math.min(...key.map((c) => state.defs[c.def].cost)) }
}
// Worth playing now: the odds they hold a key event, once they are a resource short of one or more
function jamWorth(state: GameState, p: PlayerId) {
  const foe = state.players[p === 0 ? 1 : 0]
  const { share, cheapest } = keyEvents(state, p === 0 ? 1 : 0)
  if (share < JAM_KEEP || !foe.hand.length || foe.resources.length + 1 + (foe.credits?.length ?? 0) < cheapest) return 0
  return JAM_HIT * (1 - (1 - share) ** foe.hand.length)
}

const CAPTURES = /When this unit attacks and defeats a unit:\] You may choose an enemy non-leader unit\. This unit captures it/
const CAPTURER = 6
// A unit whose attack, or its defeat, makes the next unit cost less this phase (GNK Power Droid's
// On Attack, Honor-Bound Partisan's When Defeated): on turn 2, a 4-cost unit with 3 resources, a
// 5-cost Capital Ship with Admiral Piett's Action too (the user, 2026-11-26: "insane tempo for a
// turn 2"; Partisan "you suicide it on turn 2 to get a 5 drop out"). Its attack is worth it when
// a unit in hand needs that 1 less; Partisan's only into a unit that defeats it.
const ON_ATTACK_DISCOUNT = /\[On Attack:\] The next unit you play this phase costs \[(\d)\] less/
const DEFEAT_DISCOUNT = /\[When Defeated:\] The next unit you play this phase costs \[(\d)\] less/
const CAPITAL_ACTION = /Play a \{capital ship\} unit from your hand\. It costs \[(\d)\] less/i
const ENABLER = 3
// OFF (env, tests only): AI changes switched off one at a time, to measure each
const OFF = new Set(((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.AI_OFF ?? '').split(',').filter(Boolean))
function enablerWorth(state: GameState, p: PlayerId, move: Action) {
  if (move.type !== 'attack' || OFF.has('enabler')) return 0
  const player = state.players[p]
  const unit = player.units.find((u) => u.id === move.attacker)
  if (!unit) return 0
  const text = state.defs[unit.def].text ?? ''
  const onAttack = text.match(ON_ATTACK_DISCOUNT)
  const onDefeat = text.match(DEFEAT_DISCOUNT)
  if (!onAttack && !onDefeat) return 0
  if (!onAttack) {
    const target = move.target === 'base' ? undefined : state.players[p === 0 ? 1 : 0].units.find((u) => u.id === move.target)
    if (!target || powerOf(state, target) < hpOf(state, unit) - unit.damage) return 0
  }
  const less = Number((onAttack ?? onDefeat)![1])
  const ready = player.resources.filter((r) => !r.exhausted).length + (player.credits?.length ?? 0)
  const leaderText = player.leader.deployed ? '' : (state.defs[player.leader.def].text ?? '')
  const action = !player.leader.exhausted ? Number(leaderText.match(CAPITAL_ACTION)?.[1] ?? 0) : 0
  const unlocked = player.hand
    .map((c) => state.defs[c.def])
    .filter((d) => d.type === 'unit')
    .map((d) => ({ d, cost: playCost(state, p, d) - (action && d.traits.includes('Capital Ship') ? action : 0) }))
    .filter(({ cost }) => cost > ready && cost - less <= ready)
  if (!unlocked.length) return 0
  return ENABLER + 0.5 * Math.max(...unlocked.map(({ d }) => d.cost))
}

// An enemy GNK Power Droid still ready to attack: its attack makes their next unit cost less (a
// 4-drop on turn 2). Defeated in one attack before it does, at high priority; a hit that leaves it
// standing gets nothing extra (the user, 2026-11-26: "leaving it out is a recipe for disaster").
// Not Honor-Bound Partisan: defeating it gives them the discount.
const KILL_ENABLER = 4
function killsEnabler(state: GameState, p: PlayerId, move: Action) {
  if (move.type !== 'attack' || move.target === 'base' || OFF.has('killgnk')) return 0
  const foe = state.players[p === 0 ? 1 : 0]
  const target = foe.units.find((u) => u.id === move.target)
  const attacker = state.players[p].units.find((u) => u.id === move.attacker)
  if (!target || !attacker || target.exhausted || !foe.hand.length || !ON_ATTACK_DISCOUNT.test(state.defs[target.def].text ?? '')) return 0
  const shielded = target.upgrades.some((u) => state.defs[u.def].token && state.defs[u.def].name === 'Shield')
  return !shielded && powerOf(state, attacker) >= hpOf(state, target) - target.damage ? KILL_ENABLER : 0
}

// Damage that feeds a friendly unit's power (Paz Vizsla's +2/+0 a damage), dealt before it
// attacks: Act of Aggression's 3 (and +3/+0 with Overwhelm), Open Fire's 4. The play goes before
// the attacks, worth the power it adds (the deck's notes, 2026-11-26: "15 damage in one attack")
const FEEDS = /for each damage on/
const FEED_PLAY = /^Deal (\d) damage to a unit\.$|^Draw a card\.\nYou may deal (\d) damage to a unit\./
const FEED_WORTH = 0.6
function feedWorth(state: GameState, p: PlayerId, d: CardDef) {
  const m = (d.text ?? '').match(FEED_PLAY)
  if (!m || d.type !== 'event') return 0
  const amount = Number(m[1] ?? m[2])
  const foe = state.players[p === 0 ? 1 : 0]
  const foesReady = foe.units.some((u) => !u.exhausted && u.arena === 'ground')
  const fed = state.players[p].units.find(
    (u) => FEEDS.test(state.defs[u.def].text ?? '') && !u.exhausted && hpOf(state, u) - u.damage > amount && (u.arena !== 'ground' || !foesReady),
  )
  if (!fed) return 0
  return FEED_WORTH * (2 * amount + (m[2] ? 3 : 0))
}

const GROWS_WITH_DAMAGE = 3
const SELF_HARM_UPGRADE = /Attached unit gains: "\[On Attack:\] You may deal 2 damage to a friendly unit/
const HOLOCRON_ON_FEEDER = 4
const HOLOCRON_ON_FORCE = 1.5

// An enemy combo piece (Paz Vizsla, who grows with damage; Gungi, who readies as he's damaged,
// Sith Holocron's loop): defeated in one attack at high priority (the user, 2026-11-26: "make sure
// the AI doesn't fall too easily to that combo")
// Director Krennic, whose discount runs Thrawn's deck, and Count Dooku, who keeps an aggro deck's
// units exhausted, are killed as soon as can be (the user, 2026-11-27)
const COMBO_PIECE = /for each damage on|When this unit is dealt damage and survives:\] You may discard a card from your hand\. If you do, ready this unit|has a "\[When Defeated\] " ability costs \[1\] less|can't ready more than 1 ground unit and 1 space unit/
const KILL_COMBO = 3
function killsComboPiece(state: GameState, p: PlayerId, move: Action) {
  if (move.type !== 'attack' || move.target === 'base') return 0
  const target = state.players[p === 0 ? 1 : 0].units.find((u) => u.id === move.target)
  const attacker = state.players[p].units.find((u) => u.id === move.attacker)
  if (!target || !attacker || !COMBO_PIECE.test(state.defs[target.def].text ?? '')) return 0
  const shielded = target.upgrades.some((u) => state.defs[u.def].token && state.defs[u.def].name === 'Shield')
  return !shielded && powerOf(state, attacker) >= hpOf(state, target) - target.damage ? KILL_COMBO : 0
}

// 8D8's Action: a unit from the top 5, the curve fixed, rather than its weak attack, unless that
// attack defeats a unit (a 3/1 or a 2/1) (the user, 2026-11-26)
const SEARCH_ACTION = /Deal 1 damage to another friendly unit\. If you do, search the top \d+ cards of your deck for a unit/
const SEARCH_ACTION_WORTH = 2.5
function searchActionWorth(state: GameState, p: PlayerId, move: Action, actions: Action[]) {
  const player = state.players[p]
  const id = move.type === 'ability' ? move.source : move.type === 'attack' ? move.attacker : undefined
  const unit = id && player.units.find((u) => u.id === id)
  if (!unit || !SEARCH_ACTION.test(state.defs[unit.def].text ?? '') || OFF.has('8d8')) return 0
  const foes = state.players[p === 0 ? 1 : 0].units
  const trades = actions.some((a) => {
    if (a.type !== 'attack' || a.attacker !== unit.id || a.target === 'base') return false
    const t = foes.find((u) => u.id === a.target)
    return !!t && hpOf(state, t) - t.damage <= powerOf(state, unit)
  })
  if (trades) return 0
  return move.type === 'ability' ? SEARCH_ACTION_WORTH : -SEARCH_ACTION_WORTH
}

// Interrogation Droid is in Piett's deck for The Invisible Hand, played free there (no aspect
// penalty). From hand, only to stop a strong attacker while racing (the user, 2026-11-26)
const EXHAUSTS_FOE = /^\[When Played:\] Exhaust an enemy unit\. If you do, and that unit costs 3 or less/
const STRONG_ATTACKER = 5
const HOLD_EXHAUSTER = 4

// A unit played rather than a leader ability that would leave no resources for it
const UNIT_OVER_ABILITY = 3
const UPGRADE_ON_LEADER = 2.5
const PROTECT_PER_COST = 0.2
const UPGRADE_PER_HP = 0.1
const UPGRADE_AT_RISK = 1.5
// An upgrade that makes its unit stronger (Slip-Tip's +1/+0), put on an enemy unit to get its When
// Played: the enemy keeps the bonus, and what the upgrade gives on attack
const BUFF_ON_ENEMY = 3
// An event that makes a token for each friendly unit of a kind (A Web of Spies: a Spy token for
// each friendly non-token Spy) waits for at least 2 of them, unless its hand holds nothing else
const TOKENS_PER_KIND = /^Create an? (\w+) token for each friendly (non-token )?\[\{(\w+)\}\] unit/
const TOKENS_AT_LEAST = 2
const HOLD_FOR_TOKENS = 3
const HOLD_FOR_AMBUSH = 2
// An event that only makes Spice tokens (The Spice Must Flow) puts nothing on the board: against
// a board that outpowers its own, with a unit it could play instead, each Spice token is worth
// this much less (Spice doesn't block a rush)
const SPICE_ONLY = /^Create (\d+) Spice tokens?\./
const SPICE_UNDER_PRESSURE = 0.75
// An upgrade that makes a token when it goes on a unit of a kind (Forged Imperial Writ: a Spy
// token on a Spy) goes on one of that kind, worth about a token more
const TOKEN_ON_KIND = /If attached unit is an? \[\{(\w+)\}\], create/
const ATTACH_FOR_TOKEN = 1.5
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

const RESOURCES_ITSELF = /^Resource this card\.$/m
const RAMP_SOON = 8
// A unit whose On Attack may ready a resource (R2-D2, The First Protagonist) attacks once its
// resources are spent, while there is a card or an ability to spend them on first
const READIES_RESOURCE = /\[On Attack:\][^]*Ready a resource/
const HOLD_FOR_READY = 3
function timing(state: GameState, p: PlayerId, move: Action, actions: Action[]) {
  return (
    baseTiming(state, p, move, actions) +
    leaderSafety(state, p, move) +
    pingSetsUpTrade(state, p, move, actions) -
    intoSweeper(state, p, move) -
    holdsRemoval(state, p, move) +
    upgradesForLeader(state, p, move) -
    upgradeIntoCostRemoval(state, p, move) -
    playsBlanked(state, p, move)
  )
}
// A card an enemy Galen Erso named has no abilities (the user, 2026-11-27: "make sure the AI doesn't
// play blank cards most of the time; a blank unit could work but would be inferior usually"). An
// event does nothing: a card and its cost for nothing, played only with nothing else at all. A
// unit or an upgrade keeps its body (power and HP, an upgrade's modifiers): played when nothing
// better is, short of what its text was worth.
const BLANK_EVENT = 8
const BLANK_TEXT = 1
const BLANK_PER_COST = 0.3
function playsBlanked(state: GameState, p: PlayerId, move: Action) {
  if (move.type !== 'play' || !state.named?.length) return 0
  const player = state.players[p]
  const card = player.hand.find((c) => c.id === move.card) ?? player.resources.find((r) => r.card.id === move.card)?.card ?? player.discard.find((c) => c.id === move.card)
  if (!card || !blanked(state, card, p)) return 0
  const d = state.defs[card.def]
  if (d.type === 'event') return BLANK_EVENT
  return (d.text ?? '').trim() ? BLANK_TEXT + BLANK_PER_COST * (d.cost ?? 0) : 0
}
// An upgrade on a cheap unit the foe can defeat by its cost alone (Ahsoka Tano, Not on My Death
// Watch: a unit that costs 3 or less) loses both cards to one: the user, 2026-11-27, "a lightsaber
// on a 3 cost unit against Mace: Ahsoka kills the unit + lightsaber, a blowout; super risky against
// decks with answers". Weighed by the odds the foe holds such a card it can pay for (not peeking:
// its hand and deck alike), and by what the upgrade costs.
const BY_COST = /defeat (?:a|an enemy|a non-leader) ?(?:non-leader )?unit that costs (\d+) or less/i
const COST_REMOVAL_RISK = 1.5
function upgradeIntoCostRemoval(state: GameState, p: PlayerId, move: Action) {
  if (move.type !== 'play' || !move.attachTo || OFF.has('bycost')) return 0
  const player = state.players[p]
  const card = player.hand.find((c) => c.id === move.card) ?? player.resources.find((r) => r.card.id === move.card)?.card
  const d = card && state.defs[card.def]
  const unit = player.units.find((u) => u.id === move.attachTo)
  if (!d || d.type !== 'upgrade' || !unit || unit.leader) return 0
  const cost = state.defs[unit.def].cost ?? 0
  const foe = state.players[p === 0 ? 1 : 0]
  const unseen = [...foe.hand, ...foe.deck]
  if (!unseen.length || !foe.hand.length) return 0
  // Once the foe can pay for it next round: earlier, the upgrade pays off first (counted always,
  // Talzin fell from 39 to 30 wins in 100 vs Mace, upgrades held too long)
  const affords = foe.resources.length + 2 + (foe.credits?.length ?? 0)
  const copies = unseen.filter((c) => {
    const x = state.defs[c.def]
    const m = (x.text ?? '').match(BY_COST)
    return !!m && cost <= Number(m[1]) && x.cost <= affords
  }).length
  if (!copies) return 0
  const odds = 1 - Math.pow(1 - copies / unseen.length, foe.hand.length)
  return COST_REMOVAL_RISK * odds * (1 + (d.cost ?? 0))
}
// Upgrades kept for the leader (the user, 2026-11-27: "leaders in general should receive some kind
// of bonus to get upgrades": hard to kill, and on the deploy turn all the resources are there for
// them; Mother Talzin's Constructed Lightsaber above all). An upgrade that goes on the leader unit
// (its attach rule allows it, and it helps its unit) is held from the other units while the leader
// can still deploy; on the deploy turn, with one in hand it can pay for, the leader
// deploys first, so the upgrade goes on it and what's left still plays a cheap card. Units are
// never held for it: a turn 2, 3 or 4 play comes first.
const HOLD_FOR_LEADER = 5
const DEPLOY_FOR_UPGRADE = 2
const ATTACH_ONLY = /Attach to a (non-)?\[\{(\w[\w ]*)\}\] unit/i
function fitsLeader(state: GameState, p: PlayerId, d: CardDef) {
  if (d.type !== 'upgrade' || CONDEMNS.test(d.text ?? '')) return false
  if (!((d.power ?? 0) > 0 || (d.hp ?? 0) > 0 || /gains|gets \+/i.test(d.text ?? ''))) return false
  const leader = state.defs[state.players[p].leader.def]
  if (!leader.unit) return false
  const rule = (d.text ?? '').match(ATTACH_ONLY)
  if (!rule) return true
  const has = leader.traits.includes(rule[2])
  return rule[1] ? !has : has
}
function upgradesForLeader(state: GameState, p: PlayerId, move: Action) {
  const player = state.players[p]
  // Deployed, or defeated (it can't deploy again): the upgrades go where they fit best
  if (player.leader.deployed || player.leader.epicUsed) return 0
  if (move.type === 'deploy' && !move.attachTo) {
    // What's ready after deploying (it costs nothing): an upgrade for the leader paid from it
    const ready = player.resources.filter((r) => !r.exhausted).length + (player.credits?.length ?? 0)
    const fits = player.hand.some((c) => fitsLeader(state, p, state.defs[c.def]) && playCost(state, p, state.defs[c.def]) <= ready)
    return fits ? DEPLOY_FOR_UPGRADE : 0
  }
  if (move.type !== 'play' || !move.attachTo) return 0
  const card = player.hand.find((c) => c.id === move.card)
  const d = card && state.defs[card.def]
  if (!d || !fitsLeader(state, p, d) || player.units.find((u) => u.id === move.attachTo)?.leader) return 0
  // Held for as long as the leader can still deploy (the user, 2026-11-27: a Lightsaber on Mae
  // isn't a priority while Talzin is to come; late, with her gone, it's fine)
  return -HOLD_FOR_LEADER
}
// Hard removal (No Glory, Only Results: take control of a unit, then defeat it) waits for a target
// as dear as itself while the foe still has big cards unseen (Bo-Katan Kryze, Home One), unless
// its player is in danger (the user's game, 2026-11-26: No Glory kept for Bo-Katan; the AI spent
// it on Finn, Captain Typho, Hunter, half its uses)
const HARD_REMOVAL = /^Take control of a non-leader unit, then defeat it\.|^Defeat a non-leader unit\./
const HOLD_REMOVAL = 3
const DEFEATED_STORED = 3
const STEAL_DEFEATED = /When Defeated:\] (?:Deal \d+ damage divided|You may defeat an enemy unit)/
function holdsRemoval(state: GameState, p: PlayerId, move: Action) {
  if (move.type !== 'play') return 0
  const card = state.players[p].hand.find((c) => c.id === move.card)
  const d = card && state.defs[card.def]
  if (!d || d.type !== 'event' || !HARD_REMOVAL.test(d.text ?? '')) return 0
  const foe = state.players[p === 0 ? 1 : 0]
  // Removal that takes the unit waits for one with a When Defeated worth taking (Thrawn's The
  // Legacy Run, its 6 damage then ours) while one is unseen and none is on the board (the user,
  // 2026-11-27: "keep No Glory for stuff like Thrawn's own Legacy Run")
  const steals = /^Take control/.test(d.text ?? '')
  const prize = (c: { def: string }) => STEAL_DEFEATED.test(state.defs[c.def].text ?? '')
  if (steals && !inDanger(state, p) && !foe.units.some(prize) && [...foe.hand, ...foe.deck].some(prize)) return HOLD_REMOVAL
  const dearest = Math.max(0, ...foe.units.filter((u) => !u.leader).map((u) => state.defs[u.def].cost))
  if (dearest >= d.cost || inDanger(state, p)) return 0
  const big = [...foe.hand, ...foe.deck].some((c) => state.defs[c.def].cost >= BIG_CARD)
  return big ? HOLD_REMOVAL : 0
}
// A unit played into a sweeper the foe can pay for this round or the next (Bo-Katan Kryze, Alone:
// -3/-3 to each enemy unit, at 9): dying to it, it's worth less now, by the odds the foe holds one
// (its copies unseen, deck and hand alike, so it doesn't peek, and the foe's hand size).
// Talzin against Mace-bleu, 2026-11-26: Bo-Katan, played 65 times in 100 games, defeated 107 of
// her units, 82 of them played the round before
const SWEEPER = /(?:give|gives) each enemy unit -\d+\/-(\d+)|deal (\d+) damage to each enemy unit/i
const SWEEPER_RISK = 1.5
function intoSweeper(state: GameState, p: PlayerId, move: Action) {
  if (move.type !== 'play') return 0
  const player = state.players[p]
  const card = player.hand.find((c) => c.id === move.card) ?? player.resources.find((r) => r.card.id === move.card)?.card
  const d = card && state.defs[card.def]
  if (!d || d.type !== 'unit') return 0
  const foeId = p === 0 ? 1 : 0
  const foe = state.players[foeId]
  const unseen = [...foe.hand, ...foe.deck]
  if (!unseen.length || !foe.hand.length) return 0
  const affords = foe.resources.length + 1 + (foe.credits?.length ?? 0)
  let risk = 0
  const byName = new Map<string, { amount: number; cost: number; copies: number }>()
  for (const c of unseen) {
    const x = state.defs[c.def]
    const m = (x.text ?? '').match(SWEEPER)
    if (!m || x.cost > affords) continue
    const e = byName.get(x.name) ?? { amount: Number(m[1] ?? m[2]), cost: x.cost, copies: 0 }
    e.copies++
    byName.set(x.name, e)
  }
  for (const e of byName.values()) {
    if ((d.hp ?? 0) > e.amount) continue
    // A card the foe couldn't pay for yet waits in hand: each card there counts twice for it
    const held = e.cost > foe.resources.length ? 2 * foe.hand.length : foe.hand.length
    const odds = 1 - Math.pow(1 - e.copies / unseen.length, held)
    risk = Math.max(risk, odds)
  }
  // What the unit would be worth on the board, lost with it
  const worth = 1 + 0.7 * (d.power ?? 0) + 0.25 * d.cost + 0.5 * (d.hp ?? 0)
  return risk ? SWEEPER_RISK * risk * worth : 0
}
// The leader side's -X/-X (Mother Talzin) before an attack it turns into a good trade (its attack
// then defeats the unit, or defeats it and survives; a Sentinel above all): playing the ping out
// alone doesn't show the attack after it
const TRADE_SETUP = 2.5
function pingSetsUpTrade(state: GameState, p: PlayerId, move: Action, actions: Action[]) {
  if (move.type !== 'ability' || move.source !== 'leader') return 0
  const m = (state.defs[state.players[p].leader.def].text ?? '').match(LEADER_PING)
  const amount = m ? Number(m[2] ?? m[3]) : 0
  if (!amount || !m![2]) return 0
  const mine = state.players[p].units
  const foe = state.players[p === 0 ? 1 : 0].units
  const shielded = (u: UnitState) => u.upgrades.some((x) => state.defs[x.def].token && state.defs[x.def].name === 'Shield')
  let best = 0
  for (const a of actions) {
    if (a.type !== 'attack' || a.target === 'base') continue
    const au = mine.find((u) => u.id === a.attacker)
    const eu = foe.find((u) => u.id === a.target)
    if (!au || !eu || shielded(eu)) continue
    const kills = (cut: number) => powerOf(state, au) >= hpOf(state, eu) - eu.damage - cut
    const survives = (cut: number) => hpOf(state, au) - au.damage > powerOf(state, eu) - cut
    if (kills(amount) && (!kills(0) || (survives(amount) && !survives(0)))) best = Math.max(best, TRADE_SETUP + (keywordsOf(state, eu).sentinel ? 1.5 : 0))
  }
  return best
}
// Director Krennic first: the first unit with a When Defeated each round costs 1 less, and most of
// Thrawn's deck has one (the user, 2026-11-27: "high priority to play")
const DEFEATED_DISCOUNT = /has a "\[When Defeated\] " ability costs \[1\] less/
function playsDefeatedDiscount(state: GameState, p: PlayerId, move: Action) {
  if (move.type !== 'play') return 0
  const player = state.players[p]
  const card = player.hand.find((c) => c.id === move.card)
  if (!card || !DEFEATED_DISCOUNT.test(state.defs[card.def].text ?? '')) return 0
  const fed = player.hand.filter((c) => c.id !== card.id && state.defs[c.def].type === 'unit' && /When Defeated/.test(state.defs[c.def].text ?? ''))
  return fed.length ? ENABLER : 0
}
// A unit whose When Defeated draws (Nightsister Warrior) trades as soon as its attack defeats an
// enemy unit: the card drawn, Thrawn's again (the user, 2026-11-27: "he wants options in hand,
// trade that unit as soon as a good trade is available")
const DRAWS_ON_DEFEAT = /\[When Defeated:\] Draw/
const TRADE_FOR_CARDS = 2.5
function tradesForCards(state: GameState, p: PlayerId, move: Action) {
  if (move.type !== 'attack' || move.target === 'base') return 0
  const attacker = state.players[p].units.find((u) => u.id === move.attacker)
  const target = state.players[p === 0 ? 1 : 0].units.find((u) => u.id === move.target)
  if (!attacker || !target || !DRAWS_ON_DEFEAT.test(state.defs[attacker.def].text ?? '')) return 0
  const shielded = target.upgrades.some((u) => state.defs[u.def].token && state.defs[u.def].name === 'Shield')
  return !shielded && powerOf(state, attacker) >= hpOf(state, target) - target.damage ? TRADE_FOR_CARDS : 0
}
// "Defeat a friendly non-leader unit. Then, you may play that unit …" (One Must Destroy to
// Create) waits while a friendly unit with a When Defeated can still attack: its attack first,
// then the card (the user, 2026-11-27: Inferno Squad recycled before it attacked)
const DESTROY_TO_CREATE = /^Defeat a friendly non-leader unit\. Then, you may play that unit/
const RECYCLE_AFTER_ATTACK = 2.5
function attacksBeforeRecycling(state: GameState, p: PlayerId, move: Action, actions: Action[]) {
  if (move.type !== 'play') return 0
  const card = state.players[p].hand.find((c) => c.id === move.card)
  if (!card || !DESTROY_TO_CREATE.test(state.defs[card.def].text ?? '')) return 0
  const attackers = new Set(actions.flatMap((a) => (a.type === 'attack' ? [a.attacker] : [])))
  const waiting = state.players[p].units.some((u) => attackers.has(u.id) && !u.leader && /When Defeated/.test(state.defs[u.def].text ?? ''))
  return waiting ? -RECYCLE_AFTER_ATTACK : 0
}
function baseTiming(state: GameState, p: PlayerId, move: Action, actions: Action[]) {
  const enabling =
    enablerWorth(state, p, move) +
    killsEnabler(state, p, move) +
    killsComboPiece(state, p, move) +
    playsDefeatedDiscount(state, p, move) +
    tradesForCards(state, p, move) +
    attacksBeforeRecycling(state, p, move, actions)
  if (enabling) return enabling
  const searching = searchActionWorth(state, p, move, actions)
  if (searching) return searching
  if (move.type === 'attack') {
    const unit = state.players[p].units.find((u) => u.id === move.attacker)
    const text = unit ? (state.defs[unit.def].text ?? '') : ''
    if (!READIES_RESOURCE.test(text) || state.players[p].resources.some((r) => r.exhausted)) return 0
    return actions.some((a) => a.type === 'play' || (a.type === 'ability' && a.source === 'leader')) ? -HOLD_FOR_READY : 0
  }
  // Its leader's ability that costs resources (Lando Calrissian's [1]) waits for such a unit's
  // attack: the resource it readies pays for it (the user, 2026-11-25)
  if (move.type === 'ability' && move.source === 'leader') {
    const readier = actions.some((a) => {
      if (a.type !== 'attack') return false
      const u = state.players[p].units.find((x) => x.id === a.attacker)
      return !!u && READIES_RESOURCE.test(state.defs[u.def].text ?? '')
    })
    // With a card to play first: the card, then the attack, then this. Nothing to play: this
    // first, the attack after (its resource readied then has no use: it pings instead)
    const plays = actions.some((a) => a.type === 'play')
    if (readier && plays && /^\[Action \[\[\d\]/.test(state.defs[state.players[p].leader.def].text ?? '')) return -HOLD_FOR_READY
    // A unit it can play now that paying for the ability would leave out (a 2-cost unit on turn 1
    // with 2 resources): the unit; with a unit it still has room for (a 1-cost one), the ability
    // and then that unit (the user, 2026-11-26: "if he only has 2 drops in hand, he plays that
    // first and doesn't use the credit. If only a 1 Leia or a C-3PO, he plays that + credit")
    const price = Number(state.defs[state.players[p].leader.def].text?.match(/^\[Action \[\[(\d+)\]/)?.[1] ?? 0)
    if (price) {
      const player = state.players[p]
      const ready = player.resources.filter((r) => !r.exhausted).length + (player.credits?.length ?? 0)
      const units = actions.flatMap((a) => {
        if (a.type !== 'play') return []
        const card = player.hand.find((c) => c.id === a.card)
        return card && state.defs[card.def].type === 'unit' ? [playCost(state, p, state.defs[card.def])] : []
      })
      // (its Credit token comes only on a match: not counted on)
      if (units.length && !units.some((cost) => cost <= ready - price)) return -UNIT_OVER_ABILITY
    }
  }
  // Kylo Ren's Experience token before Reforge: the unit reforged hits harder with what it finds
  if (move.type === 'ability' && move.source === 'leader' && /Give an Experience token/.test(state.defs[state.players[p].leader.def].text ?? '')) {
    const reforge = actions.some((a) => a.type === 'play' && REFORGES.test(state.defs[state.players[p].hand.find((c) => c.id === a.card)?.def ?? '']?.text ?? ''))
    if (reforge) return REFORGE_FIRST + 1
    if (anakinWaits(state, p)) return ANAKIN_SETUP
  }
  if (move.type === 'ability') return fuel(state, p, move, actions)
  if (move.type !== 'play') return 0
  const card = state.players[p].hand.find((c) => c.id === move.card) ?? state.players[p].resources.find((r) => r.card.id === move.card)?.card
  if (!card) return 0
  const d = state.defs[card.def]
  // A control deck against an aggro one plays its Sentinel units first, while the enemy has
  // units to attack its base and none of its own Sentinels stands (the user, 2026-11-25)
  const sentinelUp = state.players[p].units.some((u) => keywordsOf(state, u).sentinel)
  let worth = 0
  // A card that wants the Force (Darth Tyranus's Ambush, Talzin's Assassin's -3/-3) waits for the
  // attack of a Force unit that brings it (Nightsister Lair) (the user, 2026-11-26)
  if (FORCE_CARD.test(d.text ?? '') && !state.force?.[p] && forceOnAttack(state, p, actions)) worth -= FORCE_FIRST
  // Anakin Skywalker, Champion of Mortis, waits for Kylo Ren's discard of a Heroism card: both his
  // -3/-3 then (the user, 2026-11-25)
  if (d.name === 'Anakin Skywalker' && /Champion of Mortis/.test(d.subtitle ?? '') && anakinWaits(state, p) && actions.some((a) => a.type === 'ability' && a.source === 'leader'))
    worth -= ANAKIN_SETUP
  // An upgrade that makes a unit stronger goes on it before it attacks: on Kylo Ren as he deploys,
  // Bestial Bond with Jar Jar Binks (the user, 2026-11-25)
  const onto = move.attachTo ? state.players[p].units.find((u) => u.id === move.attachTo) : undefined
  if (d.type === 'upgrade' && onto && !onto.exhausted && (d.power ?? 0) > 0 && actions.some((a) => a.type === 'attack' && a.attacker === onto.id))
    worth += UPGRADE_BEFORE_ATTACK + (onto.leader ? UPGRADE_BEFORE_ATTACK : 0)
  // Reforge goes before the attacks: its unit attacks with the upgrade it finds (the user,
  // 2026-11-25: turn 1 a unit and an Experience token, turn 2 Reforge, then attack)
  if (REFORGES.test(d.text ?? '') && actions.some((a) => a.type === 'attack' && state.players[p].units.find((u) => u.id === a.attacker)?.upgrades.length)) worth += REFORGE_FIRST
  if (d.type === 'unit' && d.keywords.sentinel && !sentinelUp && role(state, p) < 0 && state.players[p === 0 ? 1 : 0].units.length) worth += SENTINEL_CONTROL
  if (stripsBigPlay(state, p, d)) worth += STRIP_FIRST
  worth += feedWorth(state, p, d)
  // Paz Vizsla, +2/+0 a damage: worth more than the 3/6 the board shows; Sith Holocron, its 2
  // damage on a friendly unit for +2/+0, on a unit that grows with damage (Paz Vizsla, Gungi with
  // Grit, readied as he's damaged: the deck's turn-3 combo), else on any Force unit
  if (d.type === 'unit' && FEEDS.test(d.text ?? '')) worth += GROWS_WITH_DAMAGE
  if (d.type === 'upgrade' && SELF_HARM_UPGRADE.test(d.text ?? '') && onto)
    worth += COMBO_PIECE.test(state.defs[onto.def].text ?? '') || keywordsOf(state, onto).grit ? HOLOCRON_ON_FEEDER : HOLOCRON_ON_FORCE
  if (EXHAUSTS_FOE.test(d.text ?? '') && !OFF.has('interro')) {
    const strong = state.players[p === 0 ? 1 : 0].units.some((u) => !u.exhausted && powerOf(state, u) >= STRONG_ATTACKER)
    if (!strong || !(inDanger(state, p) || foeCanFinish(state, p) || lethalNow(state, p))) worth -= HOLD_EXHAUSTER
  }
  // A unit that captures as it attacks and defeats a unit (The Mandalorian, Cleaning Up Nevarro):
  // a 2-for-1 each turn it attacks, worth more than its first one, which the board shows (the
  // user, 2026-11-26: "prioritize the Mandalorian ... so it kills and captures a unit each turn")
  if (d.type === 'unit' && CAPTURES.test(d.text ?? '')) {
    const foes = state.players[p === 0 ? 1 : 0].units.filter((u) => !u.leader).length
    worth += foes >= 2 ? CAPTURER : foes ? CAPTURER / 2 : 0
  }
  if (DISCARDS_EVENT.test(d.text ?? '')) worth += jamWorth(state, p)
  const foeUnits = state.players[p === 0 ? 1 : 0].units
  if (d.type === 'upgrade' && move.attachTo && ((d.power ?? 0) > 0 || (d.hp ?? 0) > 0) && foeUnits.some((u) => u.id === move.attachTo))
    worth -= BUFF_ON_ENEMY + (d.power ?? 0) + (d.hp ?? 0)
  // Condemn: -6/-0 on the unit as it attacks (its player discloses), so on the enemy unit that
  // hits hardest, never on a friendly one
  if (d.type === 'upgrade' && CONDEMNS.test(d.text ?? '') && move.attachTo) {
    const host = foeUnits.find((u) => u.id === move.attachTo)
    worth += host ? CONDEMN_WORTH * Math.min(6, powerOf(state, host)) : -2 * CONDEMN_WORTH * 6
  }
  if (/for each time an enemy base was dealt damage this phase/.test(d.text ?? '') && actions.some((a) => a.type === 'attack')) worth -= HOLD_FOR_HITS
  const spiceOnly = d.type === 'event' ? (d.text ?? '').match(SPICE_ONLY) : null
  if (spiceOnly) {
    const board = (q: PlayerId) => state.players[q].units.reduce((sum, u) => sum + powerOf(state, u, true), 0)
    const unitInstead = actions.some(
      (a) => a.type === 'play' && a.card !== card.id && state.defs[state.players[p].hand.find((c) => c.id === a.card)?.def ?? '']?.type === 'unit',
    )
    if (unitInstead && board(p === 0 ? 1 : 0) > board(p)) worth -= SPICE_UNDER_PRESSURE * Number(spiceOnly[1])
  }
  // A card that becomes a resource as it is played (Overgrowth): that resource is there every
  // round after, which looking one round ahead doesn't see. Played as soon as it can be, while
  // the deck's plan still wants resources (Mace: 5 to 6, the leader deployed a round sooner).
  if (RESOURCES_ITSELF.test(d.text ?? '') && state.players[p].resources.length < deckPlan(state, p).target) worth += RAMP_SOON
  const perKind = d.type === 'event' ? (d.text ?? '').match(TOKENS_PER_KIND) : null
  if (perKind) {
    const count = state.players[p].units.filter((u) => (!perKind[2] || !state.defs[u.def].token) && state.defs[u.def].traits?.includes(perKind[3])).length
    const others = state.players[p].hand.some((c) => c.id !== card.id)
    if (count < TOKENS_AT_LEAST && others) worth -= HOLD_FOR_TOKENS
  }
  // An Ambush unit with no enemy unit in its arena to ambush (Blue Ace into an empty space arena):
  // held while another card can be played, for when one comes (Red Leader, its 2/4 Sentinel)
  if (d.type === 'unit' && d.keywords?.ambush && !move.attachTo && !foeUnits.some((u) => u.arena === (d.arena ?? 'ground'))) {
    const other = actions.some((a) => a.type === 'play' && a.card !== card.id)
    if (other) worth -= HOLD_FOR_AMBUSH
  }
  const unit = d.type === 'upgrade' && move.attachTo ? state.players[p].units.find((u) => u.id === move.attachTo) : undefined
  if (unit) {
    const kind = (d.text ?? '').match(TOKEN_ON_KIND)?.[1]
    if (kind && traitsOf(state, unit).includes(kind)) worth += ATTACH_FOR_TOKEN
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
  why?.push(...weighed.filter((w) => w.gain > -Infinity).map((w) => ({ action: w.action, gain: Math.round(w.gain * 100) / 100, ...(w.rank !== undefined && { rank: Math.round(w.rank * 100) / 100 }) })))
  // A move ranked about as well that gains clearly more goes first: the rank, which looks past
  // the reply to a follow-up, can miss what one move adds to the other (Mace Windu's attack with
  // Restore 2 against the same attack without, the user's game 120, 2026-11-24)
  // Only an ability in place of a plain attack: otherwise the rank's order stands (an ability
  // first, its unit's attack after, as Paul Atreides' leader side wants)
  const top = weighed[0]
  if (top && worth(top) && top.rank !== undefined && top.action.type === 'attack') {
    // The same unit's other attack, too: only one of the two can be made, so the rank's order
    // means nothing between them (Gungi hit the base for 2 rather than defeat a 2-HP Imperial
    // Dark Trooper, the user's game 18, 2026-11-25)
    const attacker = top.action.attacker
    const better = weighed
      .filter(
        (w) =>
          worth(w) &&
          (w.action.type === 'ability' || (w.action.type === 'attack' && w.action.attacker === attacker)) &&
          w.rank !== undefined &&
          w.rank >= top.rank! - RANK_CLOSE * Math.abs(top.rank!) &&
          w.gain >= top.gain + GAIN_LEAD,
      )
      .sort((a, b) => b.gain - a.gain)[0]
    if (better) return better.action
  }
  return top && worth(top) ? top.action : done
}
// How close two ranks must be (a share of the top one's), and how much more the other must gain,
// for it to go first
const RANK_CLOSE = 0.12
const GAIN_LEAD = 3

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
// ones: its units that cost 1 (aspects missing counted): an aggro deck with many wants two of
// them on turn 1 (Wicket's)
export type DeckPlan = { curve: number[]; average: number; leader: number; top: number; target: number; spiceReserve: number; smugglers: number; ones: number }
const plans = new WeakMap<object, [DeckPlan?, DeckPlan?]>()
// Costs from 0 to this, the dearer ones counted with it
// Which AI this is, kept with each game it plays, to tell its versions apart in the stats
export const AI_VERSION = '2026-11-18 spies, spice under pressure'

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
    smugglers: cards.filter((d) => d.keywords.smuggle).length,
    ones: cards.filter((d) => d.type === 'unit' && playCost(state, p, d) <= 1).length,
  }
  known[p] = plan
  plans.set(state.defs, known)
  return plan
}

// A card with Plot is worth putting in the resources while it can still be played from there:
// its leader not yet deployed (Plot plays it then), or a deployed leader that plays cards with
// Plot from the resources (the Baron's On Attack)
const PLOT_FROM_RESOURCES = /card with \[Plot\] from your resources/i
// A card with Smuggle is worth putting in the resources on purpose, to play from there later (a
// card more, the deck's top card taking its place): with a leader that plays cards using Smuggle
// (Gurney Halleck, for 2 less), or in a deck with many of them. Its Smuggle cost within the
// plan's reach; with the leader's help, the cheapest first, played soonest.
const SMUGGLE_LEADER = /using Smuggle/i
const SMUGGLERS = 8
function smuggleHelped(state: GameState, p: PlayerId) {
  const leader = state.defs[state.players[p].leader.def]
  return SMUGGLE_LEADER.test(`${leader.text ?? ''}\n${leader.backText ?? ''}`)
}
function smuggleWanted(state: GameState, p: PlayerId, card: CardDef) {
  const smuggle = card.keywords.smuggle
  if (!smuggle) return false
  const plan = deckPlan(state, p)
  const helped = smuggleHelped(state, p)
  if (!helped && plan.smugglers < SMUGGLERS) return false
  return smuggle - (helped ? 2 : 0) <= plan.target
}

// A unit whose Plot play defeats it (Yueh, Broken Conditioning) is worth more as a unit played
// from the hand: it keeps it for that, and plays it with Plot only if it is in the resources anyway
const PLOT_DEFEATS_ITSELF = /\[When Played using Plot:\][^\n]*defeat this unit/i
function plotWanted(state: GameState, p: PlayerId, card: CardDef) {
  if (!card.keywords.plot) return false
  if (card.type === 'unit' && PLOT_DEFEATS_ITSELF.test(card.text ?? '')) return false
  const leader = state.players[p].leader
  return !leader.deployed || PLOT_FROM_RESOURCES.test(state.defs[leader.def].backText ?? '')
}

// The cards it resources: first those it can't play before the plan's target, then those it
// can't play soon unless they are its dearest (kept for later), then its cheapest, which matter
// least once the game goes on
const BIG_CARD = 7
const BIG_KEPT = 2
export function resourcePicks(state: GameState, p: PlayerId, count: number) {
  const player = state.players[p]
  const plan = deckPlan(state, p)
  const soon = player.resources.length + 2
  const price = (id: string) => playCost(state, p, state.defs[player.hand.find((c) => c.id === id)!.def])
  const extraBig = new Set<string>()
  const keptBig = new Set<string>()
  for (const c of [...player.hand].filter((c) => state.defs[c.def].cost >= BIG_CARD).sort((a, b) => state.defs[b.def].cost - state.defs[a.def].cost)) {
    const name = state.defs[c.def].name
    if (keptBig.size < BIG_KEPT && !keptBig.has(name)) keptBig.add(name)
    else extraBig.add(c.id)
  }
  const rank = (id: string) => {
    const cost = price(id)
    // A card that ramps (CHOAM Dividend) once its leader is deployed: a resource and no more
    const d = state.defs[player.hand.find((c) => c.id === id)!.def]
    if (player.leader.deployed && /put this event into play as a resource/i.test(d.text ?? '')) return 4000
    // A card with Plot, its leader still to deploy (or one that plays Plot cards from the
    // resources, the Baron): a resource now, and played from there later, replaced from the deck
    if (plotWanted(state, p, d)) return 3500 + cost
    if (smuggleWanted(state, p, d)) return 3300 - (d.keywords.smuggle ?? 0)
    // Better played in the first round ("While it's the first round of the game, this unit enters
    // play ready"): kept then
    if (state.round === 1 && /first round of the game/i.test(d.text ?? '') && cost <= soon) return -1
    // A card that strips an event from the opponent's hand (Jam Communications) stays in hand
    // while they likely hold one: cheap, it would go first otherwise
    if (DISCARDS_EVENT.test(d.text ?? '') && keyEvents(state, p === 0 ? 1 : 0).share >= JAM_KEEP) return -1
    // A card that resources itself as it's played (Overgrowth) stays in hand while the deck still
    // wants resources: played, it's a resource and its effect besides (the user's game,
    // 2026-11-26: Mace-bleu resourced it on round 1, then had no turn 2)
    if (!OFF.has('res') && RESOURCES_ITSELF.test(d.text ?? '') && player.resources.length < plan.target) return -1
    // Big cards past the two it keeps (no second copy of one): one a turn is all it plays, so
    // the rest go first (the same game: two Trask Walkers, Home One and Bo-Katan Kryze held to
    // the end while its mid-curve went to the resources)
    if (!OFF.has('res') && extraBig.has(id)) return 2500 + cost
    if (cost > plan.target) return 3000 + cost
    if (cost > soon && cost < plan.target - 1) return 2000 + cost
    if (cost <= soon) return 1000 - cost
    return cost
  }
  const sorted = player.hand.map((c) => c.id).sort((a, b) => rank(b) - rank(a))
  // Its opening hand, in a deck built to play a unit on its first turn: the curve it keeps
  // stays out of the resources while the rest can go, the least needed of it first
  const kept = openingCurve(state, p, count)
  if (!kept.length) return sorted.slice(0, count)
  const rest = sorted.filter((id) => !kept.includes(id))
  return [...rest, ...[...kept].reverse()].slice(0, count)
}

// Every deck (the user, 2026-11-26) keeps, from its opening hand: a unit for turn 1 (two 1-cost
// units for an aggro deck with many, Wicket's); a play for turn 2 (a 3-cost unit
// first, else another 2-cost unit, else a card such as Bestial Bond, and then a 2-cost unit
// besides as a backup, should the turn-1 unit die); a play for turn 3 (the dearest it can pay
// for then). Most needed first. (The user, 2026-11-26: "turn 1 plays are very important")
function openingCurve(state: GameState, p: PlayerId, count: number): string[] {
  const player = state.players[p]
  if (player.resources.length) return []
  const budget = (turn: number) => player.resources.length + count + turn - 1
  const cards = player.hand.map((c) => ({ id: c.id, d: state.defs[c.def], cost: playCost(state, p, state.defs[c.def]) }))
  const kept: string[] = []
  const free = () => cards.filter((c) => !kept.includes(c.id))
  const unit = (c: (typeof cards)[number]) => c.d.type === 'unit'
  // An aggro deck with many 1-cost units (Wicket's): two of them for turn 1
  if (deckPlan(state, p).ones >= DOUBLE_ONE) {
    const ones = free().filter((c) => unit(c) && c.cost <= 1).slice(0, 2)
    if (ones.length === 2) kept.push(...ones.map((c) => c.id))
  }
  // The turn-1 unit: the dearest it can pay for, one that makes turn 2's unit cost less first
  // when the hand has that unit (GNK Power Droid with a 4-cost unit)
  const discountOf = (c: (typeof cards)[number]) => Number((c.d.text ?? '').match(ON_ATTACK_DISCOUNT)?.[1] ?? (c.d.text ?? '').match(DEFEAT_DISCOUNT)?.[1] ?? 0)
  const capital = Number((state.defs[player.leader.def].text ?? '').match(CAPITAL_ACTION)?.[1] ?? 0)
  const pays = (c: (typeof cards)[number], extra: number) => unit(c) && c.cost - (c.d.traits.includes('Capital Ship') ? capital : 0) === budget(2) + extra
  const enablers = OFF.has('enabler') ? [] : free().filter((c) => unit(c) && c.cost <= budget(1) && discountOf(c) && cards.some((x) => x.id !== c.id && pays(x, discountOf(c))))
  // An event that plays a Vehicle unit for less (They Hate That Ship with B-Wing Skirmisher):
  // both, for turn 1
  const combo = kept.length ? [] : vehicleCombo(state, p, budget(1))
  if (combo.length) kept.push(...combo)
  const first = kept.length ? undefined : (enablers[0] ?? free().filter((c) => unit(c) && c.cost <= budget(1)).sort((a, b) => b.cost - a.cost)[0])
  if (!kept.length && !first) return []
  if (first) kept.push(first.id)
  // Past turn 1, a card with Plot goes to the resources anyway: played from there later
  const later = () => free().filter((c) => !plotWanted(state, p, c.d))
  // A turn-1 unit that makes turn 2's unit cost less (GNK Power Droid, Honor-Bound Partisan): a
  // unit one dearer for turn 2, a Capital Ship one more with Admiral Piett's Action
  if (!first && combo.length) {
    const later = () => free().filter((c) => !plotWanted(state, p, c.d))
    const next = later().filter((c) => c.cost <= budget(2)).sort((a, b) => b.cost - a.cost)[0]
    if (next) kept.push(next.id)
    const after = later().filter((c) => c.cost <= budget(3)).sort((a, b) => b.cost - a.cost)[0]
    if (after) kept.push(after.id)
    return kept
  }
  const less = first && !OFF.has('enabler') ? discountOf(first) : 0
  const stretch = (c: (typeof cards)[number]) => less > 0 && pays(c, less)
  const second =
    (less ? later().filter(stretch).sort((a, b) => b.cost - a.cost)[0] : undefined) ??
    later().filter((c) => unit(c) && c.cost === budget(2))[0] ??
    later().filter((c) => unit(c) && c.cost <= budget(1)).sort((a, b) => b.cost - a.cost)[0] ??
    later().filter((c) => c.cost <= budget(2)).sort((a, b) => b.cost - a.cost)[0]
  if (second) kept.push(second.id)
  const third = later().filter((c) => c.cost <= budget(3)).sort((a, b) => b.cost - a.cost)[0]
  if (third) kept.push(third.id)
  // Turn 2's play not a unit (an upgrade): a 2-cost unit besides, the backup
  const backup = second && !unit(second) ? later().filter((c) => unit(c) && c.cost <= budget(1))[0] : undefined
  if (backup) kept.push(backup.id)
  return kept
}

// They Hate That Ship ("play a [{Vehicle}] unit from your hand. It costs [3] less") and the
// Vehicle unit it plays, paid for together with `budget` resources (2 on turn 1): the two cards
const PLAYS_VEHICLE = /play a \[\{Vehicle\}\] unit from your hand\. It costs \[(\d)\] less/i
function vehicleCombo(state: GameState, p: PlayerId, budget = 2): string[] {
  const hand = state.players[p].hand.map((c) => ({ id: c.id, d: state.defs[c.def], cost: playCost(state, p, state.defs[c.def]) }))
  for (const event of hand) {
    const m = (event.d.text ?? '').match(PLAYS_VEHICLE)
    if (!m || event.d.type !== 'event') continue
    const ship = hand
      .filter((c) => c.d.type === 'unit' && c.d.traits.includes('Vehicle') && event.cost + Math.max(0, c.cost - Number(m[1])) <= budget)
      .sort((a, b) => b.cost - a.cost)[0]
    if (ship) return [event.id, ship.id]
  }
  return []
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
    if (!OFF.has('blind') && blindSearch(state, p, move)) return searchOutcome(state, p, move, me, deep)
    return settle(applyAction(lean(state), p, move), me, deep)
  } catch {
    return undefined
  }
}

// A card that searches its player's deck (Kelleran Beq's top 7): played out on the real deck,
// the AI would know what it finds. Judged blind instead: played out on a few shuffles of the
// deck, the middle one kept, a gamble worth what it usually finds (the user, 2026-11-26: Kelleran
// in danger against aggro "if you don't find a Sentinel it's super bad")
const SEARCH_SAMPLES = 5
const SEARCHES = /Search the top \d+ cards of your deck/
function blindSearch(state: GameState, p: PlayerId, move: Action) {
  if (move.type !== 'play') return false
  const card = state.players[p].hand.find((c) => c.id === move.card)
  return !!card && SEARCHES.test(state.defs[card.def].text ?? '')
}
function searchOutcome(state: GameState, p: PlayerId, move: Action, me: PlayerId, deep: boolean) {
  const deck = state.players[p].deck
  let seed = (state.round * 7919 + deck.length * 104729 + state.players[p].hand.length) >>> 0
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32
  const tries: { after: GameState; score: number }[] = []
  for (let i = 0; i < SEARCH_SAMPLES; i++) {
    const shuffled = [...deck]
    for (let j = shuffled.length - 1; j > 0; j--) {
      const k = Math.floor(random() * (j + 1))
      ;[shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]]
    }
    const players = state.players.map((pl, q) => (q === p ? { ...pl, deck: shuffled } : pl)) as GameState['players']
    const after = settle(applyAction(lean({ ...state, players }), p, move), me, deep)
    tries.push({ after, score: evaluate(after, me) })
  }
  tries.sort((a, b) => a.score - b.score)
  return tries[Math.floor(tries.length / 2)].after
}

// An attack on a unit that only pays off once other attacks finish it (a Sentinel no one unit
// can defeat): played on, its other units attacking it in turn, the best each time, as long as
// it stands. Each attack after the first counts a little less, the opponent acting between.
const COMBO_COST = 0.4
function combo(state: GameState, p: PlayerId, move: Action): number {
  if (move.type === 'play') return weakenCombo(state, p, move)
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

// A card that weakens enemy units for this phase (Bo-Katan Kryze's -3/-3 on each), then up to two
// attacks on enemy units: the attacks it makes better count for it, as an attack's follow-up does
// (the user's game, 2026-11-26: Ahsoka Tano and Kanan Jarrus attacked a full-size Kylo Ren first)
const WEAKENS = /-\d+\/-?\d+ for this phase/i
function weakenCombo(state: GameState, p: PlayerId, move: Action & { type: 'play' }): number {
  const card = state.players[p].hand.find((c) => c.id === move.card)
  if (!card || !WEAKENS.test(state.defs[card.def].text ?? '')) return -Infinity
  try {
    let game = settle(applyAction(lean(state), p, move), p, false)
    let best = -Infinity
    for (let step = 1; step <= 2; step++) {
      if (game.phase !== 'action') break
      const again = { ...game, active: p }
      let next: GameState | undefined
      let nextScore = -Infinity
      for (const attack of legalActions(again, p)) {
        if (attack.type !== 'attack' || attack.target === 'base') continue
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
  if (state.prompt?.firm) return quick
  const answers = legalActions(state, p)
  // Inside a move played out, only a short list of answers is worth trying
  if (answers.length < 2 || answers.length > (deep ? 40 : 10)) return quick
  // What a unit attacks, for an ability (Mace Windu's leader side): a control deck (see role)
  // leans to the enemy unit as its own attacks do (CONTROL_FIRST), not the base (Latts Razzi hit
  // the base for 3 rather than defeat a 2-HP Imperial Dark Trooper, the user's game 18, 2026-11-25)
  const lean = /^Choose what .* attacks$/.test(state.prompt?.text ?? '') && role(state, p) < 0
  const leaning = (answer: Action) => (lean && answer.type === 'answer' && !answer.picks.some((x) => x.startsWith('base')) ? CONTROL_FIRST : 0)
  let best = quick
  let bestScore = scoreOf(state, p, quick, p, deep) + leaning(quick) + 0.01
  for (const answer of answers) {
    const score = scoreOf(state, p, answer, p, deep) + leaning(answer)
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
const RESTORE_RACE = 1
function raceRate(state: GameState, p: PlayerId) {
  const foe = state.players[p === 0 ? 1 : 0]
  const left = Math.max(1, state.defs[foe.base.def].hp - foe.base.damage)
  let power = 0
  for (const unit of state.players[p].units) {
    if (state.doomed.includes(unit.id)) continue
    // Restore takes back the other side's damage: in a race nearly as good as dealing as much
    // (the user, 2026-11-23)
    const keywords = keywordsOf(state, unit)
    // A +N for this phase on a unit already exhausted ends before it attacks again (Bold
    // Resistance on a unit just played: nothing gained)
    const fading = unit.exhausted ? state.effects.filter((e) => e.unit === unit.id && e.until === 'phase').reduce((sum, e) => sum + e.power, 0) : 0
    power += (powerOf(state, unit) - Math.max(0, fading) + (keywords.raid ?? 0) + RESTORE_RACE * (keywords.restore ?? 0)) * (blocked(state, p, unit) ? 0.5 : 1)
  }
  return power / left
}

// Who's the beatdown: the player whose leader deploys dearer holds the board, trading early and
// keeping its base whole (Mace Windu, 6, against Wicket, 4): -1 for it, 0 otherwise. Its own base
// damage counts this much more. (A beatdown side, base damage it deals counting more and its
// base attacks first, did worse: Wicket 58 of 200 against the old AI's Mace, 71 before; the
// control side alone, Mace 142 of 200, 129 before. 2026-11-23)
// A plain unit, or removal with no Sentinel to clear, ranks this much lower while a base attack
// is open (the user, 2026-11-23: cards come after the attacks nearly always)
const AFTER_ATTACKS = 10
// Defeating an enemy unit that can still attack this round saves the damage it would deal: worth
// this much for each point of it (power and Raid). An exhausted one deals no more this round (the
// user's game 121, 2026-11-24: Mace Windu defeated Sabine Wren, who had attacked, while Karis
// Nemik and Reckless Rebel, still ready, then hit the base for 9)
const READY_KILL = 0.5
// A unit whose When Defeated makes a ready token (Karis Nemik's Spy): dying in its own attack
// hands the opponent the next action, to defeat the token before it attacks. Killed on their
// turn, the token attacks first. Such a trade is worth this much less.
const READY_TOKEN_EXPOSED = 1.5
function readyTokenOnDeath(state: GameState, p: PlayerId, move: Action, after: GameState | undefined) {
  if (move.type !== 'attack' || move.target === 'base' || !after) return 0
  const unit = state.players[p].units.find((u) => u.id === move.attacker)
  if (!unit || after.players[p].units.some((u) => u.id === unit.id)) return 0
  return /\[When Defeated:\][^\n]*token and ready it/i.test(state.defs[unit.def].text ?? '') ? -READY_TOKEN_EXPOSED : 0
}
// By an attack, or by a card or an ability (removal, an Ambush): each ready enemy unit gone after it
function readyKill(state: GameState, p: PlayerId, move: Action, after: GameState | undefined) {
  if (!after || (move.type === 'attack' && move.target === 'base') || move.type === 'pass' || move.type === 'initiative') return 0
  const foe = state.players[p === 0 ? 1 : 0]
  if (foe.passedForPhase) return 0
  const left = new Set(after.players[p === 0 ? 1 : 0].units.map((u) => u.id))
  let saved = 0
  for (const unit of foe.units) {
    if (unit.exhausted || left.has(unit.id)) continue
    saved += READY_KILL * Math.max(0, powerOf(state, unit) + (keywordsOf(state, unit).raid ?? 0))
  }
  return saved
}
const REMOVAL = /(deals? [^.]*damage[^.]*unit|defeat [^.]*unit)/i
const CONTROL_BASE = 0.5
const CONTROL_FIRST = 1.5
const CONDEMNS = /this unit gets -6\/-0 for this attack/
const CONDEMN_WORTH = 0.6
const REFORGES = /^Defeat an upgrade on a friendly unit\. If you do, search the top/
const REFORGE_FIRST = 2
const UPGRADE_BEFORE_ATTACK = 1
const ANAKIN_SETUP = 3
const FORCE_CARD = /the Force is with you, this unit gains|use the Force/i
const FORCE_FIRST = 3
// An attack available now by a friendly Force unit whose attack makes the Force be with you
function forceOnAttack(state: GameState, p: PlayerId, actions: Action[]) {
  const base = state.defs[state.players[p].base.def]?.text ?? ''
  if (!/When a friendly \[\{Force\}\] unit attacks:\] The (\[\{)?Force/.test(base)) return false
  return actions.some((a) => {
    if (a.type !== 'attack') return false
    const u = state.players[p].units.find((x) => x.id === a.attacker)
    return !!u && state.defs[u.def].traits.includes('Force')
  })
}
// Anakin in hand, a Heroism card to discard with it, none in the discard pile yet
function anakinWaits(state: GameState, p: PlayerId) {
  const pl = state.players[p]
  const d = (c: { def: string }) => state.defs[c.def]
  const heroism = (c: { def: string }) => d(c).aspects.includes('Heroism')
  return (
    pl.hand.some((c) => d(c).name === 'Anakin Skywalker' && /Champion of Mortis/.test(d(c).subtitle ?? '')) &&
    pl.hand.some((c) => heroism(c) && d(c).name !== 'Anakin Skywalker') &&
    !pl.discard.some(heroism)
  )
}
// A leader unit this fragile (Kylo Ren, 5/3) deploys late, and its opponent keeps a ready ground
// unit that can defeat it: its last such unit attacks the base for this much less, while that
// leader can deploy this phase (the user, 2026-11-25: good players don't get baited, they hold
// a 3-power unit ready and pass)
const FRAGILE_LEADER = 4
const HOLD_FOR_DEPLOY = 3
function holdsForDeploy(state: GameState, p: PlayerId, attackerId: string) {
  const foe = state.players[p === 0 ? 1 : 0]
  if (foe.leader.deployed || foe.passedForPhase) return false
  const leader = state.defs[foe.leader.def]
  const hp = leader.unit?.hp ?? 99
  if (hp > FRAGILE_LEADER || foe.resources.length < leader.cost) return false
  const killer = (u: UnitState) => !u.exhausted && u.arena === (leader.unit?.arena ?? 'ground') && powerOf(state, u) >= hp
  const mine = state.players[p].units
  const attacker = mine.find((u) => u.id === attackerId)
  return !!attacker && killer(attacker) && !mine.some((u) => u.id !== attackerId && killer(u))
}
const SENTINEL_CONTROL = 2
// One AI for DUNE and SWU: the same game. On DUNE the new AI won 345 of 720 against the one before
// (2026-11-23), even within noise.
export function role(state: GameState, p: PlayerId) {
  return Math.min(0, Math.sign(deckPlan(state, p === 0 ? 1 : 0).leader - deckPlan(state, p).leader))
}
export function evaluate(state: GameState, p: PlayerId) {
  const r = role(state, p)
  const board =
    side(state, p, true) -
    side(state, p === 0 ? 1 : 0) +
    RACE * (raceRate(state, p) - raceRate(state, p === 0 ? 1 : 0)) +
    (r < 0 ? -CONTROL_BASE * state.players[p].base.damage : 0)
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
  score -= pingRisk(state, p)
  for (const unit of state.players[p === 0 ? 1 : 0].units) if (borrowed.has(unit.id) && unit.owner === p) score += unitWorth(state, unit, false)
  const kept = own ? Math.min(player.spice.length, spiceKept(state, p)) : 0
  // Its cards with Plot in its resources, while they can still be played from there: cards in
  // hand still to come, as well as resources (the opponent's resources it doesn't see)
  const plots = own ? player.resources.filter((r) => plotWanted(state, p, state.defs[r.card.def])).length : 0
  score +=
    (player.hand.length + plots) * 1.5 +
    player.resources.length +
    (own ? rampWorth(state, p) : 0) +
    kept * SPICE_KEPT_WORTH +
    (player.spice.length - kept) * spiceWorth(state, p) +
    creditWorth(state, p)
  // A Fortification keeps giving while its base stands
  score += (player.base.upgrades?.length ?? 0) * 1.5
  // The Force token (SWU): worth keeping for a card in hand that uses it and can soon be paid
  // for (Vernestra Rwoh readying herself), rather than spent at once on the leader's ability
  if (state.force?.[p]) score += own ? forceWorth(state, p) : FORCE_WORTH
  if (state.initiative === p) score += 0.5
  // Next round's first action goes to whoever has the initiative: in danger, that matters most
  if (inDanger(state, p)) score -= state.initiative === p ? DANGER_FIRST : DANGER
  return score
}

// Credit tokens (SWU): each a resource for one play, kept for a dear card (a mini ramp). A
// leader that turns one into 3 as it deploys (Lando Calrissian) wants one ready before then:
// deployed at 6 resources with 3 Credit tokens, it plays a 9-cost card (Bo-Katan Kryze) that
// round (the user, 2026-11-24)
const CREDIT_WORTH = 1.5
const CREDIT_BEFORE_DEPLOY = 4
function creditWorth(state: GameState, p: PlayerId) {
  const player = state.players[p]
  const credits = player.credits?.length ?? 0
  if (!credits) return 0
  const multiplies = !player.leader.deployed && /defeat a friendly Credit token\. If you do, create 3 Credit tokens/.test(state.defs[player.leader.def].backText ?? '')
  return credits * CREDIT_WORTH + (multiplies ? CREDIT_BEFORE_DEPLOY : 0)
}

const FORCE_WORTH = 0.5
const FORCE_KEPT_WORTH = 3
const USES_FORCE = /you may use the Force|use the Force\]/i
function forceWorth(state: GameState, p: PlayerId) {
  const player = state.players[p]
  const room = player.resources.length + 1
  const user = player.hand.some((c) => {
    const d = state.defs[c.def]
    return d.type !== 'leader' && USES_FORCE.test(d.text ?? '') && playCost(state, p, d) <= room
  })
  return user ? FORCE_KEPT_WORTH : FORCE_WORTH
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
// Cards in hand that make it resource one past its plan's target, up to this many resources
const FULL_HAND = 4
const MAX_RESOURCES = 10
// A deck with this many 1-cost units mulligans a hand without two of them
const DOUBLE_ONE = 12
const RACE_BASE = 4
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

// The opponent's ready units hit this player's base for what it has left this round (Sentinels
// that hold them off left out, Raid counted), FOE_PUMP more with a card in hand and a resource ready
const FOE_PUMP = 3
function foeCanFinish(state: GameState, p: PlayerId) {
  const foe = p === 0 ? 1 : 0
  const player = state.players[foe]
  const left = state.defs[state.players[p].base.def].hp - state.players[p].base.damage
  let power = 0
  for (const unit of player.units) {
    if (unit.exhausted || blocked(state, foe, unit)) continue
    power += powerOf(state, unit) + (keywordsOf(state, unit).raid ?? 0)
  }
  if (power && player.hand.length && player.resources.some((r) => !r.exhausted)) power += FOE_PUMP
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

// The enemy leader's ping, ready to use (Mother Talzin: -1/-1 for the Force, her leader side's
// Action or her unit's On Attack): the unit worth most it would defeat counts for less. A unit
// left on 1 HP beside a ready Talzin dies to it (the user's game, 2026-11-26: Wicket and Obi-Wan
// Kenobi each attacked into 1 HP left, and fell to her -1/-1)
const PING_RISK = 0.6
const LEADER_PING = /^\[Action \[Arrow(, use the Force)?\]:\] (?:Give a unit -(\d)\/-\d|Deal (\d) damage to a unit)/
const LEADER_UNIT_PING = /\[On Attack:\] (?:You may )?(?:give a unit -(\d)\/-\d|deal (\d) damage to a unit)/i
function pingRisk(state: GameState, p: PlayerId) {
  const amount = pingAmount(state, p)
  if (!amount) return 0
  const shielded = (u: UnitState) => u.upgrades.some((x) => state.defs[x.def].token && state.defs[x.def].name === 'Shield')
  const prey = state.players[p].units.filter((u) => hpOf(state, u) - u.damage <= amount && !shielded(u) && !state.doomed.includes(u.id))
  return PING_RISK * Math.max(0, ...prey.map((u) => unitWorth(state, u)))
}
// How much the enemy leader can ping a unit of p's for now (0: it can't)
function pingAmount(state: GameState, p: PlayerId) {
  const foe = state.players[p === 0 ? 1 : 0]
  const leader = state.defs[foe.leader.def]
  let amount = 0
  if (!foe.leader.deployed) {
    const m = (leader.text ?? '').match(LEADER_PING)
    // The Force needed: the foe has it, or gets it as a Force unit of theirs attacks (Crystal Caves)
    const force =
      !!state.force?.[p === 0 ? 1 : 0] ||
      (/is with you/.test(state.defs[foe.base.def].text ?? '') && foe.units.some((u) => !u.exhausted && traitsOf(state, u).includes('Force')))
    if (m && !foe.leader.exhausted && (!m[1] || force)) amount = Number(m[2] ?? m[3])
  } else {
    const unit = foe.units.find((u) => u.leader && !u.exhausted)
    const m = unit && (leader.backText ?? '').match(LEADER_UNIT_PING)
    if (m) amount = Number(m[1] ?? m[2])
  }
  return amount
}

// The leader unit kept alive, the aggro deck's card engine above all (Wicket draws as he
// attacks): it doesn't attack a unit it can't defeat and stay where the enemy's ready units (the
// two strongest) and its leader's ping finish it this phase, nor deploy into such a board (the
// user, 2026-11-26: "his leader should also try to draw 2-3 cards by not dying. Let Talzin deal
// with Wicket": he twice deployed on round 3 and fell that round or the next)
const LEADER_THROWN = 4
function leaderSafety(state: GameState, p: PlayerId, move: Action) {
  if ((move.type !== 'deploy' || move.attachTo) && (move.type !== 'attack' || move.target === 'base')) return 0
  if (lethalNow(state, p)) return 0
  const player = state.players[p]
  const foe = state.players[p === 0 ? 1 : 0]
  if (foe.passedForPhase) return 0
  const shielded = (u: UnitState) => u.upgrades.some((x) => state.defs[x.def].token && state.defs[x.def].name === 'Shield')
  const reach = (except?: string) => {
    const ready = foe.units.filter((u) => !u.exhausted && u.id !== except).map((u) => powerOf(state, u)).sort((a, b) => b - a)
    return (ready[0] ?? 0) + (ready[1] ?? 0) + pingAmount(state, p)
  }
  // Deployed into a board that defeats it, the leader is gone for good: its unit's worth lost
  // besides (the user's game, 2026-11-26: Mace Windu deployed into Talzin and her Lightsaber, and
  // fell at once)
  if (move.type === 'deploy') {
    const u = state.defs[player.leader.def].unit
    if (!u || u.hp > reach()) return 0
    return -(LEADER_THROWN + 3 + 0.7 * u.power + 0.5 * u.hp)
  }
  const unit = player.units.find((u) => u.id === move.attacker)
  const defender = foe.units.find((u) => u.id === move.target)
  if (!unit?.leader || !defender) return 0
  const kills = !shielded(defender) && powerOf(state, unit) >= hpOf(state, defender) - defender.damage
  if (kills) return 0
  const left = hpOf(state, unit) - unit.damage - (shielded(unit) ? 0 : powerOf(state, defender))
  return left > 0 && left <= reach() ? -LEADER_THROWN : 0
}

// A unit by its power (less while a Sentinel blocks it), the health it has left, its keywords
// and what it cost; less when it will soon be gone (defeated, or back to its owner, at the
// regroup phase)
const INK_WORTH = 0.5
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
    // As much as power: healing undoes the other side's damage (was 0.5)
    0.7 * (keywords.restore ?? 0) +
    unit.upgrades.filter((u) => state.defs[u.def].name === 'Shield').length * 1.5 -
    // An Ink token (a community card's): 1 more damage the next time it takes combat damage, as
    // good as 1 health less
    unit.upgrades.filter((u) => state.defs[u.def].token && state.defs[u.def].name === 'Ink').length * INK_WORTH +
    (unit.leader ? 2 : 0) +
    // A When Defeated still to come that hits the other side hard (The Legacy Run's 6 damage,
    // Annihilator's unit defeated): the AI played it like a vanilla 3/3 for 5 (the user,
    // 2026-11-27: "super important card to deal with aggro")
    (STEAL_DEFEATED.test(card.text ?? '') ? DEFEATED_STORED : 0)
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
  // A unique card it already has in play goes first: played, a copy is defeated at once (the
  // user discarded Tantive IV to Luke's +2 for that reason, 2026-11-23)
  const spent = (id: string) => (uniqueHeld(state, p, id) ? 0 : 1)
  const rest = ids.filter((id) => !kept.includes(id)).sort((a, b) => spent(a) - spent(b) || cost(a) - cost(b))
  return [...rest.filter((id) => !spent(id)), ...kept.filter((id) => !spent(id)), ...rest.filter((id) => spent(id)), ...kept.filter((id) => spent(id))]
}

// The opponent's cards in hand, the one whose play would help them most first (Cunning Ploy: "you
// may discard a card from it"): each played on a copy of the board, their side scored after
// against before. Those they can pay for now first; if none, each as it would be next turn, their
// resources ready and one more. Those they can't play even then last, the dearest first.
let stripping = false
function stripOrder(state: GameState, p: PlayerId, ids: string[]): string[] {
  const foe: PlayerId = p === 0 ? 1 : 0
  const cost = (id: string) => {
    const card = state.players[foe].hand.find((c) => c.id === id)
    return card ? state.defs[card.def].cost : 0
  }
  const byCost = [...ids].sort((a, b) => cost(b) - cost(a))
  // Not within its own playing out (the opponent's own Cunning Ploy, played on a copy)
  if (stripping) return byCost
  stripping = true
  try {
    const board = (nextTurn: boolean): GameState => {
      const game = structuredClone({ ...state, defs: undefined, log: [], pending: null }) as unknown as GameState
      game.defs = state.defs
      game.prompt = null
      game.active = foe
      game.phase = 'action'
      if (nextTurn) {
        const player = game.players[foe]
        for (const r of player.resources) r.exhausted = false
        player.resources.push({ card: { id: 'strip-resource', def: player.resources[0]?.card.def ?? player.base.def }, exhausted: false })
      }
      return game
    }
    const impact = (game: GameState, id: string) => {
      let plays: Action[]
      try {
        plays = legalActions(game, foe).filter((a) => a.type === 'play' && a.card === id)
      } catch {
        return -Infinity
      }
      const before = evaluate(game, foe)
      let best = -Infinity
      for (const play of plays) {
        const after = outcome(game, foe, play, foe, false)
        if (after) best = Math.max(best, evaluate(after, foe) - before)
      }
      return best
    }
    const rank = (game: GameState) => {
      const scored = ids.map((id) => ({ id, score: impact(game, id) })).filter((s) => s.score > -Infinity)
      return scored.sort((a, b) => b.score - a.score).map((s) => s.id)
    }
    let ranked = rank(board(false))
    if (!ranked.length) ranked = rank(board(true))
    return [...ranked, ...byCost.filter((id) => !ranked.includes(id))]
  } finally {
    stripping = false
  }
}

// Answering an ability's question, as its script hints: 'harm' picks what hurts the opponent
// most, 'help' what helps itself, 'cheap' its cheapest cards, 'best' the dearest card it can
// soon pay for, 'strip' the opponent's card in hand whose play would help them most, an option's
// id that option, 'ids:a,b,c' those (as many as it may), 'none' nothing. Anything else picks as
// little as it may.
function quickAnswer(state: GameState, p: PlayerId): Action {
  const prompt = state.prompt as Prompt
  const ids = prompt.options.map((o) => o.id)
  if (prompt.kind === 'option') {
    return { type: 'answer', picks: [ids.includes(prompt.ai ?? '') ? (prompt.ai as string) : ids[0]] }
  }
  if (ids.includes(prompt.ai ?? '')) return { type: 'answer', picks: [prompt.ai as string] }
  if (prompt.ai?.startsWith('ids:')) {
    const named = prompt.ai.slice(4).split(',').filter((id) => ids.includes(id)).slice(0, prompt.max)
    return { type: 'answer', picks: named.length >= prompt.min ? named : ids.slice(0, prompt.min) }
  }
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
  else if (prompt.ai === 'strip') ranked = stripOrder(state, p, ids).slice(0, 1)
  else if (prompt.ai === 'best') {
    const soon = state.players[p].resources.length + 1
    ranked = [...ids].sort((a, b) => {
      const [x, y] = [cardCost(a), cardCost(b)]
      return x <= soon && y <= soon ? y - x : x <= soon ? -1 : y <= soon ? 1 : x - y
    })
  }
  // Short of picks it likes, it takes what it must from the rest
  const rest = ids.filter((id) => !ranked.includes(id))
  const wanted = prompt.ai === 'harm' || prompt.ai === 'help' ? Math.min(prompt.max, ranked.length) : prompt.ai === 'best' || prompt.ai === 'strip' ? 1 : prompt.min
  const picks = [...ranked, ...rest].slice(0, Math.max(prompt.min, wanted))
  return { type: 'answer', picks }
}
