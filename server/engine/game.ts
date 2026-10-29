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
      base: { def: list.base, damage: 0 },
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

// What the cards on a unit's side give it
function grantsTo(state: GameState, unit: UnitState): Grant[] {
  const g = new Game(state)
  return holders(state, controllerOf(state, unit)).flatMap(({ self, abilities }) => abilities.gives?.(g, self, unit) ?? [])
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
  if (!def(state, upgrade).token) state.players[upgrade.owner].discard.push({ id: upgrade.id, def: upgrade.def })
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
  current.queue.push({ player, label: source, run: () => ability(new Game(state), self) })
}

// The abilities a card has where it is: a unit's, a leader's unit side's once deployed, a
// leader side's
function scriptOf(state: GameState, inst: { def: string }, side: 'front' | 'back' = 'front'): Abilities {
  return abilitiesOf(def(state, inst), side)
}
const unitScript = (state: GameState, unit: UnitState) => scriptOf(state, unit, unit.leader ? 'back' : 'front')

// What has abilities on a player's side: their base, their leader's leader side until it
// deploys, their units and the upgrades on them
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
  return list
}

type Hook = 'whenYouPlay' | 'whenYouCreate' | 'whenSpiceDefeated' | 'whenFriendlyDefeated' | 'whenFriendlyAttacks' | 'regroupStart'

// An event on a player's side, which the abilities there that wait for it resolve after
function trigger(state: GameState, p: PlayerId, hook: Hook, extra: Partial<Self> = {}, except?: string) {
  for (const { self, abilities } of holders(state, p))
    if (self.id !== except) queue(state, p, self.def.name, abilities[hook], { ...self, ...extra })
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

function defeatUnit(state: GameState, unit: UnitState) {
  const p = controllerOf(state, unit)
  const player = state.players[p]
  player.units = player.units.filter((u) => u !== unit)
  state.effects = state.effects.filter((e) => e.unit !== unit.id)
  for (const upgrade of unit.upgrades) discardUpgrade(state, upgrade)
  if (unit.leader) {
    player.leader.deployed = false
    player.leader.exhausted = true
  } else if (!def(state, unit).token) {
    state.players[unit.owner].discard.push({ id: unit.id, def: unit.def })
  }
  log(state, `${nameOf(state, unit)} is defeated`, p)
  queue(state, p, nameOf(state, unit), unitScript(state, unit).whenDefeated, {
    id: unit.id,
    controller: p,
    def: def(state, unit),
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
  if (sentinels.length) return sentinels.map((u) => u.id)
  // Hidden (7.5.18): not the phase it entered play
  const hidden = (u: UnitState) => keywordsOf(state, u).hidden && u.entered === state.phaseCount
  return [...enemies.filter((u) => !hidden(u)).map((u) => u.id), 'base']
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
  const plays = (card: Inst, cost: number, smuggle?: boolean) => {
    const d = def(state, card)
    if (cost > ready || !canPayAdditional(state, p, d)) return
    const extra = smuggle ? { smuggle } : {}
    if (d.type === 'upgrade') {
      for (const unit of units)
        if (canAttach(state, p, d, unit)) actions.push({ type: 'play', card: card.id, attachTo: unit.id, ...extra })
    } else {
      actions.push({ type: 'play', card: card.id, ...extra })
    }
  }
  for (const card of player.hand) plays(card, playCost(state, p, def(state, card)))
  // Smuggle (7.5.14): from the resources. A ready card helps pay for itself, so it counts among
  // the ready resources.
  for (const { card } of player.resources) {
    if (def(state, card).keywords.smuggle !== undefined) plays(card, smuggleCost(state, p, def(state, card)), true)
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

const sameAction = (a: Action, b: Action) => JSON.stringify(a) === JSON.stringify(b)

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
    const state = structuredClone(game)
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

// Plays an action from the game before it, with the answers known so far: to its end, or to
// the next question, the game then showing how far it got
function play(base: GameState, p: PlayerId, action: Action, answers: string[][]): GameState {
  const state = structuredClone(base)
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
      playCard(state, p, action.card, action.attachTo, action.smuggle ? 'smuggle' : 'hand')
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

function startActionPhase(state: GameState) {
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
  state.phase = 'regroup'
  state.phaseCount++
  state.effects = state.effects.filter((e) => e.until !== 'phase')
  log(state, `Round ${state.round}: regroup phase`)
  for (const p of [state.active, other(state.active)]) trigger(state, p, 'regroupStart')
  resolveTriggers(state)
  if (state.winner !== null) return
  for (const p of [0, 1] as const) draw(state, p, 2)
  checkDefeats(state)
  for (const pl of state.players) pl.regroupDone = false
}

// Where a card is played from: the hand, the discard pile (when an ability says so), or the
// resources using Smuggle or Plot
type PlayedFrom = 'hand' | 'discard' | 'smuggle' | 'plot'

// What an ability changes in the cost of a card it plays: "It costs [1] less", "for free"
// (which leaves additional costs to pay, 1.8), "ignoring its additional costs"
type PlayOptions = { discount?: number; free?: boolean; ignoreAdditional?: boolean }

function priceOf(state: GameState, p: PlayerId, card: CardDef, from: PlayedFrom, options: PlayOptions = {}) {
  if (options.free) return 0
  const cost = from === 'smuggle' ? smuggleCost(state, p, card) : playCost(state, p, card)
  return Math.max(0, cost - (options.discount ?? 0))
}

// An upgrade's "Attach to a friendly unit." or "Attach to a non-[{Vehicle}] unit."
function canAttach(state: GameState, p: PlayerId, card: CardDef, unit: UnitState) {
  if (card.attach?.friendly && controllerOf(state, unit) !== p) return false
  if (card.attach?.not && def(state, unit).traits.includes(card.attach.not)) return false
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
  if (from === 'hand' || from === 'discard') {
    const zone = from === 'hand' ? player.hand : player.discard
    card = zone.find((c) => c.id === id) as Inst
    pay(player, priceOf(state, p, def(state, card), from, options))
    if (from === 'hand') player.hand = player.hand.filter((c) => c !== card)
    else player.discard = player.discard.filter((c) => c !== card)
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
    pay(player, cost)
    const top = player.deck.shift()
    if (top) player.resources[player.resources.indexOf(slot)] = { card: top, exhausted: true }
    else player.resources = player.resources.filter((r) => r !== slot)
  }
  const d = def(state, card)
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
  const how = { hand: '', discard: ' from the discard pile', smuggle: ' using Smuggle', plot: ' using Plot' }[from]
  const using = how + (options.free ? ' for free' : '')
  const self: Self = { id: card.id, controller: p, def: d, smuggled: from === 'smuggle', plot: from === 'plot' }
  if (d.type === 'unit') {
    // 3.5.3: a unit enters play exhausted
    const unit: UnitState = { ...card, owner: p, arena: d.arena ?? 'ground', damage: 0, exhausted: true, upgrades: [], entered: state.phaseCount }
    player.units.push(unit)
    log(state, `${player.name} plays ${d.name}${using}`, p)
    queue(state, p, d.name, scriptOf(state, card).whenPlayed, self)
    queueAmbush(state, p, unit)
  } else if (d.type === 'upgrade') {
    const unit = findUnit(state, attachTo as string) as UnitState
    unit.upgrades.push({ ...card, owner: p })
    log(state, `${player.name} attaches ${d.name} to ${nameOf(state, unit)}${using}`, p)
    queue(state, p, d.name, scriptOf(state, card).whenPlayed, { ...self, other: unit.id })
  } else {
    // An event resolves its text, then goes to the discard pile
    log(state, `${player.name} plays ${d.name}${using}`, p)
    const effect = scriptOf(state, card).play
    if (effect) effect(new Game(state), self)
    else log(state, `(${d.name}'s text doesn't do anything yet)`)
    player.discard.push(card)
  }
  // Abilities that trigger on another card being played
  trigger(state, p, 'whenYouPlay', { other: card.id, otherDef: d }, card.id)
  checkDefeats(state)
  resolveTriggers(state)
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
type AttackOptions = { power?: number }

// 6.3: exhaust the attacker, resolve its On Attack abilities and those it triggers, then both
// deal their damage at once
function attack(state: GameState, p: PlayerId, attackerId: string, target: string | 'base', options: AttackOptions = {}) {
  const player = state.players[p]
  const enemy = state.players[other(p)]
  const attacker = findUnit(state, attackerId) as UnitState
  attacker.exhausted = true
  if (options.power) state.effects.push({ unit: attackerId, power: options.power, hp: 0, until: 'attack' })
  const defenderName = target === 'base' ? nameOf(state, enemy.base) : nameOf(state, findUnit(state, target) as UnitState)
  log(state, `${player.name} attacks ${defenderName} with ${nameOf(state, attacker)}`, p)
  const self: Self = { id: attackerId, controller: p, def: def(state, attacker), attack: { attacker: attackerId, target } }
  queue(state, p, nameOf(state, attacker), unitScript(state, attacker).onAttack, self)
  trigger(state, p, 'whenFriendlyAttacks', { other: attackerId, attack: self.attack }, attackerId)
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
    } else {
      const remaining = Math.max(0, hpOf(state, defender) - defender.damage)
      const back = powerOf(state, defender)
      const dealt = damageUnit(state, defender, power)
      damageUnit(state, still, back)
      // Overwhelm (7.5.7): damage beyond what defeats the defender goes to its controller's base,
      // unless a Shield token prevented it (7.5.7e)
      if (keywords.overwhelm && dealt && power > remaining) enemy.base.damage += power - remaining
    }
    checkDefeats(state)
    resolveTriggers(state)
  }
  state.effects = state.effects.filter((e) => !(e.until === 'attack' && e.unit === attackerId))
}

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
    if (unit) unit.exhausted = true
    else if (source === 'leader') player.leader.exhausted = true
  }
  log(state, `${player.name} uses ${nameOf(state, card)}: ${ability.label}`, p)
  ability.run(new Game(state), { id: source, controller: p, def: def(state, card) })
  checkDefeats(state)
  resolveTriggers(state)
}

// --- What abilities can do ---

type Choice = { optional?: boolean; ai?: Prompt['ai']; source?: string }

// The game as card scripts see and change it: what is where, questions for the players, and
// the effects cards have. Damage and defeats are dealt with as they happen.
export class Game {
  state: GameState
  constructor(state: GameState) {
    this.state = state
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
  hasTrait(card: { def: string }, trait: string) {
    return this.def(card).traits.includes(trait)
  }
  // Every upgrade in play, with the unit it is on
  upgrades() {
    return this.units().flatMap((unit) => unit.upgrades.map((upgrade) => ({ ...upgrade, unit })))
  }
  player(p: PlayerId) {
    return this.state.players[p]
  }

  // Asking. A question with nothing to choose from isn't asked.
  // A card in a hand, deck or discard pile is shown in the question: only the player asked sees it
  choose(player: PlayerId, text: string, ids: string[], options: Choice & { min?: number; max?: number } = {}) {
    if (!ids.length) return []
    const min = Math.min(options.min ?? 1, ids.length)
    const max = Math.min(options.max ?? 1, ids.length)
    return ask({
      player,
      text,
      source: options.source,
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
  may(player: PlayerId, text: string, options: { yes?: string; no?: string; ai?: boolean; source?: string } = {}) {
    const [pick] = ask({
      player,
      text,
      source: options.source,
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
      for (const card of [...pl.hand, ...pl.deck, ...pl.discard, ...pl.resources.map((r) => r.card), ...pl.spice])
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
  defeat(unitId: string) {
    const unit = this.unit(unitId)
    if (unit) defeatUnit(this.state, unit)
    checkDefeats(this.state)
  }
  defeatUpgrade(upgradeId: string) {
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
    if (unit) unit.exhausted = true
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
  // A keyword for a while: "gains [Raid 1] for this phase"
  grant(unitId: string, keywords: Keywords, until: Effect['until']) {
    this.state.effects.push({ unit: unitId, power: 0, hp: 0, keywords, until })
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
    if (player.resources.some((r) => r.card.id === cardId)) return smuggle ? 'smuggle' : 'plot'
    return undefined
  }
  canPlay(p: PlayerId, cardId: string, options: PlayOptions & { smuggle?: boolean } = {}) {
    const from = this.placeOf(p, cardId, options.smuggle)
    const card = this.cardInfo(cardId)
    if (!from || !card) return false
    const d = this.def(card)
    if (d.token || d.type === 'leader' || d.type === 'base') return false
    if (from === 'smuggle' && d.keywords.smuggle === undefined) return false
    const slot = this.state.players[p].resources.find((r) => r.card.id === cardId)
    const ready = readyResources(this.state.players[p])
    const price = priceOf(this.state, p, d, from, options)
    if (price > ready) return false
    if (!options.ignoreAdditional && !canPayAdditional(this.state, p, d)) return false
    if (d.type === 'upgrade' && !this.units((u) => canAttach(this.state, p, d, u)).length) return false
    return slot ? true : price <= ready
  }
  playCard(p: PlayerId, cardId: string, options: PlayOptions & { smuggle?: boolean } = {}) {
    if (!this.canPlay(p, cardId, options)) return false
    const from = this.placeOf(p, cardId, options.smuggle) as PlayedFrom
    const d = this.def(this.cardInfo(cardId)!)
    let attachTo: string | undefined
    if (d.type === 'upgrade') {
      const units = this.units((u) => canAttach(this.state, p, d, u)).map((u) => u.id)
      attachTo = this.chooseOne(p, `Choose a unit for ${d.name}`, units, { ai: 'help', source: d.id }) ?? undefined
      if (!attachTo) return false
    }
    playCard(this.state, p, cardId, attachTo, from, options)
    return true
  }

  // Attack with a unit, its controller choosing what it attacks. The unit may be exhausted
  // when the ability says so.
  attackWith(unitId: string, options: AttackOptions & { exhausted?: boolean; noBases?: boolean } = {}) {
    const unit = this.unit(unitId)
    if (!unit || (unit.exhausted && !options.exhausted)) return false
    const p = controllerOf(this.state, unit)
    const targets = attackTargets(this.state, p, unit).filter((t) => !(options.noBases && t === 'base'))
    const ids = targets.map((t) => (t === 'base' ? baseId(other(p)) : t))
    const pick = this.chooseOne(p, `Choose what ${nameOf(this.state, unit)} attacks`, ids, { ai: 'harm' })
    if (!pick) return false
    attack(this.state, p, unitId, baseOwner(pick) !== undefined ? 'base' : pick, options)
    return true
  }
}
