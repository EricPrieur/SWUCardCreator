import type { Game } from './game.ts'
import type { CardDef, PlayerId } from './types.ts'

// What each card's text does. A script names the card and quotes its text as printed: while
// the card's text is the same, the script plays it; once the card is changed in the Creator,
// the script no longer applies until it is brought up to date (scriptStatus says which).

// The card an ability belongs to, as it resolves. other: the unit an upgrade went on, the unit
// that attacked or was played, for abilities that trigger on another card.
export type Self = {
  id: string
  controller: PlayerId
  def: CardDef
  other?: string
  attack?: { attacker: string; target: string | 'base' }
}

export type Ability = (g: Game, self: Self) => void

// An "Action [cost]:" ability: resources to pay, whether it exhausts the card, when it can be used
export type ActionAbility = {
  label: string
  resources?: number
  exhaust?: boolean
  can?: (g: Game, self: Self) => boolean
  run: Ability
}

export type Abilities = {
  // An event's text
  play?: Ability
  whenPlayed?: Ability
  onAttack?: Ability
  whenDefeated?: Ability
  whenDeployed?: Ability
  actions?: ActionAbility[]
  // When another friendly unit attacks; self.other is the attacker
  whenFriendlyAttacks?: Ability
  // When you play another unit; self.other is that unit
  whenYouPlay?: Ability
}

export type CardScript = {
  name: string
  // A unique card's, which tells apart cards of the same name
  subtitle?: string
  text: string
  // A leader's unit side's
  backText?: string
  // A leader's leader side's, or the card's own
  front: Abilities
  // A leader's unit side's
  back?: Abilities
}

// --- Helpers for the scripts ---

const enemy = (g: Game, self: Self) => g.other(self.controller)
const bases = () => ['base0', 'base1']
const unitIds = (g: Game, test: Parameters<Game['units']>[0]) => g.units(test).map((u) => u.id)

// "Choose an enemy non-leader unit. Its controller may discard N cards from their hand. If they
// don't, …": the price the Bene Gesserit ask
function discardOr(g: Game, self: Self, count: number, otherwise: (unitId: string) => void, verb: string) {
  const target = g.chooseOne(
    self.controller,
    `${self.def.name}: choose an enemy non-leader unit`,
    unitIds(g, (u) => g.controller(u) !== self.controller && !u.leader),
    { ai: 'harm', source: self.def.id },
  )
  if (!target) return
  const unit = g.unit(target)!
  const owner = g.controller(unit)
  const hand = g.player(owner).hand.length
  const cards = count === 1 ? 'a card' : `${count} cards`
  const save =
    hand >= count &&
    g.may(owner, `${self.def.name}: discard ${cards} to keep ${g.name(target)}, or let ${verb} it?`, {
      yes: `Discard ${cards}`,
      no: `Let ${verb} it`,
      // The AI pays when the unit is worth more than the cards
      ai: g.cost(unit) >= 2 * count,
      source: self.def.id,
    })
  if (save) g.discardChosen(owner, count)
  else otherwise(target)
}

// "Look at the top card of your deck. You may put it on the bottom of your deck or discard it."
function scout(g: Game, self: Self) {
  const [top] = g.top(self.controller, 1)
  if (!top) return
  const where = g.option(
    self.controller,
    `${self.def.name}: the top card of your deck is ${g.def(top).name}`,
    ['Leave it on top', 'Put it on the bottom', 'Discard it'],
    { ai: g.def(top).cost >= 5 ? 1 : 0, source: self.def.id, card: top.def },
  )
  if (where === 1) g.toBottom(self.controller, top.id)
  if (where === 2) g.mill(self.controller, top.id)
}

// "Draw 2 cards, then put a card from your hand on the top or bottom of your deck or discard it."
function drawTwoPutOne(g: Game, self: Self) {
  g.draw(self.controller, 2)
  const hand = g.player(self.controller).hand.map((c) => c.id)
  const card = g.chooseOne(self.controller, `${self.def.name}: choose a card from your hand to put away`, hand, {
    ai: 'cheap',
    source: self.def.id,
  })
  if (!card) return
  const where = g.option(self.controller, `${self.def.name}: put ${g.name(card)}…`, ['On top of your deck', 'On the bottom of your deck', 'In your discard pile'], {
    ai: 1,
    source: self.def.id,
  })
  if (where === 2) g.discard(self.controller, card)
  else g.putBack(self.controller, card, where === 0 ? 'top' : 'bottom')
}

// --- The DUNE cards scripted so far ---

const dune: CardScript[] = [
  {
    name: 'Reverend Mother Mohiam',
    subtitle: 'Pain or Death',
    text: '[Action [[1, Arrow]]:] Choose an enemy non-leader unit. Its controller may discard a card from their hand. If they don\'t, deal 2 damage to it.',
    backText:
      '[Sentinel]\n[On Attack:] Choose an enemy non-leader unit. Its controller may discard a card from their hand. If they don\'t, defeat it.',
    front: {
      actions: [
        {
          label: 'pain or a card',
          resources: 1,
          exhaust: true,
          can: (g, self) => g.units((u) => g.controller(u) !== self.controller && !u.leader).length > 0,
          run: (g, self) => discardOr(g, self, 1, (id) => g.damage(id, 2, self), 'Mohiam damage'),
        },
      ],
    },
    back: {
      onAttack: (g, self) => discardOr(g, self, 1, (id) => g.defeat(id), 'Mohiam defeat'),
    },
  },
  {
    name: 'Glossu Rabban',
    subtitle: 'Governor of Arrakis',
    text: '[Action [[Arrow]]:] Choose a friendly unit. Deal 1 damage to it. Then, attack with it. It gets [+1/+0] for this attack, or [+2/+0] instead if it\'s a [{Harkonnen}] unit.',
    backText:
      '[Overwhelm]\nWhen another friendly unit attacks: You may deal 1 damage to it. If you do, it gets [+1/+0] for this attack, or [+2/+0] instead if it\'s a [{Harkonnen}] unit.',
    front: {
      actions: [
        {
          label: 'hurt a unit to attack with it',
          exhaust: true,
          can: (g, self) => g.units((u) => g.controller(u) === self.controller).length > 0,
          run: (g, self) => {
            const id = g.chooseOne(
              self.controller,
              'Glossu Rabban: choose a friendly unit to deal 1 damage to, then attack with',
              unitIds(g, (u) => g.controller(u) === self.controller),
              // The AI picks a ready unit that survives the damage
              { ai: 'help', source: self.def.id },
            )
            if (!id) return
            g.damage(id, 1, self)
            const unit = g.unit(id)
            if (!unit) return
            g.attackWith(id, { power: g.hasTrait(unit, 'Harkonnen') ? 2 : 1 })
          },
        },
      ],
    },
    back: {
      whenFriendlyAttacks: (g, self) => {
        const attacker = g.unit(self.other!)
        if (!attacker) return
        const left = g.hp(attacker) - attacker.damage
        const bonus = g.hasTrait(attacker, 'Harkonnen') ? 2 : 1
        if (
          !g.may(self.controller, `Glossu Rabban: deal 1 damage to ${g.name(attacker.id)} to give it +${bonus}/+0 for this attack?`, {
            yes: 'Deal 1 damage',
            no: 'Skip',
            ai: left > 1,
            source: self.def.id,
          })
        )
          return
        g.damage(attacker.id, 1, self)
        if (g.unit(attacker.id)) g.buff(attacker.id, bonus, 0, 'attack')
      },
    },
  },
  {
    name: 'Bene Gesserit Initiate',
    text: '[Restore 1]\n[When Played:] Each opponent discards a card from their hand.',
    front: {
      whenPlayed: (g, self) => {
        g.discardChosen(enemy(g, self), 1, `${self.def.name}: choose a card to discard`)
      },
    },
  },
  {
    name: 'Test of Humanity',
    text: 'Choose an enemy non-leader unit. Its controller may discard 2 cards from their hand. If they don\'t, defeat that unit.',
    front: {
      play: (g, self) => discardOr(g, self, 2, (id) => g.defeat(id), 'the test defeat'),
    },
  },
  {
    name: 'Bene Gesserit Adept',
    text: '[When Played:] You may defeat an upgrade attached to an exhausted unit.',
    front: {
      whenPlayed: (g, self) => {
        const upgrades = g.upgrades().filter((u) => u.unit.exhausted)
        const pick = g.chooseOne(
          self.controller,
          `${self.def.name}: you may defeat an upgrade on an exhausted unit`,
          upgrades.map((u) => u.id),
          { optional: true, ai: 'harm', source: self.def.id },
        )
        if (pick) g.defeatUpgrade(pick)
      },
    },
  },
  {
    name: 'Strike \'Thopter',
    text: '[When Played:] You may deal 1 damage to a ground unit.',
    front: {
      whenPlayed: (g, self) => {
        const pick = g.chooseOne(self.controller, `${self.def.name}: you may deal 1 damage to a ground unit`, unitIds(g, (u) => u.arena === 'ground'), {
          optional: true,
          ai: 'harm',
          source: self.def.id,
        })
        if (pick) g.damage(pick, 1, self)
      },
    },
  },
  {
    name: 'Paul Atreides',
    subtitle: 'Heir to House Atreides',
    text: '[On Attack:] Discard the top card of your deck. If its cost is equal to the defender\'s cost, deal 1 damage to the defender or to a base.',
    front: {
      onAttack: (g, self) => {
        const [top] = g.top(self.controller, 1)
        if (!top) return
        g.mill(self.controller, top.id)
        const target = self.attack!.target
        const defender = target === 'base' ? undefined : g.unit(target)
        if (!defender || g.def(top).cost !== g.cost(defender)) return
        const pick = g.chooseOne(self.controller, 'Paul Atreides: deal 1 damage to the defender or to a base', [defender.id, ...bases()], {
          ai: 'harm',
          source: self.def.id,
        })
        if (pick) g.damage(pick, 1, self)
      },
    },
  },
  {
    name: 'Atreides Swordsman',
    text: '[On Attack:] Defeat all upgrades on the defending unit.',
    front: {
      onAttack: (g, self) => {
        const target = self.attack!.target
        const defender = target === 'base' ? undefined : g.unit(target)
        for (const upgrade of defender?.upgrades ?? []) g.defeatUpgrade(upgrade.id)
      },
    },
  },
  {
    name: 'Thufir Hawat',
    subtitle: 'Master of Assassins',
    text: '[When Played:] Draw 2 cards, then put a card from your hand on the top or bottom of your deck or discard it.\n[On Attack:] Look at an opponent\'s hand. You may discard an event from it.',
    front: {
      whenPlayed: drawTwoPutOne,
      onAttack: (g, self) => {
        const foe = enemy(g, self)
        const hand = g.player(foe).hand
        const events = hand.filter((c) => g.def(c).type === 'event').map((c) => c.id)
        g.log(`${self.def.name} looks at ${g.player(foe).name}'s hand`, self.controller)
        // Every card is shown; only an event can be chosen
        const pick = g.chooseOne(
          self.controller,
          events.length ? `${self.def.name}: you may discard an event from their hand` : `${self.def.name}: their hand has no event`,
          events,
          { optional: true, ai: 'harm', source: self.def.id },
        )
        if (pick) g.discard(foe, pick)
      },
    },
  },
  {
    name: 'Imperial Quartermaster',
    text: '[When Played:] You may pay [2]. If you do, defeat an upgrade.',
    front: {
      whenPlayed: (g, self) => {
        const upgrades = g.upgrades()
        if (!upgrades.length || !g.canPay(self.controller, 2)) return
        const enemies = upgrades.some((u) => g.controller(u.unit) !== self.controller)
        if (!g.may(self.controller, `${self.def.name}: pay 2 to defeat an upgrade?`, { yes: 'Pay 2', no: 'Skip', ai: enemies, source: self.def.id }))
          return
        g.pay(self.controller, 2)
        const pick = g.chooseOne(self.controller, `${self.def.name}: choose an upgrade to defeat`, upgrades.map((u) => u.id), {
          ai: 'harm',
          source: self.def.id,
        })
        if (pick) g.defeatUpgrade(pick)
      },
    },
  },
  {
    name: 'Harkonnen Troops',
    text: 'A deck can have up to 15 copies of this card.\n[When Defeated:] Deal 1 damage to a unit or base.',
    front: {
      whenDefeated: (g, self) => {
        const pick = g.chooseOne(self.controller, `${self.def.name}: deal 1 damage to a unit or base`, [...unitIds(g, () => true), ...bases()], {
          ai: 'harm',
          source: self.def.id,
        })
        if (pick) g.damage(pick, 1, self)
      },
    },
  },
  {
    name: 'Harkonnen Flamer',
    text: '[When Defeated:] Deal 1 damage to each enemy ground unit.',
    front: {
      whenDefeated: (g, self) => {
        for (const id of unitIds(g, (u) => u.arena === 'ground' && g.controller(u) !== self.controller)) g.damage(id, 1, self)
      },
    },
  },
  {
    name: 'Old Artillery',
    text: '[When Played/On Attack:] Defeat a non-unique upgrade.',
    front: {
      whenPlayed: (g, self) => defeatNonUniqueUpgrade(g, self),
      onAttack: (g, self) => defeatNonUniqueUpgrade(g, self),
    },
  },
  {
    name: 'Sietch Sayyadina',
    text: '[Restore 1]\n[When Played:] Draw a card. Then, discard a card from your hand.',
    front: {
      whenPlayed: (g, self) => {
        g.draw(self.controller, 1)
        g.discardChosen(self.controller, 1, `${self.def.name}: choose a card to discard`)
      },
    },
  },
  {
    name: 'Scouting \'Thopter',
    text: '[RAID 1]\n[When Played/On Attack:] Look at the top card of your deck. You may put it on the bottom of your deck or discard it.',
    front: { whenPlayed: scout, onAttack: scout },
  },
  {
    name: 'Kanly',
    text: 'Deal 2 damage to a unit. Then, you may defeat a friendly non-leader unit. If you do, deal damage equal to its power to the same unit.',
    front: {
      play: (g, self) => {
        const target = g.chooseOne(self.controller, 'Kanly: deal 2 damage to a unit', unitIds(g, () => true), { ai: 'harm', source: self.def.id })
        if (!target) return
        g.damage(target, 2, self)
        if (!g.unit(target)) return
        const friends = unitIds(g, (u) => g.controller(u) === self.controller && !u.leader)
        const sacrifice = g.chooseOne(self.controller, `Kanly: you may defeat a friendly non-leader unit to deal its power to ${g.name(target)}`, friends, {
          optional: true,
          // The AI keeps its units
          ai: 'none',
          source: self.def.id,
        })
        if (!sacrifice) return
        const power = g.power(g.unit(sacrifice)!)
        g.defeat(sacrifice)
        g.damage(target, power, self)
      },
    },
  },
  {
    name: 'Sabotage',
    text: 'Choose one:\n• Defeat an upgrade.\n• Deal 2 damage to a base.',
    front: {
      play: (g, self) => {
        const upgrades = g.upgrades()
        const enemyUpgrade = upgrades.some((u) => g.controller(u.unit) !== self.controller)
        const choice = g.option(self.controller, 'Sabotage: choose one', ['Defeat an upgrade', 'Deal 2 damage to a base'], {
          ai: enemyUpgrade ? 0 : 1,
          source: self.def.id,
        })
        if (choice === 0) {
          const pick = g.chooseOne(self.controller, 'Sabotage: choose an upgrade to defeat', upgrades.map((u) => u.id), { ai: 'harm', source: self.def.id })
          if (pick) g.defeatUpgrade(pick)
        } else {
          const pick = g.chooseOne(self.controller, 'Sabotage: choose a base', bases(), { ai: 'harm', source: self.def.id })
          if (pick) g.damage(pick, 2, self)
        }
      },
    },
  },
]

function defeatNonUniqueUpgrade(g: Game, self: Self) {
  const upgrades = g.upgrades().filter((u) => !g.def(u).unique)
  const pick = g.chooseOne(self.controller, `${self.def.name}: defeat a non-unique upgrade`, upgrades.map((u) => u.id), {
    ai: 'harm',
    source: self.def.id,
  })
  if (pick) g.defeatUpgrade(pick)
}

// --- Finding a card's script ---

// Spacing and line ends aside, the text as written
const normal = (text = '') =>
  text
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join('\n')

// A card is known by its name and, for a unique one, its subtitle
const keyOf = (name: string, subtitle?: string) => `${name}|${subtitle?.trim() ?? ''}`
const byKey = new Map(dune.map((script) => [keyOf(script.name, script.subtitle), script]))

export function scriptFor(card: CardDef): CardScript | undefined {
  const script = byKey.get(keyOf(card.name, card.subtitle))
  if (!script || normal(script.text) !== normal(card.text)) return undefined
  if (card.type === 'leader' && normal(script.backText) !== normal(card.backText)) return undefined
  return script
}

// Whether a card's text does something: 'scripted'; 'outdated' when its script was written
// for text since changed; 'none' for text no script plays yet; 'blank' for a card with no text
export function scriptStatus(card: CardDef): 'scripted' | 'outdated' | 'none' | 'blank' {
  if (scriptFor(card)) return 'scripted'
  if (byKey.has(keyOf(card.name, card.subtitle))) return 'outdated'
  return normal(card.text) || normal(card.backText) ? 'none' : 'blank'
}

const nothing: Abilities = {}

export function abilitiesOf(card: CardDef, side: 'front' | 'back'): Abilities {
  const script = scriptFor(card)
  if (!script) return nothing
  return (side === 'back' ? script.back : script.front) ?? nothing
}

// For the scripts' own test: every script, by name
export const scripts = dune
