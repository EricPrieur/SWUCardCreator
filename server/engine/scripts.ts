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
// [Sentinel]."; traits: "Attached unit gains the [{Atreides}] trait."
export type Grant = { keywords?: Keywords; power?: number; hp?: number; traits?: string[] }

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
  // When a triggered ability triggers at all ("Whenever a friendly Harkonnen unit is
  // defeated", once each round): otherwise it isn't, and isn't among those to order
  triggersIf?: { [K in keyof Abilities]?: (g: Game, self: Self) => boolean }
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
  // When an enemy unit attacks; self.other is the attacker
  whenEnemyAttacks?: Ability
  // When a friendly unit deals combat damage to an enemy base; self.other is that unit
  whenCombatDamageBase?: Ability
  // "When this unit completes an attack:"
  afterAttack?: Ability
  // An upgrade's: when the unit it is on becomes exhausted; when that unit is defeated
  whenAttachedExhausted?: Ability
  attachedWhenDefeated?: Ability
  // What it gives a unit (every unit in play is asked, so a script says whom it gives to)
  gives?: (g: Game, self: Self, unit: UnitState) => Grant | undefined
  // Whether the additional costs of a card being played may be ignored
  ignoresAdditionalCost?: (g: Game, self: Self, card: CardDef) => boolean
  // A unit that can't attack some units
  cantAttack?: (g: Game, self: Self, target: UnitState) => boolean
  // An upgrade's: "Attached unit can't be defeated by enemy card abilities."
  cantBeDefeatedByEnemies?: boolean
  // Whether a friendly unit can't be defeated by an enemy card's ability (`from`)
  cantBeDefeatedBy?: (g: Game, self: Self, from: Self) => boolean
  // How much less a card its controller plays costs
  costsLess?: (g: Game, self: Self, card: CardDef) => number
  // "If you would create a Spice token, you may create 2 Spice tokens instead.": whether it does
  moreSpice?: (g: Game, self: Self) => boolean
  // "Opponents play with their hands revealed."; "You may look at the top card of your deck at
  // any time."
  revealsHands?: boolean
  seesTopCard?: boolean
  // Playing it: from the discard pile, when it may be (an upgrade onto that unit); for a Spice
  // token instead of its cost, from the hand or discard pile; for 1 less for each Spice token
  // defeated, up to so many; put into play as a resource once its text resolves (an event)
  discardPlay?: (g: Game, self: Self, unit?: UnitState) => boolean
  spicePlay?: boolean
  spiceReduces?: number
  toResources?: boolean
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
// Glossu Rabban: the AI's strongest unit that can attack and survives 1 damage
const rabbanPick = (g: Game, self: Self) =>
  friendlyIds(g, self, (u) => g.canAttack(u.id) && g.hp(u) - u.damage > 1).sort((a, b) => g.power(g.unit(b)!) - g.power(g.unit(a)!))[0]

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
          // Only a unit that can then attack: one that can't would take the damage for nothing
          can: (g, self) => friendlyIds(g, self, (u) => g.canAttack(u.id)).length > 0,
          run: (g, self) => {
            const ready = friendlyIds(g, self, (u) => g.canAttack(u.id))
            const id = g.chooseOne(self.controller, 'Glossu Rabban: choose a friendly unit to deal 1 damage to, then attack with', ready, {
              ai: rabbanPick(g, self) ?? ready[0],
              source: self.def.id,
            })
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
        const upgrades = g.upgrades().filter((u) => u.unit?.exhausted)
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
        const enemies = upgrades.some((u) => u.controller !== self.controller)
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
        const name = g.name(target)
        g.damage(target, 2, self)
        // A unit may be defeated even once the target is gone (for its When Defeated ability, say):
        // only the damage needs the target still in play
        const friends = unitIds(g, (u) => g.controller(u) === self.controller && !u.leader)
        const there = !!g.unit(target)
        const sacrifice = g.chooseOne(
          self.controller,
          there ? `Kanly: you may defeat a friendly non-leader unit to deal its power to ${name}` : `Kanly: ${name} is defeated; you may still defeat a friendly non-leader unit`,
          friends,
          {
            optional: true,
            // The AI keeps its units (unless trying its answers shows one is worth giving up)
            ai: 'none',
            source: self.def.id,
          },
        )
        if (!sacrifice) return
        const power = g.power(g.unit(sacrifice)!)
        g.defeat(sacrifice)
        if (g.unit(target)) g.damage(target, power, self)
      },
    },
  },
  {
    name: 'Sabotage',
    text: 'Choose one:\n• Defeat an upgrade.\n• Deal 2 damage to a base.',
    front: {
      play: (g, self) => {
        const upgrades = g.upgrades()
        const enemyUpgrade = upgrades.some((u) => u.controller !== self.controller)
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
        const enemy = upgrades.find((u) => u.controller !== self.controller)
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
      triggersIf: { whenSpiceDefeated: (_g, self) => youDefeatSpice(self) },
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
      triggersIf: { whenSpiceDefeated: (_g, self) => youDefeatSpice(self) },
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
      triggersIf: { whenSpiceDefeated: (_g, self) => youDefeatSpice(self) },
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
      triggersIf: { whenSpiceDefeated: (g, self) => youDefeatSpice(self) && !g.used(self) && !!g.unit(self.id)?.exhausted },
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
      triggersIf: { whenSpiceDefeated: (g, self) => self.spice?.by !== self.controller && !g.used(self) },
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
      triggersIf: { whenFriendlyDefeated: (g, self) => !!self.otherDef?.traits.includes('Harkonnen') && !g.used(self) },
      whenFriendlyDefeated: (g, self) => {
        // Two Harkonnen units defeated at once trigger it twice: the second does nothing
        if (g.used(self)) return
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
        const upgrades = g.upgrades().filter((u) => u.unit && u.controller === foe)
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
          if (upgrade.controller === self.controller && g.def(upgrade).token && g.def(upgrade).name === 'Shield') g.defeatUpgrade(upgrade.id)
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
        const theirs = upgrades.filter((u) => u.controller !== self.controller)
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
        if (wasShield && chosen.unit) g.damage(chosen.unit.id, 3, self)
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
      triggersIf: { whenYouPlay: (g, self) => !!self.otherDef?.traits.includes('Bene Gesserit') && g.leaderReady(self.controller) },
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
      triggersIf: { whenYouPlay: (g, self) => self.otherDef?.type === 'unit' && g.leaderReady(self.controller) },
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
      triggersIf: { whenYouPlay: (g, self) => self.otherDef?.type === 'unit' && self.otherDef.traits.includes('Emperor') && g.leaderReady(self.controller) },
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
  // --- Constant abilities ---
  {
    name: 'Alia Atreides',
    subtitle: 'Pre-born',
    text: 'This unit gains each keyword printed on [{Fremen}] and [{Bene Gesserit}] units in your discard pile.',
    front: {
      gives: (g, self, unit) => {
        if (unit.id !== self.id) return undefined
        const keywords: Keywords = {}
        for (const card of g.player(self.controller).discard) {
          const d = g.def(card)
          if (d.type !== 'unit' || !(d.traits.includes('Fremen') || d.traits.includes('Bene Gesserit'))) continue
          for (const name of combatKeywords) if (d.keywords[name]) addKeyword(keywords, name, d.keywords[name])
        }
        return { keywords }
      },
    },
  },
  {
    name: 'Atreides Troops',
    text: 'While you control another [{Atreides}] unit, this unit gains [Restore 1].',
    front: {
      gives: (g, self, unit) => (unit.id === self.id && anotherAtreides(g, self) ? { keywords: { restore: 1 } } : undefined),
    },
  },
  {
    name: 'Chani',
    subtitle: 'Desert Guide',
    text: 'While you control an [{Arrakis}] base, this unit gains [Hidden].\nOther friendly [{Fremen}] units get [+1/+0].',
    front: {
      gives: (g, self, unit) =>
        unit.id !== self.id && g.controller(unit) === self.controller && g.hasTrait(unit, 'Fremen') ? { power: 1 } : undefined,
    },
  },
  {
    name: "Harkonnen Heavy 'Thopter",
    text: 'Friendly [{Trooper}] units gain [Raid 1].',
    front: {
      gives: (g, self, unit) => (g.controller(unit) === self.controller && g.hasTrait(unit, 'Trooper') ? { keywords: { raid: 1 } } : undefined),
    },
  },
  {
    name: "The Emperor's Frigate",
    subtitle: 'Seat of the Padishah',
    text: '[Sentinel]\nEnemy ground units get [-1/-0] while attacking a base.\n[When Played:] Search the top 5 cards of your deck for an [{Emperor}] card, reveal it and draw it.',
    front: {
      gives: (g, self, unit) =>
        g.controller(unit) !== self.controller && unit.arena === 'ground' && g.attack?.attacker === unit.id && g.attack.target === 'base'
          ? { power: -1 }
          : undefined,
      whenPlayed: (g, self) => searchDeck(g, self, 5, (d) => d.traits.includes('Emperor'), 'an Emperor card'),
    },
  },
  {
    name: 'Count Hasimir Fenring',
    subtitle: "The Emperor's Blade",
    text: "[Ambush]\nWhile attacking, this unit deals combat damage before the defender.\nThis unit can't attack units named Paul Atreides.",
    front: {
      gives: (_g, self, unit) => (unit.id === self.id ? { keywords: { firstStrike: true } } : undefined),
      cantAttack: (g, _self, target) => g.def(target).name === 'Paul Atreides',
    },
  },
  {
    name: 'Ginaz Swordmaster',
    text: '[Ambush]\n[On Attack:] If you control another [{Ginaz}] unit, this unit deals its combat damage before the defender.',
    front: {
      onAttack: (g, self) => {
        if (friendlyIds(g, self, (u) => u.id !== self.id && g.hasTrait(u, 'Ginaz')).length) g.grant(self.id, { firstStrike: true }, 'attack')
      },
    },
  },

  // --- Upgrades ---
  {
    name: 'Litany Against Fear',
    text: "Attached unit can't be defeated by enemy card abilities.",
    front: { cantBeDefeatedByEnemies: true },
  },
  {
    name: 'Stillsuit',
    text: "Attach to a non-[{Vehicle}] unit.\nAttached unit gains [Restore 1], or [Restore 2] instead if it's a [{Fremen}] unit.",
    front: {
      gives: (g, self, unit) => (unit.id === self.attachedTo ? { keywords: { restore: g.hasTrait(unit, 'Fremen') ? 2 : 1 } } : undefined),
    },
  },
  {
    name: 'Sworn Sword',
    text: 'Attach to a non-[{Vehicle}] unit.\nAttached unit gains [Sentinel] and the [{Atreides}] trait.\n[When Played:] If attached unit has the [{Atreides}] trait printed on it, give an Experience token to it.',
    front: {
      gives: (_g, self, unit) => (unit.id === self.attachedTo ? { keywords: { sentinel: true }, traits: ['Atreides'] } : undefined),
      whenPlayed: (g, self) => {
        const unit = self.other ? g.unit(self.other) : undefined
        if (unit && g.def(unit).traits.includes('Atreides')) g.giveToken(unit.id, 'Experience')
      },
    },
  },
  {
    name: 'Fedaykin Oath',
    text: 'Attach to a non-[{Vehicle}] unit.\nAttached unit gains [Sentinel] and: "[When Defeated:] Create a Fremen token."',
    front: {
      gives: (_g, self, unit) => (unit.id === self.attachedTo ? { keywords: { sentinel: true } } : undefined),
      attachedWhenDefeated: (g, self) => {
        g.createToken(self.controller, 'Fremen')
      },
    },
  },
  {
    name: 'Crysknife',
    text: 'Attach to a non-[{Vehicle}] unit.\n[When Played:] Deal 1 damage to a ground unit.\nYou may play this upgrade from your discard pile if you attach it to a [{Fremen}] unit.',
    front: {
      whenPlayed: (g, self) => {
        const pick = g.chooseOne(self.controller, 'Crysknife: deal 1 damage to a ground unit', unitIds(g, (u) => u.arena === 'ground'), {
          ai: 'harm',
          source: self.def.id,
        })
        if (pick) g.damage(pick, 1, self)
      },
      discardPlay: (g, _self, unit) => !!unit && g.hasTrait(unit, 'Fremen'),
    },
  },
  {
    name: 'Gom Jabbar',
    text: 'Attach to a non-[{Vehicle}], non-leader unit.\nAttached unit gains: "When this unit becomes exhausted, defeat it unless its controller discards a card from their hand."',
    front: {
      whenAttachedExhausted: (g, self) => {
        const unit = self.attachedTo ? g.unit(self.attachedTo) : undefined
        if (!unit) return
        const p = g.controller(unit)
        const keep =
          g.player(p).hand.length > 0 &&
          g.may(p, `Gom Jabbar: discard a card from your hand to keep ${g.name(unit.id)}?`, { yes: 'Discard a card', no: 'Let it be defeated', source: self.def.id })
        if (keep) g.discardChosen(p, 1, 'Gom Jabbar: choose a card to discard', self.def.id)
        else g.defeat(unit.id)
      },
    },
  },
  {
    name: 'Gene Manipulation',
    text: '[When Played:] Choose a card in your discard pile that shares a Trait with attached unit. Attached unit gains a [keyword] printed on that card.',
    front: {
      whenPlayed: (g, self) => {
        const unit = self.other ? g.unit(self.other) : undefined
        if (!unit) return
        const traits = g.traits(unit)
        const printed = (card: { def: string }) => combatKeywords.filter((name) => g.def(card).keywords[name])
        const cards = g
          .player(self.controller)
          .discard.filter((c) => g.def(c).traits.some((t) => traits.includes(t)) && printed(c).length)
          .map((c) => c.id)
        const pick = g.chooseOne(self.controller, `Gene Manipulation: choose a card in your discard pile that shares a trait with ${g.name(unit.id)}`, cards, {
          ai: 'best',
          source: self.def.id,
        })
        if (!pick) return
        const card = g.card(pick)!
        const names = printed(card)
        const which = names.length > 1 ? g.option(self.controller, `Gene Manipulation: ${g.name(unit.id)} gains…`, names.map(keywordLabel(card, g)), { source: self.def.id }) : 0
        const name = names[which]
        const keywords: Keywords = {}
        addKeyword(keywords, name, g.def(card).keywords[name])
        g.grant(unit.id, keywords, 'source', self.id)
        g.log(`${g.name(unit.id)} gains ${keywordLabel(card, g)(name)}`, self.controller)
      },
    },
  },
  {
    name: 'Black Market Fence',
    text: '[When Played:] You may take control of a non-unique [{Item}] upgrade or a token upgrade and attach it to a friendly unit.',
    front: {
      whenPlayed: (g, self) => {
        const p = self.controller
        const upgrades = g.upgrades().filter((u) => u.unit && (g.def(u).token || (!g.def(u).unique && g.hasTrait(u, 'Item'))))
        // The AI takes what helps it from an enemy unit
        const good = upgrades.find((u) => u.controller !== p && g.def(u).name !== 'Weakness')
        const pick = g.chooseOne(p, 'Black Market Fence: you may take an Item or token upgrade', upgrades.map((u) => u.id), {
          optional: true,
          ai: good?.id ?? 'none',
          source: self.def.id,
        })
        if (!pick) return
        const to = g.chooseOne(p, `Black Market Fence: attach ${g.def(upgrades.find((u) => u.id === pick)!).name} to a friendly unit`, friendlyIds(g, self), {
          ai: 'help',
          source: self.def.id,
        })
        if (to) g.moveUpgrade(pick, to)
      },
    },
  },

  // --- Searching the deck, playing from the discard pile ---
  {
    name: 'Bene Gesserit Shuttle',
    text: '[When Played:] Search the top 5 cards of your deck for a [{Bene Gesserit}] unit, reveal it and draw it.',
    front: {
      whenPlayed: (g, self) => searchDeck(g, self, 5, (d) => d.type === 'unit' && d.traits.includes('Bene Gesserit'), 'a Bene Gesserit unit'),
    },
  },
  {
    name: 'Harkonnen Sergeant',
    text: '[When Played:] Search the top 5 cards of your deck for a [{Trooper}] unit, reveal it and draw it. You may play it now. It costs [1] less.',
    front: {
      whenPlayed: (g, self) => {
        const p = self.controller
        const found = searchDeck(g, self, 5, (d) => d.type === 'unit' && d.traits.includes('Trooper'), 'a Trooper unit')
        if (found) g.mayPlay(p, found, `Harkonnen Sergeant: play ${g.name(found)} now, for 1 less?`, { discount: 1, source: self.def.id })
      },
    },
  },
  {
    name: 'Sardaukar Legion',
    text: 'As an additional cost to play this unit, defeat a friendly Spice token.\n[When Played:] Search the top 10 cards of your deck for any number of [{Sardaukar}] units and reveal them. You may defeat up to 3 friendly Spice tokens. Play any number of the revealed units with a combined cost of [#2] or less for each Spice token defeated this way, for free, ignoring their additional costs.',
    front: {
      whenPlayed: (g, self) => {
        const p = self.controller
        const top = g.top(p, 10)
        const revealed = top.filter((c) => g.def(c).type === 'unit' && g.hasTrait(c, 'Sardaukar'))
        if (revealed.length) g.reveal(p, revealed.map((c) => c.id), self)
        else g.log('Sardaukar Legion finds no Sardaukar unit', p)
        if (revealed.length && g.spice(p)) {
          const counts = Array.from({ length: Math.min(3, g.spice(p)) + 1 }, (_, n) => `${n} (up to ${2 * n} cost)`)
          const spent = g.option(p, 'Sardaukar Legion: defeat how many Spice tokens?', counts, { ai: counts.length - 1, source: self.def.id })
          for (let i = 0; i < spent; i++) g.defeatSpice(p)
          let budget = 2 * spent
          for (;;) {
            const ids = revealed
              .filter((c) => g.def(c).cost <= budget && g.canPlay(p, c.id, { free: true, ignoreAdditional: true }))
              .map((c) => c.id)
            const pick = g.chooseOne(p, `Sardaukar Legion: you may play a revealed unit (up to ${budget} cost left)`, ids, {
              optional: true,
              ai: 'best',
              source: self.def.id,
              // The cards searched still in the deck
              seen: top.map((c) => c.id).filter((id) => g.player(p).deck.some((c) => c.id === id)),
            })
            if (!pick) break
            budget -= g.def(g.card(pick)!).cost
            g.playCard(p, pick, { free: true, ignoreAdditional: true })
          }
        }
        // The cards searched and left go to the bottom of the deck
        g.shuffleToBottom(p, top.map((c) => c.id))
      },
    },
  },
  {
    name: 'Carryall',
    text: '[When Played/On Attack:] You may play a ground [{Vehicle}] unit from your discard pile that was defeated this phase and costs [#5] or less for free.',
    front: {
      whenPlayed: (g, self) => carryall(g, self),
      onAttack: (g, self) => carryall(g, self),
    },
  },
  {
    name: 'Harkonnen Drop Ship',
    text: '[When Played/On Attack:] You may play up to 2 [{Harkonnen}] [{Trooper}] units that cost [#2] or less from your discard pile for free.',
    front: {
      whenPlayed: (g, self) => dropShip(g, self),
      onAttack: (g, self) => dropShip(g, self),
    },
  },
  {
    name: "Paul's 'Thopter",
    subtitle: 'Into the Storm',
    text: '[When Defeated:] You may play an [{Atreides}] ground unit that costs [#2] or less from your discard pile for free.',
    front: {
      whenDefeated: (g, self) =>
        playFromDiscard(g, self, "Paul's 'Thopter: you may play an Atreides ground unit that costs 2 or less from your discard pile", (d) =>
          d.type === 'unit' && d.arena === 'ground' && d.traits.includes('Atreides') && d.cost <= 2,
        ),
    },
  },
  {
    name: 'Spice-Sworn Blade',
    text: 'You may play this unit from your hand or discard pile for free by defeating a friendly Spice token.',
    front: { spicePlay: true },
  },
  {
    name: 'CHOAM Dividend',
    text: 'While playing this event, you may defeat a friendly Spice token. If you do, it costs [1] less.\nPut this event into play as a resource.',
    front: { spiceReduces: 1, toResources: true, play: () => {} },
  },
  {
    name: 'Guild Heighliner',
    text: 'As you play this unit, you may defeat any number of friendly Spice tokens. It costs [1] less for each Spice token defeated this way.\n[When Played:] Play any number of ground units from your hand with a combined cost of [#8] or less for free. They gain [Ambush] for this phase.',
    front: {
      spiceReduces: 99,
      whenPlayed: (g, self) => {
        const p = self.controller
        let budget = 8
        for (;;) {
          const ids = g
            .player(p)
            .hand.filter((c) => g.def(c).type === 'unit' && g.def(c).arena === 'ground' && g.def(c).cost <= budget && g.canPlay(p, c.id, { free: true }))
            .map((c) => c.id)
          const pick = g.chooseOne(p, `Guild Heighliner: you may play a ground unit from your hand for free (up to ${budget} cost left)`, ids, {
            optional: true,
            ai: 'best',
            source: self.def.id,
          })
          if (!pick) return
          budget -= g.def(g.card(pick)!).cost
          // Ambush before it enters play, so it may attack as it does
          g.grant(pick, { ambush: true }, 'phase')
          g.playCard(p, pick, { free: true })
        }
      },
    },
  },
  {
    name: 'Princess Irulan',
    subtitle: 'Imperial Chronicler',
    text: '[Restore 1]\n[When Played:] You may put 3 [{Bene Gesserit}] cards from your discard pile on the bottom of your deck in any order. If you do, put the top card of your deck into play as a resource.',
    front: {
      whenPlayed: (g, self) => {
        const p = self.controller
        const cards = g.player(p).discard.filter((c) => g.hasTrait(c, 'Bene Gesserit')).map((c) => c.id)
        if (cards.length < 3) return
        if (!g.may(p, 'Princess Irulan: put 3 Bene Gesserit cards from your discard pile on the bottom of your deck to gain a resource?', { yes: 'Do it', no: 'Skip', source: self.def.id }))
          return
        const picks = g.choose(p, 'Princess Irulan: choose 3 Bene Gesserit cards, in the order they go to the bottom', cards, { min: 3, max: 3, ai: 'cheap', source: self.def.id })
        for (const id of picks) g.discardToBottom(p, id)
        g.resourceFromDeck(p)
      },
    },
  },
  {
    name: 'Sietch Reverend Mother',
    text: '[When Played:] Choose a [{Fremen}] or [{Bene Gesserit}] unit in your discard pile other than a Sietch Reverend Mother. Use its [When Played] ability as if it were this unit\'s.\n[When Defeated:] Return another [{Fremen}] or [{Bene Gesserit}] unit from your discard pile to your hand.',
    front: {
      whenPlayed: (g, self) => {
        const ids = g
          .player(self.controller)
          .discard.filter((c) => isFremenOrSister(g, c) && g.def(c).name !== 'Sietch Reverend Mother' && abilitiesOf(g.def(c), 'front').whenPlayed)
          .map((c) => c.id)
        const pick = g.chooseOne(self.controller, "Sietch Reverend Mother: choose a unit in your discard pile to use its When Played ability", ids, {
          ai: 'best',
          source: self.def.id,
        })
        if (!pick) return
        const card = g.def(g.card(pick)!)
        g.log(`Sietch Reverend Mother uses ${card.name}'s When Played ability`, self.controller)
        abilitiesOf(card, 'front').whenPlayed?.(g, self)
      },
      whenDefeated: (g, self) => {
        const ids = g
          .player(self.controller)
          .discard.filter((c) => c.id !== self.id && isFremenOrSister(g, c))
          .map((c) => c.id)
        const pick = g.chooseOne(self.controller, 'Sietch Reverend Mother: return a Fremen or Bene Gesserit unit from your discard pile to your hand', ids, {
          ai: 'best',
          source: self.def.id,
        })
        if (pick) g.fromDiscard(self.controller, pick)
      },
    },
  },
  {
    name: 'Scout',
    text: "[When Played:] You may return another friendly non-leader unit that costs [#2] or less and isn't named Scout to its owner's hand. If you do, you may play it. It costs [1] less.",
    front: {
      whenPlayed: (g, self) => {
        const p = self.controller
        const ids = friendlyIds(g, self, (u) => u.id !== self.id && !u.leader && g.cost(u) <= 2 && g.def(u).name !== 'Scout')
        const pick = g.chooseOne(p, "Scout: you may return another friendly unit that costs 2 or less to its owner's hand", ids, {
          optional: true,
          ai: 'none',
          source: self.def.id,
        })
        if (!pick) return
        g.returnToHand(pick)
        g.mayPlay(p, pick, `Scout: play ${g.name(pick)} again, for 1 less?`, { discount: 1, source: self.def.id })
      },
    },
  },

  // --- Combat ---
  {
    name: 'Amtal Rule',
    text: "Attack with a ground unit, even if it's exhausted. It can't attack bases for this attack. If it's a [{Ginaz}] unit, it deals its combat damage before the defender.",
    front: {
      play: (g, self) => {
        const pick = g.chooseOne(self.controller, 'Amtal Rule: attack with a ground unit, even if it is exhausted', friendlyIds(g, self, (u) => u.arena === 'ground' && g.canAttack(u.id, { exhausted: true, noBases: true })), {
          ai: 'help',
          source: self.def.id,
        })
        if (!pick) return
        g.attackWith(pick, { exhausted: true, noBases: true, firstStrike: g.hasTrait(g.unit(pick)!, 'Ginaz') })
      },
    },
  },
  {
    name: 'Duncan Idaho',
    subtitle: 'Swordmaster of the Ginaz',
    text: '[Sentinel]\n[When Defeated:] If this unit was defending and you control Paul Atreides or Lady Jessica, you may defeat the attacking unit.',
    front: {
      whenDefeated: (g, self) => {
        const attacker = self.attack?.target === self.id ? g.unit(self.attack.attacker) : undefined
        if (!attacker || !controlsNamed(g, self.controller, ['Paul Atreides', 'Lady Jessica'])) return
        if (g.may(self.controller, `Duncan Idaho: defeat ${g.name(attacker.id)}?`, { yes: 'Defeat it', no: 'Skip', source: self.def.id })) g.defeat(attacker.id)
      },
    },
  },
  {
    name: 'Hunter Seeker',
    text: 'When an enemy ground unit attacks: Defeat this unit. If you do, deal 3 damage to the attacking unit.',
    front: {
      whenEnemyAttacks: (g, self) => {
        const attacker = self.other ? g.unit(self.other) : undefined
        if (!attacker || attacker.arena !== 'ground' || !g.unit(self.id)) return
        g.defeat(self.id)
        if (!g.unit(self.id)) g.damage(attacker.id, 3, self)
      },
    },
  },
  {
    name: 'Prana-Bindu Adept',
    text: "[Sentinel]\nWhen this unit is attacked: Discard the top card of your deck. If it's a [{Bene Gesserit}] card, the attacking unit gets [-2/-0] for this attack.",
    front: {
      whenDefending: (g, self) => {
        const [top] = g.top(self.controller, 1)
        if (!top) return
        g.mill(self.controller, top.id)
        if (g.hasTrait(top, 'Bene Gesserit') && self.other && g.unit(self.other)) g.buff(self.other, -2, 0, 'attack')
      },
    },
  },
  {
    name: 'Bene Gesserit Operative',
    text: "[Saboteur]\n[Hidden]\n[On Attack:] If this unit is attacking a base, that base's controller discards a card from their hand.",
    front: {
      onAttack: (g, self) => {
        if (self.attack?.target === 'base') g.discardChosen(enemy(g, self), 1, 'Bene Gesserit Operative makes you discard a card', self.def.id)
      },
    },
  },
  {
    name: 'Shai-Hulud',
    text: "[Overwhelm]\n[When Played:] If you control an [{Arrakis}] base, return each non-leader [{Fremen}] unit to its owner's hand. Then defeat each other ground unit that isn't a [{Fremen}] unit.\n[When this unit completes an attack:] Return it to the bottom of its owner's deck.",
    front: {
      whenPlayed: (g, self) => {
        if (!g.controlsArrakis(self.controller)) return
        for (const id of unitIds(g, (u) => !u.leader && g.hasTrait(u, 'Fremen'))) g.returnToHand(id)
        for (const id of unitIds(g, (u) => u.id !== self.id && u.arena === 'ground' && !g.hasTrait(u, 'Fremen'))) g.defeat(id, self)
      },
      afterAttack: (g, self) => g.toDeckBottom(self.id),
    },
  },
  {
    name: 'Fremen Worm Riders',
    text: "[Overwhelm]\nWhile you control an [{Arrakis}] base, this unit gains [Ambush].\n[When Defeated:] Put this card on the bottom of its owner's deck.",
    front: {
      whenDefeated: (g, self) => {
        for (const p of [0, 1] as PlayerId[]) if (g.player(p).discard.some((c) => c.id === self.id)) g.discardToBottom(p, self.id)
        g.log("Fremen Worm Riders go to the bottom of their owner's deck", self.controller)
      },
    },
  },
  {
    name: 'Rabban\'s Gunship',
    subtitle: 'Fist of the Beast',
    text: '[When you play a [{Harkonnen}] unit (including this one):] You may deal 1 damage to a friendly unit. If you do, deal 2 damage to a ground unit or base.',
    front: {
      whenPlayed: (g, self) => gunship(g, self),
      whenYouPlay: (g, self) => {
        if (self.otherDef?.type === 'unit' && self.otherDef.traits.includes('Harkonnen')) gunship(g, self)
      },
    },
  },
  {
    name: 'The Baron\'s Wrath',
    text: 'You may defeat any number of friendly Spice tokens and friendly [{Harkonnen}] units. Deal X damage divided as you choose among any number of units. X is the number of friendly [{Harkonnen}] units, plus 2 for each Spice token and unit defeated this way.',
    front: {
      play: (g, self) => {
        const p = self.controller
        const counts = Array.from({ length: g.spice(p) + 1 }, (_, n) => `${n} Spice token${n === 1 ? '' : 's'}`)
        const spice = counts.length > 1 ? g.option(p, "The Baron's Wrath: defeat how many Spice tokens?", counts, { ai: counts.length - 1, source: self.def.id }) : 0
        for (let i = 0; i < spice; i++) g.defeatSpice(p)
        const harkonnen = friendlyIds(g, self, (u) => g.hasTrait(u, 'Harkonnen'))
        const fallen = g.choose(p, "The Baron's Wrath: defeat any number of friendly Harkonnen units", harkonnen, { min: 0, max: harkonnen.length, ai: 'none', source: self.def.id })
        for (const id of fallen) g.defeat(id)
        let left = friendlyIds(g, self, (u) => g.hasTrait(u, 'Harkonnen')).length + 2 * (spice + fallen.length)
        g.log(`The Baron's Wrath: ${left} damage to deal`, p)
        while (left > 0) {
          const target = g.chooseOne(p, `The Baron's Wrath: choose a unit to deal damage to (${left} left)`, unitIds(g, () => true), {
            ai: 'harm',
            source: self.def.id,
          })
          if (!target) return
          const amounts = Array.from({ length: left }, (_, i) => String(i + 1))
          const unit = g.unit(target)!
          const lethal = Math.min(left, Math.max(1, g.hp(unit) - unit.damage))
          const amount = amounts.length > 1 ? Number(amounts[g.option(p, `The Baron's Wrath: how much damage to ${g.name(target)}?`, amounts, { ai: lethal - 1, source: self.def.id })]) : 1
          g.damage(target, amount, self)
          left -= amount
        }
      },
    },
  },

  // --- Hands and decks ---
  {
    name: 'Imperial Spy',
    text: "[Hidden]\n[When Played/On Attack:] Look at the top card of an opponent's deck. You may put it on the bottom of their deck or discard it.",
    front: {
      whenPlayed: (g, self) => imperialSpy(g, self),
      onAttack: (g, self) => imperialSpy(g, self),
    },
  },
  {
    name: 'Lady Jessica',
    subtitle: 'Mother of the Kwisatz Haderach',
    text: "[Restore 3]\n[When Played/On Attack:] Look at an opponent's hand and choose a card in it. This phase, they can't play cards with that name. Draw a card.",
    front: {
      whenPlayed: (g, self) => nameACard(g, self),
      onAttack: (g, self) => nameACard(g, self),
    },
  },
  {
    name: 'The Voice',
    text: "Look at an opponent's hand and choose a card in it. This phase, they can't play cards with that name. Draw a card.",
    front: { play: (g, self) => nameACard(g, self) },
  },
  {
    name: 'Reverend Mother Mohiam',
    subtitle: "The Emperor's Truthsayer",
    text: "Opponents play with their hands revealed.\n[When Played:] Discard any number of [{Bene Gesserit}] cards from your hand. For each card discarded this way, choose a card in each opponent's hand. They discard it.",
    front: {
      revealsHands: true,
      whenPlayed: (g, self) => {
        const p = self.controller
        const foe = enemy(g, self)
        const hand = g.player(p).hand.filter((c) => g.def(c).traits.includes('Bene Gesserit')).map((c) => c.id)
        const mine = g.choose(p, 'Reverend Mother Mohiam: discard any number of Bene Gesserit cards from your hand; they discard one for each', hand, {
          min: 0,
          max: hand.length,
          ai: 'none',
          source: self.def.id,
        })
        for (const id of mine) g.discard(p, id)
        for (let i = 0; i < mine.length; i++) {
          const pick = g.chooseOne(p, `Reverend Mother Mohiam: choose a card in ${g.player(foe).name}'s hand to discard`, g.player(foe).hand.map((c) => c.id), {
            ai: 'best',
            source: self.def.id,
          })
          if (pick) g.discard(foe, pick)
        }
      },
    },
  },
  {
    name: 'Paul Atreides',
    subtitle: 'Usul',
    text: "While you control an [{Arrakis}] base, this unit gains [Hidden].\n[On Attack:] Look at the top card of your deck. You may discard it. If you do and it's a [{Fremen}] card, this unit gets [+2/+0] for this attack.",
    front: {
      onAttack: (g, self) => {
        const [top] = g.top(self.controller, 1)
        if (!top) return
        const fremen = g.hasTrait(top, 'Fremen')
        const discard = g.option(self.controller, 'Paul Atreides: discard the top card of your deck?', ['Leave it on top', 'Discard it'], {
          ai: fremen ? 1 : 0,
          source: self.def.id,
          card: top.def,
        })
        if (discard !== 1) return
        g.mill(self.controller, top.id)
        if (fremen) g.buff(self.id, 2, 0, 'attack')
      },
    },
  },

  // --- Taking control ---
  {
    name: 'Lady Margot Fenring',
    subtitle: 'Agent of the Sisterhood',
    text: '[When Played/On Attack:] Choose an enemy non-leader unit. You may discard a card from your hand. If you do and it costs [#4] or less, take control of it. Otherwise, exhaust it. At the start of the regroup phase, its owner takes control of it.',
    front: {
      whenPlayed: (g, self) => margot(g, self),
      onAttack: (g, self) => margot(g, self),
    },
  },
  {
    name: 'Seduction',
    text: 'Choose an enemy non-leader unit. If it costs the same as or less than a friendly [Bene Gesserit] unit, take control of it and ready it. Otherwise, exhaust it. At the start of the regroup phase, its owner takes control of it.',
    front: {
      play: (g, self) => {
        const p = self.controller
        const target = g.chooseOne(p, 'Seduction: choose an enemy non-leader unit', unitIds(g, (u) => g.controller(u) !== p && !u.leader), {
          ai: 'harm',
          source: self.def.id,
        })
        if (!target) return
        const unit = g.unit(target)!
        const sisters = g.units((u) => g.controller(u) === p && g.hasTrait(u, 'Bene Gesserit'))
        if (sisters.some((u) => g.cost(u) >= g.cost(unit))) {
          g.takeControl(target, p, true)
          g.ready(target)
        } else g.exhaust(target)
      },
    },
  },
  {
    name: 'Worm Signs',
    text: 'If you control an [{Arrakis}] base, choose a non-[{Fremen}] non-leader ground unit. Its controller chooses one:\n• Return it to its owner\'s hand.\n• Defeat it when the next regroup phase starts.',
    front: {
      play: (g, self) => {
        if (!g.controlsArrakis(self.controller)) return
        const target = g.chooseOne(self.controller, 'Worm Signs: choose a non-Fremen non-leader ground unit', unitIds(g, (u) => u.arena === 'ground' && !u.leader && !g.hasTrait(u, 'Fremen')), {
          ai: 'harm',
          source: self.def.id,
        })
        if (!target) return
        const owner = g.controller(g.unit(target)!)
        const choice = g.option(owner, `Worm Signs: ${g.name(target)}…`, ["Return it to its owner's hand", 'Defeat it when the next regroup phase starts'], {
          ai: 0,
          source: self.def.id,
        })
        if (choice === 0) g.returnToHand(target)
        else {
          g.doom(target)
          g.log(`${g.name(target)} will be defeated when the regroup phase starts`, owner)
        }
      },
    },
  },

  // --- Choices ---
  {
    name: 'Bene Gesserit Sister',
    text: '[Restore 1]\n[When Played:] Choose one:\n• Deal 2 damage to a unit.\n• The next [{Bene Gesserit}] card you play this phase costs [2] less.',
    front: {
      whenPlayed: (g, self) => {
        const p = self.controller
        const enemies = unitIds(g, (u) => g.controller(u) !== p)
        const choice = g.option(p, 'Bene Gesserit Sister: choose one', ['Deal 2 damage to a unit', 'The next Bene Gesserit card you play this phase costs 2 less'], {
          ai: enemies.length ? 0 : 1,
          source: self.def.id,
        })
        if (choice === 1) return g.discountNext(p, 'Bene Gesserit', 2)
        const pick = g.chooseOne(p, 'Bene Gesserit Sister: deal 2 damage to a unit', unitIds(g, () => true), { ai: 'harm', source: self.def.id })
        if (pick) g.damage(pick, 2, self)
      },
    },
  },
  {
    name: 'Family Atomics',
    text: 'Choose one:\n• Defeat an upgrade. If it was a Fortification, draw a card.\n• Pay [3]. If you do, defeat a non-leader unit and deal 3 damage to your base.',
    front: {
      play: (g, self) => {
        const p = self.controller
        const upgrades = g.upgrades()
        const enemyUpgrade = upgrades.some((u) => u.controller !== p)
        const choice = g.option(p, 'Family Atomics: choose one', ['Defeat an upgrade', 'Pay 3 to defeat a non-leader unit and deal 3 damage to your base'], {
          ai: !enemyUpgrade && g.canPay(p, 3) ? 1 : 0,
          source: self.def.id,
        })
        if (choice === 0) {
          const pick = g.chooseOne(p, 'Family Atomics: defeat an upgrade', upgrades.map((u) => u.id), { ai: 'harm', source: self.def.id })
          if (!pick) return
          const fortification = g.hasTrait(upgrades.find((u) => u.id === pick)!, 'Fortification')
          g.defeatUpgrade(pick)
          if (fortification) g.draw(p, 1)
          return
        }
        if (!g.pay(p, 3)) return
        const pick = g.chooseOne(p, 'Family Atomics: defeat a non-leader unit', unitIds(g, (u) => !u.leader), { ai: 'harm', source: self.def.id })
        if (pick) g.defeat(pick)
        g.damage(`base${p}`, 3, self)
      },
    },
  },

  // --- Fortifications (Fortify: on your base) ---
  {
    name: 'Thumper',
    text: '[Fortify]\n[When Played:] Search the top 10 cards of your deck for a [Creature] card, reveal it and draw it.\n[Creature] cards you play cost [1] less. When you play a [{Creature}] card, defeat this upgrade.',
    front: {
      whenPlayed: (g, self) => searchDeck(g, self, 10, (d) => d.traits.includes('Creature'), 'a Creature card'),
      costsLess: (_g, _self, card) => (card.traits.includes('Creature') ? 1 : 0),
      triggersIf: { whenYouPlay: (_g, self) => !!self.otherDef?.traits.includes('Creature') },
      whenYouPlay: (g, self) => g.defeatUpgrade(self.id),
    },
  },
  {
    name: 'Carthag Refinery',
    text: '[Fortify]\nWhile you control an [{Arrakis}] base, if you would create a Spice token, you may create 2 Spice tokens instead. If you do, deal 1 damage to attached base.\n[{Harvester}] units you play cost [1] less.',
    front: {
      moreSpice: (g, self) => {
        const p = self.controller
        if (!g.controlsArrakis(p)) return false
        // The AI takes the Spice while its base can spare the damage
        const left = g.def(g.player(p).base).hp - g.player(p).base.damage
        if (!g.may(p, 'Carthag Refinery: create 2 Spice tokens instead of 1, and deal 1 damage to your base?', { yes: 'Create 2', no: 'Create 1', ai: left > 6, source: self.def.id }))
          return false
        g.damage(`base${p}`, 1, self)
        return true
      },
      costsLess: (_g, _self, card) => (card.type === 'unit' && card.traits.includes('Harvester') ? 1 : 0),
    },
  },
  {
    name: 'The Shield Wall',
    text: '[FORTIFY]\nAttached base gains: "Enemy ground units get [-1/-0] while attacking bases. \nYour units can\'t be defeated by enemy Shai-Hulud card abilities."',
    front: {
      gives: (g, self, unit) =>
        g.controller(unit) !== self.controller && unit.arena === 'ground' && g.attack?.attacker === unit.id && g.attack.target === 'base'
          ? { power: -1 }
          : undefined,
      cantBeDefeatedBy: (_g, _self, from) => from.def.name === 'Shai-Hulud',
    },
  },

  // --- Leaders ---
  {
    name: 'Count Hasimir Fenring',
    subtitle: "The Emperor's Shadow",
    text: "[When a friendly unit deals combat damage to an enemy base:] You may exhaust this leader and defeat a friendly Spice token. If you do, look at that player's hand. You may discard a card from it. If you do, that player draws a card.",
    backText:
      "[Saboteur]\n[When Deployed:] Look at an opponent's hand and discard a card from it.\nOnce each round, when a friendly unit deals combat damage to an enemy base: You may defeat a friendly Spice token. If you do, look at that player's hand. You may discard a card from it. If you do, that player draws a card.",
    front: {
      whenCombatDamageBase: (g, self) => {
        const p = self.controller
        if (!g.leaderReady(p) || !g.spice(p)) return
        if (!g.may(p, "Count Hasimir Fenring: exhaust this leader and defeat a Spice token to look at their hand?", { yes: 'Do it', no: 'Skip', source: self.def.id }))
          return
        g.exhaustLeader(p)
        g.defeatSpice(p)
        fenringLook(g, self)
      },
    },
    back: {
      whenDeployed: (g, self) => {
        const foe = enemy(g, self)
        g.log(`Count Hasimir Fenring looks at ${g.player(foe).name}'s hand`, self.controller)
        const pick = g.chooseOne(self.controller, "Count Hasimir Fenring: discard a card from their hand", g.player(foe).hand.map((c) => c.id), {
          ai: 'best',
          source: self.def.id,
        })
        if (pick) g.discard(foe, pick)
      },
      whenCombatDamageBase: (g, self) => {
        const p = self.controller
        if (g.used(self) || !g.spice(p)) return
        if (!g.may(p, 'Count Hasimir Fenring: defeat a Spice token to look at their hand?', { yes: 'Defeat a Spice token', no: 'Skip', source: self.def.id })) return
        g.use(self)
        g.defeatSpice(p)
        fenringLook(g, self)
      },
    },
  },
  {
    name: 'Paul Atreides',
    subtitle: 'Haunted by Dreams',
    text: 'You may look at the top card of your deck at any time.\n[Action [Arrow]:] Discard the top card of your deck. Then, attack with a unit. If it has the same cost as the discarded card, it gets [+2/+0] for this attack.',
    backText:
      '[Raid 1]\n[On Attack:] Look at the top 3 cards of your deck. Discard 1 of them and put the others back in any order. If the discarded card has an [On Attack] ability, use it as if it were this unit\'s.',
    front: {
      seesTopCard: true,
      actions: [
        {
          label: 'discard your top card, then attack',
          exhaust: true,
          can: (g, self) => g.top(self.controller, 1).length > 0,
          run: (g, self) => {
            const p = self.controller
            const [top] = g.top(p, 1)
            if (!top) return
            g.mill(p, top.id)
            const cost = g.def(top).cost
            const ready = friendlyIds(g, self, (u) => g.canAttack(u.id))
            const same = ready.find((id) => g.cost(g.unit(id)!) === cost)
            const pick = g.chooseOne(p, `Paul Atreides: attack with a unit (one that costs ${cost} gets +2/+0)`, ready, {
              ai: same ?? 'help',
              source: self.def.id,
            })
            if (pick) g.attackWith(pick, { power: g.cost(g.unit(pick)!) === cost ? 2 : 0 })
          },
        },
      ],
    },
    back: {
      onAttack: (g, self) => {
        const p = self.controller
        const top = g.top(p, 3)
        if (!top.length) return
        const withAttack = top.find((c) => abilitiesOf(g.def(c), 'front').onAttack)
        const pick = g.chooseOne(p, 'Paul Atreides: discard 1 of the top 3 cards of your deck', top.map((c) => c.id), {
          ai: withAttack?.id ?? 'cheap',
          source: self.def.id,
        })
        if (!pick) return
        const card = g.card(pick)!
        g.mill(p, pick)
        // The others back on top, in the order chosen
        const rest = top.filter((c) => c.id !== pick)
        if (rest.length === 2) {
          const first = g.option(p, 'Paul Atreides: which card goes on top?', rest.map((c) => g.def(c).name), { source: self.def.id })
          g.toTop(p, rest[1 - first].id)
          g.toTop(p, rest[first].id)
        }
        const onAttack = abilitiesOf(g.def(card), 'front').onAttack
        if (onAttack) {
          g.log(`Paul Atreides uses ${g.def(card).name}'s On Attack ability`, p)
          onAttack(g, self)
        }
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

// The keywords a unit may gain from a card printed with them
const combatKeywords = ['sentinel', 'raid', 'restore', 'overwhelm', 'grit', 'saboteur', 'ambush', 'hidden'] as const
type CombatKeyword = (typeof combatKeywords)[number]

function addKeyword(keywords: Keywords, name: CombatKeyword, value: number | boolean | undefined) {
  if (typeof value === 'number') (keywords[name] as number) = ((keywords[name] as number) ?? 0) + value
  else if (value) (keywords[name] as boolean) = true
}

// "Raid 2", "Sentinel": a keyword as a card prints it
const keywordLabel = (card: { def: string }, g: Game) => (name: CombatKeyword) => {
  const value = g.def(card).keywords[name]
  const word = name[0].toUpperCase() + name.slice(1)
  return typeof value === 'number' ? `${word} ${value}` : word
}

// "Search the top N cards of your deck for …, reveal it and draw it.": the rest go to the bottom
function searchDeck(g: Game, self: Self, count: number, test: (card: CardDef) => boolean, what: string) {
  const p = self.controller
  const top = g.top(p, count)
  const found = top.filter((c) => test(g.def(c))).map((c) => c.id)
  const text = found.length
    ? `${self.def.name}: search the top ${count} cards of your deck for ${what}`
    : `${self.def.name}: no ${what.replace(/^an? /, '')} in the top ${count} cards of your deck`
  const pick = g.chooseOne(p, text, found, { ai: 'best', source: self.def.id, seen: top.map((c) => c.id) })
  if (pick) {
    g.reveal(p, [pick], self)
    g.drawCard(p, pick)
  } else g.log(`${self.def.name} finds nothing`, p)
  g.shuffleToBottom(p, top.filter((c) => c.id !== pick).map((c) => c.id))
  return pick
}

// "You may play … from your discard pile for free"
function playFromDiscard(g: Game, self: Self, text: string, test: (card: CardDef, id: string) => boolean) {
  const p = self.controller
  const ids = g
    .player(p)
    .discard.filter((c) => test(g.def(c), c.id) && g.canPlay(p, c.id, { free: true }))
    .map((c) => c.id)
  const pick = g.chooseOne(p, text, ids, { optional: true, ai: 'best', source: self.def.id })
  if (pick) g.playCard(p, pick, { free: true })
  return pick
}

const carryall = (g: Game, self: Self) =>
  playFromDiscard(g, self, 'Carryall: you may play a ground Vehicle unit defeated this phase from your discard pile', (d, id) =>
    d.type === 'unit' && d.arena === 'ground' && d.traits.includes('Vehicle') && d.cost <= 5 && g.defeatedThisPhase(id),
  )

function dropShip(g: Game, self: Self) {
  const troopers = (d: CardDef) => d.type === 'unit' && d.traits.includes('Harkonnen') && d.traits.includes('Trooper') && d.cost <= 2
  for (let i = 0; i < 2; i++)
    if (!playFromDiscard(g, self, `Harkonnen Drop Ship: you may play a Harkonnen Trooper unit that costs 2 or less from your discard pile (${2 - i} left)`, troopers)) return
}

const isFremenOrSister = (g: Game, card: { def: string }) =>
  g.def(card).type === 'unit' && (g.hasTrait(card, 'Fremen') || g.hasTrait(card, 'Bene Gesserit'))

// Whether a player controls a card of one of these names: a unit, or their leader
const controlsNamed = (g: Game, p: PlayerId, names: string[]) =>
  g.units((u) => g.controller(u) === p).some((u) => names.includes(g.def(u).name)) ||
  (!g.player(p).leader.deployed && names.includes(g.def(g.player(p).leader).name))

// Rabban's Gunship: 1 damage to a friendly unit for 2 to a ground unit or base
function gunship(g: Game, self: Self) {
  const p = self.controller
  const friends = friendlyIds(g, self)
  // The AI hurts a unit that survives it
  const tough = friends.find((id) => {
    const u = g.unit(id)!
    return g.hp(u) - u.damage > 1
  })
  const hurt = g.chooseOne(p, "Rabban's Gunship: you may deal 1 damage to a friendly unit to deal 2 damage to a ground unit or base", friends, {
    optional: true,
    ai: tough ?? 'none',
    source: self.def.id,
  })
  if (!hurt) return
  g.damage(hurt, 1, self)
  const pick = g.chooseOne(p, "Rabban's Gunship: deal 2 damage to a ground unit or base", [...unitIds(g, (u) => u.arena === 'ground'), ...bases()], {
    ai: 'harm',
    source: self.def.id,
  })
  if (pick) g.damage(pick, 2, self)
}

// Imperial Spy: the top card of the opponent's deck, left, put on the bottom or discarded
function imperialSpy(g: Game, self: Self) {
  const foe = enemy(g, self)
  const [top] = g.top(foe, 1)
  if (!top) return
  const where = g.option(self.controller, `Imperial Spy: the top card of their deck is ${g.def(top).name}`, ['Leave it on top', 'Put it on the bottom', 'Discard it'], {
    ai: 2,
    source: self.def.id,
    card: top.def,
  })
  if (where === 1) {
    g.toBottom(foe, top.id)
    g.log(`${g.player(self.controller).name} puts the top card of ${g.player(foe).name}'s deck on the bottom`, self.controller)
  } else if (where === 2) g.mill(foe, top.id)
}

// "Look at an opponent's hand and choose a card in it. This phase, they can't play cards with that
// name. Draw a card." (The Voice, Lady Jessica)
function nameACard(g: Game, self: Self) {
  const foe = enemy(g, self)
  g.log(`${g.player(self.controller).name} looks at ${g.player(foe).name}'s hand`, self.controller)
  const pick = g.chooseOne(self.controller, `${self.def.name}: choose a card in their hand; they can't play cards with that name this phase`, g.player(foe).hand.map((c) => c.id), {
    ai: 'best',
    source: self.def.id,
  })
  if (pick) g.ban(foe, g.def(g.card(pick)!).name)
  g.draw(self.controller, 1)
}

// Count Hasimir Fenring: a look at the hand of the player whose base was hit, a card discarded
// from it for one drawn
function fenringLook(g: Game, self: Self) {
  const foe = enemy(g, self)
  g.log(`Count Hasimir Fenring looks at ${g.player(foe).name}'s hand`, self.controller)
  const pick = g.chooseOne(self.controller, 'Count Hasimir Fenring: you may discard a card from their hand; they draw a card', g.player(foe).hand.map((c) => c.id), {
    optional: true,
    ai: 'best',
    source: self.def.id,
  })
  if (!pick) return
  g.discard(foe, pick)
  g.draw(foe, 1)
}

// Lady Margot Fenring: a card discarded takes a unit that costs 4 or less; otherwise it is exhausted
function margot(g: Game, self: Self) {
  const p = self.controller
  const target = g.chooseOne(p, 'Lady Margot Fenring: choose an enemy non-leader unit', unitIds(g, (u) => g.controller(u) !== p && !u.leader), {
    ai: 'harm',
    source: self.def.id,
  })
  if (!target) return
  const cheap = g.cost(g.unit(target)!) <= 4
  const discarded =
    g.player(p).hand.length > 0 &&
    g.may(p, `Lady Margot Fenring: discard a card from your hand${cheap ? ` to take control of ${g.name(target)}` : ''}?`, {
      yes: 'Discard a card',
      no: 'Skip',
      ai: cheap && g.player(p).hand.length > 1,
      source: self.def.id,
    }) &&
    g.discardChosen(p, 1, 'Lady Margot Fenring: choose a card to discard', self.def.id) > 0
  if (discarded && cheap) g.takeControl(target, p, true)
  else g.exhaust(target)
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

// Each card's script, found once: a game's copies share their cards
const scriptOfCard = new WeakMap<CardDef, CardScript | null>()

export function scriptFor(card: CardDef): CardScript | undefined {
  const known = scriptOfCard.get(card)
  if (known !== undefined) return known ?? undefined
  const script = findScript(card)
  scriptOfCard.set(card, script ?? null)
  return script
}

function findScript(card: CardDef): CardScript | undefined {
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
