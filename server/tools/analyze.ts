// What the games in a records file show, for each deck: its wins, the base damage it deals each
// round, when its leader deploys, and how it deals with enemy Sentinels: at each of its moves
// while a Sentinel holds back units it has ready, what it did, and whether those units could
// have defeated the Sentinel between them.
//
//   node tools/analyze.ts records/rabban-jessica.jsonl
import { readFileSync } from 'node:fs'
import { hpOf, keywordsOf, powerOf } from '../engine/game.ts'
import { replay, type GameRecord } from '../engine/record.ts'
import type { GameState, PlayerId, UnitState } from '../engine/types.ts'
import { loadDefs } from './dune.ts'

const file = process.argv[2]
if (!file) throw new Error('Which records file?')
const records: GameRecord[] = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
const defs = loadDefs()

type Tally = {
  games: number
  wins: number
  firstGames: number
  firstWins: number
  damage: number[]
  deployRounds: number[]
  blockedMoves: number
  could: number
  did: Record<string, number>
  didWhenCould: Record<string, number>
  sentinelRounds: number[]
  // Rounds a Sentinel could have been defeated in, by the units then ready, and those it lived through
  killableRounds: number
  survived: number
  // Rounds' attacking: the power of the units ready as the action phase starts, and where it went
  rounds: number
  readyPower: number
  powerAt: Record<string, number>
  baseDamage: number
}
const tallies = new Map<string, Tally>()
const tally = (name: string) => {
  if (!tallies.has(name))
    tallies.set(name, { games: 0, wins: 0, firstGames: 0, firstWins: 0, damage: [], deployRounds: [], blockedMoves: 0, could: 0, did: {}, didWhenCould: {}, sentinelRounds: [], killableRounds: 0, survived: 0, rounds: 0, readyPower: 0, powerAt: {}, baseDamage: 0 })
  return tallies.get(name)!
}
const add = (map: Record<string, number>, key: string) => (map[key] = (map[key] ?? 0) + 1)
const foe = (p: PlayerId): PlayerId => (p === 0 ? 1 : 0)
const sentinels = (state: GameState, p: PlayerId) => state.players[p].units.filter((u) => keywordsOf(state, u).sentinel)

for (const record of records) {
  const names = record.decks.map((d) => d.name)
  let first: PlayerId | undefined
  const baseDamage = [0, 0]
  const deployed: (number | undefined)[] = [undefined, undefined]
  // Each enemy Sentinel's first and last round in play, by the side facing it
  const seen = new Map<string, { facing: PlayerId; from: number; to: number }>()
  // Each Sentinel's rounds in which the units facing it could have defeated it
  const killable = new Map<string, Set<number>>()
  // This round's: the units ready as it started, with their power; those that attacked; base
  // damage then
  let round = 0
  let closed = true
  let ready: Map<string, number>[] = [new Map(), new Map()]
  let attacked: Set<string>[] = [new Set(), new Set()]
  let damageAt = [0, 0]
  const powerTo = (p: PlayerId, where: string, power: number) => {
    const t = tally(names[p])
    t.powerAt[where] = (t.powerAt[where] ?? 0) + power
  }
  // The round's end: what the units ready at its start did not do, and why
  const close = (state: GameState) => {
    if (closed) return
    closed = true
    for (const p of [0, 1] as PlayerId[]) {
      const t = tally(names[p])
      t.rounds++
      t.baseDamage += state.players[foe(p)].base.damage - damageAt[foe(p)]
      for (const [id, power] of ready[p]) {
        if (attacked[p].has(id)) continue
        const unit = state.players[p].units.find((u) => u.id === id)
        const guarded = unit && sentinels(state, foe(p)).some((g) => g.arena === unit.arena)
        powerTo(
          p,
          !unit ? 'idle: defeated before it attacked' : unit.exhausted ? 'idle: exhausted by a card' : guarded ? 'idle: kept back, a Sentinel in the way' : 'idle: kept back, the base open',
          power,
        )
      }
    }
  }
  const end = replay(record, defs, record.actions.length, (state, step) => {
    if (state.phase === 'action' && first === undefined) first = state.active
    if (state.phase !== 'action') close(state)
    if (state.phase === 'action' && state.round !== round) {
      round = state.round
      closed = false
      ready = [0, 1].map((p) => new Map(state.players[p].units.filter((u) => !u.exhausted).map((u) => [u.id, powerOf(state, u, true)])))
      attacked = [new Set(), new Set()]
      damageAt = [state.players[0].base.damage, state.players[1].base.damage]
      for (const p of [0, 1] as PlayerId[]) for (const power of ready[p].values()) tally(names[p]).readyPower += power
    }
    const a = step.action
    if (state.phase === 'action' && !state.prompt && a.type === 'attack' && ready[step.p].has(a.attacker) && !attacked[step.p].has(a.attacker)) {
      attacked[step.p].add(a.attacker)
      const unit = state.players[step.p].units.find((u) => u.id === a.attacker)!
      powerTo(step.p, a.target === 'base' ? 'attacked the base' : 'attacked a unit', powerOf(state, unit, true))
    }
    for (const p of [0, 1] as PlayerId[]) {
      if (state.players[p].leader.deployed && deployed[p] === undefined) deployed[p] = state.round
      for (const s of sentinels(state, p)) {
        const known = seen.get(s.id)
        if (known) known.to = state.round
        else seen.set(s.id, { facing: foe(p), from: state.round, to: state.round })
      }
    }
    if (state.phase !== 'action' || state.prompt) return
    const p = step.p
    const guards = sentinels(state, foe(p))
    const held = state.players[p].units.filter((u) => !u.exhausted && guards.some((g) => g.arena === u.arena))
    if (!held.length) return
    const t = tally(names[p])
    t.blockedMoves++
    // Those units could defeat a Sentinel between them, combat damage only
    const left = (g: UnitState) => hpOf(state, g) - g.damage
    const beatable = guards.filter((g) => held.filter((u) => u.arena === g.arena).reduce((sum, u) => sum + powerOf(state, u, true), 0) >= left(g))
    for (const g of beatable) killable.set(g.id, (killable.get(g.id) ?? new Set()).add(state.round))
    const could = beatable.length > 0
    const what =
      a.type === 'attack'
        ? guards.some((g) => g.id === a.target)
          ? 'attack the Sentinel'
          : a.target === 'base'
            ? 'attack the base (other arena)'
            : 'attack another unit'
        : a.type === 'play'
          ? 'play a card'
          : a.type === 'pass' || a.type === 'initiative'
            ? 'pass / take the initiative'
            : a.type
    add(t.did, what)
    if (could) {
      t.could++
      add(t.didWhenCould, what)
    }
  })
  close(end)
  for (const p of [0, 1] as PlayerId[]) {
    const t = tally(names[p])
    t.games++
    if (end.winner === p) t.wins++
    if (first === p) {
      t.firstGames++
      if (end.winner === p) t.firstWins++
    }
    baseDamage[foe(p)] = end.players[foe(p)].base.damage
    t.damage.push(baseDamage[foe(p)] / Math.max(1, end.round))
    if (deployed[p] !== undefined) t.deployRounds.push(deployed[p]!)
  }
  for (const [id, s] of seen) {
    const t = tally(names[s.facing])
    t.sentinelRounds.push(s.to - s.from + 1)
    // Still there in a later round: it lived through the round it could have been defeated in
    for (const round of killable.get(id) ?? []) {
      t.killableRounds++
      if (s.to > round) t.survived++
    }
  }
}

const avg = (list: number[]) => (list.length ? (list.reduce((a, b) => a + b, 0) / list.length).toFixed(1) : '-')
const pct = (n: number, of: number) => (of ? `${Math.round((100 * n) / of)}%` : '-')
console.log(`${records.length} games from ${file}`)
for (const [name, t] of tallies) {
  console.log(`\n${name}`)
  console.log(`  wins ${t.wins}/${t.games} (${pct(t.wins, t.games)}); going first ${t.firstWins}/${t.firstGames}`)
  console.log(`  base damage dealt a round ${avg(t.damage)}; leader deployed in round ${avg(t.deployRounds)} (${t.deployRounds.length} games)`)
  console.log(`  a round: ${(t.readyPower / t.rounds).toFixed(1)} power ready as it starts, ${(t.baseDamage / t.rounds).toFixed(1)} base damage dealt`)
  for (const [where, power] of Object.entries(t.powerAt).sort((a, b) => b[1] - a[1]))
    console.log(`    ${where.padEnd(40)} ${pct(power, t.readyPower)} of it`)
  console.log(`  enemy Sentinels faced: ${t.sentinelRounds.length}, each standing ${avg(t.sentinelRounds)} rounds`)
  console.log(`  rounds a Sentinel could have been defeated in by the units ready: ${t.killableRounds}, it lived through ${t.survived} (${pct(t.survived, t.killableRounds)})`)
  console.log(`  moves with ready units held back by a Sentinel: ${t.blockedMoves}`)
  for (const [what, n] of Object.entries(t.did).sort((a, b) => b[1] - a[1])) console.log(`    ${what.padEnd(32)} ${pct(n, t.blockedMoves)}`)
  console.log(`  of them, when those units could defeat it together: ${t.could}`)
  for (const [what, n] of Object.entries(t.didWhenCould).sort((a, b) => b[1] - a[1])) console.log(`    ${what.padEnd(32)} ${pct(n, t.could)}`)
}
