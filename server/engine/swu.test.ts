import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyAction, createGame, keywordsOf, legalActions, powerOf, hpOf } from './game.ts'
import { chooseAction } from './ai.ts'
import { readText } from './cards.ts'
import { swuScripts } from './swu.ts'
import { scriptStatus } from './scripts.ts'
import type { Action, CardDef, GameState, PlayerId, UnitState } from './types.ts'

// The real SWU cards scripted in swu.ts, built here from their scripts with the stats swudb gives
// them: the imported cards themselves (public/showcase/SWU) stay out of git
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
const swu = (id: string, extra: Partial<CardDef>) => {
  const script = swuScripts.find((s) => s.card === id)!
  return card(id, { name: script.name, subtitle: script.subtitle, ...readText(script.text), text: script.text, backText: script.backText, unique: true, ...extra })
}
const jedi = ['Force', 'Jedi', 'Republic']

const defs: CardDef[] = [
  card('leader', { type: 'leader', cost: 4, unit: { power: 3, hp: 6, arena: 'ground', keywords: {} } }),
  swu('swu-IC27-004', { type: 'leader', cost: 6, traits: jedi, unit: { power: 4, hp: 7, arena: 'ground', keywords: { restore: 2 } } }),
  card('plain', { type: 'base', hp: 30 }),
  card('kashyyyk', { type: 'base', hp: 30, traits: ['Kashyyyk'] }),
  card('big', { cost: 5, power: 5, hp: 5 }),
  card('small', { cost: 1, power: 1, hp: 4 }),
  card('cheap', { cost: 2, power: 2, hp: 2 }),
  card('forceUnit', { cost: 2, power: 2, hp: 3, traits: ['Force', 'Jedi'] }),
  card('xp', { name: 'Experience', type: 'upgrade', token: true, power: 1, hp: 1, arena: undefined }),
  card('shield', { name: 'Shield', type: 'upgrade', token: true, power: 0, hp: 0, arena: undefined }),
  card('swu-THMW-T03', { name: 'Beast', token: true, power: 3, hp: 3, traits: ['Creature'] }),
  card('commandHeroism', { type: 'event', cost: 1, arena: undefined, aspects: ['Command', 'Heroism'] }),
  card('command', { type: 'event', cost: 1, arena: undefined, aspects: ['Command'] }),
  swu('swu-LAW-039', { cost: 3, power: 2, hp: 1, traits: ['Underworld', 'Bounty Hunter'] }),
  swu('swu-LOF-100', { cost: 7, power: 7, hp: 7, traits: jedi }),
  swu('swu-IC27-079', { cost: 5, power: 5, hp: 5, traits: jedi }),
  swu('swu-IC27-039', { cost: 5, power: 4, hp: 5, traits: jedi }),
  swu('swu-SEC-051', { cost: 9, power: 8, hp: 8, traits: ['Mandalorian'] }),
  swu('swu-HMW-038', { type: 'upgrade', cost: 3, power: 2, hp: 2, arena: undefined, unique: false, traits: ['Innate'] }),
  swu('swu-HMW-035', { cost: 6, power: 4, hp: 7, traits: ['Clone'] }),
  swu('swu-SEC-098', { cost: 4, power: 4, hp: 5, traits: ['Naboo', 'Republic', 'Trooper'] }),
  swu('swu-IC27-081', { cost: 6, power: 5, hp: 5, traits: jedi }),
  swu('swu-ASH-056', { cost: 2, power: 2, hp: 4, traits: ['Jedi', 'Droid'] }),
  swu('swu-HMW-151', { type: 'event', cost: 5, arena: undefined, unique: false, traits: ['Disaster'] }),
  swu('swu-LOF-096', { cost: 3, power: 3, hp: 5, traits: jedi }),
  swu('swu-SEC-094', { cost: 2, power: 2, hp: 4, traits: ['Separatist', 'Official'] }),
  swu('swu-ASH-109', { cost: 4, power: 2, hp: 6, arena: 'space', traits: ['Jedi', 'Vehicle', 'Transport'] }),
  swu('swu-LAW-133', { type: 'event', cost: 6, arena: undefined, unique: false, traits: ['Innate'] }),
  swu('swu-LAW-041', { type: 'event', cost: 5, arena: undefined, unique: false, traits: ['Innate'] }),
  swu('swu-JTL-096', { cost: 3, power: 3, hp: 3, arena: 'space', traits: ['Rebel', 'Vehicle', 'Fighter'] }),
  // Kenobi Yellow Force
  swu('swu-LOF-008', { type: 'leader', cost: 5, traits: jedi, unit: { power: 3, hp: 6, arena: 'ground', keywords: {} } }),
  swu('swu-LOF-029', { type: 'base', hp: 28, arena: undefined, unique: false, traits: ['Ilum'] }),
  swu('swu-ASH-114', { type: 'upgrade', cost: 2, power: 2, hp: 2, arena: undefined, traits: ['Item', 'Weapon', 'Lightsaber'] }),
  swu('swu-ASH-222', { cost: 4, power: 4, hp: 4, arena: 'space', unique: false, traits: ['Vehicle', 'Fighter'] }),
  swu('swu-SEC-233', { type: 'event', cost: 3, arena: undefined, unique: false }),
  swu('swu-LOF-111', { cost: 3, power: 3, hp: 4, traits: ['Underworld'] }),
  swu('swu-HMW-048', { cost: 6, power: 5, hp: 5, traits: jedi }),
  swu('swu-LOF-193', { cost: 2, power: 2, hp: 3, unique: false, traits: ['Force', 'Jedi'] }),
  swu('swu-SEC-101', { cost: 5, power: 5, hp: 3, traits: ['Naboo', 'Official'] }),
  card('spy', { name: 'Spy', token: true, power: 0, hp: 2, traits: ['Official'], text: '[Raid 2]' }),
  swu('swu-LAW-067', { cost: 2, power: 2, hp: 2, traits: ['Rebel'] }),
  swu('swu-HMW-124', { cost: 7, power: 7, hp: 7, traits: jedi }),
  swu('swu-HMW-210', { cost: 2, power: 2, hp: 2, traits: ['Force', 'Jedi'] }),
  card('swu-HMW-235', { name: 'Gaderffii Stick', type: 'upgrade', cost: 1, power: 2, hp: 1, arena: undefined, traits: ['Item', 'Weapon'], text: 'Attach to a non-[{Vehicle}] unit with 3 or less power.' }),
  swu('swu-LOF-195', { cost: 3, power: 3, hp: 4, traits: jedi }),
  swu('swu-HMW-208', { cost: 1, power: 1, hp: 3, traits: ['Force', 'Rebel'] }),
  swu('swu-LAW-168', { type: 'event', cost: 4, arena: undefined, unique: false }),
  swu('swu-LOF-227', { type: 'event', cost: 4, arena: undefined, unique: false }),
  swu('swu-ASH-253', { cost: 3, power: 2, hp: 4, arena: 'space', unique: false, traits: ['Vehicle', 'Fighter'] }),
  card('fighter', { cost: 2, power: 2, hp: 3, arena: 'space', traits: ['Vehicle', 'Fighter'] }),
  // Wicket Green
  swu('swu-HMW-014', { type: 'leader', cost: 4, traits: ['Ewok'], unit: { power: 2, hp: 5, arena: 'ground', keywords: {} } }),
  card('endor', { type: 'base', hp: 30, traits: ['Endor'] }),
  swu('swu-JTL-153', { cost: 6, power: 5, hp: 7, arena: 'space', unique: false, traits: ['Rebel', 'Vehicle', 'Capital Ship'] }),
  swu('swu-JTL-250', { cost: 3, power: 3, hp: 3, arena: 'space', traits: ['Rebel', 'Vehicle', 'Fighter'] }),
  swu('swu-HMW-126', { type: 'upgrade', cost: 2, arena: undefined, unique: false, traits: ['Fortification'] }),
  swu('swu-SEC-163', { cost: 2, power: 3, hp: 1, unique: false, traits: ['Fringe', 'Official'] }),
  swu('swu-HMW-130', { cost: 1, power: 2, hp: 1, traits: ['Imperial', 'Clone'] }),
  swu('swu-HMW-118', { cost: 4, power: 5, hp: 4, unique: false, traits: ['Wookiee'] }),
  swu('swu-SEC-104', { type: 'upgrade', cost: 3, power: 2, hp: 2, arena: undefined, unique: false, traits: ['Innate'] }),
  swu('swu-ASH-034', { cost: 1, power: 3, hp: 3, traits: ['Ewok'] }),
  swu('swu-HMW-193', { type: 'event', cost: 2, arena: undefined, unique: false, traits: ['Disaster'] }),
  swu('swu-HMW-177', { cost: 2, power: 3, hp: 2, unique: false, traits: ['Ewok'] }),
  swu('swu-ASH-168', { cost: 2, power: 2, hp: 3, traits: ['Fringe'] }),
  swu('swu-JTL-151', { cost: 3, power: 3, hp: 4, arena: 'space', traits: ['Rebel', 'Vehicle', 'Fighter'] }),
  swu('swu-HMW-045', { cost: 2, power: 1, hp: 5, traits: ['Ewok'] }),
  swu('swu-SEC-148', { cost: 2, power: 3, hp: 2, traits: ['Rebel'] }),
  swu('swu-HMW-115', { cost: 1, power: 2, hp: 3, traits: ['Rebel', 'Official'] }),
  swu('swu-ASH-163', { type: 'event', cost: 2, arena: undefined, unique: false, traits: ['Gambit'] }),
  card('aggressionHeroism', { type: 'event', cost: 1, arena: undefined, aspects: ['Aggression', 'Heroism'] }),
  card('wall', { cost: 6, power: 1, hp: 9 }),
  // Veiled Icons Greef
  swu('swu-ASH-017', { type: 'leader', cost: 6, traits: ['Underworld', 'Official'], unit: { power: 4, hp: 7, arena: 'ground', keywords: {} } }),
  card('advantage', { name: 'Advantage', type: 'upgrade', token: true, power: 1, hp: 0, arena: undefined }),
  swu('swu-LAW-219', { cost: 3, power: 3, hp: 2, arena: 'space', traits: ['Vehicle'] }),
  swu('swu-ASH-208', { cost: 5, power: 4, hp: 5, traits: ['Mandalorian', 'Rebel'] }),
  swu('swu-LAW-224', { cost: 8, power: 9, hp: 7, arena: 'space', traits: ['Rebel', 'Vehicle', 'Capital Ship'] }),
  swu('swu-ASH-206', { cost: 4, power: 3, hp: 5, traits: ['Force', 'Jedi'] }),
  swu('swu-JTL-203', {
    cost: 5,
    power: 4,
    hp: 5,
    traits: ['Rebel', 'Pilot'],
    piloting: 2,
    upgrade: { power: 2, hp: 3 },
    pilotText: swuScripts.find((s) => s.card === 'swu-JTL-203')!.pilotText,
  }),
  card('fighter', { cost: 2, power: 2, hp: 3, arena: 'space', traits: ['Vehicle', 'Fighter'] }),
  card('vigilant', { cost: 2, power: 1, hp: 3, aspects: ['Vigilance'] }),
  card('aggressive', { cost: 2, power: 1, hp: 3, aspects: ['Aggression'] }),
]

const act = (state: GameState, p: PlayerId, action: Action) => applyAction(state, p, action)
const answer = (state: GameState, ...picks: string[]) => act(state, state.prompt!.player, { type: 'answer', picks })
const yes = (state: GameState) => answer(state, 'yes')

function table(o: { leader0?: string; base0?: string; units0?: string[]; units1?: string[]; hand0?: string[]; deck0?: string[] } = {}) {
  let state = createGame({
    seed: 3,
    defs,
    decks: [
      { name: 'One', leader: o.leader0 ?? 'leader', base: o.base0 ?? 'plain', deck: o.deck0 ?? Array(20).fill('big') },
      { name: 'Two', leader: 'leader', base: 'plain', deck: Array(20).fill('big') },
    ],
  })
  state = act(state, state.chooser, { type: 'first', goFirst: true })
  state = act(state, state.initiative, { type: 'mulligan', take: false })
  state = act(state, state.initiative === 0 ? 1 : 0, { type: 'mulligan', take: false })
  for (const p of [0, 1] as const) state = act(state, p, { type: 'resource', cards: state.players[p].hand.slice(0, 2).map((c) => c.id) })
  state.active = 0
  const place = (p: PlayerId, ids: string[]): UnitState[] =>
    ids.map((id, i) => ({ id: `u${p}${i}`, def: id, owner: p, arena: defs.find((d) => d.id === id)!.arena ?? 'ground', damage: 0, exhausted: false, upgrades: [] }))
  state.players[0].units = place(0, o.units0 ?? [])
  state.players[1].units = place(1, o.units1 ?? [])
  state.players[0].hand = (o.hand0 ?? []).map((id, i) => ({ id: `h${i}`, def: id }))
  for (const pl of state.players) pl.resources = Array.from({ length: 10 }, (_, i) => ({ card: { id: `r${pl.name}${i}`, def: 'big' }, exhausted: false }))
  return state
}
const unit = (state: GameState, id: string) => [...state.players[0].units, ...state.players[1].units].find((u) => u.id === id)
const tokensOn = (state: GameState, id: string, name: string) => unit(state, id)!.upgrades.filter((u) => state.defs[u.def].name === name).length
const played = (state: GameState, name: string) => state.players[0].units.find((u) => state.defs[u.def].name === name)!
const ready = (state: GameState, p: PlayerId) => state.players[p].resources.filter((r) => !r.exhausted).length

test('every scripted SWU card is scripted for its text', () => {
  for (const d of defs.filter((d) => d.id.startsWith('swu-') && !d.token)) assert.equal(scriptStatus(d), 'scripted', d.name)
})

test('Mace Windu (leader): pay 1 and exhaust, attack with a unit that gains Restore 2', () => {
  let state = table({ leader0: 'swu-IC27-004', units0: ['cheap'] })
  state.players[0].base.damage = 5
  state = act(state, 0, { type: 'ability', source: 'leader', index: 0 })
  // The only unit is picked by itself; the attack's target is asked
  if (state.prompt?.options.some((o) => o.id === 'u00')) state = answer(state, 'u00')
  state = answer(state, 'base1')
  assert.equal(state.players[1].base.damage, 2)
  assert.equal(state.players[0].base.damage, 3, 'Restore 2')
  assert.equal(ready(state, 0), 9)
  assert.ok(state.players[0].leader.exhausted)
})

test('Mace Windu (leader unit): When Deployed resources the top card of the deck', () => {
  let state = table({ leader0: 'swu-IC27-004' })
  const before = state.players[0].resources.length
  const top = state.players[0].deck[0].id
  state = act(state, 0, { type: 'deploy' })
  assert.equal(state.players[0].resources.length, before + 1)
  assert.equal(state.players[0].resources.at(-1)!.card.id, top)
  assert.ok(keywordsOf(state, unit(state, 'L0')!).restore === 2)
})

test('Latts Razzi: an Experience token, then her power in damage to an enemy ground unit', () => {
  let state = table({ units1: ['big'], hand0: ['swu-LAW-039'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, '0')
  if (state.prompt) state = answer(state, 'u10')
  assert.equal(tokensOn(state, 'h0', 'Experience'), 1)
  assert.equal(unit(state, 'u10')!.damage, 3, '2 power plus the Experience')
})

test('Kelleran Beq: plays a unit from the top 7 for 3 less', () => {
  let state = table({ hand0: ['swu-LOF-100'], deck0: ['small', 'small', 'big', ...Array(17).fill('small')] })
  const big = state.players[0].deck.find((c) => c.def === 'big')
  // The deck was shuffled: put the big unit on top
  state.players[0].deck = [big!, ...state.players[0].deck.filter((c) => c !== big)]
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, big!.id)
  assert.ok(unit(state, big!.id), 'played')
  assert.equal(ready(state, 0), 10 - 7 - 2, '5 less 3')
})

test('Qui-Gon Jinn gives another friendly unit +2/+2 for this phase', () => {
  let state = table({ units0: ['cheap'], hand0: ['swu-IC27-079'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  if (state.prompt) state = answer(state, 'u00')
  assert.equal(powerOf(state, unit(state, 'u00')!), 4)
  assert.equal(hpOf(state, unit(state, 'u00')!), 4)
})

test('Ahsoka Tano may defeat a unit that costs 3 or less', () => {
  let state = table({ units1: ['cheap', 'big'], hand0: ['swu-IC27-039'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.deepEqual(state.prompt!.options.map((o) => o.id), ['u10'], 'not the 5-cost')
  state = answer(state, 'u10')
  assert.equal(unit(state, 'u10'), undefined)
})

test('Bo-Katan Kryze: each enemy unit -3/-3, and an Experience token for each enemy unit defeated', () => {
  let state = table({ units0: ['small'], units1: ['cheap', 'cheap', 'small', 'big'], hand0: ['swu-SEC-051'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  while (state.prompt) state = answer(state, state.prompt.options.find((o) => o.id === 'u00')?.id ?? state.prompt.options[0].id)
  assert.equal(unit(state, 'u10'), undefined, '2/2 defeated')
  assert.equal(unit(state, 'u11'), undefined, '2/2 defeated')
  assert.equal(hpOf(state, unit(state, 'u12')!), 1, '1/4 now -2/1')
  assert.equal(powerOf(state, unit(state, 'u13')!), 2, '5/5 now 2/2')
  const xp = tokensOn(state, 'u00', 'Experience') + tokensOn(state, 'h0', 'Experience')
  assert.equal(xp, 2)
})

test('Bestial Bond creates a Beast token on a Force unit, not on another', () => {
  let state = table({ units0: ['forceUnit'], hand0: ['swu-HMW-038'] })
  state = act(state, 0, { type: 'play', card: 'h0', attachTo: 'u00' })
  assert.equal(state.players[0].units.filter((u) => u.def === 'swu-THMW-T03').length, 1)
  let other = table({ units0: ['cheap'], hand0: ['swu-HMW-038'] })
  other = act(other, 0, { type: 'play', card: 'h0', attachTo: 'u00' })
  assert.equal(other.players[0].units.filter((u) => u.def === 'swu-THMW-T03').length, 0)
})

test('Hunter: choose two, the same twice: two attacks with exhausted units, not on bases', () => {
  let state = table({ units0: ['big'], units1: ['small', 'cheap'], hand0: ['swu-HMW-035'] })
  state.players[0].units[0].exhausted = true
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, '1')
  if (state.prompt?.options.some((o) => o.id === 'u00') && state.prompt.options.length > 1) state = answer(state, 'u00')
  assert.ok(!state.prompt!.options.some((o) => o.id === 'base1'), 'no base')
  state = answer(state, 'u11')
  assert.equal(unit(state, 'u11'), undefined)
  state = answer(state, '0')
  state = answer(state, 'u00')
  assert.equal(tokensOn(state, 'u00', 'Shield'), 1)
})

test('Captain Typho: attacked, disclosing Command and Heroism heals 1 from the base', () => {
  let state = table({ units1: ['swu-SEC-098'], units0: ['cheap'] })
  state.players[1].base.damage = 3
  state.players[1].hand = [{ id: 'x1', def: 'commandHeroism' }]
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  state = yes(state)
  assert.equal(state.players[1].base.damage, 2)
  assert.equal(state.revealed?.[1]?.cards[0], 'commandHeroism')
})

test("Captain Typho can't disclose without the icons", () => {
  let state = table({ units1: ['swu-SEC-098'], units0: ['cheap'] })
  state.players[1].base.damage = 3
  state.players[1].hand = [{ id: 'x1', def: 'command' }]
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  assert.ok(!state.prompt)
  assert.equal(state.players[1].base.damage, 3)
})

test('Mace Windu (Dropping By) gets an Experience token on attack', () => {
  let state = table({ units0: ['swu-IC27-081'] })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'base' })
  assert.equal(tokensOn(state, 'u00', 'Experience'), 1)
  assert.equal(state.players[1].base.damage, 6)
})

test('Huyang may give an upgraded unit -4/-0', () => {
  let state = table({ units0: ['swu-ASH-056'], units1: ['big'] })
  state.players[1].units[0].upgrades.push({ id: 'x9', def: 'xp', owner: 1 })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'base' })
  state = answer(state, 'u10')
  assert.equal(powerOf(state, unit(state, 'u10')!), 2, '5 + 1 - 4')
})

test('Overgrowth: with a Kashyyyk base, a friendly unit deals its power to an enemy unit; then resourced', () => {
  let state = table({ base0: 'kashyyyk', units0: ['big'], units1: ['cheap', 'small'], hand0: ['swu-HMW-151'] })
  const resources = state.players[0].resources.length
  state = act(state, 0, { type: 'play', card: 'h0' })
  if (state.prompt?.options.some((o) => o.id === 'u00')) state = answer(state, 'u00')
  state = answer(state, 'u11')
  assert.equal(unit(state, 'u11'), undefined)
  assert.equal(state.players[0].resources.length, resources + 1)
  assert.ok(!state.players[0].discard.some((c) => c.id === 'h0'))
  let plain = table({ units0: ['big'], units1: ['cheap'], hand0: ['swu-HMW-151'] })
  plain = act(plain, 0, { type: 'play', card: 'h0' })
  assert.equal(unit(plain, 'u10')!.damage, 0, 'no Kashyyyk base')
})

test('Obi-Wan Kenobi gains Sentinel as he is played and when a Force unit is', () => {
  let state = table({ hand0: ['swu-LOF-096', 'forceUnit'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.ok(keywordsOf(state, played(state, 'Obi-Wan Kenobi')).sentinel)
  let next = table({ units0: ['swu-LOF-096'], hand0: ['cheap', 'forceUnit'] })
  next = act(next, 0, { type: 'play', card: 'h0' })
  assert.ok(!keywordsOf(next, unit(next, 'u00')!).sentinel, 'not a Force unit')
  next.active = 0
  next = act(next, 0, { type: 'play', card: 'h1' })
  assert.ok(keywordsOf(next, unit(next, 'u00')!).sentinel)
})

test('Mina Bonteri: defeated, disclosing Command, Command, Heroism draws a card', () => {
  let state = table({ units0: ['swu-SEC-094'], units1: ['big'], hand0: ['commandHeroism', 'command'] })
  state.players[0].units[0].damage = 3
  state.active = 1
  const hand = state.players[0].hand.length
  state = act(state, 1, { type: 'attack', attacker: 'u10', target: 'u00' })
  state = yes(state)
  assert.equal(state.players[0].hand.length, hand + 1)
})

test('T-6 Shuttle 1974: another unit +2/+2, and it may attack', () => {
  let state = table({ units0: ['swu-ASH-109', 'cheap'] })
  state = act(state, 0, { type: 'ability', source: 'u00', index: 0 })
  state = answer(state, 'u01')
  state = yes(state)
  state = answer(state, 'base1')
  assert.equal(state.players[1].base.damage, 4)
  assert.ok(unit(state, 'u00')!.exhausted)
})

test('Lost and Forgotten defeats a non-leader unit and heals 3 from your base', () => {
  let state = table({ units1: ['big'], hand0: ['swu-LAW-133'] })
  state.players[0].base.damage = 5
  state = act(state, 0, { type: 'play', card: 'h0' })
  if (state.prompt) state = answer(state, 'u10')
  assert.equal(unit(state, 'u10'), undefined)
  assert.equal(state.players[0].base.damage, 2)
})

test('Nothing Left to Fear: +2/+2, then may defeat a unit with that much power or less', () => {
  let state = table({ units0: ['cheap'], units1: ['big', 'small'], hand0: ['swu-LAW-041'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  if (state.prompt?.options.some((o) => o.id === 'u00')) state = answer(state, 'u00')
  assert.deepEqual(state.prompt!.options.map((o) => o.id), ['u00', 'u11'], '4 power or less: not the 5/5')
  state = answer(state, 'u11')
  assert.equal(unit(state, 'u11'), undefined)
})

test('Blue Leader may pay 2 to move to the ground with 2 Experience tokens', () => {
  let state = table({ hand0: ['swu-JTL-096'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  // When Played first, then Ambush on the ground
  state = answer(state, '0')
  state = yes(state)
  const leader = played(state, 'Blue Leader')
  assert.equal(leader.arena, 'ground')
  assert.equal(tokensOn(state, leader.id, 'Experience'), 2)
  assert.equal(ready(state, 0), 10 - 3 - 2)
})

// --- Kenobi Yellow Force ---
const force = (state: GameState, p: PlayerId) => !!state.force?.[p]
const attachTargets = (state: GameState) => legalActions(state, 0).flatMap((a) => (a.type === 'play' && a.attachTo ? [a.attachTo] : []))

test('Youngling Padawan: the Force is with you', () => {
  let state = table({ hand0: ['swu-LOF-193'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.ok(force(state, 0))
  assert.ok(!force(state, 1))
})

test('Obi-Wan Kenobi (leader): exhaust and use the Force to give an Experience token', () => {
  let state = table({ leader0: 'swu-LOF-008', units0: ['cheap'] })
  assert.ok(!legalActions(state, 0).some((a) => a.type === 'ability'), 'no Force token: no action')
  state.force = [true, false]
  state = act(state, 0, { type: 'ability', source: 'leader', index: 0 })
  if (state.prompt) state = answer(state, 'u00')
  assert.equal(tokensOn(state, 'u00', 'Experience'), 1)
  assert.ok(!force(state, 0), 'used')
  assert.ok(state.players[0].leader.exhausted)
})

test('Crystal Caves: a friendly Force unit attacking makes the Force with you', () => {
  let state = table({ base0: 'swu-LOF-029', units0: ['cheap', 'forceUnit'] })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'base' })
  assert.ok(!force(state, 0), 'not a Force unit')
  state.active = 0
  state = act(state, 0, { type: 'attack', attacker: 'u01', target: 'base' })
  assert.ok(force(state, 0))
})

test("Sabine's Lightsaber gives a Force unit Restore 2, not another; not on a Vehicle", () => {
  let state = table({ units0: ['forceUnit', 'cheap', 'fighter'], hand0: ['swu-ASH-114'] })
  assert.ok(!attachTargets(state).includes('u02'), 'no Vehicle')
  state = act(state, 0, { type: 'play', card: 'h0', attachTo: 'u00' })
  assert.equal(keywordsOf(state, unit(state, 'u00')!).restore, 2)
  let other = table({ units0: ['cheap'], hand0: ['swu-ASH-114'] })
  other = act(other, 0, { type: 'play', card: 'h0', attachTo: 'u00' })
  assert.ok(!keywordsOf(other, unit(other, 'u00')!).restore)
})

test('Gaderffii Stick attaches only to a unit with 3 or less power', () => {
  const state = table({ units0: ['cheap', 'big'], hand0: ['swu-HMW-235'] })
  assert.deepEqual(attachTargets(state), ['u00'])
})

test('Unsanctioned Patrol (Support): another unit attacks with Saboteur, past a Sentinel', () => {
  let state = table({ units0: ['fighter'], units1: ['swu-ASH-109'], hand0: ['swu-ASH-222'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, 'u00')
  // Saboteur: the base, though T-6 Shuttle is a Sentinel
  assert.ok(state.prompt!.options.some((o) => o.id === 'base1'))
  state = answer(state, 'base1')
  assert.equal(state.players[1].base.damage, 2)
})

test('Yellow Aces Bomber (Support): an upgraded supported unit deals 2 more to a base', () => {
  let state = table({ units0: ['fighter'], hand0: ['swu-ASH-253'] })
  state.players[0].units[0].upgrades.push({ id: 'x1', def: 'xp', owner: 0 })
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, 'u00')
  state = answer(state, 'base1')
  if (state.prompt) state = answer(state, 'base1')
  assert.equal(state.players[1].base.damage, 3 + 2)
})

test("Beguile returns an enemy unit that costs 6 or less to its owner's hand", () => {
  let state = table({ units1: ['big', 'swu-HMW-124'], hand0: ['swu-SEC-233'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.deepEqual(state.prompt!.options.map((o) => o.id), ['u10'], 'not the 7-cost')
  state = answer(state, 'u10')
  assert.ok(state.players[1].hand.some((c) => c.id === 'u10'))
})

test('Maz Kanata: a Force unit may attack with +2/+0', () => {
  let state = table({ units0: ['forceUnit', 'cheap'], hand0: ['swu-LOF-111'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.deepEqual(state.prompt!.options.map((o) => o.id), ['u00'])
  state = answer(state, 'u00')
  state = answer(state, 'base1')
  assert.equal(state.players[1].base.damage, 4)
})

test('Vernestra Rwoh (We Should Handle This Ourselves): a unit from the discard pile under the deck, its When Played hers', () => {
  let state = table({ units0: ['cheap'], hand0: ['swu-HMW-048'] })
  state.players[0].discard = [{ id: 'd1', def: 'swu-IC27-079' }, { id: 'd2', def: 'big' }]
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, 'd1')
  assert.equal(state.players[0].deck.at(-1)!.id, 'd1')
  // Qui-Gon's When Played, as hers: another friendly unit +2/+2
  if (state.prompt) state = answer(state, 'u00')
  assert.equal(powerOf(state, unit(state, 'u00')!), 4)
})

test('Queen Amidala: 2 Spy tokens, and one defeated to prevent lethal damage to her', () => {
  let state = table({ units1: ['big'], hand0: ['swu-SEC-101'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  const spies = state.players[0].units.filter((u) => state.defs[u.def].name === 'Spy')
  assert.equal(spies.length, 2)
  state.active = 1
  state = act(state, 1, { type: 'attack', attacker: 'u10', target: 'h0' })
  if (state.prompt) state = answer(state, spies[0].id)
  assert.equal(unit(state, 'h0')!.damage, 0)
  assert.equal(state.players[0].units.filter((u) => state.defs[u.def].name === 'Spy').length, 1)
})

test('Jyn Erso exhausts an enemy unit', () => {
  let state = table({ units1: ['big'], hand0: ['swu-LAW-067'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, '1')
  if (state.prompt) state = answer(state, 'u10')
  assert.ok(unit(state, 'u10')!.exhausted)
})

test('Luminara Unduli: playing a unit lets a unit attack with +2/+0', () => {
  let state = table({ units0: ['swu-HMW-124', 'cheap'], hand0: ['small'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, 'u01')
  state = answer(state, 'base1')
  assert.equal(state.players[1].base.damage, 4)
})

test('Sol gains Sentinel on attack', () => {
  let state = table({ units0: ['swu-HMW-210'] })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'base' })
  assert.ok(keywordsOf(state, unit(state, 'u00')!).sentinel)
})

test('Vernestra Rwoh (Precocious Knight) may use the Force to ready herself', () => {
  let state = table({ hand0: ['swu-LOF-195'] })
  state.force = [true, false]
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = yes(state)
  assert.ok(!unit(state, 'h0')!.exhausted)
  assert.ok(!force(state, 0))
})

test('Luke Skywalker enters play ready in the first round only', () => {
  let state = table({ hand0: ['swu-HMW-208'] })
  state.round = 1
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.ok(!unit(state, 'h0')!.exhausted)
  let later = table({ hand0: ['swu-HMW-208'] })
  later.round = 2
  later = act(later, 0, { type: 'play', card: 'h0' })
  assert.ok(unit(later, 'h0')!.exhausted)
})

test('Haymaker: an Experience token, then that much damage to an enemy unit in the same arena', () => {
  let state = table({ units0: ['cheap'], units1: ['big'], hand0: ['swu-LAW-168'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  if (state.prompt?.options.some((o) => o.id === 'u00')) state = answer(state, 'u00')
  if (state.prompt) state = answer(state, 'u10')
  assert.equal(unit(state, 'u10')!.damage, 3)
})

test('The Will of the Force: returns a unit, and with the Force its owner discards at random', () => {
  let state = table({ units1: ['big'], hand0: ['swu-LOF-227'] })
  state.force = [true, false]
  state.players[1].hand = [{ id: 'x1', def: 'small' }]
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, 'u10')
  state = yes(state)
  assert.equal(state.players[1].hand.length, 1, 'the unit back, one card discarded')
  assert.equal(state.players[1].discard.length, 1)
})

// --- Wicket Green ---

test('Wicket (leader): a friendly unit attacking a costlier unit may exhaust him to draw', () => {
  let state = table({ leader0: 'swu-HMW-014', units0: ['cheap'], units1: ['big'] })
  const hand = state.players[0].hand.length
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  state = yes(state)
  assert.equal(state.players[0].hand.length, hand + 1)
  assert.ok(state.players[0].leader.exhausted)
  // Attacking a cheaper unit: nothing asked
  let cheaper = table({ leader0: 'swu-HMW-014', units0: ['big'], units1: ['cheap'] })
  cheaper = act(cheaper, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  assert.ok(!cheaper.players[0].leader.exhausted)
  assert.ok(!cheaper.prompt || !/Wicket/.test(cheaper.prompt.text))
})

test('Wicket (leader unit): On Attack, with a unit costing 3 or less, draw a card', () => {
  let state = table({ leader0: 'swu-HMW-014', units0: ['cheap'] })
  state.players[0].leader.deployed = true
  state.players[0].units.push({ id: 'lw', def: 'swu-HMW-014', owner: 0, arena: 'ground', damage: 0, exhausted: false, upgrades: [], leader: true } as UnitState)
  const hand = state.players[0].hand.length
  state = act(state, 0, { type: 'attack', attacker: 'lw', target: 'base' })
  assert.equal(state.players[0].hand.length, hand + 1)
})

test('Rebellious Hammerhead deals damage equal to the cards in hand', () => {
  let state = table({ units1: ['big'], hand0: ['swu-JTL-153', 'small', 'small', 'small'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, 'u10')
  assert.equal(unit(state, 'u10')!.damage, 3)
})

test("Sabine's Masterpiece: each aspect among friendly units adds its effect", () => {
  let state = table({ units0: ['swu-JTL-250', 'vigilant', 'aggressive'], units1: ['big'] })
  state.players[0].base.damage = 4
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'base' })
  state = answer(state, 'base0')
  state = answer(state, 'u10')
  assert.equal(state.players[0].base.damage, 2, 'Vigilance: heal 2')
  assert.equal(unit(state, 'u10')!.damage, 1, 'Aggression: 1 damage')
  assert.equal(state.players[1].base.damage, 3)
})

test('Verdant Fortress: on the base, friendly units gain Raid 1', () => {
  let state = table({ units0: ['cheap'], units1: ['small'], hand0: ['swu-HMW-126'] })
  state = act(state, 0, { type: 'play', card: 'h0', attachTo: 'base0' })
  assert.equal(state.players[0].base.upgrades?.length, 1)
  assert.equal(keywordsOf(state, unit(state, 'u00')!).raid, 1)
  assert.ok(!keywordsOf(state, unit(state, 'u10')!).raid)
})

test('Outer Rim Constable may defeat an upgrade', () => {
  let state = table({ units1: ['big'], hand0: ['swu-SEC-163'] })
  unit(state, 'u10')!.upgrades.push({ id: 'k1', def: 'shield', owner: 1 })
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, 'k1')
  assert.equal(unit(state, 'u10')!.upgrades.length, 0)
})

test('Emerie Karr: 1 damage to a friendly ground unit makes the next unit cost 1 less', () => {
  let state = table({ units0: ['small'], hand0: ['swu-HMW-130', 'big'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, 'u00')
  assert.equal(unit(state, 'u00')!.damage, 1)
  assert.equal(ready(state, 0), 9)
  state.active = 0
  state = act(state, 0, { type: 'play', card: 'h1' })
  assert.equal(ready(state, 0), 5, 'the 5-cost unit for 4')
})

test('Ryyk Blademaster gains Ambush and Overwhelm with 6 or more resources', () => {
  const state = table({ units0: ['swu-HMW-118'] })
  const k = keywordsOf(state, unit(state, 'u00')!)
  assert.ok(k.ambush && k.overwhelm)
  state.players[0].resources = state.players[0].resources.slice(0, 5)
  assert.ok(!keywordsOf(state, unit(state, 'u00')!).overwhelm)
})

test('Figure of Unity: only on a unique unit; while it is ready, other friendly units gain Overwhelm, Raid 1 and Restore 1', () => {
  let state = table({ units0: ['swu-ASH-034', 'cheap'], hand0: ['swu-SEC-104'] })
  const onto = legalActions(state, 0).flatMap((a) => (a.type === 'play' && a.card === 'h0' && a.attachTo ? [a.attachTo] : []))
  assert.deepEqual(onto, ['u00'], 'only on the unique unit')
  state = act(state, 0, { type: 'play', card: 'h0', attachTo: 'u00' })
  assert.equal(unit(state, 'u00')!.upgrades.length, 1)
  const k = keywordsOf(state, unit(state, 'u01')!)
  assert.ok(k.overwhelm && k.raid === 1 && k.restore === 1)
  assert.ok(!keywordsOf(state, unit(state, 'u00')!).overwhelm, 'not the unit it is on')
  unit(state, 'u00')!.exhausted = true
  assert.ok(!keywordsOf(state, unit(state, 'u01')!).overwhelm)
})

test("Wicket (Yub Nub!) can't attack bases", () => {
  const state = table({ units0: ['swu-ASH-034'], units1: ['small'] })
  const targets = legalActions(state, 0)
    .filter((a) => a.type === 'attack' && a.attacker === 'u00')
    .map((a) => (a as { target: string }).target)
  assert.deepEqual(targets, ['u10'])
})

test('Nightfall: 1 damage, then with an Endor base an attack with +2/+0', () => {
  let state = table({ base0: 'endor', units0: ['cheap'], units1: ['big'], hand0: ['swu-HMW-193'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  if (state.prompt && /Nightfall: deal/.test(state.prompt.text)) state = answer(state, 'u10')
  state = answer(state, 'u00')
  state = answer(state, 'base1')
  assert.equal(unit(state, 'u10')!.damage, 1)
  assert.equal(state.players[1].base.damage, 4)
})

test('Adamant Ewoks: with another Ewok, 1 damage to a base and 1 to an enemy unit', () => {
  let state = table({ units0: ['swu-HMW-045'], units1: ['big'], hand0: ['swu-HMW-177'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = yes(state)
  state = answer(state, 'base1')
  if (state.prompt) state = answer(state, 'u10')
  assert.equal(state.players[1].base.damage, 1)
  assert.equal(unit(state, 'u10')!.damage, 1)
})

test('Migs Mayfeld deals 1 damage to the defender on attack, 2 when upgraded', () => {
  let state = table({ units0: ['swu-ASH-168'], units1: ['wall'] })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  assert.equal(unit(state, 'u10')!.damage, 3, '1, then 2 combat damage')
  let up = table({ units0: ['swu-ASH-168'], units1: ['wall'] })
  unit(up, 'u00')!.upgrades.push({ id: 'k1', def: 'xp', owner: 0 })
  up = act(up, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  assert.equal(unit(up, 'u10')!.damage, 5, '2, then 3 combat damage')
})

test('Red Five may deal 2 damage to a damaged unit on attack', () => {
  let state = table({ units0: ['swu-JTL-151'], units1: ['big'] })
  unit(state, 'u10')!.damage = 1
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'base' })
  state = answer(state, 'u10')
  assert.equal(unit(state, 'u10')!.damage, 3)
})

test('Logray: another friendly unit costing 3 or less is dealt damage, 1 damage to an enemy unit', () => {
  let state = table({ units0: ['swu-HMW-045', 'cheap'], units1: ['big'] })
  state = act(state, 0, { type: 'attack', attacker: 'u01', target: 'u10' })
  state = answer(state, 'u10')
  assert.equal(unit(state, 'u10')!.damage, 3, '2 combat, 1 from Logray')
})

test('Karis Nemik: defeated, disclose Aggression Heroism for a ready Spy token', () => {
  let state = table({ units0: ['swu-SEC-148'], units1: ['big'], hand0: ['aggressionHeroism'] })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  state = yes(state)
  const spy = state.players[0].units.find((u) => state.defs[u.def].name === 'Spy')
  assert.ok(spy && !spy.exhausted)
})

test('Leia Organa: playing another unit costing 3 or less heals 1 from the base', () => {
  let state = table({ units0: ['swu-HMW-115'], hand0: ['cheap', 'big'] })
  state.players[0].base.damage = 3
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.equal(state.players[0].base.damage, 2)
  state.active = 0
  state = act(state, 0, { type: 'play', card: 'h1' })
  assert.equal(state.players[0].base.damage, 2, 'not for a 5-cost unit')
})

test('Reckless Sacrifice: discard a unit, 5 damage to a unit that costs more', () => {
  let state = table({ units1: ['wall'], hand0: ['swu-ASH-163', 'small'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  if (state.prompt?.options.some((o) => o.id === 'h1')) state = answer(state, 'h1')
  if (state.prompt) state = answer(state, 'u10')
  assert.equal(state.players[0].discard.filter((c) => c.def === 'small').length, 1)
  assert.equal(unit(state, 'u10')!.damage, 5)
})

// --- Veiled Icons Greef ---

test('Greef Karga (leader): exhaust him as you play a unit, an Advantage token on it until its attack ends', () => {
  let state = table({ leader0: 'swu-ASH-017', hand0: ['cheap'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = yes(state)
  const played = state.players[0].units.find((u) => u.def === 'cheap')!
  assert.equal(tokensOn(state, played.id, 'Advantage'), 1)
  assert.equal(powerOf(state, played), 3, '+1/+0')
  assert.equal(hpOf(state, played), 2)
  assert.ok(state.players[0].leader.exhausted)
  played.exhausted = false
  state.active = 0
  state = act(state, 0, { type: 'attack', attacker: played.id, target: 'base' })
  assert.equal(state.players[1].base.damage, 3)
  assert.equal(tokensOn(state, played.id, 'Advantage'), 0, 'defeated as its attack ends')
})

test('Advantage token: defeated as the unit it is on defends', () => {
  let state = table({ units0: ['cheap'], units1: ['wall'] })
  state.players[1].units[0].upgrades.push({ id: 'k1', def: 'advantage', owner: 1 })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  assert.equal(tokensOn(state, 'u10', 'Advantage'), 0)
})

test("Anakin's Podracer: the phase's first attacker deals its combat damage first", () => {
  let state = table({ units0: ['swu-LAW-219', 'fighter'], units1: ['fighter', 'fighter'] })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  assert.ok(unit(state, 'u00'), 'it defeats the fighter before it strikes back')
  assert.equal(unit(state, 'u00')!.damage, 0)
  state = table({ units0: ['swu-LAW-219', 'fighter'], units1: ['fighter', 'fighter'] })
  state = act(state, 0, { type: 'attack', attacker: 'u01', target: 'base' })
  state.active = 0
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  assert.equal(unit(state, 'u00'), undefined, 'after another unit attacked, the two trade')
})

test('Sabine Wren: her Shield token attaching lets her exhaust a ground unit, once', () => {
  let state = table({ units1: ['big'], hand0: ['swu-ASH-208'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.equal(state.prompt?.text.startsWith('Sabine Wren'), true)
  state = answer(state, 'u10')
  assert.ok(unit(state, 'u10')!.exhausted)
  assert.equal(state.prompt, null)
})

test('Liberty: exhaust an enemy unit, its upgrades costing 4 or less back to hand (tokens set aside)', () => {
  let state = table({ units1: ['big'], hand0: ['swu-LAW-224'] })
  const big = state.players[1].units[0]
  big.upgrades.push({ id: 'g1', def: 'swu-ASH-114', owner: 1 }, { id: 'k1', def: 'xp', owner: 1 })
  state = act(state, 0, { type: 'play', card: 'h0' })
  if (state.prompt) state = answer(state, 'u10')
  assert.ok(unit(state, 'u10')!.exhausted)
  assert.equal(unit(state, 'u10')!.upgrades.length, 0)
  assert.ok(state.players[1].hand.some((c) => c.id === 'g1'), 'the lightsaber back to its hand')
  assert.ok(!state.players[1].hand.some((c) => c.id === 'k1'), 'the Experience token set aside')
})

test('Kelleran Beq: +1/+0 for each other unit with 0 power', () => {
  const state = table({ units0: ['swu-ASH-206', 'spy'], units1: ['spy', 'big'] })
  assert.equal(powerOf(state, unit(state, 'u00')!), 5)
})

test('Han Solo (Has His Moments): played as a pilot, the Vehicle may attack', () => {
  let state = table({ units0: ['fighter'], hand0: ['swu-JTL-203'] })
  state = act(state, 0, { type: 'play', card: 'h0', attachTo: 'u00', pilot: true })
  state = yes(state)
  if (state.prompt) state = answer(state, 'base1')
  assert.equal(state.players[1].base.damage, 4, '2 power +2 from Han')
})

test('Greef Karga (leader), AI: an Ambush that defeats its target goes first, the token kept after', () => {
  // Kelleran Beq 3/5 defeats a 2/2 without the +1: Ambush first, the Advantage token stays
  let state = table({ leader0: 'swu-ASH-017', units1: ['cheap'], hand0: ['swu-ASH-206'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  for (let i = 0; i < 6 && state.prompt; i++) state = act(state, 0, chooseAction(state, 0)!)
  const kelleran = state.players[0].units.find((u) => u.def === 'swu-ASH-206')!
  assert.equal(unit(state, 'u10'), undefined, 'the 2/2 is defeated')
  assert.equal(tokensOn(state, kelleran.id, 'Advantage'), 1, 'the token is still on it')
})

test('Greef Karga (leader), AI: the token goes first when the +1 is what defeats the Ambush target', () => {
  // Kelleran Beq 3/5 needs 4 power for a 4-HP unit
  let state = table({ leader0: 'swu-ASH-017', units1: ['small'], hand0: ['swu-ASH-206'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  for (let i = 0; i < 6 && state.prompt; i++) state = act(state, 0, chooseAction(state, 0)!)
  assert.equal(unit(state, 'u10'), undefined, 'the 1/4 is defeated with the +1')
})

test('Sabine Wren with Greef Karga: her Shield token and the Advantage token are two triggers, two units exhausted', () => {
  let state = table({ leader0: 'swu-ASH-017', units1: ['big', 'cheap'], hand0: ['swu-ASH-208'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  for (let i = 0; i < 8 && state.prompt; i++) state = act(state, 0, chooseAction(state, 0)!)
  assert.ok(unit(state, 'u10')!.exhausted && unit(state, 'u11')!.exhausted)
})
