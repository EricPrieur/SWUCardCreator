import type { Game } from './game.ts'
import { enginePlays } from './cards.ts'
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
  // Played from the resources using Smuggle, or Plot
  smuggled?: boolean
  plot?: boolean
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
]

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

export function scriptFor(card: CardDef): CardScript | undefined {
  const script = byKey.get(keyOf(card.name, card.subtitle))
  if (!script || normal(script.text) !== normal(card.text)) return undefined
  if (card.type === 'leader' && normal(script.backText) !== normal(card.backText)) return undefined
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
