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
  ambush?: boolean
  hidden?: boolean
  plot?: boolean
  // Fortify (7.5.21): an upgrade that attaches to your base, not a unit
  fortify?: boolean
  // Smuggle [Y]: the cost to play it from your resources
  smuggle?: number
  // Not a printed keyword: "deals combat damage before the defender", while attacking
  firstStrike?: boolean
}

// A card as the engine knows it: its printed values, and its text, which names the script
// that plays it (scripts.ts) as long as the two still match
export type CardDef = {
  id: string
  name: string
  subtitle?: string
  // 'token': one that is neither a unit nor an upgrade (Spice)
  type: 'unit' | 'leader' | 'base' | 'event' | 'upgrade' | 'token'
  // Created, never in a deck: set aside when it leaves play (3.7.3)
  token?: boolean
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
  // "While you control an [{Arrakis}] base, this unit gains …"
  arrakisKeywords?: Keywords
  // "As an additional cost to play this unit, defeat a friendly Spice token."
  spiceCost?: number
  // A base's or leader's "You start the game with a [Spice Token]."
  startSpice?: number
  // An upgrade's "Attach to a friendly unit." or "Attach to a non-[{Vehicle}], non-leader unit."
  attach?: { friendly?: boolean; not?: string[]; nonLeader?: boolean }
  // An upgrade's "Attached unit gains [Sentinel]."
  attachedKeywords?: Keywords
  // A leader's unit side
  unit?: { power: number; hp: number; arena: Arena; keywords: Keywords; arrakisKeywords?: Keywords }
  text?: string
  // A leader's unit side's text
  backText?: string
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
  // The phase it entered play in (GameState.phaseCount), for Hidden
  entered?: number
  // Each goes to its owner's discard pile, whoever controls the unit
  upgrades: (Inst & { owner: PlayerId })[]
}

export type PlayerState = {
  name: string
  leader: { def: string; deployed: boolean; exhausted: boolean; epicUsed: boolean }
  // Fortifications attached to it (none in a game saved before them)
  base: { def: string; damage: number; upgrades?: (Inst & { owner: PlayerId })[] }
  deck: Inst[]
  hand: Inst[]
  discard: Inst[]
  resources: { card: Inst; exhausted: boolean }[]
  units: UnitState[]
  // Spice tokens, beside the base
  spice: Inst[]
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

// A question an ability asks a player in the middle of an action. 'pick' chooses among
// things in the game (units, bases as base0/base1, cards by their id); 'option' among labels.
export type Prompt = {
  player: PlayerId
  text: string
  // The card whose ability asks
  source?: string
  // A card the question is about, shown with it (the top card of a deck)
  card?: string
  // The card in the player's hand a "play it now?" question plays, and what it costs then:
  // clicking that card answers yes
  play?: { card: string; cost: number }
  kind: 'pick' | 'option'
  // def: the card, for one shown only in the question (in a hand, on top of a deck)
  options: { id: string; label?: string; def?: string }[]
  // Every card looked at, in order, when only some may be picked (a deck searched): shown
  // with the question, those among the options to pick
  seen?: { id: string; def: string }[]
  min: number
  max: number
  // How the AI answers: a pick that 'harm's or 'help's, the option it takes
  ai?: 'harm' | 'help' | 'cheap' | string
}

// The action a prompt interrupted: the game as it was before it, and the answers given so far.
// Each answer plays the action again from there with one more answer, the same seed giving
// the same game, until it runs to the end.
export type Pending = { base: GameState; player: PlayerId; action: Action; answers: string[][] }

// A change to a unit that lasts a while: for this attack, for this phase, or while the card
// that made it (source, an upgrade) stays in play
export type Effect = {
  unit: string
  power: number
  hp: number
  keywords?: Keywords
  until: 'attack' | 'phase' | 'source'
  source?: string
}

// "The next [{Bene Gesserit}] card you play this phase costs [2] less."
export type Discount = { player: PlayerId; trait: string; amount: number }

// A unit whose control was taken until the regroup phase starts, when its owner takes it back
export type Borrowed = { unit: string; owner: PlayerId }

export type Revealed = { cards: string[]; by: string }

export type GameState = {
  rng: number
  round: number
  phase: Phase
  // Counts the phases gone by, for what lasts "this phase"
  phaseCount: number
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
  effects: Effect[]
  // The "once each round" abilities used this round
  usedThisRound: string[]
  // What lasts this phase: cost reductions not yet used, card names opponents can't play, the
  // units defeated (their card ids)
  discounts: Discount[]
  banned: { player: PlayerId; name: string }[]
  defeatedThisPhase: string[]
  borrowed: Borrowed[]
  // Units to defeat when the next regroup phase starts (Worm Signs)
  doomed: string[]
  // The attack under way, for what applies while attacking and the defender's own abilities
  attack: { attacker: string; target: string | 'base' } | null
  // The cards each player revealed last, and the card that made them reveal them (card ids);
  // a game saved before it had none
  revealed?: [Revealed | null, Revealed | null]
  // While an ability waits for an answer
  prompt: Prompt | null
  pending: Pending | null
}

export type Action =
  | { type: 'first'; goFirst: boolean }
  | { type: 'mulligan'; take: boolean }
  | { type: 'resource'; cards: string[] }
  // From the hand; from the resources using Smuggle; from the discard pile when the card says
  // so; for a Spice token instead of its cost when the card says so
  | { type: 'play'; card: string; attachTo?: string; smuggle?: boolean; discard?: boolean; spice?: boolean }
  | { type: 'attack'; attacker: string; target: string | 'base' }
  | { type: 'deploy' }
  // A leader's or unit's Action ability, by its number on the card
  | { type: 'ability'; source: string; index: number }
  | { type: 'answer'; picks: string[] }
  | { type: 'initiative' }
  | { type: 'pass' }
  | { type: 'concede' }

export class IllegalAction extends Error {}
