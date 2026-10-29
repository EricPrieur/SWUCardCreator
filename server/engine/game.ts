import {
  IllegalAction,
  type Action,
  type Aspect,
  type CardDef,
  type GameState,
  type Inst,
  type Keywords,
  type PlayerId,
  type PlayerState,
  type UnitState,
} from './types.ts'

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

const other = (p: PlayerId): PlayerId => (p === 0 ? 1 : 0)
const def = (state: GameState, inst: { def: string }) => state.defs[inst.def]
const log = (state: GameState, text: string, player?: PlayerId) => state.log.push({ player, text })
const nameOf = (state: GameState, inst: { def: string }) => def(state, inst).name

// 5.2: bases and leaders in play, a random player starts with the initiative, decks shuffled,
// 6 cards drawn; then the mulligans and the 2 resources, which are actions of their own
export function createGame(options: { seed: number; decks: [DeckList, DeckList]; defs: CardDef[] }): GameState {
  const defs = Object.fromEntries(options.defs.map((d) => [d.id, d]))
  const state: GameState = {
    rng: options.seed | 0,
    round: 1,
    phase: 'mulligan',
    active: 0,
    initiative: 0,
    initiativeTaken: false,
    passes: 0,
    players: [] as unknown as [PlayerState, PlayerState],
    defs,
    nextId: 1,
    log: [],
    winner: null,
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
      hand: deck.splice(0, HAND_SIZE),
      discard: [],
      resources: [],
      units: [],
      mulliganDone: false,
      setupResourced: false,
      regroupDone: false,
      passedForPhase: false,
    }
  })
  state.initiative = random(state) < 0.5 ? 0 : 1
  state.active = state.initiative
  log(state, `${state.players[state.initiative].name} starts with the initiative`, state.initiative)
  return state
}

// Who has to act now: the active player in the action phase; during setup and regroup,
// whoever still has a choice to make (both at once while choosing the setup resources)
export function waitingFor(state: GameState): PlayerId[] {
  const [a, b] = [state.initiative, other(state.initiative)]
  const pending = (done: (p: PlayerState) => boolean) => [a, b].filter((p) => !done(state.players[p]))
  switch (state.phase) {
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

function keywordsOf(state: GameState, unit: UnitState): Keywords {
  const card = def(state, unit)
  return unit.leader ? (card.unit?.keywords ?? {}) : card.keywords
}

export function hpOf(state: GameState, unit: UnitState) {
  const card = def(state, unit)
  const printed = unit.leader ? (card.unit?.hp ?? 0) : card.hp
  return printed + unit.upgrades.reduce((sum, u) => sum + def(state, u).hp, 0)
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

// 1.12.4: defeated once its damage reaches its HP. A unit goes to its owner's discard pile with
// its upgrades; a leader unit flips back to its leader side, exhausted, and can't deploy again.
function checkDefeats(state: GameState) {
  for (const p of [0, 1] as const) {
    const player = state.players[p]
    for (const unit of [...player.units]) {
      if (unit.damage < hpOf(state, unit)) continue
      player.units = player.units.filter((u) => u !== unit)
      for (const { owner, ...upgrade } of unit.upgrades) state.players[owner].discard.push(upgrade)
      if (unit.leader) {
        player.leader.deployed = false
        player.leader.exhausted = true
      } else {
        player.discard.push({ id: unit.id, def: unit.def })
      }
      log(state, `${nameOf(state, unit)} is defeated`, p)
    }
  }
  // 5.6: the game ends the moment a base is defeated; both at once is a draw
  const lost = ([0, 1] as const).filter((p) => state.players[p].base.damage >= def(state, state.players[p].base).hp)
  if (lost.length) {
    state.phase = 'over'
    state.winner = lost.length === 2 ? 'draw' : other(lost[0])
    log(state, state.winner === 'draw' ? 'Both bases fall: a draw' : `${state.players[state.winner].name} wins`)
  }
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
    if (card) player.hand.push(card)
    else player.base.damage += EMPTY_DECK_DAMAGE
  }
}

// --- What a player may do ---

function attackTargets(state: GameState, p: PlayerId, attacker: UnitState): (string | 'base')[] {
  const enemies = state.players[other(p)].units.filter((u) => u.arena === attacker.arena)
  // Sentinel (7.5.11): while an enemy in the arena has it, only those can be attacked, unless
  // the attacker has Saboteur (7.5.10)
  const sentinels = keywordsOf(state, attacker).saboteur ? [] : enemies.filter((u) => keywordsOf(state, u).sentinel)
  return sentinels.length ? sentinels.map((u) => u.id) : [...enemies.map((u) => u.id), 'base']
}

function choose<T>(list: T[], count: number): T[][] {
  if (count === 0) return [[]]
  return list.flatMap((item, i) => choose(list.slice(i + 1), count - 1).map((rest) => [item, ...rest]))
}

// Every action the player may take now; [] when it isn't their turn to choose
export function legalActions(state: GameState, p: PlayerId): Action[] {
  if (state.phase === 'over' || !waitingFor(state).includes(p)) return []
  const player = state.players[p]
  const handIds = player.hand.map((c) => c.id)
  switch (state.phase) {
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
  for (const card of player.hand) {
    const d = def(state, card)
    if (playCost(state, p, d) > ready) continue
    if (d.type === 'upgrade') {
      for (const unit of units) actions.push({ type: 'play', card: card.id, attachTo: unit.id })
    } else {
      actions.push({ type: 'play', card: card.id })
    }
  }
  for (const unit of player.units) {
    if (unit.exhausted) continue
    for (const target of attackTargets(state, p, unit)) actions.push({ type: 'attack', attacker: unit.id, target })
  }
  // 3.4.4: the Epic Action deploys the leader once you control enough resources
  const leader = def(state, player.leader)
  if (!player.leader.deployed && !player.leader.epicUsed && player.resources.length >= leader.cost)
    actions.push({ type: 'deploy' })
  if (!state.initiativeTaken) actions.push({ type: 'initiative' })
  return actions
}

// --- Taking an action ---

const sameAction = (a: Action, b: Action) => JSON.stringify(a) === JSON.stringify(b)

// The game after player p takes an action; the game given is left as it was
export function applyAction(game: GameState, p: PlayerId, action: Action): GameState {
  const state = structuredClone(game)
  if (action.type === 'concede') {
    if (state.phase === 'over') throw new IllegalAction('The game is over')
    state.phase = 'over'
    state.winner = other(p)
    log(state, `${state.players[p].name} concedes`, p)
    return state
  }
  const legal = legalActions(state, p)
  // A resource choice may list its cards in any order
  const normal = action.type === 'resource' ? { ...action, cards: [...action.cards].sort() } : action
  const allowed = legal.some((a) => sameAction(a.type === 'resource' ? { ...a, cards: [...a.cards].sort() } : a, normal))
  if (!allowed) throw new IllegalAction(`${state.players[p].name} can't ${action.type} now`)

  const player = state.players[p]
  switch (state.phase) {
    case 'mulligan':
      if (action.type === 'mulligan') mulligan(state, p, action.take)
      return state
    case 'resource':
      if (action.type === 'resource') setupResource(state, p, action.cards)
      return state
    case 'regroup':
      if (action.type === 'resource') regroupResource(state, p, action.cards)
      return state
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
      playCard(state, p, action.card, action.attachTo)
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
  }
  if (state.phase === 'over') return state
  nextTurn(state)
  return state
}

function mulligan(state: GameState, p: PlayerId, take: boolean) {
  const player = state.players[p]
  if (take) {
    player.deck.push(...player.hand)
    player.hand = []
    shuffle(state, player.deck)
    player.hand = player.deck.splice(0, HAND_SIZE)
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

// 5.5: each player draws 2, then chooses whether to resource a card
function startRegroup(state: GameState) {
  state.phase = 'regroup'
  log(state, `Round ${state.round}: regroup phase`)
  for (const p of [0, 1] as const) draw(state, p, 2)
  checkDefeats(state)
  for (const pl of state.players) pl.regroupDone = false
}

function playCard(state: GameState, p: PlayerId, id: string, attachTo?: string) {
  const player = state.players[p]
  const card = player.hand.find((c) => c.id === id) as Inst
  const d = def(state, card)
  pay(player, playCost(state, p, d))
  player.hand = player.hand.filter((c) => c !== card)
  if (d.type === 'unit') {
    // 3.5.3: a unit enters play exhausted
    player.units.push({ ...card, owner: p, arena: d.arena ?? 'ground', damage: 0, exhausted: true, upgrades: [] })
    log(state, `${player.name} plays ${d.name}`, p)
  } else if (d.type === 'upgrade') {
    const unit = findUnit(state, attachTo as string) as UnitState
    unit.upgrades.push({ ...card, owner: p })
    log(state, `${player.name} attaches ${d.name} to ${nameOf(state, unit)}`, p)
  } else {
    // Events resolve their text, which cards will script; then go to the discard pile
    player.discard.push(card)
    log(state, `${player.name} plays ${d.name}`, p)
  }
  checkDefeats(state)
}

// 6.3: exhaust the attacker, then both deal their damage at once
function attack(state: GameState, p: PlayerId, attackerId: string, target: string | 'base') {
  const player = state.players[p]
  const enemy = state.players[other(p)]
  const attacker = findUnit(state, attackerId) as UnitState
  const keywords = keywordsOf(state, attacker)
  attacker.exhausted = true
  const power = powerOf(state, attacker, true)
  // Restore (7.5.9): when it attacks, heal that much damage from your base
  if (keywords.restore) heal(state, p, keywords.restore)
  if (target === 'base') {
    enemy.base.damage += power
    log(state, `${player.name} attacks ${nameOf(state, enemy.base)} with ${nameOf(state, attacker)} for ${power}`, p)
  } else {
    const defender = findUnit(state, target) as UnitState
    const remaining = Math.max(0, hpOf(state, defender) - defender.damage)
    const back = powerOf(state, defender)
    defender.damage += power
    attacker.damage += back
    // Overwhelm (7.5.7): damage beyond what defeats the defender goes to its controller's base
    if (keywords.overwhelm && power > remaining) enemy.base.damage += power - remaining
    log(state, `${player.name} attacks ${nameOf(state, defender)} with ${nameOf(state, attacker)}`, p)
  }
  checkDefeats(state)
}

// 3.4.4: flip to the unit side, in the ground arena, ready; deployed, not played
function deploy(state: GameState, p: PlayerId) {
  const player = state.players[p]
  player.leader.deployed = true
  player.leader.epicUsed = true
  player.units.push({
    id: `L${p}`,
    def: player.leader.def,
    owner: p,
    arena: 'ground',
    damage: 0,
    exhausted: false,
    leader: true,
    upgrades: [],
  })
  log(state, `${player.name} deploys ${nameOf(state, player.leader)}`, p)
}
