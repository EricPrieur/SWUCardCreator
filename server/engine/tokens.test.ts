import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyAction, createGame, hpOf, keywordsOf, legalActions, powerOf, traitsOf } from './game.ts'
import { readText } from './cards.ts'
import { chooseAction } from './ai.ts'
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
  card('caid', { ...scripted('Sardaukar Caid'), cost: 4, power: 5, hp: 4, traits: ['Sardaukar', 'Trooper'] }),
  card('burseg', { ...scripted('Sardaukar Burseg'), cost: 5, power: 4, hp: 7, traits: ['Sardaukar', 'Official'] }),
  card('falseColors', { ...scripted('False Colors'), type: 'event', cost: 2, arena: undefined, traits: ['Sardaukar', 'Tactic'] }),
  card('terror', { ...scripted("The Emperor's Terror"), type: 'event', cost: 6, arena: undefined, traits: ['Emperor', 'Tactic'] }),
  card('household', { ...scripted('Imperial Household Guard'), cost: 2, power: 2, hp: 3 }),
  card('collector', { ...scripted('Imperial Tithe Collector'), cost: 6, power: 4, hp: 6 }),
  card('legion', { ...scripted('Sardaukar Legion'), cost: 7, power: 5, hp: 6, traits: ['Sardaukar', 'Trooper'] }),
  card('shaddamLeader', { ...scriptedBy('Shaddam IV', 'Padishah Emperor'), type: 'leader', cost: 7, unit: { power: 5, hp: 8, arena: 'ground', keywords: {} } }),
  card('shaddam', { ...scriptedBy('Shaddam IV', 'Lion Throne'), cost: 6, power: 6, hp: 8, unique: true, traits: ['Emperor', 'Official'] }),
  card('soldier', { cost: 2, power: 2, hp: 2, traits: ['Trooper'] }),
  card('carrier', { ...scripted('Sardaukar Troop Carrier'), cost: 2, power: 1, hp: 3, arena: 'space', traits: ['Emperor', 'Vehicle', 'Transport'] }),
  card('kynesDream', { ...scripted("Kynes's Dream"), type: 'event', cost: 2, arena: undefined }),
  card('levy', { ...scripted('House Levy'), type: 'event', cost: 2, arena: undefined }),
  card('crossfire', { ...scripted('Crossfire'), type: 'event', cost: 2, arena: undefined }),
  card('plans', { ...scripted('Plans Within Plans'), type: 'event', cost: 2, arena: undefined }),
  card('fremen', { cost: 2, power: 2, hp: 3, traits: ['Fremen', 'Trooper'] }),
  card('snare', { ...scripted('Shigawire Snare'), type: 'event', cost: 2, arena: undefined }),
  card('tanzerouft', { ...scripted('Tanzerouft'), type: 'event', cost: 2, arena: undefined }),
  card('arrakeen', { ...scripted('Battle of Arrakeen'), type: 'event', cost: 4, arena: undefined }),
  card('practice', { ...scripted('Weapons Practice'), type: 'event', cost: 3, arena: undefined }),
  card('sister', { cost: 2, power: 1, hp: 3, traits: ['Bene Gesserit'] }),
  card('honorGuard', { ...scripted('Kaitain Honor Guard'), cost: 3, power: 2, hp: 4 }),
  card('duelist', { ...scripted('Ginaz Shield Duelist'), cost: 3, power: 3, hp: 2 }),
  card('houseFrigate', { ...scripted('Great House Frigate'), cost: 5, power: 4, hp: 5, arena: 'space' }),
  card('proctor', { ...scripted('Bene Gesserit Proctor'), cost: 5, power: 4, hp: 6, traits: ['Bene Gesserit'] }),
  card('hoarder', { ...scripted('Harkonnen Spice Hoarder'), cost: 2, power: 1, hp: 3 }),
  card('siridar', { ...scriptedBy('Baron Vladimir Harkonnen', 'Siridar-Baron'), cost: 8, power: 8, hp: 8, unique: true, traits: ['Harkonnen', 'Official'] }),
  card('harkonnen', { cost: 2, power: 2, hp: 2, traits: ['Harkonnen', 'Trooper'] }),
  card('muaddib', { ...scriptedBy('Paul Atreides', "Muad'Dib"), cost: 9, power: 8, hp: 8, unique: true, traits: ['Atreides', 'Fremen'] }),
  card('stilgarUnit', { ...scriptedBy('Stilgar', 'Desert Commander'), cost: 5, power: 4, hp: 6, unique: true, traits: ['Fremen', 'Official'] }),
  card('heir', { name: 'Paul Atreides', subtitle: 'Heir to House Atreides', cost: 2, power: 2, hp: 3, unique: true, traits: ['Atreides'] }),
  card('sleeper', { ...scripted('The Sleeper Has Awakened'), type: 'event', cost: 5, arena: undefined }),
  card('harah', { ...scripted('Harah'), cost: 1, power: 1, hp: 2, unique: true, traits: ['Fremen'] }),
  card('ramallo', { ...scripted('Ramallo'), cost: 3, power: 1, hp: 3, unique: true, traits: ['Fremen', 'Bene Gesserit'], upgrade: { power: 2, hp: 2 }, attachedKeywords: { restore: 2 } }),
  card('nefud', { ...scripted('Iakin Nefud'), cost: 3, power: 3, hp: 3, unique: true, traits: ['Harkonnen', 'Official'] }),
  card('otheym', { ...scripted('Otheym'), cost: 2, power: 3, hp: 2, unique: true, traits: ['Fremen', 'Fedaykin'] }),
  card('pardot', { ...scripted('Pardot Kynes'), cost: 3, power: 1, hp: 4, unique: true, traits: ['Fremen', 'Emperor'] }),
  card('chaniUnit', { cost: 3, power: 3, hp: 5, unique: true, traits: ['Fremen'] }),
  card('aramsham', { ...scriptedBy('Captain Aramsham', 'Sardaukar Hunter'), cost: 4, power: 4, hp: 5, unique: true, traits: ['Emperor', 'Sardaukar', 'Official'] }),
  card('ambusher', { cost: 3, power: 3, hp: 3, text: '[Ambush]' }),
  card('shielded', { cost: 3, power: 3, hp: 3, text: '[Sentinel]\n[Shielded]' }),
  card('irulanLeader', { ...scriptedBy('Princess Irulan', 'Daughter of the Emperor'), type: 'leader', cost: 5, traits: ['Emperor'], unit: { power: 2, hp: 6, arena: 'ground', keywords: {} } }),
  card('paulLeader', { ...scriptedBy('Paul Atreides', 'Haunted by Dreams'), type: 'leader', cost: 4, traits: ['Atreides'], unit: { power: 2, hp: 5, arena: 'ground', keywords: { raid: 1 } } }),
  card('heirPinger', { ...scriptedBy('Paul Atreides', 'Heir to House Atreides'), cost: 2, power: 3, hp: 3, unique: true, traits: ['Atreides'] }),
  card('emperorGuard', { cost: 2, power: 2, hp: 3, traits: ['Emperor', 'Trooper'] }),
  card('cadet', { ...scripted('Kaitain Cadet'), cost: 1, power: 1, hp: 2, traits: ['Emperor', 'Trooper'] }),
  card('bearer', { ...scripted('Kaitain Shield Bearer'), cost: 2, power: 2, hp: 2, traits: ['Emperor', 'Trooper'] }),
  card('bladesman', { ...scripted('Imperial Bladesman'), cost: 3, power: 3, hp: 4, traits: ['Emperor', 'Trooper'] }),
  card('captain', { ...scripted('Captain of the Palace Guard'), cost: 5, power: 4, hp: 5, traits: ['Emperor', 'Trooper'] }),
  card('escort', { ...scripted('Imperial Escort Shuttle'), cost: 3, power: 2, hp: 4, arena: 'space', traits: ['Emperor', 'Vehicle', 'Transport'] }),
  card('wensicia', { ...scriptedBy('Wensicia Corrino', 'Schemer of the Throne'), cost: 4, power: 4, hp: 4, unique: true, traits: ['Emperor', 'Corrino', 'Official'] }),
  card('barrier', { ...scripted('Holtzman Barrier'), type: 'event', cost: 1, arena: undefined, aspects: ['Vigilance'], traits: ['Tactic'] }),
  card('ginaz', { ...scripted('Ginaz Training'), type: 'upgrade', cost: 2, power: 1, hp: 1, arena: undefined, aspects: ['Vigilance', 'Command'], traits: ['Learned'] }),
  card('dart', { ...scripted('Stunner Dart'), type: 'event', cost: 1, arena: undefined, aspects: ['Aggression'], traits: ['Trick'] }),
  card('raid', { ...scripted("Smugglers' Raid"), type: 'event', cost: 2, arena: undefined, aspects: ['Cunning'], traits: ['Trick'] }),
  card('goBetween', { ...scripted("Tuek's Go-Between"), cost: 3, power: 2, hp: 3, traits: ['Underworld'] }),
  card('trick2', { type: 'event', cost: 2, arena: undefined, traits: ['Trick'] }),
  card('jamis', { ...scripted('Jamis'), cost: 3, power: 3, hp: 4, unique: true, traits: ['Fremen'] }),
  card('knife', { type: 'upgrade', cost: 2, power: 1, hp: 0, arena: undefined, traits: ['Item', 'Weapon'] }),
  card('suit', { type: 'upgrade', cost: 1, power: 0, hp: 2, arena: undefined, traits: ['Item', 'Armor'] }),
  card('sandwalker', { ...scripted('Fremen Sandwalker'), cost: 2, power: 2, hp: 3, traits: ['Fremen', 'Trooper'] }),
  card('thopter', { ...scripted("Captured 'Thopter"), cost: 3, power: 2, hp: 4, arena: 'space', traits: ['Fremen', 'Vehicle'] }),
  card('contact', { ...scripted('Sietch Smuggler Contact'), cost: 4, power: 3, hp: 4, traits: ['Fremen', 'Underworld'] }),
  card('nightRaiders', { ...scripted('Fedaykin Night Raiders'), cost: 5, power: 4, hp: 5, traits: ['Fremen', 'Fedaykin', 'Trooper'] }),
  card('shishakli', { ...scriptedBy('Shishakli', 'Sietch Raider'), cost: 1, power: 2, hp: 2, unique: true, traits: ['Fremen', 'Trooper'] }),
  card('fremenLeader', { type: 'leader', cost: 5, traits: ['Fremen'], unit: { power: 3, hp: 6, arena: 'ground', keywords: {} } }),
  card('jihad', { ...scripted("Muad'Dib's Jihad"), type: 'event', cost: 9, arena: undefined, aspects: ['Aggression', 'Cunning', 'Heroism'], traits: ['Fremen', 'Tactic'] }),
  card('butlerian', { ...scripted('The Butlerian Jihad'), type: 'event', cost: 7, arena: undefined, aspects: ['Vigilance'], traits: ['Tactic'] }),
  card('strafing', { ...scripted('Strafing Run'), type: 'event', cost: 2, arena: undefined, aspects: ['Command'], traits: ['Tactic'] }),
  card('shotDown', { ...scripted('Shot Down'), type: 'event', cost: 2, arena: undefined, aspects: ['Vigilance'], traits: ['Tactic'] }),
  card('fighter', { cost: 2, power: 3, hp: 3, arena: 'space', traits: ['Vehicle', 'Fighter'] }),
  card('frigate', { cost: 5, power: 4, hp: 5, arena: 'space', traits: ['Vehicle', 'Capital Ship'] }),
  card('harvester', { cost: 4, power: 2, hp: 7, traits: ['Vehicle', 'Harvester'] }),
  card('rocketSquad', { ...scripted('Fremen Rocket Squad'), cost: 3, power: 3, hp: 3, aspects: ['Aggression', 'Heroism'], traits: ['Fremen', 'Trooper'] }),
  card('dustStorm', { ...scripted('Dust Storm'), type: 'event', cost: 3, arena: undefined, aspects: ['Cunning'], traits: ['Disaster'] }),
  card('noShip', { ...scripted('Ixian No-Ship'), cost: 4, power: 2, hp: 4, arena: 'space', unique: true, traits: ['Ixian', 'Vehicle', 'Transport'] }),
  card('freighter', { ...scripted('CHOAM Spice Freighter'), cost: 6, power: 3, hp: 7, arena: 'space', traits: ['Vehicle', 'Transport'] }),
  card('livery', { ...scripted('Frigate in Harkonnen Livery'), cost: 5, power: 4, hp: 5, arena: 'space', traits: ['Emperor', 'Harkonnen', 'Vehicle', 'Capital Ship'] }),
  card('atreidesFrigate', { ...scriptedBy('Atreides Frigate', 'Ducal Flagship'), cost: 6, power: 4, hp: 6, arena: 'space', unique: true, traits: ['Atreides', 'Vehicle', 'Capital Ship'] }),
  card('mercFighter', { ...scripted('Mercenary Strike Fighter'), cost: 3, power: 3, hp: 2, arena: 'space', traits: ['Underworld', 'Ginaz', 'Vehicle', 'Fighter'] }),
  card('commandeered', { ...scripted('Commandeered Harkonnen Frigate'), cost: 5, power: 4, hp: 5, arena: 'space', traits: ['Fremen', 'Vehicle', 'Capital Ship'] }),
  card('courier', { ...scripted('Weapons Courier'), cost: 1, power: 1, hp: 1, arena: 'space', traits: ['Vehicle', 'Transport'] }),
  card('surveyCraft', { ...scripted("Planetologist's Survey Craft"), cost: 3, power: 2, hp: 4, arena: 'space', traits: ['Emperor', 'Vehicle', 'Transport'] }),
  card('korba', { ...scripted('Korba'), cost: 6, power: 5, hp: 6, unique: true, traits: ['Fremen', 'Fedaykin', 'Official'] }),
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

test('Sardaukar Legion: up to 2 Spice tokens, each for 4 cost of revealed Sardaukar units played free', () => {
  let state = table({ hand0: ['legion'], deck0: ['burseg', 'executioner', 'trooper', 'bashar'] })
  state.players[0].resources = Array.from({ length: 7 }, (_, i) => ({ card: { id: `r${i}`, def: 'trooper' }, exhausted: false }))
  const token = state.players[0].spice[0]
  state.players[0].spice = [0, 1, 2, 3].map((i) => ({ ...token, id: `spice${i}` }))
  state = act(state, 0, { type: 'play', card: 'h0' })
  // One spent on its additional cost: 3 left, at most 2 of them for the units
  assert.deepEqual(state.prompt!.options.map((o) => o.label), ['0 (up to 0 cost)', '1 (up to 4 cost)', '2 (up to 8 cost)'])
  state = answer(state, '2')
  state = answer(state, 'd0')
  assert.equal(state.players[0].spice.length, 1)
  // 3 cost left: the Bashar still, not the Executioner
  assert.deepEqual(state.prompt!.options.map((o) => o.id), ['d3'])
  state = answer(state)
  assert.equal(state.prompt, null)
  assert.deepEqual(state.players[0].units.map((u) => u.def).sort(), ['burseg', 'legion'])
})

test('Sardaukar Caid: a Spice token, then may defeat a unit that costs 3 or less', () => {
  let state = table({ hand0: ['caid'], units1: ['bashar', 'executioner'] })
  state.players[0].resources = Array.from({ length: 4 }, (_, i) => ({ card: { id: `r${i}`, def: 'trooper' }, exhausted: false }))
  const spice = state.players[0].spice.length
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.equal(state.players[0].spice.length, spice - 1, 'its additional cost')
  // The Bashar (3), not the Executioner (4)
  const bashar = state.players[1].units.find((u) => u.def === 'bashar')!.id
  assert.deepEqual(state.prompt!.options.map((o) => o.id), [bashar])
  state = answer(state, bashar)
  assert.deepEqual(state.players[1].units.map((u) => u.def), ['executioner'])
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

test("Shigawire Snare: two units exhausted, one held for a Spice token: it doesn't ready at the regroup", () => {
  let state = table({ hand0: ['snare'], units1: ['big', 'guard', 'trooper'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, 'u10', 'u11')
  assert.deepEqual(state.players[1].units.map((u) => u.exhausted), [true, true, false])
  state = answer(state, 'yes')
  assert.deepEqual(state.prompt!.options.map((o) => o.id), ['u10', 'u11'], 'one of those units')
  state = answer(state, 'u10')
  assert.equal(state.players[0].spice.length, 0)
  state = act(state, 1, { type: 'pass' })
  state = act(state, 0, { type: 'pass' })
  for (const p of [state.initiative, state.initiative === 0 ? 1 : 0] as PlayerId[]) state = act(state, p, { type: 'resource', cards: [] })
  assert.equal(state.phase, 'action')
  assert.deepEqual(state.players[1].units.map((u) => u.exhausted), [true, false, false], 'held for the round, regroup included')
  // The next round, it readies again
  state = act(state, state.active, { type: 'pass' })
  state = act(state, state.active, { type: 'pass' })
  for (const p of [state.initiative, state.initiative === 0 ? 1 : 0] as PlayerId[]) state = act(state, p, { type: 'resource', cards: [] })
  assert.equal(state.players[1].units[0].exhausted, false)
})

test('Shigawire Snare: no Spice token, no question; the exhausted units ready at the regroup', () => {
  let state = table({ base0: 'caladan', hand0: ['snare'], units1: ['big'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, 'u10')
  assert.equal(state.prompt, null)
  assert.equal(state.players[1].units[0].exhausted, true)
})

test('Tanzerouft: one Weakness token, two with a Fremen unit, on the same unit or two', () => {
  let state = table({ base0: 'caladan', hand0: ['tanzerouft', 'tanzerouft'], units1: ['big', 'trooper'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, 'u10')
  assert.equal(state.prompt, null, 'no Fremen unit, one token')
  assert.equal(state.players[1].units[0].upgrades.length, 1)
  state.players[0].units = [{ id: 'u00', def: 'fremen', owner: 0, arena: 'ground', damage: 0, exhausted: false, upgrades: [] }]
  state.active = 0
  state = act(state, 0, { type: 'play', card: 'h1' })
  state = answer(state, 'u11')
  state = answer(state, 'u11')
  assert.equal(state.players[1].units.length, 1, 'the 2/2 is defeated by two Weakness tokens')
})

test('Battle of Arrakeen: 2 damage to each non-Fremen unit in the arena chosen', () => {
  let state = table({ hand0: ['arrakeen'], units0: ['fremen', 'trooper', 'big'], units1: ['big', 'trooper', 'guard'] })
  state.players[1].units[2].arena = 'space'
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, '0')
  assert.deepEqual(state.players[0].units.map((u) => [u.def, u.damage]), [['fremen', 0], ['big', 2]])
  assert.deepEqual(state.players[1].units.map((u) => [u.def, u.damage]), [['big', 2], ['guard', 0]], 'space spared')
})

test('Weapons Practice: an Experience token to each of up to 3 friendly Troopers', () => {
  let state = table({ hand0: ['practice'], units0: ['fremen', 'soldier', 'soldier', 'soldier', 'big'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.deepEqual(state.prompt!.options.map((o) => o.id), ['u00', 'u01', 'u02', 'u03'])
  assert.equal(state.prompt!.max, 3)
  state = answer(state, 'u00', 'u01', 'u02')
  assert.deepEqual(state.players[0].units.map((u) => u.upgrades.length), [1, 1, 1, 0, 0])
})

const shields = (state: GameState, p: PlayerId) => state.players[p].units.map((u) => u.upgrades.filter((x) => state.defs[x.def].name === 'Shield').length)

test('Kaitain Honor Guard: a Sentinel, shielded off Arrakis only', () => {
  for (const [base, shielded] of [['caladan', 1], ['arrakis', 0]] as const) {
    let state = table({ base0: base, hand0: ['honorGuard'] })
    state = act(state, 0, { type: 'play', card: 'h0' })
    assert.deepEqual(shields(state, 0), [shielded], base)
    assert.equal(state.defs.honorGuard.keywords.sentinel, true)
  }
})

test('Shielded: a Shield token as the unit is played', () => {
  assert.equal(readText('[Shielded]').keywords.shielded, true)
  let state = table({ hand0: ['shielded'] })
  state = settle(act(state, 0, { type: 'play', card: 'h0' }))
  assert.deepEqual(shields(state, 0), [1])
  assert.equal(keywordsOf(state, state.players[0].units[0]).sentinel, true)
})

test('Ginaz Shield Duelist: shielded off Arrakis before its Ambush attack, which it survives', () => {
  let state = table({ base0: 'caladan', hand0: ['duelist'], units1: ['big'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  while (state.prompt) state = answer(state, state.prompt.options.find((o) => o.id === 'u10' || o.id === 'yes')?.id ?? state.prompt.options[0].id)
  assert.equal(state.players[1].units[0].damage, 3)
  assert.deepEqual(shields(state, 0), [0], 'the shield took the damage')
  assert.equal(state.players[0].units[0].damage, 0)
})

test('Great House Frigate: off Arrakis, Shield tokens to up to 2 other friendly units', () => {
  let state = table({ base0: 'caladan', hand0: ['houseFrigate', 'houseFrigate'], units0: ['trooper', 'trooper', 'big'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.equal(state.prompt!.max, 2)
  assert.ok(!state.prompt!.options.some((o) => state.defs[o.def ?? '']?.name === 'Great House Frigate'), 'other units only')
  state = answer(state, 'u00', 'u02')
  assert.deepEqual(shields(state, 0), [1, 0, 1, 0])
  let arrakis = table({ hand0: ['houseFrigate'], units0: ['trooper'] })
  arrakis = act(arrakis, 0, { type: 'play', card: 'h0' })
  assert.equal(arrakis.prompt, null)
  assert.deepEqual(shields(arrakis, 0), [0, 0])
})

test('Bene Gesserit Proctor: a Shield token to one Bene Gesserit unit, to each off Arrakis', () => {
  let state = table({ hand0: ['proctor'], units0: ['sister', 'sister', 'trooper'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.equal(state.prompt!.options.length, 3, 'the sisters and the Proctor')
  state = answer(state, 'u01')
  assert.deepEqual(shields(state, 0), [0, 1, 0, 0])
  let off = table({ base0: 'caladan', hand0: ['proctor'], units0: ['sister', 'sister', 'trooper'] })
  off = act(off, 0, { type: 'play', card: 'h0' })
  assert.deepEqual(shields(off, 0), [1, 1, 0, 1])
})

test('Harkonnen Spice Hoarder: a Spice token when played and on attack, off Arrakis only', () => {
  let state = table({ base0: 'caladan', hand0: ['hoarder'], units0: ['hoarder'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.equal(state.players[0].spice.length, 1)
  state.active = 0
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'base' })
  assert.equal(state.players[0].spice.length, 2)
  let arrakis = table({ hand0: ['hoarder'] })
  arrakis = act(arrakis, 0, { type: 'play', card: 'h0' })
  assert.equal(arrakis.players[0].spice.length, 1, 'only the base starting one')
})

test('Ginaz Shield Duelist: its Ambush may resolve first, the Shield token after, onto the damaged unit', () => {
  let state = table({ base0: 'caladan', hand0: ['duelist'], units1: ['guard'] })
  state.players[1].units[0].damage = 1
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.equal(state.prompt!.text, 'Choose the ability to resolve first')
  const ambush = state.prompt!.options.find((o) => /Ambush/.test(o.label ?? ''))!
  state = answer(state, ambush.id)
  state = answer(state, 'u10')
  assert.equal(state.players[1].units.length, 0, 'the 1/3 is defeated')
  assert.equal(state.players[0].units[0].damage, 1)
  assert.deepEqual(shields(state, 0), [1], 'shielded after the fight: a 3/1 with a Shield token')
  // The AI sees it too
  let ai = table({ base0: 'caladan', hand0: ['duelist'], units1: ['guard'] })
  ai.players[1].units[0].damage = 1
  ai = act(ai, 0, { type: 'play', card: 'h0' })
  const first = chooseAction(ai, 0)!
  assert.equal(first.type === 'answer' && ai.prompt!.options.find((o) => o.id === first.picks[0])!.label?.includes('Ambush'), true)
})

test('Baron Vladimir Harkonnen, Siridar-Baron: another Harkonnen unit attacks a unit, exhausted, +2/+0 and Overwhelm', () => {
  let state = table({ hand0: ['siridar'], units0: ['harkonnen', 'trooper'], units1: ['trooper'] })
  state.players[0].units[0].exhausted = true
  for (let i = 0; i < 2; i++) state.players[0].resources.push({ card: { id: `rx${i}`, def: 'trooper' }, exhausted: false })
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.deepEqual(state.prompt!.options.map((o) => o.id), ['u00'], 'Harkonnen units only, exhausted ones too, not himself')
  state = answer(state, 'u00')
  assert.deepEqual(state.prompt!.options.map((o) => o.id), ['u10'], "it can't attack the base")
  state = answer(state, 'u10')
  assert.equal(state.players[1].units.length, 0)
  assert.equal(state.players[1].base.damage, 2, '4 power into a 2/2: 2 more to the base')
  assert.equal(state.defs.siridar.keywords.overwhelm, true)
})

test('Baron Vladimir Harkonnen, Siridar-Baron: a Spice token uses the When Played again, once each round', () => {
  let state = table({ units0: ['siridar', 'harkonnen'], units1: ['big', 'big'] })
  state.players[0].units[1].exhausted = true
  state.players[0].spice.push({ ...state.players[0].spice[0], id: 'sp2' })
  const baron = (s: GameState) => legalActions(s, 0).some((a) => a.type === 'ability' && a.source === 'u00')
  assert.ok(baron(state))
  state = act(state, 0, { type: 'ability', source: 'u00', index: 0 })
  state = answer(state, 'u01')
  state = answer(state, 'u10')
  assert.equal(state.players[1].units[0].damage, 4)
  assert.equal(state.players[1].base.damage, 0, 'no Overwhelm damage left over')
  assert.equal(state.players[0].spice.length, 1)
  state.active = 0
  assert.ok(!baron(state), 'once each round, a Spice token left or not')
})

test('Stilgar, Desert Commander: a friendly Fremen unit defeated, himself included, heals 2 damage from a unit or base', () => {
  let state = table({ units0: ['stilgarUnit', 'fremen', 'trooper'], units1: ['crusher'] })
  state.players[0].units[0].damage = 3
  state = act(state, 0, { type: 'attack', attacker: 'u02', target: 'u10' })
  assert.equal(state.prompt, null, 'not for a unit that is not Fremen')
  state.active = 0
  state = act(state, 0, { type: 'attack', attacker: 'u01', target: 'u10' })
  assert.match(state.prompt!.text, /Stilgar/)
  state = answer(state, 'u00')
  assert.equal(state.players[0].units[0].damage, 1)
  state.players[0].base.damage = 5
  state.players[1].units[0].damage = 0
  state.active = 0
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  assert.equal(state.players[0].units.length, 0, 'Stilgar is defeated')
  state = answer(state, 'base0')
  assert.equal(state.players[0].base.damage, 3)
  assert.equal(state.prompt, null, 'he heals once as he is defeated')
  assert.equal(state.defs.stilgarUnit.keywords.sentinel, true)
})

test('Stilgar, Desert Commander: a Fremen token when played, on Arrakis only', () => {
  for (const [base, made] of [['arrakis', 1], ['caladan', 0]] as const) {
    let state = table({ base0: base, hand0: ['stilgarUnit'] })
    state = act(state, 0, { type: 'play', card: 'h0' })
    assert.equal(state.players[0].units.length, 1 + made, base)
  }
})

test("Paul Atreides, Muad'Dib: on Arrakis each friendly Fremen unit gets +1/+0 and Ambush, him and his 2 tokens included", () => {
  for (const base of ['arrakis', 'caladan']) {
    let state = table({ base0: base, hand0: ['muaddib'], units0: ['fremen'], units1: ['big', 'big', 'big'] })
    for (let i = 0; i < 3; i++) state.players[0].resources.push({ card: { id: `rx${i}`, def: 'trooper' }, exhausted: false })
    assert.equal(powerOf(state, state.players[0].units[0]), 2, 'not in play yet')
    state = act(state, 0, { type: 'play', card: 'h0' })
    const asked: string[] = []
    while (state.prompt) {
      asked.push(state.prompt.text)
      const first = state.prompt.options.find((o) => /When Played/.test(o.label ?? '')) ?? state.prompt.options.find((o) => o.id !== 'none') ?? state.prompt.options[0]
      state = answer(state, first.id)
    }
    const ambushes = asked.filter((t) => /Ambush, choose/.test(t)).length
    const mine = state.players[0].units
    if (base === 'arrakis') {
      assert.equal(ambushes, 3, `Muad'Dib and both tokens: ${asked.join(' / ')}`)
      assert.equal(powerOf(state, mine.find((u) => u.def === 'fremen')!), 3)
    } else {
      assert.equal(ambushes, 0)
      assert.equal(mine.length, 4, 'him, the Fremen and 2 tokens')
      assert.equal(powerOf(state, mine.find((u) => u.def === 'muaddib')!), 8)
    }
  }
})

// Answers every question, a When Played ability first, then what isn't "none"
function settle(state: GameState, first = /When Played|ready this unit/) {
  while (state.prompt) {
    const o = state.prompt.options
    state = answer(state, (o.find((x) => first.test(x.label ?? '')) ?? o.find((x) => x.id !== 'none') ?? o[0]).id)
  }
  return state
}

test("The Sleeper Has Awakened: the Heir defeated, Muad'Dib played from the discard pile for free this phase, ready", () => {
  let state = table({ base0: 'caladan', hand0: ['sleeper'], units0: ['heir', 'fremen'] })
  state.players[0].discard = [{ id: 'x0', def: 'muaddib' }]
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.deepEqual(state.prompt?.options.map((o) => o.id), ['u00', 'u01'])
  state = answer(state, 'u00')
  assert.deepEqual(state.players[0].discard.map((c) => c.def).sort(), ['heir', 'muaddib', 'sleeper'])
  // Another action later this phase: the Fremen can't come back, either Paul can, for free
  state = act(state, 1, { type: 'pass' })
  const wake = legalActions(state, 0).filter((a) => a.type === 'play' && a.awakened)
  assert.deepEqual(wake.map((a) => a.type === 'play' && a.card).sort(), ['u00', 'x0'])
  const spent = state.players[0].resources.filter((r) => r.exhausted).length
  state = settle(act(state, 0, { type: 'play', card: 'x0', discard: true, awakened: true }))
  const paul = state.players[0].units.find((u) => u.def === 'muaddib')!
  assert.equal(paul.exhausted, false)
  assert.equal(state.players[0].units.length, 4, "Muad'Dib, the Fremen and 2 tokens")
  assert.equal(state.players[0].resources.filter((r) => r.exhausted).length, spent, 'for free')
  // Once only
  state = act(state, 1, { type: 'pass' })
  assert.ok(!legalActions(state, 0).some((a) => a.type === 'play' && a.awakened))
})

test('The Sleeper Has Awakened: on Arrakis, Ambush first, then ready to attack again; it lasts this phase only', () => {
  let state = table({ hand0: ['sleeper'], units0: ['muaddib'], units1: ['trooper'] })
  state = answer(act(state, 0, { type: 'play', card: 'h0' }), 'u00')
  state = act(state, 1, { type: 'pass' })
  state = settle(act(state, 0, { type: 'play', card: 'u00', discard: true, awakened: true }), /Ambush|u10/)
  const paul = state.players[0].units.find((u) => u.def === 'muaddib')!
  assert.equal(state.players[1].units.length, 0, 'the Ambush defeated the trooper')
  assert.equal(paul.exhausted, false, 'readied after it')
  let other = table({ hand0: ['sleeper'], units0: ['fremen'] })
  other = answer(act(other, 0, { type: 'play', card: 'h0' }), 'u00')
  assert.equal(other.awakened?.length, 1)
  other = act(act(other, 1, { type: 'pass' }), 0, { type: 'pass' })
  assert.equal(other.phase, 'regroup')
  assert.deepEqual(other.awakened, [])
})

test('Jamis: a Weapon upgrade from the discard pile for free, attached to him', () => {
  let state = table({ base0: 'caladan', hand0: ['jamis', 'suit'], units0: ['fremen'] })
  state.players[0].discard = [{ id: 'x0', def: 'knife' }]
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.deepEqual(state.prompt?.options.filter((o) => o.id !== 'none').map((o) => o.id), ['x0'], 'a Weapon, not the Armor in hand')
  state = settle(answer(state, 'x0'))
  const jamis = state.players[0].units.find((u) => u.def === 'jamis')!
  assert.deepEqual(jamis.upgrades.map((u) => u.def), ['knife'])
  assert.equal(state.players[0].resources.filter((r) => r.exhausted).length, 3, 'only Jamis paid for')
})

test("Jamis: defeated, his upgrades go on to other friendly Fremen units for free", () => {
  let state = table({ base0: 'caladan', units0: ['jamis', 'fremen', 'trooper'], units1: ['crusher'] })
  state.players[0].units[0].upgrades = [
    { id: 'k0', def: 'knife', owner: 0 },
    { id: 's0', def: 'suit', owner: 0 },
  ]
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  assert.ok(!state.players[0].units.some((u) => u.def === 'jamis'))
  assert.deepEqual(state.prompt?.options.filter((o) => o.id !== 'none').map((o) => o.id).sort(), ['k0', 's0'])
  state = answer(state, 'k0')
  assert.deepEqual(state.prompt?.options.map((o) => o.id), ['u01'], 'a Fremen unit only')
  state = answer(state, 'u01')
  state = answer(answer(state, 's0'), 'u01')
  assert.deepEqual(state.players[0].units.find((u) => u.id === 'u01')!.upgrades.map((u) => u.def), ['knife', 'suit'])
  assert.equal(state.players[0].resources.filter((r) => r.exhausted).length, 0, 'for free')
  assert.equal(state.prompt, null)
})

test('Harah: an Experience token to another Fremen unit once a friendly Fremen unit was defeated this phase', () => {
  // One of these attacks into the crusher and is defeated, then Harah is played
  const play = (dies: string) => {
    let state = table({ base0: 'caladan', hand0: ['harah'], units0: [dies, 'fremen'], units1: ['crusher'] })
    state = settle(act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' }))
    assert.ok(!state.players[0].units.some((u) => u.id === 'u00'))
    state = act(state, 1, { type: 'pass' })
    return settle(act(state, 0, { type: 'play', card: 'h0' }))
  }
  const upgradesOf = (state: GameState, def: string) => state.players[0].units.find((u) => u.def === def)!.upgrades.map((u) => state.defs[u.def].name)
  assert.deepEqual(upgradesOf(play('fremen'), 'fremen'), ['Experience'])
  assert.deepEqual(upgradesOf(play('fremen'), 'harah'), [], 'another unit')
  assert.deepEqual(upgradesOf(play('trooper'), 'fremen'), [], 'a Fremen unit has to have been defeated')
})

test('Ramallo: heals 2, and 3 more for a Spice token', () => {
  let state = table({ hand0: ['ramallo'] })
  state.players[0].base.damage = 6
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, 'base0')
  assert.equal(state.players[0].base.damage, 4)
  state = answer(state, 'yes')
  assert.equal(state.players[0].base.damage, 1)
  assert.equal(state.players[0].spice.length, 0)
})

test('Ramallo: defeated, she is attached to a Fremen or Bene Gesserit unit, +2/+2 and Restore 2, until it leaves play', () => {
  let state = table({ base0: 'caladan', units0: ['ramallo', 'fremen', 'trooper'], units1: ['crusher'] })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
  assert.deepEqual(state.prompt?.options.map((o) => o.id), ['u01'], 'not the trooper')
  state = answer(state, 'u01')
  const fremen = state.players[0].units.find((u) => u.id === 'u01')!
  assert.deepEqual(fremen.upgrades.map((u) => u.def), ['ramallo'])
  assert.ok(!state.players[0].discard.some((c) => c.def === 'ramallo'))
  assert.equal(powerOf(state, fremen), 4)
  assert.equal(hpOf(state, fremen), 5)
  assert.equal(keywordsOf(state, fremen).restore, 2)
  // The unit defeated, she goes to the discard pile as any upgrade does
  state = act(state, 1, { type: 'pass' })
  state = settle(act(state, 0, { type: 'attack', attacker: 'u01', target: 'u10' }))
  assert.ok(state.players[0].discard.some((c) => c.def === 'ramallo'))
})

test('Iakin Nefud: other Harkonnen Troopers get +1/+0; a Spice token readies him', () => {
  let state = table({ hand0: ['nefud'], units0: ['harkonnen', 'trooper'], units1: ['trooper'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, 'yes')
  const mine = state.players[0].units
  assert.equal(powerOf(state, mine.find((u) => u.def === 'harkonnen')!), 3)
  assert.equal(powerOf(state, mine.find((u) => u.def === 'trooper')!), 2, 'not a Harkonnen')
  const nefud = mine.find((u) => u.def === 'nefud')!
  assert.equal(powerOf(state, nefud), 3, 'other units only')
  assert.equal(nefud.exhausted, false)
  assert.equal(state.players[0].spice.length, 0)
})

test('Otheym: a ready Fremen token with another unique Fremen unit only', () => {
  for (const [others, made] of [[['fremen'], 0], [['chaniUnit'], 1]] as const) {
    let state = table({ base0: 'caladan', hand0: ['otheym'], units0: [...others] })
    state = settle(act(state, 0, { type: 'play', card: 'h0' }))
    const tokens = state.players[0].units.filter((u) => !['otheym', ...others].includes(u.def))
    assert.equal(tokens.length, made)
    if (made) assert.equal(tokens[0].exhausted, false)
  }
})

test('Pardot Kynes: a Spice token; 3 damage healed from the base at the regroup phase with 3 Spice tokens', () => {
  for (const [extra, healed] of [[1, 3], [0, 0]] as const) {
    let state = table({ hand0: ['pardot'] })
    state.players[0].base.damage = 5
    state = settle(act(state, 0, { type: 'play', card: 'h0' }))
    assert.equal(state.players[0].spice.length, 2)
    for (let i = 0; i < extra; i++) state.players[0].spice.push({ id: `sx${i}`, def: state.players[0].spice[0].def })
    state = settle(act(act(state, 1, { type: 'pass' }), 0, { type: 'pass' }))
    assert.equal(state.players[0].base.damage, 5 - healed)
  }
})

test('Captain Aramsham: enemy units lose Hidden and Ambush; an Experience token to each other Sardaukar', () => {
  let state = table({ hand0: ['aramsham'], units0: ['bashar', 'spy'], units1: ['spy', 'ambusher'] })
  state = settle(act(state, 0, { type: 'play', card: 'h0' }))
  assert.equal(state.players[0].spice.length, 0, 'his additional cost')
  const [enemySpy, ambusher] = state.players[1].units
  assert.equal(keywordsOf(state, enemySpy).hidden, undefined)
  assert.equal(keywordsOf(state, ambusher).ambush, undefined)
  assert.equal(keywordsOf(state, state.players[0].units.find((u) => u.def === 'spy')!).hidden, true, 'his own keep theirs')
  const bashar = state.players[0].units.find((u) => u.def === 'bashar')!
  assert.deepEqual(bashar.upgrades.map((u) => state.defs[u.def].name), ['Experience'])
  assert.equal(state.players[0].units.find((u) => u.def === 'aramsham')!.upgrades.length, 0)
})

test('Stunner Dart: exhaust a unit, from the hand or using Smuggle', () => {
  let state = table({ hand0: ['dart'], units1: ['big'] })
  state = settle(act(state, 0, { type: 'play', card: 'h0' }))
  assert.equal(state.players[1].units[0].exhausted, true)
  state = table({ units1: ['big'] })
  state.players[0].resources[0].card = { id: 'rd', def: 'dart' }
  assert.ok(legalActions(state, 0).some((a) => a.type === 'play' && a.card === 'rd' && a.smuggle))
  state = settle(act(state, 0, { type: 'play', card: 'rd', smuggle: true }))
  assert.equal(state.players[1].units[0].exhausted, true)
})

test("Smugglers' Raid: an attack with +2/+0, and a Spice token when played using Smuggle", () => {
  let state = table({ hand0: ['raid'], units0: ['trooper'] })
  const spice = state.players[0].spice.length
  state = settle(act(state, 0, { type: 'play', card: 'h0' }))
  assert.equal(state.players[1].base.damage, 4, 'the Trooper attacks the base with 2 + 2')
  assert.equal(state.players[0].spice.length, spice, 'no Spice from the hand')
  // Smuggle 3, Cunning off-aspect: 3 + 2
  state = table({ units0: ['trooper'] })
  state.players[0].resources[0].card = { id: 'rr', def: 'raid' }
  state = settle(act(state, 0, { type: 'play', card: 'rr', smuggle: true }))
  assert.equal(state.players[1].base.damage, 4)
  assert.equal(state.players[0].spice.length, spice + 1, 'a Spice token for the Smuggle')
})

test('Shishakli: ready again when you play a Trick event, after it resolves', () => {
  let state = table({ hand0: ['raid', 'dart'], units0: ['shishakli'] })
  state = settle(act(state, 0, { type: 'play', card: 'h0' }))
  assert.equal(state.players[1].base.damage, 4, 'he attacks the base with 2 + 2')
  assert.equal(state.players[0].units[0].exhausted, false, 'and is ready again')
  // Each Trick, not once each round
  state.players[0].units[0].exhausted = true
  for (const r of state.players[0].resources) r.exhausted = false
  state.active = 0
  state = settle(act(state, 0, { type: 'play', card: 'h1' }))
  assert.equal(state.players[0].units[0].exhausted, false, 'Stunner Dart is a Trick too')
})

test("Muad'Dib's Jihad: every unit and Spice token defeated, a Fremen token for each Fremen card on Arrakis", () => {
  let state = rich(table({ hand0: ['jihad'], units0: ['shishakli', 'sandwalker', 'trooper'], units1: ['big', 'thopter'] }), 16)
  state.players[0].units.push({ id: 'L0', def: 'leader', owner: 0, arena: 'ground', damage: 0, exhausted: false, leader: true, upgrades: [] })
  state.players[0].leader.deployed = true
  state.players[0].units.push({ id: 'tok', def: 'token-fremen', owner: 0, arena: 'ground', damage: 0, exhausted: false, upgrades: [] })
  state.players[1].spice.push({ id: 'x1', def: 'token-spice' })
  state = settle(act(state, 0, { type: 'play', card: 'h0' }))
  assert.equal(state.players[1].units.length, 0)
  assert.equal(state.players[0].leader.deployed, false, 'the leader back to its leader side')
  assert.equal(state.players[0].spice.length + state.players[1].spice.length, 0)
  // Shishakli and the Sandwalker: not the token or the Trooper
  assert.deepEqual(state.players[0].units.map((u) => state.defs[u.def].name), ['Fremen', 'Fremen'])
  // A Fremen leader unit counts too
  state = rich(table({ hand0: ['jihad'] }), 16)
  state.players[0].units.push({ id: 'L0', def: 'fremenLeader', owner: 0, arena: 'ground', damage: 0, exhausted: false, leader: true, upgrades: [] })
  state.players[0].leader = { ...state.players[0].leader, def: 'fremenLeader', deployed: true }
  state = settle(act(state, 0, { type: 'play', card: 'h0' }))
  assert.equal(state.players[0].units.length, 1)
  // Off Arrakis, no tokens
  state = rich(table({ base0: 'caladan', hand0: ['jihad'], units0: ['shishakli'] }), 16)
  state = settle(act(state, 0, { type: 'play', card: 'h0' }))
  assert.equal(state.players[0].units.length, 0)
})

test('The Butlerian Jihad defeats each Vehicle unit, in both arenas', () => {
  let state = rich(table({ hand0: ['butlerian'], units0: ['thopter', 'sandwalker'], units1: ['carrier', 'big'] }))
  state = settle(act(state, 0, { type: 'play', card: 'h0' }))
  assert.deepEqual(state.players[0].units.map((u) => u.def), ['sandwalker'])
  assert.deepEqual(state.players[1].units.map((u) => u.def), ['big'])
})

test("Tuek's Go-Between: a Trick event from the discard pile, for 2 less", () => {
  let state = table({ hand0: ['goBetween'], units1: ['big'] })
  state.players[0].discard = [
    { id: 'x0', def: 'dart' },
    { id: 'x1', def: 'trick2' },
    { id: 'x2', def: 'levy' },
  ]
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.deepEqual(state.prompt?.options.filter((o) => o.id !== 'none').map((o) => o.id), ['x0', 'x1'], 'Tricks only')
  state = settle(answer(state, 'x1'))
  assert.equal(state.players[0].resources.filter((r) => r.exhausted).length, 3, 'the 2-cost Trick for free')
  assert.ok(state.players[0].discard.some((c) => c.id === 'x1'), 'back to the discard pile')
  state = table({ hand0: ['goBetween'], units1: ['big'] })
  state.players[0].discard = [{ id: 'x0', def: 'dart' }]
  state = settle(answer(act(state, 0, { type: 'play', card: 'h0' }), 'x0'))
  assert.equal(state.players[1].units[0].exhausted, true)
})


// Enough ready resources to play anything off-aspect
const rich = (state: GameState, count = 12) => {
  state.players[0].resources = Array.from({ length: count }, (_, i) => ({ card: { id: `rr${i}`, def: 'trooper' }, exhausted: false }))
  return state
}

test('Fremen Sandwalker: on attack, may exhaust an enemy ground unit that costs 3 or less', () => {
  let state = table({ units0: ['sandwalker'], units1: ['trooper', 'big'] })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'base' })
  assert.deepEqual(state.prompt?.options.filter((o) => o.id !== 'none').map((o) => o.id), ['u10'], 'not the 5-cost unit')
  state = answer(state, 'u10')
  assert.equal(state.players[1].units[0].exhausted, true)
  assert.equal(state.players[1].base.damage, 2)
})

test("Captured 'Thopter: on attack, 1 damage to a ground unit", () => {
  let state = table({ units0: ['thopter'], units1: ['trooper'] })
  state.players[0].units[0].arena = 'space'
  state = settle(act(state, 0, { type: 'attack', attacker: 'u00', target: 'base' }))
  assert.equal(state.players[1].units[0].damage, 1)
  assert.equal(state.players[1].base.damage, 2)
})

test('Sietch Smuggler Contact: Spice for another Underworld unit, a Fremen token for another Fremen unit', () => {
  let state = rich(table({ hand0: ['contact'] }))
  const spice = state.players[0].spice.length
  state = settle(act(state, 0, { type: 'play', card: 'h0' }))
  assert.equal(state.players[0].spice.length, spice, 'alone, nothing: it does not count itself')
  assert.equal(state.players[0].units.length, 1)
  state = rich(table({ hand0: ['contact'], units0: ['goBetween', 'fremen'] }))
  state = settle(act(state, 0, { type: 'play', card: 'h0' }))
  assert.equal(state.players[0].spice.length, spice + 1)
  assert.equal(state.players[0].units.filter((u) => state.defs[u.def].token).length, 1, 'a Fremen token')
})

test('Fedaykin Night Raiders: with another Fremen unit, return an enemy unit that costs 3 or less to hand', () => {
  let state = rich(table({ hand0: ['nightRaiders'], units1: ['trooper'] }))
  state = settle(act(state, 0, { type: 'play', card: 'h0' }))
  assert.equal(state.players[1].units.length, 1, 'no other Fremen unit, nothing returned')
  state = rich(table({ hand0: ['nightRaiders'], units0: ['fremen'], units1: ['trooper', 'big'] }))
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.deepEqual(state.prompt?.options.map((o) => o.id), ['u10'])
  state = answer(state, 'u10')
  assert.deepEqual(state.players[1].units.map((u) => u.id), ['u11'])
  assert.ok(state.players[1].hand.some((c) => c.def === 'trooper'))
})

test('Korba: each friendly Fremen token gets an Experience token when he is played and when he attacks', () => {
  let state = rich(table({ hand0: ['korba'], units0: ['token-fremen', 'fremen'], units1: [] }))
  state = settle(act(state, 0, { type: 'play', card: 'h0' }))
  const upgrades = (id: string) => state.players[0].units.find((u) => u.id === id)!.upgrades.length
  assert.equal(upgrades('u00'), 1, 'the token')
  assert.equal(upgrades('u01'), 0, 'not a Fremen unit that is not a token')
  const korba = state.players[0].units.find((u) => u.def === 'korba')!
  korba.exhausted = false
  state.active = 0
  state = settle(act(state, 0, { type: 'attack', attacker: korba.id, target: 'base' }))
  assert.equal(upgrades('u00'), 2)
})

test('Strafing Run: a Vehicle attacks and deals its power as damage to an enemy ground unit', () => {
  let state = table({ hand0: ['strafing'], units0: ['trooper', 'fighter'], units1: ['big'] })
  state.players[0].units[1].arena = 'space'
  // Only the Vehicle may attack: no choice to make
  state = settle(act(state, 0, { type: 'play', card: 'h0' }))
  assert.equal(state.players[1].units[0].damage, 3, "the 'thopter's 3 power to the ground unit")
  assert.equal(state.players[1].base.damage, 3, 'and its attack on the base')
  assert.equal(state.players[0].units[1].exhausted, true)
  assert.equal(state.players[0].units[0].exhausted, false, 'the Trooper stays ready')
})

test('Strafing Run: no Vehicle, no attack', () => {
  let state = table({ hand0: ['strafing'], units0: ['trooper'], units1: ['big'] })
  state = settle(act(state, 0, { type: 'play', card: 'h0' }))
  assert.equal(state.players[1].base.damage, 0)
  assert.equal(state.players[1].units[0].damage, 0)
})

test('Shot Down: defeats a space unit that is not a Capital Ship, never a ground Vehicle', () => {
  let state = table({ hand0: ['shotDown'], units1: ['frigate', 'trooper', 'fighter'] })
  state.players[1].units[0].arena = 'space'
  state.players[1].units[2].arena = 'space'
  state = settle(act(state, 0, { type: 'play', card: 'h0' }))
  assert.deepEqual(state.players[1].units.map((u) => u.def), ['frigate', 'trooper'], 'only the fighter could be picked')
  state = table({ hand0: ['shotDown'], units1: ['harvester'] })
  state = settle(act(state, 0, { type: 'play', card: 'h0' }))
  assert.equal(state.players[1].units.length, 1, 'a ground Vehicle is safe')
})

test('Fremen Rocket Squad: 2 damage to a space unit when it attacks, Hidden on Arrakis', () => {
  let state = table({ units0: ['rocketSquad'], units1: ['fighter'] })
  state.players[1].units[0].arena = 'space'
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'base' })
  assert.equal(state.prompt?.player, 0, 'it may deal the damage')
  state = answer(state, 'u10')
  assert.equal(state.players[1].units[0].damage, 2)
  assert.equal(state.players[1].base.damage, 3)
  assert.equal(keywordsOf(state, state.players[0].units[0]).hidden, true, 'Hidden on an Arrakis base')
})

test('Dust Storm: a Weakness token to each space unit, and a second to enemy ones on Arrakis', () => {
  // units0: a fighter (3/3); units1: a fighter, a frigate (4/5) and a ground trooper
  let state = table({ hand0: ['dustStorm'], units0: ['fighter'], units1: ['fighter', 'frigate', 'big'] })
  for (const u of [state.players[0].units[0], state.players[1].units[0], state.players[1].units[1]]) u.arena = 'space'
  state = settle(act(state, 0, { type: 'play', card: 'h0' }))
  const [mine] = state.players[0].units
  assert.equal(powerOf(state, mine), 2, 'yours: one token')
  assert.equal(hpOf(state, mine), 2)
  const [fighter, frigate, big] = state.players[1].units
  assert.equal(powerOf(state, fighter), 1, 'theirs: two tokens')
  assert.equal(powerOf(state, frigate), 2, 'Capital Ships too')
  assert.equal(powerOf(state, big), 5, 'not the ground')
  // Off Arrakis: one token each
  state = table({ base0: 'caladan', hand0: ['dustStorm'], units1: ['fighter'] })
  state.players[1].units[0].arena = 'space'
  state = settle(act(state, 0, { type: 'play', card: 'h0' }))
  assert.equal(powerOf(state, state.players[1].units[0]), 2)
})

test('Ixian No-Ship: plays a ground unit costing 3 or less from the hand, paid for, with Ambush', () => {
  let state = table({ hand0: ['noShip', 'trooper', 'big'], units1: ['guard'] })
  const ready = () => state.players[0].resources.filter((r) => !r.exhausted).length
  const before = ready()
  state = act(state, 0, { type: 'play', card: 'h0' })
  // Only the Trooper may land: the 5-cost unit is too big
  assert.deepEqual(state.prompt?.options.map((o) => o.id).filter((id) => id !== 'none'), ['h1'])
  state = settle(state)
  const trooper = state.players[0].units.find((u) => u.def === 'trooper')!
  assert.ok(trooper, 'the Trooper is in play')
  assert.equal(before - ready(), 4 + 1, 'the No-Ship and the Trooper both paid for')
  assert.equal(trooper.exhausted, true, 'it attacked with Ambush')
  assert.equal(state.players[1].units[0].damage, 2)
})

test('CHOAM Spice Freighter: 2 Spice tokens for its controller when it is defeated', () => {
  let state = table({ hand0: ['shotDown'], units1: ['freighter'] })
  state.players[1].units[0].arena = 'space'
  const spice = state.players[1].spice.length
  state = settle(act(state, 0, { type: 'play', card: 'h0' }))
  assert.equal(state.players[1].units.length, 0)
  assert.equal(state.players[1].spice.length, spice + 2, 'its owner gets the cargo')
})

test('Frigate in Harkonnen Livery: readies a friendly ground Trooper unit with +2/+0 for this phase', () => {
  let state = table({ hand0: ['livery'], units0: ['soldier', 'big'] })
  state.players[0].units[0].exhausted = true
  state = settle(act(state, 0, { type: 'play', card: 'h0' }))
  const soldier = state.players[0].units[0]
  assert.equal(soldier.exhausted, false, 'the Trooper is ready again')
  assert.equal(powerOf(state, soldier), 4, '2 + 2')
  assert.equal(powerOf(state, state.players[0].units[1]), 5, 'not a Trooper: no change')
})

test('Atreides Frigate: an Experience token to each of up to 3 friendly ground units', () => {
  let state = table({ hand0: ['atreidesFrigate'], units0: ['trooper', 'trooper', 'trooper', 'trooper', 'fighter'] })
  state.players[0].units[4].arena = 'space'
  state = act(state, 0, { type: 'play', card: 'h0' })
  const ids = state.players[0].units.slice(0, 3).map((u) => u.id)
  state = answer(state, ...ids)
  state = settle(state)
  const tokens = state.players[0].units.map((u) => u.upgrades.length)
  assert.deepEqual(tokens.slice(0, 5), [1, 1, 1, 0, 0], 'three ground units, not the fighter')
})

test('Mercenary Strike Fighter: a Spice token for 2 damage to a unit, in either arena', () => {
  let state = table({ hand0: ['mercFighter'], units1: ['fighter'] })
  state.players[1].units[0].arena = 'space'
  const spice = state.players[0].spice.length
  assert.ok(spice > 0, 'the Arrakis base gives a Spice token')
  state = act(state, 0, { type: 'play', card: 'h0' })
  const yes = state.prompt!.options.find((o) => /Defeat a Spice token/.test(o.label ?? ''))!
  state = answer(state, yes.id)
  state = settle(answer(state, 'u10'))
  assert.equal(state.players[0].spice.length, spice - 1)
  assert.equal(state.players[1].units[0].damage, 2, 'a space unit too')
  // No Spice token: no question, no damage
  state = table({ base0: 'caladan', hand0: ['mercFighter'], units1: ['big'] })
  state = settle(act(state, 0, { type: 'play', card: 'h0' }))
  assert.equal(state.players[1].units[0].damage, 0)
})

test('Commandeered Harkonnen Frigate: 1 damage to an enemy ground unit for each friendly Fremen ground unit', () => {
  let state = table({ hand0: ['commandeered'], units0: ['fremen', 'fremen', 'trooper', 'thopter'], units1: ['big', 'trooper'] })
  state.players[0].units[3].arena = 'space'
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, 'u10')
  state = answer(state, 'u10')
  state = settle(state)
  assert.equal(state.players[1].units[0].damage, 2, "two Fremen on the ground: not the Trooper, not the Fremen 'thopter")
  assert.equal(state.players[1].units[1].damage, 0)
})

test("Planetologist's Survey Craft: heals 2 from a friendly ground unit or your base when it attacks", () => {
  let state = table({ units0: ['surveyCraft', 'big'] })
  state.players[0].units[0].arena = 'space'
  state.players[0].units[1].damage = 3
  state.players[0].base.damage = 5
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'base' })
  state = settle(answer(state, 'u01'))
  assert.equal(state.players[0].units[1].damage, 1)
  assert.equal(state.players[0].base.damage, 5)
  assert.equal(state.players[1].base.damage, 2)
})

test('Weapons Courier: an Experience token to a friendly ground unit, not a space unit', () => {
  let state = table({ hand0: ['courier'], units0: ['trooper', 'fighter'] })
  state.players[0].units[1].arena = 'space'
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = settle(answer(state, 'u00'))
  assert.deepEqual(state.players[0].units.slice(0, 2).map((u) => u.upgrades.length), [1, 0])
  // No friendly ground unit: nothing to give it to
  state = settle(act(table({ hand0: ['courier'] }), 0, { type: 'play', card: 'h0' }))
  assert.equal(state.prompt, null)
  assert.equal(state.players[0].units.length, 1, 'only the Courier')
})

// --- Irulan's Emperor units and shield cards ---
const shieldOf = (owner: PlayerId, id = 'sh') => ({ id, def: 'token-shield', owner })
const unitOf = (state: GameState, def: string) => [...state.players[0].units, ...state.players[1].units].find((u) => u.def === def)!
const pickBy = (state: GameState, label: RegExp) => state.prompt!.options.find((o) => label.test(o.label ?? ''))!.id

test('Holtzman Barrier: one Shield token on Arrakis, two on different units off it; Kaitain Cadet gets +2/+0 while shielded', () => {
  let state = table({ hand0: ['barrier'], units0: ['cadet', 'emperorGuard'] })
  state = settle(act(state, 0, { type: 'play', card: 'h0' }))
  assert.equal(shields(state, 0).reduce((a, b) => a + b), 1, 'on Arrakis')
  state = table({ base0: 'caladan', hand0: ['barrier'], units0: ['cadet', 'emperorGuard'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, 'u00')
  assert.ok(!state.prompt!.options.some((o) => o.id === 'u00'), 'another unit')
  state = answer(state, 'u01')
  assert.deepEqual(shields(state, 0), [1, 1])
  assert.equal(powerOf(state, unitOf(state, 'cadet')), 3)
})

test('Kaitain Shield Bearer: a Shield token to a friendly Emperor unit, itself included', () => {
  let state = table({ hand0: ['bearer'], units0: ['emperorGuard', 'trooper'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.deepEqual(state.prompt!.options.map((o) => o.id).sort(), ['h0', 'u00'])
  state = answer(state, 'h0')
  assert.equal(unitOf(state, 'bearer').upgrades.length, 1)
})

test('Imperial Bladesman: 2 damage to an enemy ground unit when a Shield token on it is defeated', () => {
  let state = table({ units0: ['bladesman'], units1: ['big'] })
  state.players[0].units[0].upgrades = [shieldOf(0)]
  state = settle(act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' }))
  assert.equal(unitOf(state, 'bladesman').damage, 0, 'the Shield took the damage back')
  assert.equal(state.players[1].units.length, 0, 'the big one: 3 combat damage, then 2')
})

test('Captain of the Palace Guard: Shielded, then up to 2 Shield tokens spent for 2 damage each', () => {
  let state = table({ hand0: ['captain'], units0: ['emperorGuard'], units1: ['big', 'trooper'] })
  state.players[0].units[0].upgrades = [shieldOf(0)]
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, pickBy(state, /Shielded/))
  assert.equal(keywordsOf(state, unitOf(state, 'captain')).sentinel, true)
  assert.equal(state.prompt!.options.filter((o) => o.id !== 'none').length, 2, 'its own Shield and the guard')
  state = answer(state, 'sh')
  state = answer(state, 'u10')
  state = answer(state, state.prompt!.options.find((o) => o.id !== 'none')!.id)
  state = answer(state, 'u10')
  assert.equal(unitOf(state, 'big').damage, 4)
  assert.deepEqual(shields(state, 0), [0, 0])
  assert.ok(!state.prompt, 'no third')
})

test('Imperial Escort Shuttle: its Shield token prevents damage to another friendly Emperor unit', () => {
  let state = table({ units0: ['escort', 'emperorGuard', 'trooper'], units1: ['big'] })
  state.players[0].units[0].arena = 'space'
  state.players[0].units[0].upgrades = [shieldOf(0)]
  state = act(state, 0, { type: 'attack', attacker: 'u01', target: 'u10' })
  assert.match(state.prompt!.text, /Imperial Escort Shuttle/)
  state = answer(state, 'yes')
  assert.equal(unitOf(state, 'emperorGuard').damage, 0)
  assert.deepEqual(shields(state, 0), [0, 0, 0])
  // Not for a unit that isn't an Emperor unit
  state = table({ units0: ['escort', 'trooper'], units1: ['big'] })
  state.players[0].units[0].upgrades = [shieldOf(0)]
  state = act(state, 0, { type: 'attack', attacker: 'u01', target: 'u10' })
  assert.ok(!state.prompt)
  assert.equal(state.players[0].units.length, 1)
})

test('Wensicia Corrino: damage equal to the number of upgrades on friendly units', () => {
  let state = table({ hand0: ['wensicia'], units0: ['emperorGuard'], units1: ['big'] })
  state.players[0].units[0].upgrades = [shieldOf(0), { id: 'k0', def: 'knife', owner: 0 }]
  state = settle(act(state, 0, { type: 'play', card: 'h0' }))
  assert.equal(unitOf(state, 'big').damage, 2)
})

test('Ginaz Training: +1/+1 and a Shield token on the unit', () => {
  let state = table({ hand0: ['ginaz'], units0: ['trooper'] })
  state = settle(act(state, 0, { type: 'play', card: 'h0', attachTo: 'u00' }))
  const unit = unitOf(state, 'trooper')
  assert.deepEqual(unit.upgrades.map((u) => state.defs[u.def].name).sort(), ['Ginaz Training', 'Shield'])
  assert.equal(powerOf(state, unit), 3)
})

test('Princess Irulan: Action [1, exhaust], a Shield token to a friendly Emperor unit', () => {
  let state = table({ units0: ['trooper', 'emperorGuard'] })
  state.players[0].leader.def = 'irulanLeader'
  const ready = state.players[0].resources.filter((r) => !r.exhausted).length
  state = settle(act(state, 0, { type: 'ability', source: 'leader', index: 0 }))
  assert.deepEqual(shields(state, 0), [0, 1], 'the Emperor unit, not the other')
  assert.equal(state.players[0].leader.exhausted, true)
  assert.equal(state.players[0].resources.filter((r) => !r.exhausted).length, ready - 1)
})

test('The AI discards so as to keep its best play now and next round: a 5-cost card on 2 resources, not its 2-drop', () => {
  const initiate = card('initiate', { ...scripted('Bene Gesserit Initiate'), cost: 2, power: 2, hp: 1, traits: ['Bene Gesserit'] })
  let state = table({ hand0: ['initiate'] })
  state.defs.initiate = initiate
  state.players[1].hand = [{ id: 'x0', def: 'big' }, { id: 'x1', def: 'guard' }, { id: 'x2', def: 'trooper' }]
  state.players[1].resources = state.players[1].resources.slice(0, 2)
  state = act(state, 0, { type: 'play', card: 'h0' })
  while (state.prompt && state.prompt.player === 0) state = answer(state, state.prompt.options[0].id)
  assert.equal(state.prompt?.player, 1)
  state = act(state, 1, chooseAction(state, 1)!)
  assert.deepEqual(state.players[1].hand.map((c) => c.def).sort(), ['guard', 'trooper'])
})

test("Paul Atreides' unit side: a card from the discard pile to the bottom of the deck, its On Attack used as his", () => {
  let state = table({ units1: ['trooper'] })
  state.players[0].leader.def = 'paulLeader'
  state.players[0].discard = [{ id: 'x0', def: 'big' }, { id: 'x1', def: 'sandwalker' }]
  state = settle(act(state, 0, { type: 'deploy' }))
  const paul = state.players[0].units.find((u) => u.leader)!
  paul.exhausted = false
  state.active = 0
  state = act(state, 0, { type: 'attack', attacker: paul.id, target: 'base' })
  assert.match(state.prompt!.text, /discard pile on the bottom/)
  state = answer(state, 'x1')
  // The Sandwalker's On Attack: exhaust an enemy ground unit that costs 3 or less
  state = answer(state, 'u10')
  assert.equal(state.players[1].units[0].exhausted, true)
  assert.deepEqual(state.players[0].discard.map((c) => c.id), ['x0'])
  assert.equal(state.players[0].deck.at(-1)!.id, 'x1')
})

test('Paul Atreides, Heir: choose an enemy unit, reveal the top card; same cost, 1 damage to that unit or a base', () => {
  let state = table({ units0: ['heirPinger'], units1: ['trooper', 'emperorGuard'], deck0: ['emperorGuard', 'big'] })
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'base' })
  assert.deepEqual(state.prompt!.options.map((o) => o.id), ['u10', 'u11'], 'any enemy unit, not only the defender')
  state = answer(state, 'u11')
  assert.ok(state.log.some((l) => /reveals emperorGuard/.test(l.text)))
  state = answer(state, 'base1')
  assert.equal(state.players[1].base.damage, 3 + 1)
  assert.equal(state.players[0].deck[0].def, 'emperorGuard', 'the card stays on top')
  // No match: no damage
  state = table({ units0: ['heirPinger'], units1: ['trooper'], deck0: ['big'] })
  state = settle(act(state, 0, { type: 'attack', attacker: 'u00', target: 'base' }))
  assert.equal(state.players[1].base.damage, 3)
  assert.equal(state.players[1].units[0].damage, 0)
})
