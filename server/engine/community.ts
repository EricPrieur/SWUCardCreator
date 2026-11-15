import type { Game } from './game.ts'
import { searchDeck, type CardScript, type Self } from './scripts.ts'
import type { CardDef, UnitState } from './types.ts'

// The scripts of community cards: cards players made in the Creator and submitted to be played
// (Showroom, Submit for play). Each names its card by '<account id>/<card id>', as the Admin
// panel's Community queue shows it, and quotes the card's text as submitted, like DUNE's
// scripts: an edited card waits for its script to be brought up to date. A card whose text the
// engine plays by itself (keywords only) needs none.
//
// Kept apart from DUNE's (scripts.ts): two cards of the same name, a DUNE one and a community
// one, or two players', each keep their own script.
//
// To see what waits for a script in production: node tools/prod-queue.ts (from server/).

// --- zverev20's Splatoon cards (account 5): the Ink token and the cards that give it ---

// A trait, whatever its case ("[{OCTOWEAPON}]" for the Octoweapon trait)
const hasTraitCi = (d: CardDef, trait: string) => d.traits.some((t) => t.toLowerCase() === trait.toLowerCase())
const enemyUnits = (g: Game, self: Self) => g.units((u) => g.controller(u) !== self.controller)
const friendlyUnits = (g: Game, self: Self) => g.units((u) => g.controller(u) === self.controller)
const ink = (g: Game, unitId: string) => g.giveToken(unitId, 'Ink')
// The AI inks the enemy unit that can hurt it most: the strongest
const strongest = (g: Game, units: UnitState[]) => [...units].sort((a, b) => g.power(b) - g.power(a))[0]?.id

// "Each friendly unit gives 1 Ink token to a different enemy unit."
function inkEach(g: Game, self: Self) {
  const enemies = enemyUnits(g, self)
  const n = Math.min(friendlyUnits(g, self).length, enemies.length)
  if (!n) return
  const ai = [...enemies]
    .sort((a, b) => g.power(b) - g.power(a))
    .slice(0, n)
    .map((u) => u.id)
  const picks = g.choose(self.controller, `${self.def.name}: give 1 Ink token to each of ${n} different enemy units`, enemies.map((u) => u.id), {
    min: n,
    max: n,
    ai,
    source: self.def.id,
  })
  for (const id of picks) ink(g, id)
}

// Up to (or exactly) so many Ink tokens, one at a time, among enemy units
function inkAmong(g: Game, self: Self, count: number, optional: boolean) {
  for (let i = 0; i < count; i++) {
    const enemies = enemyUnits(g, self)
    const pick = g.chooseOne(self.controller, `${self.def.name}: give an Ink token to an enemy unit (${count - i} left)`, enemies.map((u) => u.id), {
      optional,
      ai: strongest(g, enemies),
      source: self.def.id,
    })
    if (!pick) return
    ink(g, pick)
  }
}

export const communityScripts: (CardScript & { card: string })[] = [
  {
    card: '5/eb36170b-6ef9-458c-833e-a4dfc666c152',
    name: 'Ink',
    text: 'If attached unit would take combat damage, it takes that much damage plus 1 instead, then, defeat this upgrade.',
    front: {
      attachedCombatDamage: (g, self, amount) => {
        g.log(`Ink: ${g.name(self.attachedTo!)} takes 1 more combat damage`)
        g.defeatUpgrade(self.id)
        return amount + 1
      },
    },
  },
  {
    card: '5/402a3f44-e2a6-4694-a56a-eb9439530eb8',
    name: 'Octowhirl',
    text: '[When Played:] Give each enemy unit an Ink token.\n[On Attack:] You may deal 1 damage to each enemy unit with an Ink token.',
    front: {
      whenPlayed: (g, self) => {
        for (const u of enemyUnits(g, self)) ink(g, u.id)
      },
      onAttack: (g, self) => {
        const inked = enemyUnits(g, self).filter((u) => g.tokens(u.id, 'Ink') > 0)
        if (!inked.length) return
        const yes = g.may(self.controller, `Octowhirl: deal 1 damage to each enemy unit with an Ink token (${inked.length})?`, {
          ai: true,
          source: self.def.id,
        })
        if (yes) for (const u of inked) g.damage(u.id, 1, self)
      },
    },
  },
  {
    card: '5/8b0bf3d8-e497-4530-ac19-2c8399b6dea6',
    name: 'Octonozzle',
    text: '<<[Sentinel]>>\n[When Defense Ends:] You may give an Ink token to the attacker.',
    front: {
      afterDefending: (g, self) => {
        const attacker = self.other ? g.unit(self.other) : undefined
        if (!attacker) return
        if (g.may(self.controller, `Octonozzle: give an Ink token to ${g.name(attacker.id)}?`, { ai: true, source: self.def.id })) ink(g, attacker.id)
      },
    },
  },
  {
    card: '5/47d9297f-5bce-45ad-9f5a-15b0ef71c986',
    name: 'Octostomp',
    text: '[Overwhelm]\n[When this unit deals combat damage to an enemy unit:] Distribute up to 3 Ink tokens among enemy units.',
    front: {
      whenCombatDamageUnit: (g, self) => inkAmong(g, self, 3, true),
    },
  },
  {
    card: '5/643f1a55-ea94-426f-b965-869a91aad48b',
    name: 'Enter the Octobot!',
    text: 'Search the top 10 cards of your deck for an [{OCTOWEAPON}] unit, reveal it, and draw it. Then, if it costs [6] or less, you may play it for free. {(Put the remaining cards on the bottom of your deck in a random order.)}',
    front: {
      play: (g, self) => {
        const p = self.controller
        const found = searchDeck(g, self, 10, (d) => d.type === 'unit' && hasTraitCi(d, 'Octoweapon'), 'an Octoweapon unit')
        const card = found && g.player(p).hand.find((c) => c.id === found)
        if (card && g.def(card).cost <= 6) g.mayPlay(p, card.id, `Enter the Octobot!: play ${g.name(card.id)} for free?`, { free: true, source: self.def.id })
      },
    },
  },
  {
    card: '5/083fdaec-a16c-4773-9266-cbfbcd7d5784',
    name: 'Octocopter',
    text: '[When Attack Ends:] Give the defending unit an Ink token.',
    front: {
      whenAttackEnds: (g, self) => {
        const target = self.attack?.target
        if (target && target !== 'base' && g.unit(target)) ink(g, target)
      },
    },
  },
  {
    card: '5/ab28c790-c8f8-463d-84fd-8763f22c4297',
    name: 'Octotrooper',
    text: '[When Attack Ends:] You may give the defending unit an Ink token.',
    front: {
      whenAttackEnds: (g, self) => {
        const target = self.attack?.target
        if (!target || target === 'base' || !g.unit(target)) return
        if (g.may(self.controller, `Octotrooper: give an Ink token to ${g.name(target)}?`, { ai: true, source: self.def.id })) ink(g, target)
      },
    },
  },
  {
    card: '5/f3bd9f1f-6832-4d93-a6aa-6b4097b0e87a',
    name: 'Squee-G',
    text: '[When Defeated:] You may defeat all upgrades attached to a friendly unit.',
    front: {
      whenDefeated: (g, self) => {
        const units = friendlyUnits(g, self).filter((u) => u.upgrades.length)
        // The AI clears the unit carrying the most enemy upgrades (Ink, Weakness), if any
        const enemyOwned = (u: UnitState) => u.upgrades.filter((up) => up.owner !== self.controller).length
        const best = [...units].sort((a, b) => enemyOwned(b) - enemyOwned(a))[0]
        const pick = g.chooseOne(self.controller, 'Squee-G: you may defeat all upgrades attached to a friendly unit', units.map((u) => u.id), {
          optional: true,
          ai: best && enemyOwned(best) > 0 ? best.id : undefined,
          source: self.def.id,
        })
        const unit = pick ? g.unit(pick) : undefined
        if (unit) for (const up of [...unit.upgrades]) g.defeatUpgrade(up.id)
      },
    },
  },
  {
    card: '5/af701a4e-d288-4f37-aaa4-7ec9d9441a9a',
    name: 'Imprisoned Zapfish',
    text: '[Shielded]\n[When Played:] You may give a Shield token to a friendly [{VEHICLE}] or [{DROID}] unit.',
    front: {
      whenPlayed: (g, self) => {
        const units = friendlyUnits(g, self).filter((u) => hasTraitCi(g.def(u), 'Vehicle') || hasTraitCi(g.def(u), 'Droid'))
        const pick = g.chooseOne(self.controller, 'Imprisoned Zapfish: you may give a Shield token to a friendly Vehicle or Droid unit', units.map((u) => u.id), {
          optional: true,
          ai: strongest(g, units),
          source: self.def.id,
        })
        if (pick) g.giveToken(pick, 'Shield')
      },
    },
  },
  {
    // A pilot leader. Its Piloting box ("Attached unit is a leader unit." and an On Attack) isn't
    // played yet: the engine deploys a leader as a unit only, so he deploys as one.
    card: '5/ef5317d1-f494-4946-842d-6f820763e767',
    name: 'DJ Octavio',
    text: '[Action [[Arrow]]:] For each friendly unit, give 1 Ink token to an enemy unit.',
    backText: '[When Deployed:] Each friendly unit gives 1 Ink token to a different enemy unit.',
    front: {
      actions: [
        {
          label: 'give an Ink token to an enemy unit for each friendly unit',
          exhaust: true,
          can: (g, self) => friendlyUnits(g, self).length > 0 && enemyUnits(g, self).length > 0,
          run: (g, self) => inkAmong(g, self, friendlyUnits(g, self).length, false),
        },
      ],
    },
    back: { whenDeployed: inkEach },
  },
]
