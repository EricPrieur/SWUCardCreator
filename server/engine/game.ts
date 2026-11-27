import {
  IllegalAction,
  type Action,
  type Aspect,
  type CardDef,
  type Effect,
  type GameState,
  type Inst,
  type Keywords,
  type PlayerId,
  type PlayerState,
  type Printing,
  type Prompt,
  type UnitState,
} from './types.ts'
import { builtInTokens } from './cards.ts'
import { abilitiesOf, type Abilities, type Ability, type Grant, type Self } from './scripts.ts'

// Rule numbers below are those of the Comprehensive Rules v9.0

const HAND_SIZE = 6
const EMPTY_DECK_DAMAGE = 3

// printings: how each card of deck looks, in the same order; null or left out, plain
export type DeckList = { name: string; leader: string; base: string; deck: string[]; printings?: (Printing | null)[] }

// A seeded random number generator (mulberry32) whose state lives in the game, so a game is
// replayed exactly from its seed and its actions
function random(state: GameState) {
  state.rng = (state.rng + 0x6d2b79f5) | 0
  let t = state.rng
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

function shuffle<T>(state: GameState, list: T[]) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(random(state) * (i + 1))
    ;[list[i], list[j]] = [list[j], list[i]]
  }
}

export const other = (p: PlayerId): PlayerId => (p === 0 ? 1 : 0)
const def = (state: GameState, inst: { def: string }) => state.defs[inst.def]
const log = (state: GameState, text: string, player?: PlayerId, card?: string) => state.log.push(card ? { player, text, card } : { player, text })
const nameOf = (state: GameState, inst: { def: string }) => def(state, inst).name
// A base, as a prompt or an ability names it
export const baseId = (p: PlayerId) => `base${p}`
const baseOwner = (id: string): PlayerId | undefined => (id === 'base0' ? 0 : id === 'base1' ? 1 : undefined)
// The Fortifications on a player's base
export const baseUpgrades = (state: GameState, p: PlayerId) => (state.players[p].base.upgrades ??= [])

// Damage to a player's base, counted as one more time it was dealt damage this phase
export function hitBase(state: GameState, p: PlayerId, amount: number) {
  if (amount <= 0) return
  const base = state.players[p].base
  base.damage += amount
  if (base.hitPhase !== state.phaseCount) base.hits = 0
  base.hitPhase = state.phaseCount
  base.hits = (base.hits ?? 0) + 1
}
// How many times a player's base was dealt damage this phase
export const baseHits = (state: GameState, p: PlayerId) => (state.players[p].base.hitPhase === state.phaseCount ? state.players[p].base.hits ?? 0 : 0)

// 5.2: bases and leaders in play, a random player chosen to decide who starts with the
// initiative; then, actions of their own, that choice, the 6 cards drawn, the mulligans and the
// 2 resources
export function createGame(options: { seed: number; decks: [DeckList, DeckList]; defs: CardDef[] }): GameState {
  // The set's own tokens, or the official ones
  const tokens = builtInTokens.filter((t) => !options.defs.some((d) => d.token && d.name === t.name))
  const defs = Object.fromEntries([...options.defs, ...tokens].map((d) => [d.id, d]))
  const state: GameState = {
    rng: options.seed | 0,
    round: 1,
    phase: 'first',
    phaseCount: 0,
    active: 0,
    initiative: 0,
    initiativeTaken: false,
    chooser: 0,
    passes: 0,
    players: [] as unknown as [PlayerState, PlayerState],
    defs,
    nextId: 1,
    log: [],
    winner: null,
    effects: [],
    usedThisRound: [],
    discounts: [],
    banned: [],
    awakened: [],
    defeatedThisPhase: [],
    fallen: [],
    borrowed: [],
    doomed: [],
    held: [],
    attack: null,
    revealed: [null, null],
    prompt: null,
    pending: null,
  }
  options.decks.forEach((list, p) => {
    for (const id of [list.leader, list.base, ...list.deck]) if (!defs[id]) throw new Error(`Unknown card ${id}`)
    const deck = list.deck.map((id) => ({ id: `c${state.nextId++}`, def: id }))
    list.printings?.forEach((printing, i) => {
      if (printing && deck[i]) (state.printings ??= {})[deck[i].id] = printing
    })
    shuffle(state, deck)
    state.players[p] = {
      name: list.name,
      leader: { def: list.leader, deployed: false, exhausted: false, epicUsed: false },
      base: { def: list.base, damage: 0, upgrades: [] },
      deck,
      hand: [],
      discard: [],
      resources: [],
      units: [],
      spice: [],
      mulliganDone: false,
      setupResourced: false,
      regroupDone: false,
      passedForPhase: false,
      drawn: 0,
    }
  })
  // A base (an Arrakis base) or a leader that starts the game with Spice tokens
  for (const p of [0, 1] as const) {
    const { base, leader } = state.players[p]
    const start = (def(state, base).startSpice ?? 0) + (def(state, leader).startSpice ?? 0)
    if (start) createSpice(state, p, start)
  }
  state.chooser = random(state) < 0.5 ? 0 : 1
  state.initiative = state.active = state.chooser
  log(state, `${state.players[state.chooser].name} decides who goes first`, state.chooser)
  return state
}

// Who has to act now: whoever a question waits on; the active player in the action phase;
// during setup and regroup, whoever still has a choice to make (both at once while choosing
// the setup resources)
export function waitingFor(state: GameState): PlayerId[] {
  if (state.prompt) return [state.prompt.player]
  const [a, b] = [state.initiative, other(state.initiative)]
  const pending = (done: (p: PlayerState) => boolean) => [a, b].filter((p) => !done(state.players[p]))
  switch (state.phase) {
    case 'first':
      return [state.chooser]
    // 5.2.1e: the player with the initiative decides first
    case 'mulligan':
      return pending((p) => p.mulliganDone).slice(0, 1)
    case 'resource':
      return pending((p) => p.setupResourced)
    // 5.5.1c: starting with the active player, who is the one with the initiative (1.2.5)
    case 'regroup':
      return pending((p) => p.regroupDone).slice(0, 1)
    case 'action':
      return [state.active]
    default:
      return []
  }
}

// --- Card values in play ---

// 8.1: 2 more for each aspect icon the leader and base don't provide
export function aspectPenalty(state: GameState, p: PlayerId, card: CardDef) {
  const player = state.players[p]
  // A unit whose upgrade has it provide its aspect icons while paying costs (The Darksaber)
  const lent = player.units.filter((u) => u.upgrades.some((x) => /this unit provides its aspect icons/i.test(def(state, x).text ?? ''))).flatMap((u) => def(state, u).aspects)
  const provided = [...def(state, player.leader).aspects, ...def(state, player.base).aspects, ...lent]
  const count = (list: Aspect[], aspect: Aspect) => list.filter((a) => a === aspect).length
  const missing = [...new Set(card.aspects)].reduce(
    (sum, aspect) => sum + Math.max(0, count(card.aspects, aspect) - count(provided, aspect)),
    0,
  )
  return missing * 2
}

export const playCost = (state: GameState, p: PlayerId, card: CardDef) => card.cost + aspectPenalty(state, p, card)
export const smuggleCost = (state: GameState, p: PlayerId, card: CardDef) =>
  (card.keywords.smuggle ?? 0) + aspectPenalty(state, p, card)

export const controlsArrakis = (state: GameState, p: PlayerId) =>
  def(state, state.players[p].base).traits.includes('Arrakis')

// Keywords added to those a unit has; numbered ones stack (7.5.4)
function addKeywords(keywords: Keywords, gained: Keywords | undefined) {
  for (const [name, value] of Object.entries(gained ?? {}) as [keyof Keywords, number | boolean][]) {
    if (typeof value === 'number') (keywords[name] as number) = ((keywords[name] as number) ?? 0) + value
    else (keywords[name] as boolean) = true
  }
}

const effectsOn = (state: GameState, unit: UnitState) => state.effects.filter((e) => e.unit === unit.id)

// What the cards in play give a unit: those on its side, and those on the other side that
// give enemy units something (each script says whom it gives to)
// While grants are worked out, a unit's traits are its printed ones: a grant can't depend on another
let granting = false
function grantsTo(state: GameState, unit: UnitState): Grant[] {
  if (granting) return []
  const g = new Game(state)
  granting = true
  try {
    return [...holders(state, 0), ...holders(state, 1)].flatMap(({ self, abilities }) => abilities.gives?.(g, self, unit) ?? [])
  } finally {
    granting = false
  }
}

// Its printed traits, and those it gains
export function traitsOf(state: GameState, unit: UnitState) {
  const gained = [...grantsTo(state, unit), ...effectsOn(state, unit)].flatMap((grant) => grant.traits ?? [])
  const all = [...new Set([...def(state, unit).traits, ...gained])]
  return state.lostTraits?.length ? all.filter((t) => !traitLost(state, unit.owner, t)) : all
}
// "Enemy cards, including those not in play, lose that [Trait] for this phase." (The First Legion)
export const traitLost = (state: GameState, owner: PlayerId | undefined, trait: string) =>
  owner !== undefined && !!state.lostTraits?.some((l) => l.owner === owner && l.trait === trait && l.phase === state.phaseCount)

// Printed keywords; those gained with an Arrakis base, from upgrades, for a while, from other cards
export function keywordsOf(state: GameState, unit: UnitState): Keywords {
  const card = def(state, unit)
  const keywords: Keywords = blanked(state, unit) ? {} : { ...((unit.leader ? card.unit?.keywords : card.keywords) ?? {}) }
  const gained = unit.leader ? card.unit?.arrakisKeywords : card.arrakisKeywords
  if (gained && controlsArrakis(state, controllerOf(state, unit))) addKeywords(keywords, gained)
  for (const upgrade of unit.upgrades) addKeywords(keywords, def(state, upgrade).attachedKeywords)
  for (const effect of effectsOn(state, unit)) addKeywords(keywords, effect.keywords)
  const grants = grantsTo(state, unit)
  for (const grant of grants) addKeywords(keywords, grant.keywords)
  // Lost, whatever gives them (Captain Aramsham)
  for (const grant of grants) for (const name of grant.loses ?? []) delete keywords[name]
  // Lost for a while (Guild Bribe's Sentinel)
  for (const effect of effectsOn(state, unit)) for (const name of effect.loses ?? []) delete keywords[name]
  return keywords
}

// An upgrade's printed modifiers; a unit card attached as an upgrade (Ramallo), those printed on
// its upgrade box
const modifier = (state: GameState, upgrade: Inst, stat: 'power' | 'hp') => {
  const card = def(state, upgrade)
  if (card.type === 'leader') return card.unit?.pilot?.[stat] ?? 0
  return card.type === 'upgrade' ? card[stat] : (card.upgrade?.[stat] ?? 0)
}

// --- Pilots (7.5.17, 3.4.4a) ---

// A unit or leader card attached as an upgrade: a pilot. Its Piloting box's abilities are its own then.
const isCardAsUpgrade = (card: CardDef) => card.type === 'unit' || card.type === 'leader'
const upgradeScript = (state: GameState, upgrade: Inst) => scriptOf(state, upgrade, isCardAsUpgrade(def(state, upgrade)) ? 'pilot' : 'front')
// A Pilot on it: a card attached using Piloting, or an upgrade with the Pilot trait
const pilotsOn = (state: GameState, unit: UnitState) =>
  unit.upgrades.filter((u) => isCardAsUpgrade(def(state, u)) || def(state, u).traits.includes('Pilot')).length
// Where a pilot may go: a friendly Vehicle unit with room for one more Pilot (1, or what it says)
export const canPilot = (state: GameState, p: PlayerId, unit: UnitState) =>
  controllerOf(state, unit) === p && traitsOf(state, unit).includes('Vehicle') && pilotsOn(state, unit) < (unitScript(state, unit).pilots ?? 1)
// A leader unit for every "leader" and "non-leader" (3.4.7): the leader's own, or one a pilot
// leader is attached to ("Attached unit is a leader unit.")
export const isLeaderUnit = (state: GameState, unit: UnitState) => !!unit.leader || unit.upgrades.some((u) => !!def(state, u).makesLeader)

export function hpOf(state: GameState, unit: UnitState) {
  const card = def(state, unit)
  const printed = unit.leader ? (card.unit?.hp ?? 0) : card.hp
  return (
    printed +
    unit.upgrades.reduce((sum, u) => sum + modifier(state, u, 'hp'), 0) +
    effectsOn(state, unit).reduce((sum, e) => sum + e.hp, 0) +
    grantsTo(state, unit).reduce((sum, grant) => sum + (grant.hp ?? 0), 0)
  )
}

// Hidden (7.5.18): a unit with it can't be attacked the phase it entered play
export const isHidden = (state: GameState, unit: UnitState) => !!keywordsOf(state, unit).hidden && unit.entered === state.phaseCount

// Grit (7.5.6): +1/+0 for each damage on it; Raid (7.5.8): +N/+0 while attacking
export function powerOf(state: GameState, unit: UnitState, attacking = false) {
  const card = def(state, unit)
  const keywords = keywordsOf(state, unit)
  const printed = unit.leader ? (card.unit?.power ?? 0) : card.power
  return Math.max(
    0,
    printed +
      unit.upgrades.reduce((sum, u) => sum + modifier(state, u, 'power'), 0) +
      effectsOn(state, unit).reduce((sum, e) => sum + e.power, 0) +
      grantsTo(state, unit).reduce((sum, grant) => sum + (grant.power ?? 0), 0) +
      (keywords.grit ? unit.damage : 0) +
      (attacking ? (keywords.raid ?? 0) : 0),
  )
}

// What a player can pay now: its ready resources and its Credit tokens
const readyResources = (player: PlayerState) => player.resources.filter((r) => !r.exhausted).length + (player.credits?.length ?? 0)

// Resources first, then Credit tokens for what they can't pay; or Credit tokens first
// (creditsFirst: the player's choice, keeping resources ready)
function pay(state: GameState, p: PlayerId, amount: number, creditsFirst = false) {
  const player = state.players[p]
  const spend = (n: number) => {
    for (let i = 0; i < n && player.credits?.length; i++) defeatCredit(state, p)
    return n
  }
  if (creditsFirst) amount -= spend(Math.min(amount, player.credits?.length ?? 0))
  for (const resource of player.resources) {
    if (amount <= 0) break
    if (!resource.exhausted) {
      resource.exhausted = true
      amount--
    }
  }
  if (amount > 0) spend(amount)
}

function createCredit(state: GameState, p: PlayerId, count = 1) {
  const credit = tokenDef(state, 'Credit')
  if (!credit || count <= 0) return
  const player = state.players[p]
  player.credits ??= []
  for (let i = 0; i < count; i++) player.credits.push({ id: `c${state.nextId++}`, def: credit.id })
  log(state, `${player.name} creates ${count === 1 ? 'a Credit token' : `${count} Credit tokens`}`, p)
}
// A player's Credit token, the one named or any, defeated: gone from the game
function defeatCredit(state: GameState, owner: PlayerId, id?: string, by: PlayerId = owner) {
  const player = state.players[owner]
  const token = player.credits?.find((t) => id === undefined || t.id === id)
  if (!token) return false
  player.credits = player.credits!.filter((t) => t !== token)
  log(state, `${state.players[by].name} defeats ${by === owner ? 'a' : `${player.name}'s`} Credit token`, by)
  return true
}

function findUnit(state: GameState, id: string) {
  for (const p of [0, 1] as const) {
    const unit = state.players[p].units.find((u) => u.id === id)
    if (unit) return unit
  }
  return undefined
}

const controllerOf = (state: GameState, unit: UnitState): PlayerId => (state.players[0].units.includes(unit) ? 0 : 1)

// --- Tokens (3.7) ---

const tokenDef = (state: GameState, name: string) =>
  Object.values(state.defs).find((d) => d.token && d.name === name) as CardDef

// "Until the end of the round, Spice tokens can't be created and bases can't be healed."
export const spiceLocked = (state: GameState) => state.spiceLock === state.round

function createSpice(state: GameState, p: PlayerId, count = 1) {
  if (spiceLocked(state)) {
    log(state, `${state.players[p].name} can't create Spice tokens this round`, p)
    return
  }
  const spice = tokenDef(state, 'Spice')
  // "you may create 2 Spice tokens instead" (Carthag Refinery): one more each time it is used
  if (current) for (const { self, abilities } of holders(state, p)) if (abilities.moreSpice?.(new Game(state, p), self)) count++
  for (let i = 0; i < count; i++) state.players[p].spice.push({ id: `s${state.nextId++}`, def: spice.id })
  log(state, `${state.players[p].name} creates ${count === 1 ? 'a Spice token' : `${count} Spice tokens`}`, p)
}

// A player's Spice token, the one named or any, defeated by a player: gone from the game
function defeatSpice(state: GameState, owner: PlayerId, id?: string, by: PlayerId = owner) {
  const player = state.players[owner]
  const token = player.spice.find((t) => id === undefined || t.id === id)
  if (!token) return false
  player.spice = player.spice.filter((t) => t !== token)
  log(state, `${state.players[by].name} defeats ${by === owner ? 'a' : `${player.name}'s`} Spice token`, by)
  for (const p of [0, 1] as const) trigger(state, p, 'whenSpiceDefeated', { spice: { owner, by } })
  return true
}

// A token unit enters play exhausted, like any unit (3.5.3)
function createUnitToken(state: GameState, p: PlayerId, name: string) {
  const token = tokenDef(state, name)
  const unit: UnitState = {
    id: `t${state.nextId++}`,
    def: token.id,
    owner: p,
    arena: token.arena ?? 'ground',
    damage: 0,
    exhausted: true,
    upgrades: [],
    entered: state.phaseCount,
  }
  state.players[p].units.push(unit)
  log(state, `${state.players[p].name} creates a ${name} token`, p)
  queueShielded(state, p, unit)
  queueAmbush(state, p, unit)
  trigger(state, p, 'whenYouCreate', { other: unit.id, otherDef: token }, unit.id)
  return unit
}

// attached: whether this token counts as upgrades attaching (false for the 2nd and 3rd of 3 at once)
function giveToken(state: GameState, unit: UnitState, name: string, attached = true) {
  const token = tokenDef(state, name)
  // A community card's token (Ink) not in the game: its card isn't supported
  if (!token) return
  const id = `k${state.nextId++}`
  unit.upgrades.push({ id, def: token.id, owner: controllerOf(state, unit) })
  log(state, `${nameOf(state, unit)} gets ${/^[AEIOU]/.test(name) ? 'an' : 'a'} ${name} token`, controllerOf(state, unit))
  if (attached) upgradeAttached(state, unit, id)
}

// "When 1 or more upgrades attach to this unit:" (Sabine Wren): once for each time, several
// given by one ability (3 Advantage tokens) once in all. Her Shield token from Shielded and an
// Advantage token from Greef Karga are two.
function upgradeAttached(state: GameState, unit: UnitState, upgradeId: string) {
  const p = controllerOf(state, unit)
  queue(state, p, nameOf(state, unit), 'upgrade attached', unitScript(state, unit).whenUpgradeAttached, {
    id: unit.id,
    controller: p,
    def: def(state, unit),
    other: upgradeId,
  })
}

// Advantage tokens (ASH): "When attached unit's attack or defense ends: Defeat this upgrade."
function endAdvantage(state: GameState, unitId: string) {
  const unit = findUnit(state, unitId)
  if (!unit) return
  const tokens = unit.upgrades.filter((u) => def(state, u).token && def(state, u).name === 'Advantage')
  if (!tokens.length) return
  unit.upgrades = unit.upgrades.filter((u) => !tokens.includes(u))
  log(state, `${nameOf(state, unit)}'s Advantage token${tokens.length > 1 ? 's are' : ' is'} defeated`, controllerOf(state, unit))
  checkDefeats(state)
}

// Damage to a unit, unless a Shield token on it prevents it and is defeated instead, one Shield
// for each time damage is dealt (3.7.6): the damage dealt
function damageUnit(state: GameState, unit: UnitState, amount: number, combat = false, unpreventable = false) {
  if (amount <= 0) return 0
  // Indirect damage (8.35.2): no Shield token or ability prevents it, the tokens left as they are
  if (unpreventable) {
    unit.damage += amount
    const p = controllerOf(state, unit)
    trigger(state, p, 'whenFriendlyDamaged', { other: unit.id }, unit.id)
    queue(state, p, nameOf(state, unit), 'when dealt damage', unitScript(state, unit).whenDealtDamage, { id: unit.id, controller: p, def: def(state, unit) })
    return amount
  }
  const shield = shieldOn(state, unit)
  if (shield) {
    unit.upgrades = unit.upgrades.filter((u) => u !== shield)
    log(state, `A Shield token prevents the damage to ${nameOf(state, unit)}`, controllerOf(state, unit))
    shieldDefeated(state, unit)
    return 0
  }
  // "If damage would be dealt to another friendly [Emperor] unit, you may defeat a Shield token on
  // this unit. If you do, prevent that damage."
  const p = controllerOf(state, unit)
  for (const { self, abilities } of holders(state, p)) {
    const guard = findUnit(state, self.id)
    const spare = guard && guard !== unit && shieldOn(state, guard)
    if (!guard || !spare || !abilities.sharesShield?.(new Game(state, p), self, unit)) continue
    const yes = new Game(state, p).may(p, `${nameOf(state, guard)}: defeat a Shield token on it to prevent ${amount} damage to ${nameOf(state, unit)}?`, {
      source: guard.def,
      // The AI spends it on damage that would defeat the unit, or on 2 or more
      ai: amount >= 2 || unit.damage + amount >= hpOf(state, unit),
    })
    if (!yes) continue
    guard.upgrades = guard.upgrades.filter((u) => u !== spare)
    log(state, `${nameOf(state, guard)}'s Shield token prevents the damage to ${nameOf(state, unit)}`, p)
    shieldDefeated(state, guard)
    return 0
  }
  // "If damage would be dealt to this unit, you may … If you do, prevent that damage." (Queen Amidala)
  const own = unitScript(state, unit).preventsDamage
  if (own && own(new Game(state, p), { id: unit.id, controller: p, def: def(state, unit) }, amount)) return 0
  // Combat damage an upgrade on it changes (Ink: plus 1, then the token is defeated)
  if (combat)
    for (const upgrade of [...unit.upgrades]) {
      const change = upgradeScript(state, upgrade).attachedCombatDamage
      if (!change) continue
      const owner = upgrade.owner
      amount = change(new Game(state, owner), { id: upgrade.id, controller: owner, def: def(state, upgrade), attachedTo: unit.id }, amount)
    }
  unit.damage += amount
  // "When another friendly unit … is dealt damage:" (Logray)
  if (amount > 0) trigger(state, p, 'whenFriendlyDamaged', { other: unit.id }, unit.id)
  // "When this unit is dealt damage and survives:": the script checks it survived as it resolves
  if (amount > 0) queue(state, p, nameOf(state, unit), 'when dealt damage', unitScript(state, unit).whenDealtDamage, { id: unit.id, controller: p, def: def(state, unit) })
  return amount
}

const shieldOn = (state: GameState, unit: UnitState) => unit.upgrades.find((u) => def(state, u).token && def(state, u).name === 'Shield')

// "When a Shield token on this unit is defeated:"
function shieldDefeated(state: GameState, unit: UnitState) {
  const p = controllerOf(state, unit)
  queue(state, p, nameOf(state, unit), 'a Shield token on it is defeated', unitScript(state, unit).whenShieldDefeated, { id: unit.id, controller: p, def: def(state, unit) })
}

// An upgrade leaving play: to its owner's discard pile, a token set aside (3.7.3)
function discardUpgrade(state: GameState, upgrade: Inst & { owner: PlayerId }) {
  state.effects = state.effects.filter((e) => e.source !== upgrade.id)
  // A pilot leader: back to its base zone, exhausted (3.4.5)
  if (def(state, upgrade).type === 'leader') {
    const leader = state.players[upgrade.owner].leader
    leader.deployed = false
    leader.exhausted = true
    return
  }
  if (!def(state, upgrade).token) state.players[upgrade.owner].discard.push({ id: upgrade.id, def: upgrade.def })
}

// Exhausting a unit, which an upgrade on it may wait for (Gom Jabbar)
function exhaustUnit(state: GameState, unit: UnitState) {
  if (unit.exhausted) return
  unit.exhausted = true
  const p = controllerOf(state, unit)
  for (const upgrade of unit.upgrades)
    queue(state, p, nameOf(state, upgrade), 'attached unit exhausted', upgradeScript(state, upgrade).whenAttachedExhausted, {
      id: upgrade.id,
      controller: p,
      def: def(state, upgrade),
      attachedTo: unit.id,
    })
}

// --- Resolving abilities: questions and triggers ---

// An ability asked something that has no answer yet: the action stops here, to be played
// again from its start once the question is answered (see Pending)
class Pause extends Error {
  prompt: Prompt
  constructor(prompt: Prompt) {
    super('Waiting for an answer')
    this.prompt = prompt
  }
}

// A triggered ability waiting to resolve
// \`same\`: the ability and the card it is on, which tells one ability triggered twice (Chani's, once
// for the card played and once for each token created) from two that need an order
// last: an ability that counts what happened this phase (Fedaykin Strike Leader), which the AI
// resolves after the others
// later: whether the AI resolves it after the others, asked as it orders them (Abilities.aiLater)
type Trigger = { player: PlayerId; label: string; run: () => void; same?: unknown[]; last?: boolean; later?: () => boolean; automatic?: boolean }

// The action being played: the answers it has, the next to hand out, the abilities triggered.
// One action at a time, start to end in one go, so it can live outside the game state.
type Run = { answers: string[][]; next: number; queue: Trigger[] }
let current: Run | null = null

function ask(prompt: Prompt): string[] {
  const run = current as Run
  if (run.next < run.answers.length) return run.answers[run.next++]
  throw new Pause(prompt)
}

// Outside an action (as the game is set up) nothing triggers. Labelled with the card and its
// trigger: a card with two abilities waiting (a leader and its unit, say) is told apart
function queue(state: GameState, player: PlayerId, source: string, what: string, ability: Ability | undefined, self: Self, later?: (g: Game, self: Self) => boolean, automatic?: boolean) {
  if (!ability || !current) return
  const last = /this phase/.test(self.def.text ?? '') && /for each time/.test(self.def.text ?? '')
  current.queue.push({
    player,
    label: `${source}: ${what}`,
    run: () => ability(new Game(state, player), self),
    same: [ability, self.id],
    last,
    ...(later && { later: () => later(new Game(state, player), self) }),
    ...(automatic && { automatic }),
  })
}

// The abilities a card has where it is: a unit's, a leader's unit side's once deployed, a
// leader side's
function scriptOf(state: GameState, inst: { def: string; id?: string }, side: 'front' | 'back' | 'pilot' = 'front'): Abilities {
  if (inst.id && blanked(state, inst as Inst)) return {}
  return abilitiesOf(def(state, inst), side)
}

// Whose card this is: a unit's or an upgrade's owner, else the player whose zone holds it
function ownerOfId(state: GameState, id: string): PlayerId | undefined {
  for (const p of [0, 1] as const) {
    const player = state.players[p]
    if ([...player.hand, ...player.deck, ...player.discard, ...player.resources.map((r) => r.card)].some((c) => c.id === id)) return p
  }
  for (const unit of [...state.players[0].units, ...state.players[1].units]) {
    if (unit.id === id) return unit.owner
    const upgrade = unit.upgrades.find((u) => u.id === id)
    if (upgrade) return upgrade.owner
  }
  return undefined
}
// A card named by an enemy Galen Erso while he is in play: it loses all abilities (not a leader)
export function blanked(state: GameState, inst: Inst) {
  if (!state.named?.length) return false
  const d = def(state, inst)
  if (d.type === 'leader' || (inst as UnitState).leader) return false
  for (const n of state.named) {
    if (n.name !== d.name) continue
    const by = findUnit(state, n.unit)
    if (!by) continue
    const owner = (inst as UnitState).owner ?? ownerOfId(state, inst.id)
    if (owner !== undefined && owner !== controllerOf(state, by)) return true
  }
  return false
}
const unitScript = (state: GameState, unit: UnitState) => scriptOf(state, unit, unit.leader ? 'back' : 'front')

// What has abilities on a player's side: their base, their leader's leader side until it
// deploys, their units and the upgrades on them, the Fortifications on their base
type Holder = { self: Self; abilities: Abilities }
function holders(state: GameState, p: PlayerId): Holder[] {
  const player = state.players[p]
  const list: Holder[] = [{ self: { id: baseId(p), controller: p, def: def(state, player.base) }, abilities: scriptOf(state, player.base) }]
  if (!player.leader.deployed)
    list.push({ self: { id: 'leader', controller: p, def: def(state, player.leader) }, abilities: scriptOf(state, player.leader) })
  for (const unit of player.units) {
    list.push({ self: { id: unit.id, controller: p, def: def(state, unit) }, abilities: unitScript(state, unit) })
    for (const upgrade of unit.upgrades)
      list.push({ self: { id: upgrade.id, controller: p, def: def(state, upgrade), attachedTo: unit.id }, abilities: upgradeScript(state, upgrade) })
  }
  for (const upgrade of player.base.upgrades ?? [])
    list.push({ self: { id: upgrade.id, controller: p, def: def(state, upgrade), attachedTo: baseId(p) }, abilities: scriptOf(state, upgrade) })
  return list
}

type Hook =
  | 'whenYouPlay'
  | 'whenYouCreate'
  | 'whenSpiceDefeated'
  | 'whenFriendlyDefeated'
  | 'whenEnemyDefeated'
  | 'whenFriendlyDamaged'
  | 'whenBaseHealed'
  | 'whenFriendlyAttacks'
  | 'whenFriendlyAttackEnds'
  | 'whenOpponentPlays'
  | 'whenEnemyAttacks'
  | 'whenCombatDamageBase'
  | 'regroupStart'
  | 'actionStart'

// The trigger as the card words it, "[When you play a [{Bene Gesserit}] card:]" read as "when you
// play a Bene Gesserit card"; a deployed leader's from its unit side
function triggerText(card: CardDef, deployed: boolean) {
  const text = (deployed && card.backText) || card.text
  const found = /\[(When (?:you|a|an) [^:]*?):\]/.exec(text ?? '')
  return found && found[1].replace(/\[\{([^}]*)\}\]/g, '$1').replace(/^When/, 'when')
}
const hookNames: Record<Hook, string> = {
  whenYouPlay: 'when you play a card',
  whenYouCreate: 'when you create a token',
  whenSpiceDefeated: 'when a Spice token is defeated',
  whenFriendlyDefeated: 'when a friendly unit is defeated',
  whenEnemyDefeated: 'when an enemy unit is defeated',
  whenFriendlyDamaged: 'when a friendly unit is dealt damage',
  whenBaseHealed: 'when damage is healed from your base',
  whenFriendlyAttacks: 'when a friendly unit attacks',
  whenFriendlyAttackEnds: "when a friendly unit's attack ends",
  whenOpponentPlays: 'when an opponent plays a card',
  whenEnemyAttacks: 'when an enemy unit attacks',
  whenCombatDamageBase: 'when combat damage is dealt to a base',
  regroupStart: 'start of the regroup phase',
  actionStart: 'start of the action phase',
}

// An event on a player's side, which the abilities there that wait for it resolve after
function trigger(state: GameState, p: PlayerId, hook: Hook, extra: Partial<Self> = {}, except?: string) {
  for (const { self, abilities } of holders(state, p)) {
    if (self.id === except) continue
    const triggered = { ...self, ...extra }
    if (abilities.triggersIf?.[hook]?.(new Game(state, p), triggered) === false) continue
    const what = triggerText(self.def, !!findUnit(state, self.id)?.leader) ?? hookNames[hook]
    const by = self.id === 'leader' ? ' (leader)' : ''
    queue(state, p, self.def.name + by, what, abilities[hook], triggered, abilities.aiLater?.[hook], !!abilities.automatic?.[hook])
  }
}

// "Use this ability only once each round"
const onceKey = (self: Self, name: string) => `${self.def.id}|${self.id}|${name}`

// Triggered abilities resolve once the step that triggered them is done: the active player's
// first (7.6.10), each player choosing the order of their own when they have more than one
function resolveTriggers(state: GameState) {
  const run = current as Run
  while (run.queue.length && state.phase !== 'over') {
    const ofActive = run.queue.filter((t) => t.player === state.active)
    const mine = ofActive.length ? ofActive : run.queue
    let next = mine.find((t) => t.automatic) ?? mine[0]
    // The same ability more than once (one for each Fremen token created) needs no order, nor
    // one with nothing to choose (it goes first)
    const same = (a: Trigger, b: Trigger) => a === b || (!!a.same && !!b.same && a.same.every((x, i) => x === b.same![i]))
    if (!next.automatic && mine.some((t) => !same(t, next))) {
      const [pick] = ask({
        player: next.player,
        kind: 'option',
        text: 'Choose the ability to resolve first',
        options: mine.map((t, i) => ({ id: String(i), label: t.label })),
        min: 1,
        max: 1,
        // The AI: the first that is neither "last" nor "later", else the first not "last"
        ai: String([mine.findIndex((t) => !t.last && !t.later?.()), mine.findIndex((t) => !t.last), 0].find((i) => i >= 0)),
      })
      next = mine[Number(pick)]
    }
    run.queue = run.queue.filter((t) => t !== next)
    next.run()
  }
}

// 1.12.4: defeated once its damage reaches its HP. A unit goes to its owner's discard pile with
// its upgrades; a leader unit flips back to its leader side, exhausted, and can't deploy again.
function checkDefeats(state: GameState) {
  // Again until none is left: a unit defeated may take another's HP with it (Sardaukar Burseg's
  // +1/+1, the smoke test found 2026-11-24: a Sardaukar Recruit checked before him stayed alive)
  for (let again = true; again; ) {
    again = false
    for (const p of [0, 1] as const)
      for (const unit of [...state.players[p].units])
        if (state.players[p].units.includes(unit) && unit.damage >= hpOf(state, unit)) {
          defeatUnit(state, unit)
          again = true
        }
  }
  // 5.6: the game ends the moment a base is defeated; both at once is a draw
  const lost = ([0, 1] as const).filter((p) => state.players[p].base.damage >= def(state, state.players[p].base).hp)
  if (lost.length && state.phase !== 'over') {
    state.phase = 'over'
    state.winner = lost.length === 2 ? 'draw' : other(lost[0])
    log(state, state.winner === 'draw' ? 'Both bases fall: a draw' : `${state.players[state.winner].name} wins`)
  }
}

// 8.30.3: a player controls one copy of a unique card (the same name and subtitle). With two in
// play, they choose the one to keep and the other is defeated at once, before any ability
// waiting to resolve (1.15.5b); abilities of either copy being played or defeated still resolve.
function checkUnique(state: GameState, p: PlayerId) {
  const player = state.players[p]
  const inPlay = [...player.units, ...player.units.flatMap((u) => u.upgrades), ...(player.base.upgrades ?? [])]
  const copies = new Map<string, string[]>()
  for (const card of inPlay) {
    const d = def(state, card)
    if (!d.unique || d.token) continue
    const key = `${d.name}|${d.subtitle ?? ''}`
    copies.set(key, [...(copies.get(key) ?? []), card.id])
  }
  for (const ids of copies.values()) {
    if (ids.length < 2) continue
    const g = new Game(state, p)
    const name = g.name(ids[0])
    const keep = g.chooseOne(p, `${name} is unique: choose the copy to keep (the one just played is the last in its row, its When Played still to come); the other is defeated`, ids, { ai: 'help' }) ?? ids[ids.length - 1]
    for (const id of ids) {
      if (id === keep) continue
      const unit = findUnit(state, id)
      if (unit) defeatUnit(state, unit)
      else g.defeatUpgrade(id)
    }
    log(state, `${player.name} keeps one ${name}: a player controls one copy of a unique card`, p)
  }
  checkDefeats(state)
}

// How the AI divides indirect damage to a player's side: dividing their own, all on the base
// unless that would defeat it, then on their cheapest units first; dividing an opponent's (Devastator,
// Hunting the Rebellion), on the units it defeats, the dearest for the damage first, the rest on
// the base
function indirectPlan(state: GameState, assigner: PlayerId, target: PlayerId, amount: number): Record<string, number> {
  const plan: Record<string, number> = {}
  const base = baseId(target)
  const units = state.players[target].units
  const left = (u: UnitState) => hpOf(state, u) - u.damage
  let rest = amount
  if (assigner === target) {
    const baseLeft = def(state, state.players[target].base).hp - state.players[target].base.damage
    const onBase = Math.min(rest, Math.max(0, baseLeft - 1))
    if (onBase) plan[base] = onBase
    rest -= onBase
    for (const u of [...units].sort((a, b) => def(state, a).cost - def(state, b).cost)) {
      if (rest <= 0) break
      const n = Math.min(rest, left(u))
      plan[u.id] = n
      rest -= n
    }
    if (rest > 0) plan[base] = (plan[base] ?? 0) + rest
    return plan
  }
  for (const u of [...units].sort((a, b) => (def(state, b).cost + (leaderUnit(b) ? 4 : 0)) / left(b) - (def(state, a).cost + (leaderUnit(a) ? 4 : 0)) / left(a))) {
    if (left(u) > rest) continue
    plan[u.id] = left(u)
    rest -= left(u)
  }
  if (rest > 0) plan[base] = rest
  return plan
}
const leaderUnit = (u: UnitState) => !!u.leader

// Rule 33.4: a unit leaving play rescues the cards it captured, each returned to play exhausted
// under its owner's control (it enters play, not played: no When Played)
function rescueAll(state: GameState, unit: UnitState) {
  for (const card of unit.captured ?? []) {
    const d = def(state, card)
    state.players[card.owner].units.push({ id: card.id, def: card.def, owner: card.owner, arena: d.arena ?? 'ground', damage: 0, exhausted: true, upgrades: [], entered: state.phaseCount })
    log(state, `${state.players[card.owner].name} rescues ${nameOf(state, card)}`, card.owner)
  }
  unit.captured = []
}

function defeatUnit(state: GameState, unit: UnitState) {
  const p = controllerOf(state, unit)
  const player = state.players[p]
  player.units = player.units.filter((u) => u !== unit)
  rescueAll(state, unit)
  state.effects = state.effects.filter((e) => e.unit !== unit.id)
  // What an upgrade gives the unit it is on: "Attached unit gains: [When Defeated:] …"
  for (const upgrade of unit.upgrades)
    queue(state, p, nameOf(state, upgrade), 'When Defeated', upgradeScript(state, upgrade).attachedWhenDefeated, {
      id: upgrade.id,
      controller: p,
      def: def(state, upgrade),
      attachedTo: unit.id,
      otherDef: def(state, unit),
    })
  for (const upgrade of unit.upgrades) discardUpgrade(state, upgrade)
  if (unit.leader) {
    player.leader.deployed = false
    player.leader.exhausted = true
  } else if (!def(state, unit).token) {
    state.players[unit.owner].discard.push({ id: unit.id, def: unit.def })
    state.defeatedThisPhase.push(unit.id)
  }
  state.fallen = [...(state.fallen ?? []), { player: p, def: unit.def }]
  log(state, `${nameOf(state, unit)} is defeated`, p)
  // A unit defeated in an attack knows it: "If this unit was defending, …"
  const inAttack = state.attack && (state.attack.attacker === unit.id || state.attack.target === unit.id) ? state.attack : undefined
  queue(state, p, nameOf(state, unit), 'When Defeated', unitScript(state, unit).whenDefeated, {
    id: unit.id,
    controller: p,
    def: def(state, unit),
    upgrades: unit.upgrades.map((u) => u.id),
    ...(inAttack && { attack: { ...inAttack } }),
  })
  trigger(state, p, 'whenFriendlyDefeated', { other: unit.id, otherDef: def(state, unit) })
  trigger(state, other(p), 'whenEnemyDefeated', { other: unit.id, otherDef: def(state, unit) })
}

function heal(state: GameState, p: PlayerId, amount: number) {
  if (spiceLocked(state)) return
  const base = state.players[p].base
  const before = base.damage
  base.damage = Math.max(0, base.damage - amount)
  if (base.damage < before) trigger(state, p, 'whenBaseHealed')
}

// 8.6: drawing from an empty deck deals 3 damage to your base instead
function draw(state: GameState, p: PlayerId, count: number) {
  const player = state.players[p]
  for (let i = 0; i < count; i++) {
    const card = player.deck.shift()
    if (card) {
      player.hand.push(card)
      player.drawn++
    } else hitBase(state, p, EMPTY_DECK_DAMAGE)
  }
}

// --- What a player may do ---

// A leader unit with Overwhelm that pumps itself for its attack (Luke Skywalker, I Have to Face
// Him): its deck's beatdown. It hits the base, or, made to fight a Sentinel, the one with the
// least HP left, the most damage carried over to the base (the user, 2026-11-24)
export function racesBase(state: GameState, unit: UnitState) {
  return !!unit.leader && !!keywordsOf(state, unit).overwhelm && /this unit gets \+\d+\/\+0 for this attack/.test(state.defs[unit.def].backText ?? '')
}
export function raceTarget(state: GameState, targets: string[]) {
  if (targets.includes('base')) return 'base'
  const left = (id: string) => {
    const u = [...state.players[0].units, ...state.players[1].units].find((x) => x.id === id)
    return u ? hpOf(state, u) - u.damage : Infinity
  }
  return [...targets].sort((a, b) => left(a) - left(b))[0]
}
function attackTargets(state: GameState, p: PlayerId, attacker: UnitState): (string | 'base')[] {
  const enemies = state.players[other(p)].units.filter((u) => u.arena === attacker.arena)
  // Sentinel (7.5.11): while an enemy in the arena has it, only those can be attacked, unless
  // the attacker has Saboteur (7.5.10)
  const sentinels = keywordsOf(state, attacker).saboteur ? [] : enemies.filter((u) => keywordsOf(state, u).sentinel)
  if (sentinels.length) {
    const cantAttack = unitScript(state, attacker).cantAttack
    const self: Self = { id: attacker.id, controller: p, def: def(state, attacker) }
    return sentinels.filter((u) => !cantAttack?.(new Game(state), self, u)).map((u) => u.id)
  }
  // "This unit can't attack units named Paul Atreides."
  const cant = unitScript(state, attacker).cantAttack
  const g = new Game(state)
  const self: Self = { id: attacker.id, controller: p, def: def(state, attacker) }
  const allowed = (u: UnitState) => !isHidden(state, u) && !cant?.(g, self, u)
  // "This unit can't attack bases." (Wicket)
  return [...enemies.filter(allowed).map((u) => u.id), ...(unitScript(state, attacker).cantAttackBases ? [] : ['base' as const])]
}

function choose<T>(list: T[], count: number): T[][] {
  if (count === 0) return [[]]
  return list.flatMap((item, i) => choose(list.slice(i + 1), count - 1).map((rest) => [item, ...rest]))
}

// A leader's or a unit's Action abilities that can be used now, with what they cost
function actionAbilities(state: GameState, p: PlayerId) {
  const player = state.players[p]
  const ready = readyResources(player)
  const found: { source: string; index: number }[] = []
  const offer = (source: string, abilities: Abilities, exhausted: boolean, self: Self) =>
    abilities.actions?.forEach((ability, index) => {
      if (ability.exhaust && exhausted) return
      if ((ability.resources ?? 0) > ready) return
      if (ability.can && !ability.can(new Game(state), self)) return
      found.push({ source, index })
    })
  if (!player.leader.deployed) {
    offer('leader', scriptOf(state, player.leader), player.leader.exhausted, {
      id: 'leader',
      controller: p,
      def: def(state, player.leader),
    })
  }
  for (const unit of player.units)
    offer(unit.id, unitScript(state, unit), unit.exhausted, { id: unit.id, controller: p, def: def(state, unit) })
  // A base's Action abilities (an Epic Action: Aldhani Garrison)
  offer(baseId(p), scriptOf(state, player.base), false, { id: baseId(p), controller: p, def: def(state, player.base) })
  // Spice tokens are all alike: one stands for them
  const spice = player.spice[0]
  if (spice) offer(spice.id, scriptOf(state, spice), false, { id: spice.id, controller: p, def: def(state, spice) })
  return found
}

// Every action the player may take now; [] when it isn't their turn to choose. An answer with
// several picks is listed in each of its combinations only while there are few.
export function legalActions(state: GameState, p: PlayerId): Action[] {
  if (state.phase === 'over' || !waitingFor(state).includes(p)) return []
  if (state.prompt) {
    const { options, min, max } = state.prompt
    const ids = options.map((o) => o.id)
    const sizes = Array.from({ length: max - min + 1 }, (_, i) => min + i)
    if (max > 1 && ids.length > 10) return []
    return sizes.flatMap((size) => choose(ids, size)).map((picks) => ({ type: 'answer', picks }))
  }
  const player = state.players[p]
  const handIds = player.hand.map((c) => c.id)
  switch (state.phase) {
    case 'first':
      return [
        { type: 'first', goFirst: true },
        { type: 'first', goFirst: false },
      ]
    case 'mulligan':
      return [
        { type: 'mulligan', take: false },
        { type: 'mulligan', take: true },
      ]
    case 'resource':
      return choose(handIds, Math.min(2, handIds.length)).map((cards) => ({ type: 'resource', cards }))
    case 'regroup':
      return [{ type: 'resource', cards: [] }, ...handIds.map((id) => ({ type: 'resource' as const, cards: [id] }))]
  }
  const actions: Action[] = [{ type: 'pass' }]
  const ready = readyResources(player)
  const units = [...state.players[0].units, ...state.players[1].units]
  const g = new Game(state)
  // How: using Smuggle, from the discard pile, for a Spice token instead of its cost. Keys in
  // the order an action lists them, which comparing actions needs.
  const plays = (card: Inst, from: PlayedFrom, spice = false, awakened = false) => {
    const d = def(state, card)
    if (isBanned(state, p, d)) return
    // Its own cost; a pilot too dear as a unit may still be played for its Piloting cost, below
    // (Han Solo: 5 as a unit, 2 as a pilot)
    let payable = true
    if (spice) {
      if (!player.spice.length) return
    } else if (
      (d.type === 'upgrade' && !d.keywords.fortify ? upgradePrice(state, p, d, from, { free: awakened }) : priceOf(state, p, d, from, { free: awakened })) -
        spiceRoom(state, p, d) >
        ready ||
      !canPayAdditional(state, p, d)
    ) {
      if (!(d.type === 'unit' && d.piloting !== undefined)) return
      payable = false
    }
    const extra = {
      ...(from === 'smuggle' && { smuggle: true }),
      ...(from === 'discard' && { discard: true }),
      ...(spice && { spice: true }),
      ...(awakened && { awakened: true }),
    }
    const fromDiscard = from === 'discard' && !awakened ? scriptOf(state, card).discardPlay : undefined
    const self: Self = { id: card.id, controller: p, def: d }
    if (!payable) {
      // Only as a pilot
    } else if (d.keywords.fortify) {
      if (!fromDiscard || fromDiscard(g, self)) actions.push({ type: 'play', card: card.id, attachTo: baseId(p), ...extra })
    } else if (d.type === 'upgrade') {
      for (const unit of units)
        if (
          canAttach(state, p, d, unit) &&
          (!fromDiscard || fromDiscard(g, self, unit)) &&
          (spice || priceOf(state, p, d, from, { free: awakened, target: unit.id }) - spiceRoom(state, p, d) <= ready)
        )
          actions.push({ type: 'play', card: card.id, attachTo: unit.id, ...extra })
    } else if (!fromDiscard || fromDiscard(g, self)) {
      actions.push({ type: 'play', card: card.id, ...extra })
    }
    // Piloting (7.5.17): as an upgrade on a friendly Vehicle unit without a Pilot, for its
    // Piloting cost (not for a Spice token, nor using Smuggle)
    if (d.type === 'unit' && d.piloting !== undefined && !spice && from !== 'smuggle' && !fromDiscard) {
      const affordable = priceOf(state, p, d, from, { free: awakened, pilot: true }) - spiceRoom(state, p, d) <= ready && canPayAdditional(state, p, d)
      if (affordable)
        for (const unit of player.units) if (canPilot(state, p, unit)) actions.push({ type: 'play', card: card.id, attachTo: unit.id, pilot: true, ...extra })
    }
  }
  for (const card of player.hand) {
    plays(card, 'hand')
    if (scriptOf(state, card).spicePlay) plays(card, 'hand', true)
  }
  // Smuggle (7.5.14): from the resources. A ready card helps pay for itself, so it counts among
  // the ready resources.
  for (const { card } of player.resources) {
    if (def(state, card).keywords.smuggle !== undefined) plays(card, 'smuggle')
  }
  // A card that may be played from the discard pile
  for (const card of player.discard) {
    const abilities = scriptOf(state, card)
    if (abilities.discardPlay) plays(card, 'discard')
    if (abilities.spicePlay) plays(card, 'discard', true)
    if (isAwakened(state, p, def(state, card))) plays(card, 'discard', false, true)
  }
  for (const unit of player.units) {
    if (unit.exhausted) continue
    for (const target of attackTargets(state, p, unit)) actions.push({ type: 'attack', attacker: unit.id, target })
  }
  // 3.4.4: the Epic Action deploys the leader once you control enough resources
  const leader = def(state, player.leader)
  if (!player.leader.deployed && !player.leader.epicUsed && player.resources.length >= leader.cost) {
    actions.push({ type: 'deploy' })
    // A pilot leader: or as an upgrade on a friendly Vehicle unit without a Pilot on it
    if (leader.unit?.pilot) for (const unit of player.units) if (canPilot(state, p, unit)) actions.push({ type: 'deploy', attachTo: unit.id })
  }
  for (const { source, index } of actionAbilities(state, p)) actions.push({ type: 'ability', source, index })
  if (!state.initiativeTaken) actions.push({ type: 'initiative' })
  return actions
}

// --- Taking an action ---

// The same action whatever the order of its keys, which a record kept in Postgres (JSONB) changes
const keyed = (action: Action) => JSON.stringify(Object.entries(action).sort(([a], [b]) => a.localeCompare(b)))
export const sameAction = (a: Action, b: Action) => keyed(a) === keyed(b)

function checkAnswer(prompt: Prompt, picks: string[]) {
  const ids = new Set(prompt.options.map((o) => o.id))
  const ok =
    picks.length >= prompt.min &&
    picks.length <= prompt.max &&
    new Set(picks).size === picks.length &&
    picks.every((pick) => ids.has(pick))
  if (!ok) throw new IllegalAction('That answer is not one of the choices')
}

// The game after player p takes an action; the game given is left as it was
export function applyAction(game: GameState, p: PlayerId, action: Action): GameState {
  if (action.type === 'concede') {
    if (game.phase === 'over') throw new IllegalAction('The game is over')
    const state = copy(game)
    state.prompt = null
    state.pending = null
    state.phase = 'over'
    state.winner = other(p)
    log(state, `${state.players[p].name} concedes`, p)
    return state
  }
  if (action.type === 'cancel') {
    if (!game.prompt?.cancel || p !== game.prompt.player || !game.pending) throw new IllegalAction('Nothing to take back')
    return game.pending.base
  }
  if (game.prompt) {
    if (action.type !== 'answer' || p !== game.prompt.player) throw new IllegalAction('An answer is awaited')
    checkAnswer(game.prompt, action.picks)
    const pending = game.pending as NonNullable<GameState['pending']>
    return play(pending.base, pending.player, pending.action, [...pending.answers, action.picks])
  }
  const legal = legalActions(game, p)
  // A resource choice may list its cards in any order; how a cost is paid (Credit tokens first)
  // isn't part of which action it is
  const { creditsFirst: _, ...plain } = action as Action & { creditsFirst?: boolean }
  const normal = action.type === 'resource' ? { ...action, cards: [...action.cards].sort() } : (plain as Action)
  const allowed = legal.some((a) => sameAction(a.type === 'resource' ? { ...a, cards: [...a.cards].sort() } : a, normal))
  if (!allowed) throw new IllegalAction(`${game.players[p].name} can't ${action.type} now`)
  return play(game, p, action, [])
}

// A game to change: a deep copy, but for what never changes once made, which the copy shares:
// the card definitions, the log's lines and the game an ability's question waits in
function copy(state: GameState): GameState {
  const { defs, log, pending, ...rest } = state
  return { ...structuredClone(rest), defs, log: [...log], pending }
}

// Plays an action from the game before it, with the answers known so far: to its end, or to
// the next question, the game then showing how far it got
function play(base: GameState, p: PlayerId, action: Action, answers: string[][]): GameState {
  const state = copy(base)
  const outer = current
  current = { answers, next: 0, queue: [] }
  try {
    perform(state, p, action)
    return state
  } catch (error) {
    if (!(error instanceof Pause)) throw error
    state.prompt = error.prompt
    state.pending = { base, player: p, action, answers }
    return state
  } finally {
    current = outer
  }
}

function perform(state: GameState, p: PlayerId, action: Action) {
  const player = state.players[p]
  switch (state.phase) {
    case 'first':
      if (action.type === 'first') chooseFirst(state, p, action.goFirst)
      return
    case 'mulligan':
      if (action.type === 'mulligan') mulligan(state, p, action.take)
      return
    case 'resource':
      if (action.type === 'resource') setupResource(state, p, action.cards)
      return
    case 'regroup':
      if (action.type === 'resource') regroupResource(state, p, action.cards)
      return
  }

  switch (action.type) {
    case 'pass':
      log(state, `${player.name} passes`, p)
      state.passes++
      break
    case 'initiative':
      // 1.15.5: take the counter, and pass for the rest of the phase
      state.initiative = p
      state.initiativeTaken = true
      player.passedForPhase = true
      log(state, `${player.name} takes the initiative`, p)
      state.passes++
      break
    case 'play': {
      const awakened = !!(action.discard && action.awakened) && wakeUp(state, p, action.card)
      playCard(state, p, action.card, action.attachTo, action.smuggle ? 'smuggle' : action.discard ? 'discard' : 'hand', {
        spiceInstead: action.spice,
        free: awakened,
        awakened,
        pilot: action.pilot,
        creditsFirst: action.creditsFirst,
      })
      state.passes = 0
      break
    }
    case 'attack':
      attack(state, p, action.attacker, action.target)
      state.passes = 0
      break
    case 'deploy':
      deploy(state, p, action.attachTo)
      state.passes = 0
      break
    case 'ability':
      useAbility(state, p, action.source, action.index, action.creditsFirst)
      state.passes = 0
      break
  }
  if (state.phase === 'over') return
  nextTurn(state)
}

// 5.2.1c: the chosen player gives the initiative to themselves or to their opponent; then
// each draws their opening hand (5.2.1d)
function chooseFirst(state: GameState, p: PlayerId, goFirst: boolean) {
  state.initiative = state.active = goFirst ? p : other(p)
  log(state, `${state.players[p].name} chooses to go ${goFirst ? 'first' : 'second'}`, p)
  for (const q of [0, 1] as const) draw(state, q, handSize(state, q))
  state.phase = 'mulligan'
}

// The opening hand: 6 cards, more with a leader that says so (Luke Skywalker, I Have to Face Him:
// "Draw 2 more cards in your starting hand.")
const handSize = (state: GameState, p: PlayerId) => HAND_SIZE + (scriptOf(state, state.players[p].leader, 'front').startingHand ?? 0)

function mulligan(state: GameState, p: PlayerId, take: boolean) {
  const player = state.players[p]
  if (take) {
    player.deck.push(...player.hand)
    player.hand = []
    shuffle(state, player.deck)
    player.hand = player.deck.splice(0, handSize(state, p))
    player.drawn += player.hand.length
    log(state, `${player.name} takes a mulligan`, p)
  } else {
    log(state, `${player.name} keeps their hand`, p)
  }
  player.mulliganDone = true
  if (state.players.every((pl) => pl.mulliganDone)) state.phase = 'resource'
}

// 5.2.1f: exactly 2, facedown and ready
function setupResource(state: GameState, p: PlayerId, cards: string[]) {
  const player = state.players[p]
  moveToResources(player, cards, false)
  player.setupResourced = true
  log(state, `${player.name} resources 2 cards`, p)
  if (state.players.every((pl) => pl.setupResourced)) startActionPhase(state)
}

// 5.5.1c: up to 1, facedown and exhausted; then everything readies and a new round begins
function regroupResource(state: GameState, p: PlayerId, cards: string[]) {
  const player = state.players[p]
  moveToResources(player, cards, true)
  player.regroupDone = true
  if (cards.length) log(state, `${player.name} resources a card`, p)
  if (!state.players.every((pl) => pl.regroupDone)) return
  for (const pl of state.players) {
    for (const unit of pl.units) if (!state.held?.includes(unit.id)) unit.exhausted = false
    for (const resource of pl.resources) resource.exhausted = false
    pl.leader.exhausted = false
  }
  state.round++
  state.usedThisRound = []
  state.held = []
  startActionPhase(state)
}

function moveToResources(player: PlayerState, cards: string[], exhausted: boolean) {
  for (const id of cards) {
    const card = player.hand.find((c) => c.id === id) as Inst
    player.hand = player.hand.filter((c) => c !== card)
    player.resources.push({ card, exhausted })
  }
}

// What lasts "this phase" ends with it
function endPhase(state: GameState) {
  state.discounts = []
  state.banned = []
  state.awakened = []
  state.defeatedThisPhase = []
  state.fallen = []
}

function startActionPhase(state: GameState) {
  endPhase(state)
  state.phase = 'action'
  state.phaseCount++
  state.active = state.initiative
  state.initiativeTaken = false
  state.passes = 0
  for (const pl of state.players) pl.passedForPhase = false
  log(state, `Round ${state.round}: action phase`)
  // "At the start of the action phase, …"; then what waited for the next action phase
  for (const p of [state.active, other(state.active)]) trigger(state, p, 'actionStart')
  const later = state.later ?? []
  state.later = []
  for (const wait of later) {
    const d = state.defs[wait.def]
    const ability = abilitiesOf(d, 'front').later
    if (ability) queue(state, wait.player, d.name, 'start of the action phase', (g, self) => ability(g, self, wait.data), { id: wait.id, controller: wait.player, def: d })
  }
  resolveTriggers(state)
}

// 5.4.1b: turns alternate; a player who took the initiative passes on each turn they get.
// Two passes in a row end the phase.
function nextTurn(state: GameState) {
  for (;;) {
    if (state.passes >= 2) return startRegroup(state)
    state.active = other(state.active)
    if (!state.players[state.active].passedForPhase) return
    state.passes++
  }
}

// 5.5: each player draws 2, then chooses whether to resource a card. What lasted for the
// action phase ends with it.
function startRegroup(state: GameState) {
  endPhase(state)
  state.phase = 'regroup'
  state.phaseCount++
  state.effects = state.effects.filter((e) => e.until !== 'phase')
  log(state, `Round ${state.round}: regroup phase`)
  // Units taken for a while go back to their owners; units doomed are defeated
  for (const { unit: id, owner } of state.borrowed) {
    const unit = findUnit(state, id)
    if (unit && controllerOf(state, unit) !== owner) moveUnit(state, unit, owner)
  }
  state.borrowed = []
  for (const id of state.doomed) {
    const unit = findUnit(state, id)
    if (unit) defeatUnit(state, unit)
  }
  state.doomed = []
  checkDefeats(state)
  for (const p of [state.active, other(state.active)]) trigger(state, p, 'regroupStart')
  resolveTriggers(state)
  if (state.winner !== null) return
  for (const p of [0, 1] as const) draw(state, p, 2)
  checkDefeats(state)
  for (const pl of state.players) pl.regroupDone = false
}

// Where a card is played from: the hand, the discard pile (when an ability says so), or the
// resources using Smuggle or Plot
export type PlayedFrom = 'hand' | 'discard' | 'smuggle' | 'plot' | 'deck'

// What an ability changes in the cost of a card it plays: "It costs [1] less", "for free"
// (which leaves additional costs to pay, 1.8), "ignoring its additional costs"
// spiceInstead: "for free by defeating a friendly Spice token"
// awakened: it gains "[When Played:] Ready this unit." (The Sleeper Has Awakened)
// pilot: using Piloting, its Piloting cost
// target: the unit an upgrade goes on, which may change its cost
// prefer: for an upgrade, the unit the AI puts it on (a Plot upgrade on the leader just deployed)
type PlayOptions = { prefer?: string; creditsFirst?: boolean; discount?: number; free?: boolean; ignoreAdditional?: boolean; spiceInstead?: boolean; awakened?: boolean; pilot?: boolean; target?: string }

// The next card of a trait a player plays this phase costs less (Bene Gesserit Sister); each
// such discount waiting applies to that card
const discountsFor = (state: GameState, p: PlayerId, card: CardDef) =>
  // trait ':unit': the next unit, whatever its traits (Emerie Karr)
  state.discounts.filter((d) => d.player === p && (d.trait === ':unit' ? card.type === 'unit' : card.traits.includes(d.trait)))

// "[Creature] cards you play cost [1] less.": what the cards on a player's side take off, and
// the card's own, onto the unit it goes on
function costsLess(state: GameState, p: PlayerId, card: CardDef, from: PlayedFrom, target?: string) {
  const g = new Game(state)
  const onto = target ? findUnit(state, target) : undefined
  const own = (onto ? (abilitiesOf(card, 'front').costsLessOnto?.(g, p, onto) ?? 0) : 0) + (abilitiesOf(card, 'front').costsLessSelf?.(g, p) ?? 0)
  return own + holders(state, p).reduce((sum, { self, abilities }) => sum + (abilities.costsLess?.(g, self, card, from, onto) ?? 0), 0)
}
// The cards on a player's side that make this card cost less, as it is played
function discounters(state: GameState, p: PlayerId, card: CardDef, from: PlayedFrom, target?: string) {
  const g = new Game(state)
  const onto = target ? findUnit(state, target) : undefined
  return holders(state, p).filter(({ self, abilities }) => (abilities.costsLess?.(g, self, card, from, onto) ?? 0) > 0)
}

// What the opponent's cards add to a card's cost (Raddus, exhausted: 3 more)
function taxes(state: GameState, p: PlayerId, card: CardDef) {
  const g = new Game(state)
  return holders(state, other(p)).reduce((sum, { self, abilities }) => sum + (abilities.taxesOpponents?.(g, self, card) ?? 0), 0)
}
function priceOf(state: GameState, p: PlayerId, card: CardDef, from: PlayedFrom, options: PlayOptions = {}) {
  if (options.free || options.spiceInstead) return 0
  const cost =
    from === 'smuggle'
      ? smuggleCost(state, p, card)
      : options.pilot && card.piloting !== undefined
        ? card.piloting + aspectPenalty(state, p, card)
        : playCost(state, p, card)
  return Math.max(
    0,
    cost +
      taxes(state, p, card) -
      (options.discount ?? 0) -
      discountsFor(state, p, card).reduce((sum, d) => sum + d.amount, 0) -
      costsLess(state, p, card, from, options.target),
  )
}
// An upgrade's price onto its cheapest unit, among these if given
function upgradePrice(state: GameState, p: PlayerId, card: CardDef, from: PlayedFrom, options: PlayOptions = {}, onto?: string[]) {
  const units = [...state.players[0].units, ...state.players[1].units].filter((u) => canAttach(state, p, card, u) && (!onto || onto.includes(u.id)))
  const prices = units.map((u) => priceOf(state, p, card, from, { ...options, target: u.id }))
  return prices.length ? Math.min(...prices) : priceOf(state, p, card, from, options)
}

// What a card in a player's hand costs them to play now: its cost, aspects missing and
// discounts counted
export const handPrice = (state: GameState, p: PlayerId, card: CardDef) =>
  card.type === 'upgrade' && !card.keywords.fortify ? upgradePrice(state, p, card, 'hand') : priceOf(state, p, card, 'hand')
// An upgrade in a player's hand: what it costs onto each unit it can go on (Mastery: 1 less on a
// unique one), shown on the units as it is played
export function attachPrices(state: GameState, p: PlayerId, card: CardDef): Record<string, number> {
  if (card.type !== 'upgrade' || card.keywords.fortify) return {}
  const units = [...state.players[0].units, ...state.players[1].units].filter((u) => canAttach(state, p, card, u))
  return Object.fromEntries(units.map((u) => [u.id, priceOf(state, p, card, 'hand', { target: u.id })]))
}

// How much less a card may cost for the Spice tokens defeated as it is played (CHOAM Dividend,
// Guild Heighliner), never below none when they are all needed for its additional cost
const spiceRoom = (state: GameState, p: PlayerId, card: CardDef) =>
  Math.max(0, Math.min(state.players[p].spice.length - (card.spiceCost ?? 0), abilitiesOf(card, 'front').spiceReduces ?? 0))

// A unit a player may play from their discard pile for free this phase (The Sleeper Has Awakened)
const isAwakened = (state: GameState, p: PlayerId, card: CardDef) =>
  card.type === 'unit' && (state.awakened ?? []).some((a) => a.player === p && a.name === card.name)

// Playing it uses that permission up
function wakeUp(state: GameState, p: PlayerId, id: string) {
  const card = state.players[p].discard.find((c) => c.id === id)
  const name = card && def(state, card).name
  const i = (state.awakened ?? []).findIndex((a) => a.player === p && a.name === name)
  if (i < 0) return false
  state.awakened!.splice(i, 1)
  return true
}

// The unit gains "[When Played:] Ready this unit.", which resolves with its other When Played
// abilities, in the order its controller chooses
function queueWakeUp(state: GameState, p: PlayerId, id: string) {
  const unit = findUnit(state, id)
  if (!unit || !current) return
  current.queue.push({ player: p, label: `${nameOf(state, unit)}: ready this unit`, run: () => new Game(state, p).ready(id) })
}

// A card name opponents can't play this phase (The Voice)
const isBanned = (state: GameState, p: PlayerId, card: CardDef) => state.banned.some((b) => b.player === p && b.name === card.name)

// An upgrade's "Attach to a friendly unit." or "Attach to a non-[{Vehicle}] unit."
function canAttach(state: GameState, p: PlayerId, card: CardDef, unit: UnitState) {
  if (card.attach?.friendly && controllerOf(state, unit) !== p) return false
  if (card.attach?.enemy && controllerOf(state, unit) === p) return false
  if (card.attach?.nonLeader && isLeaderUnit(state, unit)) return false
  // "Attach to a [{Unique}] unit." (Figure of Unity)
  if (card.attach?.unique && !def(state, unit).unique) return false
  const traits = traitsOf(state, unit)
  if (card.attach?.not?.some((trait) => traits.includes(trait))) return false
  if (card.attach?.only?.some((trait) => !traits.includes(trait))) return false
  // "with 3 or less power" (Gaderffii Stick)
  if (card.attach?.maxPower !== undefined && powerOf(state, unit) > card.attach.maxPower) return false
  return true
}

// A card that lets another card's additional costs be ignored (Shaddam IV), if one does now
function waiverFor(state: GameState, p: PlayerId, card: CardDef) {
  if (!card.spiceCost) return undefined
  const g = new Game(state)
  return holders(state, p).find(({ self, abilities }) => abilities.ignoresAdditionalCost?.(g, self, card))
}

const canPayAdditional = (state: GameState, p: PlayerId, card: CardDef) =>
  (card.spiceCost ?? 0) <= state.players[p].spice.length || !!waiverFor(state, p, card)

function playCard(state: GameState, p: PlayerId, id: string, attachTo?: string, from: PlayedFrom = 'hand', options: PlayOptions = {}) {
  const player = state.players[p]
  const playing = [...player.hand, ...player.discard, ...player.deck, ...player.resources.map((r) => r.card)].find((c) => c.id === id)
  const cheaper = playing && !options.free && !options.spiceInstead ? discounters(state, p, def(state, playing), from, attachTo) : []
  let card: Inst
  if (from === 'hand' || from === 'discard' || from === 'deck') {
    const zones = { hand: player.hand, discard: player.discard, deck: player.deck }
    card = zones[from].find((c) => c.id === id) as Inst
    payFor(state, p, def(state, card), priceOf(state, p, def(state, card), from, { ...options, target: attachTo }), options.creditsFirst)
    if (from === 'hand') player.hand = player.hand.filter((c) => c !== card)
    else if (from === 'discard') player.discard = player.discard.filter((c) => c !== card)
    else player.deck = player.deck.filter((c) => c !== card)
  } else {
    // 7.5.14e-g, 7.5.19c: the card helps pay for itself, and the top card of the deck takes its
    // place, exhausted (none when the deck is empty)
    const slot = player.resources.find((r) => r.card.id === id) as PlayerState['resources'][number]
    card = slot.card
    let cost = priceOf(state, p, def(state, card), from, { ...options, target: attachTo })
    if (cost > 0 && !slot.exhausted) {
      slot.exhausted = true
      cost--
    }
    payFor(state, p, def(state, card), cost, options.creditsFirst)
    const top = player.deck.shift()
    if (top) player.resources[player.resources.indexOf(slot)] = { card: top, exhausted: true }
    else player.resources = player.resources.filter((r) => r !== slot)
  }
  const d = def(state, card)
  for (const { self: by, abilities } of cheaper) abilities.costedLess?.(new Game(state, p), by)
  const used = discountsFor(state, p, d)
  if (!options.free && !options.spiceInstead) state.discounts = state.discounts.filter((x) => !used.includes(x))
  if (options.spiceInstead) defeatSpice(state, p)
  // An additional cost: Spice tokens to defeat, unless a card lets it be ignored. With the Spice
  // to pay, its controller chooses.
  if (d.spiceCost && !options.ignoreAdditional) {
    const waiver = waiverFor(state, p, d)
    const waive =
      !!waiver &&
      (player.spice.length < d.spiceCost ||
        new Game(state).may(p, `${waiver.self.def.name}: ignore the additional cost of ${d.name}?`, {
          yes: 'Ignore it',
          no: `Defeat ${d.spiceCost === 1 ? 'a Spice token' : `${d.spiceCost} Spice tokens`}`,
          source: waiver.self.def.id,
        }))
    if (waiver && waive) {
      state.usedThisRound.push(onceKey(waiver.self, 'ignoresAdditionalCost'))
      log(state, `${waiver.self.def.name}: ${d.name}'s additional cost is ignored`, p)
    } else for (let i = 0; i < d.spiceCost; i++) defeatSpice(state, p)
  }
  const how = { hand: '', discard: ' from the discard pile', smuggle: ' using Smuggle', plot: ' using Plot', deck: ' from the deck' }[from]
  const using = how + (options.spiceInstead ? ' by defeating a Spice token' : options.free ? ' for free' : '')
  const self: Self = { id: card.id, controller: p, def: d, smuggled: from === 'smuggle', plot: from === 'plot' }
  if (d.type === 'unit' && options.pilot && attachTo) {
    // Using Piloting: attached as an upgrade, its Piloting box what it does. Its When Played
    // abilities resolve as it is played, whichever way (3.13.3: all its text is still its own).
    const unit = findUnit(state, attachTo) as UnitState
    unit.upgrades.push({ ...card, owner: p })
    log(state, `${player.name} plays ${d.name} as a pilot on ${nameOf(state, unit)}${using}`, p, d.id)
    const attached = { ...self, other: unit.id, attachedTo: unit.id }
    queue(state, p, d.name, 'When Played', scriptOf(state, card, 'pilot').whenPlayed, attached)
    upgradeAttached(state, unit, card.id)
  } else if (d.type === 'unit') {
    // 3.5.3: a unit enters play exhausted
    const unit: UnitState = { ...card, owner: p, arena: d.arena ?? 'ground', damage: 0, exhausted: true, upgrades: [], entered: state.phaseCount }
    player.units.push(unit)
    log(state, `${player.name} plays ${d.name}${using}`, p, d.id)
    // Shielded first, so a When Played ability can count or spend its Shield token
    queueShielded(state, p, unit)
    queue(state, p, d.name, 'When Played', scriptOf(state, card).whenPlayed, self)
    if (options.awakened) queueWakeUp(state, p, unit.id)
    queueAmbush(state, p, unit)
  } else if (d.keywords.fortify) {
    // 7.5.21: onto its player's own base
    baseUpgrades(state, p).push({ ...card, owner: p })
    log(state, `${player.name} attaches ${d.name} to ${nameOf(state, player.base)}${using}`, p, d.id)
    queue(state, p, d.name, 'When Played', scriptOf(state, card).whenPlayed, { ...self, other: baseId(p), attachedTo: baseId(p) })
  } else if (d.type === 'upgrade') {
    const unit = findUnit(state, attachTo as string) as UnitState
    unit.upgrades.push({ ...card, owner: p })
    log(state, `${player.name} attaches ${d.name} to ${nameOf(state, unit)}${using}`, p, d.id)
    queue(state, p, d.name, 'When Played', scriptOf(state, card).whenPlayed, { ...self, other: unit.id, attachedTo: unit.id })
    upgradeAttached(state, unit, card.id)
    if (controllerOf(state, unit) === p)
      queue(state, p, nameOf(state, unit), 'upgrade played on it', unitScript(state, unit).whenUpgradePlayedOn, { id: unit.id, controller: p, def: def(state, unit), other: card.id })
  } else {
    // An event resolves its text, then goes to the discard pile
    log(state, `${player.name} plays ${d.name}${using}`, p, d.id)
    const abilities = scriptOf(state, card)
    if (abilities.play) abilities.play(new Game(state, p), self)
    else log(state, `(${d.name}'s text doesn't do anything yet)`)
    // "Put this event into play as a resource." (exhausted, 2.4.1b)
    if (abilities.toResources) {
      player.resources.push({ card, exhausted: true })
      log(state, `${player.name} puts ${d.name} into play as a resource`, p)
    } else player.discard.push(card)
  }
  // A second copy of a unique card: one is defeated before its When Played resolves
  if (d.type !== 'event') checkUnique(state, p)
  // Abilities that trigger on another card being played
  trigger(state, p, 'whenYouPlay', { other: card.id, otherDef: d }, card.id)
  trigger(state, other(p), 'whenOpponentPlays', { other: card.id, otherDef: d })
  checkDefeats(state)
  resolveTriggers(state)
}

// Paying for a card: the Spice tokens that may make it cheaper defeated first, as many as its
// controller chooses (the AI as few as it needs)
function payFor(state: GameState, p: PlayerId, card: CardDef, price: number, creditsFirst = false) {
  const room = Math.min(spiceRoom(state, p, card), price)
  let spent = 0
  if (room > 0) {
    const needed = Math.max(0, price - readyResources(state.players[p]))
    const counts = Array.from({ length: room - needed + 1 }, (_, i) => needed + i)
    spent =
      counts.length === 1
        ? counts[0]
        : counts[
            new Game(state).option(
              p,
              `${card.name}: defeat how many Spice tokens to pay less?`,
              counts.map((n) => `${n} (pay ${price - n})`),
              { ai: 0, source: card.id },
            )
          ]
    for (let i = 0; i < spent; i++) defeatSpice(state, p)
  }
  pay(state, p, price - spent, creditsFirst)
}

// Shielded (7.5.12): as it is played, deployed or created, it gets a Shield token, in the same
// window as its When Played abilities
function queueShielded(state: GameState, p: PlayerId, unit: UnitState) {
  if (!keywordsOf(state, unit).shielded) return
  ;(current as Run).queue.push({
    player: p,
    label: `${nameOf(state, unit)}: Shielded`,
    // The AI: after its Ambush when the unit it attacks can't defeat it, so the Shield token
    // stays for later (Darth Tyranus on a 2/4, the user, 2026-11-26)
    later: () => {
      const still = findUnit(state, unit.id)
      if (!still || !keywordsOf(state, still).ambush) return false
      const left = (u: UnitState) => hpOf(state, u) - u.damage
      return attackTargets(state, p, still)
        .filter((t) => t !== 'base')
        .map((t) => findUnit(state, t) as UnitState)
        .some((t) => powerOf(state, still, true) >= left(t) && powerOf(state, t) < left(still))
    },
    run: () => {
      const still = findUnit(state, unit.id)
      if (still) giveToken(state, still, 'Shield')
    },
  })
}

// Ambush (7.5.5): as it enters play, it may attack an enemy unit, exhausted as it is. The AI
// attacks a unit it defeats or outlasts, the dearest first.
function queueAmbush(state: GameState, p: PlayerId, unit: UnitState) {
  if (!keywordsOf(state, unit).ambush) return
  ;(current as Run).queue.push({
    player: p,
    label: `${nameOf(state, unit)}: Ambush`,
    run: () => {
      const still = findUnit(state, unit.id)
      if (!still) return
      const targets = attackTargets(state, p, still).filter((t) => t !== 'base')
      const left = (u: UnitState) => hpOf(state, u) - u.damage
      const units = targets.map((t) => findUnit(state, t) as UnitState)
      let good = units
        .filter((t) => powerOf(state, still, true) >= left(t) || powerOf(state, t) < left(still))
        .sort((a, b) => def(state, b).cost - def(state, a).cost)[0]
      // One that captures as its attack defeats a unit (The Mandalorian, Cleaning Up Nevarro):
      // a unit it defeats, the dearest but for the strongest enemy, which it captures after (the
      // user, 2026-11-26: "kill a decent small to medium unit and capture the strongest")
      if (unitScript(state, still).whenAttackDefeats) {
        const kills = units.filter((t) => powerOf(state, still, true) >= left(t)).sort((a, b) => def(state, b).cost - def(state, a).cost)
        const strongest = [...units].filter((t) => !t.leader).sort((a, b) => def(state, b).cost - def(state, a).cost || powerOf(state, b) - powerOf(state, a))[0]
        const survives = (t: UnitState) => powerOf(state, t) < left(still)
        good = kills.find((t) => t !== strongest && survives(t)) ?? kills.find((t) => t !== strongest) ?? kills[0] ?? good
      }
      const pick = new Game(state).chooseOne(p, `${nameOf(state, still)}: Ambush, choose an enemy unit to attack`, targets, {
        optional: true,
        ai: good?.id ?? 'none',
        source: still.def,
      })
      if (pick) attack(state, p, still.id, pick)
    },
  })
}

// Plot (7.5.19): when you deploy a leader, the player first chooses, all at once, the Plot cards
// in their resources they plan to play, any number of them, even more than they can pay for, and
// shows them (b); then plays them one at a time in any order, each paid for in full, and may stop
// or skip any. Only the cards in the resources as the leader deploys: a Plot card that replaces
// one played can't be played in the same deploy (d) (the user, 2026-11-25)
function queuePlots(state: GameState, p: PlayerId) {
  const player = state.players[p]
  const plots = player.resources.filter((r) => def(state, r.card).keywords.plot).map((r) => r.card.id)
  if (!plots.length) return
  ;(current as Run).queue.push({
    player: p,
    label: 'Plot',
    run: () => {
      const g = new Game(state)
      const planned = g.choose(p, 'Plot: choose the cards you plan to play from your resources (your opponent sees them)', plots, {
        min: 0,
        max: plots.length,
        // The AI plans only the cards it can pay for together (revealing the rest gives them away)
        ai: (() => {
          const plan = plotPlan(state, p, plots.filter((id) => g.canPlay(p, id)))
          return plan.length ? `ids:${plan.join(',')}` : 'none'
        })(),
        firm: true,
      })
      if (!planned.length) return
      g.log(`${player.name} plans to play using Plot: ${planned.map((id) => g.name(id)).join(', ')}`, p)
      const left = new Set(planned)
      for (;;) {
        const ids = [...left].filter((id) => player.resources.some((r) => r.card.id === id) && g.canPlay(p, id))
        // The AI: the next card of the set it can pay for that is worth most (plotPlan)
        const plan = plotPlan(state, p, ids)
        const id = g.chooseOne(p, 'Plot: choose the next card to play (or stop)', ids, { optional: true, ai: plan[0] ?? 'none', firm: true })
        // The AI puts a Plot upgrade on the leader it just deployed (Unveiled Might on Kylo Ren)
        const leader = player.units.find((u) => u.leader)?.id
        if (!id || !g.playCard(p, id, { ...(leader && { prefer: leader }) })) return
        left.delete(id)
      }
    },
  })
}

// The AI's Plot cards on a deploy: of those it can pay for together, the set worth most, each card
// worth its cost, a second copy of a unique card in play (or in the set) a little (its When Played
// only). Jar Jar Binks and Chancellor Palpatine (5) over Unveiled Might (4) on 5 resources, Might
// over two Jar Jars (2 + 0.8), Might and Jar Jar on 6 (the user, 2026-11-25). Dearest first.
const SECOND_COPY = 0.4
const BIG_FLIP_COST = 8
const BIG_FLIP = 1.5
const PLOT_REPLACED = 1
function plotPlan(state: GameState, p: PlayerId, ids: string[]) {
  const player = state.players[p]
  const ready = readyResources(player)
  const card = (id: string) => def(state, player.resources.find((r) => r.card.id === id)!.card)
  const g = new Game(state)
  const price = (id: string) => g.price(p, id)
  const inPlay = new Set(player.units.map((u) => def(state, u).name))
  // What the resources left after the set still pay for from hand: the dearest card, a big one
  // (8 or more) worth a little more. Lando Calrissian's flip turn: 6 resources and 3 Credit
  // tokens play Raddus or Bo-Katan Kryze (9) rather than Galen Erso (4) using Plot and a 5-cost
  // card (the user, 2026-11-26: "Lando can play a 9 drop on his flip turn")
  const hand = player.hand.map((c) => ({ id: c.id, cost: def(state, c).cost, price: price(c.id) }))
  const fromHand = (left: number) => Math.max(0, ...hand.filter((c) => c.price <= left).map((c) => c.cost + (c.cost >= BIG_FLIP_COST ? BIG_FLIP : 0)))
  let best: string[] = []
  let bestWorth = fromHand(ready)
  const list = ids.slice(0, 10)
  for (let mask = 1; mask < 1 << list.length; mask++) {
    const set = list.filter((_, i) => mask & (1 << i))
    const spent = set.reduce((sum, id) => sum + price(id), 0)
    if (spent > ready) continue
    const seen = new Set(inPlay)
    let worth = fromHand(ready - spent)
    for (const id of [...set].sort((a, b) => card(b).cost - card(a).cost)) {
      const d = card(id)
      // (a Plot card played is replaced in the resources from the deck: a card more)
      worth += (d.unique && seen.has(d.name) ? SECOND_COPY * d.cost : d.cost) + PLOT_REPLACED
      seen.add(d.name)
    }
    if (worth > bestWorth) [best, bestWorth] = [set, worth]
  }
  return best.sort((a, b) => card(b).cost - card(a).cost)
}

// What an attack may do differently, for an ability that makes one
// Saboteur: the defending unit's Shield tokens defeated
const sabotage: Ability = (g, self) => {
  const target = self.attack?.target
  const unit = target && target !== 'base' ? g.unit(target) : undefined
  if (!unit) return
  for (const shield of unit.upgrades.filter((u) => g.def(u).token && g.def(u).name === 'Shield').map((u) => u.id)) g.defeatUpgrade(shield)
}

type AttackOptions = { power?: number; firstStrike?: boolean; overwhelm?: boolean; onAttack?: Ability }
// onAttack: an On Attack ability the unit gains for this attack (Strafing Run)

// 6.3: exhaust the attacker, resolve its On Attack abilities and those it triggers, then both
// deal their damage at once
function attack(state: GameState, p: PlayerId, attackerId: string, target: string | 'base', options: AttackOptions = {}) {
  const player = state.players[p]
  const enemy = state.players[other(p)]
  const attacker = findUnit(state, attackerId) as UnitState
  const outer = state.attack
  state.attack = { attacker: attackerId, target }
  // An attack an ability makes (Ambush, say) resolves its own abilities first: those already
  // waiting (another When Played of the same unit) wait until it is over
  const run = current as Run
  const waiting = run.queue
  run.queue = []
  if (options.power) state.effects.push({ unit: attackerId, power: options.power, hp: 0, until: 'attack' })
  if (options.firstStrike || options.overwhelm)
    state.effects.push({
      unit: attackerId,
      power: 0,
      hp: 0,
      keywords: {
        ...(options.firstStrike && { firstStrike: true }),
        ...(options.overwhelm && { overwhelm: true }),
      },
      until: 'attack',
    })
  const defenderName = target === 'base' ? nameOf(state, enemy.base) : nameOf(state, findUnit(state, target) as UnitState)
  log(state, `${player.name} attacks ${defenderName} with ${nameOf(state, attacker)}`, p)
  exhaustUnit(state, attacker)
  if (state.attackers?.phase !== state.phaseCount) state.attackers = { phase: state.phaseCount, units: [] }
  state.attackers.units.push(attackerId)
  if (target === 'base') (state.attackers.bases ??= []).push({ unit: attackerId, base: other(p) })
  const self: Self = { id: attackerId, controller: p, def: def(state, attacker), attack: { attacker: attackerId, target } }
  queue(state, p, nameOf(state, attacker), 'On Attack', unitScript(state, attacker).onAttack, self)
  if (options.onAttack) queue(state, p, nameOf(state, attacker), 'On Attack', options.onAttack, self)
  // An On Attack its upgrades give it (Maula Pistol): the unit's own, as it attacks
  for (const upgrade of attacker.upgrades)
    queue(state, p, nameOf(state, attacker), 'On Attack', upgradeScript(state, upgrade).attachedOnAttack, { ...self, attachedTo: attackerId })
  // Saboteur's second ability (7.5.10a): "On Attack: Defeat all Shield tokens attached to the defending unit."
  if (keywordsOf(state, attacker).saboteur && target !== 'base') queue(state, p, nameOf(state, attacker), 'Saboteur', sabotage, self)
  trigger(state, p, 'whenFriendlyAttacks', { other: attackerId, attack: self.attack }, attackerId)
  trigger(state, other(p), 'whenEnemyAttacks', { other: attackerId, attack: self.attack })
  const defending = target === 'base' ? undefined : findUnit(state, target)
  // Its card, for When Defense Ends after it is defeated
  const defendingDef = defending && def(state, defending)
  if (defending)
    queue(state, other(p), nameOf(state, defending), 'when defending', unitScript(state, defending).whenDefending, {
      id: defending.id,
      controller: other(p),
      def: def(state, defending),
      other: attackerId,
      attack: self.attack,
    })
  // A When this unit is attacked its upgrades give it (Diplomatic Immunity)
  if (defending)
    for (const upgrade of defending.upgrades)
      queue(state, other(p), nameOf(state, defending), 'when defending', upgradeScript(state, upgrade).attachedWhenDefending, {
        id: upgrade.id,
        controller: other(p),
        def: def(state, upgrade),
        other: attackerId,
        attack: self.attack,
        attachedTo: defending.id,
      })
  resolveTriggers(state)

  // The attack ends without combat when either is gone
  let toBase = 0
  const still = findUnit(state, attackerId)
  const defender = target === 'base' ? undefined : findUnit(state, target)
  if (state.phase !== 'over' && still && (target === 'base' || defender)) {
    const keywords = keywordsOf(state, still)
    // Combat damage prevented, dealt by or to either unit (Yoda): neither deals any
    const calm = (id: string) => !!state.noCombat?.some((n) => n.unit === id && n.phase === state.phaseCount)
    const quiet = calm(still.id) || (!!defender && calm(defender.id))
    const power = quiet ? 0 : powerOf(state, still, true)
    // Restore (7.5.9): when it attacks, heal that much damage from your base
    if (keywords.restore) heal(state, p, keywords.restore)
    if (!defender) {
      toBase = power
      hitBase(state, other(p), power)
      log(state, `${nameOf(state, still)} deals ${power} damage to ${nameOf(state, enemy.base)}`, p)
      if (power > 0) trigger(state, p, 'whenCombatDamageBase', { other: attackerId, attack: { attacker: attackerId, target } })
    } else {
      const back = quiet ? 0 : powerOf(state, defender)
      // The defender's combat damage first (The Stranger): its own after, with the power it has
      // then, if it survives
      const second = !quiet && !keywords.firstStrike && !!unitScript(state, still).strikesSecond?.(new Game(state), { id: still.id, controller: p, def: def(state, still), attack: { attacker: attackerId, target } }, defender)
      let taken = 0
      let hit = power
      if (second) {
        log(state, `${nameOf(state, defender)} deals its combat damage first`, p)
        taken = damageUnit(state, still, back, true)
        checkDefeats(state)
        hit = findUnit(state, still.id) ? powerOf(state, still, true) : 0
      }
      const remaining = Math.max(0, hpOf(state, defender) - defender.damage)
      const dealt = damageUnit(state, defender, hit, true)
      // Dealing its combat damage first, a unit that defeats the defender takes none back
      if (keywords.firstStrike) {
        checkDefeats(state)
        if (findUnit(state, defender.id)) taken = damageUnit(state, still, back, true)
      } else if (!second) taken = damageUnit(state, still, back, true)
      // "When this unit deals combat damage to an enemy unit:", each that did
      if (dealt > 0)
        queue(state, p, nameOf(state, still), 'deals combat damage to a unit', unitScript(state, still).whenCombatDamageUnit, {
          id: still.id,
          controller: p,
          def: def(state, still),
          other: defender.id,
          attack: { attacker: attackerId, target },
        })
      if (taken > 0)
        queue(state, other(p), nameOf(state, defender), 'deals combat damage to a unit', unitScript(state, defender).whenCombatDamageUnit, {
          id: defender.id,
          controller: other(p),
          def: def(state, defender),
          other: still.id,
          attack: { attacker: attackerId, target },
        })
      // Overwhelm (7.5.7): damage beyond what defeats the defender goes to its controller's base,
      // unless a Shield token prevented it (7.5.7e)
      if (keywords.overwhelm && dealt && hit > remaining) {
        toBase = hit - remaining
        hitBase(state, other(p), hit - remaining)
        trigger(state, p, 'whenCombatDamageBase', { other: attackerId, attack: { attacker: attackerId, target } })
      }
    }
    checkDefeats(state)
    // "When this unit attacks and defeats a unit:" (The Mandalorian), whether it survived or not
    if (defender && !findUnit(state, defender.id))
      queue(state, p, nameOf(state, attacker), 'attacks and defeats a unit', unitScript(state, attacker).whenAttackDefeats, {
        id: attackerId,
        controller: p,
        def: self.def,
        other: defender.id,
        attack: { attacker: attackerId, target },
      })
    resolveTriggers(state)
    // "When this unit completes an attack:", only once it has, still in play
    const after = findUnit(state, attackerId)
    if (after && state.winner === null) {
      queue(state, p, nameOf(state, after), 'after attacking', unitScript(state, after).afterAttack, {
        id: after.id,
        controller: p,
        def: def(state, after),
        attack: { attacker: attackerId, target },
      })
      resolveTriggers(state)
    }
  }
  // "When Attack Ends:" and "When Defense Ends:", whether the unit survived or not (a card that
  // asks says "If this unit survived": self.survived)
  if (state.phase !== 'over' && state.winner === null) {
    const attack = { attacker: attackerId, target }
    queue(state, p, nameOf(state, attacker), 'when attack ends', unitScript(state, attacker).whenAttackEnds, {
      id: attackerId,
      controller: p,
      def: self.def,
      attack,
      other: target === 'base' ? undefined : target,
      survived: !!findUnit(state, attackerId),
    })
    if (defending)
      queue(state, other(p), nameOf(state, defending), 'when defense ends', unitScript(state, defending).afterDefending, {
        id: defending.id,
        controller: other(p),
        def: defendingDef!,
        other: attackerId,
        attack,
        survived: !!findUnit(state, defending.id),
      })
    trigger(state, p, 'whenFriendlyAttackEnds', { other: attackerId, attack, baseDamage: toBase })
    resolveTriggers(state)
  }
  endAdvantage(state, attackerId)
  if (defending) endAdvantage(state, defending.id)
  state.effects = state.effects.filter((e) => !(e.until === 'attack' && e.unit === attackerId))
  state.attack = outer
  run.queue = [...run.queue, ...waiting]
}

// A unit changing control: to the other player's side, as it is
function moveUnit(state: GameState, unit: UnitState, to: PlayerId) {
  const from = controllerOf(state, unit)
  if (from === to) return
  state.players[from].units = state.players[from].units.filter((u) => u !== unit)
  state.players[to].units.push(unit)
  log(state, `${state.players[to].name} takes control of ${nameOf(state, unit)}`, to)
}

// Opponents play with their hands revealed (Reverend Mother Mohiam)
export const handRevealed = (state: GameState, p: PlayerId) => holders(state, other(p)).some(({ abilities }) => abilities.revealsHands)
// "You may look at the top card of your deck at any time."
export const seesTopCard = (state: GameState, p: PlayerId) => holders(state, p).some(({ abilities }) => abilities.seesTopCard)

// 3.4.4: flip to the unit side, in its arena, ready; deployed, not played
function deploy(state: GameState, p: PlayerId, attachTo?: string) {
  const player = state.players[p]
  player.leader.deployed = true
  player.leader.epicUsed = true
  // A pilot leader deployed as an upgrade (3.4.4a): its unit side attached to the Vehicle
  const vehicle = attachTo ? findUnit(state, attachTo) : undefined
  if (vehicle) {
    const id = `L${p}`
    vehicle.upgrades.push({ id, def: player.leader.def, owner: p })
    log(state, `${player.name} deploys ${nameOf(state, player.leader)} as a pilot on ${nameOf(state, vehicle)}`, p)
    const self = { id, controller: p, def: def(state, player.leader), other: vehicle.id, attachedTo: vehicle.id }
    queue(state, p, nameOf(state, player.leader), 'When Deployed', scriptOf(state, player.leader, 'back').whenDeployed, self)
    queue(state, p, nameOf(state, player.leader), 'When Deployed', scriptOf(state, player.leader, 'pilot').whenDeployed, self)
    checkUnique(state, p)
    queuePlots(state, p)
    resolveTriggers(state)
    return
  }
  const unit: UnitState = {
    id: `L${p}`,
    def: player.leader.def,
    owner: p,
    arena: def(state, player.leader).unit?.arena ?? 'ground',
    damage: 0,
    exhausted: false,
    leader: true,
    upgrades: [],
    entered: state.phaseCount,
  }
  player.units.push(unit)
  log(state, `${player.name} deploys ${nameOf(state, player.leader)}`, p)
  queueShielded(state, p, unit)
  queue(state, p, nameOf(state, unit), 'When Deployed', scriptOf(state, unit, 'back').whenDeployed, {
    id: unit.id,
    controller: p,
    def: def(state, unit),
  })
  checkUnique(state, p)
  queueAmbush(state, p, unit)
  queuePlots(state, p)
  resolveTriggers(state)
}

// What an Action ability says, for a button that uses it
// Where an Action ability is: on the leader, a unit, a Spice token
function abilitySource(state: GameState, p: PlayerId, source: string) {
  const player = state.players[p]
  if (source === baseId(p)) return { unit: undefined, card: player.base, abilities: scriptOf(state, player.base) }
  const unit = source === 'leader' ? undefined : findUnit(state, source)
  const spice = player.spice.find((t) => t.id === source)
  const card = unit ?? spice ?? player.leader
  return { unit, card, abilities: unit ? unitScript(state, unit) : scriptOf(state, card) }
}

export function abilityLabel(state: GameState, p: PlayerId, source: string, index: number) {
  const ability = abilitySource(state, p, source).abilities.actions?.[index]
  if (!ability) return ''
  const cost = [ability.resources && `${ability.resources} resource${ability.resources > 1 ? 's' : ''}`, ability.exhaust && 'exhaust']
  const paid = cost.filter(Boolean).join(', ')
  return paid ? `${ability.label} (${paid})` : ability.label
}

// An Action ability: pay its cost, exhausting the card when it says so, then resolve it
function useAbility(state: GameState, p: PlayerId, source: string, index: number, creditsFirst = false) {
  const player = state.players[p]
  const { unit, card, abilities } = abilitySource(state, p, source)
  const ability = abilities.actions?.[index]
  if (!ability) throw new IllegalAction('No such ability')
  pay(state, p, ability.resources ?? 0, creditsFirst)
  if (ability.exhaust) {
    if (unit) exhaustUnit(state, unit)
    else if (source === 'leader') player.leader.exhausted = true
  }
  log(state, `${player.name} uses ${nameOf(state, card)}: ${ability.label}`, p)
  ability.run(new Game(state, p), { id: source, controller: p, def: def(state, card) })
  checkDefeats(state)
  resolveTriggers(state)
}

// --- What abilities can do ---

// seen: the cards looked at, those not among ids shown too
// cancel: the action may be taken back from this question, its first
type Choice = { optional?: boolean; ai?: Prompt['ai']; firm?: boolean; source?: string; seen?: string[]; cancel?: boolean }

// The game as card scripts see and change it: what is where, questions for the players, and
// the effects cards have. Damage and defeats are dealt with as they happen.
export class Game {
  state: GameState
  // The player whose ability this is, if it is one
  by?: PlayerId
  constructor(state: GameState, by?: PlayerId) {
    this.state = state
    this.by = by
  }

  // Reading
  get active() {
    return this.state.active
  }
  other(p: PlayerId) {
    return other(p)
  }
  def(card: { def: string }) {
    return def(this.state, card)
  }
  name(id: string) {
    const owner = baseOwner(id)
    if (owner !== undefined) return nameOf(this.state, this.state.players[owner].base)
    const unit = this.unit(id)
    if (unit) return nameOf(this.state, unit)
    const card = this.cardInfo(id)
    return card ? nameOf(this.state, card) : id
  }
  unit(id: string) {
    return findUnit(this.state, id)
  }
  // Every unit in play, or those a test lets through
  units(test: (unit: UnitState) => boolean = () => true) {
    return [...this.state.players[0].units, ...this.state.players[1].units].filter(test)
  }
  controller(unit: UnitState) {
    return controllerOf(this.state, unit)
  }
  power(unit: UnitState) {
    return powerOf(this.state, unit)
  }
  hp(unit: UnitState) {
    return hpOf(this.state, unit)
  }
  // Its keywords now, those it is given included
  keywords(unit: UnitState) {
    return keywordsOf(this.state, unit)
  }
  cost(unit: UnitState) {
    return this.def(unit).cost
  }
  // A leader unit, for "leader" and "non-leader": the leader's own, or one a pilot leader made one
  isLeader(unit: UnitState) {
    return isLeaderUnit(this.state, unit)
  }
  // A unit in play's traits include those it gains
  hasTrait(card: { def: string }, trait: string) {
    const unit = 'upgrades' in card ? (card as UnitState) : undefined
    if (unit && findUnit(this.state, unit.id)) return traitsOf(this.state, unit).includes(trait)
    const id = (card as { id?: string }).id
    if (id && this.state.lostTraits?.length && traitLost(this.state, ownerOfId(this.state, id), trait)) return false
    return this.def(card).traits.includes(trait)
  }
  // The attack under way
  get attack() {
    return this.state.attack
  }
  // Every upgrade in play, with its controller and the unit it is on (none for a Fortification,
  // on its controller's base)
  upgrades(): (Inst & { owner: PlayerId; controller: PlayerId; unit?: UnitState })[] {
    return [
      ...this.units().flatMap((unit) => unit.upgrades.map((upgrade) => ({ ...upgrade, controller: controllerOf(this.state, unit), unit }))),
      ...([0, 1] as const).flatMap((p) => (this.state.players[p].base.upgrades ?? []).map((upgrade) => ({ ...upgrade, controller: p }))),
    ]
  }
  player(p: PlayerId) {
    return this.state.players[p]
  }

  // Asking. A question with nothing to choose from isn't asked.
  // A card in a hand, deck or discard pile is shown in the question: only the player asked sees it
  choose(player: PlayerId, text: string, ids: string[], options: Choice & { min?: number; max?: number } = {}) {
    // Nothing to choose: no question, unless there are cards looked at to show
    if (!ids.length && !options.seen?.length) return []
    const min = Math.min(options.min ?? 1, ids.length)
    const max = Math.min(options.max ?? 1, ids.length)
    const seen = options.seen?.flatMap((id) => {
      const card = this.cardInfo(id)
      return card ? [{ id, def: card.def }] : []
    })
    return ask({
      player,
      text,
      source: options.source,
      ...(seen && { seen }),
      ...(options.cancel && { cancel: true }),
      kind: 'pick',
      options: ids.map((id) => ({ id, label: this.name(id), def: this.cardInfo(id)?.def })),
      min,
      max,
      ai: options.ai,
      ...(options.firm && { firm: true }),
    })
  }
  // One of them, or nothing when optional (or when there is nothing to choose)
  chooseOne(player: PlayerId, text: string, ids: string[], options: Choice = {}) {
    const [pick] = this.choose(player, text, ids, { ...options, min: options.optional ? 0 : 1, max: 1 })
    return pick ?? null
  }
  // A "you may": yes or no. ai: what the AI answers.
  may(player: PlayerId, text: string, options: { yes?: string; no?: string; ai?: boolean; firm?: boolean; source?: string; play?: Prompt['play'] } = {}) {
    const [pick] = ask({
      player,
      text,
      source: options.source,
      ...(options.play && { play: options.play }),
      kind: 'option',
      options: [
        { id: 'no', label: options.no ?? 'No' },
        { id: 'yes', label: options.yes ?? 'Yes' },
      ],
      min: 1,
      max: 1,
      ai: options.ai === false ? 'no' : 'yes',
      ...(options.firm && { firm: true }),
    })
    return pick === 'yes'
  }
  // "Choose one:": the number of the choice taken
  option(player: PlayerId, text: string, labels: string[], options: { ai?: number; firm?: boolean; source?: string; card?: string } = {}) {
    const [pick] = ask({
      player,
      text,
      source: options.source,
      card: options.card,
      kind: 'option',
      options: labels.map((label, i) => ({ id: String(i), label })),
      min: 1,
      max: 1,
      ai: String(options.ai ?? 0),
      ...(options.firm && { firm: true }),
    })
    return Number(pick)
  }
  private cardInfo(id: string) {
    for (const pl of this.state.players)
      for (const card of [
        ...pl.hand,
        ...pl.deck,
        ...pl.discard,
        ...pl.resources.map((r) => r.card),
        ...pl.spice,
        ...pl.units.flatMap((u) => u.upgrades),
        ...(pl.base.upgrades ?? []),
      ])
        if (card.id === id) return card
    return undefined
  }
  // A card out of play, or a Spice token, by its id
  card(id: string) {
    return this.cardInfo(id)
  }

  // Doing
  log(text: string, player?: PlayerId) {
    log(this.state, text, player)
  }
  // Cards a player reveals (from their deck, say), shown to both players until they reveal others
  reveal(p: PlayerId, cardIds: string[], by: Self) {
    const cards = cardIds.flatMap((id) => (this.card(id) ? [this.card(id)!.def] : []))
    if (!cards.length) return
    this.state.revealed ??= [null, null]
    this.state.revealed[p] = { cards, by: by.def.id }
    this.log(`${this.player(p).name} reveals ${cards.map((d) => this.state.defs[d].name).join(', ')}`, p)
  }
  // To a unit or a base (base0, base1): the damage dealt, none when a Shield token prevents it
  damage(target: string, amount: number, from?: Self) {
    if (amount <= 0) return 0
    const owner = baseOwner(target)
    if (owner !== undefined) hitBase(this.state, owner, amount)
    else {
      const unit = this.unit(target)
      if (!unit || !damageUnit(this.state, unit, amount)) return 0
    }
    this.log(`${from ? `${from.def.name} deals` : 'Dealt'} ${amount} damage to ${this.name(target)}`, from?.controller)
    checkDefeats(this.state)
    return amount
  }
  // Indirect damage (rule 35): `amount` unpreventable damage to a player, which that player
  // divides among their units and base, no unit more than its HP left; the dealer divides it
  // when a card on their side assigns it (Devastator, Hunting the Rebellion). All of it is dealt
  // at once, once divided.
  indirect(target: PlayerId, amount: number, from: Self) {
    if (amount <= 0) return
    const dealer = from.controller
    const assigner = target !== dealer && holders(this.state, dealer).some(({ abilities }) => abilities.assignsIndirect) ? dealer : target
    const base = baseId(target)
    const dealt: Record<string, number> = {}
    const room = (id: string) => {
      if (id === base) return Infinity
      const unit = this.unit(id)
      return unit ? hpOf(this.state, unit) - unit.damage - (dealt[id] ?? 0) : 0
    }
    const plan = indirectPlan(this.state, assigner, target, amount)
    this.log(`${from.def.name}: ${amount} indirect damage to ${this.state.players[target].name}, divided by ${this.state.players[assigner].name}`, dealer)
    let left = amount
    while (left > 0) {
      const ids = [base, ...this.state.players[target].units.map((u) => u.id).filter((id) => room(id) > 0)]
      const next = ids.find((id) => (plan[id] ?? 0) > 0) ?? base
      const pick = this.chooseOne(assigner, `${from.def.name}: where does the indirect damage go? (${left} left)`, ids, { ai: next, firm: true, source: from.def.id }) ?? base
      const most = Math.min(left, room(pick))
      const want = Math.max(1, Math.min(most, plan[pick] ?? most))
      const n = most > 1 ? this.option(assigner, `How much of it to ${this.name(pick)}?`, Array.from({ length: most }, (_, i) => String(i + 1)), { ai: want - 1, firm: true, source: from.def.id }) + 1 : 1
      dealt[pick] = (dealt[pick] ?? 0) + n
      if (plan[pick]) plan[pick] = Math.max(0, plan[pick] - n)
      left -= n
    }
    for (const [id, n] of Object.entries(dealt)) {
      if (id === base) hitBase(this.state, target, n)
      else {
        const unit = this.unit(id)
        if (unit) damageUnit(this.state, unit, n, false, true)
      }
      this.log(`${from.def.name} deals ${n} indirect damage to ${this.name(id)}`, dealer)
    }
    checkDefeats(this.state)
  }
  // How many times a player's base was dealt damage this phase
  baseHits(p: PlayerId) {
    return baseHits(this.state, p)
  }
  heal(target: string, amount: number, from?: Self) {
    const owner = baseOwner(target)
    const damaged = owner !== undefined ? this.state.players[owner].base : this.unit(target)
    if (!damaged || amount <= 0) return
    if (owner !== undefined && spiceLocked(this.state)) {
      this.log(`${this.name(target)} can't be healed this round`, from?.controller)
      return
    }
    const healed = Math.min(amount, damaged.damage)
    damaged.damage -= healed
    this.log(`${from ? `${from.def.name} heals` : 'Healed'} ${healed} damage from ${this.name(target)}`, from?.controller)
    if (owner !== undefined && healed > 0) trigger(this.state, owner, 'whenBaseHealed')
  }
  // A unit an upgrade keeps from being defeated by enemy card abilities isn't; nor one a card
  // on its side keeps from being defeated by the card whose ability it is (`from`)
  defeat(unitId: string, from?: Self) {
    const unit = this.unit(unitId)
    if (!unit) return
    const p = controllerOf(this.state, unit)
    const safe = unit.upgrades.some((u) => scriptOf(this.state, u).cantBeDefeatedByEnemies) || !!unitScript(this.state, unit).cantBeDefeatedByEnemyAbilities
    if (safe && this.by !== undefined && this.by !== p) {
      this.log(`${nameOf(this.state, unit)} can't be defeated by enemy card abilities`)
      return
    }
    const guard = from && from.controller !== p && holders(this.state, p).find(({ self, abilities }) => abilities.cantBeDefeatedBy?.(this, self, from))
    if (guard) {
      this.log(`${guard.self.def.name}: ${nameOf(this.state, unit)} can't be defeated by ${from.def.name}`, p)
      return
    }
    defeatUnit(this.state, unit)
    checkDefeats(this.state)
  }
  defeatUpgrade(upgradeId: string) {
    for (const p of [0, 1] as const) {
      const base = this.state.players[p].base
      const upgrade = base.upgrades?.find((u) => u.id === upgradeId)
      if (!upgrade) continue
      base.upgrades = base.upgrades!.filter((u) => u !== upgrade)
      discardUpgrade(this.state, upgrade)
      this.log(`${nameOf(this.state, upgrade)} on ${nameOf(this.state, base)} is defeated`)
    }
    for (const unit of this.units()) {
      const upgrade = unit.upgrades.find((u) => u.id === upgradeId)
      if (!upgrade) continue
      unit.upgrades = unit.upgrades.filter((u) => u !== upgrade)
      discardUpgrade(this.state, upgrade)
      this.log(`${nameOf(this.state, upgrade)} on ${nameOf(this.state, unit)} is defeated`)
      if (def(this.state, upgrade).token && def(this.state, upgrade).name === 'Shield') shieldDefeated(this.state, unit)
      checkDefeats(this.state)
    }
  }
  // By an ability: logged (an attack's exhausting isn't)
  exhaust(unitId: string) {
    const unit = this.unit(unitId)
    if (!unit || unit.exhausted) return
    exhaustUnit(this.state, unit)
    this.log(`${nameOf(this.state, unit)} is exhausted`)
  }
  ready(unitId: string) {
    const unit = this.unit(unitId)
    if (unit && !this.state.held?.includes(unitId)) unit.exhausted = false
  }
  // "It can't ready this round (including during the regroup phase)."
  hold(unitId: string) {
    this.state.held = [...(this.state.held ?? []), unitId]
  }
  // +power/+HP to a unit, for this attack or this phase
  buff(unitId: string, power: number, hp: number, until: Effect['until']) {
    this.state.effects.push({ unit: unitId, power, hp, until })
    // -3/-3 can defeat it (Bo-Katan Kryze, Alone)
    if (hp < 0) checkDefeats(this.state)
  }
  pay(p: PlayerId, amount: number) {
    if (readyResources(this.state.players[p]) < amount) return false
    pay(this.state, p, amount)
    return true
  }
  canPay(p: PlayerId, amount: number) {
    return readyResources(this.state.players[p]) >= amount
  }
  draw(p: PlayerId, count: number) {
    draw(this.state, p, count)
    this.log(`${this.state.players[p].name} draws ${count === 1 ? 'a card' : `${count} cards`}`, p)
    checkDefeats(this.state)
  }
  // From a hand to its owner's discard pile
  discard(p: PlayerId, cardId: string) {
    const player = this.state.players[p]
    const card = player.hand.find((c) => c.id === cardId)
    if (!card) return
    player.hand = player.hand.filter((c) => c !== card)
    player.discard.push(card)
    if (this.state.handDiscards?.phase !== this.state.phaseCount) this.state.handDiscards = { phase: this.state.phaseCount, ids: [] }
    this.state.handDiscards.ids.push(card.id)
    this.log(`${player.name} discards ${nameOf(this.state, card)}`, p)
  }
  discardedFromHandThisPhase(cardId: string) {
    return this.state.handDiscards?.phase === this.state.phaseCount && this.state.handDiscards.ids.includes(cardId)
  }
  // Once a game (an Epic Action)
  usedOnce(self: Self, name = '') {
    return !!this.state.usedEver?.includes(onceKey(self, name))
  }
  useOnce(self: Self, name = '') {
    this.state.usedEver = [...(this.state.usedEver ?? []), onceKey(self, name)]
  }
  // Enemy cards (owner's) lose a trait for this phase
  loseTrait(owner: PlayerId, trait: string) {
    this.state.lostTraits = [...(this.state.lostTraits ?? []).filter((l) => l.phase === this.state.phaseCount), { owner, trait, phase: this.state.phaseCount }]
    this.log(`${this.state.players[owner].name}'s cards lose the ${trait} trait for this phase`)
  }
  // "That player discards a random card from their hand", by the game's seeded randomness
  discardRandom(p: PlayerId) {
    const hand = this.state.players[p].hand
    if (!hand.length) return undefined
    const card = hand[Math.floor(random(this.state) * hand.length)]
    this.discard(p, card.id)
    return card.id
  }
  // A player chooses cards from their own hand and discards them
  discardChosen(p: PlayerId, count: number, text = `Choose ${count === 1 ? 'a card' : `${count} cards`} to discard`, source?: string) {
    const hand = this.state.players[p].hand.map((c) => c.id)
    const picks = this.choose(p, text, hand, { min: count, max: count, ai: 'discard', source })
    for (const id of picks) this.discard(p, id)
    return picks.length
  }
  // The top cards of a deck, which stay there
  top(p: PlayerId, count: number) {
    return this.state.players[p].deck.slice(0, count)
  }
  toBottom(p: PlayerId, cardId: string) {
    const deck = this.state.players[p].deck
    const card = deck.find((c) => c.id === cardId)
    if (!card) return
    this.state.players[p].deck = [...deck.filter((c) => c !== card), card]
  }
  // Cards searched and not taken go to the bottom of the deck in a random order
  shuffleToBottom(p: PlayerId, cardIds: string[]) {
    const ids = cardIds.filter((id) => this.state.players[p].deck.some((c) => c.id === id))
    shuffle(this.state, ids)
    for (const id of ids) this.toBottom(p, id)
  }
  // From a deck to its discard pile
  mill(p: PlayerId, cardId: string) {
    const player = this.state.players[p]
    const card = player.deck.find((c) => c.id === cardId)
    if (!card) return
    player.deck = player.deck.filter((c) => c !== card)
    player.discard.push(card)
    this.log(`${player.name} discards ${nameOf(this.state, card)} from their deck`, p)
  }
  // From a hand to the top or bottom of its deck
  putBack(p: PlayerId, cardId: string, where: 'top' | 'bottom') {
    const player = this.state.players[p]
    const card = player.hand.find((c) => c.id === cardId)
    if (!card) return
    player.hand = player.hand.filter((c) => c !== card)
    if (where === 'top') player.deck.unshift(card)
    else player.deck.push(card)
    this.log(`${player.name} puts a card on the ${where} of their deck`, p)
  }
  // A card from a deck to its hand
  drawCard(p: PlayerId, cardId: string) {
    const player = this.state.players[p]
    const card = player.deck.find((c) => c.id === cardId)
    if (!card) return
    player.deck = player.deck.filter((c) => c !== card)
    player.hand.push(card)
    player.drawn++
    this.log(`${player.name} draws a card`, p)
  }
  // A card of a deck put on top of it
  toTop(p: PlayerId, cardId: string) {
    const deck = this.state.players[p].deck
    const card = deck.find((c) => c.id === cardId)
    if (card) this.state.players[p].deck = [card, ...deck.filter((c) => c !== card)]
  }

  // Tokens
  controlsArrakis(p: PlayerId) {
    return controlsArrakis(this.state, p)
  }
  spice(p: PlayerId) {
    return this.state.players[p].spice.length
  }
  createSpice(p: PlayerId, count = 1) {
    createSpice(this.state, p, count)
  }
  // Credit tokens (SWU)
  credits(p: PlayerId) {
    return this.state.players[p].credits?.length ?? 0
  }
  createCredit(p: PlayerId, count = 1) {
    createCredit(this.state, p, count)
  }
  defeatCredit(p: PlayerId, id?: string, by: PlayerId = p) {
    return defeatCredit(this.state, p, id, by)
  }
  // Take control of one of an opponent's Credit tokens (Lieutenant Gorn)
  takeCredit(from: PlayerId) {
    const token = this.state.players[from].credits?.[0]
    if (!token) return false
    const to = other(from)
    this.state.players[from].credits = this.state.players[from].credits!.slice(1)
    ;(this.state.players[to].credits ??= []).push(token)
    this.log(`${this.state.players[to].name} takes control of ${this.state.players[from].name}'s Credit token`, to)
    return true
  }
  // "Until the end of the round, Spice tokens can't be created and bases can't be healed."
  lockSpice() {
    this.state.spiceLock = this.state.round
    this.log("Until the end of the round, Spice tokens can't be created and bases can't be healed")
  }
  // A player's Spice token, this one or any, defeated by them or by the player named: whether
  // there was one to defeat
  defeatSpice(p: PlayerId, id?: string, by: PlayerId = p) {
    return defeatSpice(this.state, p, id, by)
  }
  spiceIds(p: PlayerId) {
    return this.state.players[p].spice.map((t) => t.id)
  }
  // A token unit (Fremen), exhausted unless readied: its id
  createToken(p: PlayerId, name: string, options: { ready?: boolean } = {}) {
    const unit = createUnitToken(this.state, p, name)
    if (options.ready) unit.exhausted = false
    return unit.id
  }
  // A token upgrade: Experience, Shield, Weakness
  giveToken(unitId: string, name: string, count = 1) {
    const unit = this.unit(unitId)
    if (!unit) return
    for (let i = 0; i < count; i++) giveToken(this.state, unit, name, i === 0)
    checkDefeats(this.state)
  }
  // The units that attacked this phase, in order
  attackedThisPhase() {
    return this.state.attackers?.phase === this.state.phaseCount ? [...this.state.attackers.units] : []
  }
  tokens(unitId: string, name: string) {
    const unit = this.unit(unitId)
    return unit ? unit.upgrades.filter((u) => this.def(u).token && this.def(u).name === name).length : 0
  }

  // "At the start of the next action phase, …": the card's later ability then, with data
  later(self: Self, data?: number) {
    this.state.later = [...(this.state.later ?? []), { player: self.controller, id: self.id, def: self.def.id, data }]
  }
  // A unit moving to the other arena ("You may move this unit to the ground arena")
  moveToArena(unitId: string, arena: 'ground' | 'space') {
    const unit = this.unit(unitId)
    if (!unit || unit.arena === arena) return false
    unit.arena = arena
    this.log(`${nameOf(this.state, unit)} moves to the ${arena} arena`, controllerOf(this.state, unit))
    return true
  }

  // The Force token (SWU): "The Force is with you" (one at most), and "use the Force" (lose it)
  hasForce(p: PlayerId) {
    return !!this.state.force?.[p]
  }
  forceIsWith(p: PlayerId) {
    if (this.hasForce(p)) return
    this.state.force = [...(this.state.force ?? [false, false])] as [boolean, boolean]
    this.state.force[p] = true
    this.log(`The Force is with ${this.player(p).name}`, p)
  }
  useForce(p: PlayerId) {
    if (!this.hasForce(p)) return false
    this.state.force = [...this.state.force!] as [boolean, boolean]
    this.state.force[p] = false
    this.log(`${this.player(p).name} uses the Force`, p)
    return true
  }

  // "Use this ability only once each round": whether it was, and using it
  used(self: Self, name = '') {
    return this.state.usedThisRound.includes(onceKey(self, name))
  }
  use(self: Self, name = '') {
    this.state.usedThisRound.push(onceKey(self, name))
  }

  // A player's leader: ready on its leader side, or as a unit; exhausting it
  leaderReady(p: PlayerId) {
    const player = this.state.players[p]
    return player.leader.deployed ? !this.unit(`L${p}`)?.exhausted : !player.leader.exhausted
  }
  exhaustLeader(p: PlayerId) {
    const player = this.state.players[p]
    if (player.leader.deployed) this.exhaust(`L${p}`)
    else player.leader.exhausted = true
  }
  // A keyword for a while: "gains [Raid 1] for this phase", or while a card stays in play
  // Keywords a unit loses for a while ("It loses [Sentinel] for this phase")
  strip(unitId: string, loses: (keyof Keywords)[], until: Effect['until']) {
    this.state.effects.push({ unit: unitId, power: 0, hp: 0, loses, until })
  }
  grant(unitId: string, keywords: Keywords, until: Effect['until'], source?: string, traits?: string[]) {
    this.state.effects.push({ unit: unitId, power: 0, hp: 0, keywords, until, ...(source && { source }), ...(traits && { traits }) })
  }
  // Control of a unit, for good or until the regroup phase starts
  takeControl(unitId: string, p: PlayerId, untilRegroup = false) {
    const unit = this.unit(unitId)
    if (!unit) return
    const before = controllerOf(this.state, unit)
    moveUnit(this.state, unit, p)
    if (untilRegroup && before !== p) this.state.borrowed.push({ unit: unitId, owner: unit.owner })
    checkUnique(this.state, p)
  }
  // An upgrade moved to another unit
  moveUpgrade(upgradeId: string, unitId: string) {
    const to = this.unit(unitId)
    const from = this.units((u) => u.upgrades.some((up) => up.id === upgradeId))[0]
    if (!to || !from) return
    const upgrade = from.upgrades.find((u) => u.id === upgradeId)!
    from.upgrades = from.upgrades.filter((u) => u !== upgrade)
    this.state.effects = this.state.effects.filter((e) => e.source !== upgrade.id)
    to.upgrades.push(upgrade)
    this.log(`${nameOf(this.state, upgrade)} moves to ${nameOf(this.state, to)}`)
    upgradeAttached(this.state, to, upgrade.id)
    checkDefeats(this.state)
  }
  // A unit out of play to the bottom of its owner's deck (its upgrades discarded)
  // Its owner puts it on the top or the bottom of their deck (a token is set aside)
  toDeck(unitId: string, where: 'top' | 'bottom') {
    const unit = this.unit(unitId)
    if (!unit) return
    if (where === 'bottom') return this.toDeckBottom(unitId)
    const p = controllerOf(this.state, unit)
    this.state.players[p].units = this.state.players[p].units.filter((u) => u !== unit)
    rescueAll(this.state, unit)
    this.state.effects = this.state.effects.filter((e) => e.unit !== unit.id)
    for (const upgrade of unit.upgrades) discardUpgrade(this.state, upgrade)
    if (!this.def(unit).token) this.state.players[unit.owner].deck.unshift({ id: unit.id, def: unit.def })
    this.log(`${nameOf(this.state, unit)} goes on top of ${this.state.players[unit.owner].name}'s deck`, p)
  }
  // The units that attacked this player's base this phase
  attackedBase(p: PlayerId) {
    return this.state.attackers?.phase === this.state.phaseCount ? (this.state.attackers.bases ?? []).filter((b) => b.base === p).map((b) => b.unit) : []
  }
  enteredThisPhase(unit: UnitState) {
    return unit.entered === this.state.phaseCount
  }
  // Its combat damage, dealt and taken, prevented for this phase
  preventCombat(unitId: string) {
    this.state.noCombat = [...(this.state.noCombat ?? []).filter((n) => n.phase === this.state.phaseCount), { unit: unitId, phase: this.state.phaseCount }]
    this.log(`Combat damage dealt to and by ${this.name(unitId)} is prevented this phase`)
  }
  // "Name a card": each non-leader card the opponent owns with this name loses all abilities while
  // this unit is in play
  nameCard(self: Self, name: string) {
    this.state.named = [...(this.state.named ?? []).filter((n) => findUnit(this.state, n.unit)), { unit: self.id, name }]
    this.log(`${this.state.players[self.controller].name} names ${name}`, self.controller)
  }
  toDeckBottom(unitId: string) {
    const unit = this.unit(unitId)
    if (!unit) return
    const p = controllerOf(this.state, unit)
    this.state.players[p].units = this.state.players[p].units.filter((u) => u !== unit)
    rescueAll(this.state, unit)
    this.state.effects = this.state.effects.filter((e) => e.unit !== unit.id)
    for (const upgrade of unit.upgrades) discardUpgrade(this.state, upgrade)
    if (!this.def(unit).token) this.state.players[unit.owner].deck.push({ id: unit.id, def: unit.def })
    this.log(`${nameOf(this.state, unit)} goes to the bottom of ${this.state.players[unit.owner].name}'s deck`, p)
  }
  // From a discard pile to the bottom of its deck
  discardToBottom(p: PlayerId, cardId: string) {
    const player = this.state.players[p]
    const card = player.discard.find((c) => c.id === cardId)
    if (!card) return
    player.discard = player.discard.filter((c) => c !== card)
    player.deck.push(card)
  }
  // "The next [{Bene Gesserit}] card you play this phase costs [2] less."
  discountNext(p: PlayerId, trait: string, amount: number) {
    this.state.discounts.push({ player: p, trait, amount })
  }
  // "This phase, opponents can't play the named card."
  ban(p: PlayerId, name: string) {
    this.state.banned.push({ player: p, name })
    this.log(`${this.state.players[p].name} can't play ${name} this phase`)
  }
  // "For this phase, you may play a unit with that name from your discard pile for free."
  awaken(p: PlayerId, name: string) {
    this.state.awakened = [...(this.state.awakened ?? []), { player: p, name }]
    this.log(`${this.state.players[p].name} may play ${name} from their discard pile for free this phase`, p)
  }
  // Defeated when the next regroup phase starts
  doom(unitId: string) {
    if (!this.state.doomed.includes(unitId)) this.state.doomed.push(unitId)
  }
  // A card from a player's discard pile onto a unit as an upgrade, not played
  attachFromDiscard(p: PlayerId, cardId: string, unitId: string) {
    const player = this.state.players[p]
    const card = player.discard.find((c) => c.id === cardId)
    const unit = this.unit(unitId)
    if (!card || !unit) return
    player.discard = player.discard.filter((c) => c !== card)
    unit.upgrades.push({ ...card, owner: p })
    this.log(`${nameOf(this.state, card)} is attached to ${nameOf(this.state, unit)}`, p)
    // A unique card attached beside a copy already in play (a second Ramallo): one is defeated
    checkUnique(this.state, p)
  }
  // Whether a unit of a player's like this was defeated this phase ("If a friendly [{Fremen}]
  // unit was defeated this phase"), a token too
  fellThisPhase(p: PlayerId, test: (card: CardDef) => boolean) {
    return (this.state.fallen ?? []).some((f) => f.player === p && test(def(this.state, f)))
  }
  defeatedThisPhase(cardId: string) {
    return this.state.defeatedThisPhase.includes(cardId)
  }
  traits(unit: UnitState) {
    return traitsOf(this.state, unit)
  }
  // To its owner's hand; a leader unit is defeated instead (3.4.6), a token set aside (3.7.3)
  // An upgrade back to its owner's hand (Liberty); a token one is set aside (3.7)
  upgradeToHand(upgradeId: string) {
    for (const unit of this.units()) {
      const upgrade = unit.upgrades.find((u) => u.id === upgradeId)
      if (!upgrade) continue
      unit.upgrades = unit.upgrades.filter((u) => u !== upgrade)
      this.state.effects = this.state.effects.filter((e) => e.source !== upgrade.id)
      if (this.def(upgrade).token) this.log(`${nameOf(this.state, upgrade)} on ${nameOf(this.state, unit)} is set aside`)
      else {
        this.state.players[upgrade.owner].hand.push({ id: upgrade.id, def: upgrade.def })
        this.log(`${nameOf(this.state, upgrade)} returns to ${this.state.players[upgrade.owner].name}'s hand`)
      }
      checkDefeats(this.state)
    }
  }
  // Rule 33.1: a unit captures another, face down under it: its damage gone, its upgrades
  // defeated, out of play (no When Defeated); a token captured is set aside (33.5)
  capture(guardId: string, unitId: string) {
    const guard = this.unit(guardId)
    const unit = this.unit(unitId)
    if (!guard || !unit || unit.leader) return
    const p = controllerOf(this.state, unit)
    this.state.players[p].units = this.state.players[p].units.filter((u) => u !== unit)
    rescueAll(this.state, unit)
    this.state.effects = this.state.effects.filter((e) => e.unit !== unit.id)
    for (const upgrade of unit.upgrades) discardUpgrade(this.state, upgrade)
    if (!this.def(unit).token) guard.captured = [...(guard.captured ?? []), { id: unit.id, def: unit.def, owner: unit.owner }]
    this.log(`${nameOf(this.state, guard)} captures ${nameOf(this.state, unit)}`, controllerOf(this.state, guard))
  }
  returnToHand(unitId: string) {
    const unit = this.unit(unitId)
    if (!unit) return
    if (unit.leader) return this.defeat(unitId)
    const p = controllerOf(this.state, unit)
    this.state.players[p].units = this.state.players[p].units.filter((u) => u !== unit)
    rescueAll(this.state, unit)
    this.state.effects = this.state.effects.filter((e) => e.unit !== unit.id)
    for (const upgrade of unit.upgrades) discardUpgrade(this.state, upgrade)
    if (!this.def(unit).token) this.state.players[unit.owner].hand.push({ id: unit.id, def: unit.def })
    this.log(`${nameOf(this.state, unit)} returns to ${this.state.players[unit.owner].name}'s hand`, p)
  }
  // From a discard pile to its hand
  fromDiscard(p: PlayerId, cardId: string) {
    const player = this.state.players[p]
    const card = player.discard.find((c) => c.id === cardId)
    if (!card) return
    player.discard = player.discard.filter((c) => c !== card)
    player.hand.push(card)
    this.log(`${player.name} returns ${nameOf(this.state, card)} from their discard pile to their hand`, p)
  }
  // The top card of a deck put into play as a resource, exhausted (2.4.1b)
  resourceFromDeck(p: PlayerId) {
    const player = this.state.players[p]
    const card = player.deck.shift()
    if (!card) return
    player.resources.push({ card, exhausted: true })
    this.log(`${player.name} puts the top card of their deck into play as a resource`, p)
  }

  // Playing a card for an ability: from the hand, the discard pile, or the resources (as if
  // using Plot, or using Smuggle), the ability changing what it costs. Whether it could be.
  private placeOf(p: PlayerId, cardId: string, smuggle?: boolean): PlayedFrom | undefined {
    const player = this.state.players[p]
    if (player.hand.some((c) => c.id === cardId)) return 'hand'
    if (player.discard.some((c) => c.id === cardId)) return 'discard'
    if (player.deck.some((c) => c.id === cardId)) return 'deck'
    if (player.resources.some((r) => r.card.id === cardId)) return smuggle ? 'smuggle' : 'plot'
    return undefined
  }
  // A card's aspect penalty for its player (Aldhani Garrison ignores one)
  penalty(p: PlayerId, cardId: string) {
    const card = this.cardInfo(cardId)
    return card ? aspectPenalty(this.state, p, this.def(card)) : 0
  }
  readyResources(p: PlayerId) {
    return readyResources(this.state.players[p])
  }
  // What a card costs its player to play now, from where it is
  price(p: PlayerId, cardId: string, options: PlayOptions & { smuggle?: boolean } = {}) {
    const from = this.placeOf(p, cardId, options.smuggle)
    const card = this.cardInfo(cardId)
    return from && card ? priceOf(this.state, p, this.def(card), from, options) : 0
  }
  // "Play it now?": the question, answered yes by clicking the card, which then is played
  mayPlay(p: PlayerId, cardId: string, text: string, options: PlayOptions & { source?: string } = {}) {
    if (!this.canPlay(p, cardId, options)) return false
    const { source, ...play } = options
    if (!this.may(p, text, { yes: 'Play it', no: 'Keep it', source, play: { card: cardId, cost: this.price(p, cardId, play) } })) return false
    this.playCard(p, cardId, play)
    return true
  }
  // onto: the units an upgrade may go on ("attached to this unit")
  canPlay(p: PlayerId, cardId: string, options: PlayOptions & { smuggle?: boolean; onto?: string[] } = {}) {
    const from = this.placeOf(p, cardId, options.smuggle)
    const card = this.cardInfo(cardId)
    if (!from || !card) return false
    const d = this.def(card)
    if (d.token || d.type === 'leader' || d.type === 'base') return false
    if (from === 'smuggle' && d.keywords.smuggle === undefined) return false
    if (isBanned(this.state, p, d)) return false
    const slot = this.state.players[p].resources.find((r) => r.card.id === cardId)
    const ready = readyResources(this.state.players[p])
    const price =
      (d.type === 'upgrade' && !d.keywords.fortify ? upgradePrice(this.state, p, d, from, options, options.onto) : priceOf(this.state, p, d, from, options)) -
      spiceRoom(this.state, p, d)
    if (price > ready) return false
    if (!options.ignoreAdditional && !canPayAdditional(this.state, p, d)) return false
    // 7.5.21b: a Fortification needs no unit to attach to
    if (d.type === 'upgrade' && !d.keywords.fortify && !this.attachable(p, d, options.onto).length) return false
    return slot ? true : price <= ready
  }
  playCard(p: PlayerId, cardId: string, options: PlayOptions & { smuggle?: boolean; onto?: string[] } = {}) {
    if (!this.canPlay(p, cardId, options)) return false
    const from = this.placeOf(p, cardId, options.smuggle) as PlayedFrom
    const d = this.def(this.cardInfo(cardId)!)
    let attachTo: string | undefined
    if (d.keywords.fortify) attachTo = baseId(p)
    else if (d.type === 'upgrade') {
      // Onto a unit it can be paid for on (its cost may depend on the unit)
      const room = readyResources(this.state.players[p]) + spiceRoom(this.state, p, d)
      const units = this.attachable(p, d, options.onto).filter((u) => priceOf(this.state, p, d, from, { ...options, target: u }) <= room)
      const prefer = options.prefer && units.includes(options.prefer) ? options.prefer : undefined
      attachTo = this.chooseOne(p, `Choose a unit for ${d.name}`, units, { ai: prefer ?? 'help', ...(prefer && { firm: true }), source: d.id }) ?? undefined
      if (!attachTo) return false
    }
    playCard(this.state, p, cardId, attachTo, from, options)
    return true
  }
  // The units an upgrade may be attached to, among these if given
  attachable(p: PlayerId, card: CardDef, onto?: string[]) {
    return this.units((u) => canAttach(this.state, p, card, u) && (!onto || onto.includes(u.id))).map((u) => u.id)
  }

  // What a unit may attack, if it can attack at all: ready (unless the ability says it may be
  // exhausted) and with something to attack
  attackable(unitId: string, options: { exhausted?: boolean; noBases?: boolean } = {}) {
    const unit = this.unit(unitId)
    if (!unit || (unit.exhausted && !options.exhausted)) return []
    return attackTargets(this.state, controllerOf(this.state, unit), unit).filter((t) => !(options.noBases && t === 'base'))
  }
  canAttack(unitId: string, options: { exhausted?: boolean; noBases?: boolean } = {}) {
    return this.attackable(unitId, options).length > 0
  }

  // Attack with a unit, its controller choosing what it attacks. The unit may be exhausted
  // when the ability says so.
  attackWith(unitId: string, options: AttackOptions & { exhausted?: boolean; noBases?: boolean } = {}) {
    const unit = this.unit(unitId)
    if (!unit) return false
    const p = controllerOf(this.state, unit)
    const targets = this.attackable(unitId, options)
    const ids = targets.map((t) => (t === 'base' ? baseId(other(p)) : t))
    const race = racesBase(this.state, unit) ? raceTarget(this.state, targets) : undefined
    const ai = race === undefined ? 'harm' : race === 'base' ? baseId(other(p)) : race
    const pick = this.chooseOne(p, `Choose what ${nameOf(this.state, unit)} attacks`, ids, { ai, firm: race !== undefined })
    if (!pick) return false
    attack(this.state, p, unitId, baseOwner(pick) !== undefined ? 'base' : pick, options)
    return true
  }
}
