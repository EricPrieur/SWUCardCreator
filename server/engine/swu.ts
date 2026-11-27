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

// Mando's N-1 Starfighter's On Attack: its own, or the one a unit it supports gains. The AI
// exhausts the leader while it isn't deployed (deploying doesn't need it ready), not a leader unit
function n1Attack(g: Game, self: Self) {
  const p = self.controller
  const leaderUnit = friendly(g, self, (u) => !!u.leader && !u.exhausted && u.id !== self.id)[0]
  if (g.leaderReady(p)) {
    if (!g.may(p, "Mando's N-1 Starfighter: exhaust your leader for +2/+0 for this attack?", { yes: 'Exhaust', no: 'Skip', ai: true, source: 'swu-ASH-203' })) return
    g.exhaustLeader(p)
  } else if (leaderUnit) {
    if (!g.may(p, `Mando's N-1 Starfighter: exhaust ${g.name(leaderUnit)} for +2/+0 for this attack?`, { yes: 'Exhaust', no: 'Skip', ai: false, source: 'swu-ASH-203' })) return
    g.exhaust(leaderUnit)
  } else return
  g.buff(self.id, 2, 0, 'attack')
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
  const score = (id: string) => (g.unit(id)!.exhausted ? 0 : 10 + threat(g, id)) + 5 * bounced(id)
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
      const power = threat(g, a) + (b ? threat(g, b) : 0)
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

// How much an enemy unit does if left ready, for the cards that exhaust one: its power, its Raid,
// and its Restore counting for more (an aggro deck racing a healer: Mace Windu's Restore 2 takes
// back what it deals; the user, 2026-11-23). Nothing for one already exhausted.
const RESTORE_THREAT = 1.25
function threat(g: Game, id: string) {
  const unit = g.unit(id)
  if (!unit || unit.exhausted) return 0
  const keywords = g.keywords(unit)
  return g.power(unit) + (keywords.raid ?? 0) + RESTORE_THREAT * (keywords.restore ?? 0)
}
const mostThreat = (g: Game, ids: string[]) => [...ids].sort((a, b) => threat(g, b) - threat(g, a))[0]
// An exhausted unit's, were it readied (Blue Ace readies the one that does least)
function readyThreat(g: Game, id: string) {
  const unit = g.unit(id)
  if (!unit) return 0
  const keywords = g.keywords(unit)
  return g.power(unit) + (keywords.raid ?? 0) + RESTORE_THREAT * (keywords.restore ?? 0)
}

// Ezra Bridger: an Advantage token on a different unit, after an attack that dealt 3 or more
// combat damage to a base. The AI: its strongest ready unit, which attacks next; else its strongest
function ezraAdvantage(g: Game, self: Self, leader: boolean) {
  const p = self.controller
  const ids = all(g, (u) => u.id !== self.other)
  if (!ids.length) return
  const byPower = (list: string[]) => [...list].sort((a, b) => g.power(g.unit(b)!) - g.power(g.unit(a)!))
  const mine = friendly(g, self, (u) => u.id !== self.other)
  const best = byPower(friendly(g, self, (u) => u.id !== self.other && !u.exhausted))[0] ?? byPower(mine)[0]
  if (leader) {
    if (!g.leaderReady(p)) return
    if (!g.may(p, 'Ezra Bridger: exhaust this leader to give an Advantage token to a different unit?', { yes: 'Exhaust', no: 'Skip', ai: !!best, source: self.def.id })) return
    g.exhaustLeader(p)
  }
  const pick = g.chooseOne(p, 'Ezra Bridger: give an Advantage token to a different unit', ids, { optional: !leader, ai: best ?? null, source: self.def.id })
  if (pick) g.giveToken(pick, 'Advantage')
}
const ezraIf = (_g: Game, self: Self) => (self.baseDamage ?? 0) >= 3

// "Deal N damage to a unit": the enemy unit the AI hits. One the damage defeats, the dearest;
// else the one that would do the most. None when there's no enemy unit among them (it may pass).
// Damage that defeats nothing pops the Shield token on the strongest shielded enemy unit, unless
// an unshielded one threatens clearly more (the user, 2026-11-25: a legit use of a ping)
const SHIELD_POP_EDGE = 2
function bestHit(g: Game, self: Self, ids: string[], amount: number) {
  const foes = ids.map((id) => g.unit(id)!).filter((u) => u && g.controller(u) !== self.controller)
  const shielded = (u: UnitState) => g.tokens(u.id, 'Shield') > 0
  const lethal = foes.filter((u) => g.hp(u) - u.damage <= amount && !shielded(u)).sort((a, b) => g.cost(b) - g.cost(a))
  if (lethal.length) return lethal[0].id
  const byThreat = (list: UnitState[]) => [...list].sort((a, b) => readyThreat(g, b.id) - readyThreat(g, a.id))[0]
  const pop = byThreat(foes.filter(shielded))
  const chip = byThreat(foes.filter((u) => !shielded(u)))
  if (pop && (!chip || readyThreat(g, chip.id) < readyThreat(g, pop.id) + SHIELD_POP_EDGE)) return pop.id
  return chip?.id ?? null
}

// Kylo Ren's cost, a card discarded: Kylo's TIE Silencer when it can then be played from the
// discard pile this phase, else the card the AI needs least
function kyloDiscard(g: Game, p: PlayerId, source: string) {
  const hand = g.player(p).hand
  const tie = hand.find((c) => g.def(c).name === "Kylo's TIE Silencer" && g.price(p, c.id) <= g.readyResources(p))
  // A Heroism card for Anakin Skywalker, Champion of Mortis, while one is still to come and the
  // discard pile has none: both his -3/-3 then (the user, 2026-11-25)
  const pl = g.player(p)
  const anakin = [...pl.hand, ...pl.deck, ...pl.resources.map((r) => r.card)].some((c) => g.def(c).name === 'Anakin Skywalker' && /Champion of Mortis/.test(g.def(c).subtitle ?? ''))
  const heroism = (c: { def: string }) => g.def(c).aspects.includes('Heroism')
  const forAnakin = anakin && !pl.discard.some(heroism) ? hand.filter((c) => heroism(c) && g.def(c).name !== 'Anakin Skywalker').sort((a, b) => g.def(a).cost - g.def(b).cost)[0] : undefined
  const wanted = tie ?? forAnakin
  const pick = g.chooseOne(p, 'Kylo Ren: discard a card from your hand', hand.map((c) => c.id), { ai: wanted?.id ?? 'discard', firm: !!wanted, source })
  if (pick) g.discard(p, pick)
}

// Aldhani Garrison: the cards in hand with an aspect penalty that it lets be played
function garrisonCards(g: Game, p: PlayerId) {
  return g.player(p).hand.filter((c) => g.penalty(p, c.id) > 0 && g.canPlay(p, c.id, { discount: 2 })).map((c) => c.id)
}
// The splash it was built for: Latts Razzi first, Nothing Left to Fear next (the user, 2026-11-25)
const garrisonWorth = (g: Game, id: string) => {
  const d = g.def(g.card(id)!)
  return (d.name === 'Latts Razzi' ? 100 : 0) + (d.name === 'Nothing Left to Fear' ? 50 : 0) + d.cost
}

// Oppo Rancisis looks at the other friendly units' keywords, not at its own
let oppoLooking = false

// Vaneé: an Experience token moved, the AI from the weakest unit with one to the strongest unit
// that can attack (the attacking Vaneé herself On Attack)
function vanee(g: Game, self: Self) {
  const p = self.controller
  const holders = friendly(g, self, (u) => g.tokens(u.id, 'Experience') > 0)
  if (!holders.length) return
  const worth = (id: string) => readyThreat(g, id) + (g.attack?.attacker === id ? 5 : 0) + (g.canAttack(id) ? 2 : 0)
  const from = [...holders].sort((a, b) => worth(a) - worth(b))[0]
  const to = [...friendly(g, self)].sort((a, b) => worth(b) - worth(a))[0]
  const move = to !== from && worth(to) > worth(from) + 2
  const pick = g.chooseOne(p, 'Vaneé: you may defeat an Experience token on a friendly unit', holders, { optional: true, ai: move ? from : undefined, source: self.def.id })
  if (!pick) return
  const token = g.unit(pick)!.upgrades.find((x) => g.def(x).token && g.def(x).name === 'Experience')
  if (!token) return
  g.defeatUpgrade(token.id)
  const target = g.chooseOne(p, 'Vaneé: give an Experience token to a friendly unit', friendly(g, self), { ai: to, source: self.def.id })
  if (target) g.giveToken(target, 'Experience')
}

// "Give a unit -N/-N for this phase": the AI's enemy unit, the dearest it defeats (its HP left, no
// Shield token matters), else none
function shrinkTarget(g: Game, self: Self, amount: number) {
  const lethal = enemy(g, self, (u) => g.hp(u) - u.damage <= amount).map((id) => g.unit(id)!)
  return lethal.sort((a, b) => g.cost(b) - g.cost(a))[0]?.id
}
// Anakin Skywalker's -3/-3s, planned together (the user, 2026-11-25): two units each defeated, or
// one unit with 6 HP or less left defeated by both, the best of these; else the -3s on the enemy
// unit that threatens most, so it can't trade back or hit as hard. Space units too.
function anakinPlan(g: Game, self: Self, count: number): (string | undefined)[] {
  if (!count) return []
  const foes = enemy(g, self).map((id) => g.unit(id)!)
  const left = (u: UnitState) => g.hp(u) - u.damage
  const worth = (u: UnitState) => g.cost(u) + (u.exhausted ? 0 : 0.5 * g.power(u)) + (g.isLeader(u) ? 3 : 0)
  const singles = foes.filter((u) => left(u) <= 3).sort((a, b) => worth(b) - worth(a))
  const top = mostThreat(g, foes.map((u) => u.id))
  if (count === 1) return [singles[0]?.id ?? top]
  const doubles = foes.filter((u) => left(u) > 3 && left(u) <= 6).sort((a, b) => worth(b) - worth(a))
  const two = singles.length >= 2 ? worth(singles[0]) + worth(singles[1]) : -1
  const both = doubles.length ? worth(doubles[0]) : -1
  const one = singles.length ? worth(singles[0]) : -1
  if (both > two && both > one) return [doubles[0].id, doubles[0].id]
  if (two >= 0) return [singles[0].id, singles[1].id]
  if (one >= 0) return [singles[0].id, mostThreat(g, foes.filter((u) => u !== singles[0]).map((u) => u.id)) ?? undefined]
  return [top, top]
}
function shrinkOn(g: Game, self: Self, amount: number, text: string, target: string | undefined) {
  const pick = g.chooseOne(self.controller, text, all(g), { optional: true, ai: target, firm: !!target, source: self.def.id })
  if (!pick) return
  g.log(`${g.name(pick)} gets -${amount}/-${amount} for this phase`, self.controller)
  g.buff(pick, -amount, -amount, 'phase')
}
function shrink(g: Game, self: Self, amount: number, text: string, optional = true) {
  const target = shrinkTarget(g, self, amount) ?? (optional ? undefined : mostThreat(g, enemy(g, self)))
  const pick = g.chooseOne(self.controller, text, all(g), { optional, ai: target, source: self.def.id })
  if (!pick) return
  g.log(`${g.name(pick)} gets -${amount}/-${amount} for this phase`, self.controller)
  g.buff(pick, -amount, -amount, 'phase')
}

// Captain Phasma: +2/+2 for this phase on another First Order unit, the AI's the one about to
// attack (Kylo Ren first), else the strongest
function phasma(g: Game, self: Self) {
  const ids = friendly(g, self, (u) => u.id !== self.id && g.hasTrait(u, 'First Order'))
  if (!ids.length) return
  const worth = (id: string) => (g.canAttack(id) ? 20 : 0) + (g.isLeader(g.unit(id)!) ? 10 : 0) + g.power(g.unit(id)!)
  const best = [...ids].sort((a, b) => worth(b) - worth(a))[0]
  const pick = g.chooseOne(self.controller, 'Captain Phasma: you may give another First Order unit +2/+2 for this phase', ids, { optional: true, ai: best, firm: true, source: self.def.id })
  if (pick) g.buff(pick, 2, 2, 'phase')
}

// "Look at an opponent's hand. You may discard a card from it. If you do, they draw a card."
// The AI takes the card whose play would help them most (its 'strip')
const MON_CAL_STRIP = 6
function stripHand(g: Game, self: Self, name: string) {
  const p = self.controller
  const foe = p === 0 ? 1 : 0
  const hand = g.player(foe).hand
  g.log(`${g.player(p).name} looks at ${g.player(foe).name}'s hand`, p)
  const discard = g.chooseOne(p, `${name}: you may discard a card from your opponent's hand (they draw one)`, hand.map((c) => c.id), {
    optional: true,
    ai: 'strip',
    source: self.def.id,
    seen: hand.map((c) => c.id),
  })
  if (!discard) return
  g.discard(foe, discard)
  g.draw(foe, 1)
}

// --- Mace-bleu and Lando7's helpers ---

// Trask Walker: a unit in your discard pile costing 7 or less, to the bottom of your deck (heal 3
// from your base) or back to your hand. The AI takes the dearest back to its hand, or heals with
// its base at half its HP or worse.
function traskWalker(g: Game, self: Self) {
  const p = self.controller
  const ids = g.player(p).discard.filter((c) => g.def(c).type === 'unit' && g.def(c).cost <= 7).map((c) => c.id)
  if (!ids.length) return
  const costOf = (id: string) => g.def(g.player(p).discard.find((c) => c.id === id)!).cost
  const dearest = [...ids].sort((a, b) => costOf(b) - costOf(a))[0]
  const pick = g.chooseOne(p, 'Trask Walker: choose a unit in your discard pile that costs 7 or less', ids, { ai: dearest, source: self.def.id })
  if (!pick) return
  const base = g.player(p).base
  const low = base.damage * 2 >= g.def(base).hp
  const how = g.option(p, `Trask Walker: ${g.name(pick)}`, ['Return it to your hand', 'Put it on the bottom of your deck and heal 3 damage from your base'], {
    ai: low ? 1 : 0,
    source: self.def.id,
  })
  if (how === 0) g.fromDiscard(p, pick)
  else {
    g.discardToBottom(p, pick)
    g.heal(baseOf(p), 3, self)
  }
}

// Obi-Wan Kenobi (I Sense a Trap). The AI: an enemy unit -5/-5 that defeats it, else the dearest
// unit back, else an enemy unit weakened
function senseATrap(g: Game, self: Self) {
  const p = self.controller
  const discard = g.player(p).discard
  const fallen = discard.filter((c) => g.def(c).type === 'unit' && g.defeatedThisPhase(c.id) && g.canPlay(p, c.id, { discount: 5 })).map((c) => c.id)
  const fresh = all(g, (u) => u.id !== self.id && g.enteredThisPhase(u))
  const enemies = fresh.filter((id) => g.controller(g.unit(id)!) !== p)
  const kills = enemies.filter((id) => g.hp(g.unit(id)!) - g.unit(id)!.damage <= 5)
  const costOf = (id: string) => g.def(discard.find((c) => c.id === id)!).cost
  const dearest = [...fallen].sort((a, b) => costOf(b) - costOf(a))[0]
  const ai = kills.length ? 2 : dearest ? 1 : enemies.length ? 2 : 0
  const pick = g.option(
    p,
    'Obi-Wan Kenobi: you may choose one',
    ['Nothing', 'Play a unit defeated this phase from your discard pile, for 5 less', 'A unit that entered play this phase gets -5/-5 for this phase'],
    { ai, source: self.def.id },
  )
  if (pick === 1 && fallen.length) {
    const card = g.chooseOne(p, 'Obi-Wan Kenobi: play a unit defeated this phase, for 5 less', fallen, { ai: dearest, source: self.def.id })
    if (card) g.playCard(p, card, { discount: 5 })
  } else if (pick === 2 && fresh.length) {
    const target = g.chooseOne(p, 'Obi-Wan Kenobi: a unit that entered play this phase gets -5/-5', fresh, {
      ai: kills[0] ?? mostThreat(g, enemies) ?? 'harm',
      source: self.def.id,
    })
    if (target) g.buff(target, -5, -5, 'phase')
  }
}

// "Its owner puts it on the top or bottom of their deck": the AI owner keeps its card on top
function ownerToDeck(g: Game, self: Self, unitId: string) {
  const unit = g.unit(unitId)
  if (!unit) return
  const where = g.option(unit.owner, `${self.def.name}: put ${g.name(unitId)} on the top or the bottom of your deck?`, ['Top', 'Bottom'], {
    ai: 0,
    source: self.def.id,
  })
  g.toDeck(unitId, where === 0 ? 'top' : 'bottom')
}

// "Look at the top card of your deck. You may put it on the bottom of your deck." The AI keeps a
// card it can play by next round
function topToBottom(g: Game, self: Self) {
  const p = self.controller
  const top = g.top(p, 1)[0]
  if (!top) return
  const keep = g.def(top).cost <= g.player(p).resources.length + 1
  if (
    g.may(p, `${self.def.name}: the top card of your deck is ${g.def(top).name}. Put it on the bottom of your deck?`, {
      yes: 'Bottom',
      no: 'Keep it',
      ai: !keep,
      source: self.def.id,
    })
  )
    g.toBottom(p, top.id)
}

const ASPECT_NAMES: Aspect[] = ['Vigilance', 'Command', 'Aggression', 'Cunning', 'Heroism', 'Villainy']
// Lando Calrissian: choose an aspect, discard the top card of a deck, a Credit token if it has
// that aspect. The AI calls the aspect its own deck is built around, on its own deck: the share
// of its whole list with that aspect, a deck built on one call with a few exceptions (Lando7
// Bleu Heroïsme: Heroism) (the user, 2026-11-24)
function landoCall(g: Game, p: PlayerId) {
  const pl = g.player(p)
  const cards = [...pl.deck, ...pl.hand, ...pl.discard, ...pl.resources.map((r) => r.card), ...g.units((u) => u.owner === p && !u.leader && !g.def(u).token)]
  const counts = ASPECT_NAMES.map((a) => cards.filter((c) => g.def(c).aspects.includes(a)).length)
  return counts.indexOf(Math.max(...counts))
}
function landoSabacc(g: Game, self: Self) {
  const p = self.controller
  const aspect = g.option(p, 'Lando Calrissian: choose an aspect', ASPECT_NAMES, { ai: landoCall(g, p), source: self.def.id })
  const deck = g.option(p, 'Lando Calrissian: discard the top card of which deck?', ['Your deck', "Your opponent's deck"], { ai: 0, source: self.def.id })
  const q = deck === 0 ? p : g.other(p)
  const top = g.top(q, 1)[0]
  if (!top) return
  g.mill(q, top.id)
  if (g.def(top).aspects.includes(ASPECT_NAMES[aspect])) g.createCredit(p)
}

// Kanan Jarrus. The AI: the enemy unit it costs them most to lose (a token is gone for good)
function kanan(g: Game, self: Self) {
  const most = friendly(g, self, (u) => g.def(u).aspects.some((a) => a === 'Command' || a === 'Aggression')).length ? 4 : 2
  const fits = (u: UnitState) => !g.isLeader(u) && g.cost(u) <= most
  const worth = (id: string) => (g.def(g.unit(id)!).token ? 3 : g.cost(g.unit(id)!)) + threat(g, id)
  const best = [...enemy(g, self, fits)].sort((a, b) => worth(b) - worth(a))[0]
  const pick = g.chooseOne(self.controller, `Kanan Jarrus: you may return a non-leader unit that costs ${most} or less to its owner's hand`, all(g, fits), {
    optional: true,
    ai: best ?? 'none',
    source: self.def.id,
  })
  if (pick) g.returnToHand(pick)
}

// Yoda (A Disturbing Puzzle). The AI: the strongest enemy unit still to attack this phase; else
// the defender, when its damage back would defeat Yoda
function yodaPuzzle(g: Game, self: Self) {
  const target = self.attack?.target
  const me = g.unit(self.id)
  const later = enemy(g, self, (u) => u.id !== target && !u.exhausted && g.power(u) > 0)
  const defender = target && target !== 'base' ? g.unit(target) : undefined
  const saves = defender && me && g.power(defender) >= g.hp(me) - me.damage ? defender.id : undefined
  const pick = g.chooseOne(self.controller, 'Yoda: you may choose an enemy unit; combat damage dealt to and by it is prevented this phase', enemy(g, self), {
    optional: true,
    ai: mostThreat(g, later) ?? saves ?? 'none',
    source: self.def.id,
  })
  if (pick) g.preventCombat(pick)
}

// R2-D2 (The First Protagonist). The AI readies a resource it has spent when that resource gets
// used: its leader's ability that costs [1] (Lando's Credit token), or a card in hand just 1 short
// (the user, 2026-11-25: resources all spent first, R2 attacks, Lando makes a Credit with the one
// readied); else it defeats a ground unit with the 1 damage; else readies one anyway; else looks
function r2Protagonist(g: Game, self: Self) {
  const p = self.controller
  const pl = g.player(p)
  const kill = enemy(g, self, (u) => u.arena === 'ground' && g.hp(u) - u.damage <= 1)
  const spent = pl.resources.some((r) => r.exhausted)
  const canPay = pl.resources.filter((r) => !r.exhausted).length + g.credits(p)
  const leaderUse = !pl.leader.deployed && g.leaderReady(p) && /^\[Action \[\[1\], Arrow\]:\]/.test(g.def(pl.leader).text ?? '')
  const oneShort = pl.hand.some((c) => g.price(p, c.id) === canPay + 1)
  const ready = spent && (leaderUse || oneShort)
  const pick = g.option(p, 'R2-D2: choose one', ['Ready a resource', 'Deal 1 damage to a ground unit', 'Look at the top card of your deck; you may discard it'], {
    ai: ready ? 0 : kill.length ? 1 : spent ? 0 : 2,
    // The board score doesn't see what the resource readied pays for
    firm: ready,
    source: self.def.id,
  })
  if (pick === 0) {
    const r = g.player(p).resources.find((x) => x.exhausted)
    if (r) {
      r.exhausted = false
      g.log(`${g.player(p).name} readies a resource`, p)
    }
  } else if (pick === 1) {
    const target = g.chooseOne(p, 'R2-D2: deal 1 damage to a ground unit', all(g, (u) => u.arena === 'ground'), { ai: kill[0] ?? 'harm', source: self.def.id })
    if (target) g.damage(target, 1, self)
  } else {
    const top = g.top(p, 1)[0]
    if (!top) return
    const keep = g.def(top).cost <= g.player(p).resources.length + 1
    if (g.may(p, `R2-D2: the top card of your deck is ${g.def(top).name}. Discard it?`, { yes: 'Discard', no: 'Keep it', ai: !keep, source: self.def.id })) g.mill(p, top.id)
  }
}

// Galen Erso: a card named, among those the opponent owns. The AI weighs each name by every copy
// still to matter: in play (twice), in hand or deck, in the resources with Plot; each by what its
// text does: a card that gives its abilities to others most (Tantive IV: Raid 2 and Saboteur to
// each other Rebel), keywords, its cost. A card with no text loses nothing (the user, 2026-11-25)
const GIVES_OTHERS = /each other friendly|other friendly [^.]*(gain|get)s/i
function galenWorth(g: Game, c: { def: string }) {
  const d = g.def(c)
  const text = d.text ?? ''
  if (!text.trim()) return 0
  const keywords = Object.keys(d.keywords ?? {}).length
  return 1 + 0.3 * d.cost + 0.5 * keywords + (GIVES_OTHERS.test(text) ? 4 : 0)
}
function galenErso(g: Game, self: Self) {
  const foe = g.other(self.controller)
  const pl = g.player(foe)
  const inPlay = g.units((u) => u.owner === foe && !u.leader)
  const cards = [...pl.hand, ...pl.deck, ...pl.discard, ...pl.resources.map((r) => r.card), ...inPlay]
  const names = [...new Set(cards.filter((c) => g.def(c).type !== 'leader' && !g.def(c).token).map((c) => g.def(c).name))].sort()
  if (!names.length) return
  const score: Record<string, number> = {}
  const add = (c: { def: string }, times: number) => {
    const d = g.def(c)
    if (d.type === 'leader' || d.token) return
    score[d.name] = (score[d.name] ?? 0) + times * galenWorth(g, c)
  }
  for (const u of inPlay) add(u, 2)
  for (const c of [...pl.hand, ...pl.deck]) add(c, 1)
  for (const r of pl.resources) if (g.def(r.card).keywords?.plot) add(r.card, 1)
  const wanted = [...names].sort((a, b) => (score[b] ?? 0) - (score[a] ?? 0))[0]
  const pick = g.option(self.controller, 'Galen Erso: name a card', names, { ai: Math.max(0, names.indexOf(wanted)), source: self.def.id })
  g.nameCard(self, names[pick])
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
      automatic: { whenFriendlyAttacks: true },
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
    // The Shield token (THMW T01, for its image): the engine prevents the damage and defeats it
    card: 'swu-THMW-T01',
    name: 'Shield',
    text: 'If damage would be dealt to attached unit, prevent that damage. If you do, defeat a Shield token on it.',
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
        const weakest = [...exhausted].sort((a, b) => readyThreat(g, a) - readyThreat(g, b))[0]
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
        // The AI takes the card whose play would help them most (the AI's 'strip')
        const discard = g.chooseOne(p, "Cunning Ploy: you may discard a card from your opponent's hand (they draw one)", hand.map((c) => c.id), {
          optional: true,
          ai: 'strip',
          source: self.def.id,
          seen: hand.map((c) => c.id),
        })
        if (discard) {
          g.discard(foe, discard)
          g.draw(foe, 1)
        }
        const readyEnemies = enemy(g, self, (u) => !u.exhausted)
        const target = g.chooseOne(p, 'Cunning Ploy: exhaust an enemy unit', readyEnemies.length ? readyEnemies : enemy(g, self), {
          // The AI: the ready enemy that would do the most, healers first
          ai: mostThreat(g, readyEnemies) ?? 'harm',
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
        const ready = (arena: string) => enemy(g, self, (u) => u.arena === arena).reduce((sum, id) => sum + threat(g, id), 0)
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
        const strongest = mostThreat(g, ready)
        const pick = g.chooseOne(self.controller, 'Sabine Wren: you may exhaust a ground unit', ground, { optional: true, ai: strongest ?? null, source: self.def.id })
        if (pick) g.exhaust(pick)
      },
    },
  },
  // --- Luke Rebels (swudb.com/deck/TBXCVdKhz) ---
  {
    card: 'swu-IC27-006',
    name: 'Luke Skywalker',
    subtitle: 'I Have to Face Him',
    text: 'Draw 2 more cards in your starting hand.',
    backText: '[Overwhelm]\n[On Attack:] You may discard a card from your hand. If you do, this unit gets +2/+0 for this attack.',
    front: { startingHand: 2 },
    back: {
      onAttack: (g, self) => {
        const p = self.controller
        const hand = g.player(p).hand
        const me = g.unit(self.id)
        const target = self.attack?.target
        if (!hand.length || !me || !target) return
        // The AI pays a card for the +2 nearly always: Overwhelm carries it to the base. Not its
        // last card when it can play that one next round, unless that one is a unique copy
        // already in play (the user, 2026-11-24)
        const inPlay = (c: { def: string }) => g.def(c).unique && friendly(g, self, (u) => g.def(u).name === g.def(c).name).length > 0
        const last = hand.length === 1 ? hand[0] : undefined
        const worth = !last || inPlay(last) || g.def(last).cost > g.player(p).resources.length
        if (!g.may(p, 'Luke Skywalker: discard a card from your hand for +2/+0 for this attack?', { yes: 'Discard', no: 'Skip', ai: worth, firm: true, source: self.def.id })) return
        const pick = g.chooseOne(p, 'Luke Skywalker: discard a card from your hand', hand.map((c) => c.id), { ai: 'discard', source: self.def.id })
        if (!pick) return
        g.discard(p, pick)
        g.buff(self.id, 2, 0, 'attack')
      },
    },
  },
  {
    card: 'swu-HMW-232',
    name: 'Mon Cal Cruiser',
    text: "[When Played:] Choose one:\n• Attack with a unit. It gets +2/+0 for this attack.\n• Look at an opponent's hand. You may discard a card from it. If you do, they draw a card.",
    front: {
      whenPlayed: (g, self) => {
        const p = self.controller
        const attackers = friendly(g, self, (u) => g.canAttack(u.id))
        // The AI attacks when it has a unit that can; but against an opponent with 6 or more
        // resources and Credit tokens ready and cards in hand, it strips their big play first,
        // unless the +2 wins (the user, 2026-11-25: Lando about to play Bo-Katan)
        const foe = g.other(p)
        const fp = g.player(foe)
        const theirs = fp.resources.filter((r) => !r.exhausted).length + g.credits(foe)
        const baseLeft = g.def(fp.base).hp - fp.base.damage
        const wins = attackers.some((id) => g.attackable(id).includes('base') && g.power(g.unit(id)!) + 2 >= baseLeft)
        const strip = fp.hand.length > 0 && theirs >= MON_CAL_STRIP && !wins
        const pick = g.option(p, 'Mon Cal Cruiser: choose one', ['Attack with a unit (+2/+0)', "Look at an opponent's hand and discard a card from it"], {
          ai: attackers.length && !strip ? 0 : 1,
          firm: strip,
          source: self.def.id,
        })
        if (pick === 0) {
          const attacker = g.chooseOne(p, 'Mon Cal Cruiser: attack with a unit; it gets +2/+0', attackers, { ai: 'help', source: self.def.id })
          if (attacker) g.attackWith(attacker, { power: 2 })
          return
        }
        stripHand(g, self, 'Mon Cal Cruiser')
      },
    },
  },
  {
    card: 'swu-HMW-173',
    name: 'Rebel Operation',
    text: 'This card costs [1] less to play for each friendly [{Rebel}] unit and leader.\nDraw 2 cards.',
    front: {
      costsLessSelf: (g, p) => {
        const leader = g.player(p).leader
        const leaderRebel = !leader.deployed && g.def(leader).traits.includes('Rebel') ? 1 : 0
        return g.units((u) => g.controller(u) === p && g.hasTrait(u, 'Rebel')).length + leaderRebel
      },
      play: (g, self) => g.draw(self.controller, 2),
    },
  },
  {
    card: 'swu-IC27-117',
    name: 'Hera Syndulla',
    subtitle: 'Against the Odds',
    text: '[When you play another [{Rebel}] card:] Deal 1 damage to a base.',
    front: {
      triggersIf: { whenYouPlay: (_g, self) => !!self.otherDef && self.otherDef.traits.includes('Rebel') && self.other !== self.id },
      whenYouPlay: (g, self) => {
        if (!g.unit(self.id)) return
        const pick = g.chooseOne(self.controller, 'Hera Syndulla: deal 1 damage to a base', [baseOf(0), baseOf(1)], { ai: baseOf(self.controller === 0 ? 1 : 0), source: self.def.id })
        if (pick) g.damage(pick, 1, self)
      },
    },
  },
  {
    card: 'swu-LAW-078',
    name: 'Sabine Wren',
    subtitle: 'Spectre Five',
    text: '[Ambush]\n[When Played:] You may defeat a non-[{Unique}] upgrade. If you control a [Vigilance] or [Command] unit, you may defeat an upgrade instead.',
    front: {
      whenPlayed: (g, self) => {
        const p = self.controller
        const anyUpgrade = g.units((u) => g.controller(u) === p && g.def(u).aspects.some((a) => a === 'Vigilance' || a === 'Command')).length > 0
        const upgrades = g.upgrades().filter((u) => anyUpgrade || !g.def(u).unique)
        // The AI defeats an enemy's, the dearest
        const theirs = upgrades.filter((u) => u.controller !== p).sort((a, b) => g.def(b).cost - g.def(a).cost)
        const pick = g.chooseOne(p, `Sabine Wren: you may defeat ${anyUpgrade ? 'an' : 'a non-unique'} upgrade`, upgrades.map((u) => u.id), {
          optional: true,
          ai: theirs[0]?.id ?? null,
          source: self.def.id,
        })
        if (pick) g.defeatUpgrade(pick)
      },
    },
  },
  {
    card: 'swu-ASH-153',
    name: 'Green Leader',
    subtitle: "Crynyd's Sacrifice",
    text: '[When Defeated:] You may deal 2 damage to a unit.',
    front: {
      whenDefeated: (g, self) => {
        const ids = all(g)
        const pick = g.chooseOne(self.controller, 'Green Leader: you may deal 2 damage to a unit', ids, { optional: true, ai: bestHit(g, self, ids, 2), source: self.def.id })
        if (pick) g.damage(pick, 2, self)
      },
    },
  },
  {
    card: 'swu-IC27-119',
    name: 'Sabine Wren',
    subtitle: 'Liberator of Krownest',
    text: "[Saboteur]\n[When Played:] Discard 2 cards from a deck. You may deal damage to a unit equal to the difference in those cards' costs.",
    front: {
      whenPlayed: (g, self) => {
        const p = self.controller
        const foe = p === 0 ? 1 : 0
        // The AI mills the opponent's deck: its own is what it will draw
        const which = g.option(p, 'Sabine Wren: discard 2 cards from a deck', ["Your opponent's deck", 'Your deck'], { ai: 0, source: self.def.id })
        const owner = which === 1 ? p : foe
        const cards = g.top(owner, 2)
        for (const card of cards) g.mill(owner, card.id)
        if (cards.length < 2) return
        const amount = Math.abs(g.def(cards[0]).cost - g.def(cards[1]).cost)
        g.log(`Sabine Wren: the costs differ by ${amount}`, p)
        if (!amount) return
        const ids = all(g)
        const pick = g.chooseOne(p, `Sabine Wren: you may deal ${amount} damage to a unit`, ids, { optional: true, ai: bestHit(g, self, ids, amount), source: self.def.id })
        if (pick) g.damage(pick, amount, self)
      },
    },
  },
  {
    card: 'swu-LAW-079',
    name: 'K-2SO',
    subtitle: 'Locking the Vault',
    text: '[Ambush]\n[On Attack:] You may deal 3 damage to a damaged ground unit.',
    front: {
      onAttack: (g, self) => {
        const ids = all(g, (u) => u.damage > 0 && u.arena === 'ground')
        const pick = g.chooseOne(self.controller, 'K-2SO: you may deal 3 damage to a damaged ground unit', ids, { optional: true, ai: bestHit(g, self, ids, 3), source: self.def.id })
        if (pick) g.damage(pick, 3, self)
      },
    },
  },
  {
    card: 'swu-IC27-160',
    name: 'Tantive IV',
    subtitle: 'For Alderaan',
    text: 'Each other friendly [{Rebel}] unit gains [Raid 2] and [Saboteur].',
    front: {
      gives: (g, self, unit) =>
        unit.id !== self.id && g.controller(unit) === self.controller && g.hasTrait(unit, 'Rebel') ? { keywords: { raid: 2, saboteur: true } } : undefined,
    },
  },
  {
    card: 'swu-TWI-153',
    name: 'Bold Resistance',
    text: 'Choose up to 3 units that share the same [{Trait}]. Each of those units gets [+2/+0] for this phase.',
    front: {
      play: (g, self) => {
        const p = self.controller
        const mine = friendly(g, self).map((id) => g.unit(id)!)
        const traits = [...new Set(mine.flatMap((u) => g.traits(u)))]
        if (!traits.length) return
        // The AI: the trait most of its units that can still attack share, and the 3 strongest of
        // those; none when none can (the +2 then does nothing, so it doesn't play it)
        const attackers = (trait: string) =>
          mine.filter((u) => g.canAttack(u.id) && g.traits(u).includes(trait)).sort((a, b) => g.power(b) - g.power(a))
        const best = traits.reduce((a, b) => (attackers(b).length > attackers(a).length ? b : a))
        const trait = traits[g.option(p, 'Bold Resistance: choose a trait', traits, { ai: traits.indexOf(best), source: self.def.id })] ?? best
        const ids = all(g, (u) => g.traits(u).includes(trait))
        const ai = `ids:${attackers(trait).slice(0, 3).map((u) => u.id).join(',')}`
        const picks = g.choose(p, `Bold Resistance: up to 3 ${trait} units get +2/+0 for this phase`, ids, { min: 0, max: 3, ai, source: self.def.id })
        for (const id of picks) g.buff(id, 2, 0, 'phase')
      },
    },
  },
  {
    card: 'swu-ASH-157',
    name: 'Danger Squadron Wingmen',
    text: '[On Attack:] You may give an Advantage token to another unit.',
    front: {
      onAttack: (g, self) => {
        const ids = all(g, (u) => u.id !== self.id)
        // The AI: its strongest ready unit, which attacks next
        const ready = friendly(g, self, (u) => u.id !== self.id && !u.exhausted).sort((a, b) => g.power(g.unit(b)!) - g.power(g.unit(a)!))
        const pick = g.chooseOne(self.controller, 'Danger Squadron Wingmen: you may give an Advantage token to another unit', ids, {
          optional: true,
          ai: ready[0] ?? friendly(g, self, (u) => u.id !== self.id)[0] ?? null,
          source: self.def.id,
        })
        if (pick) g.giveToken(pick, 'Advantage')
      },
    },
  },
  // --- Single cards, imported 2026-11-24 ---
  {
    card: 'swu-LAW-222',
    name: 'Rebel Blockade Runner',
    text: '[Saboteur]',
    front: {},
  },
  {
    card: 'swu-ASH-159',
    name: 'Alphabet Squadron U-Wing',
    subtitle: 'Quiet Devotion',
    text: '[Overwhelm]\n[When the regroup phase starts:] Give an Advantage token to a unit.',
    front: {
      regroupStart: (g, self) => {
        const ids = all(g)
        if (!ids.length) return
        // The AI: its strongest friendly unit, which attacks first next round
        const best = friendly(g, self).sort((a, b) => g.power(g.unit(b)!) - g.power(g.unit(a)!))[0] ?? ids[0]
        const pick = g.chooseOne(self.controller, 'Alphabet Squadron U-Wing: give an Advantage token to a unit', ids, { ai: best, source: self.def.id })
        if (pick) g.giveToken(pick, 'Advantage')
      },
    },
  },
  {
    card: 'swu-IC27-166',
    name: "I've Got A Bad Feeling",
    text: "Return a non-leader unit to its owner's hand.\nGive a Shield token to a friendly unit.",
    front: {
      play: (g, self) => {
        const p = self.controller
        const ids = all(g, (u) => !g.isLeader(u))
        const pick = ids.length ? g.chooseOne(p, "I've Got A Bad Feeling: return a non-leader unit to its owner's hand", ids, { ai: 'harm', source: self.def.id }) : null
        if (pick) g.returnToHand(pick)
        const mine = friendly(g, self)
        if (!mine.length) return
        // The AI: its strongest unit
        const best = [...mine].sort((a, b) => g.power(g.unit(b)!) + g.hp(g.unit(b)!) - g.power(g.unit(a)!) - g.hp(g.unit(a)!))[0]
        const shield = g.chooseOne(p, "I've Got A Bad Feeling: give a Shield token to a friendly unit", mine, { ai: best, source: self.def.id })
        if (shield) g.giveToken(shield, 'Shield')
      },
    },
  },
  {
    card: 'swu-HMW-238',
    name: 'Exploit Confidence',
    text: "Return a non-leader unit with 6 or more power to it's owner's hand.",
    front: {
      play: (g, self) => {
        const ids = all(g, (u) => !g.isLeader(u) && g.power(u) >= 6)
        if (!ids.length) return
        const pick = g.chooseOne(self.controller, "Exploit Confidence: return a non-leader unit with 6 or more power to its owner's hand", ids, { ai: 'harm', source: self.def.id })
        if (pick) g.returnToHand(pick)
      },
    },
  },
  {
    card: 'swu-ASH-013',
    name: 'Ezra Bridger',
    subtitle: "It's Now or Never",
    text: "[When a friendly unit's attack ends:] If it dealt 3 or more combat damage to a base, you may exhaust this leader. If you do, give an Advantage token to a different unit.",
    backText: "[Saboteur]\n[When a friendly unit's attack ends:] If it dealt 3 or more combat damage to a base, you may give an Advantage token to a different unit.",
    front: {
      triggersIf: { whenFriendlyAttackEnds: (g, self) => ezraIf(g, self) && g.leaderReady(self.controller) },
      whenFriendlyAttackEnds: (g, self) => ezraAdvantage(g, self, true),
    },
    back: {
      triggersIf: { whenFriendlyAttackEnds: ezraIf },
      whenFriendlyAttackEnds: (g, self) => ezraAdvantage(g, self, false),
    },
  },
  {
    card: 'swu-JTL-164',
    name: 'Cham Syndulla',
    subtitle: 'Rallying Ryloth',
    text: '[When Played:] If you control fewer resources than an opponent, you may resource the top card of your deck.',
    front: {
      whenPlayed: (g, self) => {
        const p = self.controller
        if (g.player(p).resources.length >= g.player(p === 0 ? 1 : 0).resources.length) return
        if (g.may(p, 'Cham Syndulla: resource the top card of your deck?', { yes: 'Resource', no: 'Skip', ai: true, source: self.def.id })) g.resourceFromDeck(p)
      },
    },
  },
  {
    card: 'swu-JTL-249',
    name: 'Millennium Falcon',
    subtitle: 'Get Out And Push',
    text: 'You may play or deploy 1 additional [{Pilot}] on this unit.\nThis unit gets [+1/+0] for each [{Pilot}] on it.',
    front: {
      pilots: 2,
      gives: (g, self, unit) => {
        if (unit.id !== self.id) return undefined
        const pilots = unit.upgrades.filter((u) => ['unit', 'leader'].includes(g.def(u).type) || g.def(u).traits.includes('Pilot')).length
        return pilots ? { power: pilots } : undefined
      },
    },
  },
  {
    card: 'swu-LOF-151',
    name: "Knight's Saber",
    text: 'Attach to a [{Jedi}] non-[{Vehicle}] unit.',
    front: {},
  },
  {
    card: 'swu-SEC-176',
    name: 'Sudden Ferocity',
    text: '[Plot]',
    front: {},
  },
  {
    card: 'swu-SEC-252',
    name: 'Maarva Andor',
    subtitle: "We've Been Sleeping",
    text: '[When Defeated:] Give an Experience token to each friendly [{Rebel}] unit.',
    front: {
      whenDefeated: (g, self) => {
        for (const id of friendly(g, self, (u) => u.id !== self.id && g.hasTrait(u, 'Rebel'))) g.giveToken(id, 'Experience')
      },
    },
  },
  {
    card: 'swu-LAW-068',
    name: 'Millennium Falcon',
    subtitle: 'Dodging Patrols',
    text: '[On Attack:] You may give a space unit -2/-0 for this phase. You may give a ground unit +2/+0 for this phase.',
    front: {
      onAttack: (g, self) => {
        const p = self.controller
        const byPower = (list: string[]) => [...list].sort((a, b) => g.power(g.unit(b)!) - g.power(g.unit(a)!))
        // The AI: -2 on the space unit it attacks (less damage back), else the strongest ready enemy one
        const target = self.attack?.target
        const defender = target && target !== 'base' && g.unit(target)?.arena === 'space' ? target : undefined
        const weaken = defender ?? byPower(enemy(g, self, (u) => u.arena === 'space' && !u.exhausted))[0] ?? byPower(enemy(g, self, (u) => u.arena === 'space'))[0]
        const space = g.chooseOne(p, 'Millennium Falcon: you may give a space unit -2/-0 for this phase', all(g, (u) => u.arena === 'space'), { optional: true, ai: weaken ?? null, source: self.def.id })
        if (space) g.buff(space, -2, 0, 'phase')
        // +2 on the strongest friendly ground unit that can still attack
        const strong = byPower(friendly(g, self, (u) => u.arena === 'ground' && !u.exhausted))[0] ?? null
        const ground = g.chooseOne(p, 'Millennium Falcon: you may give a ground unit +2/+0 for this phase', all(g, (u) => u.arena === 'ground'), { optional: true, ai: strong, source: self.def.id })
        if (ground) g.buff(ground, 2, 0, 'phase')
      },
    },
  },
  {
    // Credit tokens aren't in the engine yet (no deck here makes them): a 4/4 until they are
    card: 'swu-LAW-221',
    name: 'Lieutenant Gorn',
    subtitle: 'I Deserve Worse',
    text: '[On Attack:] Take control of an enemy Credit token.',
    front: {},
  },
  {
    card: 'swu-HMW-211',
    name: 'Tech',
    subtitle: 'I Thought It Was Obvious',
    text: '[When this unit is dealt damage and survives:] You may exhaust a unit.',
    front: {
      whenDealtDamage: (g, self) => {
        if (!g.unit(self.id)) return
        const ready = enemy(g, self, (u) => !u.exhausted)
        const pick = g.chooseOne(self.controller, 'Tech: you may exhaust a unit', all(g), { optional: true, ai: mostThreat(g, ready) ?? null, source: self.def.id })
        if (pick) g.exhaust(pick)
      },
    },
  },
  {
    card: 'swu-SEC-172',
    name: 'Cinta Kaz',
    subtitle: 'The Struggle Comes First',
    text: '[When Played:] You may attack with a unit.\n[Plot]',
    front: {
      whenPlayed: (g, self) => {
        const ready = friendly(g, self, (u) => g.canAttack(u.id))
        if (!ready.length) return
        // The AI attacks with its leader unit (Luke Skywalker, deployed as Plot plays her)
        const leader = ready.find((id) => g.unit(id)?.leader)
        const attacker = g.chooseOne(self.controller, 'Cinta Kaz: you may attack with a unit', ready, { optional: true, ai: leader ?? 'help', firm: !!leader, source: self.def.id })
        if (attacker) g.attackWith(attacker)
      },
    },
  },
  {
    card: 'swu-LOF-142',
    name: 'Adi Gallia',
    subtitle: 'Stern and Focused',
    text: "[When an opponent plays an event:] Deal 1 damage to that player's base.",
    front: {
      triggersIf: { whenOpponentPlays: (_g, self) => self.otherDef?.type === 'event' },
      whenOpponentPlays: (g, self) => g.damage(baseOf(self.controller === 0 ? 1 : 0), 1, self),
    },
  },
  {
    card: 'swu-SEC-198',
    name: 'Bail Organa',
    subtitle: 'Responding to Catastrophe',
    text: '[On Attack:] You may discard a card from your hand. If you do, create a Spy token.',
    front: {
      onAttack: (g, self) => {
        const p = self.controller
        const hand = g.player(p).hand
        if (!hand.length) return
        // The AI: its cheapest card, with 3 or more in hand
        const cheapest = [...hand].sort((a, b) => g.def(a).cost - g.def(b).cost)[0]
        const pick = g.chooseOne(p, 'Bail Organa: you may discard a card from your hand to create a Spy token', hand.map((c) => c.id), {
          optional: true,
          ai: hand.length >= 3 ? cheapest.id : 'none',
          source: self.def.id,
        })
        if (!pick) return
        g.discard(p, pick)
        g.createToken(p, 'Spy')
      },
    },
  },
  {
    card: 'swu-JTL-147',
    name: 'Black One',
    subtitle: 'Straight At Them',
    text: 'While this unit is upgraded, it gets [+1/+0].\n[On Attack:] If you control Poe Dameron, you may deal 1 damage to a unit.',
    front: {
      gives: (_g, self, unit) => (unit.id === self.id && unit.upgrades.length ? { power: 1 } : undefined),
      onAttack: (g, self) => {
        const poe = g.units((u) => g.controller(u) === self.controller && (g.def(u).name === 'Poe Dameron' || u.upgrades.some((x) => g.def(x).name === 'Poe Dameron')))
        if (!poe.length) return
        const ids = all(g)
        const pick = g.chooseOne(self.controller, 'Black One: you may deal 1 damage to a unit', ids, { optional: true, ai: bestHit(g, self, ids, 1) ?? null, source: self.def.id })
        if (pick) g.damage(pick, 1, self)
      },
    },
  },
  {
    card: 'swu-ASH-203',
    name: "Mando's N-1 Starfighter",
    subtitle: 'Faster than a Fathier',
    text: '[Support]\n[On Attack:] You may exhaust a friendly leader. If you do, this unit gets +2/+0 for this attack.',
    front: {
      whenPlayed: (g, self) => support(g, self, { onAttack: n1Attack }),
      onAttack: n1Attack,
    },
  },
  {
    card: 'swu-IC27-115',
    name: 'Poe Dameron',
    subtitle: 'Hero of the Resistance',
    text: '[When you play another [{Resistance}] card:] This unit gets +1/+0 for this phase.',
    front: {
      triggersIf: { whenYouPlay: (_g, self) => self.other !== self.id && !!self.otherDef?.traits.includes('Resistance') },
      whenYouPlay: (g, self) => g.buff(self.id, 1, 0, 'phase'),
    },
  },
  {
    card: 'swu-ASH-040',
    name: 'Poe Dameron',
    subtitle: "I'll Come Back For You",
    text: 'All units lose [Sentinel].',
    front: {
      gives: () => ({ loses: ['sentinel'] }),
    },
  },
  {
    card: 'swu-SEC-164',
    name: 'Warrior of Clan Ordo',
    text: "[On Attack:] You may disclose [Aggression]. If you don't, deal 2 damage to your base.",
    front: {
      onAttack: (g, self) => {
        if (!disclose(g, self, ['Aggression'])) g.damage(baseOf(self.controller), 2, self)
      },
    },
  },
  // --- Mace-bleu (swudb.com/deck/AjbssNCt) ---
  {
    card: 'swu-ASH-133',
    name: 'Trask Walker',
    text: '[When Played/On Attack:] Choose a unit in your discard pile that costs 7 or less. Either put that card on the bottom of your deck and heal 3 damage from your base or return it to your hand.',
    front: { whenPlayed: traskWalker, onAttack: traskWalker },
  },
  {
    card: 'swu-ASH-065',
    name: 'Home One',
    subtitle: 'Heart of the Fleet',
    text: '[Sentinel]\n[When Played:] Heal all damage from each friendly unit.',
    front: {
      whenPlayed: (g, self) => {
        for (const id of friendly(g, self)) {
          const u = g.unit(id)
          if (u?.damage) g.heal(id, u.damage, self)
        }
      },
    },
  },
  {
    card: 'swu-LOF-045',
    name: 'Yaddle',
    subtitle: 'A Chance To Make Things Right',
    text: '[Restore 1]\n[On Attack:] Each other friendly [{Jedi}] unit gains [Restore 1] for this phase.',
    front: {
      onAttack: (g, self) => {
        for (const id of friendly(g, self, (u) => u.id !== self.id && g.traits(u).includes('Jedi'))) g.grant(id, { restore: 1 }, 'phase', self.id)
      },
    },
  },
  {
    card: 'swu-IC27-042',
    name: 'Obi-Wan Kenobi',
    subtitle: 'I Sense a Trap',
    text: '[When Played:] You may choose one:\n• Play a unit that was defeated this phase from your discard pile. It costs [5] less.\n• Choose a unit that entered play this phase. It gets -5/-5 for this phase.',
    front: { whenPlayed: senseATrap },
  },
  {
    card: 'swu-ASH-062',
    name: 'The Mandalorian',
    subtitle: 'Devoted Rescuer',
    text: '[Shielded]\nIf damage would be dealt to another friendly unit, you may defeat a Shield token on this unit. If you do, prevent that damage.',
    front: { sharesShield: () => true },
  },
  {
    card: 'swu-IC27-037',
    name: 'Finn',
    subtitle: 'Stand and Fight',
    text: '[Sentinel]\nWhile this unit is upgraded, he gains [Restore 2].',
    front: { gives: (_g, self, unit) => (unit.id === self.id && unit.upgrades.length ? { keywords: { restore: 2 } } : undefined) },
  },
  // --- Lando7 (swudb.com/deck/ffrxjspp) ---
  {
    card: 'swu-LAW-018',
    name: 'Lando Calrissian',
    subtitle: 'Full Sabacc',
    text: '[Action [[1], Arrow]:] Choose an aspect, then discard a card from a deck. If it has the chosen aspect, create a Credit token.',
    backText: '[When Deployed:] You may defeat a friendly Credit token. If you do, create 3 Credit tokens.',
    front: {
      actions: [{ label: 'an aspect, a card discarded from a deck, a Credit token on a match', resources: 1, exhaust: true, run: landoSabacc }],
    },
    back: {
      whenDeployed: (g, self) => {
        const p = self.controller
        if (!g.credits(p)) return
        if (!g.may(p, 'Lando Calrissian: defeat a Credit token to create 3 Credit tokens?', { yes: 'Defeat it', no: 'Skip', source: self.def.id })) return
        if (g.defeatCredit(p)) g.createCredit(p, 3)
      },
    },
  },
  {
    card: 'swu-HMW-218',
    name: 'New Tactics',
    text: 'Choose a non-leader unit. Its owner puts it on the top or bottom of their deck.',
    front: {
      play: (g, self) => {
        const ids = all(g, (u) => !g.isLeader(u))
        const target = g.chooseOne(self.controller, 'New Tactics: choose a non-leader unit', ids, {
          ai: mostThreat(g, enemy(g, self, (u) => !g.isLeader(u))) ?? 'harm',
          source: self.def.id,
        })
        if (target) ownerToDeck(g, self, target)
      },
    },
  },
  {
    card: 'swu-SOR-236',
    name: 'R2-D2',
    subtitle: 'Ignoring Protocol',
    text: '[When Played/On Attack:] Look at the top card of your deck. You may put it on the bottom of your deck.',
    front: { whenPlayed: topToBottom, onAttack: topToBottom },
  },
  {
    card: 'swu-LAW-089',
    name: 'Kanan Jarrus',
    subtitle: 'Spectre One',
    text: "[Restore 1]\n[When Played:] You may return a non-leader unit that costs 2 or less to its owner's hand. If you control a [Command] or [Aggression] unit, you may return a non-leader unit that costs 4 or less instead.",
    front: { whenPlayed: kanan },
  },
  {
    card: 'swu-IC27-157',
    name: 'The Mandalorian',
    subtitle: 'From the Shadows',
    text: '[Shielded]\n[On Attack:] If the defending unit is exhausted, it gets -4/-0 for this attack.',
    front: {
      onAttack: (g, self) => {
        const target = self.attack?.target
        const defender = target && target !== 'base' ? g.unit(target) : undefined
        if (defender?.exhausted) g.buff(defender.id, -4, 0, 'attack')
      },
    },
  },
  {
    card: 'swu-IC27-035',
    name: 'Yoda',
    subtitle: 'A Disturbing Puzzle',
    text: '[On Attack:] You may choose an enemy unit. Prevent all combat damage that would be dealt to and dealt by that unit for this phase.',
    front: { onAttack: yodaPuzzle },
  },
  {
    card: 'swu-IC27-151',
    name: 'R2-D2',
    subtitle: 'The First Protagonist',
    text: '[On Attack:] Choose one:\n• Ready a resource.\n• Deal 1 damage to a ground unit.\n• Look at the top card of your deck. You may discard it.',
    front: { onAttack: r2Protagonist },
  },
  {
    card: 'swu-SEC-046',
    name: 'Galen Erso',
    subtitle: "You'll Never Win",
    text: '[When Played:] Name a card. While this unit is in play, each non-leader card an opponent owns with that name, including those not in play, loses all abilities.\n[Plot]',
    front: { whenPlayed: galenErso },
  },
  {
    card: 'swu-IC27-043',
    name: 'Raddus',
    subtitle: 'Hope of the Resistance',
    text: '[Restore 3]\nWhile this unit is exhausted, cards your opponents play cost [3] more.',
    front: { taxesOpponents: (g, self) => (g.unit(self.id)?.exhausted ? 3 : 0) },
  },
  {
    card: 'swu-LOF-200',
    name: 'Qui-Gon Jinn',
    subtitle: 'The Negotiations Will Be Short',
    text: '[Ambush]\n[When Defeated:] You may choose a non-leader ground unit. Its owner puts it on the top or bottom of their deck.',
    front: {
      whenDefeated: (g, self) => {
        const ids = all(g, (u) => !g.isLeader(u) && u.arena === 'ground')
        const foes = enemy(g, self, (u) => !g.isLeader(u) && u.arena === 'ground')
        const pick = g.chooseOne(self.controller, 'Qui-Gon Jinn: you may choose a non-leader ground unit; its owner puts it on the top or bottom of their deck', ids, {
          optional: true,
          ai: mostThreat(g, foes) ?? foes[0] ?? 'none',
          source: self.def.id,
        })
        if (pick) ownerToDeck(g, self, pick)
      },
    },
  },
  {
    card: 'swu-HMW-078',
    name: 'Qui-Gon Jinn',
    subtitle: "We'll Handle This",
    text: "[Grit]\n[When Played:] You may defeat a unit that attacked your base this phase. If it's a leader unit, defeat this unit.",
    front: {
      whenPlayed: (g, self) => {
        const ids = g.attackedBase(self.controller).filter((id) => g.unit(id) && g.controller(g.unit(id)!) !== self.controller)
        if (!ids.length) return
        const pick = g.chooseOne(self.controller, 'Qui-Gon Jinn: you may defeat a unit that attacked your base this phase', ids, {
          optional: true,
          ai: mostThreat(g, ids) ?? ids[0],
          source: self.def.id,
        })
        if (!pick) return
        const leader = g.isLeader(g.unit(pick)!)
        g.defeat(pick, self)
        if (leader) g.defeat(self.id, self)
      },
    },
  },
  {
    card: 'swu-IC27-163',
    name: 'Bo-Katan Kryze',
    subtitle: 'Right Place, Right Time',
    text: '[Shielded]\n[When Played:] Give each enemy unit -7/-0 for this phase.',
    front: {
      whenPlayed: (g, self) => {
        for (const id of enemy(g, self)) g.buff(id, -7, 0, 'phase')
      },
    },
  },
  // --- Kylo10 green (2026-11-25) ---
  {
    card: 'swu-SEC-082',
    name: 'Chancellor Palpatine',
    subtitle: 'I Am The Senate',
    text: '[When Played:] If you control a leader unit, create 2 Spy tokens and give those tokens [Sentinel] for this phase.\n[Plot]',
    front: {
      whenPlayed: (g, self) => {
        if (!friendly(g, self, (u) => g.isLeader(u)).length) return
        for (let i = 0; i < 2; i++) g.grant(g.createToken(self.controller, 'Spy'), { sentinel: true }, 'phase', self.def.id)
      },
    },
  },
  {
    card: 'swu-IC27-003',
    name: 'Kylo Ren',
    subtitle: 'Supreme Leader',
    text: '[Action [Arrow, discard a card from your hand]:] Give an Experience token to a unit.',
    backText: '[When Deployed:] You may return a unit from your discard pile to your hand.',
    front: {
      actions: [
        {
          label: 'Discard a card: give an Experience token to a unit',
          exhaust: true,
          can: (g, self) => g.player(self.controller).hand.length > 0 && friendly(g, self).length > 0,
          run: (g, self) => {
            const p = self.controller
            kyloDiscard(g, p, self.def.id)
            // With Reforge in hand: the unit it will reforge, one with an Experience token that can
            // still attack, its power up for the upgrade it finds (Craving Power: 5 damage)
            const reforge = g.player(p).hand.some((c) => g.def(c).name === 'Reforge')
            const holder = reforge
              ? friendly(g, self, (u) => g.tokens(u.id, 'Experience') > 0 && g.canAttack(u.id)).sort((a, b) => g.power(g.unit(b)!) - g.power(g.unit(a)!))[0]
              : undefined
            const pick = g.chooseOne(p, 'Kylo Ren: give an Experience token to a unit', all(g), { ai: holder ?? 'help', ...(holder && { firm: true }), source: self.def.id })
            if (pick) g.giveToken(pick, 'Experience')
          },
        },
      ],
    },
    back: {
      whenDeployed: (g, self) => {
        const p = self.controller
        const ids = g.player(p).discard.filter((c) => g.def(c).type === 'unit').map((c) => c.id)
        if (!ids.length) return
        const dearest = [...ids].sort((a, b) => g.def(g.card(b)!).cost - g.def(g.card(a)!).cost)[0]
        const pick = g.chooseOne(p, 'Kylo Ren: you may return a unit from your discard pile to your hand', ids, { optional: true, ai: dearest, source: self.def.id })
        if (pick) g.fromDiscard(p, pick)
      },
    },
  },
  {
    card: 'swu-LAW-022',
    name: 'Aldhani Garrison',
    text: '[Epic Action:] Play a card from your hand, ignoring 1 of its [Vigilance], [Command], [Aggression], or [Cunning] aspect penalties.',
    front: {
      actions: [
        {
          label: 'Epic Action: play a card, ignoring 1 aspect penalty',
          can: (g, self) => !g.usedOnce(self) && garrisonCards(g, self.controller).length > 0,
          run: (g, self) => {
            const p = self.controller
            const ids = garrisonCards(g, p)
            const wanted = [...ids].sort((a, b) => garrisonWorth(g, b) - garrisonWorth(g, a))[0]
            const pick = g.chooseOne(p, 'Aldhani Garrison: play a card, ignoring 1 aspect penalty', ids, { ai: wanted, firm: true, source: self.def.id })
            if (!pick) return
            g.useOnce(self)
            g.playCard(p, pick, { discount: 2 })
          },
        },
      ],
    },
  },
  {
    card: 'swu-HMW-108',
    name: 'The First Legion',
    subtitle: "Vader's Fist",
    text: '[On Attack:] Name a [{Trait}]. Enemy cards, including those not in play, lose that [{Trait}] for this phase.',
    front: {
      onAttack: (g, self) => {
        const foe = g.other(self.controller)
        const pl = g.player(foe)
        const cards = [...pl.hand, ...pl.deck, ...pl.discard, ...pl.resources.map((r) => r.card), ...g.units((u) => u.owner === foe), pl.leader]
        const traits = [...new Set(cards.flatMap((c) => g.def(c).traits))].sort()
        if (!traits.length) return
        // The AI: the trait the enemy cards in play ask for most ("each other friendly [Rebel]"),
        // else the one most of their units have
        const inPlay = g.units((u) => g.controller(u) === foe)
        const texts = [...inPlay.flatMap((u) => [g.def(u), ...u.upgrades.map((x) => g.def(x))]), g.def(pl.leader), g.def(pl.base)].map((d) => `${d.text ?? ''}\n${d.backText ?? ''}`)
        const score = (t: string) => 10 * texts.filter((x) => x.includes(`{${t}}`)).length + inPlay.filter((u) => g.def(u).traits.includes(t)).length
        const wanted = [...traits].sort((a, b) => score(b) - score(a))[0]
        const pick = g.option(self.controller, 'The First Legion: name a trait', traits, { ai: traits.indexOf(wanted), source: self.def.id })
        g.loseTrait(foe, traits[pick])
      },
    },
  },
  {
    card: 'swu-IC27-086',
    name: 'Enfys Nest',
    subtitle: 'No More!',
    text: '[Ambush]\nWhile attacking a unit that costs 3 or less, this unit gets +2/+0 and gains [Overwhelm].',
    front: {
      gives: (g, self, unit) => {
        if (unit.id !== self.id || g.attack?.attacker !== self.id || g.attack.target === 'base') return undefined
        const target = g.unit(g.attack.target)
        return target && g.cost(target) <= 3 ? { power: 2, keywords: { overwhelm: true } } : undefined
      },
    },
  },
  {
    card: 'swu-IC27-056',
    name: 'Allegiant General Pryde',
    subtitle: 'Heartless Efficiency',
    text: '[When Defeated:] Give an Experience token to the friendly unit with the most power.',
    front: {
      whenDefeated: (g, self) => {
        const ids = friendly(g, self, (u) => u.id !== self.id)
        if (!ids.length) return
        const most = Math.max(...ids.map((id) => g.power(g.unit(id)!)))
        const top = ids.filter((id) => g.power(g.unit(id)!) === most)
        const pick =
          top.length > 1
            ? g.chooseOne(self.controller, 'Allegiant General Pryde: give an Experience token to the friendly unit with the most power', top, { ai: 'help', source: self.def.id })
            : top[0]
        if (pick) g.giveToken(pick, 'Experience')
      },
    },
  },
  {
    card: 'swu-SEC-111',
    name: 'Jar Jar Binks',
    subtitle: 'Mesa Propose…',
    text: '[When Played:] You may give another friendly unit [+2/+2] for this phase.\n[Plot]',
    front: {
      whenPlayed: (g, self) => {
        const ids = friendly(g, self, (u) => u.id !== self.id)
        if (!ids.length) return
        // The AI: the unit about to attack, a leader unit just deployed first (Kylo Ren to 7/5,
        // the user, 2026-11-25), else the strongest
        const worth = (id: string) => {
          const u = g.unit(id)!
          return (g.canAttack(id) ? 20 : 0) + (g.isLeader(u) ? 10 : 0) + g.power(u)
        }
        const best = [...ids].sort((a, b) => worth(b) - worth(a))[0]
        const pick = g.chooseOne(self.controller, 'Jar Jar Binks: you may give another friendly unit +2/+2 for this phase', ids, {
          optional: true,
          ai: best,
          firm: true,
          source: self.def.id,
        })
        if (pick) g.buff(pick, 2, 2, 'phase')
      },
    },
  },
  {
    card: 'swu-HMW-134',
    name: 'Zam Wesell',
    subtitle: 'Not What She Seems',
    text: "[Hidden]\nThis unit gains each friendly leader's [[{Traits}]] except [{Force}], even while she's not in play.",
    front: {
      gives: (g, self, unit) => {
        if (unit.id !== self.id) return undefined
        const traits = g.def(g.player(self.controller).leader).traits.filter((t) => t !== 'Force')
        return traits.length ? { traits } : undefined
      },
    },
  },
  {
    card: 'swu-ASH-135',
    name: 'The Darksaber',
    subtitle: 'Icon of Leadership',
    text: 'Attach to a [{Unique}] non-[{Vehicle}] unit.\nAttached unit is a leader unit and gains the [{Mandalorian}] trait.\nAttached unit gains: "While you are paying costs, this unit provides its aspect icons."',
    front: {
      gives: (_g, self, unit) => (unit.id === self.attachedTo ? { traits: ['Mandalorian'] } : undefined),
    },
  },
  {
    card: 'swu-LOF-105',
    name: 'Oppo Rancisis',
    subtitle: 'Ancient Councilor',
    text: 'This unit gains [Ambush] while another friendly unit has [Ambush]. The same is true for [Grit], [Hidden], [Overwhelm], [Saboteur], [Sentinel], and [Shielded].\nThis unit gains [Raid 2] while another friendly unit has [{Keyword}]Raid{/keyword}. The same is true for [{Keyword}]Restore{/keyword}.',
    front: {
      gives: (g, self, unit) => {
        if (unit.id !== self.id || oppoLooking) return undefined
        oppoLooking = true
        try {
          const others = friendly(g, self, (u) => u.id !== self.id).map((id) => g.keywords(g.unit(id)!))
          const has = (k: keyof Keywords) => others.some((kw) => !!kw[k])
          const keywords: Keywords = {}
          for (const k of ['ambush', 'grit', 'hidden', 'overwhelm', 'saboteur', 'sentinel', 'shielded'] as const) if (has(k)) keywords[k] = true
          if (has('raid')) keywords.raid = 2
          if (has('restore')) keywords.restore = 2
          return Object.keys(keywords).length ? { keywords } : undefined
        } finally {
          oppoLooking = false
        }
      },
    },
  },
  {
    card: 'swu-LOF-082',
    name: 'Vaneé',
    subtitle: 'I Live to Serve',
    text: '[When Played/On Attack:] You may defeat an Experience token on a friendly unit. If you do, give an Experience token to a friendly unit.',
    front: {
      whenPlayed: (g, self) => vanee(g, self),
      onAttack: (g, self) => vanee(g, self),
    },
  },
  {
    card: 'swu-ASH-097',
    name: 'Moff Gideon',
    subtitle: 'Remnant Commander',
    text: '[Sentinel]\n[When Defeated:] You may return a non-[{Unique}] [{Imperial}] unit from your discard pile to your hand.',
    front: {
      whenDefeated: (g, self) => {
        const p = self.controller
        const ids = g.player(p).discard.filter((c) => g.def(c).type === 'unit' && !g.def(c).unique && g.hasTrait(c, 'Imperial')).map((c) => c.id)
        if (!ids.length) return
        const dearest = [...ids].sort((a, b) => g.def(g.card(b)!).cost - g.def(g.card(a)!).cost)[0]
        const pick = g.chooseOne(p, 'Moff Gideon: you may return a non-unique Imperial unit from your discard pile to your hand', ids, { optional: true, ai: dearest, source: self.def.id })
        if (pick) g.fromDiscard(p, pick)
      },
    },
  },
  {
    card: 'swu-LOF-091',
    name: 'Craving Power',
    text: "Attach to a friendly unit.\n[When Played:] Deal damage to an enemy unit equal to attached unit's power.",
    front: {
      whenPlayed: (g, self) => {
        const host = self.attachedTo ? g.unit(self.attachedTo) : undefined
        const ids = enemy(g, self)
        if (!host || !ids.length) return
        const amount = g.power(host)
        const pick = g.chooseOne(self.controller, `Craving Power: deal ${amount} damage to an enemy unit`, ids, { ai: bestHit(g, self, ids, amount) ?? 'harm', source: self.def.id })
        if (pick) g.damage(pick, amount, self)
      },
    },
  },
  {
    card: 'swu-HMW-114',
    name: 'Breach',
    text: 'A friendly unit deals damage equal to its power to an enemy unit in its arena. If the friendly unit has [Overwhelm], deal deal excess damage to an enemy base.',
    front: {
      play: (g, self) => {
        const p = self.controller
        const pairs = friendly(g, self, (u) => g.power(u) > 0).flatMap((f) => enemy(g, self, (e) => e.arena === g.unit(f)!.arena).map((e) => ({ f, e })))
        if (!pairs.length) return
        // The AI: the dearest unit it defeats, else the most threatening, by its strongest unit
        const worth = ({ f, e }: { f: string; e: string }) => {
          const from = g.unit(f)!
          const to = g.unit(e)!
          const kills = g.power(from) >= g.hp(to) - to.damage && !g.tokens(e, 'Shield')
          return (kills ? 100 + 10 * g.cost(to) : readyThreat(g, e)) + (kills ? -0.1 : 0.1) * g.power(from)
        }
        const best = [...pairs].sort((a, b) => worth(b) - worth(a))[0]
        const f = g.chooseOne(p, 'Breach: a friendly unit deals damage equal to its power', [...new Set(pairs.map((x) => x.f))], { ai: best.f, firm: true, source: self.def.id })
        const from = f ? g.unit(f) : undefined
        if (!from) return
        const amount = g.power(from)
        const targets = enemy(g, self, (u) => u.arena === from.arena)
        const e = g.chooseOne(p, `Breach: ${g.name(from.id)} deals ${amount} damage to an enemy unit in its arena`, targets, {
          ai: best.f === f ? best.e : (bestHit(g, self, targets, amount) ?? 'harm'),
          source: self.def.id,
        })
        const to = e ? g.unit(e) : undefined
        if (!to) return
        const left = g.tokens(to.id, 'Shield') ? Infinity : g.hp(to) - to.damage
        const source = { id: from.id, controller: p, def: g.def(from) }
        const overwhelm = !!g.keywords(from).overwhelm
        g.damage(to.id, amount, source)
        if (overwhelm && amount > left) g.damage(baseOf(g.other(p)), amount - left, source)
      },
    },
  },
  {
    card: 'swu-IC27-063',
    name: "Kylo's TIE Silencer",
    subtitle: 'Follow My Lead',
    text: '[Restore 1]\n[When this unit is discarded from your hand:] For this phase, you may play it from your discard pile (paying its cost).',
    front: {
      discardPlay: (g, self) => g.discardedFromHandThisPhase(self.id),
    },
  },
  {
    card: 'swu-IC27-087',
    name: 'Issue a Command',
    text: "Reveal the top card of your deck. If it's a unit, draw it.\nGive an Experience token to a friendly unit.\nResource this event.",
    front: {
      toResources: true,
      play: (g, self) => {
        const p = self.controller
        const [top] = g.top(p, 1)
        if (top) {
          g.log(`${g.player(p).name} reveals ${g.def(top).name}`, p)
          if (g.def(top).type === 'unit') g.draw(p, 1)
        }
        const pick = g.chooseOne(p, 'Issue a Command: give an Experience token to a friendly unit', friendly(g, self), { ai: 'help', source: self.def.id })
        if (pick) g.giveToken(pick, 'Experience')
      },
    },
  },
  // --- Kylo10 blue reforge (2026-11-25) ---
  {
    card: 'swu-ASH-115',
    name: 'The Student Guides the Master',
    text: 'Give a friendly unit +1/+0 for this phase for each other friendly unit with less power than it.',
    front: {
      play: (g, self) => {
        const ids = friendly(g, self)
        if (!ids.length) return
        const bonus = (id: string) => friendly(g, self, (u) => u.id !== id && g.power(u) < g.power(g.unit(id)!)).length
        // The AI: the unit about to attack that gains most, a leader unit first
        const worth = (id: string) => bonus(id) + (g.canAttack(id) ? 10 : 0) + (g.isLeader(g.unit(id)!) ? 0.5 : 0)
        const best = [...ids].sort((a, b) => worth(b) - worth(a))[0]
        const pick = g.chooseOne(self.controller, 'The Student Guides the Master: give a friendly unit +1/+0 for each other friendly unit with less power', ids, { ai: best, firm: true, source: self.def.id })
        if (pick && bonus(pick)) g.buff(pick, bonus(pick), 0, 'phase')
      },
    },
  },
  {
    card: 'swu-LOF-062',
    name: 'Axe Woves',
    subtitle: 'Accomplished Warrior',
    text: '[Shielded]\nThis unit gets [+1/+1] for each upgrade on him.',
    front: {
      gives: (_g, self, unit) => (unit.id === self.id && unit.upgrades.length ? { power: unit.upgrades.length, hp: unit.upgrades.length } : undefined),
    },
  },
  {
    card: 'swu-ASH-090',
    name: 'Reforge',
    text: 'Defeat an upgrade on a friendly unit. If you do, search the top 8 cards of your deck for an upgrade that can attach to that unit, reveal it, and play it on that unit. It costs [4] less.',
    front: {
      play: (g, self) => {
        const p = self.controller
        const upgrades = g.upgrades().filter((u) => u.unit && g.controller(u.unit) === p)
        if (!upgrades.length) return
        // The AI: the upgrade worth least (a token: the Experience given on turn 1), on a unit that
        // can still attack, the strongest, which gets the new one (the user, 2026-11-25)
        const worth = (u: (typeof upgrades)[number]) =>
          (g.def(u).token ? (g.def(u).name === 'Shield' ? 1.5 : 1) : g.def(u).cost) - 0.1 * g.power(u.unit!) - (g.canAttack(u.unit!.id) ? 2 : 0)
        const cheapest = [...upgrades].sort((a, b) => worth(a) - worth(b))[0]
        // The unit first, then which of its upgrades (the user, 2026-11-26: clearer than every
        // upgrade at once); one upgrade on it is that one
        const holders = [...new Set(upgrades.map((u) => u.unit!.id))]
        const holder = g.chooseOne(p, 'Reforge: choose a friendly unit with an upgrade', holders, { ai: cheapest.unit!.id, source: self.def.id })
        const on = upgrades.filter((u) => u.unit!.id === holder)
        if (!on.length) return
        const best = [...on].sort((a, b) => worth(a) - worth(b))[0]
        const pick =
          on.length === 1 ? on[0].id : g.chooseOne(p, `Reforge: defeat an upgrade on ${g.name(holder!)}`, on.map((u) => u.id), { ai: best.id, source: self.def.id })
        const chosen = upgrades.find((u) => u.id === pick)
        if (!chosen?.unit) return
        const unitId = chosen.unit.id
        g.defeatUpgrade(chosen.id)
        if (!g.unit(unitId)) return
        const top = g.top(p, 8)
        const found = top.filter((c) => g.def(c).type === 'upgrade' && g.attachable(p, g.def(c), [unitId]).length).map((c) => c.id)
        // Craving Power while there is an enemy unit to hit (1 resource), else The Darksaber (a
        // leader unit, out of reach of much removal), else the dearest
        const rank = (id: string) => {
          const d = g.def(g.card(id)!)
          return (d.name === 'Craving Power' && enemy(g, self).length ? 100 : 0) + (d.name === 'The Darksaber' ? 50 : 0) + d.cost
        }
        const dearest = [...found].sort((a, b) => rank(b) - rank(a))[0]
        const text = found.length ? 'Reforge: search the top 8 cards of your deck for an upgrade to play on that unit (it costs 4 less)' : 'Reforge: no upgrade for that unit in the top 8 cards of your deck'
        const take = g.chooseOne(p, text, found, { ai: dearest, source: self.def.id, seen: top.map((c) => c.id) })
        if (take) {
          g.reveal(p, [take], self)
          if (!g.playCard(p, take, { discount: 4, onto: [unitId], prefer: unitId })) g.drawCard(p, take)
        } else g.log('Reforge finds nothing', p)
        g.shuffleToBottom(p, g.top(p, 8).filter((c) => top.some((t) => t.id === c.id)).map((c) => c.id))
      },
    },
  },
  {
    card: 'swu-LOF-070',
    name: 'Anakin Skywalker',
    subtitle: 'Champion of Mortis',
    text: '[When Played:] If there is a [Heroism] card in your discard pile, you may give a unit -3/-3 for this phase.\n[When Played:] If there is a [Villainy] card in your discard pile, you may give a unit -3/-3 for this phase.',
    front: {
      whenPlayed: (g, self) => {
        const discard = g.player(self.controller).discard
        const aspects = (['Heroism', 'Villainy'] as Aspect[]).filter((a) => discard.some((c) => g.def(c).aspects.includes(a)))
        const plan = anakinPlan(g, self, aspects.length)
        aspects.forEach((aspect, i) => {
          const target = [plan[i], ...plan].find((id) => id && g.unit(id))
          shrinkOn(g, self, 3, `Anakin Skywalker (${aspect}): you may give a unit -3/-3 for this phase`, target)
        })
      },
    },
  },
  {
    card: 'swu-HMW-064',
    name: 'Scorch',
    subtitle: 'Imperial Commando',
    text: '[On Attack:] You may deal 1 damage to an upgrade unit.',
    front: {
      onAttack: (g, self) => {
        const ids = all(g, (u) => u.upgrades.length > 0)
        if (!ids.length) return
        const pick = g.chooseOne(self.controller, 'Scorch: you may deal 1 damage to an upgraded unit', ids, { optional: true, ai: bestHit(g, self, ids, 1) ?? undefined, source: self.def.id })
        if (pick) g.damage(pick, 1, self)
      },
    },
  },
  {
    card: 'swu-LAW-129',
    name: 'Mastery',
    text: 'This upgrade costs [1] less to play on a [{Unique}] unit.',
    front: {
      costsLessOnto: (g, _p, unit) => (g.def(unit).unique ? 1 : 0),
    },
  },
  {
    card: 'swu-JTL-088',
    name: 'Captain Phasma',
    subtitle: 'On My Command',
    text: '[When Played/On Attack:] You may give another {first order} unit [+2/+2] for this phase.',
    front: {
      whenPlayed: (g, self) => phasma(g, self),
      onAttack: (g, self) => phasma(g, self),
    },
  },
  {
    card: 'swu-LOF-059',
    name: 'Nightsister Warrior',
    text: '[When Defeated:] Draw a card.',
    front: {
      whenDefeated: (g, self) => g.draw(self.controller, 1),
    },
  },
  {
    card: 'swu-LOF-031',
    name: 'Karis',
    subtitle: "We Don't Like Strangers",
    text: '[When Defeated:] You may use the Force. If you do, give a unit -2/-2 for this phase.',
    front: {
      whenDefeated: (g, self) => {
        const p = self.controller
        if (!g.hasForce(p)) return
        const target = shrinkTarget(g, self, 2)
        if (!g.may(p, 'Karis: use the Force to give a unit -2/-2 for this phase?', { yes: 'Use the Force', no: 'Keep it', ai: !!target, source: self.def.id })) return
        if (g.useForce(p)) shrink(g, self, 2, 'Karis: give a unit -2/-2 for this phase', false)
      },
    },
  },
  {
    card: 'swu-LOF-102',
    name: "Yoda's Lightsaber",
    text: 'Attach to a non-[{Vehicle}] unit.\n[When Played:] You may use the [{Force}]. If you do, heal 3 damage from a base.',
    front: {
      whenPlayed: (g, self) => {
        const p = self.controller
        if (!g.hasForce(p)) return
        // The AI heals its own base when it has taken damage
        // ... unless a card in hand wants the Force (Darth Tyranus, Talzin's Assassin)
        const own = g.player(p).base.damage > 0 && !g.player(p).hand.some((c) => /the Force is with you, this unit gains|use the Force/i.test(g.def(c).text ?? ''))
        if (!g.may(p, "Yoda's Lightsaber: use the Force to heal 3 damage from a base?", { yes: 'Use the Force', no: 'Keep it', ai: own, source: self.def.id })) return
        if (!g.useForce(p)) return
        const pick = g.chooseOne(p, "Yoda's Lightsaber: heal 3 damage from a base", [baseOf(p), baseOf(g.other(p))], { ai: baseOf(p), source: self.def.id })
        if (pick) g.heal(pick, 3, self)
      },
    },
  },
  {
    card: 'swu-SEC-052',
    name: 'Diplomatic Immunity',
    text: 'Attached unit gains: "[When this unit is attacked:] You may disclose [Vigilance][Vigilance][Heroism][Heroism] (reveal cards from your hand with these aspect icons among them). If you do, the attacker gets -2/-0 for this attack."',
    front: {
      attachedWhenDefending: (g, self) => {
        if (!self.other || !g.unit(self.other)) return
        if (!disclose(g, self, ['Vigilance', 'Vigilance', 'Heroism', 'Heroism'])) return
        g.log(`${g.name(self.other)} gets -2/-0 for this attack`, self.controller)
        g.buff(self.other, -2, 0, 'attack')
      },
    },
  },
  // --- 2026-11-26 ---
  {
    card: 'swu-LOF-020',
    name: 'Nightsister Lair',
    text: '[When a friendly [{Force}] unit attacks:] The Force is with you.',
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
    card: 'swu-LOF-231',
    name: 'Darth Tyranus',
    subtitle: 'Servant of Sidious',
    text: '[Shielded]\nWhile the Force is with you, this unit gains [Ambush].',
    front: {
      gives: (g, self, unit) => (unit.id === self.id && g.hasForce(self.controller) ? { keywords: { ambush: true } } : undefined),
    },
  },
  {
    card: 'swu-LOF-035',
    name: "Talzin's Assassin",
    text: '[When Played:] You may use the Force. If you do, give a unit -3/-3 for this phase.',
    front: {
      whenPlayed: (g, self) => {
        const p = self.controller
        if (!g.hasForce(p)) return
        // The AI: when the -3/-3 defeats an enemy unit, or takes 3 power off one with 4 or more
        const target = shrinkTarget(g, self, 3) ?? enemy(g, self, (u) => g.power(u) >= 4).sort((a, b) => g.power(g.unit(b)!) - g.power(g.unit(a)!))[0]
        if (!g.may(p, "Talzin's Assassin: use the Force to give a unit -3/-3 for this phase?", { yes: 'Use the Force', no: 'Keep it', ai: !!target, source: self.def.id })) return
        if (!g.useForce(p)) return
        shrinkOn(g, self, 3, "Talzin's Assassin: give a unit -3/-3 for this phase", target)
      },
    },
  },
  {
    card: 'swu-LOF-229',
    name: 'Kylo Ren',
    subtitle: 'I Know Your Story',
    text: '[Overwhelm]\n[When you play an upgrade on this unit:] You may use the Force. If you do, draw a card.',
    front: {
      whenUpgradePlayedOn: (g, self) => {
        const p = self.controller
        if (!g.hasForce(p)) return
        // The AI draws, unless a card in hand wants the Force (Darth Tyranus, Talzin's Assassin)
        const keep = g.player(p).hand.some((c) => /the Force is with you, this unit gains|use the Force/i.test(g.def(c).text ?? ''))
        if (!g.may(p, 'Kylo Ren: use the Force to draw a card?', { yes: 'Use the Force', no: 'Keep it', ai: !keep, source: self.def.id })) return
        if (g.useForce(p)) g.draw(p, 1)
      },
    },
  },
  // --- Thorrk's Lando data vault (swuforge.com/decks/cmwm1475n0kbw01k6pk7tz53d), 2026-11-26 ---
  {
    // Its deck size is checked as the deck is built, not in a game
    card: 'swu-JTL-024',
    name: 'Data Vault',
    text: 'Your minimum deck size is increased by 10 cards.',
    front: {},
  },
  {
    card: 'swu-IC27-070',
    name: 'C-3PO',
    subtitle: 'Impulse Buy',
    text: '[Action [Arrow]:] Give an Experience token to another unit. Then, if it has 6 or more power, draw a card.',
    front: {
      actions: [
        {
          label: 'Experience token to another unit, a card at 6 power',
          exhaust: true,
          can: (g, self) => all(g).some((id) => id !== self.id),
          run: (g, self) => {
            const ids = all(g).filter((id) => id !== self.id)
            // The AI: a friendly unit it lifts to 6 power (a card too), else its strongest one
            const mine = friendly(g, self, (u) => u.id !== self.id)
            const draws = mine.filter((id) => g.power(g.unit(id)!) + 1 >= 6)
            const best = [...(draws.length ? draws : mine)].sort((a, b) => g.power(g.unit(b)!) - g.power(g.unit(a)!))[0]
            const pick = g.chooseOne(self.controller, 'C-3PO: give an Experience token to another unit', ids, { ai: best ?? 'help', ...(best && { firm: true }), source: self.def.id })
            if (!pick) return
            g.giveToken(pick, 'Experience')
            const unit = g.unit(pick)
            if (unit && g.power(unit) >= 6) g.draw(self.controller, 1)
          },
        },
      ],
    },
  },
  {
    card: 'swu-JTL-201',
    name: 'Ahsoka Tano',
    subtitle: 'Chasing Whispers',
    text: "[When Played:] An opponent discards a card from their hand. If it's a unit, you may exhaust a unit.",
    front: {
      whenPlayed: (g, self) => {
        const foe = g.other(self.controller)
        const hand = g.player(foe).hand.map((c) => c.id)
        if (!hand.length) return
        const [card] = g.choose(foe, 'Ahsoka Tano: discard a card from your hand', hand, { min: 1, max: 1, ai: 'discard', source: self.def.id })
        if (!card) return
        const unit = g.def(g.card(card)!).type === 'unit'
        g.discard(foe, card)
        if (!unit) return
        // The AI exhausts the enemy unit that would hit hardest
        const ready = enemy(g, self, (u) => !u.exhausted)
        const pick = g.chooseOne(self.controller, 'Ahsoka Tano: you may exhaust a unit', all(g), { optional: true, ai: mostThreat(g, ready) ?? 'none', source: self.def.id })
        if (pick) g.exhaust(pick)
      },
    },
  },
  {
    card: 'swu-JTL-207',
    name: 'Jam Communications',
    text: "Look at an opponent's hand and discard an event from it.",
    front: {
      play: (g, self) => {
        const p = self.controller
        const foe = g.other(p)
        const hand = g.player(foe).hand
        g.log(`${g.player(p).name} looks at ${g.player(foe).name}'s hand`, p)
        const events = hand.filter((c) => g.def(c).type === 'event').map((c) => c.id)
        // The AI takes their dearest event
        const dearest = [...events].sort((a, b) => g.def(g.card(b)!).cost - g.def(g.card(a)!).cost)[0]
        const pick = g.chooseOne(p, events.length ? 'Jam Communications: discard an event from their hand' : 'Jam Communications: no event in their hand', events, {
          ai: dearest ?? 'none',
          source: self.def.id,
          seen: hand.map((c) => c.id),
        })
        if (pick) g.discard(foe, pick)
      },
    },
  },
  {
    // "Opponents can't take control of this unit": nothing in these decks takes control
    card: 'swu-LAW-149',
    name: 'Rey',
    subtitle: 'Skywalker',
    text: "Opponents can't take control of this unit.\nThis unit can't be defeated by enemy card abilities.",
    front: {
      cantBeDefeatedByEnemyAbilities: true,
    },
  },
  {
    card: 'swu-SEC-209',
    name: 'The Mandalorian',
    subtitle: 'Cleaning Up Nevarro',
    text: '[Ambush]\n[When this unit attacks and defeats a unit:] You may choose an enemy non-leader unit. This unit captures it.',
    front: {
      whenAttackDefeats: (g, self) => {
        if (!g.unit(self.id)) return
        const ids = enemy(g, self, (u) => !g.isLeader(u))
        if (!ids.length) return
        const pick = g.chooseOne(self.controller, 'The Mandalorian: you may choose an enemy non-leader unit for him to capture', ids, { optional: true, ai: 'harm', source: self.def.id })
        if (pick) g.capture(self.id, pick)
      },
    },
  },
  // --- Thorrk's Piett Red (swuforge.com/decks/cmwt6zc640jlc01o1qaldkkpx), 2026-11-26 ---
  {
    card: 'swu-JTL-005',
    name: 'Admiral Piett',
    subtitle: 'Commanding the Armada',
    text: '[Action [Arrow]:] Play a {capital ship} unit from your hand. It costs [1] less.',
    backText: 'Each {capital ship} unit you play costs [2] less.',
    front: {
      actions: [
        {
          label: 'play a Capital Ship unit for 1 less',
          exhaust: true,
          can: (g, self) => capitalShips(g, self.controller).some((id) => g.canPlay(self.controller, id, { discount: 1 })),
          run: (g, self) => {
            const p = self.controller
            const ids = capitalShips(g, p).filter((id) => g.canPlay(p, id, { discount: 1 }))
            const pick = g.chooseOne(p, 'Admiral Piett: play a Capital Ship unit from your hand for 1 less', ids, { ai: 'best', source: self.def.id })
            if (pick) g.playCard(p, pick, { discount: 1 })
          },
        },
      ],
    },
    back: {
      costsLess: (_g, _self, card) => (card.type === 'unit' && card.traits.includes('Capital Ship') ? 2 : 0),
    },
  },
  {
    card: 'swu-ASH-118',
    name: '8D8',
    subtitle: "Daimyo's Majordomo",
    text: '[Hidden]\n[Action [Arrow]:] Deal 1 damage to another friendly unit. If you do, search the top 5 cards of your deck for a unit, reveal it, and draw it.',
    front: {
      actions: [
        {
          label: '1 damage to another friendly unit, a unit from the top 5',
          exhaust: true,
          can: (g, self) => friendly(g, self, (u) => u.id !== self.id).length > 0,
          run: (g, self) => {
            const p = self.controller
            // The AI: the friendly unit with the most HP to spare (no Shield token to lose)
            const ids = friendly(g, self, (u) => u.id !== self.id)
            const spare = (id: string) => {
              const u = g.unit(id)!
              return g.hp(u) - u.damage - (g.tokens(id, 'Shield') ? 3 : 0) - (g.isLeader(u) ? 2 : 0)
            }
            const best = [...ids].sort((a, b) => spare(b) - spare(a))[0]
            const pick = g.chooseOne(p, '8D8: deal 1 damage to another friendly unit', ids, { ai: best, firm: true, source: self.def.id })
            if (!pick || !g.damage(pick, 1, self)) return
            // The AI fixes its curve: the dearest unit it can pay for next round, else the cheapest
            const next = g.player(p).resources.length + 1
            const offCurve = ((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.AI_OFF ?? '').includes('8d8')
            searchDraw(g, self, 5, (c) => g.def(c).type === 'unit', 'a unit', offCurve ? undefined : (ids) => {
              const costs = ids.map((id) => ({ id, cost: g.def(g.card(id)!).cost }))
              return [...costs].filter((c) => c.cost <= next).sort((a, b) => b.cost - a.cost)[0]?.id ?? [...costs].sort((a, b) => a.cost - b.cost)[0]?.id
            })
          },
        },
      ],
    },
  },
  {
    card: 'swu-ASH-099',
    name: 'Gozanti Assault Carrier',
    text: '[Support]\n[On Attack:] This unit gains [Sentinel] for this phase.',
    front: {
      onAttack: (g, self) => {
        if (g.unit(self.id)) g.grant(self.id, { sentinel: true }, 'phase')
      },
    },
  },
  {
    card: 'swu-HMW-247',
    name: 'Surveillance Cruiser',
    text: '[When Played:] If an opponent controls an [{Endor}], [{Kashyyyk}], [{Naboo}], or [{Tatooine}] base, draw a card.',
    front: {
      whenPlayed: (g, self) => {
        const base = g.def(g.player(g.other(self.controller)).base)
        if (['Endor', 'Kashyyyk', 'Naboo', 'Tatooine'].some((t) => base.traits.includes(t))) g.draw(self.controller, 1)
      },
    },
  },
  {
    card: 'swu-IC27-129',
    name: 'DRK-1 Probe Droid',
    text: '[When Played:] You may defeat a non-[{Unique}] upgrade.',
    front: {
      whenPlayed: (g, self) => {
        const ups = g.upgrades().filter((u) => u.unit && !g.def(u).unique)
        if (!ups.length) return
        // The AI: an enemy upgrade, the dearest card first, then a Shield token, then Experience
        const worth = (u: (typeof ups)[number]) => (g.def(u).token ? (g.def(u).name === 'Shield' ? 2.5 : 1) : 2 + g.def(u).cost)
        const theirs = ups.filter((u) => u.controller !== self.controller).sort((a, b) => worth(b) - worth(a))
        const pick = g.chooseOne(self.controller, 'DRK-1 Probe Droid: you may defeat a non-unique upgrade', ups.map((u) => u.id), { optional: true, ai: theirs[0]?.id ?? 'none', source: self.def.id })
        if (pick) g.defeatUpgrade(pick)
      },
    },
  },
  {
    card: 'swu-IC27-136',
    name: 'Open Fire',
    text: 'Deal 4 damage to a unit.',
    front: {
      play: (g, self) => {
        const pick = g.chooseOne(self.controller, 'Open Fire: deal 4 damage to a unit', all(g), { ai: bestHit(g, self, enemy(g, self), 4) ?? 'harm', source: self.def.id })
        if (pick) g.damage(pick, 4, self)
      },
    },
  },
  {
    card: 'swu-IC27-068',
    name: 'Devastator',
    subtitle: "Lord Vader's Flagship",
    text: '[Overwhelm]\n[When Played:] Search the top 5 cards of your deck for a [Villainy] unit that costs 12 or less and play it for free.',
    front: {
      whenPlayed: (g, self) => {
        const p = self.controller
        const top = g.top(p, 5)
        const units = top.filter((c) => g.def(c).type === 'unit' && g.def(c).aspects.includes('Villainy') && g.def(c).cost <= 12 && g.canPlay(p, c.id, { free: true })).map((c) => c.id)
        // The AI: the dearest, unless it is racing: then what holds off damage (the user,
        // 2026-11-26): the other Devastator when its 4 indirect damage defeats an enemy unit, a
        // Sentinel (Moff Gideon), Interrogation Droid's exhaust
        const byCost = [...units].sort((a, b) => g.def(g.card(b)!).cost - g.def(g.card(a)!).cost)
        const base = g.player(p).base
        const left = g.def(base).hp - base.damage
        const foes = enemy(g, self)
        const racing = foes.reduce((sum, id) => sum + g.power(g.unit(id)!), 0) * 2 >= left
        const text = (id: string) => g.def(g.card(id)!).text ?? ''
        const kills = foes.some((id) => !g.isLeader(g.unit(id)!) && g.hp(g.unit(id)!) - g.unit(id)!.damage <= 4)
        const defensive =
          (kills ? byCost.find((id) => /Deal 4 indirect damage to each opponent/.test(text(id))) : undefined) ??
          byCost.find((id) => g.def(g.card(id)!).keywords.sentinel) ??
          byCost.find((id) => /^\[When Played:\] Exhaust an enemy unit/.test(text(id)))
        const off = ((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.AI_OFF ?? '').includes('devpick')
        const dearest = racing && defensive && !off ? defensive : byCost[0]
        const pick = g.chooseOne(p, 'Devastator: a Villainy unit from the top 5 cards of your deck to play for free', units, { ai: dearest ?? 'none', source: self.def.id, seen: top.map((c) => c.id) })
        if (pick) {
          g.reveal(p, [pick], self)
          g.playCard(p, pick, { free: true })
        } else g.log('Devastator finds no Villainy unit to play', p)
        g.shuffleToBottom(p, top.filter((c) => c.id !== pick && g.player(p).deck.some((d) => d.id === c.id)).map((c) => c.id))
      },
    },
  },
  {
    card: 'swu-JTL-131',
    name: 'Turbolaser Salvo',
    text: 'Choose an arena. A friendly space unit deals damage equal to its power to each enemy unit in that arena.',
    front: {
      play: (g, self) => {
        const p = self.controller
        const ships = friendly(g, self, (u) => u.arena === 'space')
        if (!ships.length) return
        // The AI: the arena and ship that defeat the most enemy cost
        const arenas = ['ground', 'space'] as const
        const score = (arena: (typeof arenas)[number], power: number) =>
          enemy(g, self, (u) => u.arena === arena).reduce((sum, id) => {
            const u = g.unit(id)!
            return sum + (g.hp(u) - u.damage <= power && !g.tokens(id, 'Shield') ? g.cost(u) + 1 : Math.min(power, g.hp(u) - u.damage) * 0.2)
          }, 0)
        const power = Math.max(...ships.map((id) => g.power(g.unit(id)!)))
        const best = score('space', power) > score('ground', power) ? 1 : 0
        const arena = arenas[g.option(p, 'Turbolaser Salvo: choose an arena', ['Ground', 'Space'], { ai: best, source: self.def.id })]
        const strongest = [...ships].sort((a, b) => g.power(g.unit(b)!) - g.power(g.unit(a)!))[0]
        const ship = g.chooseOne(p, 'Turbolaser Salvo: a friendly space unit to deal its power in damage', ships, { ai: strongest, firm: true, source: self.def.id })
        if (!ship) return
        const amount = g.power(g.unit(ship)!)
        for (const id of enemy(g, self, (u) => u.arena === arena)) if (g.unit(id)) g.damage(id, amount, { ...self, id: ship })
      },
    },
  },
  {
    card: 'swu-JTL-143',
    name: 'Devastator',
    subtitle: 'Hunting the Rebellion',
    text: 'You assign all indirect damage you deal to opponents.\n[When Played:] Deal 4 indirect damage to each opponent.',
    front: {
      assignsIndirect: true,
      whenPlayed: (g, self) => g.indirect(g.other(self.controller), 4, self),
    },
  },
  {
    card: 'swu-JTL-181',
    name: 'Planetary Bombardment',
    text: 'Deal 8 indirect damage to a player. If you control a {capital ship} unit, deal 12 indirect damage instead.',
    front: {
      play: (g, self) => {
        const p = self.controller
        const amount = friendly(g, self, (u) => g.hasTrait(u, 'Capital Ship')).length ? 12 : 8
        const who = g.option(p, `Planetary Bombardment: deal ${amount} indirect damage to a player`, [g.player(g.other(p)).name, g.player(p).name], { ai: 0, source: self.def.id })
        g.indirect(who === 0 ? g.other(p) : p, amount, self)
      },
    },
  },
  {
    card: 'swu-JTL-089',
    name: 'The Invisible Hand',
    subtitle: 'Crawling with Vultures',
    text: '[When Played/When this unit completes an attack:] You may search the top 8 cards of your deck for a [{Droid}] unit, reveal it, and draw it. If it costs 2 or less, you may play it for free.',
    front: {
      whenPlayed: (g, self) => invisibleHand(g, self),
      afterAttack: (g, self) => invisibleHand(g, self),
    },
  },
  {
    card: 'swu-LAW-058',
    name: 'Honor-Bound Partisan',
    text: '[When Played:] Deal 1 damage to a base.\n[When Defeated:] The next unit you play this phase costs [1] less.',
    front: {
      whenPlayed: (g, self) => {
        const p = self.controller
        const pick = g.chooseOne(p, 'Honor-Bound Partisan: deal 1 damage to a base', [baseOf(g.other(p)), baseOf(p)], { ai: baseOf(g.other(p)), firm: true, source: self.def.id })
        if (pick) g.damage(pick, 1, self)
      },
      whenDefeated: (g, self) => g.discountNext(self.controller, ':unit', 1),
    },
  },
  {
    card: 'swu-LAW-075',
    name: 'Interrogation Droid',
    text: '[When Played:] Exhaust an enemy unit. If you do, and that unit costs 3 or less, its controller discards a card from their hand.',
    front: {
      whenPlayed: (g, self) => {
        const ids = enemy(g, self, (u) => !u.exhausted)
        if (!ids.length) return
        // The AI: a ready one that costs 3 or less (a card discarded too), else the one that hits hardest
        const cheap = ids.filter((id) => g.cost(g.unit(id)!) <= 3)
        const pick = g.chooseOne(self.controller, 'Interrogation Droid: exhaust an enemy unit', ids, { ai: mostThreat(g, cheap.length ? cheap : ids) ?? 'harm', source: self.def.id })
        if (!pick) return
        g.exhaust(pick)
        const unit = g.unit(pick)
        if (unit && g.cost(unit) <= 3) g.discardChosen(g.controller(unit), 1, 'Interrogation Droid: discard a card from your hand', self.def.id)
      },
    },
  },
  {
    card: 'swu-SEC-110',
    name: 'GNK Power Droid',
    text: '[On Attack:] The next unit you play this phase costs [1] less.',
    front: {
      onAttack: (g, self) => g.discountNext(self.controller, ':unit', 1),
    },
  },
  {
    card: 'swu-SEC-180',
    name: "Let's Call It War",
    text: 'Deal 3 damage to a unit. Then, if you have the initiative, you may deal 2 damage to another unit in the same arena.',
    front: {
      play: (g, self) => {
        const p = self.controller
        const pick = g.chooseOne(p, "Let's Call It War: deal 3 damage to a unit", all(g), { ai: bestHit(g, self, enemy(g, self), 3) ?? 'harm', source: self.def.id })
        if (!pick) return
        const arena = g.unit(pick)!.arena
        g.damage(pick, 3, self)
        if (g.state.initiative !== p) return
        const others = all(g, (u) => u.id !== pick && u.arena === arena)
        if (!others.length) return
        const target = bestHit(g, self, enemy(g, self, (u) => u.id !== pick && u.arena === arena), 2)
        const second = g.chooseOne(p, "Let's Call It War: you may deal 2 damage to another unit in the same arena", others, { optional: true, ai: target ?? 'none', source: self.def.id })
        if (second) g.damage(second, 2, self)
      },
    },
  },
  // --- Luke Thermal oscillator (swudb.com/deck/wkbIVTYIXD), 2026-11-26 ---
  {
    // Its deck size is checked as the deck is built, not in a game
    card: 'swu-JTL-025',
    name: 'Thermal Oscillator',
    text: 'Your minimum deck size is decreased by 5 cards.',
    front: {},
  },
  {
    card: 'swu-IC27-123',
    name: 'Jyn Erso',
    subtitle: "Her Father's Revenge",
    text: '[Saboteur]\n[When Played:] Ready up to 3 units with combined cost 7 or less. They each gain [Saboteur] for this phase.',
    front: {
      whenPlayed: (g, self) => {
        const p = self.controller
        const ids = all(g, (u) => u.exhausted && u.id !== self.id && g.cost(u) <= 7)
        if (!ids.length) return
        // The AI: its exhausted units with the most power for 7 cost, up to 3
        const mine = friendly(g, self, (u) => u.exhausted && u.id !== self.id && g.cost(u) <= 7)
        let best: string[] = []
        let bestPower = 0
        const walk = (from: number, picked: string[], cost: number, power: number) => {
          if (power > bestPower) [best, bestPower] = [picked, power]
          if (picked.length === 3) return
          for (let i = from; i < mine.length; i++) {
            const u = g.unit(mine[i])!
            if (cost + g.cost(u) <= 7) walk(i + 1, [...picked, mine[i]], cost + g.cost(u), power + g.power(u))
          }
        }
        walk(0, [], 0, 0)
        const picks = g.choose(p, 'Jyn Erso: ready up to 3 units with combined cost 7 or less', ids, { min: 0, max: 3, ai: best.length ? `ids:${best.join(',')}` : 'none', source: self.def.id })
        let spent = 0
        for (const id of picks) {
          const u = g.unit(id)
          if (!u || spent + g.cost(u) > 7) continue
          spent += g.cost(u)
          g.ready(id)
          g.grant(id, { saboteur: true }, 'phase')
        }
      },
    },
  },
  {
    card: 'swu-LAW-183',
    name: 'B-Wing Skirmisher',
    text: '[When Played:] Deal 1 damage to each of up to 2 space units.',
    front: {
      whenPlayed: (g, self) => {
        const ids = all(g, (u) => u.arena === 'space' && u.id !== self.id)
        if (!ids.length) return
        // The AI: enemy space units 1 damage defeats, the dearest first, then the most threatening
        const foes = enemy(g, self, (u) => u.arena === 'space')
        const left = (id: string) => g.hp(g.unit(id)!) - g.unit(id)!.damage
        const dies = (id: string) => Number(left(id) <= 1 && !g.tokens(id, 'Shield'))
        const order = [...foes].sort((a, b) => dies(b) - dies(a) || threat(g, b) - threat(g, a))
        const picks = g.choose(self.controller, 'B-Wing Skirmisher: deal 1 damage to each of up to 2 space units', ids, { min: 0, max: 2, ai: order.length ? `ids:${order.slice(0, 2).join(',')}` : 'none', source: self.def.id })
        for (const id of picks) if (g.unit(id)) g.damage(id, 1, self)
      },
    },
  },
  {
    card: 'swu-LOF-153',
    name: 'Paz Vizsla',
    subtitle: 'Unyielding Warrior',
    text: 'This unit gets [+2/+0] for each damage on him.',
    front: {
      gives: (_g, self, unit) => (unit.id === self.id && unit.damage ? { power: 2 * unit.damage } : undefined),
    },
  },
  {
    card: 'swu-HMW-166',
    name: 'Gungi',
    subtitle: 'Fighting for Kashyyyk',
    text: '[Grit]\n[When this unit is dealt damage and survives:] You may discard a card from your hand. If you do, ready this unit.',
    front: {
      whenDealtDamage: (g, self) => {
        const unit = g.unit(self.id)
        const p = self.controller
        if (!unit || !unit.exhausted || !g.player(p).hand.length) return
        // The AI: while the action phase goes on, to attack again: during its own attack (Sith
        // Holocron's 2 damage on itself, the deck's turn-3 combo) whatever the card, else
        // keeping a card besides
        const own = g.state.attack?.attacker === self.id
        const yes = g.state.phase === 'action' && (own || g.player(p).hand.length >= 2)
        if (!g.may(p, 'Gungi: discard a card from your hand to ready him?', { yes: 'Discard', no: 'Skip', ai: yes, source: self.def.id })) return
        g.discardChosen(p, 1, 'Gungi: discard a card from your hand', self.def.id)
        g.ready(self.id)
      },
    },
  },
  {
    card: 'swu-IC27-120',
    name: 'Rey',
    subtitle: 'Embracing Destiny',
    text: '[Action [[1], discard a card from your hand]:] Attack with a unit. It gets +2/+0 for this attack.',
    front: {
      actions: [
        {
          label: 'discard a card: attack with a unit, +2/+0',
          resources: 1,
          can: (g, self) => g.player(self.controller).hand.length > 0 && friendly(g, self).some((id) => g.canAttack(id)),
          run: (g, self) => {
            const p = self.controller
            g.discardChosen(p, 1, 'Rey: discard a card from your hand', self.def.id)
            const ids = friendly(g, self).filter((id) => g.canAttack(id))
            const strongest = [...ids].sort((a, b) => g.power(g.unit(b)!) - g.power(g.unit(a)!))[0]
            const pick = g.chooseOne(p, 'Rey: attack with a unit (+2/+0)', ids, { ai: strongest, source: self.def.id })
            if (pick) g.attackWith(pick, { power: 2 })
          },
        },
      ],
    },
  },
  {
    card: 'swu-TWI-174',
    name: 'Open Fire',
    text: 'Deal 4 damage to a unit.',
    front: {
      play: (g, self) => {
        const pick = g.chooseOne(self.controller, 'Open Fire: deal 4 damage to a unit', all(g), { ai: feedsOnDamage(g, self, 4) ?? bestHit(g, self, enemy(g, self), 4) ?? 'harm', source: self.def.id })
        if (pick) g.damage(pick, 4, self)
      },
    },
  },
  {
    card: 'swu-IC27-127',
    name: 'Act of Aggression',
    text: 'Draw a card.\nYou may deal 3 damage to a unit.\nGive a friendly unit +3/+0 and [Overwhelm] for this phase.',
    front: {
      play: (g, self) => {
        const p = self.controller
        g.draw(p, 1)
        // The AI: the 3 damage on its own Paz Vizsla when he can attack after (+6/+0, then +3/+0
        // and Overwhelm), else on the enemy unit it hurts most
        const paz = feedsOnDamage(g, self, 3)
        const hit = paz ?? bestHit(g, self, enemy(g, self), 3)
        const pick = g.chooseOne(p, 'Act of Aggression: you may deal 3 damage to a unit', all(g), { optional: true, ai: hit ?? 'none', source: self.def.id })
        if (pick) g.damage(pick, 3, self)
        const mine = friendly(g, self)
        if (!mine.length) return
        // The AI: a ready unit that can still attack, the strongest
        const ready = mine.filter((id) => g.canAttack(id))
        const best = paz && g.unit(paz) ? paz : [...(ready.length ? ready : mine)].sort((a, b) => g.power(g.unit(b)!) - g.power(g.unit(a)!))[0]
        const buffed = g.chooseOne(p, 'Act of Aggression: give a friendly unit +3/+0 and Overwhelm for this phase', mine, { ai: best, source: self.def.id })
        if (!buffed) return
        g.buff(buffed, 3, 0, 'phase')
        g.grant(buffed, { overwhelm: true }, 'phase')
      },
    },
  },
  {
    card: 'swu-JTL-155',
    name: 'They Hate That Ship',
    text: 'An opponent creates 2 TIE Fighter tokens and readies them. Then, play a [{Vehicle}] unit from your hand. It costs [3] less.',
    front: {
      play: (g, self) => {
        const p = self.controller
        const foe = g.other(p)
        g.createToken(foe, 'TIE Fighter', { ready: true })
        g.createToken(foe, 'TIE Fighter', { ready: true })
        const ids = g.player(p).hand.filter((c) => g.def(c).type === 'unit' && g.def(c).traits.includes('Vehicle') && g.canPlay(p, c.id, { discount: 3 })).map((c) => c.id)
        const pick = g.chooseOne(p, 'They Hate That Ship: play a Vehicle unit from your hand for 3 less', ids, { ai: 'best', source: self.def.id })
        if (pick) g.playCard(p, pick, { discount: 3 })
      },
    },
  },
  {
    card: 'swu-LOF-138',
    name: 'Sith Holocron',
    text: 'Attach to a [{Force}] unit.\nAttached unit gains: "[On Attack:] You may deal 2 damage to a friendly unit. If you do, this unit gets [+2/+0] for this attack."',
    front: {
      attachedOnAttack: (g, self) => {
        const host = self.attachedTo ? g.unit(self.attachedTo) : undefined
        if (!host) return
        const ids = friendly(g, { ...self, controller: g.controller(host) })
        const left = (u: UnitState) => g.hp(u) - u.damage
        // The AI: on itself when the damage pays (Paz Vizsla's +2/+0 a damage, Grit, Gungi readied)
        // and it survives the attack; else on a sturdy unit when the +2/+0 defeats the defender
        const target = g.state.attack?.target
        const defender = target && target !== 'base' ? g.unit(target) : undefined
        const takes = defender ? g.power(defender) : 0
        const feeds = /for each damage on|\[Grit\]|When this unit is dealt damage and survives/.test(g.def(host).text ?? '') || g.keywords(host).grit
        let pick: string | undefined
        if (feeds && left(host) > 2 + takes) pick = host.id
        // At the base: 2 more damage there for 2 on a sturdy unit that doesn't attack this round
        else if (!defender)
          pick = [...ids].filter((id) => id !== host.id && left(g.unit(id)!) >= 5 && g.unit(id)!.exhausted).sort((a, b) => left(g.unit(b)!) - left(g.unit(a)!))[0]
        else if (defender) {
          const need = g.hp(defender) - defender.damage
          if (g.power(host) < need && g.power(host) + 2 >= need)
            pick = [...ids].filter((id) => id !== host.id && left(g.unit(id)!) > 2).sort((a, b) => left(g.unit(b)!) - left(g.unit(a)!))[0]
        }
        const chosen = g.chooseOne(g.controller(host), 'Sith Holocron: you may deal 2 damage to a friendly unit for +2/+0', ids, { optional: true, ai: pick ?? 'none', source: self.def.id })
        if (!chosen || !g.damage(chosen, 2, self)) return
        if (g.unit(host.id)) g.buff(host.id, 2, 0, 'attack')
      },
    },
  },
  // --- Mother Talzin Yellow Force (swu-competitivehub.com/decklist/39228), 2026-11-26 ---
  {
    card: 'swu-LOF-002',
    name: 'Mother Talzin',
    subtitle: 'Power Through Magick',
    text: '[Action [Arrow, use the Force]:] Give a unit -1/-1 for this phase.',
    backText: '[On Attack:] You may give a unit -1/-1 for this phase.',
    front: {
      actions: [
        {
          label: 'use the Force: a unit -1/-1',
          exhaust: true,
          can: (g, self) => g.hasForce(self.controller) && g.units(() => true).length > 0,
          run: (g, self) => {
            if (!g.useForce(self.controller)) return
            shrinkOn(g, self, 1, 'Mother Talzin: give a unit -1/-1 for this phase', shrinkTarget(g, self, 1) ?? tradeTarget(g, self, 1) ?? mostThreat(g, enemy(g, self)))
          },
        },
      ],
    },
    back: {
      // The AI: a unit -1/-1 defeats, else the unit she attacks (it hits back for 1 less)
      onAttack: (g, self) => {
        const target = self.attack?.target
        const defender = target && target !== 'base' && g.unit(target) ? target : undefined
        shrinkOn(g, self, 1, 'Mother Talzin: you may give a unit -1/-1 for this phase', shrinkTarget(g, self, 1) ?? defender ?? tradeTarget(g, self, 1))
      },
    },
  },
  {
    card: 'swu-SEC-186',
    name: 'Garindan',
    subtitle: 'Information Broker',
    text: "[When Played:] Name a card. Look at an opponent's hand and discard a card with that name from it.\n[Plot]",
    front: { whenPlayed: (g, self) => garindan(g, self) },
  },
  {
    card: 'swu-ASH-219',
    name: 'Jod Na Nawood',
    subtitle: 'Keeping Secrets',
    text: '[Sentinel]\n[When Played:] You may pay [4]. If you do, choose an arena. Exhaust each unit in that arena.',
    front: {
      whenPlayed: (g, self) => {
        const p = self.controller
        if (!g.canPay(p, 4)) return
        // The AI: the arena where the enemy's ready power most outweighs its own, by JOD_EDGE
        const edge = (arena: string) =>
          enemy(g, self, (u) => u.arena === arena && !u.exhausted).reduce((s, id) => s + g.power(g.unit(id)!), 0) -
          friendly(g, self, (u) => u.arena === arena && !u.exhausted).reduce((s, id) => s + g.power(g.unit(id)!), 0)
        const arenas = ['ground', 'space'] as const
        const best = edge('ground') >= edge('space') ? 0 : 1
        if (!g.may(p, 'Jod Na Nawood: pay 4 to exhaust each unit in an arena?', { yes: 'Pay 4', no: 'Skip', ai: edge(arenas[best]) >= JOD_EDGE, source: self.def.id })) return
        if (!g.pay(p, 4)) return
        const arena = arenas[g.option(p, 'Jod Na Nawood: exhaust each unit in an arena', ['Ground', 'Space'], { ai: best, source: self.def.id })]
        g.log(`Each unit in the ${arena} arena is exhausted`, p)
        for (const id of all(g, (u) => u.arena === arena)) g.exhaust(id)
      },
    },
  },
  {
    card: 'swu-LAW-086',
    name: 'The Stranger',
    subtitle: 'No Survivors',
    text: '[Ambush]\n[Grit]\nWhile Attacking, you may have the defending unit deal combat damage before this unit.',
    front: {
      // When he survives the defender's damage: Grit makes his own hit harder
      strikesSecond: (g, self, defender) => {
        const unit = g.unit(self.id)
        return !!unit && g.hp(unit) - unit.damage > g.power(defender)
      },
    },
  },
  {
    card: 'swu-ASH-224',
    name: 'Elzar Mann',
    subtitle: 'Haunted by a Vision',
    text: 'While you control a [{Force}] leader, this unit enters play ready.\n[When Played:] Distribute up to 5 Advantage tokens among other friendly units. Then, an opponent searches twice that many cards from the top of their deck for an event, reveals it, and draws it.',
    front: {
      whenPlayed: (g, self) => {
        const p = self.controller
        if (g.def(g.player(p).leader).traits.includes('Force')) g.ready(self.id)
        const ids = friendly(g, self, (u) => u.id !== self.id)
        if (!ids.length) return
        // The AI: one on each other unit that can attack this phase, up to 3 (each token is 2
        // cards the opponent searches for an event)
        const ready = ids.filter((id) => g.canAttack(id)).sort((a, b) => g.power(g.unit(b)!) - g.power(g.unit(a)!))
        const count = g.option(p, 'Elzar Mann: how many Advantage tokens to distribute?', ['0', '1', '2', '3', '4', '5'], { ai: Math.min(3, ready.length), firm: true, source: self.def.id })
        for (let i = 0; i < count; i++) {
          const pick = g.chooseOne(p, `Elzar Mann: give an Advantage token to another friendly unit (${i + 1} of ${count})`, ids, { ai: ready[i % Math.max(1, ready.length)] ?? ids[0], source: self.def.id })
          if (pick) g.giveToken(pick, 'Advantage')
        }
        if (count) searchDraw(g, { ...self, controller: g.other(p) }, 2 * count, (c) => g.def(c).type === 'event', 'an event')
      },
    },
  },
  {
    card: 'swu-ASH-053',
    name: 'Pre Vizsla',
    subtitle: 'Strong-Willed Ruler',
    text: '[When Played:] Defeat any number of non-leader units with a total of 6 or less remaining HP. Create a Mandalorian token for each unit defeated this way.',
    front: {
      whenPlayed: (g, self) => {
        const p = self.controller
        const ids = all(g, (u) => !g.isLeader(u) && g.hp(u) - u.damage <= 6)
        if (!ids.length) return
        // The AI: the enemy units worth most (cost, then power) whose HP left adds up to 6 or less
        const foes = enemy(g, self, (u) => !g.isLeader(u) && g.hp(u) - u.damage <= 6).slice(0, 12)
        const worth = (id: string) => g.cost(g.unit(id)!) + 0.3 * g.power(g.unit(id)!) + 1
        let best: string[] = []
        let bestWorth = 0
        for (let mask = 1; mask < 1 << foes.length; mask++) {
          const set = foes.filter((_, i) => mask & (1 << i))
          if (set.reduce((s, id) => s + left(g, id), 0) > 6) continue
          const w = set.reduce((s, id) => s + worth(id), 0)
          if (w > bestWorth) [best, bestWorth] = [set, w]
        }
        const picks = g.choose(p, 'Pre Vizsla: defeat any number of non-leader units with 6 or less remaining HP in total', ids, {
          min: 0,
          max: ids.length,
          ai: best.length ? `ids:${best.join(',')}` : 'none',
          source: self.def.id,
        })
        let total = 0
        const doomed: string[] = []
        for (const id of picks) {
          if (!g.unit(id) || total + left(g, id) > 6) continue
          total += left(g, id)
          doomed.push(id)
        }
        let count = 0
        for (const id of doomed) {
          g.defeat(id, self)
          if (!g.unit(id)) count++
        }
        for (let i = 0; i < count; i++) g.createToken(p, 'Mandalorian')
      },
    },
  },
  {
    card: 'swu-ASH-194',
    name: 'Snub Fighter Squadron',
    text: '[Ambush]\n[When Played:] Deal 1 damage to a space unit.',
    front: {
      whenPlayed: (g, self) => {
        const ids = all(g, (u) => u.arena === 'space')
        if (!ids.length) return
        // The AI: an enemy space unit (the best hit), else its own sturdiest space unit
        const own = friendly(g, self, (u) => u.arena === 'space').sort((a, b) => left(g, b) - left(g, a))[0]
        const pick = g.chooseOne(self.controller, 'Snub Fighter Squadron: deal 1 damage to a space unit', ids, { ai: bestHit(g, self, ids, 1) ?? own, source: self.def.id })
        if (pick) g.damage(pick, 1, self)
      },
    },
  },
  {
    card: 'swu-HMW-203',
    name: 'Victor Squadron',
    subtitle: 'In Attack Formation',
    text: 'This unit enters play ready.',
    front: { whenPlayed: (g, self) => g.ready(self.id) },
  },
  {
    card: 'swu-HMW-204',
    name: 'Nightbrother',
    subtitle: "Maul's Gauntlet",
    text: '[When Played:] You may play a unit from your discard pile. It costs [3] less and enters play ready. At the start of the next regroup phase, defeat it.',
    front: {
      whenPlayed: (g, self) => {
        const p = self.controller
        const ids = g.player(p).discard.filter((c) => g.def(c).type === 'unit' && g.canPlay(p, c.id, { discount: 3 })).map((c) => c.id)
        if (!ids.length) return
        // The AI: the dearest
        const dearest = [...ids].sort((a, b) => g.def(g.card(b)!).cost - g.def(g.card(a)!).cost)[0]
        const pick = g.chooseOne(p, 'Nightbrother: you may play a unit from your discard pile for 3 less (it enters ready, and is defeated when the next regroup phase starts)', ids, {
          optional: true,
          ai: dearest,
          source: self.def.id,
        })
        if (!pick || !g.playCard(p, pick, { discount: 3 }) || !g.unit(pick)) return
        g.ready(pick)
        g.doom(pick)
      },
    },
  },
  {
    card: 'swu-LAW-217',
    name: 'Hold For Questioning',
    text: "Exhaust an enemy unit. If you do, look at its controller's hand and discard a card form it that shares an aspect with that unit.",
    front: {
      play: (g, self) => {
        const p = self.controller
        const ids = enemy(g, self)
        // The AI: the ready enemy unit that threatens most
        const ready = ids.filter((id) => !g.unit(id)!.exhausted)
        const pick = g.chooseOne(p, 'Hold For Questioning: exhaust an enemy unit', ids, { ai: mostThreat(g, ready) ?? ids[0] ?? 'none', source: self.def.id })
        const unit = pick ? g.unit(pick) : undefined
        if (!unit || unit.exhausted) return
        g.exhaust(unit.id)
        const foe = g.controller(unit)
        const aspects = g.def(unit).aspects
        const hand = g.player(foe).hand
        g.log(`${g.player(p).name} looks at ${g.player(foe).name}'s hand`, p)
        const fits = hand.filter((c) => g.def(c).aspects.some((a) => aspects.includes(a))).map((c) => c.id)
        if (!fits.length) return
        const gone = g.chooseOne(p, `Hold For Questioning: discard a card that shares an aspect with ${g.name(unit.id)}`, fits, { ai: 'strip', source: self.def.id, seen: hand.map((c) => c.id) })
        if (gone) g.discard(foe, gone)
      },
    },
  },
  {
    card: 'swu-JTL-043',
    name: 'No Glory, Only Results',
    text: 'Take control of a non-leader unit, then defeat it.',
    front: {
      play: (g, self) => {
        const p = self.controller
        const ids = all(g, (u) => !g.isLeader(u))
        // The AI: the enemy unit worth most
        const worth = (id: string) => g.cost(g.unit(id)!) + threat(g, id)
        const foes = enemy(g, self, (u) => !g.isLeader(u)).sort((a, b) => worth(b) - worth(a))
        const pick = g.chooseOne(p, 'No Glory, Only Results: take control of a non-leader unit, then defeat it', ids, { ai: foes[0] ?? 'none', source: self.def.id })
        if (!pick) return
        g.takeControl(pick, p)
        g.defeat(pick, self)
      },
    },
  },
  {
    card: 'swu-SEC-038',
    name: 'Condemn',
    text: 'While attached unit is attacking, it gains: "[On Attack:] The defending player may disclose [Vigilance][Villainy]. If they do, this unit gets -6/-0 for this attack" and loses all other abilities.',
    front: {
      attachedOnAttack: (g, self) => {
        const host = self.attachedTo ? g.unit(self.attachedTo) : undefined
        if (!host) return
        // Its keywords gone for the attack (its other abilities that already fired stay done)
        const keywords = Object.keys(g.keywords(host)) as (keyof Keywords)[]
        if (keywords.length) g.strip(host.id, keywords, 'attack')
        const defending = g.other(g.controller(host))
        if (!disclose(g, { ...self, controller: defending }, ['Vigilance', 'Villainy'])) return
        g.log(`${g.name(host.id)} gets -6/-0 for this attack`, defending)
        g.buff(host.id, -6, 0, 'attack')
      },
    },
  },
  {
    card: 'swu-LOF-261',
    name: 'Constructed Lightsaber',
    text: 'Attach to a [{Force}] unit.\nIf attached unit is a [Heroism] unit, it gains [Restore 2].\nIf attached unit is a [Villainy] unit, it gains [Raid 2].\nIf attached unit is a non-[Heroism], non-[Villainy] unit, it gains [Sentinel].',
    front: {
      gives: (g, self, unit) => {
        if (unit.id !== self.attachedTo) return undefined
        const aspects = g.def(unit).aspects
        if (aspects.includes('Heroism')) return { keywords: { restore: 2 } }
        if (aspects.includes('Villainy')) return { keywords: { raid: 2 } }
        return { keywords: { sentinel: true } }
      },
    },
  },
  // --- Wicket Data Vault (swu-competitivehub.com/decklist/39226), 2026-11-26 ---
  {
    card: 'swu-ASH-116',
    name: 'Ant Droid',
    text: '[When Defeated:] Draw a card.',
    front: { whenDefeated: (g, self) => g.draw(self.controller, 1) },
  },
  {
    card: 'swu-LAW-191',
    name: 'Arvel Skeen',
    subtitle: 'Win and Walk Away',
    text: '[When Played/On Attack:] You may defeat a Credit token. If you do, deal 1 damage to a unit or base.',
    front: { whenPlayed: (g, self) => arvel(g, self), onAttack: (g, self) => arvel(g, self) },
  },
  {
    card: 'swu-ASH-112',
    name: 'Luke Skywalker',
    subtitle: 'Answering the Call',
    text: '[Restore 1]\n[When Played:] If you control at least 4 units, deal 3 damage to each enemy unit.',
    front: {
      whenPlayed: (g, self) => {
        if (friendly(g, self).length < 4) return
        for (const id of enemy(g, self)) if (g.unit(id)) g.damage(id, 3, self)
      },
    },
  },
  {
    card: 'swu-LOF-147',
    name: "Kit Fisto's Aethersprite",
    subtitle: 'Good Hunting',
    text: '[Saboteur]\n[When Played:] You may defeat any number of upgrades on a unit.',
    front: {
      whenPlayed: (g, self) => {
        const p = self.controller
        const ids = all(g, (u) => u.upgrades.length > 0)
        if (!ids.length) return
        // The AI: the enemy unit whose upgrades are worth most (cost, a Shield 2, other tokens 1)
        const upWorth = (u: UnitState) => u.upgrades.reduce((s, up) => s + (g.def(up).token ? (g.def(up).name === 'Shield' ? 2 : 1) : Math.max(1, g.def(up).cost)), 0)
        const foes = enemy(g, self, (u) => u.upgrades.length > 0).sort((a, b) => upWorth(g.unit(b)!) - upWorth(g.unit(a)!))
        const pick = g.chooseOne(p, "Kit Fisto's Aethersprite: you may defeat any number of upgrades on a unit", ids, { optional: true, ai: foes[0] ?? 'none', source: self.def.id })
        const unit = pick ? g.unit(pick) : undefined
        if (!unit) return
        const ups = unit.upgrades.map((u) => u.id)
        const mine = g.controller(unit) === p
        const gone = g.choose(p, `Kit Fisto's Aethersprite: defeat any number of upgrades on ${g.name(unit.id)}`, ups, { min: 0, max: ups.length, ai: mine ? 'none' : `ids:${ups.join(',')}`, source: self.def.id })
        for (const id of gone) g.defeatUpgrade(id)
      },
    },
  },
  {
    card: 'swu-ASH-183',
    name: 'Whistling Birds',
    text: 'Attach to a non-[{Vehicle}] unit.\nAttached unit gains: "[When Attack Ends:] If this unit dealt combat damage to an opponent\'s base, deal 2 damage to each unit that opponent controls in this unit\'s arena."',
    front: {
      whenFriendlyAttackEnds: (g, self) => {
        if (!self.attachedTo || self.other !== self.attachedTo || !self.baseDamage) return
        const host = g.unit(self.attachedTo)
        if (!host) return
        const foe = g.other(g.controller(host))
        for (const id of all(g, (u) => g.controller(u) === foe && u.arena === host.arena)) if (g.unit(id)) g.damage(id, 2, self)
      },
    },
  },
]

// --- Thorrk's Piett Red's helpers ---

// The Capital Ship units in a player's hand
function capitalShips(g: Game, p: PlayerId) {
  return g.player(p).hand.filter((c) => g.def(c).type === 'unit' && g.def(c).traits.includes('Capital Ship')).map((c) => c.id)
}

// "Search the top N cards of your deck for a … , reveal it, and draw it." The AI: the dearest.
// The others go to the bottom in a random order. The card drawn, if any.
function searchDraw(g: Game, self: Self, count: number, fits: (c: { id: string; def: string }) => boolean, what: string, choose?: (ids: string[]) => string | undefined) {
  const p = self.controller
  const top = g.top(p, count)
  const ids = top.filter(fits).map((c) => c.id)
  const dearest = choose ? choose(ids) : [...ids].sort((a, b) => g.def(g.card(b)!).cost - g.def(g.card(a)!).cost)[0]
  const pick = g.chooseOne(p, `${self.def.name}: search the top ${count} cards of your deck for ${what} to draw`, ids, { optional: true, ai: dearest ?? 'none', source: self.def.id, seen: top.map((c) => c.id) })
  if (pick) {
    g.reveal(p, [pick], self)
    g.drawCard(p, pick)
  } else g.log(`${self.def.name} finds nothing to draw`, p)
  g.shuffleToBottom(p, top.filter((c) => c.id !== pick && g.player(p).deck.some((d) => d.id === c.id)).map((c) => c.id))
  return pick
}

// The Invisible Hand: a Droid unit from the top 8 drawn; costing 2 or less, played for free if
// the player wants (the AI does)
function invisibleHand(g: Game, self: Self) {
  const p = self.controller
  const pick = searchDraw(g, self, 8, (c) => g.def(c).type === 'unit' && g.def(c).traits.includes('Droid'), 'a Droid unit')
  if (!pick || g.def(g.card(pick)!).cost > 2 || !g.canPlay(p, pick, { free: true })) return
  if (g.may(p, `The Invisible Hand: play ${g.name(pick)} for free?`, { yes: 'Play it', no: 'Keep it', source: self.def.id })) g.playCard(p, pick, { free: true })
}

// A friendly unit that gets power from its damage (Paz Vizsla's +2/+0 a damage) to deal `amount`
// damage to before it attacks (Act of Aggression, Open Fire): ready to attack, surviving it, and
// no enemy ground unit ready to finish it after (the deck's combo, "15 damage in one attack")
function feedsOnDamage(g: Game, self: Self, amount: number) {
  const foesReady = enemy(g, self, (u) => !u.exhausted && u.arena === 'ground').length
  return friendly(g, self, (u) => /for each damage on/.test(g.def(u).text ?? '') && g.canAttack(u.id) && g.hp(u) - u.damage > amount && (u.arena !== 'ground' || !foesReady))[0]
}

// --- Mother Talzin's and Wicket Data Vault's helpers ---

const JOD_EDGE = 4
const GARINDAN_KILLER = 2.5
const left = (g: Game, id: string) => g.hp(g.unit(id)!) - g.unit(id)!.damage

// Garindan: a card named, then a card of that name discarded from the opponent's hand. The AI
// names the card most likely there and worth most: each copy it hasn't seen (hand and deck alike,
// so it doesn't peek), by its cost
function garindan(g: Game, self: Self) {
  const p = self.controller
  const foe = g.other(p)
  const pl = g.player(foe)
  const unseen = [...pl.hand, ...pl.deck]
  const known = [...unseen, ...pl.discard, ...pl.resources.map((r) => r.card), ...g.units((u) => u.owner === foe && !u.leader)]
  const names = [...new Set(known.filter((c) => g.def(c).type !== 'leader' && !g.def(c).token).map((c) => g.def(c).name))].sort()
  if (!names.length) return
  // With its leader deployed, a card that defeats that leader at once counts most: an Ambush unit,
  // one that attacks with a unit even exhausted (Hunter, Everyone Get to Cover!), damage enough
  // (the user, 2026-11-27: "Talzin deploys against Mace and plays Garindan: she could often go for
  // Hunter, one of the top cards that deal with Talzin right away, x3 in Mace decks")
  const leader = g.units((u) => !!u.leader && g.controller(u) === p)[0]
  const kills = (d: { type: string; text?: string; keywords?: { ambush?: boolean } }) => {
    if (!leader) return false
    const text = d.text ?? ''
    const hit = text.match(/deal (\d+) damage to a unit/i)
    return (d.type === 'unit' && (!!d.keywords?.ambush || /Attack with a unit, even if it's exhausted/i.test(text))) || (!!hit && Number(hit[1]) >= left(g, leader.id))
  }
  const score: Record<string, number> = {}
  for (const c of unseen) {
    const d = g.def(c)
    if (d.type !== 'leader' && !d.token) score[d.name] = (score[d.name] ?? 0) + (1 + 0.3 * d.cost) * (kills(d) ? GARINDAN_KILLER : 1)
  }
  const wanted = [...names].sort((a, b) => (score[b] ?? 0) - (score[a] ?? 0))[0]
  const name = names[g.option(p, 'Garindan: name a card', names, { ai: Math.max(0, names.indexOf(wanted)), firm: true, source: self.def.id })]
  g.log(`${g.player(p).name} names ${name} and looks at ${pl.name}'s hand`, p)
  const fits = pl.hand.filter((c) => g.def(c).name === name).map((c) => c.id)
  if (!fits.length) return g.log(`${pl.name} has no ${name} in hand`, p)
  const gone = g.chooseOne(p, `Garindan: discard ${name} from your opponent's hand`, fits, { ai: fits[0], source: self.def.id, seen: pl.hand.map((c) => c.id) })
  if (gone) g.discard(foe, gone)
}

// Arvel Skeen: a Credit token defeated for 1 damage to a unit or base. The AI: when the damage
// defeats an enemy unit (the dearest) or finishes the enemy base
function arvel(g: Game, self: Self) {
  const p = self.controller
  if (!g.credits(p)) return
  const foe = g.other(p)
  const kill = enemy(g, self, (u) => g.hp(u) - u.damage <= 1 && !g.tokens(u.id, 'Shield')).sort((a, b) => g.cost(g.unit(b)!) - g.cost(g.unit(a)!))[0]
  const base = g.player(foe).base
  const finish = (g.def(base).hp ?? 30) - base.damage <= 1 ? baseOf(foe) : undefined
  const target = finish ?? kill
  if (!g.may(p, 'Arvel Skeen: defeat a Credit token to deal 1 damage to a unit or base?', { yes: 'Defeat a Credit', no: 'Skip', ai: !!target, source: self.def.id })) return
  if (!g.defeatCredit(p)) return
  const pick = g.chooseOne(p, 'Arvel Skeen: deal 1 damage to a unit or base', [...all(g), baseOf(0), baseOf(1)], { ai: target ?? baseOf(foe), source: self.def.id })
  if (pick) g.damage(pick, 1, self)
}

// The enemy unit a -X/-X turns into a good trade for one of p's ready units (Mother Talzin, the
// user 2026-11-26: "do good trades against Sentinel with the -1, or prevent good trades"): its
// attack then defeats it, or defeats it and survives where it wouldn't have. A Sentinel first,
// then the dearest. undefined: none
function tradeTarget(g: Game, self: Self, amount: number) {
  const shielded = (id: string) => g.tokens(id, 'Shield') > 0
  let best: string | undefined
  let bestWorth = 0
  for (const a of friendly(g, self, (u) => g.canAttack(u.id))) {
    const au = g.unit(a)!
    for (const e of g.attackable(a).filter((t) => t !== 'base')) {
      const eu = g.unit(e)
      if (!eu || g.controller(eu) === self.controller || shielded(e)) continue
      const kills = (cut: number) => g.power(au) >= left(g, e) - cut
      const survives = (cut: number) => left(g, a) > g.power(eu) - cut
      if (!(kills(amount) && (!kills(0) || (survives(amount) && !survives(0))))) continue
      const worth = g.cost(eu) + (g.keywords(eu).sentinel ? 5 : 0)
      if (worth > bestWorth) [best, bestWorth] = [e, worth]
    }
  }
  return best
}
