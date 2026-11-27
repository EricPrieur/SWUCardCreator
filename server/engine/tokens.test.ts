import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyAction, createGame, Game, hpOf, keywordsOf, legalActions, powerOf, traitsOf } from './game.ts'
import { readText } from './cards.ts'
import { chooseAction, resourcePicks } from './ai.ts'
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
  card('lasgunVolley', { type: 'event', cost: 3, text: 'Deal 4 damage to a unit.' }),
  card('escortFrigate', { ...scripted('Caladan Escort Frigate'), cost: 5, power: 3, hp: 6, arena: 'space', traits: ['Atreides', 'Vehicle', 'Capital Ship'] }),
  card('tabrElder', { ...scripted('Sietch Tabr Elder'), cost: 5, power: 3, hp: 7, traits: ['Fremen'], keywords: { sentinel: true } }),
  card('restorer', { cost: 2, power: 2, hp: 3, keywords: { restore: 2 } }),
  card('spiceBarge', { ...scripted("Smuggler's Spice Barge"), cost: 5, power: 4, hp: 5, arena: 'space', traits: ['Underworld', 'Vehicle', 'Transport'] }),
  card('turnedAsset', { ...scripted('Turned Asset'), cost: 6, power: 4, hp: 5, traits: ['Spy'] }),
  card('spyToken', { cost: 0, power: 0, hp: 2, token: true, traits: ['Spy'], keywords: { raid: 2 } }),
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
  card('hoarder', { ...scripted('Harkonnen Sleeper Agent'), cost: 2, power: 1, hp: 3, traits: ['Harkonnen', 'Spy'] }),
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
  card('stilgarLeader', { ...scriptedBy('Stilgar', 'Naib of Sietch Tabr'), type: 'leader', cost: 5, traits: ['Fremen'], unit: { power: 4, hp: 6, arena: 'ground', keywords: {} } }),
  card('kindjal', { ...scripted('Atreides Kindjal'), type: 'upgrade', cost: 1, power: 1, hp: 1, traits: ['Atreides', 'Item', 'Weapon'] }),
  card('maula', { ...scripted('Maula Pistol'), type: 'upgrade', cost: 1, power: 1, hp: 0, traits: ['Fremen', 'Item', 'Weapon'] }),
  card('ambush', { ...scripted('Sietch Ambush'), type: 'event', cost: 1, arena: undefined, aspects: ['Aggression', 'Heroism'], traits: ['Fremen', 'Tactic'] }),
  card('keeper', { ...scripted('Deathstill Keeper'), cost: 3, power: 2, hp: 4, traits: ['Fremen'] }),
  card('sayyadina', { ...scriptedBy('Chani', 'Sayyadina of the Fedaykin'), cost: 7, power: 4, hp: 6, unique: true, traits: ['Fremen', 'Fedaykin'] }),
  card('ultimatum', { ...scripted('He Who Can Destroy a Thing'), type: 'event', cost: 3, arena: undefined, aspects: ['Aggression', 'Heroism'], traits: ['Fremen', 'Tactic'] }),
  card('martyr', { ...scripted('Fedaykin Martyr'), cost: 2, power: 2, hp: 2, traits: ['Fremen', 'Fedaykin'] }),
  card('litany', { ...scripted('Litany Against Fear'), type: 'upgrade', cost: 2, power: 2, hp: 2, traits: ['Bene Gesserit', 'Learned'] }),
  card('sixer', { cost: 6, power: 6, hp: 6 }),
  card('strikeLeader', { ...scripted('Fedaykin Strike Leader'), cost: 5, power: 5, hp: 4, traits: ['Fremen', 'Fedaykin'] }),
  card('yuehPlot', { ...scriptedBy('Dr. Wellington Yueh', 'Broken Conditioning'), type: 'unit', cost: 3, power: 3, hp: 5, arena: 'ground', unique: true, traits: ['Atreides', 'Suk', 'Spy'] }),
  card('faceDancer', { ...scripted('Tleilaxu Face Dancer'), type: 'unit', cost: 4, power: 0, hp: 1, arena: 'ground', traits: ['Tleilaxu'] }),
  card('spiceFlow', { ...scripted('The Spice Must Flow'), type: 'event', cost: 3, arena: undefined }),
  card('picket', { ...scripted('Imperial Picket Ship'), type: 'unit', cost: 2, power: 1, hp: 4, arena: 'space', traits: ['Emperor', 'Vehicle', 'Fighter'] }),
  card('probe', { ...scripted('Ixian Probe Drone'), type: 'unit', cost: 2, power: 2, hp: 2, arena: 'space', traits: ['Ixian', 'Vehicle', 'Drone', 'Spy'] }),
  card('enemyThopter', { cost: 2, power: 3, hp: 1, arena: 'space', traits: ['Vehicle', 'Fighter'] }),
  card('spymaster', { ...scripted('Spymaster of Kaitain'), type: 'unit', cost: 6, power: 4, hp: 6, arena: 'ground', traits: ['Emperor', 'Spy'] }),
  card('scytale', { ...scriptedBy('Scytale', 'Tleilaxu Master'), type: 'unit', cost: 6, power: 5, hp: 6, arena: 'ground', unique: true, traits: ['Tleilaxu', 'Spy'] }),
  card('herald', { ...scripted('Imperial Herald'), type: 'unit', cost: 4, power: 4, hp: 5, arena: 'ground', traits: ['Emperor', 'Official'] }),
  card('doubleAgent', { ...scripted('Landsraad Double Agent'), type: 'unit', cost: 4, power: 5, hp: 4, arena: 'ground', traits: ['Spy', 'Official'] }),
  card('informant', { ...scripted('Residency Informant'), type: 'unit', cost: 2, power: 2, hp: 4, arena: 'ground', traits: ['Emperor', 'Spy'] }),
  card('fenringLeader', { ...scriptedBy('Count Hasimir Fenring', "The Emperor's Shadow"), type: 'leader', cost: 6, unit: { power: 4, hp: 6, arena: 'ground', keywords: { saboteur: true } } }),
  card('imperialSpy', { ...scripted('Imperial Spy'), type: 'unit', cost: 2, power: 2, hp: 4, arena: 'ground', traits: ['Emperor', 'Spy'] }),
  card('blade', { ...scriptedBy('Count Hasimir Fenring', "The Emperor's Blade"), type: 'unit', cost: 5, power: 5, hp: 3, arena: 'ground', traits: ['Emperor', 'Spy'] }),
  card('webOfSpies', { ...scripted('A Web of Spies'), type: 'event', cost: 3, arena: undefined, traits: ['Trick'] }),
  card('writ', { ...scripted('Forged Imperial Writ'), type: 'upgrade', cost: 1, power: 1, hp: 1, arena: undefined, traits: ['Item'] }),
  card('gurneyLeader', { ...scriptedBy('Gurney Halleck', 'Smuggler of Arrakis'), type: 'leader', cost: 5, aspects: ['Cunning', 'Heroism'], traits: ['Atreides', 'Underworld'], unit: { power: 3, hp: 5, arena: 'ground', keywords: { saboteur: true } } }),
  card('chaniLeader', { ...scriptedBy('Chani', 'Sihaya'), type: 'leader', cost: 4, traits: ['Fremen'], unit: { power: 3, hp: 5, arena: 'ground', keywords: {} } }),
  card('letoLeader', { ...scriptedBy('Duke Leto Atreides', 'Duke of House Atreides'), type: 'leader', cost: 6, traits: ['Atreides'], unit: { power: 4, hp: 7, arena: 'ground', keywords: {} } }),
  card('lighter', { ...scripted("Tuek's Lighter"), subtitle: "Smuggler's Run", cost: 3, power: 2, hp: 3, arena: 'space', traits: ['Underworld', 'Vehicle'] }),
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
  card('noShip', { ...scripted('Ixian No-Ship'), cost: 3, power: 2, hp: 3, arena: 'space', unique: true, traits: ['Ixian', 'Vehicle', 'Transport'] }),
  card('freighter', { ...scripted('CHOAM Spice Freighter'), cost: 6, power: 3, hp: 7, arena: 'space', traits: ['Vehicle', 'Transport'] }),
  card('livery', { ...scripted('Frigate in Harkonnen Livery'), cost: 5, power: 4, hp: 5, arena: 'space', traits: ['Emperor', 'Harkonnen', 'Vehicle', 'Capital Ship'] }),
  card('atreidesFrigate', { ...scriptedBy('Atreides Frigate', 'Ducal Flagship'), cost: 6, power: 4, hp: 6, arena: 'space', unique: true, traits: ['Atreides', 'Vehicle', 'Capital Ship'] }),
  card('mercFighter', { ...scripted('Mercenary Strike Fighter'), cost: 3, power: 3, hp: 2, arena: 'space', traits: ['Underworld', 'Ginaz', 'Vehicle', 'Fighter'] }),
  card('commandeered', { ...scripted('Commandeered Harkonnen Frigate'), cost: 5, power: 4, hp: 5, arena: 'space', traits: ['Fremen', 'Vehicle', 'Capital Ship'] }),
  card('courier', { ...scripted('Weapons Courier'), cost: 1, power: 1, hp: 1, arena: 'space', traits: ['Vehicle', 'Transport'] }),
  card('surveyCraft', { ...scripted("Planetologist's Survey Craft"), cost: 3, power: 2, hp: 4, arena: 'space', traits: ['Emperor', 'Vehicle', 'Transport'] }),
  card('korba', { ...scripted('Korba'), cost: 6, power: 5, hp: 6, unique: true, traits: ['Fremen', 'Fedaykin', 'Official'] }),
  card('waterSeller', { ...scripted('Water Seller'), cost: 1, power: 1, hp: 4, aspects: ['Cunning', 'Vigilance'], traits: ['Underworld'] }),
  card('lookout', { ...scripted("Smuggler's Lookout"), cost: 2, power: 2, hp: 3, aspects: ['Vigilance'], traits: ['Underworld'] }),
  card('guildBribe', { ...scripted('Guild Bribe'), type: 'event', cost: 1, arena: undefined, aspects: ['Cunning'], traits: ['Trick'] }),
  card('sealedPass', { ...scripted('Sealed Pass'), type: 'event', cost: 2, arena: undefined, aspects: ['Vigilance'], traits: ['Tactic'] }),
  card('slipTip', { ...scripted('Slip-Tip'), type: 'upgrade', cost: 1, power: 1, hp: 1, arena: undefined, traits: ['Item', 'Weapon', 'Poison'] }),
  card('spiceHoard', { ...scripted('The Spice Hoard'), type: 'upgrade', cost: 2, arena: undefined, unique: true, traits: ['Fortification'] }),
  card('guildTransport', { ...scripted('Guild Transport'), cost: 4, power: 2, hp: 5, arena: 'space', traits: ['Spacing Guild', 'Vehicle', 'Transport'] }),
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
  // Smuggle 4, Cunning off-aspect: 4 + 2
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
  // Planned, then played (7.5.19b)
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

test("Kynes's Dream: 3 healed from your base and each friendly Fremen unit, an Experience token to each Fremen unit healed", () => {
  let state = table({ hand0: ['kynesDream'], units0: ['fremen', 'fremen', 'big'], units1: ['fremen'] })
  state.players[0].base.damage = 10
  state.players[0].units[0].damage = 2
  state.players[0].units[2].damage = 2
  state.players[1].units[0].damage = 2
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.equal(state.players[0].base.damage, 7)
  assert.deepEqual(state.players[0].units.map((u) => u.damage), [0, 0, 2], 'Fremen only')
  assert.deepEqual(state.players[0].units.map((u) => u.upgrades.length), [1, 0, 0], 'the damaged Fremen only')
  assert.equal(state.players[1].units[0].damage, 2, 'friendly only')
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

test('Harkonnen Sleeper Agent: on Arrakis a Spy token when played; off Arrakis a Spice token when played and on attack', () => {
  const spies = (st: GameState) => st.players[0].units.filter((u) => st.defs[u.def].name === 'Spy')
  let state = table({ hand0: ['hoarder'], units0: ['hoarder'] })
  const spice = state.players[0].spice.length
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.equal(spies(state).length, 1)
  assert.equal(state.players[0].spice.length, spice, 'no Spice token on Arrakis')
  const spy = spies(state)[0]
  assert.equal(powerOf(state, spy), 0)
  assert.equal(keywordsOf(state, spy).raid, 2, 'a 0/2 with Raid 2')
  state.active = 0
  state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'base' })
  assert.equal(spies(state).length, 1, 'no Spy token on attack')
  let off = table({ base0: 'caladan', hand0: ['hoarder'], units0: ['hoarder'] })
  off = act(off, 0, { type: 'play', card: 'h0' })
  assert.equal(off.players[0].spice.length, 1)
  assert.equal(spies(off).length, 0)
  off.active = 0
  off = act(off, 0, { type: 'attack', attacker: 'u00', target: 'base' })
  assert.equal(off.players[0].spice.length, 2, 'off Arrakis, Spice on attack as before')
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

test('Ramallo: her first heal may be passed, and then no Spice token is asked for', () => {
  let state = table({ hand0: ['ramallo'], units1: ['crusher'] })
  state.players[1].units[0].damage = 2
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.equal(state.prompt?.min, 0, 'only an enemy unit to heal: she may pass')
  state = answer(state)
  assert.equal(state.players[1].units[0].damage, 2)
  assert.equal(state.prompt, null)
})

test('the AI plays a unique card it already controls (Ramallo attached) only for what her When Played is worth', () => {
  const setup = (damage: number) => {
    let state = table({ base0: 'caladan', units0: ['ramallo', 'fremen'], units1: ['crusher'], hand0: ['ramallo'] })
    state = act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' })
    state = answer(state, 'u01')
    state = act(state, 1, { type: 'pass' })
    state.players[0].base.damage = damage
    return { state, hand: state.players[0].hand.find((c) => c.def === 'ramallo')!.id }
  }
  // What the AI makes of playing her, among its moves
  const gainOf = (damage: number) => {
    const { state, hand } = setup(damage)
    const why: { action: Action; gain: number }[] = []
    chooseAction(state, 0, why)
    return why.find((w) => w.action.type === 'play' && w.action.card === hand)?.gain ?? -Infinity
  }
  // Nothing to heal: a card and resources spent for nothing
  assert.ok(gainOf(0) <= 0, 'not for no heal')
  // Her base in reach of the enemy's 6-power unit: healing it is worth her body
  assert.ok(gainOf(22) > 0, 'worth it to heal a base under pressure')
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

test("Smugglers' Raid: an attack with +2/+0, from the hand or using Smuggle", () => {
  let state = table({ hand0: ['raid'], units0: ['trooper'] })
  const spice = state.players[0].spice.length
  state = settle(act(state, 0, { type: 'play', card: 'h0' }))
  assert.equal(state.players[1].base.damage, 4, 'the Trooper attacks the base with 2 + 2')
  assert.equal(state.players[0].spice.length, spice, 'no Spice from the hand')
  // Smuggle 4, Cunning off-aspect: 4 + 2
  state = table({ units0: ['trooper'] })
  state.players[0].resources[0].card = { id: 'rr', def: 'raid' }
  state = settle(act(state, 0, { type: 'play', card: 'rr', smuggle: true }))
  assert.equal(state.players[1].base.damage, 4)
  assert.equal(state.players[0].spice.length, spice, 'no Spice token for the Smuggle either')
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
  assert.equal(before - ready(), 3 + 1, 'the No-Ship and the Trooper both paid for')
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

test('Frigate in Harkonnen Livery: attacks with a friendly ground Trooper unit, +2/+0 for that attack', () => {
  let state = table({ hand0: ['livery'], units0: ['soldier', 'big'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.deepEqual(state.prompt!.options.map((o) => o.id), ['u00'], 'the Trooper only')
  state = settle(answer(state, 'u00'))
  const soldier = state.players[0].units[0]
  assert.equal(soldier.exhausted, true, 'it attacked')
  assert.equal(state.players[1].base.damage, 4, '2 + 2')
  assert.equal(powerOf(state, soldier), 2, 'for that attack only')
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

test('Commandeered Harkonnen Frigate: damage to one enemy ground unit equal to the friendly Fremen ground units', () => {
  let state = table({ hand0: ['commandeered'], units0: ['fremen', 'fremen', 'trooper', 'thopter'], units1: ['big', 'trooper'] })
  state.players[0].units[3].arena = 'space'
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.match(state.prompt!.text, /deal 2 damage/)
  state = answer(state, 'u10')
  assert.equal(state.prompt, null, 'one target, asked once')
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

test('Stilgar: his token only once a Fremen unit was played this phase, not for one already in play', () => {
  let state = table({ units0: ['fremen'], hand0: ['fremen'] })
  state.players[0].leader.def = 'stilgarLeader'
  state.players[0].units[0].entered = -1
  const ability: Action = { type: 'ability', source: 'leader', index: 0 }
  assert.ok(!legalActions(state, 0).some((a) => a.type === 'ability' && a.source === 'leader'))
  state = settle(act(state, 0, { type: 'play', card: 'h0' }))
  state.active = 0
  state = settle(act(state, 0, ability))
  assert.equal(state.players[0].units.filter((u) => state.defs[u.def].name === 'Fremen').length, 1, 'a Fremen token')
})

test("Duke Leto's leader side gives Experience to Atreides units only: Tuek's Lighter gets none, the Spice token stays", () => {
  let state = table({ hand0: ['lighter'] })
  state.players[0].leader.def = 'letoLeader'
  state.players[0].resources = state.players[0].resources.slice(0, 3)
  assert.equal(state.players[0].spice.length, 1)
  state = act(state, 0, { type: 'play', card: 'h0' })
  while (state.prompt?.player === 0) state = act(state, 0, chooseAction(state, 0)!)
  const lighter = state.players[0].units.find((u) => u.def === 'lighter')!
  assert.equal(lighter.upgrades.length, 0, 'no Experience token: not an Atreides unit')
  assert.equal(state.players[0].spice.length, 1, 'the Spice token kept')
  assert.equal(state.players[0].leader.exhausted, false, 'the leader still ready')
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

test("Paul Atreides' unit side: a unit card from the discard pile to the bottom of the deck, its When Played used as his", () => {
  let state = table({ units1: ['trooper'] })
  state.players[0].leader.def = 'paulLeader'
  state.players[0].discard = [{ id: 'x0', def: 'big' }, { id: 'x1', def: 'shieldTrooper' }, { id: 'x2', def: 'lasgunVolley' }]
  state = settle(act(state, 0, { type: 'deploy' }))
  const paul = state.players[0].units.find((u) => u.leader)!
  paul.exhausted = false
  state.active = 0
  state = act(state, 0, { type: 'attack', attacker: paul.id, target: 'base' })
  assert.match(state.prompt!.text, /discard pile on the bottom/)
  assert.deepEqual(state.prompt!.options.map((o) => o.id), ['x0', 'x1'], 'unit cards only')
  state = answer(state, 'x1')
  while (state.prompt) state = answer(state, state.prompt.ai ?? state.prompt.options[0].id)
  // Atreides Shield Trooper's When Played, on an Arrakis base: an Experience token to "this unit", Paul
  const after = state.players[0].units.find((u) => u.leader)!
  assert.deepEqual(after.upgrades.map((u) => state.defs[u.def].name), ['Experience'])
  assert.deepEqual(state.players[0].discard.map((c) => c.id), ['x0', 'x2'])
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

test('Fedaykin Strike Leader: 1 damage for each time the enemy base was dealt damage this phase, ready at 3; the AI pings with Chani first', () => {
  const attackAll = (state: GameState) => {
    for (const u of state.players[0].units) {
      state.active = 0
      state = act(state, 0, { type: 'attack', attacker: u.id, target: 'base' })
    }
    state.active = 0
    return state
  }
  let state = attackAll(table({ hand0: ['strikeLeader'], units0: ['trooper', 'trooper'] }))
  assert.equal(state.players[1].base.damage, 4)
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.equal(state.players[1].base.damage, 6, '2 hits, 2 damage')
  assert.equal(state.players[0].units.at(-1)!.exhausted, true)
  // Chani's ping first makes it 3
  state = attackAll(table({ hand0: ['strikeLeader'], units0: ['trooper', 'trooper'] }))
  state.players[0].leader.def = 'chaniLeader'
  state = act(state, 0, { type: 'play', card: 'h0' })
  while (state.prompt) state = answer(state, state.prompt.ai ?? state.prompt.options[0].id)
  assert.equal(state.players[1].base.damage, 4 + 1 + 3, 'Chani 1, then 3 hits')
  assert.equal(state.players[0].units.at(-1)!.exhausted, false, 'ready')
})

test('Atreides Kindjal: +1/+1 and Saboteur, so the armed unit attacks the base past a Sentinel', () => {
  let state = table({ hand0: ['kindjal'], units0: ['trooper'], units1: ['guard'] })
  const attacker = state.players[0].units[0].id
  assert.equal(legalActions(state, 0).some((a) => a.type === 'attack' && a.attacker === attacker && a.target === 'base'), false, 'the Sentinel guards')
  state = act(state, 0, { type: 'play', card: 'h0', attachTo: attacker })
  while (state.prompt) state = answer(state, state.prompt.ai ?? state.prompt.options[0].id)
  state.active = 0
  const unit = state.players[0].units[0]
  assert.equal(powerOf(state, unit), 3)
  assert.equal(hpOf(state, unit), 3)
  state = act(state, 0, { type: 'attack', attacker, target: 'base' })
  assert.equal(state.players[1].base.damage, 3)
})

test('Saboteur defeats the defending unit\'s Shield tokens before combat damage (7.5.10a)', () => {
  let state = table({ hand0: ['kindjal'], units0: ['trooper'], units1: ['guard'] })
  const attacker = state.players[0].units[0].id
  const guard = state.players[1].units[0]
  guard.upgrades.push({ id: 's1', def: 'token-shield', owner: 1 }, { id: 's2', def: 'token-shield', owner: 1 })
  state = act(state, 0, { type: 'play', card: 'h0', attachTo: attacker })
  while (state.prompt) state = answer(state, state.prompt.ai ?? state.prompt.options[0].id)
  state.active = 0
  state = act(state, 0, { type: 'attack', attacker, target: guard.id })
  while (state.prompt) state = answer(state, state.prompt.ai ?? state.prompt.options[0].id)
  const after = state.players[1].units.find((u) => u.id === guard.id)!
  assert.equal(after.upgrades.length, 0, 'both Shields gone')
  assert.equal(after.damage, 3, 'and the 3 damage dealt')
})

test('The AI attacks the base before it plays a Fedaykin Strike Leader, so the hits count', () => {
  let state = table({ hand0: ['strikeLeader'], units0: ['trooper', 'trooper'] })
  state.players[1].units = []
  // Its turns, until it plays the Strike Leader: by then both units have attacked
  for (let i = 0; i < 10 && state.players[0].hand.length; i++) {
    const move = chooseAction(state, 0)!
    if (move.type === 'play') assert.equal(state.players[0].units.filter((u) => !u.leader && u.exhausted).length, 2, 'both attacked first')
    state = act(state, 0, move)
    while (state.prompt) state = answer(state, state.prompt.ai ?? state.prompt.options[0].id)
    state.active = 0
  }
  assert.equal(state.players[0].hand.length, 0, 'played')
})

test('The AI puts Litany Against Fear on its leader unit rather than a cheap unit', () => {
  let state = table({ hand0: ['litany'], units0: ['trooper'] })
  for (const r of state.players[0].resources) r.exhausted = false
  state = act(state, 0, { type: 'deploy' })
  while (state.prompt) state = answer(state, state.prompt.ai ?? state.prompt.options[0].id)
  state.active = 0
  const leaderUnit = state.players[0].units.find((u) => u.leader)!
  leaderUnit.exhausted = true
  state.players[0].units[0].exhausted = true
  const move = chooseAction(state, 0)!
  assert.equal(move.type, 'play')
  assert.equal(move.type === 'play' && move.attachTo, leaderUnit.id)
})

test('The AI keeps an upgrade off a unit an enemy unit can defeat, putting it on a sturdy one', () => {
  let state = table({ hand0: ['litany'], units0: ['trooper', 'guard'], units1: ['big'] })
  for (const u of state.players[0].units) u.exhausted = true
  // Its leader can't deploy yet: 3 resources; and it was defeated before, so the upgrade isn't
  // held for it (upgradesForLeader)
  state.players[0].resources = state.players[0].resources.slice(0, 3)
  state.players[0].leader.epicUsed = true
  state.players[0].spice = []
  // The trooper (2/2) would be a 4/4 the enemy 5/5 defeats; the guard (1/4) a 3/6 it doesn't
  const move = chooseAction(state, 0)!
  assert.equal(move.type, 'play')
  assert.equal(move.type === 'play' && move.attachTo, state.players[0].units[1].id)
})

test('The AI counts a unit it took until the regroup phase as its owner\'s: trading it away costs it nothing', () => {
  let state = table({ units0: ['big'], units1: ['guard'] })
  // Its 5/5 is borrowed (Seduction): attacking the 1/4 Sentinel with it is free
  const big = state.players[0].units[0]
  big.owner = 1
  state.borrowed = [{ unit: big.id, owner: 1 }]
  state.players[0].resources = state.players[0].resources.slice(0, 3)
  state.players[0].spice = []
  state.players[0].hand = []
  const move = chooseAction(state, 0)!
  assert.equal(move.type, 'attack')
})

test("Paul Atreides' leader side: the AI discards a unit on top for his unit side, keeps a card it wants to draw", () => {
  let state = table({ units0: ['trooper'] })
  state.players[0].leader.def = 'paulLeader'
  state.players[0].spice = []
  state.players[0].hand = []
  state.initiative = 1
  state.initiativeTaken = true
  const uses = (s: GameState) => {
    const legal = legalActions(s, 0)
    return legal.some((a) => a.type === 'ability' && a.source === 'leader') && !legal.some((a) => a.type === 'initiative')
  }
  // A cheap unit on top (cost 1, 6 resources): fuel
  state.players[0].deck = [{ id: 'd0', def: 'trooper' }, ...state.players[0].deck]
  assert.ok(uses(state), 'the opponent has the initiative')
  const fuelled = chooseAction(state, 0)!
  assert.equal(fuelled.type === 'ability' && fuelled.source, 'leader')
  // A 6-cost card on top with 6 resources: the one it wants next round, kept
  state.players[0].deck[0] = { id: 'd0', def: 'sixer' }
  const kept = chooseAction(state, 0)!
  assert.notEqual(kept.type === 'ability' && kept.source, 'leader')
})

test('Maula Pistol: the armed unit gains an On Attack, 1 damage to the enemy base, its own', () => {
  let state = table({ hand0: ['maula'], units0: ['trooper'] })
  const attacker = state.players[0].units[0].id
  state = act(state, 0, { type: 'play', card: 'h0', attachTo: attacker })
  while (state.prompt) state = answer(state, state.prompt.ai ?? state.prompt.options[0].id)
  state.active = 0
  state = act(state, 0, { type: 'attack', attacker, target: 'base' })
  assert.equal(state.players[1].base.damage, 3 + 1, '3 combat damage and the On Attack')
})

test('Sietch Ambush: 1 damage to a ground unit, and 1 to the enemy base only with a Fremen unit', () => {
  let state = table({ hand0: ['ambush'], units1: ['sixer'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, state.players[1].units[0].id)
  assert.equal(state.players[1].units[0].damage, 1)
  assert.equal(state.players[1].base.damage, 0, 'no Fremen unit')
  state = table({ hand0: ['ambush'], units0: ['martyr'], units1: ['sixer'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, state.players[1].units[0].id)
  assert.equal(state.players[1].base.damage, 1, 'with a Fremen unit')
})

test('Fedaykin Martyr: defeated, it deals 2 damage to the enemy base', () => {
  let state = table({ units0: ['martyr'], units1: ['sixer'] })
  state = act(state, 0, { type: 'attack', attacker: state.players[0].units[0].id, target: state.players[1].units[0].id })
  while (state.prompt) state = answer(state, state.prompt.ai ?? state.prompt.options[0].id)
  assert.equal(state.players[0].units.length, 0, 'the Martyr is defeated')
  assert.equal(state.players[1].base.damage, 2)
})

test('Deathstill Keeper: 1 damage to the enemy base when another friendly Fremen unit is defeated, and when it is', () => {
  let state = table({ units0: ['keeper', 'martyr'], units1: ['sixer'] })
  const [keeper, martyr] = state.players[0].units.map((u) => u.id)
  state = act(state, 0, { type: 'attack', attacker: martyr, target: state.players[1].units[0].id })
  while (state.prompt) state = answer(state, state.prompt.ai ?? state.prompt.options[0].id)
  assert.equal(state.players[1].base.damage, 2 + 1, "the Martyr's 2 and the Keeper's 1")
  state.active = 0
  state = act(state, 0, { type: 'attack', attacker: keeper, target: state.players[1].units[0].id })
  while (state.prompt) state = answer(state, state.prompt.ai ?? state.prompt.options[0].id)
  assert.equal(state.players[0].units.length, 0)
  assert.equal(state.players[1].base.damage, 3 + 1, 'its own death')
})

test("Chani's leader side: a Fremen event played (Sietch Ambush) triggers her too", () => {
  let state = table({ hand0: ['ambush'], units0: ['martyr'], units1: ['sixer'] })
  state.players[0].leader.def = 'chaniLeader'
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, state.players[1].units[0].id)
  assert.match(state.prompt?.text ?? '', /^Chani:/)
  state = answer(state, 'yes')
  assert.equal(state.players[1].base.damage, 1 + 1, "the Ambush's 1 and Chani's 1")
  assert.equal(state.players[0].leader.exhausted, true)
})

test('Chani, Sayyadina of the Fedaykin: a Fremen unit card from the discard pile to the bottom of the deck for each Fremen unit, 1 damage each', () => {
  let state = table({ hand0: ['sayyadina'], units0: ['martyr'] })
  state.players[0].resources.push(...Array(7).fill(0).map((_, i) => ({ card: { id: `r${i}`, def: 'trooper' }, exhausted: false })))
  state.players[0].discard = [{ id: 'x0', def: 'martyr' }, { id: 'x1', def: 'keeper' }, { id: 'x2', def: 'martyr' }, { id: 'x3', def: 'trooper' }]
  state = act(state, 0, { type: 'play', card: 'h0' })
  while (state.prompt) state = answer(state, state.prompt.ai ?? state.prompt.options[0].id)
  // Two Fremen units (her and the Martyr): two cards put back, the Trooper not a Fremen
  assert.equal(state.players[1].base.damage, 2)
  assert.deepEqual(state.players[0].discard.map((c) => c.id).sort(), ['x2', 'x3'])
  assert.deepEqual(state.players[0].deck.slice(-2).map((c) => c.id), ['x0', 'x1'])
})

test('He Who Can Destroy a Thing: every Spice token defeated, both sides, each a 1-damage ping; no Spice created and no base healed this round', () => {
  let state = table({ hand0: ['ultimatum'], units1: ['martyr'] })
  state.players[0].resources.push(...Array(3).fill(0).map((_, i) => ({ card: { id: `r${i}`, def: 'trooper' }, exhausted: false })))
  for (const p of [0, 1] as const) {
    state.players[p].spice.push({ id: `extra${p}`, def: state.players[p].spice[0]?.def ?? 'spice' })
  }
  const tokens = state.players[0].spice.length + state.players[1].spice.length
  state.players[1].base.damage = 5
  state = act(state, 0, { type: 'play', card: 'h0' })
  while (state.prompt) state = answer(state, state.prompt.ai ?? state.prompt.options[0].id)
  assert.equal(state.players[0].spice.length + state.players[1].spice.length, 0, 'every Spice token defeated')
  // The AI finishes the 2/2 Martyr with two pings, the rest at the base
  assert.equal(state.players[1].units.length, 0)
  assert.equal(state.players[1].base.damage, 5 + tokens - 2)
  const g = new Game(state, 1)
  g.createSpice(1)
  g.heal('base1', 3)
  assert.equal(state.players[1].spice.length, 0, "no Spice token created")
  assert.equal(state.players[1].base.damage, 5 + tokens - 2, 'no damage healed')
  state.round++
  g.createSpice(1)
  assert.equal(state.players[1].spice.length, 1, 'next round it is over')
})

// --- Gurney's smugglers (2026-11-17) ---
test('Water Seller: a Spice token for 3 damage healed from your base', () => {
  let state = table({ hand0: ['waterSeller'] })
  state.players[0].base.damage = 5
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, 'yes')
  assert.equal(state.players[0].base.damage, 2)
  assert.equal(state.players[0].spice.length, 0)
})

test("Smuggler's Lookout: a Sentinel, and a Spice token when played using Smuggle", () => {
  assert.equal(defs.find((d) => d.id === 'lookout')!.keywords.sentinel, true)
  let state = table({ deck0: ['big'] })
  state.players[0].resources[0].card = { id: 'lo', def: 'lookout' }
  state = settle(act(state, 0, { type: 'play', card: 'lo', smuggle: true }))
  assert.ok(state.players[0].units.some((u) => u.id === 'lo'))
  assert.equal(state.players[0].spice.length, 2, 'the Arrakis one and the Smuggle bonus')
})

test('Guild Bribe: an enemy unit exhausted, without Sentinel this phase; a Spice token to take a card from their hand, which they replace', () => {
  let state = table({ hand0: ['guildBribe'], units0: ['trooper'], units1: ['guard', 'trooper'] })
  state.players[1].hand = [{ id: 'e0', def: 'big' }, { id: 'e1', def: 'trooper' }]
  state.players[1].deck = [{ id: 'e2', def: 'guard' }, ...state.players[1].deck]
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = answer(state, 'u10')
  const guard = state.players[1].units.find((u) => u.id === 'u10')!
  assert.equal(guard.exhausted, true)
  assert.ok(!keywordsOf(state, guard).sentinel, 'no Sentinel this phase')
  state = answer(state, 'yes')
  assert.deepEqual(state.prompt?.options.map((o) => o.id), ['e0', 'e1'])
  state = answer(state, 'e0')
  assert.deepEqual(state.players[1].hand.map((c) => c.id), ['e1', 'e2'], 'the big one gone, a card drawn')
  assert.deepEqual(state.players[1].discard.map((c) => c.id), ['e0'])
  assert.equal(state.players[0].spice.length, 0)
  // The phase over, Sentinel again
  state.effects = state.effects.filter((e) => e.until !== 'phase')
  assert.equal(keywordsOf(state, guard).sentinel, true)
})

test('Sealed Pass: a ground unit costing 3 or less; 1 less to play with an Underworld unit', () => {
  const plain = table({ hand0: ['sealedPass'], units1: ['trooper', 'guard', 'big'] })
  plain.defs = { ...plain.defs, threeCost: { ...plain.defs.trooper, id: 'threeCost', cost: 3 } }
  plain.players[1].units.push({ id: 'u19', def: 'threeCost', owner: 1, arena: 'ground', damage: 0, exhausted: false, upgrades: [] })
  let state = act(plain, 0, { type: 'play', card: 'h0' })
  assert.deepEqual(state.prompt?.options.map((o) => o.id), ['u10', 'u11', 'u19'], '3 or less, not the 5-cost')
  const price = (s0: GameState) => {
    const before = s0.players[0].resources.filter((r) => !r.exhausted).length
    const after = act(s0, 0, { type: 'play', card: 'h0' })
    return before - after.players[0].resources.filter((r) => !r.exhausted).length
  }
  const without = price(table({ hand0: ['sealedPass'], units1: ['trooper'] }))
  const withUnderworld = price(table({ hand0: ['sealedPass'], units0: ['waterSeller'], units1: ['trooper'] }))
  assert.equal(without - withUnderworld, 1, 'an Underworld unit takes 1 off')
})

test('Slip-Tip: the attached unit gives the defender a Weakness token on attack; using Smuggle, a Weakness token too', () => {
  let state = table({ hand0: ['slipTip'], units0: ['big'], units1: ['big'] })
  state = settle(act(state, 0, { type: 'play', card: 'h0', attachTo: 'u00' }))
  assert.equal(powerOf(state, state.players[0].units[0]), 6)
  state = act(state, 1, { type: 'pass' })
  state = settle(act(state, 0, { type: 'attack', attacker: 'u00', target: 'u10' }))
  // 5/5 with a Weakness token (4/4) takes 6: defeated; it dealt 4
  assert.equal(state.players[1].units.length, 0)
  assert.equal(state.players[0].units[0].damage, 4)
  let smuggled = table({ deck0: ['big'], units0: ['big'], units1: ['big'] })
  smuggled.players[0].resources[0].card = { id: 'st', def: 'slipTip' }
  smuggled = act(smuggled, 0, { type: 'play', card: 'st', smuggle: true, attachTo: 'u00' })
  smuggled = settle(answer(smuggled, 'u10'))
  assert.equal(powerOf(smuggled, smuggled.players[1].units[0]), 4, 'a Weakness token on the enemy unit')
})

test('The Spice Hoard: a Spice token, and 1 damage healed from your base each time you defeat one', () => {
  let state = table({ hand0: ['spiceHoard'], deck0: ['big', 'guard', 'trooper', 'trooper'] })
  state = settle(act(state, 0, { type: 'play', card: 'h0', attachTo: 'base0' }))
  assert.equal(state.players[0].spice.length, 2)
  assert.ok(state.players[0].base.upgrades?.some((u) => u.def === 'spiceHoard'))
  state.players[0].base.damage = 4
  state.active = 0
  state = act(state, 0, { type: 'ability', source: state.players[0].spice[0].id, index: 0 })
  state = settle(state)
  assert.equal(state.players[0].base.damage, 3)
})

test('Guild Transport: a ground unit costing 3 or less back to hand, and played again for free', () => {
  let state = table({ hand0: ['guildTransport'], units0: ['waterSeller', 'big'] })
  state.players[0].base.damage = 6
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.deepEqual(state.prompt?.options.map((o) => o.id), ['u00'], 'not the 5-cost')
  state = answer(state, 'u00')
  const ready = state.players[0].resources.filter((r) => !r.exhausted).length
  state = answer(state, 'yes')
  assert.ok(state.players[0].units.some((u) => u.id === 'u00'), 'played again')
  // Its When Played again: the Arrakis Spice token for 3 healed
  state = answer(state, 'yes')
  assert.equal(state.players[0].base.damage, 3)
  assert.equal(state.players[0].resources.filter((r) => !r.exhausted).length, ready, 'for free')
})

test('The Spice Hoard may be played using Smuggle, onto your base', () => {
  let state = table({ deck0: ['big'] })
  state.players[0].resources[0].card = { id: 'sh', def: 'spiceHoard' }
  assert.ok(legalActions(state, 0).some((a) => a.type === 'play' && a.card === 'sh' && a.smuggle))
  state = settle(act(state, 0, { type: 'play', card: 'sh', smuggle: true, attachTo: 'base0' }))
  assert.ok(state.players[0].base.upgrades?.some((u) => u.id === 'sh'))
})

test('the AI puts Smuggle cards in its resources when its leader plays cards using Smuggle', () => {
  const state = table({ hand0: ['smuggler', 'big', 'trooper'] })
  // A leader that doesn't: the dearest card it can't play soon goes first, as before
  assert.notDeepEqual(resourcePicks(state, 0, 1), ['h0'])
  const gurney = { ...state, defs: { ...state.defs, leader: { ...state.defs.leader, text: '[Action [Arrow]:] Play a card using Smuggle. It costs [2] less.' } } }
  assert.deepEqual(resourcePicks(gurney, 0, 1), ['h0'], 'Spice Smuggler, to play from there')
})

test('the AI puts Slip-Tip on its own unit, not on an enemy one for its Smuggle Weakness token', () => {
  // Its only unit exhausted, in reach of a bigger enemy one: the upgrade at risk there
  const state = table({ units0: ['trooper'], units1: ['big'] })
  state.players[0].units[0].exhausted = true
  state.players[0].resources[0].card = { id: 'st', def: 'slipTip' }
  const why: { action: Action; gain: number }[] = []
  chooseAction(state, 0, why)
  const gain = (onto: string) => why.find((w) => w.action.type === 'play' && w.action.card === 'st' && w.action.attachTo === onto)?.gain ?? -Infinity
  assert.ok(gain('u00') > gain('u10'), 'its own unit before the enemy one')
  assert.ok(gain('u10') <= 0, 'never on the enemy one')
})

test('Gurney Halleck: a Spice token to smuggle a card for 2 less; deployed, one card smuggled for 2 less', () => {
  const ready = (st: GameState) => st.players[0].resources.filter((r) => !r.exhausted).length
  const setup = () => {
    const st = table({ units0: ['trooper'], deck0: ['big', 'big'] })
    st.players[0].leader.def = 'gurneyLeader'
    st.players[0].resources[0].card = { id: 'rr', def: 'raid' }
    return st
  }
  // What smuggling it costs without him
  const plain = setup()
  const full = ready(plain) - ready(settle(act(plain, 0, { type: 'play', card: 'rr', smuggle: true })))
  // His Action: a Spice token, then 2 less
  let state = setup()
  const action = legalActions(state, 0).find((a) => a.type === 'ability' && a.source === 'leader')!
  assert.ok(action, 'his Action, with a Spice token and a card to smuggle')
  const before = ready(state)
  state = act(state, 0, action)
  if (state.prompt?.options.some((o) => o.id === 'rr')) state = answer(state, 'rr')
  state = settle(state)
  assert.equal(before - ready(state), full - 2, '2 less')
  assert.ok(state.players[0].discard.some((c) => c.id === 'rr'), "Smugglers' Raid played")
  // Nothing to smuggle: no Action, so no Spice token spent for nothing
  const bare = table({})
  bare.players[0].leader.def = 'gurneyLeader'
  assert.ok(!legalActions(bare, 0).some((a) => a.type === 'ability' && a.source === 'leader'))
  // Deployed: a 3/5 Saboteur that may smuggle a card for 2 less, no Spice token needed
  state = setup()
  state.players[0].spice = []
  state = act(state, 0, { type: 'deploy' })
  assert.ok(state.prompt?.options.some((o) => o.id === 'rr'), 'the card to smuggle')
  assert.equal(state.prompt?.min, 0, 'you may')
  state = settle(answer(state, 'rr'))
  assert.ok(state.players[0].discard.some((c) => c.id === 'rr'))
  const gurney = state.players[0].units.find((u) => u.leader)!
  assert.equal(keywordsOf(state, gurney).saboteur, true)
})

test('the AI keeps a unit whose Plot play defeats it (Yueh) to play from the hand, not as a resource', () => {
  const state = table({ hand0: ['yuehPlot', 'trooper', 'informant'] })
  assert.ok(state.defs.yuehPlot.keywords.plot, 'Yueh has Plot')
  assert.ok(!state.players[0].leader.deployed)
  const picks = resourcePicks(state, 0, 1)
  assert.notEqual(state.players[0].hand.find((c) => c.id === picks[0])!.def, 'yuehPlot')
})

test('the AI plays a unit, not The Spice Must Flow, against a board that outpowers its own', () => {
  // Round 3: 3 resources, a 5-power enemy unit, nothing of its own
  const state = table({ hand0: ['spiceFlow', 'informant'], units1: ['big'] })
  state.players[0].resources = state.players[0].resources.slice(0, 3)
  state.players[0].resources.forEach((r) => (r.exhausted = false))
  const why: { action: Action; gain: number }[] = []
  chooseAction(state, 0, why)
  // (with 8 resources, deploying its leader comes first: compare the two cards)
  const gain = (card: string) => why.find((w) => w.action.type === 'play' && w.action.card === card)!.gain
  assert.ok(gain('h1') > gain('h0'), `the Informant ${gain('h1')}, The Spice Must Flow ${gain('h0')}`)
})

test('the AI holds A Web of Spies until it makes 2 Spy tokens', () => {
  let state = table({ hand0: ['webOfSpies', 'trooper'], units0: ['informant'] })
  state.players[0].resources.forEach((r) => (r.exhausted = false))
  const move = chooseAction(state, 0)!
  assert.ok(!(move.type === 'play' && move.card === 'h0'), 'one Spy: it waits')
  state = table({ hand0: ['webOfSpies', 'trooper'], units0: ['informant', 'imperialSpy', 'doubleAgent'] })
  state.players[0].resources.forEach((r) => (r.exhausted = false))
  const later = chooseAction(state, 0)!
  assert.ok(later.type === 'play' && later.card === 'h0', 'three Spies: it plays it')
})

test("Tleilaxu Face Dancer: Experience tokens for half the copied unit's power and HP, and its traits", () => {
  let state = table({ hand0: ['faceDancer'], units0: ['informant'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  const informant = state.players[0].units.find((u) => u.def === 'informant')!.id
  if (state.prompt) state = answer(state, informant)
  const dancer = state.players[0].units.find((u) => u.def === 'faceDancer')!
  assert.equal(dancer.upgrades.filter((u) => state.defs[u.def].name === 'Experience').length, 3, 'a 2/4: 3')
  assert.deepEqual([...traitsOf(state, dancer)].sort(), ['Emperor', 'Spy', 'Tleilaxu'])
  // Copied traits count as its own: a Spy for A Web of Spies
  state.players[0].hand.push({ id: 'h9', def: 'webOfSpies' })
  state.players[0].resources.forEach((r) => (r.exhausted = false))
  state.active = 0
  state = settle(act(state, 0, { type: 'play', card: 'h9' }))
  assert.equal(state.players[0].units.filter((u) => state.defs[u.def].token && state.defs[u.def].name === 'Spy').length, 2)
})

test('Imperial Picket Ship: Sentinel; exhausts an enemy space unit when played, not a ground one', () => {
  let state = table({ hand0: ['picket'], units1: ['big', 'enemyThopter'] })
  state.players[1].units[1].arena = 'space'
  state = act(state, 0, { type: 'play', card: 'h0' })
  if (state.prompt) {
    assert.deepEqual(state.prompt.options.map((o) => o.id), ['u11'], 'the space unit only')
    state = answer(state, 'u11')
  }
  assert.equal(state.players[1].units[1].exhausted, true)
  assert.equal(state.players[1].units[0].exhausted, false)
  const picket = state.players[0].units.find((u) => u.def === 'picket')!
  assert.equal(keywordsOf(state, picket).sentinel, true)
})

test('Ixian Probe Drone: Hidden, a Spy, and a Spy token on attack', () => {
  let state = table({ units0: ['probe'] })
  const probe = state.players[0].units[0]
  probe.arena = 'space'
  assert.equal(keywordsOf(state, probe).hidden, true)
  assert.ok(traitsOf(state, probe).includes('Spy'))
  state = settle(act(state, 0, { type: 'attack', attacker: probe.id, target: 'base' }))
  assert.equal(state.players[0].units.filter((u) => state.defs[u.def].token && state.defs[u.def].name === 'Spy').length, 1)
})

test('Spymaster of Kaitain: a ready Spy token, then another ready Spy (the new token too) may attack', () => {
  let state = table({ hand0: ['spymaster'], units0: ['imperialSpy'] })
  state.players[0].resources.forEach((r) => (r.exhausted = false))
  const spy = state.players[0].units[0].id
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.ok(state.prompt, 'the attack question')
  const token = state.players[0].units.find((u) => state.defs[u.def].token && state.defs[u.def].name === 'Spy')!
  assert.ok(!token.exhausted, 'the token is ready')
  assert.deepEqual(
    state.prompt!.options.map((o) => o.id).filter((id) => id !== 'none').sort(),
    [spy, token.id].sort(),
    'the ready Spies, not itself',
  )
  state = settle(answer(state, token.id))
  assert.equal(powerOf(state, state.players[0].units.find((u) => u.id === spy)!), 2, 'no +1/+0 for the other Spies')
  assert.ok(state.players[1].base.damage > 0, 'the token attacked')
})

test('Scytale: defeats an enemy non-leader unit with 4 or less remaining HP', () => {
  let state = table({ hand0: ['scytale'], units1: ['big', 'informant'] })
  state.players[0].resources.forEach((r) => (r.exhausted = false))
  // The 5/5 has 5 HP left; damaged by 1, it has 4
  state = act(state, 0, { type: 'play', card: 'h0' })
  if (state.prompt) {
    assert.deepEqual(state.prompt.options.map((o) => o.id), ['u11'], 'only the 2/4')
    state = answer(state, 'u11')
  }
  assert.equal(state.players[1].units.length, 1)
  let hurt = table({ hand0: ['scytale'], units1: ['big'] })
  hurt.players[0].resources.forEach((r) => (r.exhausted = false))
  hurt.players[1].units[0].damage = 1
  hurt = settle(act(hurt, 0, { type: 'play', card: 'h0' }))
  assert.equal(hurt.players[1].units.length, 0, '4 HP left: defeated')
})

test('Imperial Herald: an Experience token to another friendly unit', () => {
  let state = table({ hand0: ['herald'], units0: ['informant'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  const informant = state.players[0].units.find((u) => u.def === 'informant')!.id
  assert.deepEqual(state.prompt?.options.map((o) => o.id), [informant], 'not itself')
  state = answer(state, informant)
  const tokens = (id: string) => state.players[0].units.find((u) => u.id === id)!.upgrades.filter((u) => state.defs[u.def].name === 'Experience').length
  assert.equal(tokens(informant), 1)
  assert.equal(tokens('h0'), 0, 'not on itself')
  // Alone, nothing to give
  let alone = table({ hand0: ['herald'] })
  alone = act(alone, 0, { type: 'play', card: 'h0' })
  assert.ok(!alone.prompt, 'no question')
})

test('Landsraad Double Agent: Saboteur, and a Spy token when played', () => {
  let state = table({ hand0: ['doubleAgent'] })
  state = settle(act(state, 0, { type: 'play', card: 'h0' }))
  const agent = state.players[0].units.find((u) => u.def === 'doubleAgent')!
  assert.equal(keywordsOf(state, agent).saboteur, true)
  assert.equal(state.players[0].units.filter((u) => state.defs[u.def].name === 'Spy').length, 1)
})

test('Residency Informant: Saboteur while you control a Spice token', () => {
  const state = table({ units0: ['informant'] })
  const informant = state.players[0].units[0]
  assert.ok(state.players[0].spice.length > 0)
  assert.equal(keywordsOf(state, informant).saboteur, true, 'the Arrakis Spice token')
  state.players[0].spice = []
  assert.ok(!keywordsOf(state, informant).saboteur, 'no Spice token, no Saboteur')
})

test('Count Hasimir Fenring: a Spice token for a Spy token; deployed, a Spy token on attack', () => {
  const spies = (st: GameState) => st.players[0].units.filter((u) => st.defs[u.def].name === 'Spy').length
  let state = table({})
  state.players[0].leader.def = 'fenringLeader'
  const action = legalActions(state, 0).find((a) => a.type === 'ability' && a.source === 'leader')!
  assert.ok(action)
  state = settle(act(state, 0, action))
  assert.equal(spies(state), 1)
  assert.equal(state.players[0].spice.length, 0)
  assert.ok(!legalActions(state, 0).some((a) => a.type === 'ability' && a.source === 'leader'), 'no Spice token, no Action')
  state = table({ units1: ['trooper'] })
  state.players[0].leader.def = 'fenringLeader'
  state = settle(act(state, 0, { type: 'deploy' }))
  const fenring = state.players[0].units.find((u) => u.leader)!
  fenring.exhausted = false
  state.active = 0
  state = settle(act(state, 0, { type: 'attack', attacker: fenring.id, target: 'base' }))
  assert.equal(spies(state), 1)
})

test('Imperial Spy: the AI leaves a weak card on top of their deck, and discards a strong one', () => {
  const top = (def: string, resources: number) => {
    let state = table({ hand0: ['imperialSpy'] })
    state.players[1].deck.unshift({ id: 'top', def })
    state.players[1].resources = state.players[1].resources.slice(0, 1)
    while (state.players[1].resources.length < resources) state.players[1].resources.push({ card: { id: `r${state.players[1].resources.length}`, def: 'trooper' }, exhausted: false })
    state = act(state, 0, { type: 'play', card: 'h0' })
    // What the AI answers
    while (state.prompt) state = answer(state, state.prompt.ai ?? state.prompt.options[0].id)
    return state.players[1].deck[0]?.id === 'top'
  }
  assert.equal(top('trooper', 5), true, 'a 2-cost card late: left on top')
  assert.equal(top('big', 5), false, 'a dear card: gone')
})

test("Count Hasimir Fenring, The Emperor's Blade: a Spy token when played", () => {
  let state = table({ hand0: ['blade'] })
  state = settle(act(state, 0, { type: 'play', card: 'h0' }))
  assert.equal(state.players[0].units.filter((u) => state.defs[u.def].name === 'Spy').length, 1)
})

test('A Web of Spies: a ready Spy token for each friendly Spy unit, not counting Spy tokens', () => {
  const spyTokens = (st: GameState) => st.players[0].units.filter((u) => st.defs[u.def].token && st.defs[u.def].name === 'Spy')
  let state = table({ hand0: ['webOfSpies'], units0: ['informant', 'imperialSpy', 'trooper'] })
  state.players[0].resources.forEach((r) => (r.exhausted = false))
  while (state.players[0].resources.length < 8) state.players[0].resources.push({ card: { id: `r${state.players[0].resources.length}`, def: 'trooper' }, exhausted: false })
  // Two Spy tokens already: not counted
  state = act(state, 0, { type: 'play', card: 'h0' })
  state = settle(state)
  assert.equal(spyTokens(state).length, 2, 'the Informant and the Imperial Spy')
  assert.ok(spyTokens(state).every((u) => !u.exhausted), 'ready')
  assert.ok(spyTokens(state).every((u) => state.defs[u.def].traits.includes('Spy')), 'DUNE Spy tokens are Spies')
  state.players[0].hand.push({ id: 'h9', def: 'webOfSpies' })
  state.players[0].resources.forEach((r) => (r.exhausted = false))
  state.active = 0
  state = settle(act(state, 0, { type: 'play', card: 'h9' }))
  assert.equal(spyTokens(state).length, 4, 'still 2 more, the tokens not counted')
})

test('Forged Imperial Writ: +1/+1 and Saboteur; a Spy token only when it goes on a Spy', () => {
  const spies = (st: GameState) => st.players[0].units.filter((u) => st.defs[u.def].token && st.defs[u.def].name === 'Spy').length
  let state = table({ hand0: ['writ'], units0: ['trooper'] })
  state = settle(act(state, 0, { type: 'play', card: 'h0', attachTo: 'u00' }))
  const trooper = state.players[0].units.find((u) => u.id === 'u00')!
  assert.equal(keywordsOf(state, trooper).saboteur, true)
  assert.equal(hpOf(state, trooper), 3)
  assert.equal(spies(state), 0, 'not a Spy: no token')
  let spy = table({ hand0: ['writ'], units0: ['informant'] })
  spy = settle(act(spy, 0, { type: 'play', card: 'h0', attachTo: 'u00' }))
  assert.equal(spies(spy), 1, 'on a Spy: a Spy token')
})

test('the AI puts the Forged Imperial Writ on a Spy', () => {
  const state = table({ hand0: ['writ'], units0: ['trooper', 'informant'] })
  state.players[0].resources.forEach((r) => (r.exhausted = false))
  const why: { action: Action; gain: number }[] = []
  chooseAction(state, 0, why)
  const on = (id: string) => why.find((w) => w.action.type === 'play' && w.action.attachTo === id)?.gain ?? -Infinity
  assert.ok(on('u01') > on('u00'), `the Informant ${on('u01')}, the Trooper ${on('u00')}`)
})

test('Caladan Escort Frigate: an Experience token to another friendly unit when played and on attack', () => {
  let state = table({ hand0: ['escortFrigate'], units0: ['big'] })
  state = settle(act(state, 0, { type: 'play', card: 'h0' }))
  assert.equal(state.players[0].units[0].upgrades.length, 1, 'when played')
  const frigate = state.players[0].units.find((u) => u.def === 'escortFrigate')!
  frigate.exhausted = false
  state.active = 0
  state = settle(act(state, 0, { type: 'attack', attacker: frigate.id, target: 'base' }))
  assert.equal(state.players[0].units[0].upgrades.length, 2, 'on attack')
})

test('Sietch Tabr Elder: heals 3 from your base when played, and a Fremen token the first time your base is healed each round', () => {
  let state = table({ hand0: ['tabrElder'], units0: ['restorer'] })
  state.players[0].base.damage = 10
  state = settle(act(state, 0, { type: 'play', card: 'h0' }))
  assert.equal(state.players[0].base.damage, 7)
  const fremen = () => state.players[0].units.filter((u) => state.defs[u.def].token).length
  assert.equal(fremen(), 1, 'its own heal makes a token')
  state.active = 0
  state = settle(act(state, 0, { type: 'attack', attacker: 'u00', target: 'base' }))
  assert.equal(state.players[0].base.damage, 5, 'Restore 2')
  assert.equal(fremen(), 1, 'once each round')
})

test('Sietch Tabr Elder: no token when nothing is healed', () => {
  let state = table({ hand0: ['tabrElder'] })
  state = settle(act(state, 0, { type: 'play', card: 'h0' }))
  assert.equal(state.players[0].units.filter((u) => state.defs[u.def].token).length, 0)
})

test("Smuggler's Spice Barge: a Spice token when played and on attack", () => {
  let state = table({ hand0: ['spiceBarge'] })
  const spice = state.players[0].spice.length
  state = settle(act(state, 0, { type: 'play', card: 'h0' }))
  assert.equal(state.players[0].spice.length, spice + 1)
  const barge = state.players[0].units[0]
  barge.exhausted = false
  state.active = 0
  state = settle(act(state, 0, { type: 'attack', attacker: barge.id, target: 'base' }))
  assert.equal(state.players[0].spice.length, spice + 2)
})

test('Turned Asset: a friendly Spy defeated, it takes control of an enemy non-leader unit that costs 3 or less', () => {
  let state = table({ hand0: ['turnedAsset'], units0: ['spyToken'], units1: ['big', 'soldier'] })
  state = act(state, 0, { type: 'play', card: 'h0' })
  assert.deepEqual(state.prompt!.options.map((o) => o.id).sort(), ['h0', 'u00'], 'the token or itself')
  state = answer(state, 'u00')
  assert.deepEqual(state.prompt!.options.map((o) => o.id), ['u11'], 'only the one that costs 3 or less')
  state = settle(answer(state, 'u11'))
  assert.ok(state.players[0].units.some((u) => u.def === 'soldier'), 'taken')
  assert.equal(state.players[1].units.length, 1)
  assert.ok(!state.players[0].units.some((u) => u.def === 'spyToken'), 'the Spy token defeated')
})

test('Turned Asset: the AI gives up its Spy token for the enemy unit', () => {
  let state = table({ hand0: ['turnedAsset'], units0: ['spyToken'], units1: ['soldier'] })
  state = settle(act(state, 0, { type: 'play', card: 'h0' }))
  assert.ok(state.players[0].units.some((u) => u.def === 'soldier'))
  assert.ok(state.players[0].units.some((u) => u.def === 'turnedAsset'), 'not itself')
})

test('Plot: a Plot card that replaces one played cannot be played in the same deploy (7.5.19d)', () => {
  let state = table({ deck0: ['plotter', 'big'] })
  state.players[0].resources[0].card = { id: 'pl', def: 'plotter' }
  state = act(state, 0, { type: 'deploy' })
  state = answer(state, 'pl')
  state = answer(state, 'pl')
  assert.equal(state.players[0].resources[0].card.def, 'plotter', 'the replacement has Plot')
  assert.ok(!state.prompt?.options.some((o) => o.id === state.players[0].resources[0].card.id))
})
