import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyAction, createGame, hpOf, isLeaderUnit, keywordsOf, legalActions, powerOf, waitingFor } from './game.ts'
import { readText } from './cards.ts'
import { communityScripts } from './community.ts'
import { scriptStatus } from './scripts.ts'
import { chooseAction } from './ai.ts'
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

// By its key: two community cards may share a name (two Octozeppelins)
const communityKey = (key: string) => {
  const script = communityScripts.find((s) => s.card === key)!
  return { name: script.name, community: script.card, ...readText(script.text), text: script.text, backText: script.backText, pilotText: script.pilotText }
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
  card('xp', { name: 'Experience', type: 'upgrade', token: true, power: 1, hp: 1, arena: undefined }),
  card('vulnerable', { ...community('Attack the Vulnerable'), type: 'event', cost: 3, arena: undefined }),
  card('elite', { ...community('Elite Octoling'), cost: 4, power: 2, hp: 5 }),
  card('torpedo', { ...community('Octorpedo'), cost: 3, power: 0, hp: 4, arena: 'space' }),
  card('marina', { ...community('Marina'), cost: 3, power: 3, hp: 3, unique: true }),
  card('twintacle', { ...community('Shielded Twintacle Octotrooper'), cost: 4, power: 3, hp: 3 }),
  card('zeppelin', { ...community('Octozeppelin'), cost: 5, power: 4, hp: 5, arena: 'space' }),
  card('blueprints', { ...community('Octarian Blueprints'), type: 'upgrade', cost: 3, power: 2, hp: 3, arena: undefined }),
  card('octoling', { ...community('Octoling'), cost: 2, power: 2, hp: 3, traits: ['Octarian', 'Octoling', 'Trooper'] }),
  card('octotrooper', { cost: 2, power: 1, hp: 2, traits: ['Octarian', 'trooper'] }),
  card('strike', { ...community('Long Distance Strike'), type: 'event', cost: 5, arena: undefined }),
  card('splat', { ...community('Splat Bomb'), type: 'event', cost: 4, arena: undefined }),
  card('shieldedTrooper', { ...community('Shielded Octotrooper'), cost: 2, power: 1, hp: 2 }),
  card('tentacle', { ...community('Tentacle'), type: 'upgrade', cost: 2, power: 2, hp: 1, arena: undefined }),
  card('stamp', { ...community('Octostamp'), cost: 3, power: 3, hp: 3 }),
  card('king', { ...community('Octobot King'), cost: 6, power: 5, hp: 6, arena: 'space', unique: true, traits: ['Octarian', 'Octoweapon', 'Vehicle'] }),
  card('pod', { ...community('Octopod'), cost: 1, power: 0, hp: 3 }),
  card('cheap', { type: 'upgrade', cost: 2, power: 1, hp: 1, arena: undefined }),
  card('callie', { ...community('Callie'), subtitle: 'Hey, DJ!', cost: 7, power: 4, hp: 9, unique: true, traits: ['Inkling', 'Octarian'] }),
  card('uncover', { ...community('Uncover the Hideout'), type: 'event', cost: 1, arena: undefined }),
  card('amped', { ...community('Amped Octostamp'), cost: 4, power: 4, hp: 4 }),
  card('inkling', { ...community('Versatile Inkling'), cost: 2, power: 1, hp: 3 }),
  card('sprinkler', { ...community('Sprinkler'), type: 'event', cost: 4, arena: undefined }),
  card('seeker', { ...community('Octoseeker'), cost: 4, power: 3, hp: 3, arena: 'space' }),
  card('mist', { ...community('Toxic Mist'), type: 'event', cost: 3, arena: undefined }),
  card('wall', { ...community('Splash Wall'), type: 'event', cost: 1, arena: undefined }),
  card('beakon', { ...community('Squid Beakon Jump'), type: 'event', cost: 1, arena: undefined }),
  card('octopodXL', { ...community('Oversized Octopod'), cost: 3, power: 0, hp: 6 }),
  card('zeppelin2', { ...communityKey('5/aa4f5990-ae62-4d36-9364-1752cd493029'), cost: 5, power: 4, hp: 5, arena: 'space' }),
  card('hidden', { cost: 2, power: 2, hp: 2, text: '[Hidden]' }),
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

// --- The second batch: the cards that use the Ink tokens ---

const enemyInked = (state: GameState, id: string, count: number) => {
  const u = unit(state, id)!
  for (let i = 0; i < count; i++) u.upgrades.push({ id: `k${id}${i}`, def: 'ink', owner: 0 })
}
// To the next action phase: both pass, then neither resources a card
function nextActionPhase(state: GameState) {
  state = act(state, state.active, { type: 'pass' })
  state = act(state, state.active, { type: 'pass' })
  return regroup(state)
}
// The regroup phase: neither player resources a card (the one with the initiative first)
function regroup(state: GameState) {
  while (state.phase === 'regroup') state = act(state, waitingFor(state)[0], { type: 'resource', cards: [] })
  return state
}

test('Attack the Vulnerable deals 2 damage to each enemy unit with an Ink token', () => {
  let state = table({ units1: ['big', 'small'], hand0: ['vulnerable'] })
  enemyInked(state, 'u10', 1)
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.equal(unit(state, 'u10')!.damage, 2)
  assert.equal(unit(state, 'u11')!.damage, 0)
})

test('Elite Octoling gains +1/+0 for each Ink token in play; Octoling for each other friendly Octarian Trooper', () => {
  const state = table({ units0: ['elite', 'octoling', 'octotrooper', 'octoling'], units1: ['big', 'small'] })
  enemyInked(state, 'u10', 2)
  enemyInked(state, 'u11', 1)
  assert.equal(powerOf(state, unit(state, 'u00')!), 5)
  // The other Octoling and the Octarian trooper: whatever the case of its traits
  assert.equal(powerOf(state, unit(state, 'u01')!), 4)
})

test('Octorpedo may defeat itself as its attack ends, to give the defending unit 6 Ink tokens; Octopod must, for 3', () => {
  let state = table({ units0: ['torpedo'], units1: ['small'] })
  unit(state, 'u00')!.arena = 'ground'
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  state = yes(state)
  assert.equal(unit(state, 'u00'), undefined)
  assert.equal(inkOn(state, 'u10'), 6)
  assert.equal(unit(state, 'u10')!.damage, 1, 'Raid 1')
  state = table({ units0: ['pod'], units1: ['big'] })
  state.players[1].units[0].damage = 0
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  assert.equal(unit(state, 'u00'), undefined)
  // 5 power against 3 HP: the Octopod is defeated in combat, so no Ink
  assert.equal(inkOn(state, 'u10'), 0)
  state = table({ units0: ['pod'], units1: ['small'] })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  assert.equal(unit(state, 'u00'), undefined, 'defeated by its own ability')
  assert.equal(inkOn(state, 'u10'), 3)
})

test('Marina: the first upgrade you play on another friendly unit each phase costs 1 less', () => {
  let state = table({ units0: ['marina', 'small'], hand0: ['cheap', 'cheap'] })
  const ready = () => state.players[0].resources.filter((r) => !r.exhausted).length
  // Onto Marina herself: full price
  assert.ok(legalActions(state, 0).some((a) => a.type === 'play' && a.attachTo === 'u00'))
  state = act(state, 0, { type: 'play', card: 'h0', attachTo: 'u01' })
  assert.equal(ready(), 7, 'cost 1')
  state.active = 0
  state = act(state, 0, { type: 'play', card: 'h1', attachTo: 'u01' })
  assert.equal(ready(), 5, 'the second one, full price')
})

test('Octarian Blueprints costs 1 less on an Octarian unit, and the AI pays the price of the unit it picks', () => {
  let state = table({ units0: ['octoling', 'small'], hand0: ['blueprints'] })
  for (const r of state.players[0].resources.slice(2)) r.exhausted = true
  // 2 ready: onto the Octoling only
  assert.deepEqual(
    legalActions(state, 0).flatMap((a) => (a.type === 'play' ? [a.attachTo] : [])),
    ['u00'],
  )
  state = act(state, 0, { type: 'play', card: 'h0', attachTo: 'u00' })
  assert.equal(unit(state, 'u00')!.upgrades.length, 1)
})

test('Octozeppelin gives an enemy unit an Ink token at the start of the action phase', () => {
  let state = table({ units0: ['zeppelin'], units1: ['big', 'small'] })
  state = nextActionPhase(state)
  assert.equal(state.phase, 'action')
  state = answer(state, 'u11')
  assert.equal(inkOn(state, 'u11'), 1)
})

test('Long Distance Strike: at the start of the next action phase, damage equal to the revealed unit\'s power, then 1 for each Ink token, defeated', () => {
  let state = table({ units1: ['big', 'small'], hand0: ['strike', 'stomp'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, 'h1')
  assert.equal(unit(state, 'u10')!.damage, 0, 'not yet')
  enemyInked(state, 'u10', 2)
  state = nextActionPhase(state)
  // Octostomp's 5 power: the big unit (5 HP) is defeated outright; the small one (4 HP) too
  state = answer(state, 'u11')
  assert.equal(unit(state, 'u11'), undefined)
  // On a sturdy inked unit: 5, then the 2 Ink tokens defeated for 2 more
  state = table({ units1: ['nozzle'], hand0: ['strike', 'copter'] })
  enemyInked(state, 'u10', 2)
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, 'h1')
  state = nextActionPhase(state)
  if (state.prompt?.text.includes('Long Distance')) state = answer(state, 'u10')
  assert.equal(unit(state, 'u10')!.damage, 4, '2, plus 1 for each Ink token')
  assert.equal(inkOn(state, 'u10'), 0)
})

test('Splat Bomb inks each enemy unit in an arena and heals your base 1 for each', () => {
  let state = table({ units1: ['big', 'small', 'zeppelin'], hand0: ['splat'] })
  unit(state, 'u12')!.arena = 'space'
  state.players[0].base.damage = 5
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, '0')
  assert.equal(inkOn(state, 'u10'), 1)
  assert.equal(inkOn(state, 'u11'), 1)
  assert.equal(inkOn(state, 'u12'), 0)
  assert.equal(state.players[0].base.damage, 3)
})

test('Shielded Octotroopers ink the unit they fought', () => {
  let state = table({ units0: ['small'], units1: ['shieldedTrooper'] })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  state = yes(state)
  assert.equal(inkOn(state, 'u00'), 1)
  state = table({ units0: ['twintacle'], units1: ['nozzle'] })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  // Octonozzle's own question first (the defender's), then the Twintacle's
  while (state.prompt && !state.prompt.text.includes('Twintacle')) state = answer(state, 'no')
  state = yes(state)
  assert.equal(inkOn(state, 'u10'), 2)
})

test('Tentacle: an Octoweapon or Vehicle it is on distributes 3 Ink tokens when defeated; Octostamp inks as it deals combat damage', () => {
  let state = table({ units0: ['vehicle'], units1: ['whirl', 'small'] })
  unit(state, 'u00')!.upgrades.push({ id: 'tt', def: 'tentacle', owner: 0 })
  unit(state, 'u00')!.damage = 2
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  assert.equal(unit(state, 'u00'), undefined)
  state = answer(state, 'u11')
  state = answer(state, 'u11')
  state = answer(state, 'u10')
  assert.equal(inkOn(state, 'u11'), 2)
  state = table({ units0: ['small'], units1: ['big', 'small'] })
  unit(state, 'u00')!.upgrades.push({ id: 'tt', def: 'tentacle', owner: 0 })
  unit(state, 'u00')!.damage = 3
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  assert.equal(inkOn(state, 'u10') + inkOn(state, 'u11'), 0, 'not a Vehicle')
  state = table({ units0: ['stamp'], units1: ['big', 'small'] })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  state = answer(state, 'u11')
  assert.equal(inkOn(state, 'u11'), 1)
})

test('Octobot King may move to the ground arena with an Experience token; with DJ Octavio on it, Overwhelm and Restore 2', () => {
  let state = table({ units1: ['big'], hand0: ['king'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = yes(state)
  const king = state.players[0].units.find((u) => u.def === 'king')!
  assert.equal(king.arena, 'ground')
  assert.equal(king.upgrades.length, 1)
  assert.equal(keywordsOf(state, king).overwhelm, undefined)
  king.upgrades.push({ id: 'dj', def: 'octavio', owner: 0 })
  assert.equal(keywordsOf(state, king).overwhelm, true)
  assert.equal(keywordsOf(state, king).restore, 2)
})

test("the AI uses DJ Octavio's Action: an Ink token on an enemy unit is worth something to it", () => {
  const state = table({ leader0: 'octavio', units0: ['small', 'small'], units1: ['big', 'whirl'] })
  for (const u of state.players[0].units) u.exhausted = true
  state.players[0].hand = []
  // Turn 1: 2 resources, too few to deploy him
  state.players[0].resources = state.players[0].resources.slice(0, 2)
  assert.deepEqual(chooseAction(state, 0), { type: 'ability', source: 'leader', index: 0 })
})


// --- The second batch (2026-11-18) ---
const tokensOn = (state: GameState, id: string, name: string) => unit(state, id)!.upgrades.filter((u) => state.defs[u.def].name === name).length

test('Callie: a friendly unit gives an enemy unit 1 more Ink token; an event does not', () => {
  let state = table({ units0: ['callie', 'copter'], units1: ['big'] })
  assert.equal(keywordsOf(state, unit(state, 'u00')!).sentinel, true)
  state = act(state, 0, { type: 'attack', attacker: 'u01', target: 'u10' })
  assert.equal(inkOn(state, 'u10'), 2, 'the Octocopter gives 1, plus 1')
  let event = table({ units0: ['callie'], units1: ['big'], hand0: ['sprinkler'] })
  event = act(event, 0, { type: 'play', card: 'h0' })
  assert.equal(inkOn(event, 'u10'), 1, 'an event is not a unit')
})

test('Uncover the Hideout: a unit that costs 3 or more discarded from their hand', () => {
  let state = table({ hand0: ['uncover'] })
  state.players[1].hand = [{ id: 'e0', def: 'small' }, { id: 'e1', def: 'big' }, { id: 'e2', def: 'wall' }]
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.deepEqual(state.prompt!.options.map((o) => o.id), ['e1'], 'the 5-cost unit only')
  state = answer(state, 'e1')
  assert.deepEqual(state.players[1].hand.map((c) => c.id), ['e0', 'e2'])
})

test('Amped Octostamp: when defeated, an Experience token to a unit and 3 Ink tokens to another', () => {
  let state = table({ units0: ['amped', 'small'], units1: ['big'] })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  // A 4/4 into a 5/5: defeated
  assert.equal(unit(state, 'u00'), undefined)
  state = answer(state, 'u01')
  assert.ok(state.prompt!.options.every((o) => o.id !== 'u01'), 'another unit')
  state = answer(state, 'u10')
  assert.equal(tokensOn(state, 'u01', 'Experience'), 1)
  assert.equal(inkOn(state, 'u10'), 3)
})

test('Versatile Inkling: Raid 2 while it has an Ink token', () => {
  const state = table({ units0: ['inkling'] })
  const inkling = state.players[0].units[0]
  assert.equal(keywordsOf(state, inkling).raid, 1)
  inkling.upgrades.push({ id: 'k1', def: 'ink', owner: 1 })
  assert.equal(keywordsOf(state, inkling).raid, 2)
})

test('Sprinkler: an Ink token on each enemy unit, then a resource', () => {
  let state = table({ units1: ['big', 'small'], hand0: ['sprinkler'] })
  const resources = state.players[0].resources.length
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.equal(inkOn(state, 'u10'), 1)
  assert.equal(inkOn(state, 'u11'), 1)
  assert.equal(state.players[0].resources.length, resources + 1)
})

test('Octoseeker: enemy units lose Hidden; a Shield token to a friendly unit when played', () => {
  let state = table({ hand0: ['seeker'], units0: ['big'], units1: ['hidden'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  if (state.prompt) state = answer(state, 'u00')
  assert.equal(tokensOn(state, 'u00', 'Shield'), 1)
  assert.ok(!keywordsOf(state, unit(state, 'u10')!).hidden)
})

test('Toxic Mist: the Ink tokens on 2 units become as many Weakness tokens', () => {
  let state = table({ hand0: ['mist'], units1: ['big', 'small'] })
  state.players[1].units[0].upgrades.push({ id: 'k1', def: 'ink', owner: 0 }, { id: 'k2', def: 'ink', owner: 0 })
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, 'u10', 'u11')
  assert.equal(inkOn(state, 'u10'), 0)
  assert.equal(tokensOn(state, 'u10', 'Weakness'), 2)
  assert.equal(tokensOn(state, 'u11', 'Weakness'), 0)
})

test('Splash Wall: a Shield token to a unit', () => {
  let state = table({ hand0: ['wall'], units0: ['big'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  if (state.prompt) state = answer(state, 'u00')
  assert.equal(tokensOn(state, 'u00', 'Shield'), 1)
})

test('Squid Beakon Jump: a unit played from hand, paying its cost, with an Experience token', () => {
  let state = table({ hand0: ['beakon', 'big'] })
  const ready = state.players[0].resources.filter((r) => !r.exhausted).length
  state = act(state, 0, { type: 'play', card: 'h0' })
  if (state.prompt) state = answer(state, 'h1')
  assert.equal(tokensOn(state, 'h1', 'Experience'), 1)
  assert.equal(ready - state.players[0].resources.filter((r) => !r.exhausted).length, 6, '1 for the event, 5 for the unit')
})

test('Oversized Octopod: Raid 2; may defeat itself after attacking for 6 Ink tokens on the defender', () => {
  let state = table({ units0: ['octopodXL'], units1: ['big'] })
  assert.equal(keywordsOf(state, state.players[0].units[0]).raid, 2)
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  state = yes(state)
  assert.equal(unit(state, 'u00'), undefined)
  assert.equal(inkOn(state, 'u10'), 6)
})

test('Octozeppelin (the one for any unit): its own script, apart from the first Octozeppelin', () => {
  const zeppelin = defs.find((d) => d.id === 'zeppelin2')!
  assert.equal(scriptStatus(zeppelin), 'scripted')
  const script = communityScripts.find((s) => s.card === '5/aa4f5990-ae62-4d36-9364-1752cd493029')!
  assert.ok(script.front?.actionStart)
})
