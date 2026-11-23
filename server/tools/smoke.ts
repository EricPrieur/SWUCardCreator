// The smoke test: every DUNE card played at least once, in a busy position, whether it is in a
// Featured Deck or not. Each card is played (every way it can be: from the hand, using Smuggle,
// for a Spice token, Plot, onto each kind of unit for an upgrade), attacks, is defeated, uses its
// Action abilities, and the game is played on through a regroup phase. Each step is checked for
// errors (a crash, a legal action refused), broken states (a unit alive with lethal damage, a
// card in two places, a question nobody can answer) and, against a "vanilla twin" of the card
// (its stats and keywords, no script), whether its text did anything at all.
//
//   node tools/smoke.ts [name filter]
//
// VARIANT=path/to/variant.ts plays cards not yet exported (fromdb.ts). Exit code 1 on errors or
// broken states; quiet cards are listed to look at, not counted as failures (their condition may
// just not hold on the smoke board).
import { pathToFileURL } from 'node:url'
import { chooseAction } from '../engine/ai.ts'
import { readText } from '../engine/cards.ts'
import { applyAction, createGame, handRevealed, hpOf, keywordsOf, legalActions, powerOf, waitingFor } from '../engine/game.ts'
import { scriptFor, scripts, scriptStatus } from '../engine/scripts.ts'
import { IllegalAction, type Action, type CardDef, type GameState, type PlayerId, type UnitState } from '../engine/types.ts'
import { loadDefs } from './dune.ts'

const filter = process.argv[2]?.toLowerCase()
const all = loadDefs()
if (process.env.VARIANT) (await import(pathToFileURL(process.env.VARIANT).href)).default(all, scripts)
const dune = all.filter((d) => !d.community && !d.token)

// --- The smoke board's own cards: a leader and a base with no text, and a big plain attacker ---
const plain = (id: string, extra: Partial<CardDef>): CardDef =>
  ({ id, name: id, type: 'unit', cost: 0, power: 0, hp: 0, arena: 'ground', aspects: [], traits: [], unique: false, ...readText(''), ...extra }) as CardDef
const smokeLeader = plain('smoke-leader', { type: 'leader', cost: 4, aspects: ['Vigilance', 'Command', 'Aggression', 'Cunning'], unit: { power: 3, hp: 6, arena: 'ground', keywords: {} } })
const smokeBase = plain('smoke-base', { type: 'base', hp: 30, traits: ['Arrakis'], startSpice: 3 })
const otherBase = plain('smoke-other-base', { type: 'base', hp: 30, startSpice: 3 })
const enemyBase = plain('smoke-enemy-base', { type: 'base', hp: 30 })
const giant = plain('smoke-giant', { cost: 8, power: 9, hp: 12 })
const extras = [smokeLeader, smokeBase, otherBase, enemyBase, giant]

// Plain units from the set to fill the board with traits cards ask about
// Non-unique first; a pool of mostly unique cards (real SWU decks) takes unique ones too
const cheapest = (test: (d: CardDef) => boolean, not: Set<string>) => {
  const fits = dune.filter((d) => d.type === 'unit' && !not.has(d.id) && test(d)).sort((a, b) => Number(a.unique) - Number(b.unique) || a.cost - b.cost || a.id.localeCompare(b.id))
  return fits[0]
}
// The pool's own most common unit traits, so another pool's board (real SWU cards) has them too
const commonTraits = Object.entries(
  dune.filter((d) => d.type === 'unit' && !d.token).flatMap((d) => d.traits).reduce<Record<string, number>>((n, t) => ({ ...n, [t]: (n[t] ?? 0) + 1 }), {}),
)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 4)
  .map(([t]) => t)
function boardOf(traits: string[], space: number, not: Set<string>) {
  const picked: CardDef[] = []
  for (const t of [...traits, ...commonTraits.filter((c) => !traits.includes(c))]) {
    const d = cheapest((d) => d.arena === 'ground' && d.traits.includes(t), new Set([...not, ...picked.map((p) => p.id)]))
    if (d) picked.push(d)
  }
  for (let i = 0; i < space; i++) {
    const d = cheapest((d) => d.arena === 'space', new Set([...not, ...picked.map((p) => p.id)]))
    if (d) picked.push(d)
  }
  return picked
}
const fillers = [
  ...dune.filter((d) => d.type === 'unit' && !d.unique && d.cost <= 3),
  ...dune.filter((d) => d.type === 'unit' && d.unique && d.cost <= 3),
].slice(0, 8)
const handExtras = [
  cheapest((d) => d.arena === 'ground' && d.cost <= 2, new Set()),
  dune.find((d) => d.type === 'event' && d.cost <= 2 && !d.unique),
  dune.find((d) => d.type === 'upgrade' && d.cost <= 2 && !d.unique),
].filter((d): d is CardDef => !!d)
// More for the rich board: a Trick, a Bene Gesserit card and a Trooper in hand
const richExtras = [
  dune.find((d) => d.type === 'event' && d.traits.includes('Trick') && !d.unique),
  dune.find((d) => d.traits.includes('Bene Gesserit') && !d.unique && d.type !== 'leader'),
  cheapest((d) => d.traits.includes('Trooper') && d.cost <= 3, new Set()),
  cheapest((d) => d.traits.includes('Fremen') && d.cost <= 3, new Set()),
  cheapest((d) => d.traits.includes('Sardaukar'), new Set()),
  dune.find((d) => d.type === 'event' && d.traits.includes('Fremen') && !d.unique && d.cost <= 3),
].filter((d): d is CardDef => !!d)
const itemUpgrade = dune.find((d) => d.type === 'upgrade' && d.traits.includes('Item') && !d.unique && !d.keywords.fortify)

// --- Finding out what happened ---
type Problem = { card: string; step: string; kind: 'error' | 'broken'; detail: string }
const problems: Problem[] = []
const quiet: { card: string; lines: string[] }[] = []
const unscripted: string[] = []
let steps = 0

const units = (s: GameState) => [...s.players[0].units, ...s.players[1].units]

// What a step changed that the card's text could have: everything but the log
function fingerprint(s: GameState, twin?: string, id?: string) {
  const zone = (z: { id: string; def: string }[]) => z.map((c) => c.def).sort()
  const players = s.players.map((p) => ({
    hand: zone(p.hand),
    deck: p.deck.length,
    top: p.deck.slice(0, 3).map((c) => c.def),
    discard: zone(p.discard),
    resources: p.resources.length,
    ready: p.resources.filter((r) => !r.exhausted).length,
    spice: p.spice.length,
    base: p.base.damage,
    baseUpgrades: zone(p.base.upgrades ?? []),
    leader: [p.leader.deployed, p.leader.exhausted, p.leader.epicUsed],
    units: p.units
      .map((u) => [u.def, u.damage, u.exhausted, u.arena, powerOf(s, u), hpOf(s, u), JSON.stringify(keywordsOf(s, u)), zone(u.upgrades).join()].join('|'))
      .sort(),
  }))
  // Delayed and lasting effects too: discounts, units doomed or held, cards banned, hands revealed
  const later = { effects: s.effects, discounts: s.discounts, doomed: s.doomed, held: s.held, banned: s.banned, awakened: s.awakened, revealed: [handRevealed(s, 0), handRevealed(s, 1)] }
  let text = JSON.stringify({ players, winner: s.winner, phase: s.phase, later, prompt: s.prompt?.text })
  if (twin && id) text = text.split(twin).join(id)
  return text
}

function check(s: GameState, card: string, step: string) {
  const broken = (detail: string) => problems.push({ card, step, kind: 'broken', detail })
  if (!s.prompt && s.phase !== 'over') {
    for (const u of units(s)) {
      const hp = hpOf(s, u)
      const power = powerOf(s, u)
      if (![hp, power, u.damage].every(Number.isFinite)) broken(`${s.defs[u.def].name}: power ${power}, HP ${hp}, damage ${u.damage}`)
      else if (u.damage >= hp) broken(`${s.defs[u.def].name} alive with ${u.damage} damage on ${hp} HP`)
    }
  }
  const seen = new Map<string, string>()
  const place = (id: string, where: string) => {
    if (seen.has(id)) broken(`${id} both in ${seen.get(id)} and ${where}`)
    seen.set(id, where)
  }
  s.players.forEach((p, i) => {
    for (const c of p.hand) place(c.id, `hand ${i}`)
    for (const c of p.deck) place(c.id, `deck ${i}`)
    for (const c of p.discard) place(c.id, `discard ${i}`)
    for (const r of p.resources) place(r.card.id, `resources ${i}`)
    for (const c of p.spice) place(c.id, `spice ${i}`)
    for (const c of p.base.upgrades ?? []) place(c.id, `base ${i}`)
    for (const u of p.units) {
      place(u.id, `units ${i}`)
      for (const up of u.upgrades) place(up.id, `upgrades of ${u.id}`)
    }
  })
  if (s.phase !== 'over') {
    const who = waitingFor(s)
    if (!who.length) broken('nobody to act')
    if (s.prompt && s.prompt.options.length < s.prompt.min) broken(`question "${s.prompt.text}" has ${s.prompt.options.length} options for ${s.prompt.min} picks`)
    for (const p of who) if (!legalActions(s, p).length && !(s.prompt && s.prompt.max > 1 && s.prompt.options.length > 10)) broken(`player ${p} has no legal action`)
  }
}

// --- Answering questions: the AI's way, or at random (a seeded generator of our own) ---
type Way = { ai: true } | { ai: false; rng: () => number }
const seeded = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

function answerFor(s: GameState, way: Way): Action {
  const p = s.prompt!.player
  if (way.ai) {
    const a = chooseAction(s, p)
    if (a) return a
  }
  const { options, min, max } = s.prompt!
  const rng = way.ai ? seeded(7) : way.rng
  const ids = options.map((o) => o.id).sort(() => rng() - 0.5)
  const size = min + Math.floor(rng() * (Math.min(max, ids.length) - min + 1))
  return { type: 'answer', picks: ids.slice(0, size) }
}

// One action and every question it asks, answered; undefined after an error (recorded)
function act(s: GameState, p: PlayerId, action: Action, card: string, step: string, way: Way): GameState | undefined {
  steps++
  try {
    s = applyAction(s, p, action)
    for (let i = 0; s.prompt && i < 60; i++) s = applyAction(s, s.prompt.player, answerFor(s, way))
    if (s.prompt) problems.push({ card, step, kind: 'broken', detail: `still asking after 60 answers: ${s.prompt.text}` })
  } catch (e) {
    const err = e as Error
    const where = err.stack?.split('\n').find((l) => l.includes('engine'))?.trim() ?? ''
    problems.push({ card, step, kind: 'error', detail: `${err instanceof IllegalAction ? 'legal action refused: ' : ''}${err.message} ${where}`.trim() })
    return undefined
  }
  check(s, card, step)
  return s
}

// --- The smoke board ---
// The plain board (an Arrakis base), or the rich one: no Arrakis base, upgrades and Shields on
// units, enemy Spice, Atreides, Ginaz, Harvester and unique Fremen units, a Fremen token
function board(d: CardDef, rich: boolean): GameState {
  const not = new Set([d.id])
  const mine = rich
    ? boardOf(['Atreides', 'Ginaz', 'Harvester', 'Emperor', 'Harkonnen', 'Fremen', 'Underworld'], 1, not)
    : boardOf(['Spy', 'Sardaukar', 'Fremen', 'Trooper', 'Harkonnen', 'Bene Gesserit'], 1, not)
  if (rich) {
    const uniqueFremen = dune.find((u) => u.type === 'unit' && u.unique && u.arena === 'ground' && u.traits.includes('Fremen') && u.id !== d.id)
    if (uniqueFremen) mine.push(uniqueFremen)
  }
  const theirs = boardOf(rich ? ['Sardaukar', 'Spy', 'Atreides', 'Bene Gesserit'] : ['Atreides', 'Emperor', 'Underworld', 'Official', 'Fremen'], 2, not)
  const defs = [...all, ...extras, ...(all.includes(d) ? [] : [d])]
  const leader = d.type === 'leader' ? d.id : smokeLeader.id
  const base = d.type === 'base' ? d.id : rich ? otherBase.id : smokeBase.id
  const deck = Array.from({ length: 30 }, (_, i) => fillers[i % fillers.length].id)
  let s = createGame({
    seed: 3,
    defs,
    decks: [
      { name: 'Smoke', leader, base, deck },
      { name: 'Board', leader: smokeLeader.id, base: enemyBase.id, deck },
    ],
  })
  s = applyAction(s, s.chooser, { type: 'first', goFirst: true })
  s = applyAction(s, s.initiative, { type: 'mulligan', take: false })
  s = applyAction(s, s.initiative === 0 ? 1 : 0, { type: 'mulligan', take: false })
  for (const p of [0, 1] as const) s = applyAction(s, p, { type: 'resource', cards: s.players[p].hand.slice(0, 2).map((c) => c.id) })
  s.active = 0
  const place = (p: PlayerId, cards: CardDef[]): UnitState[] =>
    cards.map((c, i) => ({ id: `b${p}${i}`, def: c.id, owner: p, arena: c.arena ?? 'ground', damage: 0, exhausted: false, upgrades: [], entered: -1 }))
  s.players[0].units = place(0, mine)
  s.players[1].units = [
    ...place(1, theirs),
    ...[0, 1].map((i) => ({ id: `g${i}`, def: giant.id, owner: 1 as PlayerId, arena: 'ground' as const, damage: 0, exhausted: false, upgrades: [], entered: -1 })),
  ]
  // Damaged and exhausted units for cards that ask for them
  // (a unit with 1 HP left alone: 1 damage would defeat it)
  for (const u of [s.players[0].units[1], s.players[1].units[0]]) if (u && hpOf(s, u) > 1) u.damage = 1
  if (s.players[1].units[1]) s.players[1].units[1].exhausted = true
  const tokenOf = (name: string) => Object.values(s.defs).find((t) => t.token && t.name === name)
  if (rich) {
    const [shield, experience, spice, fremen] = ['Shield', 'Experience', 'Spice', 'Fremen'].map(tokenOf)
    const up = (u: UnitState | undefined, def: CardDef | undefined, id: string) => u && def && u.upgrades.push({ id, def: def.id, owner: u.owner })
    const [e0, e1, e2] = s.players[1].units
    up(e0, itemUpgrade, 'ue0')
    up(e1, shield, 'ue1')
    up(e2, experience, 'ue2')
    up(s.players[0].units[0], shield, 'um0')
    up(s.players[0].units[2], itemUpgrade, 'um2')
    if (spice) s.players[1].spice = [0, 1].map((i) => ({ id: `se${i}`, def: spice.id }))
    if (fremen) s.players[0].units.push({ id: 'ft0', def: fremen.id, owner: 0, arena: 'ground', damage: 0, exhausted: false, upgrades: [], entered: -1 })
  }
  // Spice tokens to spend, whatever the base starts with
  const spiceToken = tokenOf('Spice')
  if (spiceToken) while (s.players[0].spice.length < 3) s.players[0].spice.push({ id: `sm${s.players[0].spice.length}`, def: spiceToken.id })
  // A leader or a base is never in a hand
  const inHand = d.type === 'leader' || d.type === 'base' ? [] : [{ id: 'smoke', def: d.id }]
  s.players[0].hand = [...inHand, ...[...handExtras, ...(rich ? richExtras : [])].filter((e) => e.id !== d.id).map((e, i) => ({ id: `x${i}`, def: e.id }))]
  s.players[1].hand = handExtras.map((e, i) => ({ id: `y${i}`, def: e.id }))
  const resources = Array.from({ length: 12 }, (_, i) => ({ card: { id: `r${i}`, def: fillers[i % fillers.length].id }, exhausted: false }))
  // A second copy where Smuggle and Plot play it from
  if (d.keywords.smuggle !== undefined || d.keywords.plot) resources[0] = { card: { id: 'smoke-r', def: d.id }, exhausted: false }
  s.players[0].resources = resources
  s.players[1].resources = resources.map((r) => ({ card: { id: `${r.card.id}e`, def: fillers[0].id }, exhausted: false }))
  s.players[0].discard = fillers.slice(0, 4).map((f, i) => ({ id: `dd${i}`, def: f.id }))
  if (/discard pile/i.test(`${d.text}\n${d.backText ?? ''}`)) s.players[0].discard.push({ id: 'smoke-d', def: d.id })
  s.players[1].discard = fillers.slice(4, 6).map((f, i) => ({ id: `de${i}`, def: f.id }))
  return s
}

// --- The steps ---
type Step = { name: string; run: (s: GameState, way: Way, card: string) => GameState | undefined }
const mineId = (id: string) => ['smoke', 'smoke-r', 'smoke-d'].includes(id)
// A card's def id, wherever player 0 has it
const findCard = (s: GameState, id: string) => {
  const p = s.players[0]
  return [...p.hand, ...p.discard, ...p.deck, ...p.resources.map((r) => r.card)].find((c) => c.id === id)!.def
}

// The ways the card can be played; upgrades onto a few different kinds of unit
function plays(s: GameState): Action[] {
  const all = legalActions(s, 0).filter((a): a is Extract<Action, { type: 'play' }> => a.type === 'play' && mineId(a.card))
  const kinds = new Map<string, Action>()
  for (const a of all) {
    const target = a.attachTo ? units(s).find((u) => u.id === a.attachTo) : undefined
    // A unit's traits make it another kind only when the card names them ("If attached unit is a
    // [{Creature}] or a [{Force}] unit"): others' traits would multiply the steps for nothing
    const named = (s.defs[findCard(s, a.card)].text ?? '').match(/\[\{([^}]+)\}\]/g)?.map((t) => t.slice(2, -2)) ?? []
    const traits = target ? s.defs[target.def].traits.filter((t) => named.includes(t)).join('/') : ''
    const kind = [a.card, a.smuggle, a.spice, a.discard, a.pilot, target ? `${target.owner}${target.arena}${!!target.leader}${traits}` : a.attachTo].join()
    if (!kinds.has(kind)) kinds.set(kind, a)
  }
  return [...kinds.values()]
}

// The card's unit, ready to act
const myUnit = (s: GameState, defId: string) => s.players[0].units.find((u) => u.def === defId || u.upgrades.some((up) => up.def === defId && up.id.startsWith('smoke')))

function ready(s: GameState, u: UnitState) {
  s = structuredClone(s)
  const unit = units(s).find((x) => x.id === u.id)!
  unit.exhausted = false
  unit.entered = -1
  s.active = 0
  s.passes = 0
  return s
}

// The steps a card goes through, each from the position the last left. Returns the positions
// after each step, keyed by its name, for the twin to compare with
function runCard(d: CardDef, way: Way, label: string, rich: boolean) {
  const after = new Map<string, string>()
  const note = (name: string, s: GameState | undefined, twin?: string) => s && after.set(name, fingerprint(s, twin, twin?.replace(/~twin$/, '')))
  const twinId = d.id.endsWith('~twin') ? d.id : undefined
  let s: GameState | undefined
  try {
    s = board(d, rich)
  } catch (e) {
    problems.push({ card: label, step: 'set up', kind: 'error', detail: (e as Error).message })
    return after
  }
  check(s, label, 'set up')
  const start = s

  // Played, each way
  let played: GameState | undefined
  for (const a of plays(start)) {
    const name = `play ${[a.type === 'play' && a.smuggle && 'smuggle', a.type === 'play' && a.spice && 'spice', a.type === 'play' && a.discard && 'discard', a.type === 'play' && a.pilot && 'pilot', a.type === 'play' && a.attachTo && `on ${a.attachTo}`].filter(Boolean).join(' ') || 'from hand'}`
    const r = act(start, 0, a, label, name, way)
    note(name, r, twinId)
    if (r && !played && !(a.type === 'play' && (a.smuggle || a.discard || a.spice))) played = r
    played ??= r
  }
  // A leader: its Action abilities, then deployed
  if (d.type === 'leader') {
    for (const a of legalActions(start, 0).filter((a) => (a.type === 'ability' && a.source === 'leader') || a.type === 'deploy')) {
      const name = a.type === 'deploy' ? `deploy${a.attachTo ? ' as pilot' : ''}` : `leader ability ${a.index}`
      const r = act(start, 0, a, label, name, way)
      note(name, r, twinId)
      if (r && a.type === 'deploy' && !a.attachTo) played = r
    }
  }
  // Plot: played from the resources as the leader deploys
  if (d.keywords.plot && d.type !== 'leader') {
    const deploy = legalActions(start, 0).find((a) => a.type === 'deploy')
    if (deploy) note('plot (deploy)', act(start, 0, deploy, label, 'plot (deploy)', way), twinId)
  }
  // A base: its Action abilities
  if (d.type === 'base') for (const a of legalActions(start, 0).filter((a) => a.type === 'ability')) note(`base ability ${(a as { index: number }).index}`, act(start, 0, a, label, 'base ability', way), twinId)

  // Reactions: what the card answers to, from where it is now (a leader's front side too). Each
  // card in hand played, a friendly Spice token defeated, an enemy attack on the base and on a unit
  const react = (from: GameState, where: string) => {
    if (from.prompt || from.phase === 'over') return
    const s0 = structuredClone(from)
    s0.active = 0
    s0.passes = 0
    for (const card of s0.players[0].hand.filter((c) => !mineId(c.id))) {
      const a = legalActions(s0, 0).find((a) => a.type === 'play' && a.card === card.id)
      if (a) note(`${where}then play ${s0.defs[card.def].name}`, act(s0, 0, a, label, 'reaction: a card played', way), twinId)
    }
    const spice = s0.players[0].spice[0]
    const use = spice && legalActions(s0, 0).find((a) => a.type === 'ability' && a.source === spice.id)
    if (use) note(`${where}then a Spice token defeated`, act(s0, 0, use, label, 'reaction: a Spice token defeated', way), twinId)
    const s1 = structuredClone(from)
    s1.active = 1
    s1.passes = 0
    const attacks = legalActions(s1, 1).filter((a): a is Extract<Action, { type: 'attack' }> => a.type === 'attack' && a.attacker.startsWith('g'))
    for (const a of [attacks.find((a) => a.target === 'base'), attacks.find((a) => a.target !== 'base')].filter(Boolean) as Action[])
      note(`${where}then an enemy attacks ${(a as { target: string }).target === 'base' ? 'the base' : 'a unit'}`, act(s1, 1, a, label, 'reaction: an enemy attack', way), twinId)
  }
  if (d.type === 'leader' || d.type === 'base' || d.keywords.fortify) react(start, 'before: ')
  if (!played || played.phase === 'over') return after
  if (d.type !== 'event') react(played, '')
  const unit = myUnit(played, d.id)
  if (unit && !played.prompt) {
    // Its Action abilities, ready
    const readied = ready(played, unit)
    for (const a of legalActions(readied, 0).filter((a) => a.type === 'ability' && (a.source === unit.id || a.source.startsWith('smoke'))))
      note(`ability ${(a as { index: number }).index}`, act(readied, 0, a, label, 'unit ability', way), twinId)
    // It attacks: the base, and a unit
    const attacks = legalActions(readied, 0).filter((a): a is Extract<Action, { type: 'attack' }> => a.type === 'attack' && a.attacker === unit.id)
    for (const a of [attacks.find((a) => a.target === 'base'), attacks.find((a) => a.target !== 'base' && !a.target.startsWith('g'))].filter(Boolean) as Action[])
      note(`attack ${(a as { target: string }).target === 'base' ? 'base' : 'unit'}`, act(readied, 0, a, label, 'attack', way), twinId)
    // It is defeated: a giant attacks it, with it one damage from defeat
    const doomed = structuredClone(played)
    const target = units(doomed).find((x) => x.id === unit.id)!
    if (target.owner === 0 || doomed.players[0].units.includes(target)) {
      target.damage = Math.max(0, hpOf(doomed, target) - 1)
      for (const u of doomed.players[0].units) if (u.id !== target.id) u.exhausted = true
      doomed.active = 1
      doomed.passes = 0
      const hit = legalActions(doomed, 1).find((a) => a.type === 'attack' && a.target === target.id)
      if (hit) note('defeated', act(doomed, 1, hit, label, 'defeated', way), twinId)
    }
  }
  // Played on: both pass, the regroup phase (no resource), then a few legal actions at random
  // in the next phase (the AI's own choices are too slow here)
  if (!way.ai || twinId) return after
  let on: GameState | undefined = structuredClone(played)
  on.passes = 0
  const phase = on.phaseCount
  const rng = seeded(11)
  for (let i = 0; on && on.phase !== 'over' && i < 30 && on.phaseCount < phase + 3; i++) {
    const p = waitingFor(on)[0]
    if (p === undefined) break
    const legal = legalActions(on, p).filter((a) => a.type !== 'concede')
    const a: Action | undefined =
      on.phaseCount === phase ? { type: 'pass' } : on.phase === 'regroup' ? { type: 'resource', cards: [] } : legal[Math.floor(rng() * legal.length)]
    if (!a) {
      problems.push({ card: label, step: 'played on', kind: 'broken', detail: `no legal action for player ${p} (${on.phase})` })
      break
    }
    on = act(on, p, a, label, `played on (${on.phase})`, way)
  }
  return after
}

// The twin: the card's stats and keywords, none of its script
function twinOf(d: CardDef): CardDef {
  return { ...d, id: `${d.id}~twin`, name: `${d.name} (twin)`, text: '', backText: d.backText === undefined ? undefined : '', pilotText: d.pilotText === undefined ? undefined : '' }
}

const cards = dune.filter((d) => !filter || `${d.name} ${d.subtitle ?? ''}`.toLowerCase().includes(filter))
const started = Date.now()
for (const d of cards) {
  const label = `${d.name}${d.subtitle ? `, ${d.subtitle}` : ''}${d.id.includes('#back') ? ' (back)' : ''}`
  const status = scriptStatus(d)
  if (status === 'none' || status === 'outdated') unscripted.push(`${label} [${status}]`)
  // Quiet: a scripted card whose every step, on both boards, left the game as its twin's did
  const differs: string[] = []
  const tried: string[] = []
  for (const rich of [false, true]) {
    const real = runCard(d, { ai: true }, label, rich)
    for (const seed of [1, 2]) runCard(d, { ai: false, rng: seeded(seed * 7919 + d.id.length + (rich ? 1 : 0)) }, label, rich)
    if (!scriptFor(d)) continue
    const twin = runCard(twinOf(d), { ai: true }, `${label} (twin)`, rich)
    for (const [name, print] of real) {
      tried.push(`${rich ? 'rich ' : ''}${name}`)
      if (twin.get(name) !== print) differs.push(`${rich ? 'rich ' : ''}${name}`)
    }
  }
  if (scriptFor(d)) {
    if (process.env.SMOKE_DEBUG) for (const name of differs) {
      console.log(`${label}: differs at ${name}`)
    }
    if (!differs.length && tried.length) quiet.push({ card: label, lines: tried })
  }
}

// --- The report ---
const byCard = new Map<string, Problem[]>()
for (const p of problems) byCard.set(p.card, [...(byCard.get(p.card) ?? []), p])
console.log(`Smoke test: ${cards.length} cards, ${steps} actions, ${((Date.now() - started) / 1000).toFixed(0)} s`)
console.log(`\n${byCard.size} cards with errors or broken states`)
for (const [card, list] of byCard) {
  console.log(`  ${card}`)
  const seen = new Set<string>()
  for (const p of list) {
    const line = `    ${p.kind} at ${p.step}: ${p.detail}`
    if (!seen.has(line)) console.log(line)
    seen.add(line)
  }
}
console.log(`\n${quiet.length} scripted cards whose text changed nothing on the smoke board (look at these)`)
for (const q of quiet) console.log(`  ${q.card} (steps: ${q.lines.join(', ')})`)
if (unscripted.length) console.log(`\n${unscripted.length} cards with text no script plays\n  ${unscripted.join('\n  ')}`)
process.exit(byCard.size ? 1 : 0)
