import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyAction, createGame } from './game.ts'
import { scripts, scriptStatus } from './scripts.ts'
import { viewFor } from './view.ts'
import { IllegalAction, type Action, type CardDef, type GameState, type PlayerId, type UnitState } from './types.ts'

// Test cards with the name and text of scripted DUNE cards, so their scripts play them
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
const scripted = (name: string) => {
  const script = scripts.find((s) => s.name === name)!
  return { name, subtitle: script.subtitle, text: script.text, backText: script.backText }
}

const defs: CardDef[] = [
  card('rabban', {
    ...scripted('Glossu Rabban'),
    type: 'leader',
    cost: 5,
    aspects: ['Aggression', 'Villainy'],
    unit: { power: 4, hp: 6, arena: 'ground', keywords: { overwhelm: true } },
  }),
  card('chani', { type: 'leader', cost: 4, unit: { power: 2, hp: 5, arena: 'ground', keywords: {} } }),
  card('base', { type: 'base', hp: 30 }),
  card('trooper', { cost: 1, power: 2, hp: 2 }),
  card('brute', { cost: 3, power: 3, hp: 6, traits: ['Harkonnen'] }),
  card('thopter', { ...scripted("Strike 'Thopter"), cost: 2, power: 2, hp: 3, arena: 'space' }),
  card('initiate', { ...scripted('Bene Gesserit Initiate'), cost: 2, power: 2, hp: 1, keywords: { restore: 1 } }),
  card('troops', { ...scripted('Harkonnen Troops'), cost: 1, power: 2, hp: 1 }),
  card('flamer', { ...scripted('Harkonnen Flamer'), cost: 2, power: 3, hp: 2 }),
  card('kanly', { ...scripted('Kanly'), type: 'event', cost: 2, arena: undefined }),
  card('mystery', { type: 'event', cost: 1, text: 'Something no script plays yet.', arena: undefined }),
]

const act = (state: GameState, p: PlayerId, action: Action) => applyAction(state, p, action)
const answer = (state: GameState, ...picks: string[]) => act(state, state.prompt!.player, { type: 'answer', picks })

// Player 0 to act in the action phase, Rabban against Chani, with these units and hands
function table(units0: string[], units1: string[], hand0: string[] = [], hand1: string[] = []) {
  let state = createGame({
    seed: 11,
    defs,
    decks: [
      { name: 'Rabban', leader: 'rabban', base: 'base', deck: Array(20).fill('trooper') },
      { name: 'Chani', leader: 'chani', base: 'base', deck: Array(20).fill('trooper') },
    ],
  })
  state = act(state, state.chooser, { type: 'first', goFirst: true })
  state = act(state, state.initiative, { type: 'mulligan', take: false })
  state = act(state, state.initiative === 0 ? 1 : 0, { type: 'mulligan', take: false })
  for (const p of [0, 1] as const)
    state = act(state, p, { type: 'resource', cards: state.players[p].hand.slice(0, 2).map((c) => c.id) })
  state.active = 0
  const place = (p: PlayerId, ids: string[]): UnitState[] =>
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
  state.players[0].hand = hand0.map((id, i) => ({ id: `h0${i}`, def: id }))
  state.players[1].hand = hand1.map((id, i) => ({ id: `h1${i}`, def: id }))
  for (const pl of state.players) pl.resources = Array.from({ length: 6 }, (_, i) => ({ card: { id: `r${i}`, def: 'trooper' }, exhausted: false }))
  return state
}

test('a card whose text matches its script plays it; other text does nothing yet', () => {
  assert.equal(scriptStatus(defs.find((d) => d.id === 'thopter')!), 'scripted')
  assert.equal(scriptStatus({ ...defs.find((d) => d.id === 'thopter')!, text: 'Changed text.' }), 'outdated')
  assert.equal(scriptStatus(defs.find((d) => d.id === 'mystery')!), 'none')
  assert.equal(scriptStatus(defs.find((d) => d.id === 'trooper')!), 'blank')
  const state = act(table([], [], ['mystery']), 0, { type: 'play', card: 'h00' })
  assert.ok(state.log.some((l) => /mystery's text doesn't do anything yet/.test(l.text)))
})

test('a When Played ability asks for its target, and the turn passes once it is answered', () => {
  let state = table([], ['trooper', 'brute'], ['thopter'])
  state = act(state, 0, { type: 'play', card: 'h00' })
  // "You may": any ground unit, or none
  assert.deepEqual(state.prompt?.options.map((o) => o.id), ['u10', 'u11'])
  assert.equal(state.prompt?.min, 0)
  assert.equal(state.active, 0, 'still player 0, until the ability is done')
  assert.ok(state.players[0].units.some((u) => u.def === 'thopter'), 'the unit is in play while the question is open')
  assert.throws(() => answer(state, 'base1'), IllegalAction)
  assert.throws(() => act(state, 1, { type: 'pass' }), IllegalAction)
  const done = answer(state, 'u10')
  assert.equal(done.prompt, null)
  assert.equal(done.players[1].units[0].damage, 1)
  assert.equal(done.active, 1)
  // Answering with nothing skips the damage
  assert.equal(answer(state).players[1].units[0].damage, 0)
})

test('an opponent answers the question put to them, and only they see its choices', () => {
  let state = table([], [], ['initiate'], ['trooper', 'brute'])
  state = act(state, 0, { type: 'play', card: 'h00' })
  assert.equal(state.prompt?.player, 1)
  assert.equal(state.prompt?.options.length, 2)
  const theirs = viewFor(state, 1)
  const mine = viewFor(state, 0)
  assert.ok(theirs.prompt && 'options' in theirs.prompt)
  assert.ok(mine.prompt && !('options' in mine.prompt), 'the player who asked does not see the hand')
  assert.deepEqual(mine.actions, [])
  state = answer(state, 'h11')
  assert.deepEqual(state.players[1].hand.map((c) => c.def), ['trooper'])
  assert.deepEqual(state.players[1].discard.map((c) => c.def), ['brute'])
  assert.equal(state.active, 1, 'the turn passed')
})

test('When Defeated abilities resolve after combat, the active player\'s first', () => {
  // Rabban's Troops attack Chani's Flamer: both are defeated
  let state = table(['troops'], ['flamer', 'trooper'])
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  assert.equal(state.prompt?.player, 0, 'the Troops ask first')
  assert.match(state.prompt!.text, /deal 1 damage/)
  state = answer(state, 'u11')
  // Then the Flamer deals 1 damage to each enemy ground unit: none are left
  assert.equal(state.prompt, null)
  assert.equal(state.players[1].units[0].damage, 1, "the trooper took the Troops' 1 damage")
  assert.deepEqual(state.players[0].units, [])
  assert.equal(state.players[0].discard.length + state.players[1].discard.length, 2)
})

test('an Action ability pays its cost, exhausts the leader and can make an attack', () => {
  let state = table(['brute'], ['trooper'])
  const ability: Action = { type: 'ability', source: 'leader', index: 0 }
  state = act(state, 0, ability)
  assert.deepEqual(state.prompt?.options.map((o) => o.id), ['u00'])
  state = answer(state, 'u00')
  // 1 damage to the brute, then it attacks: the trooper or the base
  assert.deepEqual(state.prompt?.options.map((o) => o.id), ['u10', 'base1'])
  state = answer(state, 'base1')
  assert.equal(state.players[1].base.damage, 5, '3 power, +2 for a Harkonnen unit')
  assert.equal(state.players[0].units[0].damage, 1)
  assert.ok(state.players[0].leader.exhausted)
  assert.deepEqual(state.effects, [], 'the +2 lasted for the attack only')
  assert.equal(state.active, 1)
  // Exhausted, the leader can't do it again this round
  state.active = 0
  assert.throws(() => act(state, 0, ability), IllegalAction)
})

test('a deployed leader\'s ability triggers when another friendly unit attacks', () => {
  let state = table(['trooper'], [])
  state.players[0].units.push({ id: 'L0', def: 'rabban', owner: 0, arena: 'ground', damage: 0, exhausted: true, leader: true, upgrades: [] })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'base' })
  assert.equal(state.prompt?.kind, 'option')
  state = answer(state, 'yes')
  // The trooper (2 HP) took 1 damage and hits for 2 + 1
  assert.equal(state.players[1].base.damage, 3)
  assert.equal(state.players[0].units.find((u) => u.id === 'u00')?.damage, 1)
})

test('an event with a choice and a "you may"; the same answers give the same game', () => {
  let state = table(['trooper', 'brute'], ['brute'], ['kanly'])
  state = act(state, 0, { type: 'play', card: 'h00' })
  state = answer(state, 'u10')
  assert.equal(state.players[1].units[0].damage, 2)
  // Defeat the friendly brute (3 power) to finish the enemy brute (6 HP, 2 damage)? 2 + 3 = 5: not quite
  state = answer(state, 'u01')
  assert.equal(state.players[1].units[0].damage, 5)
  assert.ok(!state.players[0].units.some((u) => u.id === 'u01'))
  assert.deepEqual(state.players[0].discard.map((c) => c.def).sort(), ['brute', 'kanly'])
})

test('a player may concede while a question is open', () => {
  let state = table([], ['trooper'], ['thopter'])
  state = act(state, 0, { type: 'play', card: 'h00' })
  state = act(state, 1, { type: 'concede' })
  assert.equal(state.winner, 0)
  assert.equal(state.prompt, null)
})
