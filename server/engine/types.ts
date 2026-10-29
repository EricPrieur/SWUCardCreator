// The game simulator's engine: the rules of a game of Star Wars: Unlimited, played with
// DUNE cards. It runs on the server, which holds the one true game and tells each player
// only what they may see. It knows nothing of screens or sockets.

export type PlayerId = 0 | 1
export type Aspect = 'Vigilance' | 'Command' | 'Aggression' | 'Cunning' | 'Heroism' | 'Villainy'
export type Arena = 'ground' | 'space'

// The keywords the engine applies; numbered ones stack (rule 7.5.4)
export type Keywords = {
  sentinel?: boolean
  raid?: number
  restore?: number
  overwhelm?: boolean
  grit?: boolean
  saboteur?: boolean
}

// A card as the engine knows it: printed values only
export type CardDef = {
  id: string
  name: string
  subtitle?: string
  type: 'unit' | 'leader' | 'base' | 'event' | 'upgrade'
  // A leader's deploy cost; nothing for a base
  cost: number
  // A unit's, an upgrade's modifiers, a base's HP
  power: number
  hp: number
  arena?: Arena
  aspects: Aspect[]
  traits: string[]
  unique: boolean
  keywords: Keywords
  // A leader's unit side
  unit?: { power: number; hp: number; arena: Arena; keywords: Keywords }
}

// One physical card in a game; def names its CardDef
export type Inst = { id: string; def: string }

export type UnitState = Inst & {
  owner: PlayerId
  arena: Arena
  damage: number
  exhausted: boolean
  // The leader's unit side, deployed
  leader?: boolean
  // Each goes to its owner's discard pile, whoever controls the unit
  upgrades: (Inst & { owner: PlayerId })[]
}

export type PlayerState = {
  name: string
  leader: { def: string; deployed: boolean; exhausted: boolean; epicUsed: boolean }
  base: { def: string; damage: number }
  deck: Inst[]
  hand: Inst[]
  discard: Inst[]
  resources: { card: Inst; exhausted: boolean }[]
  units: UnitState[]
  // Setup: has decided on a mulligan, has chosen 2 resources
  mulliganDone: boolean
  setupResourced: boolean
  // Regroup: has chosen whether to resource a card
  regroupDone: boolean
  // Took the initiative: passes for the rest of the action phase
  passedForPhase: boolean
  // Every card drawn this game, the starting hand and a mulligan's included: open
  // information, which the screen animates as it goes up
  drawn: number
}

// 'first': the player chosen at random decides who starts with the initiative (5.2.1c)
export type Phase = 'first' | 'mulligan' | 'resource' | 'action' | 'regroup' | 'over'

export type LogEntry = { player?: PlayerId; text: string }

export type GameState = {
  rng: number
  round: number
  phase: Phase
  active: PlayerId
  initiative: PlayerId
  initiativeTaken: boolean
  // Chosen at random to decide who starts with the initiative
  chooser: PlayerId
  // Passes in a row in this action phase; two end it
  passes: number
  players: [PlayerState, PlayerState]
  defs: Record<string, CardDef>
  nextId: number
  log: LogEntry[]
  // Once the game is over: the winner, or 'draw'
  winner: PlayerId | 'draw' | null
}

export type Action =
  | { type: 'first'; goFirst: boolean }
  | { type: 'mulligan'; take: boolean }
  | { type: 'resource'; cards: string[] }
  | { type: 'play'; card: string; attachTo?: string }
  | { type: 'attack'; attacker: string; target: string | 'base' }
  | { type: 'deploy' }
  | { type: 'initiative' }
  | { type: 'pass' }
  | { type: 'concede' }

export class IllegalAction extends Error {}
