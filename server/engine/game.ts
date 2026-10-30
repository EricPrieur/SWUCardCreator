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
  type Prompt,
  type UnitState,
} from './types.ts'
import { builtInTokens } from './cards.ts'
import { abilitiesOf, type Abilities, type Ability, type Grant, type Self } from './scripts.ts'

// Rule numbers below are those of the Comprehensive Rules v9.0

const HAND_SIZE = 6
const EMPTY_DECK_DAMAGE = 3

export type DeckList = { name: string; leader: string; base: string; deck: string[] }

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
const log = (state: GameState, text: string, player?: PlayerId) => state.log.push({ player, text })
const nameOf = (state: GameState, inst: { def: string }) => def(state, inst).name
// A base, as a prompt or an ability names it
export const baseId = (p: PlayerId) => `base${p}`
const baseOwner = (id: string): PlayerId | undefined => (id === 'base0' ? 0 : id === 'base1' ? 1 : undefined)
// The Fortifications on a player's base
export const baseUpgrades = (state: GameState, p: PlayerId) => (state.players[p].base.upgrades ??= [])

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
    defeatedThisPhase: [],
    borrowed: [],
    doomed: [],
    attack: null,
    revealed: [null, null],
    prompt: null,
    pending: null,
  }
  options.decks.forEach((list, p) => {
    for (const id of [list.leader, list.base, ...list.deck]) if (!defs[id]) throw new Error(`Unknown card ${id}`)
    const deck = list.deck.map((id) => ({ id: `c${state.nextId++}`, def: id }))
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
  const provided = [...def(state, player.leader).aspects, ...def(state, player.base).aspects]
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
  const gained = grantsTo(state, unit).flatMap((grant) => grant.traits ?? [])
  return [...new Set([...def(state, unit).traits, ...gained])]
}

// Printed keywords; those gained with an Arrakis base, from upgrades, for a while, from other cards
export function keywordsOf(state: GameState, unit: UnitState): Keywords {
  const card = def(state, unit)
  const keywords: Keywords = { ...((unit.leader ? card.unit?.keywords : card.keywords) ?? {}) }
  const gained = unit.leader ? card.unit?.arrakisKeywords : card.arrakisKeywords
  if (gained && controlsArrakis(state, controllerOf(state, unit))) addKeywords(keywords, gained)
  for (const upgrade of unit.upgrades) addKeywords(keywords, def(state, upgrade).attachedKeywords)
  for (const effect of effectsOn(state, unit)) addKeywords(keywords, effect.keywords)
  for (const grant of grantsTo(state, unit)) addKeywords(keywords, grant.keywords)
  return keywords
}

export function hpOf(state: GameState, unit: UnitState) {
  const card = def(state, unit)
  const printed = unit.leader ? (card.unit?.hp ?? 0) : card.hp
  return (
    printed +
    unit.upgrades.reduce((sum, u) => sum + def(state, u).hp, 0) +
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
      unit.upgrades.reduce((sum, u) => sum + def(state, u).power, 0) +
      effectsOn(state, unit).reduce((sum, e) => sum + e.power, 0) +
      grantsTo(state, unit).reduce((sum, grant) => sum + (grant.power ?? 0), 0) +
      (keywords.grit ? unit.damage : 0) +
      (attacking ? (keywords.raid ?? 0) : 0),
  )
}

const readyResources = (player: PlayerState) => player.resources.filter((r) => !r.exhausted).length

function pay(player: PlayerState, amount: number) {
  for (const resource of player.resources) {
    if (amount <= 0) break
    if (!resource.exhausted) {
      resource.exhausted = true
      amount--
    }
  }
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

function createSpice(state: GameState, p: PlayerId, count = 1) {
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
  queueAmbush(state, p, unit)
  trigger(state, p, 'whenYouCreate', { other: unit.id, otherDef: token }, unit.id)
  return unit
}

function giveToken(state: GameState, unit: UnitState, name: string) {
  const token = tokenDef(state, name)
  unit.upgrades.push({ id: `k${state.nextId++}`, def: token.id, owner: controllerOf(state, unit) })
  log(state, `${nameOf(state, unit)} gets ${/^[AEIOU]/.test(name) ? 'an' : 'a'} ${name} token`, controllerOf(state, unit))
}

// Damage to a unit, unless a Shield token on it prevents it and is defeated instead, one Shield
// for each time damage is dealt (3.7.6): the damage dealt
function damageUnit(state: GameState, unit: UnitState, amount: number) {
  if (amount <= 0) return 0
  const shield = unit.upgrades.find((u) => def(state, u).token && def(state, u).name === 'Shield')
  if (shield) {
    unit.upgrades = unit.upgrades.filter((u) => u !== shield)
    log(state, `A Shield token prevents the damage to ${nameOf(state, unit)}`, controllerOf(state, unit))
    return 0
  }
  unit.damage += amount
  return amount
}

// An upgrade leaving play: to its owner's discard pile, a token set aside (3.7.3)
function discardUpgrade(state: GameState, upgrade: Inst & { owner: PlayerId }) {
  state.effects = state.effects.filter((e) => e.source !== upgrade.id)
  if (!def(state, upgrade).token) state.players[upgrade.owner].discard.push({ id: upgrade.id, def: upgrade.def })
}

// Exhausting a unit, which an upgrade on it may wait for (Gom Jabbar)
function exhaustUnit(state: GameState, unit: UnitState) {
  if (unit.exhausted) return
  unit.exhausted = true
  const p = controllerOf(state, unit)
  for (const upgrade of unit.upgrades)
    queue(state, p, nameOf(state, upgrade), scriptOf(state, upgrade).whenAttachedExhausted, {
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
type Trigger = { player: PlayerId; label: string; run: () => void }

// The action being played: the answers it has, the next to hand out, the abilities triggered.
// One action at a time, start to end in one go, so it can live outside the game state.
type Run = { answers: string[][]; next: number; queue: Trigger[] }
let current: Run | null = null

function ask(prompt: Prompt): string[] {
  const run = current as Run
  if (run.next < run.answers.length) return run.answers[run.next++]
  throw new Pause(prompt)
}

// Outside an action (as the game is set up) nothing triggers
function queue(state: GameState, player: PlayerId, source: string, ability: Ability | undefined, self: Self) {
  if (!ability || !current) return
  current.queue.push({ player, label: source, run: () => ability(new Game(state, player), self) })
}

// The abilities a card has where it is: a unit's, a leader's unit side's once deployed, a
// leader side's
function scriptOf(state: GameState, inst: { def: string }, side: 'front' | 'back' = 'front'): Abilities {
  return abilitiesOf(def(state, inst), side)
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
      list.push({ self: { id: upgrade.id, controller: p, def: def(state, upgrade), attachedTo: unit.id }, abilities: scriptOf(state, upgrade) })
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
  | 'whenFriendlyAttacks'
  | 'whenEnemyAttacks'
  | 'whenCombatDamageBase'
  | 'regroupStart'

// An event on a player's side, which the abilities there that wait for it resolve after
function trigger(state: GameState, p: PlayerId, hook: Hook, extra: Partial<Self> = {}, except?: string) {
  for (const { self, abilities } of holders(state, p)) {
    if (self.id === except) continue
    const triggered = { ...self, ...extra }
    if (abilities.triggersIf?.[hook]?.(new Game(state, p), triggered) === false) continue
    queue(state, p, self.def.name, abilities[hook], triggered)
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
    let next = mine[0]
    // The same ability more than once (one for each Fremen token created) needs no order
    if (new Set(mine.map((t) => t.label)).size > 1) {
      const [pick] = ask({
        player: next.player,
        kind: 'option',
        text: 'Choose the ability to resolve first',
        options: mine.map((t, i) => ({ id: String(i), label: t.label })),
        min: 1,
        max: 1,
        ai: '0',
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
  for (const p of [0, 1] as const) {
    for (const unit of [...state.players[p].units]) if (unit.damage >= hpOf(state, unit)) defeatUnit(state, unit)
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
    const keep = g.chooseOne(p, `${name} is unique: choose the copy to keep, the other is defeated`, ids, { ai: 'help' }) ?? ids[ids.length - 1]
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

function defeatUnit(state: GameState, unit: UnitState) {
  const p = controllerOf(state, unit)
  const player = state.players[p]
  player.units = player.units.filter((u) => u !== unit)
  state.effects = state.effects.filter((e) => e.unit !== unit.id)
  // What an upgrade gives the unit it is on: "Attached unit gains: [When Defeated:] …"
  for (const upgrade of unit.upgrades)
    queue(state, p, nameOf(state, upgrade), scriptOf(state, upgrade).attachedWhenDefeated, {
      id: upgrade.id,
      controller: p,
      def: def(state, upgrade),
      attachedTo: unit.id,
    })
  for (const upgrade of unit.upgrades) discardUpgrade(state, upgrade)
  if (unit.leader) {
    player.leader.deployed = false
    player.leader.exhausted = true
  } else if (!def(state, unit).token) {
    state.players[unit.owner].discard.push({ id: unit.id, def: unit.def })
    state.defeatedThisPhase.push(unit.id)
  }
  log(state, `${nameOf(state, unit)} is defeated`, p)
  // A unit defeated in an attack knows it: "If this unit was defending, …"
  const inAttack = state.attack && (state.attack.attacker === unit.id || state.attack.target === unit.id) ? state.attack : undefined
  queue(state, p, nameOf(state, unit), unitScript(state, unit).whenDefeated, {
    id: unit.id,
    controller: p,
    def: def(state, unit),
    ...(inAttack && { attack: { ...inAttack } }),
  })
  trigger(state, p, 'whenFriendlyDefeated', { other: unit.id, otherDef: def(state, unit) })
}

function heal(state: GameState, p: PlayerId, amount: number) {
  const base = state.players[p].base
  base.damage = Math.max(0, base.damage - amount)
}

// 8.6: drawing from an empty deck deals 3 damage to your base instead
function draw(state: GameState, p: PlayerId, count: number) {
  const player = state.players[p]
  for (let i = 0; i < count; i++) {
    const card = player.deck.shift()
    if (card) {
      player.hand.push(card)
      player.drawn++
    } else player.base.damage += EMPTY_DECK_DAMAGE
  }
}

// --- What a player may do ---

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
  return [...enemies.filter(allowed).map((u) => u.id), 'base']
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
  const plays = (card: Inst, from: PlayedFrom, spice = false) => {
    const d = def(state, card)
    if (isBanned(state, p, d)) return
    if (spice) {
      if (!player.spice.length) return
    } else if (priceOf(state, p, d, from) - spiceRoom(state, p, d) > ready || !canPayAdditional(state, p, d)) return
    const extra = { ...(from === 'smuggle' && { smuggle: true }), ...(from === 'discard' && { discard: true }), ...(spice && { spice: true }) }
    const fromDiscard = from === 'discard' ? scriptOf(state, card).discardPlay : undefined
    const self: Self = { id: card.id, controller: p, def: d }
    if (d.keywords.fortify) {
      if (!fromDiscard || fromDiscard(g, self)) actions.push({ type: 'play', card: card.id, attachTo: baseId(p), ...extra })
    } else if (d.type === 'upgrade') {
      for (const unit of units)
        if (canAttach(state, p, d, unit) && (!fromDiscard || fromDiscard(g, self, unit)))
          actions.push({ type: 'play', card: card.id, attachTo: unit.id, ...extra })
    } else if (!fromDiscard || fromDiscard(g, self)) {
      actions.push({ type: 'play', card: card.id, ...extra })
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
  }
  for (const unit of player.units) {
    if (unit.exhausted) continue
    for (const target of attackTargets(state, p, unit)) actions.push({ type: 'attack', attacker: unit.id, target })
  }
  // 3.4.4: the Epic Action deploys the leader once you control enough resources
  const leader = def(state, player.leader)
  if (!player.leader.deployed && !player.leader.epicUsed && player.resources.length >= leader.cost)
    actions.push({ type: 'deploy' })
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
  if (game.prompt) {
    if (action.type !== 'answer' || p !== game.prompt.player) throw new IllegalAction('An answer is awaited')
    checkAnswer(game.prompt, action.picks)
    const pending = game.pending as NonNullable<GameState['pending']>
    return play(pending.base, pending.player, pending.action, [...pending.answers, action.picks])
  }
  const legal = legalActions(game, p)
  // A resource choice may list its cards in any order
  const normal = action.type === 'resource' ? { ...action, cards: [...action.cards].sort() } : action
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
    case 'play':
      playCard(state, p, action.card, action.attachTo, action.smuggle ? 'smuggle' : action.discard ? 'discard' : 'hand', {
        spiceInstead: action.spice,
      })
      state.passes = 0
      break
    case 'attack':
      attack(state, p, action.attacker, action.target)
      state.passes = 0
      break
    case 'deploy':
      deploy(state, p)
      state.passes = 0
      break
    case 'ability':
      useAbility(state, p, action.source, action.index)
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
  for (const q of [0, 1] as const) draw(state, q, HAND_SIZE)
  state.phase = 'mulligan'
}

function mulligan(state: GameState, p: PlayerId, take: boolean) {
  const player = state.players[p]
  if (take) {
    player.deck.push(...player.hand)
    player.hand = []
    shuffle(state, player.deck)
    player.hand = player.deck.splice(0, HAND_SIZE)
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
    for (const unit of pl.units) unit.exhausted = false
    for (const resource of pl.resources) resource.exhausted = false
    pl.leader.exhausted = false
  }
  state.round++
  state.usedThisRound = []
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
  state.defeatedThisPhase = []
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
type PlayedFrom = 'hand' | 'discard' | 'smuggle' | 'plot' | 'deck'

// What an ability changes in the cost of a card it plays: "It costs [1] less", "for free"
// (which leaves additional costs to pay, 1.8), "ignoring its additional costs"
// spiceInstead: "for free by defeating a friendly Spice token"
type PlayOptions = { discount?: number; free?: boolean; ignoreAdditional?: boolean; spiceInstead?: boolean }

// The next card of a trait a player plays this phase costs less (Bene Gesserit Sister)
const discountFor = (state: GameState, p: PlayerId, card: CardDef) =>
  state.discounts.find((d) => d.player === p && card.traits.includes(d.trait))

// "[Creature] cards you play cost [1] less.": what the cards on a player's side take off
function costsLess(state: GameState, p: PlayerId, card: CardDef) {
  const g = new Game(state)
  return holders(state, p).reduce((sum, { self, abilities }) => sum + (abilities.costsLess?.(g, self, card) ?? 0), 0)
}

function priceOf(state: GameState, p: PlayerId, card: CardDef, from: PlayedFrom, options: PlayOptions = {}) {
  if (options.free || options.spiceInstead) return 0
  const cost = from === 'smuggle' ? smuggleCost(state, p, card) : playCost(state, p, card)
  return Math.max(0, cost - (options.discount ?? 0) - (discountFor(state, p, card)?.amount ?? 0) - costsLess(state, p, card))
}

// What a card in a player's hand costs them to play now: its cost, aspects missing and
// discounts counted
export const handPrice = (state: GameState, p: PlayerId, card: CardDef) => priceOf(state, p, card, 'hand')

// How much less a card may cost for the Spice tokens defeated as it is played (CHOAM Dividend,
// Guild Heighliner)
const spiceRoom = (state: GameState, p: PlayerId, card: CardDef) =>
  Math.min(state.players[p].spice.length - (card.spiceCost ?? 0), abilitiesOf(card, 'front').spiceReduces ?? 0)

// A card name opponents can't play this phase (The Voice)
const isBanned = (state: GameState, p: PlayerId, card: CardDef) => state.banned.some((b) => b.player === p && b.name === card.name)

// An upgrade's "Attach to a friendly unit." or "Attach to a non-[{Vehicle}] unit."
function canAttach(state: GameState, p: PlayerId, card: CardDef, unit: UnitState) {
  if (card.attach?.friendly && controllerOf(state, unit) !== p) return false
  if (card.attach?.nonLeader && unit.leader) return false
  const traits = traitsOf(state, unit)
  if (card.attach?.not?.some((trait) => traits.includes(trait))) return false
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
  let card: Inst
  if (from === 'hand' || from === 'discard' || from === 'deck') {
    const zones = { hand: player.hand, discard: player.discard, deck: player.deck }
    card = zones[from].find((c) => c.id === id) as Inst
    payFor(state, p, def(state, card), priceOf(state, p, def(state, card), from, options))
    if (from === 'hand') player.hand = player.hand.filter((c) => c !== card)
    else if (from === 'discard') player.discard = player.discard.filter((c) => c !== card)
    else player.deck = player.deck.filter((c) => c !== card)
  } else {
    // 7.5.14e-g, 7.5.19c: the card helps pay for itself, and the top card of the deck takes its
    // place, exhausted (none when the deck is empty)
    const slot = player.resources.find((r) => r.card.id === id) as PlayerState['resources'][number]
    card = slot.card
    let cost = priceOf(state, p, def(state, card), from, options)
    if (cost > 0 && !slot.exhausted) {
      slot.exhausted = true
      cost--
    }
    payFor(state, p, def(state, card), cost)
    const top = player.deck.shift()
    if (top) player.resources[player.resources.indexOf(slot)] = { card: top, exhausted: true }
    else player.resources = player.resources.filter((r) => r !== slot)
  }
  const d = def(state, card)
  const discount = discountFor(state, p, d)
  if (discount && !options.free && !options.spiceInstead) state.discounts = state.discounts.filter((x) => x !== discount)
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
  if (d.type === 'unit') {
    // 3.5.3: a unit enters play exhausted
    const unit: UnitState = { ...card, owner: p, arena: d.arena ?? 'ground', damage: 0, exhausted: true, upgrades: [], entered: state.phaseCount }
    player.units.push(unit)
    log(state, `${player.name} plays ${d.name}${using}`, p)
    queue(state, p, d.name, scriptOf(state, card).whenPlayed, self)
    queueAmbush(state, p, unit)
  } else if (d.keywords.fortify) {
    // 7.5.21: onto its player's own base
    baseUpgrades(state, p).push({ ...card, owner: p })
    log(state, `${player.name} attaches ${d.name} to ${nameOf(state, player.base)}${using}`, p)
    queue(state, p, d.name, scriptOf(state, card).whenPlayed, { ...self, other: baseId(p), attachedTo: baseId(p) })
  } else if (d.type === 'upgrade') {
    const unit = findUnit(state, attachTo as string) as UnitState
    unit.upgrades.push({ ...card, owner: p })
    log(state, `${player.name} attaches ${d.name} to ${nameOf(state, unit)}${using}`, p)
    queue(state, p, d.name, scriptOf(state, card).whenPlayed, { ...self, other: unit.id })
  } else {
    // An event resolves its text, then goes to the discard pile
    log(state, `${player.name} plays ${d.name}${using}`, p)
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
  checkDefeats(state)
  resolveTriggers(state)
}

// Paying for a card: the Spice tokens that may make it cheaper defeated first, as many as its
// controller chooses (the AI as few as it needs)
function payFor(state: GameState, p: PlayerId, card: CardDef, price: number) {
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
  pay(state.players[p], price - spent)
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
      const good = targets
        .map((t) => findUnit(state, t) as UnitState)
        .filter((t) => powerOf(state, still, true) >= left(t) || powerOf(state, t) < left(still))
        .sort((a, b) => def(state, b).cost - def(state, a).cost)[0]
      const pick = new Game(state).chooseOne(p, `${nameOf(state, still)}: Ambush, choose an enemy unit to attack`, targets, {
        optional: true,
        ai: good?.id ?? 'none',
        source: still.def,
      })
      if (pick) attack(state, p, still.id, pick)
    },
  })
}

// Plot (7.5.19): when you deploy a leader, play any of your Plot cards from your resources, one
// after the other, each paid for in full
function queuePlots(state: GameState, p: PlayerId) {
  const player = state.players[p]
  if (!player.resources.some((r) => def(state, r.card).keywords.plot)) return
  ;(current as Run).queue.push({
    player: p,
    label: 'Plot',
    run: () => {
      const g = new Game(state)
      for (;;) {
        const ids = player.resources.map((r) => r.card.id).filter((id) => g.def(g.card(id)!).keywords.plot && g.canPlay(p, id))
        const id = g.chooseOne(p, 'Plot: choose a card to play from your resources', ids, { optional: true, ai: ids[0] })
        if (!id || !g.playCard(p, id)) return
      }
    },
  })
}

// What an attack may do differently, for an ability that makes one
type AttackOptions = { power?: number; firstStrike?: boolean }

// 6.3: exhaust the attacker, resolve its On Attack abilities and those it triggers, then both
// deal their damage at once
function attack(state: GameState, p: PlayerId, attackerId: string, target: string | 'base', options: AttackOptions = {}) {
  const player = state.players[p]
  const enemy = state.players[other(p)]
  const attacker = findUnit(state, attackerId) as UnitState
  const outer = state.attack
  state.attack = { attacker: attackerId, target }
  if (options.power) state.effects.push({ unit: attackerId, power: options.power, hp: 0, until: 'attack' })
  if (options.firstStrike) state.effects.push({ unit: attackerId, power: 0, hp: 0, keywords: { firstStrike: true }, until: 'attack' })
  const defenderName = target === 'base' ? nameOf(state, enemy.base) : nameOf(state, findUnit(state, target) as UnitState)
  log(state, `${player.name} attacks ${defenderName} with ${nameOf(state, attacker)}`, p)
  exhaustUnit(state, attacker)
  const self: Self = { id: attackerId, controller: p, def: def(state, attacker), attack: { attacker: attackerId, target } }
  queue(state, p, nameOf(state, attacker), unitScript(state, attacker).onAttack, self)
  trigger(state, p, 'whenFriendlyAttacks', { other: attackerId, attack: self.attack }, attackerId)
  trigger(state, other(p), 'whenEnemyAttacks', { other: attackerId, attack: self.attack })
  const defending = target === 'base' ? undefined : findUnit(state, target)
  if (defending)
    queue(state, other(p), nameOf(state, defending), unitScript(state, defending).whenDefending, {
      id: defending.id,
      controller: other(p),
      def: def(state, defending),
      other: attackerId,
      attack: self.attack,
    })
  resolveTriggers(state)

  // The attack ends without combat when either is gone
  const still = findUnit(state, attackerId)
  const defender = target === 'base' ? undefined : findUnit(state, target)
  if (state.phase !== 'over' && still && (target === 'base' || defender)) {
    const keywords = keywordsOf(state, still)
    const power = powerOf(state, still, true)
    // Restore (7.5.9): when it attacks, heal that much damage from your base
    if (keywords.restore) heal(state, p, keywords.restore)
    if (!defender) {
      enemy.base.damage += power
      log(state, `${nameOf(state, still)} deals ${power} damage to ${nameOf(state, enemy.base)}`, p)
      if (power > 0) trigger(state, p, 'whenCombatDamageBase', { other: attackerId, attack: { attacker: attackerId, target } })
    } else {
      const remaining = Math.max(0, hpOf(state, defender) - defender.damage)
      const back = powerOf(state, defender)
      const dealt = damageUnit(state, defender, power)
      // Dealing its combat damage first, a unit that defeats the defender takes none back
      if (keywords.firstStrike) {
        checkDefeats(state)
        if (findUnit(state, defender.id)) damageUnit(state, still, back)
      } else damageUnit(state, still, back)
      // Overwhelm (7.5.7): damage beyond what defeats the defender goes to its controller's base,
      // unless a Shield token prevented it (7.5.7e)
      if (keywords.overwhelm && dealt && power > remaining) {
        enemy.base.damage += power - remaining
        trigger(state, p, 'whenCombatDamageBase', { other: attackerId, attack: { attacker: attackerId, target } })
      }
    }
    checkDefeats(state)
    resolveTriggers(state)
    // "When this unit completes an attack:"
    const after = findUnit(state, attackerId)
    if (after && state.winner === null) {
      queue(state, p, nameOf(state, after), unitScript(state, after).afterAttack, { id: after.id, controller: p, def: def(state, after) })
      resolveTriggers(state)
    }
  }
  state.effects = state.effects.filter((e) => !(e.until === 'attack' && e.unit === attackerId))
  state.attack = outer
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
function deploy(state: GameState, p: PlayerId) {
  const player = state.players[p]
  player.leader.deployed = true
  player.leader.epicUsed = true
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
  queue(state, p, nameOf(state, unit), scriptOf(state, unit, 'back').whenDeployed, {
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
function useAbility(state: GameState, p: PlayerId, source: string, index: number) {
  const player = state.players[p]
  const { unit, card, abilities } = abilitySource(state, p, source)
  const ability = abilities.actions?.[index]
  if (!ability) throw new IllegalAction('No such ability')
  pay(player, ability.resources ?? 0)
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
type Choice = { optional?: boolean; ai?: Prompt['ai']; source?: string; seen?: string[] }

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
  cost(unit: UnitState) {
    return this.def(unit).cost
  }
  // A unit in play's traits include those it gains
  hasTrait(card: { def: string }, trait: string) {
    const unit = 'upgrades' in card ? (card as UnitState) : undefined
    return unit && findUnit(this.state, unit.id) ? traitsOf(this.state, unit).includes(trait) : this.def(card).traits.includes(trait)
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
      kind: 'pick',
      options: ids.map((id) => ({ id, label: this.name(id), def: this.cardInfo(id)?.def })),
      min,
      max,
      ai: options.ai,
    })
  }
  // One of them, or nothing when optional (or when there is nothing to choose)
  chooseOne(player: PlayerId, text: string, ids: string[], options: Choice = {}) {
    const [pick] = this.choose(player, text, ids, { ...options, min: options.optional ? 0 : 1, max: 1 })
    return pick ?? null
  }
  // A "you may": yes or no. ai: what the AI answers.
  may(player: PlayerId, text: string, options: { yes?: string; no?: string; ai?: boolean; source?: string; play?: Prompt['play'] } = {}) {
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
    })
    return pick === 'yes'
  }
  // "Choose one:": the number of the choice taken
  option(player: PlayerId, text: string, labels: string[], options: { ai?: number; source?: string; card?: string } = {}) {
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
    if (owner !== undefined) this.state.players[owner].base.damage += amount
    else {
      const unit = this.unit(target)
      if (!unit || !damageUnit(this.state, unit, amount)) return 0
    }
    this.log(`${from ? `${from.def.name} deals` : 'Dealt'} ${amount} damage to ${this.name(target)}`, from?.controller)
    checkDefeats(this.state)
    return amount
  }
  heal(target: string, amount: number, from?: Self) {
    const owner = baseOwner(target)
    const damaged = owner !== undefined ? this.state.players[owner].base : this.unit(target)
    if (!damaged || amount <= 0) return
    const healed = Math.min(amount, damaged.damage)
    damaged.damage -= healed
    this.log(`${from ? `${from.def.name} heals` : 'Healed'} ${healed} damage from ${this.name(target)}`, from?.controller)
  }
  // A unit an upgrade keeps from being defeated by enemy card abilities isn't; nor one a card
  // on its side keeps from being defeated by the card whose ability it is (`from`)
  defeat(unitId: string, from?: Self) {
    const unit = this.unit(unitId)
    if (!unit) return
    const p = controllerOf(this.state, unit)
    const safe = unit.upgrades.some((u) => scriptOf(this.state, u).cantBeDefeatedByEnemies)
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
      checkDefeats(this.state)
    }
  }
  exhaust(unitId: string) {
    const unit = this.unit(unitId)
    if (unit) exhaustUnit(this.state, unit)
  }
  ready(unitId: string) {
    const unit = this.unit(unitId)
    if (unit) unit.exhausted = false
  }
  // +power/+HP to a unit, for this attack or this phase
  buff(unitId: string, power: number, hp: number, until: Effect['until']) {
    this.state.effects.push({ unit: unitId, power, hp, until })
  }
  pay(p: PlayerId, amount: number) {
    if (readyResources(this.state.players[p]) < amount) return false
    pay(this.state.players[p], amount)
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
    this.log(`${player.name} discards ${nameOf(this.state, card)}`, p)
  }
  // A player chooses cards from their own hand and discards them
  discardChosen(p: PlayerId, count: number, text = `Choose ${count === 1 ? 'a card' : `${count} cards`} to discard`, source?: string) {
    const hand = this.state.players[p].hand.map((c) => c.id)
    const picks = this.choose(p, text, hand, { min: count, max: count, ai: 'cheap', source })
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
    for (let i = 0; i < count; i++) giveToken(this.state, unit, name)
    checkDefeats(this.state)
  }
  tokens(unitId: string, name: string) {
    const unit = this.unit(unitId)
    return unit ? unit.upgrades.filter((u) => this.def(u).token && this.def(u).name === name).length : 0
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
  grant(unitId: string, keywords: Keywords, until: Effect['until'], source?: string) {
    this.state.effects.push({ unit: unitId, power: 0, hp: 0, keywords, until, ...(source && { source }) })
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
    checkDefeats(this.state)
  }
  // A unit out of play to the bottom of its owner's deck (its upgrades discarded)
  toDeckBottom(unitId: string) {
    const unit = this.unit(unitId)
    if (!unit) return
    const p = controllerOf(this.state, unit)
    this.state.players[p].units = this.state.players[p].units.filter((u) => u !== unit)
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
  // Defeated when the next regroup phase starts
  doom(unitId: string) {
    if (!this.state.doomed.includes(unitId)) this.state.doomed.push(unitId)
  }
  defeatedThisPhase(cardId: string) {
    return this.state.defeatedThisPhase.includes(cardId)
  }
  traits(unit: UnitState) {
    return traitsOf(this.state, unit)
  }
  // To its owner's hand; a leader unit is defeated instead (3.4.6), a token set aside (3.7.3)
  returnToHand(unitId: string) {
    const unit = this.unit(unitId)
    if (!unit) return
    if (unit.leader) return this.defeat(unitId)
    const p = controllerOf(this.state, unit)
    this.state.players[p].units = this.state.players[p].units.filter((u) => u !== unit)
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
  canPlay(p: PlayerId, cardId: string, options: PlayOptions & { smuggle?: boolean } = {}) {
    const from = this.placeOf(p, cardId, options.smuggle)
    const card = this.cardInfo(cardId)
    if (!from || !card) return false
    const d = this.def(card)
    if (d.token || d.type === 'leader' || d.type === 'base') return false
    if (from === 'smuggle' && d.keywords.smuggle === undefined) return false
    if (isBanned(this.state, p, d)) return false
    const slot = this.state.players[p].resources.find((r) => r.card.id === cardId)
    const ready = readyResources(this.state.players[p])
    const price = priceOf(this.state, p, d, from, options) - spiceRoom(this.state, p, d)
    if (price > ready) return false
    if (!options.ignoreAdditional && !canPayAdditional(this.state, p, d)) return false
    // 7.5.21b: a Fortification needs no unit to attach to
    if (d.type === 'upgrade' && !d.keywords.fortify && !this.units((u) => canAttach(this.state, p, d, u)).length) return false
    return slot ? true : price <= ready
  }
  playCard(p: PlayerId, cardId: string, options: PlayOptions & { smuggle?: boolean } = {}) {
    if (!this.canPlay(p, cardId, options)) return false
    const from = this.placeOf(p, cardId, options.smuggle) as PlayedFrom
    const d = this.def(this.cardInfo(cardId)!)
    let attachTo: string | undefined
    if (d.keywords.fortify) attachTo = baseId(p)
    else if (d.type === 'upgrade') {
      const units = this.units((u) => canAttach(this.state, p, d, u)).map((u) => u.id)
      attachTo = this.chooseOne(p, `Choose a unit for ${d.name}`, units, { ai: 'help', source: d.id }) ?? undefined
      if (!attachTo) return false
    }
    playCard(this.state, p, cardId, attachTo, from, options)
    return true
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
    const pick = this.chooseOne(p, `Choose what ${nameOf(this.state, unit)} attacks`, ids, { ai: 'harm' })
    if (!pick) return false
    attack(this.state, p, unitId, baseOwner(pick) !== undefined ? 'base' : pick, options)
    return true
  }
}
