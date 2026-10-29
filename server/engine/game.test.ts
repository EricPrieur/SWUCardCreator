import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyAction, createGame, legalActions, playCost, powerOf } from './game.ts'
import { viewFor } from './view.ts'
import { IllegalAction, type Action, type CardDef, type GameState, type PlayerId } from './types.ts'

// Plain cards made up for the tests: the engine only reads their printed values
const card = (id: string, extra: Partial<CardDef>): CardDef => ({
  id,
  name: id,
  type: 'unit',
  cost: 0,
  power: 0,
  hp: 0,
  arena: 'ground',
  aspects: [],
  traits: [],
  unique: false,
  keywords: {},
  ...extra,
})

const defs: CardDef[] = [
  card('chani', { type: 'leader', cost: 4, aspects: ['Aggression', 'Heroism'], unit: { power: 2, hp: 5, arena: 'ground', keywords: {} } }),
  card('rabban', { type: 'leader', cost: 5, aspects: ['Aggression', 'Villainy'], unit: { power: 4, hp: 6, arena: 'ground', keywords: {} } }),
  card('sietch', { type: 'base', hp: 28, aspects: ['Cunning'] }),
  card('carthag', { type: 'base', hp: 28, aspects: ['Aggression'] }),
  card('trooper', { cost: 1, power: 2, hp: 2, aspects: ['Aggression'] }),
  card('wall', { cost: 2, power: 1, hp: 4, aspects: ['Vigilance'], keywords: { sentinel: true } }),
  card('raider', { cost: 2, power: 2, hp: 3, keywords: { raid: 2, restore: 1 } }),
  card('brute', { cost: 3, power: 5, hp: 5, keywords: { overwhelm: true } }),
  card('scrapper', { cost: 2, power: 1, hp: 4, keywords: { grit: true } }),
  card('ship', { cost: 2, power: 3, hp: 3, arena: 'space' }),
  card('knife', { type: 'upgrade', cost: 1, power: 2, hp: 1, arena: undefined }),
]

const deckOf = (id: string, count = 50) => Array.from({ length: count }, () => id)

// A game past the choice of who goes first: the player chosen goes first
function newGame(seed = 7, deck0 = deckOf('trooper'), deck1 = deckOf('trooper')) {
  const state = createGame({
    seed,
    defs,
    decks: [
      { name: 'Chani', leader: 'chani', base: 'sietch', deck: deck0 },
      { name: 'Rabban', leader: 'rabban', base: 'carthag', deck: deck1 },
    ],
  })
  return applyAction(state, state.chooser, { type: 'first', goFirst: true })
}

const act = (state: GameState, p: PlayerId, action: Action) => applyAction(state, p, action)

// Through setup: both keep, both resource their first 2 cards
function started(state = newGame()) {
  const first = state.initiative
  const second = first === 0 ? 1 : 0
  state = act(state, first, { type: 'mulligan', take: false })
  state = act(state, second, { type: 'mulligan', take: false })
  for (const p of [0, 1] as const) state = act(state, p, { type: 'resource', cards: state.players[p].hand.slice(0, 2).map((c) => c.id) })
  return state
}

// A board set up by hand: player 0 active in the action phase with the given units in play
function board(units0: string[], units1: string[], resources = 5) {
  const state = started()
  state.active = 0
  state.initiative = 0
  const place = (p: PlayerId, ids: string[]) =>
    ids.map((id, i) => ({
      id: `u${p}${i}`,
      def: id,
      owner: p,
      arena: defs.find((d) => d.id === id)?.arena ?? 'ground',
      damage: 0,
      exhausted: false,
      upgrades: [],
    }))
  state.players[0].units = place(0, units0)
  state.players[1].units = place(1, units1)
  for (const pl of state.players)
    pl.resources = Array.from({ length: resources }, (_, i) => ({ card: { id: `r${i}`, def: 'trooper' }, exhausted: false }))
  return state
}

test('setup: 6 cards each, mulligans in initiative order, then 2 ready resources each', () => {
  let state = newGame()
  assert.equal(state.phase, 'mulligan')
  assert.deepEqual(
    state.players.map((p) => [p.hand.length, p.deck.length]),
    [
      [6, 44],
      [6, 44],
    ],
  )
  const first = state.initiative
  const second = first === 0 ? 1 : 0
  // The player without the initiative waits for the other's decision
  assert.deepEqual(legalActions(state, second), [])
  assert.throws(() => act(state, second, { type: 'mulligan', take: false }), IllegalAction)
  state = act(state, first, { type: 'mulligan', take: true })
  state = act(state, second, { type: 'mulligan', take: false })
  assert.equal(state.phase, 'resource')
  assert.equal(state.players[first].hand.length, 6)
  assert.equal(state.players[first].deck.length, 44)

  // Both choose at once; exactly 2
  assert.throws(() => act(state, 0, { type: 'resource', cards: [state.players[0].hand[0].id] }), IllegalAction)
  state = act(state, second, { type: 'resource', cards: state.players[second].hand.slice(0, 2).map((c) => c.id) })
  assert.equal(state.phase, 'resource')
  state = act(state, first, { type: 'resource', cards: state.players[first].hand.slice(0, 2).map((c) => c.id) })
  assert.equal(state.phase, 'action')
  assert.equal(state.round, 1)
  assert.equal(state.active, first)
  for (const p of state.players) {
    assert.equal(p.hand.length, 4)
    assert.deepEqual(
      p.resources.map((r) => r.exhausted),
      [false, false],
    )
  }
})

test('the same seed and actions give the same game', () => {
  const a = started(newGame(42))
  const b = started(newGame(42))
  assert.deepEqual(a, b)
  assert.notDeepEqual(started(newGame(43)).players[0].hand, a.players[0].hand)
})

test('a card costs 2 more for each aspect icon the leader and base lack', () => {
  const state = newGame()
  const of = (id: string) => defs.find((d) => d.id === id) as CardDef
  // Chani (Aggression, Heroism) on Sietch Tabr (Cunning)
  assert.equal(playCost(state, 0, of('trooper')), 1)
  assert.equal(playCost(state, 0, of('wall')), 4)
  assert.equal(playCost(state, 0, card('x', { cost: 1, aspects: ['Cunning', 'Cunning'] })), 3)
  assert.equal(playCost(state, 0, card('x', { cost: 1, aspects: ['Villainy', 'Vigilance'] })), 5)
})

test('a unit is played exhausted and paid for with resources', () => {
  let state = board([], [], 2)
  state.players[0].hand = [{ id: 'h1', def: 'trooper' }, { id: 'h2', def: 'wall' }]
  const plays = legalActions(state, 0).filter((a) => a.type === 'play')
  // The Vigilance wall costs 4 here: too much
  assert.deepEqual(plays, [{ type: 'play', card: 'h1' }])
  state = act(state, 0, { type: 'play', card: 'h1' })
  assert.equal(state.players[0].units[0].exhausted, true)
  assert.equal(state.players[0].resources.filter((r) => r.exhausted).length, 1)
  assert.equal(state.active, 1)
})

test('combat: both deal damage at once, and units are defeated', () => {
  let state = board(['trooper'], ['scrapper'])
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  const [scrapper] = state.players[1].units
  assert.equal(scrapper.damage, 2)
  assert.equal(state.players[0].units[0].damage, 1)
  // Grit: the scrapper now has 1 + 2 power
  assert.equal(powerOf(state, scrapper), 3)

  state = board(['brute'], ['trooper'])
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  assert.equal(state.players[1].units.length, 0)
  assert.equal(state.players[1].discard.length, 1)
  // Overwhelm: 5 power against 2 HP sends 3 to the base
  assert.equal(state.players[1].base.damage, 3)
})

test('Sentinel decides what can be attacked, in its arena only', () => {
  const state = board(['trooper', 'ship'], ['wall', 'trooper', 'ship'])
  const targets = (attacker: string) =>
    legalActions(state, 0)
      .filter((a) => a.type === 'attack' && a.attacker === attacker)
      .map((a) => (a.type === 'attack' ? a.target : ''))
  assert.deepEqual(targets('u00'), ['u10'])
  assert.deepEqual(targets('u01'), ['u12', 'base'])
  assert.throws(() => act(state, 0, { type: 'attack', attacker: 'u00', target: 'base' }), IllegalAction)
})

test('Raid adds power while attacking, Restore heals the base when attacking', () => {
  let state = board(['raider'], [])
  state.players[0].base.damage = 5
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'base' })
  assert.equal(state.players[1].base.damage, 4)
  assert.equal(state.players[0].base.damage, 4)
  assert.equal(state.players[0].units[0].exhausted, true)
})

test('upgrades add their stats and go to the discard pile with the unit', () => {
  let state = board(['trooper'], ['brute'])
  state.players[0].hand = [{ id: 'k', def: 'knife' }]
  state = act(state, 0, { type: 'play', card: 'k', attachTo: 'u00' })
  assert.equal(powerOf(state, state.players[0].units[0]), 4)
  state = act(state, 1, { type: 'attack', attacker: 'u10', target: 'u00' })
  assert.equal(state.players[0].units.length, 0)
  assert.deepEqual(state.players[0].discard.map((c) => c.def).sort(), ['knife', 'trooper'])
})

test('two passes in a row end the action phase; the regroup draws 2, resources, readies', () => {
  let state = board(['trooper'], [])
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'base' })
  state = act(state, 1, { type: 'pass' })
  assert.equal(state.phase, 'action')
  state = act(state, 0, { type: 'pass' })
  assert.equal(state.phase, 'regroup')
  assert.equal(state.players[0].hand.length, 6)

  // The player with the initiative resources first, at most one card, exhausted
  assert.deepEqual(legalActions(state, 1), [])
  state = act(state, 0, { type: 'resource', cards: [state.players[0].hand[0].id] })
  state = act(state, 1, { type: 'resource', cards: [] })
  assert.equal(state.phase, 'action')
  assert.equal(state.round, 2)
  assert.equal(state.players[0].resources.length, 6)
  assert.ok(state.players[0].resources.every((r) => !r.exhausted))
  assert.equal(state.players[0].units[0].exhausted, false)
  assert.equal(state.active, 0)
})

test('taking the initiative passes for the rest of the phase and starts the next round', () => {
  let state = board(['trooper'], ['trooper'])
  state = act(state, 0, { type: 'pass' })
  // Right after the opponent passes, taking the initiative ends the phase
  state = act(state, 1, { type: 'initiative' })
  assert.equal(state.phase, 'regroup')
  assert.equal(state.initiative, 1)

  state = board(['trooper'], ['trooper'])
  state = act(state, 0, { type: 'initiative' })
  assert.equal(state.active, 1)
  assert.ok(!legalActions(state, 1).some((a) => a.type === 'initiative'))
  // Player 1 keeps acting while player 0 passes each turn
  state = act(state, 1, { type: 'attack', attacker: 'u10', target: 'base' })
  assert.equal(state.active, 1)
  state = act(state, 1, { type: 'pass' })
  assert.equal(state.phase, 'regroup')
  assert.equal(state.players[0].hand.length, 6)
})

test('a leader deploys once enough resources are in play, and flips back when defeated', () => {
  let state = board([], ['brute'], 3)
  assert.ok(!legalActions(state, 0).some((a) => a.type === 'deploy'))
  state = board([], ['brute'], 4)
  state = act(state, 0, { type: 'deploy' })
  const leader = state.players[0].units[0]
  assert.equal(leader.leader, true)
  assert.equal(leader.exhausted, false)
  assert.equal(powerOf(state, leader), 2)

  state = act(state, 1, { type: 'attack', attacker: 'u10', target: leader.id })
  assert.equal(state.players[0].units.length, 0)
  assert.equal(state.players[0].leader.deployed, false)
  assert.equal(state.players[0].leader.exhausted, true)
  assert.equal(state.players[0].discard.length, 0)
  state.active = 0
  assert.ok(!legalActions(state, 0).some((a) => a.type === 'deploy'))
})

test('defeating the base wins; an empty deck damages the base instead of drawing', () => {
  let state = board(['brute'], [])
  state.players[1].base.damage = 24
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'base' })
  assert.equal(state.phase, 'over')
  assert.equal(state.winner, 0)
  assert.deepEqual(legalActions(state, 1), [])

  state = board([], [])
  state.players[1].deck = state.players[1].deck.slice(0, 1)
  state = act(state, 0, { type: 'pass' })
  state = act(state, 1, { type: 'pass' })
  assert.equal(state.players[1].base.damage, 3)
})

test('each player sees their own hand and resources, never the opponent’s or the decks', () => {
  const state = started()
  const view = viewFor(state, 0)
  assert.equal(view.players[0].hand?.length, 4)
  assert.equal(view.players[1].hand, null)
  assert.equal(view.players[1].handCount, 4)
  assert.ok(view.players[1].resources.every((r) => r.card === null))
  assert.ok(view.players[0].resources.every((r) => r.card !== null))
  assert.equal(view.players[1].deckCount, 44)
  assert.ok(!('deck' in view.players[1]))
  assert.ok(!JSON.stringify(view).includes(state.players[1].hand[0].id))
})

test('the cards drawn are counted: the starting hand, a mulligan, the regroup', () => {
  let state = newGame()
  const first = state.initiative
  assert.deepEqual(state.players.map((p) => p.drawn), [6, 6])
  state = act(state, first, { type: 'mulligan', take: true })
  assert.equal(state.players[first].drawn, 12)
  state = act(state, first === 0 ? 1 : 0, { type: 'mulligan', take: false })
  for (const p of [0, 1] as const) state = act(state, p, { type: 'resource', cards: state.players[p].hand.slice(0, 2).map((c) => c.id) })
  state = act(state, state.active, { type: 'pass' })
  state = act(state, state.active, { type: 'pass' })
  assert.equal(state.players[first].drawn, 14)
  assert.equal(viewFor(state, first === 0 ? 1 : 0).players[first].drawn, 14)
})

test('a random player decides who goes first, before the opening hands are drawn', () => {
  const state = createGame({
    seed: 3,
    defs,
    decks: [
      { name: 'Chani', leader: 'chani', base: 'sietch', deck: deckOf('trooper') },
      { name: 'Rabban', leader: 'rabban', base: 'carthag', deck: deckOf('trooper') },
    ],
  })
  const chooser = state.chooser
  const opponent = chooser === 0 ? 1 : 0
  assert.equal(state.phase, 'first')
  assert.deepEqual(state.players.map((p) => p.hand.length), [0, 0])
  assert.deepEqual(legalActions(state, opponent), [])
  const second = act(state, chooser, { type: 'first', goFirst: false })
  assert.equal(second.phase, 'mulligan')
  assert.equal(second.initiative, opponent)
  assert.deepEqual(second.players.map((p) => p.hand.length), [6, 6])
  // The player now with the initiative decides on a mulligan first
  assert.deepEqual(legalActions(second, chooser), [])
  assert.equal(act(state, chooser, { type: 'first', goFirst: true }).initiative, chooser)
})
