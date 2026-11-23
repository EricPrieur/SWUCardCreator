import type { Game } from './game.ts'
import { abilitiesOf, searchDeck, type Ability, type CardScript, type Self } from './scripts.ts'
import type { Aspect, Keywords, PlayerId, UnitState } from './types.ts'

// The scripts of real Star Wars: Unlimited cards, for the dev-only SWU tab: the cards a swudb.com
// deck uses, imported by tools/swu-import.ts into public/showcase/SWU (not in git). Each names
// its card by id, swu-<set>-<number> (the normal printing's number), and quotes the card's text
// as the import writes it in the Creator's markup: a card whose text changes on swudb waits for
// its script to be brought up to date, as DUNE's do. Cards with only keywords need none.
//
// Kept apart from DUNE's (scripts.ts) and the community's (community.ts).

const friendly = (g: Game, self: Self, test: (u: UnitState) => boolean = () => true) =>
  g.units((u) => g.controller(u) === self.controller && test(u)).map((u) => u.id)
const enemy = (g: Game, self: Self, test: (u: UnitState) => boolean = () => true) =>
  g.units((u) => g.controller(u) !== self.controller && test(u)).map((u) => u.id)
const all = (g: Game, test: (u: UnitState) => boolean = () => true) => g.units(test).map((u) => u.id)
const baseOf = (p: PlayerId) => `base${p}`

// "You may disclose [Command][Heroism]": reveal cards from your hand whose aspect icons, together,
// include these. The AI always does when it can (revealing costs nothing here).
function disclose(g: Game, self: Self, aspects: Aspect[]) {
  const p = self.controller
  const hand = g.player(p).hand
  // Fewest cards that cover the icons: try each card that covers some of what is still needed
  const need = [...aspects]
  const shown: string[] = []
  for (const card of [...hand].sort((a, b) => g.def(b).aspects.length - g.def(a).aspects.length)) {
    const icons = [...g.def(card).aspects]
    const covers = need.filter((a) => {
      const i = icons.indexOf(a)
      if (i < 0) return false
      icons.splice(i, 1)
      return true
    })
    if (!covers.length) continue
    shown.push(card.id)
    for (const a of covers) need.splice(need.indexOf(a), 1)
    if (!need.length) break
  }
  if (need.length) return false
  if (!g.may(p, `${self.def.name}: disclose ${aspects.join(', ')}?`, { yes: 'Disclose', no: 'Skip', source: self.def.id })) return false
  g.reveal(p, shown, self)
  return true
}

// [Support] (ASH): "When you play this unit, you may attack with another unit. It gains this unit's
// other abilities for this attack." gains: those abilities, keywords and an On Attack.
// prefer: the units the AI attacks with first, when there are some (an upgraded one, for Yellow
// Aces Bomber, whose On Attack needs it); the strongest of them
function support(g: Game, self: Self, gains: { keywords?: Keywords; onAttack?: Ability; prefer?: (u: UnitState) => boolean } = {}) {
  const p = self.controller
  const ids = friendly(g, self, (u) => u.id !== self.id && g.canAttack(u.id))
  const preferred = gains.prefer ? ids.map((id) => g.unit(id)!).filter(gains.prefer).sort((a, b) => g.power(b) - g.power(a))[0] : undefined
  const pick = g.chooseOne(p, `${self.def.name}: Support: you may attack with another unit; it gains this unit's abilities`, ids, {
    optional: true,
    ai: preferred?.id ?? 'help',
    source: self.def.id,
  })
  if (!pick) return
  if (gains.keywords) g.grant(pick, gains.keywords, 'attack')
  g.attackWith(pick, gains.onAttack ? { onAttack: gains.onAttack } : {})
}
const hasExperience = (g: Game, u: UnitState) => g.tokens(u.id, 'Experience') > 0

// Yellow Aces Bomber's On Attack: its own, or the one a unit it supports gains
function bomberAttack(g: Game, self: Self) {
  const unit = g.unit(self.id)
  if (!unit?.upgrades.length) return
  const pick = g.chooseOne(self.controller, 'Yellow Aces Bomber: deal 2 damage to a base', [baseOf(0), baseOf(1)], { ai: 'harm', source: 'swu-ASH-253' })
  if (pick) g.damage(pick, 2, self)
}

// Migs Mayfeld's On Attack: its own, or the one a unit it supports gains
function migsAttack(g: Game, self: Self) {
  const target = self.attack?.target
  if (!target || target === 'base' || !g.unit(target)) return
  g.damage(target, g.unit(self.id)?.upgrades.length ? 2 : 1, self)
}

// Greef Karga's: "When you play or create a unit:" an Advantage token to it, the leader side
// exhausting for it (the AI always does), the unit side for free
function greefLeader(g: Game, self: Self) {
  const p = self.controller
  if (!self.other || !g.unit(self.other) || !g.leaderReady(p)) return
  if (!g.may(p, `Greef Karga: exhaust this leader to give ${g.name(self.other)} an Advantage token?`, { yes: 'Exhaust', no: 'Skip', ai: true, source: self.def.id })) return
  g.exhaustLeader(p)
  g.giveToken(self.other, 'Advantage')
}
// Whether the AI lets the unit's Ambush go first: the token, given after, stays on it for its
// next fight if it survives, where given before it is spent on the Ambush. Unless the +1 is what
// lets it defeat a unit (the dearest it can), or the unit has already attacked.
function ambushFirst(g: Game, self: Self) {
  const unit = self.other ? g.unit(self.other) : undefined
  if (!unit || !g.keywords(unit).ambush || g.attackedThisPhase().includes(unit.id)) return false
  const power = g.power(unit)
  const targets = g.attackable(unit.id, { exhausted: true, noBases: true }).map((id) => g.unit(id)!)
  const dearest = (bonus: number) =>
    Math.max(-1, ...targets.filter((t) => power + bonus >= g.hp(t) - t.damage).map((t) => g.cost(t)))
  return dearest(1) <= dearest(0)
}
function greefUnit(g: Game, self: Self) {
  if (self.other && g.unit(self.other)) g.giveToken(self.other, 'Advantage')
}

// Liberty's When Played and On Attack: exhaust an enemy unit, its upgrades costing 4 or less back
// to their owners' hands. The AI picks the ready enemy with the most of those, then the strongest.
function liberty(g: Game, self: Self) {
  const targets = enemy(g, self)
  if (!targets.length) return
  const bounced = (id: string) => g.unit(id)!.upgrades.filter((u) => g.def(u).cost <= 4).length
  const score = (id: string) => (g.unit(id)!.exhausted ? 0 : 10 + g.power(g.unit(id)!)) + 5 * bounced(id)
  const ai = [...targets].sort((a, b) => score(b) - score(a))[0]
  const pick = g.chooseOne(self.controller, 'Liberty: exhaust an enemy unit and return its upgrades that cost 4 or less', targets, { ai, source: self.def.id })
  if (!pick) return
  g.exhaust(pick)
  for (const upgrade of g.unit(pick)?.upgrades.filter((u) => g.def(u).cost <= 4) ?? []) g.upgradeToHand(upgrade.id)
}

// Princess Leia's When Played and On Attack: up to 2 units in one arena, costing 4 or less
// together. The AI exhausts ready enemies, the strongest pair it can.
function leiaDistraction(g: Game, self: Self) {
  const p = self.controller
  const ready = enemy(g, self, (u) => !u.exhausted && g.cost(u) <= 4)
  let plan: string[] = []
  let planPower = -1
  for (const a of ready)
    for (const b of [undefined, ...ready]) {
      if (b === a) continue
      const ua = g.unit(a)!
      const ub = b ? g.unit(b)! : undefined
      if (ub && (ub.arena !== ua.arena || g.cost(ua) + g.cost(ub) > 4)) continue
      const power = g.power(ua) + (ub ? g.power(ub) : 0)
      if (power > planPower) [plan, planPower] = [b ? [a, b] : [a], power]
    }
  const first = g.chooseOne(p, 'Princess Leia: you may exhaust a unit (up to 2 in one arena, combined cost 4 or less)', all(g, (u) => g.cost(u) <= 4), {
    optional: true,
    ai: plan[0] ?? null,
    source: self.def.id,
  })
  if (!first) return
  const one = g.unit(first)!
  const left = 4 - g.cost(one)
  const second = g.chooseOne(p, 'Princess Leia: you may exhaust another unit in that arena', all(g, (u) => u.id !== first && u.arena === one.arena && g.cost(u) <= left), {
    optional: true,
    ai: plan[1] ?? null,
    source: self.def.id,
  })
  g.exhaust(first)
  if (second) g.exhaust(second)
}

export const swuScripts: (CardScript & { card: string })[] = [
  // --- Veiled Icons Mace (swudb.com/deck/bzfAdNnzUAHd) ---
  {
    card: 'swu-IC27-004',
    name: 'Mace Windu',
    subtitle: 'Here With Backup',
    text: '[Action [[1], Arrow]:] Attack with a unit. It gains [Restore 2] for this attack.',
    backText: '[Restore 2]\n[When Deployed:] Resource the top card of your deck.',
    front: {
      actions: [
        {
          label: 'attack with a unit, Restore 2',
          resources: 1,
          exhaust: true,
          can: (g, self) => friendly(g, self, (u) => g.canAttack(u.id)).length > 0,
          run: (g, self) => {
            const pick = g.chooseOne(self.controller, 'Mace Windu: attack with a unit; it gains Restore 2', friendly(g, self, (u) => g.canAttack(u.id)), { ai: 'help', source: self.def.id })
            if (!pick) return
            g.grant(pick, { restore: 2 }, 'attack')
            g.attackWith(pick)
          },
        },
      ],
    },
    back: {
      whenDeployed: (g, self) => g.resourceFromDeck(self.controller),
    },
  },
  {
    card: 'swu-LAW-039',
    name: 'Latts Razzi',
    subtitle: 'Deadly Whipmaster',
    text: '[When Played:] Give a Shield token or an Experience token to this unit. Then, she deals damage equal to her power to an enemy ground unit.',
    front: {
      whenPlayed: (g, self) => {
        const p = self.controller
        // The AI takes Experience: one more damage now and later
        const pick = g.option(p, 'Latts Razzi: give this unit', ['an Experience token', 'a Shield token'], { ai: 0, source: self.def.id })
        g.giveToken(self.id, pick === 0 ? 'Experience' : 'Shield')
        const me = g.unit(self.id)
        if (!me) return
        const target = g.chooseOne(p, `Latts Razzi: deal ${g.power(me)} damage to an enemy ground unit`, enemy(g, self, (u) => u.arena === 'ground'), { ai: 'harm', source: self.def.id })
        if (target) g.damage(target, g.power(me), self)
      },
    },
  },
  {
    card: 'swu-LOF-100',
    name: 'Kelleran Beq',
    subtitle: 'The Sabered Hand',
    text: '[When Played:] Search the top 7 cards of your deck for a unit, reveal it, and play it. It costs [3] less.',
    front: {
      whenPlayed: (g, self) => {
        const p = self.controller
        const top = g.top(p, 7)
        const units = top.filter((c) => g.def(c).type === 'unit' && g.canPlay(p, c.id, { discount: 3 })).map((c) => c.id)
        const pick = g.chooseOne(p, 'Kelleran Beq: a unit from the top 7 cards of your deck to play for 3 less', units, { ai: 'best', source: self.def.id, seen: top.map((c) => c.id) })
        if (pick) {
          g.reveal(p, [pick], self)
          g.playCard(p, pick, { discount: 3 })
        } else g.log('Kelleran Beq finds no unit to play', p)
        g.shuffleToBottom(p, top.filter((c) => c.id !== pick && g.player(p).deck.some((d) => d.id === c.id)).map((c) => c.id))
      },
    },
  },
  {
    card: 'swu-IC27-079',
    name: 'Qui-Gon Jinn',
    subtitle: 'Unwavering Belief',
    text: '[Sentinel]\n[When Played:] Give another friendly unit +2/+2 for this phase.',
    front: {
      whenPlayed: (g, self) => {
        const pick = g.chooseOne(self.controller, 'Qui-Gon Jinn: another friendly unit gets +2/+2 for this phase', friendly(g, self, (u) => u.id !== self.id), { ai: 'help', source: self.def.id })
        if (pick) g.buff(pick, 2, 2, 'phase')
      },
    },
  },
  {
    card: 'swu-IC27-039',
    name: 'Ahsoka Tano',
    subtitle: 'Not on My Death Watch',
    text: '[When Played:] You may defeat a unit that costs 3 or less.',
    front: {
      whenPlayed: (g, self) => {
        const ids = all(g, (u) => !g.isLeader(u) && g.cost(u) <= 3)
        const pick = g.chooseOne(self.controller, 'Ahsoka Tano: you may defeat a unit that costs 3 or less', ids, { optional: true, ai: 'harm', source: self.def.id })
        if (pick) g.defeat(pick, self)
      },
    },
  },
  {
    card: 'swu-SEC-051',
    name: 'Bo-Katan Kryze',
    subtitle: 'Alone',
    text: '[When Played:] Give each enemy unit -3/-3 for this phase.\n[When an enemy unit is defeated:] Give an Experience token to a friendly unit.',
    front: {
      whenPlayed: (g, self) => {
        for (const id of enemy(g, self)) g.buff(id, -3, -3, 'phase')
        g.log('Bo-Katan Kryze: each enemy unit gets -3/-3 for this phase', self.controller)
      },
      whenEnemyDefeated: (g, self) => {
        if (!g.unit(self.id)) return
        const pick = g.chooseOne(self.controller, 'Bo-Katan Kryze: give an Experience token to a friendly unit', friendly(g, self), { ai: 'help', source: self.def.id })
        if (pick) g.giveToken(pick, 'Experience')
      },
    },
  },
  {
    card: 'swu-HMW-038',
    name: 'Bestial Bond',
    text: '[When Played:] If attached unit is a [{Creature}] or a [{Force}] unit, create a Beast token.',
    front: {
      whenPlayed: (g, self) => {
        // An upgrade's When Played names its unit as other
        const unit = self.other ? g.unit(self.other) : undefined
        if (unit && (g.hasTrait(unit, 'Creature') || g.hasTrait(unit, 'Force'))) g.createToken(self.controller, 'Beast')
      },
    },
  },
  {
    card: 'swu-HMW-035',
    name: 'Hunter',
    subtitle: 'Everyone Get to Cover!',
    text: "[When Played:] Choose two. You may choose the same option more than once:\n• Give a Shield token to a unit.\n• Attack with a unit, even if it's exhausted. It can't attack bases for this attack.",
    front: {
      whenPlayed: (g, self) => {
        const p = self.controller
        for (let i = 0; i < 2; i++) {
          const attackers = friendly(g, self, (u) => g.canAttack(u.id, { exhausted: true, noBases: true }))
          // The AI attacks when an attack is there (a unit to hit), shields otherwise
          const pick = g.option(p, `Hunter: choose ${i ? 'the second' : 'one'}`, ['Give a Shield token to a unit', 'Attack with a unit, even if exhausted (not bases)'], { ai: attackers.length ? 1 : 0, source: self.def.id })
          if (pick === 0) {
            const unit = g.chooseOne(p, 'Hunter: give a Shield token to a unit', all(g), { ai: 'help', source: self.def.id })
            if (unit) g.giveToken(unit, 'Shield')
          } else {
            const unit = g.chooseOne(p, 'Hunter: attack with a unit, even if exhausted; not a base', attackers, { ai: 'help', source: self.def.id })
            if (unit) g.attackWith(unit, { exhausted: true, noBases: true })
          }
        }
      },
    },
  },
  {
    card: 'swu-SEC-098',
    name: 'Captain Typho',
    subtitle: 'All Necessary Precautions',
    text: '[Sentinel]\n[When this unit is attacked:] You may disclose [Command][Heroism]. If you do, heal 1 damage from your base.',
    front: {
      whenDefending: (g, self) => {
        if (g.player(self.controller).base.damage > 0 && disclose(g, self, ['Command', 'Heroism'])) g.heal(baseOf(self.controller), 1, self)
      },
    },
  },
  {
    card: 'swu-IC27-081',
    name: 'Mace Windu',
    subtitle: 'Dropping By',
    text: '[Ambush]\n[On Attack:] Give an Experience token to this unit.',
    front: {
      onAttack: (g, self) => g.giveToken(self.id, 'Experience'),
    },
  },
  {
    card: 'swu-ASH-056',
    name: 'Huyang',
    subtitle: 'Your Aptitude Falls Short',
    text: '[On Attack:] You may give an upgraded unit -4/-0 for this phase.',
    front: {
      onAttack: (g, self) => {
        const pick = g.chooseOne(self.controller, 'Huyang: you may give an upgraded unit -4/-0 for this phase', all(g, (u) => u.upgrades.length > 0), { optional: true, ai: 'harm', source: self.def.id })
        if (pick) g.buff(pick, -4, 0, 'phase')
      },
    },
  },
  {
    card: 'swu-HMW-151',
    name: 'Overgrowth',
    text: 'If you control a [{Kashyyyk}] base, a friendly unit deals damage equal to its power to an enemy unit.\nResource this card.',
    front: {
      toResources: true,
      play: (g, self) => {
        const p = self.controller
        if (!g.def(g.player(p).base).traits.includes('Kashyyyk')) return
        const from = g.chooseOne(p, 'Overgrowth: a friendly unit deals damage equal to its power', friendly(g, self, (u) => g.power(u) > 0), { ai: 'best', source: self.def.id })
        const unit = from ? g.unit(from) : undefined
        if (!unit) return
        const to = g.chooseOne(p, `Overgrowth: ${g.name(unit.id)} deals ${g.power(unit)} damage to an enemy unit`, enemy(g, self), { ai: 'harm', source: self.def.id })
        if (to) g.damage(to, g.power(unit), { id: unit.id, controller: p, def: g.def(unit) })
      },
    },
  },
  {
    card: 'swu-LOF-096',
    name: 'Obi-Wan Kenobi',
    subtitle: 'Protective Padawan',
    text: '[When you play a [{Force}] unit:] This unit gains [Sentinel] for this phase.',
    front: {
      // "(including this one)": his own When Played, and the other Force units played after him
      whenPlayed: (g, self) => g.grant(self.id, { sentinel: true }, 'phase'),
      triggersIf: { whenYouPlay: (_g, self) => !!self.otherDef && self.otherDef.type === 'unit' && self.otherDef.traits.includes('Force') },
      whenYouPlay: (g, self) => {
        if (g.unit(self.id)) g.grant(self.id, { sentinel: true }, 'phase')
      },
    },
  },
  {
    card: 'swu-SEC-094',
    name: 'Mina Bonteri',
    subtitle: 'Stop This War',
    text: '[Restore 1]\n[When Defeated:] You may disclose [Command][Command][Heroism]. If you do, draw a card.',
    front: {
      whenDefeated: (g, self) => {
        if (disclose(g, self, ['Command', 'Command', 'Heroism'])) g.draw(self.controller, 1)
      },
    },
  },
  {
    card: 'swu-ASH-109',
    name: 'T-6 Shuttle 1974',
    subtitle: "With a Mentor's Dedication",
    text: '[Sentinel]\n[Action [Arrow]:] Give another unit +2/+2 for this phase. You may attack with that unit.',
    front: {
      actions: [
        {
          label: 'another unit +2/+2, then it may attack',
          exhaust: true,
          can: (g, self) => friendly(g, self, (u) => u.id !== self.id).length > 0,
          run: (g, self) => {
            const p = self.controller
            const pick = g.chooseOne(p, 'T-6 Shuttle 1974: another unit gets +2/+2 for this phase', all(g, (u) => u.id !== self.id), { ai: 'help', source: self.def.id })
            if (!pick) return
            g.buff(pick, 2, 2, 'phase')
            const unit = g.unit(pick)
            if (unit && g.controller(unit) === p && g.canAttack(pick) && g.may(p, `T-6 Shuttle 1974: attack with ${g.name(pick)}?`, { yes: 'Attack', no: 'Skip', source: self.def.id })) g.attackWith(pick)
          },
        },
      ],
    },
  },
  {
    card: 'swu-LAW-133',
    name: 'Lost and Forgotten',
    text: 'Defeat a non-leader unit. If you do, heal 3 damage from your base.',
    front: {
      play: (g, self) => {
        const pick = g.chooseOne(self.controller, 'Lost and Forgotten: defeat a non-leader unit', all(g, (u) => !g.isLeader(u)), { ai: 'harm', source: self.def.id })
        if (!pick) return
        g.defeat(pick, self)
        if (!g.unit(pick)) g.heal(baseOf(self.controller), 3, self)
      },
    },
  },
  {
    card: 'swu-LAW-041',
    name: 'Nothing Left to Fear',
    text: 'Choose a friendly unit and give it +2/+2 for this phase. Then, you may defeat a non-leader unit with power equal to or less than the chosen unit.',
    front: {
      play: (g, self) => {
        const p = self.controller
        const chosen = g.chooseOne(p, 'Nothing Left to Fear: a friendly unit gets +2/+2 for this phase', friendly(g, self), { ai: 'best', source: self.def.id })
        if (!chosen) return
        g.buff(chosen, 2, 2, 'phase')
        const unit = g.unit(chosen)
        if (!unit) return
        const power = g.power(unit)
        const pick = g.chooseOne(p, `Nothing Left to Fear: you may defeat a non-leader unit with ${power} or less power`, all(g, (u) => !g.isLeader(u) && g.power(u) <= power), { optional: true, ai: 'harm', source: self.def.id })
        if (pick) g.defeat(pick, self)
      },
    },
  },
  {
    card: 'swu-JTL-096',
    name: 'Blue Leader',
    subtitle: 'Scarif Air Support',
    text: '[Ambush]\n[When Played:] You may pay [2]. If you do, move this unit to the ground arena and give 2 Experience tokens to it.',
    front: {
      whenPlayed: (g, self) => {
        const p = self.controller
        if (!g.canPay(p, 2)) return
        if (!g.may(p, 'Blue Leader: pay 2 to move this unit to the ground arena with 2 Experience tokens?', { yes: 'Pay 2', no: 'Stay in space', source: self.def.id })) return
        if (!g.pay(p, 2)) return
        g.moveToArena(self.id, 'ground')
        g.giveToken(self.id, 'Experience', 2)
      },
    },
  },

  // --- Kenobi Yellow Force (swudb.com/deck/opbvFQxqLay) ---
  {
    card: 'swu-LOF-008',
    name: 'Obi-Wan Kenobi',
    subtitle: 'Courage Makes Heroes',
    text: '[Action [Arrow, use the Force]:] Give an Experience token to a unit without an Experience token on it.',
    backText: '[On Attack:] You may give an Experience token to another unit without an Experience token on it.',
    front: {
      actions: [
        {
          label: 'use the Force: an Experience token',
          exhaust: true,
          can: (g, self) => g.hasForce(self.controller) && all(g, (u) => !hasExperience(g, u)).length > 0,
          run: (g, self) => {
            if (!g.useForce(self.controller)) return
            const ids = all(g, (u) => !hasExperience(g, u))
            const pick = g.chooseOne(self.controller, 'Obi-Wan Kenobi: give an Experience token to a unit without one', ids, { ai: 'help', source: self.def.id })
            if (pick) g.giveToken(pick, 'Experience')
          },
        },
      ],
    },
    back: {
      onAttack: (g, self) => {
        const ids = all(g, (u) => u.id !== self.id && !hasExperience(g, u))
        const pick = g.chooseOne(self.controller, 'Obi-Wan Kenobi: you may give an Experience token to another unit without one', ids, {
          optional: true,
          ai: 'help',
          source: self.def.id,
        })
        if (pick) g.giveToken(pick, 'Experience')
      },
    },
  },
  {
    card: 'swu-LOF-029',
    name: 'Crystal Caves',
    text: '[When a friendly [{Force}] unit attacks:] The [{Force}] is with you.',
    front: {
      triggersIf: {
        whenFriendlyAttacks: (g, self) => {
          const unit = self.other ? g.unit(self.other) : undefined
          return !!unit && g.hasTrait(unit, 'Force') && !g.hasForce(self.controller)
        },
      },
      whenFriendlyAttacks: (g, self) => g.forceIsWith(self.controller),
    },
  },
  {
    card: 'swu-ASH-114',
    name: "Sabine's Lightsaber",
    subtitle: 'Not Alone',
    text: 'Attach to a non-[{Vehicle}] unit.\nIf attached unit is Sabine Wren or a [{Force}] unit, it gains [Restore 2].',
    front: {
      gives: (g, self, unit) =>
        unit.id === self.attachedTo && (g.def(unit).name === 'Sabine Wren' || g.hasTrait(unit, 'Force')) ? { keywords: { restore: 2 } } : undefined,
    },
  },
  {
    card: 'swu-ASH-222',
    name: 'Unsanctioned Patrol',
    text: '[Support]\n[Saboteur]',
    front: {
      whenPlayed: (g, self) => support(g, self, { keywords: { saboteur: true } }),
    },
  },
  {
    card: 'swu-SEC-233',
    name: 'Beguile',
    text: "Look at an opponent's hand. Then, choose a non-leader unit that opponent controls that costs 6 or less and return it to its owner's hand.",
    front: {
      play: (g, self) => {
        const p = self.controller
        const hand = g.player(g.other(p)).hand.map((c) => c.id)
        const ids = enemy(g, self, (u) => !g.isLeader(u) && g.cost(u) <= 6)
        // Their hand is shown with the question
        const pick = g.chooseOne(p, "Beguile: return a non-leader enemy unit that costs 6 or less to its owner's hand", ids, {
          ai: 'harm',
          source: self.def.id,
          seen: hand,
        })
        if (pick) g.returnToHand(pick)
      },
    },
  },
  {
    card: 'swu-LOF-111',
    name: 'Maz Kanata',
    subtitle: 'The Light Guides',
    text: '[When Played:] You may attack with a [{Force}] unit. It gets [+2/+0] for this attack.',
    front: {
      whenPlayed: (g, self) => {
        const ids = friendly(g, self, (u) => g.hasTrait(u, 'Force') && g.canAttack(u.id))
        const pick = g.chooseOne(self.controller, 'Maz Kanata: you may attack with a Force unit; it gets +2/+0', ids, { optional: true, ai: 'help', source: self.def.id })
        if (pick) g.attackWith(pick, { power: 2 })
      },
    },
  },
  {
    card: 'swu-HMW-048',
    name: 'Vernestra Rwoh',
    subtitle: 'We Should Handle This Ourselves',
    text: '[Sentinel]\nAs an additional cost to play this unit, put up to 2 units that each cost 5 or less from your discard pile on the bottom of your deck. This unit gains those units\' ["When Played"] abilities for this phase.',
    front: {
      // Read as she is played: the units chosen go under the deck, and their When Played
      // abilities resolve as hers
      whenPlayed: (g, self) => {
        const p = self.controller
        const ids = g
          .player(p)
          .discard.filter((c) => g.def(c).type === 'unit' && g.def(c).cost <= 5)
          .map((c) => c.id)
        const picks = g.choose(p, 'Vernestra Rwoh: up to 2 units that cost 5 or less from your discard pile to the bottom of your deck', ids, {
          min: 0,
          max: 2,
          ai: 'best',
          source: self.def.id,
        })
        const gained = picks.map((id) => g.def(g.card(id)!))
        for (const id of picks) g.discardToBottom(p, id)
        for (const d of gained) {
          const whenPlayed = abilitiesOf(d, 'front').whenPlayed
          if (!whenPlayed || !g.unit(self.id)) continue
          g.log(`Vernestra Rwoh uses ${d.name}'s When Played`, p)
          whenPlayed(g, self)
        }
      },
    },
  },
  {
    card: 'swu-LOF-193',
    name: 'Youngling Padawan',
    text: '[When Played:] The Force is with you.',
    front: {
      whenPlayed: (g, self) => g.forceIsWith(self.controller),
    },
  },
  {
    card: 'swu-SEC-101',
    name: 'Queen Amidala',
    subtitle: 'Championing Her People',
    text: '[When Played:] Create 2 Spy tokens.\nIf damage would be dealt to this unit, you may defeat another friendly unit that shares a trait with this unit. If you do, prevent that damage.',
    front: {
      whenPlayed: (g, self) => {
        g.createToken(self.controller, 'Spy')
        g.createToken(self.controller, 'Spy')
      },
      preventsDamage: (g, self, amount) => {
        const me = g.unit(self.id)
        if (!me) return false
        const traits = g.def(me).traits
        const ids = friendly(g, self, (u) => u.id !== self.id && g.def(u).traits.some((t) => traits.includes(t)))
        if (!ids.length) return false
        // The AI does when the damage would defeat her, or is 3 or more
        const worth = me.damage + amount >= g.hp(me) || amount >= 3
        const text = `Queen Amidala: you may defeat another friendly unit that shares a trait with her, to prevent ${amount} damage to her`
        const pick = worth ? g.chooseOne(self.controller, text, ids, { optional: true, ai: 'discard', source: self.def.id }) : null
        if (!pick) return false
        g.defeat(pick)
        g.log(`Queen Amidala: ${amount} damage prevented`, self.controller)
        return true
      },
    },
  },
  {
    card: 'swu-LAW-067',
    name: 'Jyn Erso',
    subtitle: 'Take the Next Chance',
    text: '[When Played:] Either give an Experience token to a unit or exhaust a unit.',
    front: {
      whenPlayed: (g, self) => {
        const p = self.controller
        const ready = enemy(g, self, (u) => !u.exhausted)
        const pick = g.option(p, 'Jyn Erso: either', ['Give an Experience token to a unit', 'Exhaust a unit'], { ai: ready.length ? 1 : 0, source: self.def.id })
        if (pick === 0) {
          const unit = g.chooseOne(p, 'Jyn Erso: give an Experience token to a unit', all(g), { ai: 'help', source: self.def.id })
          if (unit) g.giveToken(unit, 'Experience')
        } else {
          const unit = g.chooseOne(p, 'Jyn Erso: exhaust a unit', all(g, (u) => !u.exhausted), { ai: 'harm', source: self.def.id })
          if (unit) g.exhaust(unit)
        }
      },
    },
  },
  {
    card: 'swu-HMW-124',
    name: 'Luminara Unduli',
    subtitle: 'Besieged General',
    text: '[When you play a unit:] You may attack with a unit. It gets +2/+0 for this attack.',
    front: {
      triggersIf: { whenYouPlay: (_g, self) => self.otherDef?.type === 'unit' },
      whenYouPlay: (g, self) => {
        if (!g.unit(self.id)) return
        const ids = friendly(g, self, (u) => g.canAttack(u.id))
        const pick = g.chooseOne(self.controller, 'Luminara Unduli: you may attack with a unit; it gets +2/+0', ids, { optional: true, ai: 'help', source: self.def.id })
        if (pick) g.attackWith(pick, { power: 2 })
      },
    },
  },
  {
    card: 'swu-HMW-210',
    name: 'Sol',
    subtitle: 'Compassionate Guardian',
    text: '[Shielded]\n[On Attack:] This unit gains [Sentinel] for this phase.',
    front: {
      onAttack: (g, self) => g.grant(self.id, { sentinel: true }, 'phase'),
    },
  },
  {
    card: 'swu-LOF-195',
    name: 'Vernestra Rwoh',
    subtitle: 'Precocious Knight',
    text: '[When Played:] You may use the Force. If you do, ready this unit.',
    front: {
      whenPlayed: (g, self) => {
        const p = self.controller
        if (!g.hasForce(p) || !g.may(p, 'Vernestra Rwoh: use the Force to ready her?', { yes: 'Use the Force', no: 'Keep it', source: self.def.id })) return
        if (g.useForce(p)) g.ready(self.id)
      },
    },
  },
  {
    card: 'swu-HMW-208',
    name: 'Luke Skywalker',
    subtitle: 'Dreaming Farmboy',
    text: "[Raid 1]\nWhile it's the first round of the game, this unit enters play ready.",
    front: {
      whenPlayed: (g, self) => {
        if (g.state.round === 1) g.ready(self.id)
      },
    },
  },
  {
    card: 'swu-LAW-168',
    name: 'Haymaker',
    text: 'Give an Experience token to a friendly unit. That unit deals damage equal to its power to an enemy unit in the same arena.',
    front: {
      play: (g, self) => {
        const p = self.controller
        const from = g.chooseOne(p, 'Haymaker: give an Experience token to a friendly unit', friendly(g, self), { ai: 'best', source: self.def.id })
        if (!from) return
        g.giveToken(from, 'Experience')
        const unit = g.unit(from)
        if (!unit) return
        const ids = enemy(g, self, (u) => u.arena === unit.arena)
        const to = g.chooseOne(p, `Haymaker: ${g.name(from)} deals ${g.power(unit)} damage to an enemy unit in its arena`, ids, { ai: 'harm', source: self.def.id })
        if (to) g.damage(to, g.power(unit), { id: from, controller: p, def: g.def(unit) })
      },
    },
  },
  {
    card: 'swu-LOF-227',
    name: 'The Will of the Force',
    text: "Return a non-leader unit to its owner's hand. You may use the Force. If you do, that player discards a random card from their hand.",
    front: {
      play: (g, self) => {
        const p = self.controller
        const pick = g.chooseOne(p, "The Will of the Force: return a non-leader unit to its owner's hand", all(g, (u) => !g.isLeader(u)), {
          ai: 'harm',
          source: self.def.id,
        })
        if (!pick) return
        const owner = g.unit(pick)!.owner
        g.returnToHand(pick)
        if (!g.hasForce(p)) return
        // The AI makes only an opponent discard
        const text = 'The Will of the Force: use the Force to have that player discard a random card?'
        if (g.may(p, text, { yes: 'Use the Force', no: 'Keep it', ai: owner !== p, source: self.def.id }) && g.useForce(p)) g.discardRandom(owner)
      },
    },
  },
  {
    card: 'swu-ASH-253',
    name: 'Yellow Aces Bomber',
    text: '[Support]\n[On Attack:] If this unit is upgraded, deal 2 damage to a base.',
    front: {
      whenPlayed: (g, self) => support(g, self, { onAttack: bomberAttack, prefer: (u) => u.upgrades.length > 0 }),
      onAttack: bomberAttack,
    },
  },
  // --- Wicket Green (swudb.com/deck/hcNlcrHdrlgn) ---
  {
    card: "swu-HMW-014",
    name: "Wicket",
    subtitle: "Few Greater Battles to Fight",
    text: "[When a friendly unit attacks a unit that costs more than it:] You may exhaust this leader. If you do, draw a card.",
    backText: "[On Attack:] If you control a unit that costs 3 or less, draw a card.",
    front: {
      // "When a friendly unit attacks a unit that costs more than it:" (the attacker's cost)
      triggersIf: {
        whenFriendlyAttacks: (g, self) => {
          const target = self.attack?.target
          const attacker = self.attack && g.unit(self.attack.attacker)
          const defender = target && target !== 'base' ? g.unit(target) : undefined
          return !!attacker && !!defender && g.cost(defender) > g.cost(attacker) && g.leaderReady(self.controller)
        },
      },
      whenFriendlyAttacks: (g, self) => {
        const p = self.controller
        if (!g.leaderReady(p)) return
        if (!g.may(p, 'Wicket: exhaust this leader to draw a card?', { yes: 'Exhaust and draw', no: 'Skip', ai: true, source: self.def.id })) return
        g.exhaustLeader(p)
        g.draw(p, 1)
      },
    },
    back: {
      onAttack: (g, self) => {
        if (friendly(g, self, (u) => g.cost(u) <= 3).length) g.draw(self.controller, 1)
      },
    },
  },
  {
    card: "swu-JTL-153",
    name: "Rebellious Hammerhead",
    text: "[When Played:] You may deal damage to a unit equal to the number of cards in your hand.",
    front: {
      whenPlayed: (g, self) => {
        const amount = g.player(self.controller).hand.length
        if (!amount) return
        const pick = g.chooseOne(self.controller, `Rebellious Hammerhead: you may deal ${amount} damage to a unit`, all(g), { optional: true, ai: 'harm', source: self.def.id })
        if (pick) g.damage(pick, amount, self)
      },
    },
  },
  {
    card: "swu-JTL-250",
    name: "Sabine's Masterpiece",
    subtitle: "Crazy Colorful",
    text: "[On Attack:] If you control a:\n• {Vigilance} unit, heal 2 damage from a base.\n• {Command} unit, give an Experience token to a unit.\n• {Aggression} unit, deal 1 damage to a unit or base.\n• {Cunning} unit, exhaust or ready a resource.",
    front: {
      onAttack: (g, self) => {
        const p = self.controller
        const has = (aspect: Aspect) => friendly(g, self, (u) => g.def(u).aspects.includes(aspect)).length > 0
        if (has('Vigilance')) {
          const pick = g.chooseOne(p, "Sabine's Masterpiece: heal 2 damage from a base", [baseOf(0), baseOf(1)], { ai: baseOf(p), source: self.def.id })
          if (pick) g.heal(pick, 2, self)
        }
        if (has('Command')) {
          const pick = g.chooseOne(p, "Sabine's Masterpiece: give an Experience token to a unit", all(g), { ai: 'help', source: self.def.id })
          if (pick) g.giveToken(pick, 'Experience')
        }
        if (has('Aggression')) {
          const pick = g.chooseOne(p, "Sabine's Masterpiece: deal 1 damage to a unit or base", [...all(g), baseOf(0), baseOf(1)], { ai: 'harm', source: self.def.id })
          if (pick) g.damage(pick, 1, self)
        }
        if (has('Cunning')) {
          // Ready one of its own exhausted resources, or else exhaust one of the opponent's
          const own = g.player(p).resources.find((r) => r.exhausted)
          const theirs = g.player(g.other(p)).resources.find((r) => !r.exhausted)
          if (own) {
            own.exhausted = false
            g.log("Sabine's Masterpiece readies a resource", p)
          } else if (theirs) {
            theirs.exhausted = true
            g.log("Sabine's Masterpiece exhausts an enemy resource", p)
          }
        }
      },
    },
  },
  {
    card: "swu-HMW-126",
    name: "Verdant Fortress",
    text: "[Fortify]\nAttached base gains: \"Friendly units gain [Raid 1] \"",
    front: {
      // On its base: friendly units gain Raid 1
      gives: (g, self, unit) => (g.controller(unit) === self.controller ? { keywords: { raid: 1 } } : undefined),
    },
  },
  {
    card: "swu-SEC-163",
    name: "Outer Rim Constable",
    text: "[When Played:] You may defeat an upgrade.",
    front: {
      whenPlayed: (g, self) => {
        const ups = g.upgrades()
        if (!ups.length) return
        // The AI defeats an enemy's upgrade, a card before a token
        const theirs = ups.filter((u) => u.controller !== self.controller).sort((a, b) => Number(!!g.def(a).token) - Number(!!g.def(b).token))
        const pick = g.chooseOne(self.controller, 'Outer Rim Constable: you may defeat an upgrade', ups.map((u) => u.id), { optional: true, ai: theirs[0]?.id ?? 'harm', source: self.def.id })
        if (pick) g.defeatUpgrade(pick)
      },
    },
  },
  {
    card: "swu-HMW-130",
    name: "Emerie Karr",
    subtitle: "For Your Own Good",
    text: "[When Played:] You may deal 1 damage to another ground unit. If you control that unit, the next unit you play this phase costs [1] less.",
    front: {
      whenPlayed: (g, self) => {
        const ground = all(g, (u) => u.id !== self.id && u.arena === 'ground')
        const pick = g.chooseOne(self.controller, 'Emerie Karr: you may deal 1 damage to another ground unit', ground, { optional: true, ai: 'harm', source: self.def.id })
        if (!pick) return
        const mine = g.controller(g.unit(pick)!) === self.controller
        g.damage(pick, 1, self)
        if (mine) g.discountNext(self.controller, ':unit', 1)
      },
    },
  },
  {
    card: "swu-HMW-118",
    name: "Ryyk Blademaster",
    text: "While you control 6 or more resources, this unit gains [Ambush] and [Overwhelm].",
    front: {
      gives: (g, self, unit) =>
        unit.id === self.id && g.player(self.controller).resources.length >= 6 ? { keywords: { ambush: true, overwhelm: true } } : undefined,
    },
  },
  {
    card: "swu-SEC-104",
    name: "Figure of Unity",
    text: "Attach to a [{Unique}] unit.\nAttached unit gains: \"While this unit is ready, each other friendly unit gains [Overwhelm], [Raid 1], and [Restore 1].\"",
    front: {
      // While the unit it is on is ready, each other friendly unit gains Overwhelm, Raid 1 and Restore 1
      gives: (g, self, unit) => {
        const host = self.attachedTo ? g.unit(self.attachedTo) : undefined
        if (!host || host.exhausted || unit.id === host.id || g.controller(unit) !== g.controller(host)) return undefined
        return { keywords: { overwhelm: true, raid: 1, restore: 1 } }
      },
    },
  },
  {
    card: "swu-ASH-034",
    name: "Wicket",
    subtitle: "Yub Nub!",
    text: "[Saboteur]\nThis unit can't attack bases.",
    front: { cantAttackBases: true },
  },
  {
    card: "swu-HMW-193",
    name: "Nightfall",
    text: "Deal 1 damage to an enemy unit.\nIf you control an [{Endor}] base, you may attack with a unit. It gets +2/+0 for this attack.",
    front: {
      play: (g, self) => {
        const p = self.controller
        const hit = g.chooseOne(p, 'Nightfall: deal 1 damage to an enemy unit', enemy(g, self), { ai: 'harm', source: self.def.id })
        if (hit) g.damage(hit, 1, self)
        if (!g.def(g.player(p).base).traits.includes('Endor')) return
        const pick = g.chooseOne(p, 'Nightfall: you may attack with a unit; it gets +2/+0', friendly(g, self, (u) => g.canAttack(u.id)), { optional: true, ai: 'help', source: self.def.id })
        if (pick) g.attackWith(pick, { power: 2 })
      },
    },
  },
  {
    card: "swu-HMW-177",
    name: "Adamant Ewoks",
    text: "[When Played:] If you control another [{Ewok}] unit or an [{Endor}] base, you may deal 1 damage to a base and 1 damage to an enemy unit.",
    front: {
      whenPlayed: (g, self) => {
        const p = self.controller
        const ewok = friendly(g, self, (u) => u.id !== self.id && g.hasTrait(u, 'Ewok')).length > 0
        if (!ewok && !g.def(g.player(p).base).traits.includes('Endor')) return
        if (!g.may(p, 'Adamant Ewoks: deal 1 damage to a base and 1 damage to an enemy unit?', { yes: 'Deal the damage', no: 'Skip', ai: true, source: self.def.id })) return
        const base = g.chooseOne(p, 'Adamant Ewoks: deal 1 damage to a base', [baseOf(0), baseOf(1)], { ai: baseOf(g.other(p)), source: self.def.id })
        if (base) g.damage(base, 1, self)
        const unit = g.chooseOne(p, 'Adamant Ewoks: deal 1 damage to an enemy unit', enemy(g, self), { ai: 'harm', source: self.def.id })
        if (unit) g.damage(unit, 1, self)
      },
    },
  },
  {
    card: "swu-ASH-168",
    name: "Migs Mayfeld",
    subtitle: "How About a Toast?",
    text: "[Support]\n[On Attack:] Deal 1 damage to the defending unit. If this unit is upgraded, deal 2 damage to the defending unit instead.",
    front: {
      whenPlayed: (g, self) => support(g, self, { onAttack: migsAttack }),
      onAttack: migsAttack,
    },
  },
  {
    card: "swu-JTL-151",
    name: "Red Five",
    subtitle: "Running the Trench",
    text: "[On Attack:] You may deal 2 damage to a damaged unit.",
    front: {
      onAttack: (g, self) => {
        const pick = g.chooseOne(self.controller, 'Red Five: you may deal 2 damage to a damaged unit', all(g, (u) => u.damage > 0), { optional: true, ai: 'harm', source: self.def.id })
        if (pick) g.damage(pick, 2, self)
      },
    },
  },
  {
    card: "swu-HMW-045",
    name: "Logray",
    subtitle: "Bright Tree Shaman",
    text: "[When another friendly unit that costs 3 or less is dealt damage:] You may deal 1 damage to an enemy unit.",
    front: {
      triggersIf: {
        whenFriendlyDamaged: (g, self) => {
          const hurt = self.other ? g.unit(self.other) : undefined
          return !!hurt && hurt.id !== self.id && g.cost(hurt) <= 3 && enemy(g, self).length > 0
        },
      },
      whenFriendlyDamaged: (g, self) => {
        const pick = g.chooseOne(self.controller, 'Logray: you may deal 1 damage to an enemy unit', enemy(g, self), { optional: true, ai: 'harm', source: self.def.id })
        if (pick) g.damage(pick, 1, self)
      },
    },
  },
  {
    card: "swu-SEC-148",
    name: "Karis Nemik",
    subtitle: "Freedom Is a Pure Idea",
    text: "[Hidden]\n[When Defeated:] You may disclose [Aggression][Heroism]. If you do, create a Spy token and ready it.",
    front: {
      whenDefeated: (g, self) => {
        if (disclose(g, self, ['Aggression', 'Heroism'])) g.createToken(self.controller, 'Spy', { ready: true })
      },
    },
  },
  {
    card: "swu-HMW-115",
    name: "Leia Organa",
    subtitle: "These Are My Friends",
    text: "[When you play another unit that costs 3 or less:] Heal 1 damage from your base.",
    front: {
      triggersIf: { whenYouPlay: (_g, self) => self.otherDef?.type === 'unit' && self.otherDef.cost <= 3 },
      whenYouPlay: (g, self) => g.heal(baseOf(self.controller), 1, self),
    },
  },
  {
    card: "swu-ASH-163",
    name: "Reckless Sacrifice",
    text: "Discard a unit from your hand. Deal 5 damage to a unit that costs more than the discarded card.",
    front: {
      play: (g, self) => {
        const p = self.controller
        const units = g.player(p).hand.filter((c) => g.def(c).type === 'unit')
        if (!units.length) return
        // The AI discards its cheapest unit that leaves an enemy target
        const cheapest = [...units].sort((a, b) => g.def(a).cost - g.def(b).cost).find((c) => enemy(g, self, (u) => g.cost(u) > g.def(c).cost).length)
        const pick = g.chooseOne(p, 'Reckless Sacrifice: discard a unit from your hand', units.map((c) => c.id), { ai: (cheapest ?? units[0]).id, source: self.def.id })
        if (!pick) return
        const cost = g.def(g.player(p).hand.find((c) => c.id === pick)!).cost
        g.discard(p, pick)
        const target = g.chooseOne(p, 'Reckless Sacrifice: deal 5 damage to a unit that costs more', all(g, (u) => g.cost(u) > cost), { ai: 'harm', source: self.def.id })
        if (target) g.damage(target, 5, self)
      },
    },
  },
  // --- Veiled Icons Greef (swudb.com/deck/hVRtepYEKlM) ---
  {
    // The token Greef Karga gives: the engine defeats it as the unit's attack or defense ends
    card: 'swu-TASH-T02',
    name: 'Advantage',
    text: "[When attached unit's attack or defense ends:] Defeat this upgrade.",
    front: {},
  },
  {
    card: 'swu-ASH-017',
    name: 'Greef Karga',
    subtitle: 'Gracious Magistrate',
    text: '[When you play or create a unit:] You may exhaust this leader. If you do, give an Advantage token to that unit.',
    backText: '[When you play or create a unit:] Give an Advantage token to that unit.',
    front: {
      triggersIf: {
        whenYouPlay: (g, self) => !!self.other && !!g.unit(self.other) && g.leaderReady(self.controller),
        whenYouCreate: (g, self) => !!self.other && !!g.unit(self.other) && g.leaderReady(self.controller),
      },
      whenYouPlay: greefLeader,
      whenYouCreate: greefLeader,
      aiLater: { whenYouPlay: ambushFirst },
    },
    back: { whenYouPlay: greefUnit, whenYouCreate: greefUnit },
  },
  {
    card: 'swu-LAW-219',
    name: "Anakin's Podracer",
    subtitle: 'So Wizard!',
    text: '[Ambush]\nWhile attacking, if no other units have attacked this phase, this unit deals combat damage before the defending unit.',
    front: {
      // Its On Attack comes before combat damage: the first to attack this phase strikes first
      onAttack: (g, self) => {
        if (!g.attackedThisPhase().some((id) => id !== self.id)) g.grant(self.id, { firstStrike: true }, 'attack')
      },
    },
  },
  {
    card: 'swu-SEC-204',
    name: 'Blue Ace',
    subtitle: 'Colorful Racer',
    text: '[Ambush]\n[On Attack:] Ready an exhausted enemy unit.',
    front: {
      onAttack: (g, self) => {
        const exhausted = enemy(g, self, (u) => u.exhausted)
        if (!exhausted.length) return
        // The AI readies the enemy that can do the least with it
        const weakest = [...exhausted].sort((a, b) => g.power(g.unit(a)!) - g.power(g.unit(b)!))[0]
        const pick = g.chooseOne(self.controller, 'Blue Ace: ready an exhausted enemy unit', exhausted, { ai: weakest, source: self.def.id })
        if (pick) g.ready(pick)
      },
    },
  },
  {
    card: 'swu-TWI-224',
    name: 'Breaking In',
    text: 'Attack with a unit. It gets [+2/+0] and gains [Saboteur] for this attack.',
    front: {
      play: (g, self) => {
        const units = friendly(g, self, (u) => g.canAttack(u.id))
        const pick = g.chooseOne(self.controller, 'Breaking In: attack with a unit; it gets +2/+0 and Saboteur', units, { ai: 'help', source: self.def.id })
        if (!pick) return
        g.grant(pick, { saboteur: true }, 'attack')
        g.attackWith(pick, { power: 2 })
      },
    },
  },
  {
    card: 'swu-IC27-168',
    name: 'Cunning Ploy',
    text: "Look at an opponent's hand. You may discard a card from it. If you do, that player draws a card.\nExhaust an enemy unit.\nYou may attack with a unit. It gets +3/+0 for this attack.",
    front: {
      play: (g, self) => {
        const p = self.controller
        const foe = p === 0 ? 1 : 0
        const hand = g.player(foe).hand
        g.log(`${g.player(p).name} looks at ${g.player(foe).name}'s hand`, p)
        // The AI takes their dearest card
        const dearest = [...hand].sort((a, b) => g.def(b).cost - g.def(a).cost)[0]
        const discard = g.chooseOne(p, "Cunning Ploy: you may discard a card from your opponent's hand (they draw one)", hand.map((c) => c.id), {
          optional: true,
          ai: dearest?.id,
          source: self.def.id,
          seen: hand.map((c) => c.id),
        })
        if (discard) {
          g.discard(foe, discard)
          g.draw(foe, 1)
        }
        const target = g.chooseOne(p, 'Cunning Ploy: exhaust an enemy unit', enemy(g, self, (u) => !u.exhausted).length ? enemy(g, self, (u) => !u.exhausted) : enemy(g, self), {
          ai: 'harm',
          source: self.def.id,
        })
        if (target) g.exhaust(target)
        const attacker = g.chooseOne(p, 'Cunning Ploy: you may attack with a unit; it gets +3/+0', friendly(g, self, (u) => g.canAttack(u.id)), {
          optional: true,
          ai: 'help',
          source: self.def.id,
        })
        if (attacker) g.attackWith(attacker, { power: 3 })
      },
    },
  },
  {
    card: 'swu-SEC-211',
    name: 'Faith in Your Friends',
    text: 'Search the top 3 cards of your deck for a card and draw it. Then, you may disclose [Cunning][Cunning][Cunning][Heroism][Heroism]. If you do, create 2 Spy tokens.',
    front: {
      play: (g, self) => {
        searchDeck(g, self, 3, () => true, 'a card')
        if (disclose(g, self, ['Cunning', 'Cunning', 'Cunning', 'Heroism', 'Heroism'])) {
          g.createToken(self.controller, 'Spy')
          g.createToken(self.controller, 'Spy')
        }
      },
    },
  },
  {
    card: 'swu-IC27-155',
    name: 'Han Solo',
    subtitle: "Gamblin' Man",
    text: '[Saboteur]\n[When Played:] Search the top 10 cards of your deck for a card and draw it, then discard a random card from your hand.',
    front: {
      whenPlayed: (g, self) => {
        searchDeck(g, self, 10, () => true, 'a card')
        g.discardRandom(self.controller)
      },
    },
  },
  {
    card: 'swu-JTL-203',
    name: 'Han Solo',
    subtitle: 'Has His Moments',
    text: '[Ambush]',
    pilotText: "[Piloting] [[2 Cunning Heroism]]\n[When played as an upgrade:] You may attack with attached unit. If it's the Millennium Falcon, it deals its combat damage before the defender.",
    front: {},
    pilot: {
      whenPlayed: (g, self) => {
        const unit = self.attachedTo
        if (!unit || !g.canAttack(unit)) return
        if (!g.may(self.controller, `Han Solo: attack with ${g.name(unit)}?`, { yes: 'Attack', no: 'Skip', ai: true, source: self.def.id })) return
        g.attackWith(unit, { firstStrike: g.def(g.unit(unit)!).name === 'Millennium Falcon' })
      },
    },
  },
  {
    card: 'swu-ASH-206',
    name: 'Kelleran Beq',
    subtitle: 'Where are the Others?',
    text: '[Ambush]\nThis unit gets +1/+0 for each other unit with 0 power.',
    front: {
      gives: (g, self, unit) => {
        if (unit.id !== self.id) return undefined
        const zero = g.units((u) => u.id !== self.id && g.power(u) === 0).length
        return zero ? { power: zero } : undefined
      },
    },
  },
  {
    card: 'swu-LAW-224',
    name: 'Liberty',
    subtitle: 'Draw Their Fire!',
    text: '[Sentinel]\n[When Played/On Attack:] Exhaust an enemy unit and return all upgrades on it that cost 4 or less to their owner\'s hands.',
    front: { whenPlayed: liberty, onAttack: liberty },
  },
  {
    card: 'swu-SEC-207',
    name: 'Lightmaker',
    subtitle: 'I Have An Idea',
    text: '[Raid 4]\n[When Defeated:] Choose an arena. Exhaust each enemy unit in that arena.',
    front: {
      whenDefeated: (g, self) => {
        // The AI takes the arena where the ready enemies have the most power
        const ready = (arena: string) => enemy(g, self, (u) => u.arena === arena && !u.exhausted).reduce((sum, id) => sum + g.power(g.unit(id)!), 0)
        const pick = g.option(self.controller, 'Lightmaker: exhaust each enemy unit in an arena', ['Ground', 'Space'], {
          ai: ready('space') > ready('ground') ? 1 : 0,
          source: self.def.id,
        })
        const arena = pick === 1 ? 'space' : 'ground'
        for (const id of enemy(g, self, (u) => u.arena === arena)) g.exhaust(id)
      },
    },
  },
  {
    card: 'swu-IC27-165',
    name: 'Luke Skywalker',
    subtitle: 'Overplaying His Hand',
    text: "[When Played:] You may put an enemy non-leader unit on the bottom of its owner's deck. Its owner draws 2 cards.",
    front: {
      whenPlayed: (g, self) => {
        const targets = enemy(g, self, (u) => !g.isLeader(u))
        const pick = g.chooseOne(self.controller, "Luke Skywalker: you may put an enemy non-leader unit on the bottom of its owner's deck (they draw 2)", targets, {
          optional: true,
          ai: 'harm',
          source: self.def.id,
        })
        if (!pick) return
        const owner = g.unit(pick)!.owner
        g.toDeckBottom(pick)
        g.draw(owner, 2)
      },
    },
  },
  {
    card: 'swu-IC27-159',
    name: 'Princess Leia',
    subtitle: 'Calculated Distraction',
    text: '[When Played/On Attack:] Exhaust up to 2 units in the same arena with combined cost 4 or less.',
    front: { whenPlayed: leiaDistraction, onAttack: leiaDistraction },
  },
  {
    card: 'swu-ASH-208',
    name: 'Sabine Wren',
    subtitle: 'I Learned the Hard Way',
    text: '[Shielded]\n[When 1 or more upgrades attach to this unit:] You may exhaust a ground unit.',
    front: {
      whenUpgradeAttached: (g, self) => {
        const ground = all(g, (u) => u.arena === 'ground')
        const ready = enemy(g, self, (u) => u.arena === 'ground' && !u.exhausted)
        const strongest = [...ready].sort((a, b) => g.power(g.unit(b)!) - g.power(g.unit(a)!))[0]
        const pick = g.chooseOne(self.controller, 'Sabine Wren: you may exhaust a ground unit', ground, { optional: true, ai: strongest ?? null, source: self.def.id })
        if (pick) g.exhaust(pick)
      },
    },
  },
]
