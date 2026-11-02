import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyAction, createGame, hpOf, keywordsOf, legalActions, powerOf, traitsOf } from './game.ts'
import { readText } from './cards.ts'
import { scripts, scriptStatus } from './scripts.ts'
import { IllegalAction, type Action, type CardDef, type GameState, type PlayerId, type UnitState } from './types.ts'

// Test cards: their text is read as the Creator's export would be, and scripted ones quote
// their DUNE card
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
  ...readText(extra.text),
  ...extra,
})
const scriptedBy = (name: string, subtitle: string) => {
  const script = scripts.find((s) => s.name === name && s.subtitle === subtitle)!
  return { name, subtitle, ...readText(script.text), text: script.text, backText: script.backText }
}
const scripted = (name: string) => {
  const script = scripts.find((s) => s.name === name)!
  return { name, subtitle: script.subtitle, ...readText(script.text), text: script.text, backText: script.backText }
}

const defs: CardDef[] = [
  card('leader', { type: 'leader', cost: 4, unit: { power: 3, hp: 6, arena: 'ground', keywords: {} } }),
  card('arrakis', { type: 'base', hp: 30, traits: ['Arrakis'], text: 'You start the game with a [Spice Token].' }),
  card('caladan', { type: 'base', hp: 30, traits: ['Caladan'] }),
  card('trooper', { cost: 1, power: 2, hp: 2 }),
  card('big', { cost: 5, power: 5, hp: 5 }),
  card('guard', { cost: 2, power: 1, hp: 4, text: '[Sentinel]' }),
  card('spy', { cost: 2, power: 2, hp: 3, text: '[Hidden]' }),
  card('raider', { cost: 4, power: 4, hp: 4, text: 'While you control an [{Arrakis}] base, this unit gains [Ambush] and [Hidden].' }),
  card('crusher', { cost: 4, power: 6, hp: 6, text: '[Overwhelm]' }),
  card('smuggler', { ...scripted('Spice Smuggler'), cost: 2, power: 2, hp: 2, aspects: ['Cunning'] }),
  card('bashar', { ...scripted('Sardaukar Bashar'), cost: 3, power: 3, hp: 4, traits: ['Sardaukar', 'Trooper'] }),
  card('plotter', { cost: 2, power: 1, hp: 1, text: '[PLOT]' }),
  card('shieldTrooper', { ...scripted('Atreides Shield Trooper'), cost: 2, power: 2, hp: 2 }),
  card('desertPower', { ...scripted('Desert Power'), type: 'event', cost: 4, arena: undefined }),
  card('runner', { ...scripted('Spice Runner'), cost: 1, power: 2, hp: 1 }),
  card('executioner', { ...scripted('Sardaukar Executioner'), cost: 4, power: 5, hp: 4, traits: ['Sardaukar', 'Trooper'] }),
  card('burseg', { ...scripted('Sardaukar Burseg'), cost: 5, power: 4, hp: 7, traits: ['Sardaukar', 'Official'] }),
  card('falseColors', { ...scripted('False Colors'), type: 'event', cost: 2, arena: undefined, traits: ['Sardaukar', 'Tactic'] }),
  card('terror', { ...scripted("The Emperor's Terror"), type: 'event', cost: 6, arena: undefined, traits: ['Emperor', 'Tactic'] }),
  card('household', { ...scripted('Imperial Household Guard'), cost: 2, power: 2, hp: 3 }),
  card('collector', { ...scripted('Imperial Tithe Collector'), cost: 6, power: 4, hp: 6 }),
  card('legion', { ...scripted('Sardaukar Legion'), cost: 7, power: 5, hp: 6, traits: ['Sardaukar', 'Trooper'] }),
  card('shaddamLeader', { ...scriptedBy('Shaddam IV', 'Padishah Emperor'), type: 'leader', cost: 7, unit: { power: 5, hp: 8, arena: 'ground', keywords: {} } }),
  card('shaddam', { ...scriptedBy('Shaddam IV', 'Lion Throne'), cost: 6, power: 6, hp: 8, unique: true, traits: ['Emperor', 'Official'] }),
  card('soldier', { cost: 2, power: 2, hp: 2, traits: ['Trooper'] }),
  card('carrier', { ...scripted('Sardaukar Troop Carrier'), cost: 2, power: 1, hp: 3, arena: 'space' }),
  card('kynesDream', { ...scripted("Kynes's Dream"), type: 'event', cost: 2, arena: undefined }),
  card('levy', { ...scripted('House Levy'), type: 'event', cost: 2, arena: undefined }),
  card('crossfire', { ...scripted('Crossfire'), type: 'event', cost: 2, arena: undefined }),
  card('plans', { ...scripted('Plans Within Plans'), type: 'event', cost: 2, arena: undefined }),
]

const act = (state: GameState, p: PlayerId, action: Action) => applyAction(state, p, action)
const answer = (state: GameState, ...picks: string[]) => act(state, state.prompt!.player, { type: 'answer', picks })

// Player 0 to act in the action phase, on the base given, with these units, hand and deck
function table(options: { base0?: string; units0?: string[]; units1?: string[]; hand0?: string[]; deck0?: string[] } = {}) {
  let state = createGame({
    seed: 5,
    defs,
    decks: [
      { name: 'One', leader: 'leader', base: options.base0 ?? 'arrakis', deck: Array(20).fill('trooper') },
      { name: 'Two', leader: 'leader', base: 'caladan', deck: Array(20).fill('trooper') },
    ],
  })
  state = act(state, state.chooser, { type: 'first', goFirst: true })
  state = act(state, state.initiative, { type: 'mulligan', take: false })
  state = act(state, state.initiative === 0 ? 1 : 0, { type: 'mulligan', take: false })
  for (const p of [0, 1] as const)
    state = act(state, p, { type: 'resource', cards: state.players[p].hand.slice(0, 2).map((c) => c.id) })
  state.active = 0
  const place = (p: PlayerId, ids: string[]): UnitState[] =>
    ids.map((id, i) => ({ id: `u${p}${i}`, def: id, owner: p, arena: 'ground', damage: 0, exhausted: false, upgrades: [] }))
  state.players[0].units = place(0, options.units0 ?? [])
  state.players[1].units = place(1, options.units1 ?? [])
  state.players[0].hand = (options.hand0 ?? []).map((id, i) => ({ id: `h${i}`, def: id }))
  if (options.deck0) state.players[0].deck = options.deck0.map((id, i) => ({ id: `d${i}`, def: id }))
  for (const pl of state.players) pl.resources = Array.from({ length: 6 }, (_, i) => ({ card: { id: `r${pl.name}${i}`, def: 'trooper' }, exhausted: false }))
  return state
}

test('an Arrakis base starts with a Spice token, whose Action draws 1 of the top 3 cards', () => {
  let state = table({ deck0: ['big', 'guard', 'spy', 'trooper'] })
  assert.equal(state.players[0].spice.length, 1)
  assert.equal(state.players[1].spice.length, 0, 'not on Caladan')
  const spice: Action = { type: 'ability', source: state.players[0].spice[0].id, index: 0 }
  state = act(state, 0, spice)
  assert.equal(state.players[0].spice.length, 0)
  assert.deepEqual(state.prompt?.options.map((o) => o.def), ['big', 'guard', 'spy'])
  state = answer(state, 'd1')
  // The others, one after the other: the big one to the bottom, the spy discarded
  assert.equal(state.prompt?.card, 'big')
  state = answer(state, '1')
  assert.equal(state.prompt?.card, 'spy')
  state = answer(state, '2')
  assert.deepEqual(state.players[0].hand.map((c) => c.def), ['guard'])
  assert.deepEqual(state.players[0].deck.map((c) => c.def), ['trooper', 'big'])
  assert.deepEqual(state.players[0].discard.map((c) => c.def), ['spy'])
  assert.equal(state.active, 1)
})

test('an additional cost: no Spice token, no Sardaukar; it is spent as the unit is played', () => {
  const none = table({ base0: 'caladan', hand0: ['bashar'] })
  assert.ok(!legalActions(none, 0).some((a) => a.type === 'play'))
  let state = table({ units0: ['bashar'], hand0: ['bashar'] })
  state.players[0].units[0].def = 'trooper'
  state.defs.trooper = { ...state.defs.trooper, traits: ['Trooper'] }
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.equal(state.players[0].spice.length, 0)
  // Its When Played: an Experience token to the other Trooper
  assert.equal(state.prompt?.options.length, 1)
  state = answer(state, 'u00')
  const trooper = state.players[0].units[0]
  assert.equal(state.defs[trooper.upgrades[0].def].name, 'Experience')
})

test('a Shield token prevents damage once, and leaves nothing to Overwhelm', () => {
  let state = table({ units0: ['crusher'], hand0: ['shieldTrooper'], base0: 'caladan' })
  state = act(state, 0, { type: 'play', card: 'h0' })
  const trooper = state.players[0].units.find((u) => u.id === 'h0')!
  assert.equal(state.defs[trooper.upgrades[0].def].name, 'Shield', 'no Arrakis base: a Shield')
  // Now the crusher is the enemy's, and attacks the shielded trooper
  state.players[1].units = state.players[0].units.filter((u) => u.id === 'u00')
  state.players[0].units = [trooper]
  state.active = 1
  state = act(state, 1, { type: 'attack', attacker: 'u00', target: 'h0' })
  const after = state.players[0].units[0]
  assert.equal(after.damage, 0)
  assert.deepEqual(after.upgrades, [])
  assert.equal(state.players[0].base.damage, 0, 'no excess damage')
  assert.equal(state.players[1].units[0].damage, 2, 'the trooper hit back')
})

test('Hidden: not attacked the phase it is played; Sentinel can still be', () => {
  let state = table({ units1: ['trooper'], hand0: ['spy'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  const targets = legalActions(state, 1).flatMap((a) => (a.type === 'attack' ? [a.target] : []))
  assert.deepEqual(targets, ['base'])
  // Next phase it can be
  state.phaseCount++
  assert.ok(legalActions(state, 1).some((a) => a.type === 'attack' && a.target === 'h0'))
})

test('Ambush, gained with an Arrakis base: it attacks an enemy unit as it is played', () => {
  let state = table({ units1: ['trooper'], hand0: ['raider'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.match(state.prompt!.text, /Ambush/)
  assert.deepEqual(state.prompt?.options.map((o) => o.id), ['u10'])
  state = answer(state, 'u10')
  assert.deepEqual(state.players[1].units, [])
  assert.equal(state.players[0].units[0].damage, 2)
  // Without the base, no Ambush
  const caladan = act(table({ base0: 'caladan', units1: ['trooper'], hand0: ['raider'] }), 0, { type: 'play', card: 'h0' })
  assert.equal(caladan.prompt, null)
})

test('Smuggle plays a card from the resources, the top card of the deck taking its place', () => {
  let state = table({ deck0: ['big', 'trooper'] })
  state.players[0].resources[0].card = { id: 'sm', def: 'smuggler' }
  // Smuggle 3, Cunning off-aspect: 3 + 2
  state.players[0].resources.slice(4).forEach((r) => (r.exhausted = true))
  assert.ok(!legalActions(state, 0).some((a) => a.type === 'play' && a.smuggle), '4 ready, 5 to pay')
  state.players[0].resources[4].exhausted = false
  state = act(state, 0, { type: 'play', card: 'sm', smuggle: true })
  assert.ok(state.players[0].units.some((u) => u.id === 'sm'))
  assert.deepEqual(state.players[0].resources[0], { card: { id: 'd0', def: 'big' }, exhausted: true })
  assert.equal(state.players[0].resources.filter((r) => !r.exhausted).length, 0)
  assert.equal(state.players[0].spice.length, 3, 'its own, and 2 for the When Played and the Smuggle bonus')
  assert.ok(state.log.some((l) => /plays Spice Smuggler using Smuggle/.test(l.text)))
})

test('Plot cards are played from the resources when the leader deploys', () => {
  let state = table({ deck0: ['big'] })
  state.players[0].resources[0].card = { id: 'pl', def: 'plotter' }
  state = act(state, 0, { type: 'deploy' })
  assert.deepEqual(state.prompt?.options.map((o) => o.id), ['pl'])
  state = answer(state, 'pl')
  assert.ok(state.players[0].units.some((u) => u.id === 'pl'))
  assert.equal(state.players[0].resources[0].card.def, 'big')
})

test('Fremen tokens: created, readied, Raid 1 with an Arrakis base, set aside when defeated', () => {
  let state = table({ hand0: ['desertPower'], units1: ['big'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  const fremen = state.players[0].units
  assert.equal(fremen.length, 3)
  assert.ok(fremen.every((u) => !u.exhausted))
  assert.equal(scriptStatus(state.defs[fremen[0].def]), 'scripted', 'its text is the engine’s')
  state.active = 0
  state = act(state, 0, { type: 'attack', attacker: fremen[0].id, target: 'base' })
  assert.equal(state.players[1].base.damage, 3, '2 power, Raid 1')
  state.active = 0
  state = act(state, 0, { type: 'attack', attacker: fremen[1].id, target: 'u10' })
  assert.equal(state.players[0].units.length, 2)
  assert.deepEqual(state.players[0].discard.map((c) => c.def), ['desertPower'], 'the token is not discarded')
})

test('a When Defeated Spice token, and tokens on a defeated unit are set aside', () => {
  let state = table({ units0: ['runner'], units1: ['big'] })
  state.players[0].units[0].upgrades.push({ id: 'x', def: 'token-experience', owner: 0 })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  assert.deepEqual(state.players[0].discard.map((c) => c.def), ['runner'])
  assert.equal(state.players[0].spice.length, 2)
  assert.throws(() => act(state, 0, { type: 'pass' }), IllegalAction, 'the turn passed')
})

test('Imperial Household Guard: Sentinel and +1/+0 while it has a Shield token', () => {
  const state = table({ units0: ['household'] })
  const guard = state.players[0].units[0]
  assert.equal(powerOf(state, guard), 2)
  assert.ok(!keywordsOf(state, guard).sentinel)
  guard.upgrades.push({ id: 's', def: 'token-shield', owner: 0 })
  assert.equal(powerOf(state, guard), 3)
  assert.ok(keywordsOf(state, guard).sentinel)
})

test('Sardaukar Executioner defeats a damaged non-leader defender before combat damage; others fight', () => {
  let state = table({ units0: ['executioner'], units1: ['big'] })
  state.players[1].units[0].damage = 1
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  assert.deepEqual(state.players[1].units, [])
  assert.equal(state.players[0].units[0].damage, 0, 'no damage back')
  state = table({ units0: ['executioner'], units1: ['crusher'] })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  assert.equal(state.players[1].units[0].damage, 5)
  // Nor a damaged leader
  state = table({ units0: ['executioner'], units1: ['leader'] })
  state.players[1].units[0].leader = true
  state.players[1].units[0].damage = 1
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  assert.equal(state.players[0].units[0].damage, 3, 'the leader fought back')
})

test('Sardaukar Burseg: other friendly Sardaukar units get +1/+1', () => {
  const state = table({ units0: ['burseg', 'executioner', 'big'], units1: ['executioner'] })
  const [burseg, executioner, big] = state.players[0].units
  assert.equal(powerOf(state, executioner), 6)
  assert.equal(hpOf(state, executioner), 5)
  assert.equal(powerOf(state, burseg), 4, 'not itself')
  assert.equal(powerOf(state, big), 5, 'not others')
  assert.equal(powerOf(state, state.players[1].units[0]), 5, 'not enemies')
})

test('False Colors: a Sardaukar unit for 2 less, no Spice spent, with Ambush and the Harkonnen trait', () => {
  let state = table({ hand0: ['falseColors', 'executioner'], units1: ['trooper'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, 'h1')
  assert.match(state.prompt!.text, /Ambush/)
  state = answer(state, 'u10')
  assert.deepEqual(state.players[1].units, [])
  const executioner = state.players[0].units[0]
  assert.equal(state.players[0].spice.length, 1, 'its additional cost ignored')
  assert.equal(state.players[0].resources.filter((r) => !r.exhausted).length, 2, '2, then 4 - 2')
  assert.ok(traitsOf(state, executioner).includes('Harkonnen'))
})

test("The Emperor's Terror readies friendly Sardaukar units with +2/+0 and Overwhelm", () => {
  let state = table({ units0: ['executioner', 'big'], hand0: ['terror'] })
  for (const u of state.players[0].units) u.exhausted = true
  state = act(state, 0, { type: 'play', card: 'h0' })
  const [executioner, big] = state.players[0].units
  assert.ok(!executioner.exhausted)
  assert.equal(powerOf(state, executioner), 7)
  assert.ok(keywordsOf(state, executioner).overwhelm)
  assert.ok(big.exhausted, 'not a Sardaukar')
  assert.equal(powerOf(state, big), 5)
})

test('Shaddam IV, Lion Throne: 2 Spice tokens, then each one for 3 damage, 1 to the base or 2 Experience tokens', () => {
  let state = table({ units0: ['trooper', 'household'], units1: ['big'], hand0: ['shaddam'] })
  state.players[0].units[1].upgrades.push({ id: 's', def: 'token-shield', owner: 0 })
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.equal(state.players[0].spice.length, 3, 'the Arrakis one and 2 more')
  assert.deepEqual(state.prompt!.options.map((o) => o.label?.replace('Defeat a Spice token: ', '')), [
    'Stop',
    'Deal 3 damage to an enemy unit',
    'Deal 1 damage to an enemy base',
    'Give 2 Experience tokens to a friendly unit with no upgrades',
  ])
  state = answer(state, '1')
  state = answer(state, 'u10')
  assert.equal(state.players[1].units[0].damage, 3)
  state = answer(state, '2')
  assert.equal(state.players[1].base.damage, 1)
  state = answer(state, '3')
  // Only the units with no upgrades: not the Shielded guard, nor Shaddam once he has the tokens
  assert.deepEqual(state.prompt!.options.map((o) => o.id).sort(), ['u00', state.players[0].units[2].id].sort())
  state = answer(state, 'u00')
  assert.equal(state.players[0].units[0].upgrades.length, 2)
  assert.equal(state.players[0].spice.length, 0)
  assert.equal(state.prompt, null, 'no Spice token left to spend')
})

test("Imperial Tithe Collector: an opponent's Spice token for one of yours and an Experience token, when there is one", () => {
  let state = table({ hand0: ['collector'], units1: ['trooper'] })
  state.players[1].spice = [{ id: 'enemySpice', def: state.players[0].spice[0].def }]
  state = act(state, 0, { type: 'play', card: 'h0' })
  const collector = state.players[0].units[0]
  assert.equal(state.players[1].spice.length, 0)
  assert.equal(state.players[0].spice.length, 2)
  assert.equal(powerOf(state, collector), 5)
  assert.equal(hpOf(state, collector), 7)
  assert.ok(keywordsOf(state, collector).sentinel)
  // None to take: nothing at all
  state = table({ units0: ['collector'], units1: ['trooper'] })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  assert.equal(state.players[0].spice.length, 1)
  assert.equal(state.players[0].units[0].upgrades.length, 0)
})

test("Shaddam IV's Action: a Sardaukar unit with no Spice token costs only its cost, and it may be taken back", () => {
  let state = table({ base0: 'caladan', hand0: ['burseg', 'executioner'] })
  state.players[0].leader.def = 'shaddamLeader'
  state.players[0].resources = state.players[0].resources.slice(0, 5)
  const use: Action = { type: 'ability', source: 'leader', index: 0 }
  state = act(state, 0, use)
  assert.deepEqual(state.prompt!.options.map((o) => o.id), ['h0', 'h1'], 'Burseg, 5 for 5 ready resources')
  assert.ok(state.prompt!.cancel)
  const before = state
  state = act(state, 0, { type: 'cancel' })
  assert.equal(state.prompt, null)
  assert.ok(!state.players[0].leader.exhausted, 'the leader ready again')
  assert.equal(state.players[0].hand.length, 2)
  assert.equal(state.active, 0, 'still your turn')
  state = act(before, 0, { type: 'answer', picks: ['h0'] })
  assert.equal(state.players[0].units[0].def, 'burseg')
  assert.equal(state.players[0].resources.filter((r) => !r.exhausted).length, 0)
})

test('Sardaukar Legion: up to 2 Spice tokens, each for 3 cost of revealed Sardaukar units played free', () => {
  let state = table({ hand0: ['legion'], deck0: ['burseg', 'executioner', 'trooper', 'bashar'] })
  state.players[0].resources = Array.from({ length: 7 }, (_, i) => ({ card: { id: `r${i}`, def: 'trooper' }, exhausted: false }))
  const token = state.players[0].spice[0]
  state.players[0].spice = [0, 1, 2, 3].map((i) => ({ ...token, id: `spice${i}` }))
  state = act(state, 0, { type: 'play', card: 'h0' })
  // One spent on its additional cost: 3 left, at most 2 of them for the units
  assert.deepEqual(state.prompt!.options.map((o) => o.label), ['0 (up to 0 cost)', '1 (up to 3 cost)', '2 (up to 6 cost)'])
  state = answer(state, '2')
  state = answer(state, 'd0')
  assert.equal(state.players[0].spice.length, 1)
  // 1 cost left: neither the Executioner nor the Bashar, the cards searched only shown
  assert.deepEqual(state.prompt!.options, [])
  state = answer(state)
  assert.equal(state.prompt, null)
  assert.deepEqual(state.players[0].units.map((u) => u.def).sort(), ['burseg', 'legion'])
})

test('Sardaukar Troop Carrier: the next Trooper unit played this phase costs 1 less, and each discount waiting adds up', () => {
  let state = table({ hand0: ['carrier', 'soldier', 'soldier'] })
  const ready = (s: GameState) => s.players[0].resources.filter((r) => !r.exhausted).length
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.equal(ready(state), 4)
  state.active = 0
  state = act(state, 0, { type: 'play', card: 'h1' })
  assert.equal(ready(state), 3, 'the first Trooper for 1')
  state.active = 0
  state = act(state, 0, { type: 'play', card: 'h2' })
  assert.equal(ready(state), 1, 'the second one at full cost')
  // When Played and On Attack the same phase: 2 less for the next one
  state = table({ hand0: ['carrier', 'soldier'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  state.players[0].units[0].exhausted = false
  state.active = 0
  state = act(state, 0, { type: 'attack', attacker: state.players[0].units[0].id, target: 'base' })
  state.active = 0
  state = act(state, 0, { type: 'play', card: 'h1' })
  assert.equal(ready(state), 4, 'the soldier for 0')
})

test("Kynes's Dream: heal 3 from a unit or base, then 3 from your base for each of up to 2 Spice tokens", () => {
  let state = table({ hand0: ['kynesDream'] })
  state.players[0].spice.push({ id: 'spice2', def: state.players[0].spice[0].def })
  state.players[0].base.damage = 10
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, 'base0')
  assert.equal(state.players[0].base.damage, 7)
  assert.equal(state.prompt!.options.length, 3, '0, 1 or 2 Spice tokens')
  state = answer(state, '2')
  assert.equal(state.players[0].base.damage, 1)
  assert.equal(state.players[0].spice.length, 0)
})

test('House Levy: a unit from the top 5, and a second Trooper unit when the first is one', () => {
  let state = table({ hand0: ['levy'], deck0: ['big', 'soldier', 'soldier', 'trooper', 'guard', 'big'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, 'd1')
  assert.deepEqual(state.prompt!.options.map((o) => o.id), ['d2'], 'only the other Trooper')
  state = answer(state, 'd2')
  assert.deepEqual(state.players[0].hand.map((c) => c.id), ['d1', 'd2'])
  assert.equal(state.players[0].deck[0].id, 'd5', 'the rest to the bottom')
  // Not a Trooper: just the one
  state = table({ hand0: ['levy'], deck0: ['big', 'soldier', 'guard'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, 'd0')
  assert.equal(state.prompt, null)
  assert.deepEqual(state.players[0].hand.map((c) => c.id), ['d0'])
})

test('Crossfire: two Trooper attacks with Saboteur and +1/+0', () => {
  let state = table({ hand0: ['crossfire'], units0: ['soldier', 'soldier', 'big'], units1: ['guard'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.deepEqual(state.prompt!.options.map((o) => o.id), ['u00', 'u01'], 'Troopers only')
  state = answer(state, 'u00')
  assert.ok(state.prompt!.options.some((o) => o.id === 'base1'), 'past the Sentinel')
  state = answer(state, 'base1')
  assert.equal(state.players[1].base.damage, 3)
  assert.deepEqual(state.prompt!.options.map((o) => o.id), ['u01'])
  state = answer(state, 'u01')
  state = answer(state, 'base1')
  assert.equal(state.players[1].base.damage, 6)
  assert.equal(powerOf(state, state.players[0].units[0]), 2, 'only for the attack')
  assert.ok(!keywordsOf(state, state.players[0].units[0]).saboteur)
})

test('Plans Within Plans: +2/+0 for the attack, or +4/+0 for a Spice token', () => {
  let state = table({ hand0: ['plans', 'plans'], units0: ['trooper', 'big'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, 'u00')
  state = answer(state, 'yes')
  state = answer(state, 'base1')
  assert.equal(state.players[1].base.damage, 6)
  assert.equal(state.players[0].spice.length, 0)
  state.active = 0
  state = act(state, 0, { type: 'play', card: 'h1' })
  state = answer(state, 'u01')
  assert.deepEqual(state.prompt!.options.map((o) => o.id), ['base1'], 'no Spice left to ask for')
  state = answer(state, 'base1')
  assert.equal(state.players[1].base.damage, 13)
})
