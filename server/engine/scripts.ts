import type { Game } from './game.ts'
import { enginePlays } from './cards.ts'
import type { CardDef, Keywords, PlayerId, UnitState } from './types.ts'

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
  // Played from the resources using Smuggle, or Plot
  smuggled?: boolean
  plot?: boolean
  // The card other is, when it has left play (a unit defeated, an event played)
  otherDef?: CardDef
  // An upgrade's unit
  attachedTo?: string
  // A Spice token defeated: whose, and by whom
  spice?: { owner: PlayerId; by: PlayerId }
}

// What a card gives a unit for as long as it is in play: "Other friendly [{Sardaukar}] units gain
// [Sentinel]."
export type Grant = { keywords?: Keywords; power?: number; hp?: number }

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
  // When this unit is attacked
  whenDefending?: Ability
  // When you play another card; self.other and self.otherDef are that card
  whenYouPlay?: Ability
  // When you create a token unit; self.other is the token
  whenYouCreate?: Ability
  // When any Spice token is defeated; self.spice says whose, and by whom
  whenSpiceDefeated?: Ability
  // When another friendly unit is defeated; self.otherDef is that unit
  whenFriendlyDefeated?: Ability
  // When the regroup phase starts
  regroupStart?: Ability
  // What it gives a unit (each unit on its side is asked)
  gives?: (g: Game, self: Self, unit: UnitState) => Grant | undefined
  // Whether the additional costs of a card being played may be ignored
  ignoresAdditionalCost?: (g: Game, self: Self, card: CardDef) => boolean
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
        g.discardChosen(enemy(g, self), 1, `${self.def.name} makes you discard a card`, self.def.id)
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
        g.discardChosen(self.controller, 1, `${self.def.name}: discard a card from your hand`, self.def.id)
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

  // --- Tokens, and cards that make them ---
  {
    name: 'Spice',
    text: '[Action:] Defeat this token. Look at the top 3 cards of your deck. Draw 1 of them. Put each of the others on the top or bottom of your deck in any order, or discard it.',
    front: {
      actions: [
        {
          label: 'draw 1 of your top 3 cards',
          run: (g, self) => {
            const p = self.controller
            if (!g.defeatSpice(p, self.id)) return
            const top = g.top(p, 3)
            const drawn = g.chooseOne(p, 'Spice: draw 1 of the top 3 cards of your deck', top.map((c) => c.id), {
              ai: 'best',
              source: self.def.id,
            })
            if (drawn) g.drawCard(p, drawn)
            // One after the other: a card put on top goes over those put there before it
            for (const card of top.filter((c) => c.id !== drawn)) {
              const where = g.option(p, `Spice: put ${g.def(card).name}…`, ['On top of your deck', 'On the bottom of your deck', 'In your discard pile'], {
                // The AI keeps what it can soon pay for
                ai: g.def(card).cost > g.player(p).resources.length + 2 ? 1 : 0,
                source: self.def.id,
                card: card.def,
              })
              if (where === 0) g.toTop(p, card.id)
              else if (where === 1) g.toBottom(p, card.id)
              else g.mill(p, card.id)
            }
          },
        },
      ],
    },
  },
  {
    name: 'Spice Runner',
    text: '[When Defeated:] Create a Spice token.',
    front: { whenDefeated: (g, self) => g.createSpice(self.controller) },
  },
  {
    name: 'Spice Smuggler',
    text: '[When Played:] Create a Spice token.\n[Smuggle [[3 Cunning]]]\n[When played using Smuggle:] Create a Spice token.',
    front: { whenPlayed: (g, self) => g.createSpice(self.controller, self.smuggled ? 2 : 1) },
  },
  {
    name: "Smuggler's 'Thopter",
    text: "[When Played:] Create a Spice token. If you control a [{Spacing Guild}] unit, draw a card.\n[Smuggle [[4 Cunning]]]\n[When played using Smuggle:] Create a Spice token.",
    front: {
      whenPlayed: (g, self) => {
        g.createSpice(self.controller)
        if (g.units((u) => g.controller(u) === self.controller && g.hasTrait(u, 'Spacing Guild')).length) g.draw(self.controller, 1)
        if (self.smuggled) g.createSpice(self.controller)
      },
    },
  },
  {
    name: 'Smuggled Spice',
    text: 'Create a Spice token.\n[Smuggle [[2 Cunning]]]\n[When played using Smuggle:] Create another Spice token.',
    front: { play: (g, self) => g.createSpice(self.controller, self.smuggled ? 2 : 1) },
  },
  {
    name: "Smuggler's Harvester",
    text: '[Hidden]\n[When Played/On Attack:] If you control an [{Arrakis}] base, create a Spice token.',
    front: { whenPlayed: arrakisSpice, onAttack: arrakisSpice },
  },
  {
    name: 'Harkonnen Harvester',
    text: '[When Played/On Attack:] If you control an [{Arrakis}] base, create a Spice token, then you may deal 2 damage to a friendly unit. If you do, create another Spice token.',
    front: { whenPlayed: harkonnenHarvest, onAttack: harkonnenHarvest },
  },
  {
    name: 'Liet Kynes',
    subtitle: 'Imperial Planetologist',
    text: '[When Played/On Attack:] You may defeat a friendly Spice token. If you do, heal 3 damage from your base.\n[When Defeated:] Create 2 Spice tokens.',
    front: {
      whenPlayed: kynesHeal,
      onAttack: kynesHeal,
      whenDefeated: (g, self) => g.createSpice(self.controller, 2),
    },
  },
  {
    name: 'CHOAM Spice Broker',
    text: '[When Played:] Create a Spice token. Then, you may pay [2]. If you do, create another Spice token.',
    front: {
      whenPlayed: (g, self) => {
        const p = self.controller
        g.createSpice(p)
        if (!g.canPay(p, 2)) return
        // The AI pays with resources to spare
        if (g.may(p, 'CHOAM Spice Broker: pay 2 resources to create another Spice token?', { yes: 'Pay 2', no: 'Skip', ai: g.canPay(p, 4), source: self.def.id }) && g.pay(p, 2))
          g.createSpice(p)
      },
    },
  },
  {
    name: 'Desert Power',
    text: 'Create 2 Fremen tokens and ready them.',
    front: {
      play: (g, self) => {
        for (let i = 0; i < 2; i++) g.createToken(self.controller, 'Fremen', { ready: true })
      },
    },
  },
  {
    name: 'Fedaykin Death Commando',
    text: '[Grit]\n[When Played:] Give an Experience token to this unit for each other friendly [{Fremen}] unit.\n[When Defeated:] Create a Fremen token.',
    front: {
      whenPlayed: (g, self) => {
        const fremen = g.units((u) => g.controller(u) === self.controller && u.id !== self.id && g.hasTrait(u, 'Fremen'))
        if (fremen.length) g.giveToken(self.id, 'Experience', fremen.length)
      },
      whenDefeated: (g, self) => {
        g.createToken(self.controller, 'Fremen')
      },
    },
  },
  {
    name: 'Missionaria Sister',
    text: '[When Played:] If you control an [{Arrakis}] base, create a Fremen token.',
    front: {
      whenPlayed: (g, self) => {
        if (g.controlsArrakis(self.controller)) g.createToken(self.controller, 'Fremen')
      },
    },
  },
  {
    name: 'Stilgar',
    subtitle: 'Naib of Sietch Tabr',
    text: '[Action [[1, Arrow]]:] Create a Fremen token.',
    backText: 'While you control an [{Arrakis}] base, this unit gains [Hidden].\n[On Attack:] Create a Fremen token.',
    front: {
      actions: [
        {
          label: 'create a Fremen token',
          resources: 1,
          exhaust: true,
          run: (g, self) => {
            g.createToken(self.controller, 'Fremen')
          },
        },
      ],
    },
    back: {
      onAttack: (g, self) => {
        g.createToken(self.controller, 'Fremen')
      },
    },
  },
  {
    name: 'Atreides Shield Trooper',
    text: '[When Played:] If you control an [{Arrakis}] base, give an Experience token to this unit. Otherwise, give a Shield token to this unit.',
    front: {
      whenPlayed: (g, self) => g.giveToken(self.id, g.controlsArrakis(self.controller) ? 'Experience' : 'Shield'),
    },
  },
  {
    name: 'Sardaukar Levenbrech',
    text: 'As an additional cost to play this unit, defeat a friendly Spice token.\n[When Played:] You may defeat a non-unique upgrade.',
    front: {
      whenPlayed: (g, self) => {
        const upgrades = g.upgrades().filter((u) => !g.def(u).unique)
        // The AI defeats an enemy's upgrade, never its own
        const enemy = upgrades.find((u) => g.controller(u.unit) !== self.controller)
        const pick = g.chooseOne(self.controller, 'Sardaukar Levenbrech: you may defeat a non-unique upgrade', upgrades.map((u) => u.id), {
          optional: true,
          ai: enemy?.id ?? 'none',
          source: self.def.id,
        })
        if (pick) g.defeatUpgrade(pick)
      },
    },
  },
  {
    name: 'Sardaukar Bashar',
    text: "As an additional cost to play this unit, defeat a friendly Spice token.\n[When Played:] Give an Experience token to another friendly [{Trooper}] unit. If it's a [{Sardaukar}] unit, ready it.",
    front: {
      whenPlayed: (g, self) => {
        const troopers = unitIds(g, (u) => g.controller(u) === self.controller && u.id !== self.id && g.hasTrait(u, 'Trooper'))
        const pick = g.chooseOne(self.controller, 'Sardaukar Bashar: give an Experience token to another friendly Trooper unit', troopers, {
          ai: 'help',
          source: self.def.id,
        })
        if (!pick) return
        g.giveToken(pick, 'Experience')
        const unit = g.unit(pick)
        if (unit && g.hasTrait(unit, 'Sardaukar')) g.ready(pick)
      },
    },
  },

  // --- Spice token triggers: bases ---
  {
    name: 'Castle Caladan',
    text: '[When you defeat a friendly Spice token:] Heal 1 damage from a unit or base.',
    front: { whenSpiceDefeated: (g, self) => youDefeatSpice(self) && healOne(g, self, 1) },
  },
  {
    name: 'Harkonnen Gladiator Arena',
    text: '[When you defeat a friendly Spice token:] A friendly unit gains [Raid 1] for this phase.',
    front: {
      whenSpiceDefeated: (g, self) => {
        if (!youDefeatSpice(self)) return
        const pick = g.chooseOne(self.controller, 'Harkonnen Gladiator Arena: a friendly unit gains Raid 1 for this phase', friendlyIds(g, self), {
          ai: 'help',
          source: self.def.id,
        })
        if (pick) g.grant(pick, { raid: 1 }, 'phase')
      },
    },
  },
  {
    name: 'Imperial Prison Planet',
    text: '[When you defeat a friendly Spice token:] You may deal 1 damage to a friendly unit. If you do and it survives, give an Experience token to it.',
    front: {
      whenSpiceDefeated: (g, self) => {
        if (!youDefeatSpice(self)) return
        const ids = friendlyIds(g, self)
        // The AI toughens its strongest unit that survives the damage
        const tough = g
          .units((u) => ids.includes(u.id) && g.hp(u) - u.damage > 1)
          .sort((a, b) => g.power(b) - g.power(a))[0]
        const pick = g.chooseOne(self.controller, 'Imperial Prison Planet: you may deal 1 damage to a friendly unit to give it an Experience token', ids, {
          optional: true,
          ai: tough?.id ?? 'none',
          source: self.def.id,
        })
        if (pick && g.damage(pick, 1, self) && g.unit(pick)) g.giveToken(pick, 'Experience')
      },
    },
  },
  {
    name: 'Mother School',
    text: '[When you defeat a friendly Spice token:] Look at the top card of your deck. You may discard it.',
    front: {
      whenSpiceDefeated: (g, self) => {
        if (!youDefeatSpice(self)) return
        const [top] = g.top(self.controller, 1)
        if (!top) return
        const where = g.option(self.controller, `Mother School: the top card of your deck is ${g.def(top).name}`, ['Leave it on top', 'Discard it'], {
          ai: g.def(top).cost > g.player(self.controller).resources.length + 2 ? 1 : 0,
          source: self.def.id,
          card: top.def,
        })
        if (where === 1) g.mill(self.controller, top.id)
      },
    },
  },

  // --- Spice token triggers: units ---
  {
    name: "Tuek's Lighter",
    subtitle: "Smuggler's Run",
    text: '[Raid 1]\n[When you defeat a friendly Spice token:] You may ready this unit. Use this ability only once each round.',
    front: {
      whenSpiceDefeated: (g, self) => {
        if (!youDefeatSpice(self) || g.used(self) || !g.unit(self.id)?.exhausted) return
        if (!g.may(self.controller, "Tuek's Lighter: ready this unit?", { yes: 'Ready it', no: 'Skip', source: self.def.id })) return
        g.use(self)
        g.ready(self.id)
      },
    },
  },
  {
    name: 'Staban Tuek',
    subtitle: 'The Unseen Network',
    text: '[Hidden]\n[Smuggle] [[6 Cunning]]\n[When Played:] Draw a card.\nWhenever an opponent defeats a Spice token, create a Spice token. Use this ability only once each round.',
    front: {
      whenPlayed: (g, self) => g.draw(self.controller, 1),
      whenSpiceDefeated: (g, self) => {
        if (self.spice?.by === self.controller || g.used(self)) return
        g.use(self)
        g.createSpice(self.controller)
      },
    },
  },
  {
    name: 'Harkonnen Harvester Team',
    text: 'Whenever a friendly [{Harkonnen}] unit is defeated, create a Spice token. Use this ability only once each round.',
    front: {
      whenFriendlyDefeated: (g, self) => {
        if (!self.otherDef?.traits.includes('Harkonnen') || g.used(self)) return
        g.use(self)
        g.createSpice(self.controller)
      },
    },
  },
  {
    name: 'Spice Harvester',
    text: '[When Played/On Attack:] If you control an [{Arrakis}] base, create a Spice token.\n\n[When the regroup phase starts:] You may defeat 3 friendly Spice tokens. If you do, put the top card of your deck into play as a resource.',
    front: {
      whenPlayed: arrakisSpice,
      onAttack: arrakisSpice,
      regroupStart: (g, self) => {
        const p = self.controller
        if (g.spice(p) < 3) return
        if (!g.may(p, 'Spice Harvester: defeat 3 Spice tokens to put the top card of your deck into play as a resource?', { yes: 'Defeat 3 Spice tokens', no: 'Skip', source: self.def.id }))
          return
        for (let i = 0; i < 3; i++) g.defeatSpice(p)
        g.resourceFromDeck(p)
      },
    },
  },
  {
    name: 'Ginaz Mercenary',
    text: '[On Attack:] You may defeat a friendly Spice token. If you do, this unit gets [+2/+0] for this attack.',
    front: {
      onAttack: (g, self) => {
        const p = self.controller
        if (!g.spice(p)) return
        // The AI keeps its last Spice token
        if (!g.may(p, 'Ginaz Mercenary: defeat a Spice token for +2/+0 for this attack?', { yes: 'Defeat a Spice token', no: 'Skip', ai: g.spice(p) > 1, source: self.def.id }))
          return
        if (g.defeatSpice(p)) g.buff(self.id, 2, 0, 'attack')
      },
    },
  },
  {
    name: 'Spice Hunter',
    text: '[On Attack:] If you control another [{Fremen}] unit, you may defeat an enemy Spice token. ',
    front: {
      onAttack: (g, self) => {
        const p = self.controller
        const foe = enemy(g, self)
        if (!g.spice(foe) || !g.units((u) => g.controller(u) === p && u.id !== self.id && g.hasTrait(u, 'Fremen')).length) return
        if (g.may(p, 'Spice Hunter: defeat an enemy Spice token?', { yes: 'Defeat it', no: 'Skip', source: self.def.id })) g.defeatSpice(foe, undefined, p)
      },
    },
  },
  {
    name: 'Fremen Saboteurs',
    text: '[Saboteur]\n[When Played:] You may defeat an enemy Spice token or an upgrade on an enemy unit. If you do, deal 2 damage to a unit or base.\n',
    front: {
      whenPlayed: (g, self) => {
        const p = self.controller
        const foe = enemy(g, self)
        const upgrades = g.upgrades().filter((u) => g.controller(u.unit) === foe)
        const ids = [...g.spiceIds(foe).slice(0, 1), ...upgrades.map((u) => u.id)]
        const real = upgrades.find((u) => !g.def(u).token || g.def(u).name !== 'Weakness')
        const pick = g.chooseOne(p, 'Fremen Saboteurs: you may defeat an enemy Spice token or an upgrade on an enemy unit', ids, {
          optional: true,
          ai: real?.id ?? ids[0] ?? 'none',
          source: self.def.id,
        })
        if (!pick) return
        if (g.spiceIds(foe).includes(pick)) g.defeatSpice(foe, pick, p)
        else g.defeatUpgrade(pick)
        const target = g.chooseOne(p, 'Fremen Saboteurs: deal 2 damage to a unit or base', [...g.units().map((u) => u.id), ...bases()], {
          ai: 'harm',
          source: self.def.id,
        })
        if (target) g.damage(target, 2, self)
      },
    },
  },
  {
    name: 'Spotter \'Thopter',
    text: '[When Played/On Attack:] If you control an [{Arrakis}] base and a [{Harvester}] [{Vehicle}] unit, create a Spice token.',
    front: { whenPlayed: spotterSpice, onAttack: spotterSpice },
  },
  {
    name: 'Guild Navigator',
    text: '[Sentinel]\n[When Played:] You may defeat a friendly Spice token. If you do, look at the top 5 cards of your deck. Draw 1 of them, discard any number of them and put the rest on the bottom of your deck in any order.',
    front: {
      whenPlayed: (g, self) => {
        const p = self.controller
        if (!g.spice(p)) return
        if (!g.may(p, 'Guild Navigator: defeat a Spice token to look at the top 5 cards of your deck?', { yes: 'Defeat a Spice token', no: 'Skip', source: self.def.id }))
          return
        if (!g.defeatSpice(p)) return
        const top = g.top(p, 5)
        const drawn = g.chooseOne(p, 'Guild Navigator: draw 1 of the top 5 cards of your deck', top.map((c) => c.id), { ai: 'best', source: self.def.id })
        if (drawn) g.drawCard(p, drawn)
        const rest = top.filter((c) => c.id !== drawn).map((c) => c.id)
        const discarded = g.choose(p, 'Guild Navigator: discard any number of them; the rest go to the bottom of your deck', rest, {
          min: 0,
          max: rest.length,
          ai: 'none',
          source: self.def.id,
        })
        for (const id of rest) {
          if (discarded.includes(id)) g.mill(p, id)
          else g.toBottom(p, id)
        }
      },
    },
  },

  // --- Experience, Shield and Weakness tokens ---
  {
    name: 'Shadout Mapes',
    subtitle: 'Keeper of the Household',
    text: '[Sentinel]\n[When Defeated:] Give an Experience token to a friendly unit.',
    front: {
      whenDefeated: (g, self) => experienceTo(g, self, friendlyIds(g, self), 'Shadout Mapes: give an Experience token to a friendly unit'),
    },
  },
  {
    name: 'Gurney Halleck',
    subtitle: 'Warrior-Troubadour',
    text: '[Saboteur]\n[When Played/On Attack:] Give an Experience token to another friendly [{Atreides}] unit.',
    front: { whenPlayed: otherAtreidesExperience, onAttack: otherAtreidesExperience },
  },
  {
    name: 'Duke Leto Atreides',
    subtitle: 'The Red Duke',
    text: '[When Played/When Defeated:] Give an Experience token to each other friendly [{Atreides}] unit.',
    front: { whenPlayed: eachAtreidesExperience, whenDefeated: eachAtreidesExperience },
  },
  {
    name: 'Atreides House Guard',
    text: '<While you control another [{Atreides}] unit, this unit gains [Sentinel].>\n[When Defeated:] Give an Experience token to another friendly [{Atreides}] unit.',
    front: {
      gives: (g, self, unit) => (unit.id === self.id && anotherAtreides(g, self) ? { keywords: { sentinel: true } } : undefined),
      whenDefeated: otherAtreidesExperience,
    },
  },
  {
    name: 'Dr. Wellington Yueh',
    subtitle: 'Suk Doctor',
    text: '[When Played:] Heal 2 damage from a unit or base.\n[When Defeated:] Exhaust your leader. Defeat each Shield token on friendly units.',
    front: {
      whenPlayed: (g, self) => healOne(g, self, 2),
      whenDefeated: (g, self) => {
        g.exhaustLeader(self.controller)
        for (const upgrade of g.upgrades())
          if (g.controller(upgrade.unit) === self.controller && g.def(upgrade).token && g.def(upgrade).name === 'Shield') g.defeatUpgrade(upgrade.id)
      },
    },
  },
  {
    name: 'Esmar Tuek',
    subtitle: 'Smuggler Chief',
    text: '[When Played:] If you control a [Command] unit, give 2 Experience tokens to a friendly [{Underworld}] unit. Then, if you control an [Aggression] unit, this unit may deal damage equal to its power to a unit.',
    front: {
      whenPlayed: (g, self) => {
        const p = self.controller
        const controls = (aspect: string) => g.units((u) => g.controller(u) === p && (g.def(u).aspects as string[]).includes(aspect)).length > 0
        if (controls('Command')) {
          const underworld = friendlyIds(g, self, (u) => g.hasTrait(u, 'Underworld'))
          const pick = g.chooseOne(p, 'Esmar Tuek: give 2 Experience tokens to a friendly Underworld unit', underworld, { ai: 'help', source: self.def.id })
          if (pick) g.giveToken(pick, 'Experience', 2)
        }
        const me = g.unit(self.id)
        if (!me || !controls('Aggression')) return
        const target = g.chooseOne(p, `Esmar Tuek: you may deal ${g.power(me)} damage to a unit`, g.units().map((u) => u.id), {
          optional: true,
          ai: 'harm',
          source: self.def.id,
        })
        if (target) g.damage(target, g.power(me), self)
      },
    },
  },
  {
    name: 'Tleilaxu Face Dancer',
    text: "[Sentinel]\n[When Played:] Choose another unit. Give this unit Experience tokens equal to half the total of that unit's power and HP, rounded down.",
    front: {
      whenPlayed: (g, self) => {
        const others = g.units((u) => u.id !== self.id)
        const total = (u: UnitState) => g.power(u) + g.hp(u)
        const biggest = [...others].sort((a, b) => total(b) - total(a))[0]
        const pick = g.chooseOne(self.controller, 'Tleilaxu Face Dancer: choose another unit to copy', others.map((u) => u.id), {
          ai: biggest?.id,
          source: self.def.id,
        })
        const copied = pick ? g.unit(pick) : undefined
        if (copied) g.giveToken(self.id, 'Experience', Math.floor(total(copied) / 2))
      },
    },
  },
  {
    name: 'Feyd-Rautha Harkonnen',
    subtitle: 'na-Baron',
    text: '[Sentinel]\n[When this unit attacks or is attacked:] Give a Weakness token to the other unit in the combat.',
    front: {
      onAttack: (g, self) => {
        const target = self.attack?.target
        if (target && target !== 'base') g.giveToken(target, 'Weakness')
      },
      whenDefending: (g, self) => {
        if (self.other) g.giveToken(self.other, 'Weakness')
      },
    },
  },
  {
    name: 'Lasgun',
    text: '[When Played:] If attached unit is a [{Trooper}] unit, defeat another upgrade. If it was a Shield token, deal 3 damage to the unit it was attached to.',
    front: {
      whenPlayed: (g, self) => {
        const unit = g.unit(self.other ?? '')
        if (!unit || !g.hasTrait(unit, 'Trooper')) return
        const upgrades = g.upgrades().filter((u) => u.id !== self.id)
        const theirs = upgrades.filter((u) => g.controller(u.unit) !== self.controller)
        const shield = theirs.find((u) => g.def(u).token && g.def(u).name === 'Shield')
        const mine = upgrades.find((u) => g.def(u).token && g.def(u).name === 'Weakness')
        const pick = g.chooseOne(self.controller, 'Lasgun: defeat another upgrade', upgrades.map((u) => u.id), {
          ai: shield?.id ?? theirs[0]?.id ?? mine?.id,
          source: self.def.id,
        })
        const chosen = upgrades.find((u) => u.id === pick)
        if (!chosen) return
        const wasShield = g.def(chosen).token && g.def(chosen).name === 'Shield'
        g.defeatUpgrade(chosen.id)
        if (wasShield) g.damage(chosen.unit.id, 3, self)
      },
    },
  },
  {
    name: 'Sardaukar Vow',
    text: 'Attach to a non-[{Vehicle}] unit.\nAttached unit gains [Sentinel].\n[When Played:] If attached unit is a [{Sardaukar}] unit, give a Shield token to it.',
    front: {
      whenPlayed: (g, self) => {
        const unit = g.unit(self.other ?? '')
        if (unit && g.hasTrait(unit, 'Sardaukar')) g.giveToken(unit.id, 'Shield')
      },
    },
  },
  {
    name: 'Personal Shield',
    text: 'Attach to a friendly unit.\n[When Played:] If you control an [{Arrakis}] base, defeat attached unit. Otherwise, give a Shield token to attached unit.\n[When the regroup phase starts:] If attached unit has no Shield token, give a Shield token to it.',
    front: {
      whenPlayed: (g, self) => {
        if (!self.other) return
        if (g.controlsArrakis(self.controller)) g.defeat(self.other)
        else g.giveToken(self.other, 'Shield')
      },
      regroupStart: (g, self) => {
        if (self.attachedTo && !g.tokens(self.attachedTo, 'Shield')) g.giveToken(self.attachedTo, 'Shield')
      },
    },
  },
  {
    name: 'Piter De Vries',
    subtitle: 'Twisted Mentat',
    text: '[When Played:] Draw 2 cards, then put a card from your hand on the top or bottom of your deck or discard it.\n[PLOT]\n[When Played using Plot:] Give a Weakness token to each enemy unit. Then, defeat this unit.',
    front: {
      whenPlayed: (g, self) => {
        drawTwoPutOne(g, self)
        if (!self.plot) return
        for (const unit of g.units((u) => g.controller(u) !== self.controller)) g.giveToken(unit.id, 'Weakness')
        g.defeat(self.id)
      },
    },
  },

  // --- Leaders ---
  {
    name: 'Lady Jessica',
    subtitle: 'Bene Gesserit',
    text: '[When you play a [{Bene Gesserit}] card:] You may exhaust this leader. If you do, exhaust an enemy non-leader ground unit that costs [#4] or less.',
    backText:
      '[Restore 2]\n[When Deployed:] Return a [{Bene Gesserit}] or [{Fremen}] unit from your discard pile to your hand.\nWhen a friendly Spice token is defeated: Heal 2 damage from a unit or base.',
    front: {
      whenYouPlay: (g, self) => {
        const p = self.controller
        if (!self.otherDef?.traits.includes('Bene Gesserit') || !g.leaderReady(p)) return
        const targets = g.units((u) => g.controller(u) !== p && !u.leader && u.arena === 'ground' && g.cost(u) <= 4 && !u.exhausted)
        if (!targets.length) return
        if (!g.may(p, 'Lady Jessica: exhaust this leader to exhaust an enemy ground unit that costs 4 or less?', { yes: 'Exhaust', no: 'Skip', source: self.def.id })) return
        g.exhaustLeader(p)
        const pick = g.chooseOne(p, 'Lady Jessica: exhaust an enemy non-leader ground unit that costs 4 or less', targets.map((u) => u.id), {
          ai: 'harm',
          source: self.def.id,
        })
        if (pick) g.exhaust(pick)
      },
    },
    back: {
      whenDeployed: (g, self) => {
        const p = self.controller
        const units = g
          .player(p)
          .discard.filter((c) => g.def(c).type === 'unit' && (g.hasTrait(c, 'Bene Gesserit') || g.hasTrait(c, 'Fremen')))
          .map((c) => c.id)
        const pick = g.chooseOne(p, 'Lady Jessica: return a Bene Gesserit or Fremen unit from your discard pile to your hand', units, {
          ai: 'best',
          source: self.def.id,
        })
        if (pick) g.fromDiscard(p, pick)
      },
      whenSpiceDefeated: (g, self) => {
        if (self.spice?.owner === self.controller) healOne(g, self, 2)
      },
    },
  },
  {
    name: 'Chani',
    subtitle: 'Sihaya',
    text: '[When you play a [{Fremen}] unit or create a [{Fremen}] token:] You may exhaust this leader. If you do, deal 1 damage to an enemy base.',
    backText:
      'While you control an [{Arrakis}] base, this unit gains [Hidden].\n[When you play a [{Fremen}] unit or create a [{Fremen}] token:] Deal 1 damage to an enemy unit or base.',
    front: { whenYouPlay: chaniLeader, whenYouCreate: chaniLeader },
    back: { whenYouPlay: chaniUnit, whenYouCreate: chaniUnit },
  },
  {
    name: 'Shaddam IV',
    subtitle: 'Padishah Emperor',
    text: 'You start the game with a [Spice Token].\n[Action [Arrow]:] Play a [{Sardaukar}] card from your hand, ignoring its additional costs.',
    backText:
      'Once each round, when you play a [{Sardaukar}] card, you may ignore its additional costs.\n[When Deployed:] You may play a [{Sardaukar}] unit from your hand or discard pile for free.\nOther friendly [{Sardaukar}] units gain [Sentinel].',
    front: {
      actions: [
        {
          label: 'play a Sardaukar card, ignoring its additional costs',
          exhaust: true,
          can: (g, self) => sardaukarInHand(g, self).length > 0,
          run: (g, self) => {
            const ids = sardaukarInHand(g, self)
            const pick = g.chooseOne(self.controller, 'Shaddam IV: play a Sardaukar card from your hand, ignoring its additional costs', ids, {
              ai: 'best',
              source: self.def.id,
            })
            if (pick) g.playCard(self.controller, pick, { ignoreAdditional: true })
          },
        },
      ],
    },
    back: {
      ignoresAdditionalCost: (g, self, card) => card.traits.includes('Sardaukar') && !g.used(self, 'ignoresAdditionalCost'),
      whenDeployed: (g, self) => {
        const p = self.controller
        const player = g.player(p)
        const ids = [...player.hand, ...player.discard]
          .filter((c) => g.def(c).type === 'unit' && g.hasTrait(c, 'Sardaukar') && g.canPlay(p, c.id, { free: true }))
          .map((c) => c.id)
        const pick = g.chooseOne(p, 'Shaddam IV: you may play a Sardaukar unit from your hand or discard pile for free', ids, {
          optional: true,
          ai: 'best',
          source: self.def.id,
        })
        if (pick) g.playCard(p, pick, { free: true })
      },
      gives: (g, self, unit) =>
        unit.id !== self.id && g.controller(unit) === self.controller && g.hasTrait(unit, 'Sardaukar') ? { keywords: { sentinel: true } } : undefined,
    },
  },
  {
    name: 'Baron Vladimir Harkonnen',
    subtitle: 'The Masterstroke',
    text: '[Action [Arrow]:] Defeat a friendly Spice token. If you do, play a card from your resources as if it were played using [Plot]. It costs [1] less. Deal 1 damage to your base.',
    backText: '[When Deployed:] Play up to 2 cards from your resources as if they were played using [Plot]. Each costs [1] less.\n[When Defeated:] Deal 2 damage to each unit.',
    front: {
      actions: [
        {
          label: 'play a card from your resources for 1 less',
          exhaust: true,
          can: (g, self) => g.spice(self.controller) > 0 && plotPlays(g, self).length > 0,
          run: (g, self) => {
            const p = self.controller
            if (!g.defeatSpice(p)) return
            const pick = g.chooseOne(p, 'Baron Vladimir Harkonnen: play a card from your resources, for 1 less', plotPlays(g, self), {
              ai: 'best',
              source: self.def.id,
            })
            if (pick) g.playCard(p, pick, { discount: 1 })
            g.damage(`base${p}`, 1, self)
          },
        },
      ],
    },
    back: {
      whenDeployed: (g, self) => {
        for (let i = 0; i < 2; i++) {
          const pick = g.chooseOne(self.controller, 'Baron Vladimir Harkonnen: you may play a card from your resources, for 1 less', plotPlays(g, self), {
            optional: true,
            ai: 'best',
            source: self.def.id,
          })
          if (!pick || !g.playCard(self.controller, pick, { discount: 1 })) return
        }
      },
      whenDefeated: (g, self) => {
        for (const unit of g.units()) g.damage(unit.id, 2, self)
      },
    },
  },
  {
    name: 'Gurney Halleck',
    subtitle: 'Smuggler of Arrakis',
    text: '[Action [Arrow]:] Defeat a friendly Spice token. If you do, choose one:\n• Play a card using Smuggle. It costs [2] less.\n• Give an Experience token to a friendly [{Underworld}] unit.',
    backText:
      '[On Attack:] You may defeat a friendly Spice token. If you do, choose one:\n• Play a card using Smuggle. It costs [2] less.\n• Give an Experience token to a friendly [{Underworld}] unit.',
    front: {
      actions: [
        {
          label: 'smuggle a card for 2 less, or an Experience token',
          exhaust: true,
          can: (g, self) => g.spice(self.controller) > 0,
          run: (g, self) => {
            if (g.defeatSpice(self.controller)) gurneyChoice(g, self)
          },
        },
      ],
    },
    back: {
      onAttack: (g, self) => {
        const p = self.controller
        if (!g.spice(p)) return
        if (!g.may(p, 'Gurney Halleck: defeat a Spice token to smuggle a card for 2 less, or give an Experience token?', { yes: 'Defeat a Spice token', no: 'Skip', source: self.def.id }))
          return
        if (g.defeatSpice(p)) gurneyChoice(g, self)
      },
    },
  },
  {
    name: 'Duke Leto Atreides',
    subtitle: 'Duke of House Atreides',
    text: '[When you play a unit:] You may exhaust this leader and either pay [1] or defeat a friendly Spice token. If you do, give an Experience token to that unit.',
    backText: '<If you control another [{Atreides}] unit, this unit gains [Sentinel].>\n[When Defeated:] Defeat an enemy non-leader unit.',
    front: {
      whenYouPlay: (g, self) => {
        const p = self.controller
        if (self.otherDef?.type !== 'unit' || !self.other || !g.unit(self.other) || !g.leaderReady(p)) return
        const choices = ['Skip', ...(g.canPay(p, 1) ? ['Pay 1'] : []), ...(g.spice(p) ? ['Defeat a Spice token'] : [])]
        if (choices.length === 1) return
        // The AI spends a spare Spice token, or a spare resource
        const ai = g.spice(p) > 1 ? choices.indexOf('Defeat a Spice token') : g.canPay(p, 3) ? choices.indexOf('Pay 1') : 0
        const choice = choices[g.option(p, `Duke Leto Atreides: exhaust this leader to give ${self.otherDef.name} an Experience token?`, choices, { ai: Math.max(0, ai), source: self.def.id })]
        if (choice === 'Skip') return
        if (choice === 'Pay 1' ? !g.pay(p, 1) : !g.defeatSpice(p)) return
        g.exhaustLeader(p)
        g.giveToken(self.other, 'Experience')
      },
    },
    back: {
      gives: (g, self, unit) => (unit.id === self.id && anotherAtreides(g, self) ? { keywords: { sentinel: true } } : undefined),
      whenDefeated: (g, self) => {
        const targets = unitIds(g, (u) => g.controller(u) !== self.controller && !u.leader)
        const pick = g.chooseOne(self.controller, 'Duke Leto Atreides: defeat an enemy non-leader unit', targets, { ai: 'harm', source: self.def.id })
        if (pick) g.defeat(pick)
      },
    },
  },
  {
    name: 'Princess Irulan',
    subtitle: 'Daughter of the Emperor',
    text: '[When you play an [{Emperor}] unit:] You may exhaust this leader. If you do, give a Shield token to that unit.',
    backText: '[When Deployed:] Give a Shield token to a friendly [{Emperor}] unit.\nFriendly [{Emperor}] units with a Shield get [+1/+0].',
    front: {
      whenYouPlay: (g, self) => {
        const p = self.controller
        if (self.otherDef?.type !== 'unit' || !self.otherDef.traits.includes('Emperor') || !self.other || !g.unit(self.other) || !g.leaderReady(p)) return
        if (!g.may(p, `Princess Irulan: exhaust this leader to give ${self.otherDef.name} a Shield token?`, { yes: 'Exhaust', no: 'Skip', source: self.def.id })) return
        g.exhaustLeader(p)
        g.giveToken(self.other, 'Shield')
      },
    },
    back: {
      whenDeployed: (g, self) => {
        const ids = friendlyIds(g, self, (u) => g.hasTrait(u, 'Emperor'))
        const pick = g.chooseOne(self.controller, 'Princess Irulan: give a Shield token to a friendly Emperor unit', ids, { ai: 'help', source: self.def.id })
        if (pick) g.giveToken(pick, 'Shield')
      },
      gives: (g, self, unit) =>
        g.controller(unit) === self.controller && g.hasTrait(unit, 'Emperor') && g.tokens(unit.id, 'Shield') ? { power: 1 } : undefined,
    },
  },

  // --- Events that make or spend Spice ---
  {
    name: 'The Spice Must Flow',
    text: 'Create 3 Spice tokens. If you control an [{Arrakis}] base, create 4 Spice tokens instead. Each opponent creates a Spice token.',
    front: {
      play: (g, self) => {
        g.createSpice(self.controller, g.controlsArrakis(self.controller) ? 4 : 3)
        g.createSpice(enemy(g, self))
      },
    },
  },
  {
    name: 'Spice Trance',
    text: 'Look at the top 3 cards of your deck. Discard any number of them and put the rest back in any order. Create a Spice token. If you control an [{Arrakis}] base, create another Spice token.',
    front: {
      play: (g, self) => {
        const p = self.controller
        const top = g.top(p, 3).map((c) => c.id)
        const soon = g.player(p).resources.length + 2
        const dear = top.filter((id) => g.def(g.card(id)!).cost > soon)
        const discarded = g.choose(p, 'Spice Trance: discard any number of the top 3 cards of your deck', top, {
          min: 0,
          max: top.length,
          ai: dear[0] ?? 'none',
          source: self.def.id,
        })
        for (const id of discarded) g.mill(p, id)
        // The rest back in the order chosen, the first on top
        let rest = top.filter((id) => !discarded.includes(id))
        const order: string[] = []
        while (rest.length > 1) {
          const next = g.chooseOne(p, 'Spice Trance: choose the next card to put back, from the top down', rest, { ai: 'best', source: self.def.id })
          if (!next) break
          order.push(next)
          rest = rest.filter((id) => id !== next)
        }
        for (const id of [...order, ...rest].reverse()) g.toTop(p, id)
        g.createSpice(p, g.controlsArrakis(p) ? 2 : 1)
      },
    },
  },
  {
    name: 'Spice Raid',
    text: 'Deal 2 damage to a ground unit. If that unit is defeated this way, create a Spice token.',
    front: {
      play: (g, self) => {
        const pick = g.chooseOne(self.controller, 'Spice Raid: deal 2 damage to a ground unit', unitIds(g, (u) => u.arena === 'ground'), {
          ai: 'harm',
          source: self.def.id,
        })
        if (pick && g.damage(pick, 2, self) && !g.unit(pick)) g.createSpice(self.controller)
      },
    },
  },
  {
    name: 'Lasgun Volley',
    text: 'Deal 4 damage to a unit. Then, you may defeat a friendly Spice token. If you do, deal 2 damage to the same unit.',
    front: {
      play: (g, self) => {
        const p = self.controller
        const pick = g.chooseOne(p, 'Lasgun Volley: deal 4 damage to a unit', g.units().map((u) => u.id), { ai: 'harm', source: self.def.id })
        if (!pick) return
        g.damage(pick, 4, self)
        if (!g.unit(pick) || !g.spice(p)) return
        if (g.may(p, `Lasgun Volley: defeat a Spice token to deal 2 more damage to ${g.name(pick)}?`, { yes: 'Defeat a Spice token', no: 'Skip', source: self.def.id }) && g.defeatSpice(p))
          g.damage(pick, 2, self)
      },
    },
  },
  {
    name: 'War of Assassins',
    text: 'You may defeat 2 friendly Spice tokens. If you do, defeat a unit. Otherwise, defeat a non-leader unit.',
    front: {
      play: (g, self) => {
        const p = self.controller
        const leader = g.units((u) => !!u.leader && g.controller(u) !== p).length > 0
        const paid =
          g.spice(p) >= 2 &&
          g.may(p, 'War of Assassins: defeat 2 Spice tokens to be able to defeat a leader unit?', { yes: 'Defeat 2 Spice tokens', no: 'Skip', ai: leader, source: self.def.id })
        if (paid) for (let i = 0; i < 2; i++) g.defeatSpice(p)
        const pick = g.chooseOne(p, `War of Assassins: defeat a ${paid ? '' : 'non-leader '}unit`, unitIds(g, (u) => paid || !u.leader), {
          ai: 'harm',
          source: self.def.id,
        })
        if (pick) g.defeat(pick)
      },
    },
  },
  {
    name: 'Coriolis Storm',
    text: "You may defeat a friendly Spice token. If you do, return a non-leader unit to its owner's hand. Otherwise, return a non-leader unit that costs [#6] or less to its owner's hand.",
    front: {
      play: (g, self) => {
        const p = self.controller
        const big = g.units((u) => g.controller(u) !== p && !u.leader && g.cost(u) > 6).length > 0
        const paid =
          g.spice(p) > 0 &&
          g.may(p, "Coriolis Storm: defeat a Spice token to be able to return a unit that costs more than 6?", { yes: 'Defeat a Spice token', no: 'Skip', ai: big, source: self.def.id }) &&
          g.defeatSpice(p)
        const pick = g.chooseOne(p, "Coriolis Storm: return a non-leader unit to its owner's hand", unitIds(g, (u) => !u.leader && (paid || g.cost(u) <= 6)), {
          ai: 'harm',
          source: self.def.id,
        })
        if (pick) g.returnToHand(pick)
      },
    },
  },
  {
    name: "Earning the Fremen's respect",
    text: 'You may defeat a friendly ground [{Vehicle}] unit, any number of friendly Spice tokens, or both. Create 2 [{Fremen}] tokens if you defeated a unit this way, plus 1 for each Spice token defeated this way.',
    front: {
      play: (g, self) => {
        const p = self.controller
        const vehicles = friendlyIds(g, self, (u) => u.arena === 'ground' && g.hasTrait(u, 'Vehicle') && !u.leader)
        const vehicle = g.chooseOne(p, "Earning the Fremen's respect: you may defeat a friendly ground Vehicle unit", vehicles, {
          optional: true,
          ai: 'none',
          source: self.def.id,
        })
        if (vehicle) g.defeat(vehicle)
        const counts = Array.from({ length: g.spice(p) + 1 }, (_, n) => `${n} Spice token${n === 1 ? '' : 's'}`)
        const spent = counts.length > 1 ? g.option(p, "Earning the Fremen's respect: defeat how many Spice tokens?", counts, { ai: counts.length - 1, source: self.def.id }) : 0
        for (let i = 0; i < spent; i++) g.defeatSpice(p)
        const fremen = (vehicle ? 2 : 0) + spent
        for (let i = 0; i < fremen; i++) g.createToken(p, 'Fremen')
      },
    },
  },
]

// "When you defeat a friendly Spice token"
const youDefeatSpice = (self: Self) => self.spice?.owner === self.controller && self.spice.by === self.controller

// Friendly units, or those of them a test lets through
const friendlyIds = (g: Game, self: Self, test: (u: UnitState) => boolean = () => true) =>
  unitIds(g, (u) => g.controller(u) === self.controller && test(u))

// "Heal N damage from a unit or base": the AI heals its own
function healOne(g: Game, self: Self, amount: number) {
  const damaged = [
    ...g.units((u) => u.damage > 0).map((u) => u.id),
    ...([0, 1] as PlayerId[]).filter((p) => g.player(p).base.damage > 0).map((p) => `base${p}`),
  ]
  const pick = g.chooseOne(self.controller, `${self.def.name}: heal ${amount} damage from a unit or base`, damaged, { ai: 'help', source: self.def.id })
  if (pick) g.heal(pick, amount, self)
}

function experienceTo(g: Game, self: Self, ids: string[], text: string) {
  const pick = g.chooseOne(self.controller, text, ids, { ai: 'help', source: self.def.id })
  if (pick) g.giveToken(pick, 'Experience')
}

const anotherAtreides = (g: Game, self: Self) => friendlyIds(g, self, (u) => u.id !== self.id && g.hasTrait(u, 'Atreides')).length > 0

// "Give an Experience token to another friendly [{Atreides}] unit."
function otherAtreidesExperience(g: Game, self: Self) {
  const ids = friendlyIds(g, self, (u) => u.id !== self.id && g.hasTrait(u, 'Atreides'))
  experienceTo(g, self, ids, `${self.def.name}: give an Experience token to another friendly Atreides unit`)
}

// "Give an Experience token to each other friendly [{Atreides}] unit."
function eachAtreidesExperience(g: Game, self: Self) {
  for (const id of friendlyIds(g, self, (u) => u.id !== self.id && g.hasTrait(u, 'Atreides'))) g.giveToken(id, 'Experience')
}

// Spotter 'Thopter: Spice with an Arrakis base and a Harvester Vehicle
function spotterSpice(g: Game, self: Self) {
  const harvester = friendlyIds(g, self, (u) => g.hasTrait(u, 'Harvester') && g.hasTrait(u, 'Vehicle')).length > 0
  if (g.controlsArrakis(self.controller) && harvester) g.createSpice(self.controller)
}

// Chani: a Fremen unit played or a Fremen token created
const fremenArrives = (self: Self) => self.otherDef?.type === 'unit' && self.otherDef.traits.includes('Fremen')

function chaniLeader(g: Game, self: Self) {
  const p = self.controller
  if (!fremenArrives(self) || !g.leaderReady(p)) return
  if (!g.may(p, 'Chani: exhaust this leader to deal 1 damage to an enemy base?', { yes: 'Exhaust', no: 'Skip', source: self.def.id })) return
  g.exhaustLeader(p)
  g.damage(`base${enemy(g, self)}`, 1, self)
}

function chaniUnit(g: Game, self: Self) {
  if (!fremenArrives(self)) return
  const foe = enemy(g, self)
  const ids = [...unitIds(g, (u) => g.controller(u) === foe), `base${foe}`]
  const pick = g.chooseOne(self.controller, 'Chani: deal 1 damage to an enemy unit or base', ids, { ai: 'harm', source: self.def.id })
  if (pick) g.damage(pick, 1, self)
}

// Shaddam IV: the Sardaukar cards in hand he can play
const sardaukarInHand = (g: Game, self: Self) =>
  g
    .player(self.controller)
    .hand.filter((c) => g.hasTrait(c, 'Sardaukar') && g.canPlay(self.controller, c.id, { ignoreAdditional: true }))
    .map((c) => c.id)

// Baron Vladimir Harkonnen: the cards in his resources he can play as if using Plot, for 1 less
const plotPlays = (g: Game, self: Self) =>
  g
    .player(self.controller)
    .resources.map((r) => r.card.id)
    .filter((id) => g.canPlay(self.controller, id, { discount: 1 }))

// Gurney Halleck: "Play a card using Smuggle. It costs [2] less." or an Experience token
function gurneyChoice(g: Game, self: Self) {
  const p = self.controller
  const smuggled = g
    .player(p)
    .resources.map((r) => r.card.id)
    .filter((id) => g.canPlay(p, id, { smuggle: true, discount: 2 }))
  const choice = g.option(p, 'Gurney Halleck: choose one', ['Play a card using Smuggle, for 2 less', 'Give an Experience token to a friendly Underworld unit'], {
    ai: smuggled.length ? 0 : 1,
    source: self.def.id,
  })
  if (choice === 1) {
    experienceTo(g, self, friendlyIds(g, self, (u) => g.hasTrait(u, 'Underworld')), 'Gurney Halleck: give an Experience token to a friendly Underworld unit')
    return
  }
  const pick = g.chooseOne(p, 'Gurney Halleck: play a card using Smuggle, for 2 less', smuggled, { ai: 'best', source: self.def.id })
  if (pick) g.playCard(p, pick, { smuggle: true, discount: 2 })
}

// "If you control an [{Arrakis}] base, create a Spice token."
function arrakisSpice(g: Game, self: Self) {
  if (g.controlsArrakis(self.controller)) g.createSpice(self.controller)
}

// Harkonnen Harvester: Spice, and more Spice for hurting your own. The AI hurts the unit with
// the most HP to spare, if it survives 2 damage.
function harkonnenHarvest(g: Game, self: Self) {
  const p = self.controller
  if (!g.controlsArrakis(p)) return
  g.createSpice(p)
  const friendly = g.units((u) => g.controller(u) === p)
  const left = (u: (typeof friendly)[number]) => g.hp(u) - u.damage
  const tough = friendly.filter((u) => left(u) > 2).sort((a, b) => left(b) - left(a))[0]
  const pick = g.chooseOne(p, 'Harkonnen Harvester: you may deal 2 damage to a friendly unit to create another Spice token', friendly.map((u) => u.id), {
    optional: true,
    ai: tough?.id ?? 'none',
    source: self.def.id,
  })
  if (pick && g.damage(pick, 2, self)) g.createSpice(p)
}

// Liet Kynes: a Spice token for 3 damage healed; the AI only once its base has the damage
function kynesHeal(g: Game, self: Self) {
  const p = self.controller
  if (!g.spice(p)) return
  const hurt = g.player(p).base.damage >= 3
  if (!g.may(p, 'Liet Kynes: defeat a friendly Spice token to heal 3 damage from your base?', { yes: 'Defeat a Spice token', no: 'Skip', ai: hurt, source: self.def.id })) return
  if (g.defeatSpice(p)) g.heal(`base${p}`, 3, self)
}

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

// Looked up again and again as the engine works out what units have: each card's text is
// compared with its script's once
const found = new Map<string, CardScript | undefined>()

export function scriptFor(card: CardDef): CardScript | undefined {
  const lookup = `${keyOf(card.name, card.subtitle)}|${card.type}|${card.text}|${card.backText}`
  if (found.has(lookup)) return found.get(lookup)
  let script = byKey.get(keyOf(card.name, card.subtitle))
  if (script && normal(script.text) !== normal(card.text)) script = undefined
  if (script && card.type === 'leader' && normal(script.backText) !== normal(card.backText)) script = undefined
  found.set(lookup, script)
  return script
}

// Whether a card's text does something: 'scripted'; 'outdated' when its script was written
// for text since changed; 'none' for text no script plays yet; 'blank' for a card with no text.
// Text the engine plays by
// itself (keywords, Smuggle, Spice costs, see enginePlays) needs no script.
export function scriptStatus(card: CardDef): 'scripted' | 'outdated' | 'none' | 'blank' {
  if (scriptFor(card)) return 'scripted'
  if (byKey.has(keyOf(card.name, card.subtitle))) return 'outdated'
  const lines = [normal(card.text), normal(card.backText)].join('\n').split('\n').filter(Boolean)
  if (!lines.length) return 'blank'
  return lines.every(enginePlays) ? 'scripted' : 'none'
}

const nothing: Abilities = {}

export function abilitiesOf(card: CardDef, side: 'front' | 'back'): Abilities {
  const script = scriptFor(card)
  if (!script) return nothing
  return (side === 'back' ? script.back : script.front) ?? nothing
}

// For the scripts' own test: every script, by name
export const scripts = dune
