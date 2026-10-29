import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyAction, createGame, legalActions } from './game.ts'
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
  assert.equal(fremen.length, 2)
  assert.ok(fremen.every((u) => !u.exhausted))
  assert.equal(scriptStatus(state.defs[fremen[0].def]), 'scripted', 'its text is the engine’s')
  state.active = 0
  state = act(state, 0, { type: 'attack', attacker: fremen[0].id, target: 'base' })
  assert.equal(state.players[1].base.damage, 3, '2 power, Raid 1')
  state.active = 0
  state = act(state, 0, { type: 'attack', attacker: fremen[1].id, target: 'u10' })
  assert.equal(state.players[0].units.length, 1)
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
