import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyAction, createGame, keywordsOf, legalActions } from './game.ts'
import { readText } from './cards.ts'
import { scripts } from './scripts.ts'
import type { Action, CardDef, GameState, PlayerId, UnitState } from './types.ts'

// Test cards, scripted ones quoting their DUNE card (a leader its two sides)
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
const leaderOf = (name: string, subtitle: string, unit: { power: number; hp: number }) => {
  const info = scripted(name, subtitle)
  const back = readText(info.backText)
  return { ...info, type: 'leader' as const, cost: 5, unit: { ...unit, arena: 'ground' as const, keywords: back.keywords } }
}

const defs: CardDef[] = [
  card('leader', { type: 'leader', cost: 4, unit: { power: 3, hp: 6, arena: 'ground', keywords: {} } }),
  card('chani', leaderOf('Chani', 'Sihaya', { power: 2, hp: 5 })),
  card('shaddam', leaderOf('Shaddam IV', 'Padishah Emperor', { power: 5, hp: 8 })),
  card('baron', leaderOf('Baron Vladimir Harkonnen', 'The Masterstroke', { power: 4, hp: 8 })),
  card('caladan', { ...scripted('Castle Caladan'), type: 'base', hp: 25, traits: ['Caladan'] }),
  card('arrakis', { type: 'base', hp: 30, traits: ['Arrakis'], text: 'You start the game with a [Spice Token].' }),
  card('plain', { type: 'base', hp: 30 }),
  card('trooper', { cost: 1, power: 2, hp: 2, traits: ['Harkonnen'] }),
  card('big', { cost: 5, power: 5, hp: 5 }),
  card('staban', { ...scripted('Staban Tuek'), cost: 5, power: 4, hp: 5 }),
  card('hunter', { ...scripted('Spice Hunter'), cost: 2, power: 3, hp: 2, traits: ['Fremen'] }),
  card('fremenUnit', { cost: 1, power: 1, hp: 1, traits: ['Fremen'] }),
  card('team', { ...scripted('Harkonnen Harvester Team'), cost: 3, power: 3, hp: 4, traits: ['Harkonnen'] }),
  card('desertPower', { ...scripted('Desert Power'), type: 'event', cost: 4, arena: undefined }),
  card('levenbrech', { ...scripted('Sardaukar Levenbrech'), cost: 3, power: 4, hp: 3, traits: ['Sardaukar'] }),
  card('shield', { ...scripted('Personal Shield'), type: 'upgrade', cost: 3, power: 1, hp: 1, arena: undefined }),
  card('feyd', { ...scripted('Feyd-Rautha Harkonnen'), cost: 5, power: 5, hp: 5 }),
]

const act = (state: GameState, p: PlayerId, action: Action) => applyAction(state, p, action)
const answer = (state: GameState, ...picks: string[]) => act(state, state.prompt!.player, { type: 'answer', picks })
const yes = (state: GameState) => answer(state, 'yes')

// Player 0 to act in the action phase, with these leaders, bases, units and hands
function table(o: { leader0?: string; base0?: string; base1?: string; units0?: string[]; units1?: string[]; hand0?: string[] } = {}) {
  let state = createGame({
    seed: 3,
    defs,
    decks: [
      { name: 'One', leader: o.leader0 ?? 'leader', base: o.base0 ?? 'arrakis', deck: Array(20).fill('big') },
      { name: 'Two', leader: 'leader', base: o.base1 ?? 'plain', deck: Array(20).fill('big') },
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
  state.players[0].units = place(0, o.units0 ?? [])
  state.players[1].units = place(1, o.units1 ?? [])
  state.players[0].hand = (o.hand0 ?? []).map((id, i) => ({ id: `h${i}`, def: id }))
  for (const pl of state.players) pl.resources = Array.from({ length: 8 }, (_, i) => ({ card: { id: `r${pl.name}${i}`, def: 'big' }, exhausted: false }))
  return state
}
const spiceAction = (state: GameState): Action => ({ type: 'ability', source: state.players[0].spice[0].id, index: 0 })

test('a base triggers when you defeat a friendly Spice token', () => {
  let state = table({ base0: 'caladan', units0: ['big'] })
  state.players[0].units[0].damage = 2
  state.players[0].spice.push({ id: 'sp', def: 'token-spice' })
  state = act(state, 0, spiceAction(state))
  // The Spice token's own questions first, then Castle Caladan's
  state = answer(state, state.prompt!.options[0].id)
  while (state.prompt?.kind === 'option' && /Spice: put/.test(state.prompt.text)) state = answer(state, '0')
  assert.match(state.prompt!.text, /Castle Caladan: heal 1/)
  state = answer(state, 'u00')
  assert.equal(state.players[0].units[0].damage, 1)
})

test("Staban Tuek: an opponent defeats a Spice token, he creates one, once each round", () => {
  let state = table({ units0: ['hunter', 'fremenUnit'], units1: ['staban'] })
  state.players[1].spice.push({ id: 'x1', def: 'token-spice' }, { id: 'x2', def: 'token-spice' })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'base' })
  state = yes(state)
  assert.equal(state.players[1].spice.length, 2, 'one defeated, one created')
  state.active = 0
  state = act(state, 0, { type: 'attack', attacker: 'u01', target: 'base' })
  // Only the Spice Hunter defeats Spice; and Staban's ability is used for this round
  state.players[0].units[1].exhausted = false
  state.players[0].units[0].exhausted = false
  state.active = 0
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'base' })
  state = yes(state)
  assert.equal(state.players[1].spice.length, 1)
})

test('Chani: each Fremen token created may exhaust her for 1 damage to the enemy base', () => {
  let state = table({ leader0: 'chani', hand0: ['desertPower'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  // Two tokens, two triggers: she exhausts for the first, and can't for the second
  assert.match(state.prompt!.text, /Chani: exhaust/)
  state = yes(state)
  assert.equal(state.prompt, null)
  assert.equal(state.players[1].base.damage, 1)
  assert.ok(state.players[0].leader.exhausted)
})

test('Harkonnen Harvester Team creates a Spice token once each round', () => {
  let state = table({ units0: ['team', 'trooper', 'trooper'], units1: ['big', 'big'], base0: 'plain' })
  state = act(state, 0, { type: 'attack', attacker: 'u01', target: 'u10' })
  assert.equal(state.players[0].spice.length, 1)
  state.active = 0
  state = act(state, 0, { type: 'attack', attacker: 'u02', target: 'u11' })
  assert.equal(state.players[0].spice.length, 1, 'not again this round')
})

test("Shaddam IV: ignores a Sardaukar card's additional cost once each round, and gives Sentinel", () => {
  let state = table({ leader0: 'shaddam', base0: 'plain', hand0: ['levenbrech', 'levenbrech'] })
  // His leader side starts the game with a Spice token
  assert.equal(state.players[0].spice.length, 1)
  state.players[0].spice = []
  state = act(state, 0, { type: 'deploy' })
  assert.equal(state.prompt?.options.length, 2, 'When Deployed: either Levenbrech, for free')
  state = answer(state, 'h0')
  // Free, and its additional cost ignored: no Spice to pay it
  assert.ok(state.players[0].units.some((u) => u.id === 'h0'))
  if (state.prompt) state = answer(state)
  const levenbrech = state.players[0].units.find((u) => u.id === 'h0')!
  assert.ok(keywordsOf(state, levenbrech).sentinel, 'other Sardaukar units gain Sentinel')
  // Used for this round: the second can't be played without Spice
  state.active = 0
  assert.ok(!legalActions(state, 0).some((a) => a.type === 'play'))
})

test("The Baron's Action plays a card from the resources for 1 less, as if using Plot", () => {
  let state = table({ leader0: 'baron', base0: 'arrakis' })
  state.players[0].resources[0].card = { id: 'res', def: 'trooper' }
  state.players[0].deck = [{ id: 'top', def: 'big' }]
  state = act(state, 0, { type: 'ability', source: 'leader', index: 0 })
  state = answer(state, 'res')
  assert.ok(state.players[0].units.some((u) => u.id === 'res'))
  assert.equal(state.players[0].spice.length, 0)
  assert.equal(state.players[0].base.damage, 1)
  assert.equal(state.players[0].resources[0].card.id, 'top')
  assert.ok(state.log.some((l) => /plays trooper using Plot/.test(l.text)))
})

test('Personal Shield: only on a friendly unit, a Shield token again as the regroup phase starts', () => {
  let state = table({ base0: 'plain', units0: ['big'], units1: ['big'], hand0: ['shield'] })
  const targets = legalActions(state, 0).flatMap((a) => (a.type === 'play' ? [a.attachTo] : []))
  assert.deepEqual(targets, ['u00'])
  state = act(state, 0, { type: 'play', card: 'h0', attachTo: 'u00' })
  const shields = (s: GameState) => s.players[0].units[0].upgrades.filter((u) => u.def === 'token-shield').length
  assert.equal(shields(state), 1)
  state.players[0].units[0].upgrades = state.players[0].units[0].upgrades.filter((u) => u.def !== 'token-shield')
  state = act(state, 1, { type: 'pass' })
  state = act(state, 0, { type: 'pass' })
  assert.equal(state.phase, 'regroup')
  assert.equal(shields(state), 1)
})

test('Feyd-Rautha gives a Weakness token to the unit that attacks him', () => {
  let state = table({ units0: ['big'], units1: ['feyd'] })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  assert.ok(state.log.some((l) => l.text === 'big gets a Weakness token'))
  // 5/5 with Weakness: 4 power dealt, and Feyd's 5 defeats it, the token set aside
  assert.equal(state.players[1].units[0].damage, 4)
  assert.equal(state.players[0].units.length, 0)
  assert.deepEqual(state.players[0].discard.map((c) => c.def), ['big'])
})
