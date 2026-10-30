import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseAction } from './ai.ts'
import { applyAction, createGame, legalActions, powerOf } from './game.ts'
import { readText } from './cards.ts'
import { scripts } from './scripts.ts'
import { viewFor } from './view.ts'
import type { Action, CardDef, GameState, PlayerId, UnitState } from './types.ts'

// The third batch of DUNE cards: combat damage first, control taken, cards played from the
// discard pile, names banned, decks searched. Test cards quote their DUNE card.
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
const scripted = (name: string, subtitle?: string) => {
  const script = scripts.find((s) => s.name === name && (subtitle === undefined || s.subtitle === subtitle))!
  return { name, subtitle: script.subtitle, ...readText(script.text), text: script.text, backText: script.backText }
}

const defs: CardDef[] = [
  card('leader', { type: 'leader', cost: 4, unit: { power: 3, hp: 6, arena: 'ground', keywords: {} } }),
  card('arrakis', { type: 'base', hp: 30, traits: ['Arrakis'] }),
  card('plain', { type: 'base', hp: 30 }),
  card('big', { cost: 5, power: 5, hp: 5 }),
  card('small', { cost: 2, power: 2, hp: 2 }),
  card('frail', { cost: 1, power: 2, hp: 1 }),
  card('fremen', { cost: 2, power: 2, hp: 3, traits: ['Fremen'] }),
  card('sister', { cost: 3, power: 2, hp: 3, traits: ['Bene Gesserit'] }),
  card('paul', { name: 'Paul Atreides', subtitle: 'Test', unique: true, cost: 3, power: 3, hp: 4, traits: ['Atreides'] }),
  card('fenring', { ...scripted('Count Hasimir Fenring', "The Emperor's Blade"), cost: 5, power: 4, hp: 4 }),
  card('seeker', { ...scripted('Hunter Seeker'), cost: 1, power: 1, hp: 1 }),
  card('seduction', { ...scripted('Seduction'), type: 'event', cost: 4, arena: undefined }),
  card('crysknife', { ...scripted('Crysknife'), type: 'upgrade', cost: 1, power: 1, hp: 0, arena: undefined, traits: ['Fremen', 'Item'] }),
  card('blade', { ...scripted('Spice-Sworn Blade'), cost: 1, power: 2, hp: 1 }),
  card('dividend', { ...scripted('CHOAM Dividend'), type: 'event', cost: 4, arena: undefined }),
  card('voice', { ...scripted('The Voice'), type: 'event', cost: 2, arena: undefined }),
  card('litany', { ...scripted('Litany Against Fear'), type: 'upgrade', cost: 2, arena: undefined }),
  card('atomics', { ...scripted('Family Atomics'), type: 'event', cost: 2, arena: undefined }),
  card('gom', { ...scripted('Gom Jabbar'), type: 'upgrade', cost: 2, arena: undefined }),
  card('worm', { ...scripted('Shai-Hulud'), cost: 9, power: 10, hp: 10 }),
  card('duncan', { ...scripted('Duncan Idaho', 'Swordmaster of the Ginaz'), cost: 4, power: 4, hp: 5 }),
  card('frigate', { ...scripted("The Emperor's Frigate"), cost: 6, power: 4, hp: 7, arena: 'space' }),
  card('shuttle', { ...scripted('Bene Gesserit Shuttle'), cost: 3, power: 2, hp: 4, arena: 'space' }),
  card('mohiam', { ...scripted('Reverend Mother Mohiam', "The Emperor's Truthsayer"), cost: 7, power: 4, hp: 8 }),
  card('signs', { ...scripted('Worm Signs'), type: 'event', cost: 3, arena: undefined }),
  card('rabban', { ...scripted('Glossu Rabban', 'Governor of Arrakis'), type: 'leader', cost: 5, unit: { power: 4, hp: 6, arena: 'ground', keywords: {} } }),
  card('troops', { ...scripted('Harkonnen Troops'), cost: 1, power: 2, hp: 1, traits: ['Harkonnen', 'Trooper'] }),
  card('sergeant', { ...scripted('Harkonnen Sergeant'), cost: 3, power: 3, hp: 3 }),
  card('kanly', { ...scripted('Kanly'), type: 'event', cost: 2, arena: undefined }),
  card('adept', { cost: 4, power: 3, hp: 5, text: '[Sentinel]' }),
  card('thumper', { ...scripted('Thumper'), unique: true, type: 'upgrade', cost: 1, arena: undefined, traits: ['Fortification', 'Fremen'] }),
  card('refinery', { ...scripted('Carthag Refinery'), type: 'upgrade', cost: 2, arena: undefined, traits: ['Fortification', 'Harkonnen'] }),
  card('wall', { ...scripted('The Shield Wall'), type: 'upgrade', cost: 3, arena: undefined, traits: ['Fortification'] }),
  card('creature', { cost: 3, power: 3, hp: 3, traits: ['Creature'] }),
  card('harvester', { ...scripted('Spice Harvester'), cost: 3, power: 2, hp: 4, traits: ['Vehicle', 'Harvester'] }),
  card('pawn', { name: 'Pawn of the Sisterhood', type: 'upgrade', cost: 2, arena: undefined, text: 'Attach to a non-[{Bene Gesserit}], non-[{Vehicle}] unit.\nAttached unit gains [Sentinel].' }),
]

const act = (state: GameState, p: PlayerId, action: Action) => applyAction(state, p, action)
const answer = (state: GameState, ...picks: string[]) => act(state, state.prompt!.player, { type: 'answer', picks })

// Player 0 to act in the action phase, with these units, hands and discard piles
function table(o: { base0?: string; units0?: string[]; units1?: string[]; hand0?: string[]; hand1?: string[]; discard0?: string[]; deck0?: string[] } = {}) {
  let state = createGame({
    seed: 3,
    defs,
    decks: [
      { name: 'One', leader: 'leader', base: o.base0 ?? 'plain', deck: Array(20).fill('big') },
      { name: 'Two', leader: 'leader', base: 'plain', deck: Array(20).fill('big') },
    ],
  })
  state = act(state, state.chooser, { type: 'first', goFirst: true })
  state = act(state, state.initiative, { type: 'mulligan', take: false })
  state = act(state, state.initiative === 0 ? 1 : 0, { type: 'mulligan', take: false })
  for (const p of [0, 1] as const) state = act(state, p, { type: 'resource', cards: state.players[p].hand.slice(0, 2).map((c) => c.id) })
  state.active = 0
  const place = (p: PlayerId, ids: string[]): UnitState[] =>
    ids.map((id, i) => ({ id: `u${p}${i}`, def: id, owner: p, arena: state.defs[id].arena ?? 'ground', damage: 0, exhausted: false, upgrades: [] }))
  state.players[0].units = place(0, o.units0 ?? [])
  state.players[1].units = place(1, o.units1 ?? [])
  state.players[0].hand = (o.hand0 ?? []).map((id, i) => ({ id: `h${i}`, def: id }))
  state.players[1].hand = (o.hand1 ?? []).map((id, i) => ({ id: `e${i}`, def: id }))
  state.players[0].discard = (o.discard0 ?? []).map((id, i) => ({ id: `d${i}`, def: id }))
  if (o.deck0) state.players[0].deck = o.deck0.map((id, i) => ({ id: `k${i}`, def: id }))
  for (const pl of state.players) pl.resources = Array.from({ length: 8 }, (_, i) => ({ card: { id: `r${pl.name}${i}`, def: 'big' }, exhausted: false }))
  return state
}

test('Fenring deals his combat damage first: a defender he defeats deals none back', () => {
  let state = table({ units0: ['fenring'], units1: ['small'] })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  assert.equal(state.players[1].units.length, 0)
  assert.equal(state.players[0].units[0].damage, 0)
})

test("Fenring can't attack units named Paul Atreides", () => {
  const state = table({ units0: ['fenring'], units1: ['paul'] })
  const targets = legalActions(state, 0).flatMap((a) => (a.type === 'attack' ? [a.target] : []))
  assert.deepEqual(targets, ['base'])
})

test('Hunter Seeker: an enemy ground unit attacks, it is defeated and deals 3 damage to the attacker', () => {
  let state = table({ units0: ['big'], units1: ['seeker'] })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'base' })
  assert.equal(state.players[1].units.length, 0)
  assert.equal(state.players[0].units[0].damage, 3)
})

test('Seduction takes control of a unit, ready, until the regroup phase starts', () => {
  let state = table({ units0: ['sister'], units1: ['small'], hand0: ['seduction'] })
  state.players[1].units[0].exhausted = true
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.ok(state.prompt)
  state = answer(state, 'u10')
  assert.equal(state.players[0].units.find((u) => u.id === 'u10')?.exhausted, false)
  state = act(state, 1, { type: 'pass' })
  state = act(state, 0, { type: 'pass' })
  assert.equal(state.phase, 'regroup')
  assert.ok(state.players[1].units.some((u) => u.id === 'u10'), 'back with its owner')
})

test('Crysknife may be played from the discard pile, but only onto a Fremen unit', () => {
  const state = table({ units0: ['fremen', 'small'], discard0: ['crysknife'] })
  const plays = legalActions(state, 0).filter((a) => a.type === 'play')
  assert.deepEqual(plays, [{ type: 'play', card: 'd0', attachTo: 'u00', discard: true }])
})

test('Spice-Sworn Blade is played from the discard pile for free by defeating a Spice token', () => {
  let state = table({ discard0: ['blade'] })
  state.players[0].spice = [{ id: 'sp', def: 'token-spice' }]
  for (const r of state.players[0].resources) r.exhausted = true
  const action = { type: 'play', card: 'd0', discard: true, spice: true } as const
  assert.ok(legalActions(state, 0).some((a) => JSON.stringify(a) === JSON.stringify(action)))
  state = act(state, 0, action)
  assert.ok(state.players[0].units.some((u) => u.id === 'd0'))
  assert.equal(state.players[0].spice.length, 0)
})

test('CHOAM Dividend costs 1 less for a Spice token, and goes into play as a resource', () => {
  let state = table({ hand0: ['dividend'] })
  state.players[0].spice = [{ id: 'sp', def: 'token-spice' }]
  state.players[0].resources = state.players[0].resources.slice(0, 3)
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.equal(state.players[0].spice.length, 0)
  assert.equal(state.players[0].resources.length, 4)
  assert.ok(state.players[0].resources.some((r) => r.card.id === 'h0'))
})

test("The Voice: the named card can't be played this phase", () => {
  let state = table({ hand0: ['voice'], hand1: ['small', 'big'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, 'e0')
  state.active = 1
  const plays = legalActions(state, 1).filter((a) => a.type === 'play')
  assert.deepEqual(plays, [{ type: 'play', card: 'e1' }])
})

test("Litany Against Fear: an enemy card's ability can't defeat the unit", () => {
  let state = table({ units1: ['big', 'small'], hand0: ['atomics', 'atomics'] })
  state.players[1].units[0].upgrades = [{ id: 'lit', def: 'litany', owner: 1 }]
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, '1')
  state = answer(state, 'u10')
  assert.ok(state.players[1].units.some((u) => u.id === 'u10'), "Family Atomics can't defeat it")
  assert.equal(state.players[0].base.damage, 3)
  state.active = 0
  for (const r of state.players[0].resources) r.exhausted = false
  state = act(state, 0, { type: 'play', card: 'h1' })
  state = answer(state, '1')
  state = answer(state, 'u11')
  assert.ok(!state.players[1].units.some((u) => u.id === 'u11'), 'a unit without it is defeated')
})

test('Gom Jabbar: exhausted, the unit is defeated unless its controller discards a card', () => {
  let state = table({ units0: ['big'], hand0: ['small'] })
  state.players[0].units[0].upgrades = [{ id: 'gom', def: 'gom', owner: 1 }]
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'base' })
  state = answer(state, 'no')
  assert.equal(state.players[0].units.length, 0)
})

test('Shai-Hulud goes to the bottom of its deck once its attack is done', () => {
  let state = table({ units0: ['worm'] })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'base' })
  assert.equal(state.players[1].base.damage, 10)
  assert.equal(state.players[0].units.length, 0)
  assert.equal(state.players[0].deck.at(-1)?.def, 'worm')
})

test('Duncan Idaho, defeated defending while you control Paul Atreides, may defeat the attacker', () => {
  let state = table({ units0: ['big', 'big'], units1: ['duncan', 'paul'] })
  state.players[1].units[0].damage = 4
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  state = answer(state, 'yes')
  assert.ok(!state.players[0].units.some((u) => u.id === 'u00'))
})

test("The Emperor's Frigate: enemy ground units get -1/-0 attacking a base", () => {
  let state = table({ units0: ['big'], units1: ['frigate'] })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'base' })
  assert.equal(state.players[1].base.damage, 4)
  assert.equal(powerOf(state, state.players[0].units[0]), 5, 'only while it attacks')
})

test('Bene Gesserit Shuttle searches the top 5 cards for a Bene Gesserit unit', () => {
  let state = table({ hand0: ['shuttle'], deck0: ['big', 'small', 'sister', 'big', 'big', 'small'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.deepEqual(state.prompt!.options.map((o) => o.id), ['k2'])
  state = answer(state, 'k2')
  assert.ok(state.players[0].hand.some((c) => c.id === 'k2'))
  const deck = state.players[0].deck.map((c) => c.id)
  assert.equal(deck[0], 'k5')
  assert.deepEqual([...deck.slice(1)].sort(), ['k0', 'k1', 'k3', 'k4'], 'the rest go to the bottom, shuffled')
  assert.deepEqual(state.revealed?.[0], { cards: ['sister'], by: 'shuttle' }, 'both players see what was revealed')
})

test("Reverend Mother Mohiam: opponents play with their hands revealed", () => {
  const state = table({ units0: ['mohiam'], hand1: ['small'] })
  assert.deepEqual(viewFor(state, 0).players[1].hand?.map((c) => c.def), ['small'])
  assert.equal(viewFor(state, 1).players[0].hand, null)
})

test('Worm Signs: its controller lets the unit be defeated when the regroup phase starts', () => {
  let state = table({ base0: 'arrakis', units1: ['big'], hand0: ['signs'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, 'u10')
  state = answer(state, '1')
  assert.equal(state.players[1].units.length, 1)
  state = act(state, 1, { type: 'pass' })
  state = act(state, 0, { type: 'pass' })
  assert.equal(state.players[1].units.length, 0)
})

test('Pawn of the Sisterhood attaches to neither a Bene Gesserit unit nor a Vehicle', () => {
  const state = table({ units0: ['sister', 'small'], hand0: ['pawn'] })
  const targets = legalActions(state, 0).flatMap((a) => (a.type === 'play' ? [a.attachTo] : []))
  assert.deepEqual(targets, ['u01'])
})

test("The AI doesn't use Glossu Rabban on a unit the damage would defeat, but does on one it doesn't", () => {
  const rabban = (unit: string) => {
    const state = table({ units0: [unit] })
    state.players[0].leader.def = 'rabban'
    // Too few resources to deploy him
    state.players[0].resources = []
    return chooseAction(state, 0)
  }
  assert.deepEqual(rabban('frail'), { type: 'attack', attacker: 'u00', target: 'base' })
  assert.deepEqual(rabban('small'), { type: 'ability', source: 'leader', index: 0 })
})

test('The AI trades Harkonnen Troops for two Fremen tokens: one in combat, one as it is defeated', () => {
  let state = table({ units0: ['troops'], units1: ['frail', 'frail'] })
  state.players[0].resources = []
  const attack = chooseAction(state, 0)!
  assert.equal(attack.type, 'attack')
  assert.notEqual(attack.type === 'attack' && attack.target, 'base')
  state = act(state, 0, attack)
  while (state.prompt) state = act(state, state.prompt.player, chooseAction(state, state.prompt.player)!)
  assert.equal(state.players[1].units.length, 0)
})

test('Kanly: a friendly unit may still be defeated once the target is gone, for its When Defeated ability', () => {
  let state = table({ units0: ['troops'], units1: ['frail', 'small'], hand0: ['kanly'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, 'u10')
  assert.equal(state.players[1].units.length, 1, 'the target is defeated')
  assert.deepEqual(state.prompt!.options.map((o) => o.id), ['u00'])
  state = answer(state, 'u00')
  // Harkonnen Troops' When Defeated: 1 damage
  state = answer(state, 'u11')
  assert.equal(state.players[0].units.length, 0)
  assert.equal(state.players[1].units[0].damage, 1)
})

test('Harkonnen Sergeant offers the Trooper it draws at its cost then, played by clicking it', () => {
  let state = table({ hand0: ['sergeant'], deck0: ['big', 'troops', 'big', 'big', 'big', 'big'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, 'k1')
  assert.deepEqual(state.prompt!.play, { card: 'k1', cost: 0 })
  state = answer(state, 'yes')
  assert.ok(state.players[0].units.some((u) => u.id === 'k1'))
})

test('Thumper attaches to your base, with no unit in play, and finds a Creature that costs 1 less', () => {
  let state = table({ hand0: ['thumper'], deck0: ['big', 'creature', 'big', 'big'] })
  assert.deepEqual(legalActions(state, 0).filter((a) => a.type === 'play'), [{ type: 'play', card: 'h0', attachTo: 'base0' }])
  state = act(state, 0, { type: 'play', card: 'h0', attachTo: 'base0' })
  state = answer(state, 'k1')
  assert.deepEqual(state.players[0].base.upgrades?.map((u) => u.id), ['h0'])
  assert.equal(viewFor(state, 0).players[0].prices?.k1, 2)
  state.active = 0
  state = act(state, 0, { type: 'play', card: 'k1' })
  assert.deepEqual(state.players[0].base.upgrades, [], 'playing a Creature defeats it')
  assert.ok(state.players[0].discard.some((c) => c.id === 'h0'))
})

test('Carthag Refinery: Harvesters cost 1 less, and a Spice token may be 2 for 1 damage to the base', () => {
  let state = table({ base0: 'arrakis', hand0: ['harvester'] })
  state.players[0].base.upgrades = [{ id: 'ref', def: 'refinery', owner: 0 }]
  assert.equal(viewFor(state, 0).players[0].prices?.h0, 2)
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, 'yes')
  assert.equal(state.players[0].spice.length, 2)
  assert.equal(state.players[0].base.damage, 1)
})

test("The Shield Wall: enemy ground attackers get -1/-0 at a base, and Shai-Hulud can't defeat your units", () => {
  let state = table({ base0: 'arrakis', units0: ['big'], units1: ['small'], hand0: ['worm'] })
  state.players[1].base.upgrades = [{ id: 'wall', def: 'wall', owner: 1 }]
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'base' })
  assert.equal(state.players[1].base.damage, 4)
  state.active = 0
  state.players[0].resources.push(...Array.from({ length: 2 }, (_, i) => ({ card: { id: `rx${i}`, def: 'big' }, exhausted: false })))
  for (const r of state.players[0].resources) r.exhausted = false
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.ok(state.players[1].units.some((u) => u.id === 'u10'))
  assert.ok(!state.players[0].units.some((u) => u.id === 'u00'), 'your own units have no Shield Wall')
})

test('Family Atomics defeats a Fortification and draws a card', () => {
  let state = table({ hand0: ['atomics'] })
  state.players[1].base.upgrades = [{ id: 'wall', def: 'wall', owner: 1 }]
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, '0')
  state = answer(state, 'wall')
  assert.deepEqual(state.players[1].base.upgrades, [])
  assert.ok(state.players[1].discard.some((c) => c.id === 'wall'))
  assert.equal(state.players[0].hand.length, 1)
})

test('A deck search shows every card looked at, even when none may be taken', () => {
  let state = table({ hand0: ['thumper'], deck0: ['big', 'creature', 'small'] })
  state = act(state, 0, { type: 'play', card: 'h0', attachTo: 'base0' })
  assert.deepEqual(state.prompt!.seen?.map((c) => c.id), ['k0', 'k1', 'k2'])
  assert.deepEqual(state.prompt!.options.map((o) => o.id), ['k1'])
  state = table({ hand0: ['thumper'], deck0: ['big', 'small'] })
  state = act(state, 0, { type: 'play', card: 'h0', attachTo: 'base0' })
  assert.equal(state.prompt!.max, 0, 'nothing found: shown, with nothing to pick')
  state = answer(state)
  assert.equal(state.prompt, null)
})

test('A second copy of a unique card: its player keeps one, the other defeated before When Played resolves', () => {
  let state = table({ units0: ['paul'], units1: ['small'], hand0: ['paul', 'thumper', 'thumper'] })
  state.players[0].units[0].damage = 3
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.match(state.prompt!.text, /unique/)
  assert.deepEqual(state.prompt!.options.map((o) => o.id), ['u00', 'h0'])
  state = answer(state, 'h0')
  assert.deepEqual(state.players[0].units.map((u) => u.id), ['h0'])
  assert.ok(state.players[0].discard.some((c) => c.id === 'u00'))
  // A unique Fortification too
  state.active = 0
  state.players[0].base.upgrades = [{ id: 'old', def: 'thumper', owner: 0 }]
  state = act(state, 0, { type: 'play', card: 'h1', attachTo: 'base0' })
  assert.equal(state.prompt!.options[1].def, 'thumper', 'the copies are shown as cards')
  state = answer(state, 'old')
  assert.deepEqual(state.players[0].base.upgrades?.map((u) => u.id), ['old'])
  // Thumper's When Played still resolves: its search
  assert.match(state.prompt?.text ?? '', /Thumper/)
})

test("The AI doesn't wait out a Sentinel: two Harkonnen Troops defeat it, then the rest attack the base", () => {
  let state = table({ units0: ['troops', 'troops', 'sergeant'], units1: ['adept'] })
  state.players[0].resources = []
  state.players[0].leader.exhausted = true
  const first = chooseAction(state, 0)!
  assert.deepEqual(first, { type: 'attack', attacker: 'u00', target: 'u10' })
  state = act(state, 0, first)
  while (state.prompt) state = act(state, state.prompt.player, chooseAction(state, state.prompt.player)!)
  state = act(state, 1, { type: 'pass' })
  state = act(state, 0, chooseAction(state, 0)!)
  while (state.prompt) state = act(state, state.prompt.player, chooseAction(state, state.prompt.player)!)
  assert.equal(state.players[1].units.length, 0)
})
