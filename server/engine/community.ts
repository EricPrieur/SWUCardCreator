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
const ink2 = (g: Game, unitId: string) => g.giveToken(unitId, 'Ink', 2)
// The AI inks the enemy unit that can hurt it most: the strongest
const strongest = (g: Game, units: UnitState[]) => [...units].sort((a, b) => g.power(b) - g.power(a))[0]?.id

// "Each friendly unit gives 1 Ink token to a different enemy unit."
function inkEach(g: Game, self: Self) {
  const enemies = enemyUnits(g, self)
  const n = Math.min(friendlyUnits(g, self).length, enemies.length)
  if (!n) return
  const picks = g.choose(self.controller, `${self.def.name}: give 1 Ink token to each of ${n} different enemy units`, enemies.map((u) => u.id), {
    min: n,
    max: n,
    ai: 'harm',
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

// The Ink tokens on a unit; on every unit in play
const inkOn = (g: Game, unitId: string) => g.tokens(unitId, 'Ink')
const inkInPlay = (g: Game) => g.units(() => true).reduce((sum, u) => sum + inkOn(g, u.id), 0)
// "Give the defending unit N Ink tokens", while it is still in play
const inkDefender = (g: Game, self: Self, count: number) => {
  const target = self.attack?.target
  if (target && target !== 'base' && g.unit(target)) g.giveToken(target, 'Ink', count)
}
const isOctarianTrooper = (g: Game, u: UnitState) =>
  g.traits(u).some((t) => t.toLowerCase() === 'octarian') && g.traits(u).some((t) => t.toLowerCase() === 'trooper')

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
    // A pilot leader: deployed as a unit, or as an upgrade on a friendly Vehicle, which then is a
    // leader unit and inks with each attack
    card: '5/ef5317d1-f494-4946-842d-6f820763e767',
    name: 'DJ Octavio',
    text: '[Action [[Arrow]]:] For each friendly unit, give 1 Ink token to an enemy unit.',
    backText: '[When Deployed:] Each friendly unit gives 1 Ink token to a different enemy unit.',
    pilotText: 'Attached unit is a leader unit.\n[On Attack:] Each friendly unit gives 1 Ink token to a different enemy unit.',
    pilot: { attachedOnAttack: inkEach },
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
  {
    card: '5/9fc58d01-10ae-4e15-9ae0-ebbcdaff5dba',
    name: 'Attack the Vulnerable',
    text: 'Deal 2 damage to each enemy unit with an Ink token.',
    front: {
      play: (g, self) => {
        for (const u of enemyUnits(g, self).filter((u) => inkOn(g, u.id) > 0)) g.damage(u.id, 2, self)
      },
    },
  },
  {
    card: '5/f6de14c9-b560-4599-9c7d-7041cd55a803',
    name: 'Elite Octoling',
    text: 'This unit gains [+1/+0] for each Ink token in play.',
    front: {
      gives: (g, self, unit) => (unit.id === self.id ? { power: inkInPlay(g) } : undefined),
    },
  },
  {
    card: '5/0887a584-8a60-4742-908d-b3b9bdb27b52',
    name: 'Octorpedo',
    text: '[Raid 1]\n[When Attack Ends:] You may defeat this unit, if you do, give the defending unit 6 Ink tokens.',
    front: {
      whenAttackEnds: (g, self) => {
        if (!self.survived || !g.unit(self.id)) return
        const target = self.attack?.target
        const onUnit = !!target && target !== 'base' && !!g.unit(target)
        // The AI blows it up on a unit still in play
        if (!g.may(self.controller, 'Octorpedo: defeat this unit to give the defending unit 6 Ink tokens?', { ai: onUnit, source: self.def.id })) return
        g.defeat(self.id, self)
        if (!g.unit(self.id)) inkDefender(g, self, 6)
      },
    },
  },
  {
    card: '5/db3d98fd-714f-45e0-ac9f-3a2d798e69ef',
    name: 'Marina',
    text: '[Restore 1]\nThe first upgrade you play on another friendly unit each phase costs [1] less.',
    front: {
      costsLess: (g, self, card, _from, onto) =>
        card.type === 'upgrade' && onto && onto.id !== self.id && g.controller(onto) === self.controller && !g.used(self, `upgrade ${g.state.phaseCount}`) ? 1 : 0,
      costedLess: (g, self) => g.use(self, `upgrade ${g.state.phaseCount}`),
    },
  },
  {
    card: '5/a48bab9d-5992-4b4b-83b6-a1cbd9677450',
    name: 'Shielded Twintacle Octotrooper',
    text: '[Shielded]\n[When Attack Or Defense Ends:] You may give the attacking/defending enemy unit 2 Ink tokens.',
    front: {
      whenAttackEnds: (g, self) => {
        const target = self.attack?.target
        if (!target || target === 'base' || !g.unit(target)) return
        if (g.may(self.controller, `Shielded Twintacle Octotrooper: give ${g.name(target)} 2 Ink tokens?`, { ai: true, source: self.def.id })) ink2(g, target)
      },
      afterDefending: (g, self) => {
        const attacker = self.other ? g.unit(self.other) : undefined
        if (!attacker) return
        if (g.may(self.controller, `Shielded Twintacle Octotrooper: give ${g.name(attacker.id)} 2 Ink tokens?`, { ai: true, source: self.def.id }))
          ink2(g, attacker.id)
      },
    },
  },
  {
    card: '5/0f7f7858-26b6-4b62-8ea9-a25ab7a07af0',
    name: 'Octozeppelin',
    text: 'At the start of the action phase, give an Ink token to an enemy unit.',
    front: {
      actionStart: (g, self) => inkAmong(g, self, 1, false),
    },
  },
  {
    card: '5/88a03ac1-e5ec-494c-8fb5-f92cfa83b3a1',
    name: 'Octarian Blueprints',
    text: 'This upgrade costs [1] less to play on an [{OCTARIAN}] unit.',
    front: {
      costsLessOnto: (g, _p, unit) => (g.traits(unit).some((t) => t.toLowerCase() === 'octarian') ? 1 : 0),
    },
  },
  {
    card: '5/024a8a18-f2fa-4050-800e-e68c8aa795c6',
    name: 'Octoling',
    text: 'This unit gains [+1/+0] for each other friendly [{OCTARIAN}] [{TROOPER}] unit.',
    front: {
      gives: (g, self, unit) =>
        unit.id === self.id ? { power: friendlyUnits(g, self).filter((u) => u.id !== self.id && isOctarianTrooper(g, u)).length } : undefined,
    },
  },
  {
    card: '5/4bbcd684-dcff-46e0-a7a9-6a2c26da8d2c',
    name: 'Long Distance Strike',
    text: "Reveal a unit from your hand, at the start of the next action phase, deal damage to an enemy unit equal to the revealed unit's power. {(If the damaged enemy unit has Ink tokens on it, defeat them and deal 1 damage to that enemy unit for each one.)}",
    front: {
      play: (g, self) => {
        const units = g.player(self.controller).hand.filter((c) => g.def(c).type === 'unit')
        const best = [...units].sort((a, b) => g.def(b).power - g.def(a).power)[0]
        const pick = g.chooseOne(self.controller, 'Long Distance Strike: reveal a unit from your hand', units.map((c) => c.id), {
          ai: best?.id,
          source: self.def.id,
        })
        if (!pick) return
        g.reveal(self.controller, [pick], self)
        const power = g.def(g.player(self.controller).hand.find((c) => c.id === pick)!).power
        g.log(`Long Distance Strike: ${power} damage to an enemy unit at the start of the next action phase`, self.controller)
        g.later(self, power)
      },
      later: (g, self, power = 0) => {
        const enemies = enemyUnits(g, self)
        // The AI hits the strongest unit it can defeat, else the strongest
        const lethal = (u: UnitState) => g.hp(u) - u.damage <= power + inkOn(g, u.id)
        const ai = strongest(g, enemies.filter(lethal)) ?? strongest(g, enemies)
        const pick = g.chooseOne(self.controller, `Long Distance Strike: deal ${power} damage to an enemy unit`, enemies.map((u) => u.id), {
          ai,
          source: self.def.id,
        })
        if (!pick) return
        g.damage(pick, power, self)
        const unit = g.unit(pick)
        if (!unit) return
        const inks = unit.upgrades.filter((up) => g.def(up).token && g.def(up).name === 'Ink')
        for (const up of inks) g.defeatUpgrade(up.id)
        if (inks.length && g.unit(pick)) g.damage(pick, inks.length, self)
      },
    },
  },
  {
    card: '5/708d0cc7-3f06-46c4-b982-20dd8781c9d5',
    name: 'Splat Bomb',
    text: 'Choose an arena, then give each enemy unit in that arena an Ink token, then, heal 1 damage from your base for each Ink token you gave in this way.',
    front: {
      play: (g, self) => {
        const count = (arena: string) => enemyUnits(g, self).filter((u) => u.arena === arena).length
        const pick = g.option(self.controller, 'Splat Bomb: choose an arena', ['Ground', 'Space'], {
          ai: count('space') > count('ground') ? 1 : 0,
          source: self.def.id,
        })
        const arena = pick === 1 ? 'space' : 'ground'
        const units = enemyUnits(g, self).filter((u) => u.arena === arena)
        let given = 0
        for (const u of units) {
          const before = inkOn(g, u.id)
          ink(g, u.id)
          given += inkOn(g, u.id) - before
        }
        g.heal(`base${self.controller}`, given, self)
      },
    },
  },
  {
    card: '5/fafa9a9e-fd25-4fdb-be89-5870c99191bb',
    name: 'Shielded Octotrooper',
    text: '[Shielded]\n[When Defense Ends:] You may give the attacker an Ink token.',
    front: {
      afterDefending: (g, self) => {
        const attacker = self.other ? g.unit(self.other) : undefined
        if (!attacker) return
        if (g.may(self.controller, `Shielded Octotrooper: give an Ink token to ${g.name(attacker.id)}?`, { ai: true, source: self.def.id })) ink(g, attacker.id)
      },
    },
  },
  {
    card: '5/f162924a-4be6-4117-ba9d-8089fe6f1357',
    name: 'Tentacle',
    text: 'If attached unit is an [{OCTOWEAPON}] or [{VEHICLE}], it gains: “[When Defeated:] Distribute 3 Ink tokens among enemy units.”',
    front: {
      attachedWhenDefeated: (g, self) => {
        const unit = self.otherDef
        if (unit && (hasTraitCi(unit, 'Octoweapon') || hasTraitCi(unit, 'Vehicle'))) inkAmong(g, self, 3, false)
      },
    },
  },
  {
    card: '5/982b238b-56b1-4aaf-80c4-7f48f3cdfdc3',
    name: 'Octostamp',
    text: '[When this unit deals combat damage to an enemy unit:] Give an Ink token to an enemy unit.',
    front: {
      whenCombatDamageUnit: (g, self) => inkAmong(g, self, 1, false),
    },
  },
  {
    card: '5/f7d9d38c-95ac-42e4-9619-55b7ef7885a1',
    name: 'Octobot King',
    text: '[When Played:] You may move this unit to the ground arena, if you do, give an Experience token to it.\nWhile this unit has an upgrade named DJ Octavio, it gains [Overwhelm] and [Restore 2]',
    front: {
      whenPlayed: (g, self) => {
        const unit = g.unit(self.id)
        if (!unit || unit.arena === 'ground') return
        // The AI moves it where the enemy has more units to fight
        const there = (arena: string) => enemyUnits(g, self).filter((u) => u.arena === arena).length
        const ai = there('ground') >= there('space')
        if (!g.may(self.controller, 'Octobot King: move this unit to the ground arena and give it an Experience token?', { ai, source: self.def.id })) return
        if (g.moveToArena(self.id, 'ground')) g.giveToken(self.id, 'Experience')
      },
      gives: (g, self, unit) =>
        unit.id === self.id && unit.upgrades.some((up) => g.def(up).name === 'DJ Octavio') ? { keywords: { overwhelm: true, restore: 2 } } : undefined,
    },
  },
  {
    card: '5/2481943b-e208-417b-bad3-faa3980334bf',
    name: 'Octopod',
    text: '[Raid 1]\n[When Attack Ends:] Defeat this unit, if you do, give the defending unit 3 Ink tokens.',
    front: {
      whenAttackEnds: (g, self) => {
        if (!self.survived || !g.unit(self.id)) return
        g.defeat(self.id, self)
        if (!g.unit(self.id)) inkDefender(g, self, 3)
      },
    },
  },
]
