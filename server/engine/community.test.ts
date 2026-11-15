import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyAction, createGame, hpOf, isLeaderUnit, keywordsOf, legalActions, powerOf } from './game.ts'
import { readText } from './cards.ts'
import { communityScripts } from './community.ts'
import { scriptStatus } from './scripts.ts'
import type { Action, CardDef, GameState, PlayerId, UnitState } from './types.ts'

// zverev20's Splatoon cards: the Ink token and the cards that give it, each a community card
// carrying its key, as the engine knows a supported one
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
const community = (name: string) => {
  const script = communityScripts.find((s) => s.name === name)!
  return { name, community: script.card, ...readText(script.text), text: script.text, backText: script.backText, pilotText: script.pilotText }
}

const defs: CardDef[] = [
  card('leader', { type: 'leader', cost: 4, unit: { power: 3, hp: 6, arena: 'ground', keywords: {} } }),
  card('octavio', {
    ...community('DJ Octavio'),
    type: 'leader',
    cost: 5,
    unit: { power: 4, hp: 6, arena: 'ground', keywords: {}, pilot: { power: 2, hp: 2 } },
    makesLeader: true,
  }),
  card('vehicle', { cost: 3, power: 3, hp: 5, traits: ['Vehicle'] }),
  card('pilotUnit', {
    cost: 3,
    power: 2,
    hp: 2,
    traits: ['Pilot'],
    piloting: 2,
    upgrade: { power: 2, hp: 1 },
    pilotText: '[Piloting] [[2]]\nAttached unit gains [Raid 1].',
    attachedKeywords: { raid: 1 },
  }),
  card('plain', { type: 'base', hp: 30 }),
  card('ink', { ...community('Ink'), type: 'upgrade', token: true, arena: undefined }),
  card('whirl', { ...community('Octowhirl'), cost: 6, power: 5, hp: 6 }),
  card('nozzle', { ...community('Octonozzle'), cost: 4, power: 2, hp: 6 }),
  card('stomp', { ...community('Octostomp'), cost: 5, power: 5, hp: 5 }),
  card('copter', { ...community('Octocopter'), cost: 2, power: 2, hp: 2 }),
  card('trooper', { ...community('Octotrooper'), cost: 2, power: 2, hp: 2 }),
  card('squee', { ...community('Squee-G'), cost: 1, power: 1, hp: 1 }),
  card('zapfish', { ...community('Imprisoned Zapfish'), cost: 2, power: 1, hp: 3 }),
  card('octobot', { ...community('Enter the Octobot!'), type: 'event', cost: 3, arena: undefined }),
  card('maw', { cost: 6, power: 5, hp: 7, traits: ['Octarian', 'Octoweapon', 'Droid'] }),
  card('big', { cost: 5, power: 5, hp: 5 }),
  card('small', { cost: 1, power: 1, hp: 4 }),
  card('drone', { cost: 1, power: 1, hp: 1, traits: ['Droid'] }),
]

const act = (state: GameState, p: PlayerId, action: Action) => applyAction(state, p, action)
const answer = (state: GameState, ...picks: string[]) => act(state, state.prompt!.player, { type: 'answer', picks })
const yes = (state: GameState) => answer(state, 'yes')

function table(o: { leader0?: string; units0?: string[]; units1?: string[]; hand0?: string[]; deck0?: string[] } = {}) {
  let state = createGame({
    seed: 3,
    defs,
    decks: [
      { name: 'One', leader: o.leader0 ?? 'leader', base: 'plain', deck: o.deck0 ?? Array(20).fill('big') },
      { name: 'Two', leader: 'leader', base: 'plain', deck: Array(20).fill('big') },
    ],
  })
  state = act(state, state.chooser, { type: 'first', goFirst: true })
  state = act(state, state.initiative, { type: 'mulligan', take: false })
  state = act(state, state.initiative === 0 ? 1 : 0, { type: 'mulligan', take: false })
  for (const p of [0, 1] as const) state = act(state, p, { type: 'resource', cards: state.players[p].hand.slice(0, 2).map((c) => c.id) })
  state.active = 0
  const place = (p: PlayerId, ids: string[]): UnitState[] =>
    ids.map((id, i) => ({ id: `u${p}${i}`, def: id, owner: p, arena: 'ground', damage: 0, exhausted: false, upgrades: [] }))
  state.players[0].units = place(0, o.units0 ?? [])
  state.players[1].units = place(1, o.units1 ?? [])
  state.players[0].hand = (o.hand0 ?? []).map((id, i) => ({ id: `h${i}`, def: id }))
  for (const pl of state.players) pl.resources = Array.from({ length: 8 }, (_, i) => ({ card: { id: `r${pl.name}${i}`, def: 'big' }, exhausted: false }))
  return state
}
const inkOn = (state: GameState, id: string) =>
  [...state.players[0].units, ...state.players[1].units].find((u) => u.id === id)!.upgrades.filter((u) => u.def === 'ink').length
const unit = (state: GameState, id: string) => [...state.players[0].units, ...state.players[1].units].find((u) => u.id === id)

test('every Splatoon card is scripted for its text', () => {
  for (const d of defs.filter((d) => d.community)) assert.equal(scriptStatus(d), 'scripted', d.name)
})

test('Ink: the attached unit takes 1 more combat damage, then the token is defeated', () => {
  let state = table({ units0: ['big'], units1: ['small'] })
  state.players[1].units[0].upgrades.push({ id: 'k1', def: 'ink', owner: 0 })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  // 5 power, plus 1: a 4 HP unit is defeated either way; check on a sturdier one below
  assert.equal(unit(state, 'u10'), undefined)
  let other = table({ units0: ['small'], units1: ['big'] })
  other.players[1].units[0].upgrades.push({ id: 'k1', def: 'ink', owner: 0 })
  other = act(other, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  assert.equal(unit(other, 'u10')!.damage, 2, '1 combat damage plus 1')
  assert.equal(inkOn(other, 'u10'), 0, 'the Ink token is defeated')
})

test("Ink doesn't change damage that isn't combat damage", () => {
  let state = table({ units1: ['big'], hand0: ['whirl'] })
  state.players[1].units[0].upgrades.push({ id: 'k1', def: 'ink', owner: 0 })
  state.players[1].units[0].damage = 0
  // Octowhirl's On Attack deals 1 to each inked enemy unit: 1, not 2
  state.players[0].units = [{ id: 'u00', def: 'whirl', owner: 0, arena: 'ground', damage: 0, exhausted: false, upgrades: [] }]
  state.players[1].units.push({ id: 'u11', def: 'small', owner: 1, arena: 'ground', damage: 0, exhausted: false, upgrades: [] })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'base' })
  state = yes(state)
  assert.equal(unit(state, 'u10')!.damage, 1)
  assert.equal(inkOn(state, 'u10'), 1, 'still there')
  assert.equal(unit(state, 'u11')!.damage, 0, 'no Ink, no damage')
})

test('Octowhirl gives each enemy unit an Ink token as it is played', () => {
  let state = table({ units1: ['big', 'small'], hand0: ['whirl'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.equal(inkOn(state, 'u10'), 1)
  assert.equal(inkOn(state, 'u11'), 1)
})

test('Octonozzle may give the attacker an Ink token when the defense ends', () => {
  let state = table({ units0: ['small'], units1: ['nozzle'] })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  assert.equal(state.prompt?.player, 1)
  state = yes(state)
  assert.equal(inkOn(state, 'u00'), 1)
})

test('Octonozzle gives its Ink token even when it is defeated defending', () => {
  let state = table({ units0: ['whirl'], units1: ['nozzle'] })
  state.players[1].units[0].damage = 3
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  assert.equal(unit(state, 'u10'), undefined)
  state = yes(state)
  assert.equal(inkOn(state, 'u00'), 1)
})

test('Octostomp distributes up to 3 Ink tokens when it deals combat damage to a unit', () => {
  let state = table({ units0: ['stomp'], units1: ['big', 'small'] })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  state = answer(state, 'u11')
  state = answer(state, 'u11')
  state = answer(state)
  assert.equal(inkOn(state, 'u11'), 2, 'stopped after 2')
})

test('Octocopter gives the defending unit an Ink token when the attack ends; Octotrooper may', () => {
  let state = table({ units0: ['copter'], units1: ['big'] })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  // 2 HP against 5 power: the Octocopter is defeated, and its attack still ends
  assert.equal(unit(state, 'u00'), undefined)
  assert.equal(inkOn(state, 'u10'), 1)
  state = table({ units0: ['copter'], units1: ['small'] })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  assert.equal(inkOn(state, 'u10'), 1)
  state = table({ units0: ['trooper'], units1: ['small'] })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  state = yes(state)
  assert.equal(inkOn(state, 'u10'), 1)
})

test('Squee-G, defeated, may defeat all upgrades on a friendly unit', () => {
  let state = table({ units0: ['squee', 'big'], units1: ['big'] })
  state.players[0].units[1].upgrades.push({ id: 'k1', def: 'ink', owner: 1 }, { id: 'k2', def: 'ink', owner: 1 })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  state = answer(state, 'u01')
  assert.equal(unit(state, 'u01')!.upgrades.length, 0)
})

test('Imprisoned Zapfish may give a Shield token to a friendly Vehicle or Droid unit', () => {
  let state = table({ units0: ['drone', 'big'], hand0: ['zapfish'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  // Shielded and When Played: its own Shield first
  state = answer(state, '0')
  assert.deepEqual(state.prompt!.options.map((o) => o.id), ['u00'], 'the Droid only')
  state = answer(state, 'u00')
  assert.equal(unit(state, 'u00')!.upgrades.length, 1)
})

test('Enter the Octobot! draws an Octoweapon unit from the top 10 and may play it for free', () => {
  let state = table({ hand0: ['octobot'], deck0: ['big', 'big', 'maw', ...Array(17).fill('big')] })
  state.players[0].deck = [{ id: 'd0', def: 'big' }, { id: 'd1', def: 'maw' }, ...Array.from({ length: 15 }, (_, i) => ({ id: `d${i + 2}`, def: 'big' }))]
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, 'd1')
  state = yes(state)
  assert.ok(state.players[0].units.some((u) => u.def === 'maw'), 'in play')
})

test('DJ Octavio: his Action gives an Ink token for each friendly unit; deployed, each friendly unit inks a different enemy', () => {
  let state = table({ leader0: 'octavio', units0: ['small', 'small'], units1: ['big', 'small'] })
  state = act(state, 0, { type: 'ability', source: 'leader', index: 0 })
  state = answer(state, 'u10')
  state = answer(state, 'u10')
  assert.equal(inkOn(state, 'u10'), 2)
  state = table({ leader0: 'octavio', units0: ['small'], units1: ['big', 'small'] })
  state = act(state, 0, { type: 'deploy' })
  // Two friendly units now, him and the small one: an Ink token each to two different enemies
  state = answer(state, 'u10', 'u11')
  assert.equal(inkOn(state, 'u10'), 1)
  assert.equal(inkOn(state, 'u11'), 1)
})

test('a pilot may be played as an upgrade on a friendly Vehicle without a Pilot, for its Piloting cost', () => {
  let state = table({ units0: ['vehicle', 'big'], units1: ['vehicle'], hand0: ['pilotUnit', 'pilotUnit'] })
  const pilotPlays = legalActions(state, 0).filter((a) => a.type === 'play' && a.pilot)
  assert.deepEqual([...new Set(pilotPlays.map((a) => a.type === 'play' && a.attachTo))], ['u00'], 'the friendly Vehicle only')
  assert.ok(legalActions(state, 0).some((a) => a.type === 'play' && a.card === 'h0' && !a.pilot), 'or as a unit')
  const ready = state.players[0].resources.filter((r) => !r.exhausted).length
  state = act(state, 0, { type: 'play', card: 'h0', attachTo: 'u00', pilot: true })
  assert.equal(ready - state.players[0].resources.filter((r) => !r.exhausted).length, 2, 'Piloting 2')
  const vehicle = unit(state, 'u00')!
  assert.equal(powerOf(state, vehicle), 5, '3 + 2')
  assert.equal(hpOf(state, vehicle), 6, '5 + 1')
  assert.equal(keywordsOf(state, vehicle).raid, 1)
  state.active = 0
  assert.ok(!legalActions(state, 0).some((a) => a.type === 'play' && a.pilot), 'one Pilot on it already')
})

test('a pilot goes to the discard pile with its Vehicle', () => {
  let state = table({ units0: ['vehicle'], units1: ['big'] })
  state.players[0].units[0].upgrades.push({ id: 'p1', def: 'pilotUnit', owner: 0 })
  state.players[0].units[0].damage = 5
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  assert.ok(state.players[0].discard.some((c) => c.id === 'p1'))
})

test('DJ Octavio deploys as a pilot: his Vehicle is a leader unit, inks as it attacks, and he returns when it falls', () => {
  let state = table({ leader0: 'octavio', units0: ['vehicle'], units1: ['big', 'small'] })
  assert.ok(legalActions(state, 0).some((a) => a.type === 'deploy' && a.attachTo === 'u00'))
  state = act(state, 0, { type: 'deploy', attachTo: 'u00' })
  // When Deployed: one friendly unit, so 1 Ink token
  state = answer(state, 'u10')
  assert.equal(inkOn(state, 'u10'), 1)
  const vehicle = unit(state, 'u00')!
  assert.ok(isLeaderUnit(state, vehicle), 'Attached unit is a leader unit.')
  assert.equal(powerOf(state, vehicle), 5, '3 + 2')
  assert.ok(state.players[0].leader.deployed)
  // On Attack, from his Piloting box
  state.active = 0
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'base' })
  state = answer(state, 'u11')
  assert.equal(inkOn(state, 'u11'), 1)
  // Defeated with it: back to the base zone, exhausted, and deployable no more (Epic Action used)
  // 7 HP with him: 6 damage, and the enemy's 5-power unit finishes it
  unit(state, 'u00')!.damage = 6
  state.active = 1
  state = act(state, 1, { type: 'attack', attacker: 'u10', target: 'u00' })
  assert.equal(unit(state, 'u00'), undefined)
  assert.equal(state.players[0].leader.deployed, false)
  assert.equal(state.players[0].leader.exhausted, true)
})
