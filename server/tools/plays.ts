// How a card is played in a records file: each time it was played, the board before, what it
// did (its log lines) and what it changed: enemy units defeated and damage dealt to them, friendly
// units and Spice tokens it cost. Then the averages.
//
//   node tools/plays.ts records/rabban-jessica.jsonl "The Baron's Wrath" [how many to show]
import { readFileSync } from 'node:fs'
import { hpOf } from '../engine/game.ts'
import { replay, type GameRecord } from '../engine/record.ts'
import type { GameState, PlayerId } from '../engine/types.ts'
import { loadDefs } from './dune.ts'

const [file, cardName, showArg = '8'] = process.argv.slice(2)
if (!file || !cardName) throw new Error('Which records file, and which card?')
const records: GameRecord[] = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
const defs = loadDefs()
const ids = new Set(defs.filter((d) => d.name.toLowerCase() === cardName.toLowerCase()).map((d) => d.id))
if (!ids.size) throw new Error(`No card named ${cardName}`)

const foe = (p: PlayerId): PlayerId => (p === 0 ? 1 : 0)
const unitText = (state: GameState, p: PlayerId) =>
  state.players[p].units.map((u) => `${state.defs[u.def].name} ${hpOf(state, u) - u.damage}hp`).join(', ') || 'none'

type Play = {
  game: number
  round: number
  p: PlayerId
  won: boolean
  before: GameState
  lines: string[]
  killed: number
  damage: number
  wasted: number
  lost: number
  spice: number
  enemies: number
}
const plays: Play[] = []

records.forEach((record, g) => {
  let open: { p: PlayerId; before: GameState; logAt: number } | null = null
  const close = (after: GameState) => {
    if (!open) return
    const { p, before } = open
    const e = foe(p)
    let killed = 0
    let damage = 0
    for (const u of before.players[e].units) {
      const now = after.players[e].units.find((x) => x.id === u.id)
      const left = hpOf(before, u) - u.damage
      if (!now) {
        killed++
        damage += left
      } else damage += now.damage - u.damage
    }
    // Damage to its own side's units that stayed
    let wasted = 0
    for (const u of before.players[p].units) {
      const now = after.players[p].units.find((x) => x.id === u.id)
      if (now) wasted += Math.max(0, now.damage - u.damage)
    }
    plays.push({
      game: g + 1,
      round: before.round,
      p,
      won: record.result?.winner === p,
      before,
      lines: after.log.slice(open.logAt).map((l) => l.text),
      killed,
      damage,
      wasted,
      lost: before.players[p].units.filter((u) => !after.players[p].units.some((x) => x.id === u.id)).length,
      spice: before.players[p].spice.length - after.players[p].spice.length,
      enemies: before.players[e].units.length,
    })
    open = null
  }
  const end = replay(record, defs, record.actions.length, (state, step) => {
    // A play goes on through the answers to the questions it asks
    if (open && !(step.action.type === 'answer' && state.prompt)) close(state)
    if (step.action.type === 'play' && step.card && ids.has(step.card)) open = { p: step.p, before: state, logAt: state.log.length }
  })
  close(end)
})

const show = Number(showArg)
for (const play of plays.slice(0, show)) {
  const { before, p } = play
  console.log(`\nGame ${play.game}, round ${play.round}, ${before.players[p].name}${play.won ? ' (won the game)' : ''}`)
  console.log(`  its units: ${unitText(before, p)}; Spice tokens ${before.players[p].spice.length}; resources ${before.players[p].resources.length}`)
  console.log(`  enemy units: ${unitText(before, foe(p))}`)
  for (const line of play.lines) console.log(`    ${line}`)
}
const avg = (f: (p: Play) => number) => (plays.length ? (plays.reduce((s, p) => s + f(p), 0) / plays.length).toFixed(2) : '-')
console.log(`\n${plays.length} plays of ${cardName} in ${records.length} games`)
console.log(`  enemy units there ${avg((p) => p.enemies)}, defeated ${avg((p) => p.killed)}, damage to enemy units ${avg((p) => p.damage)}`)
console.log(`  damage to its own units that lived ${avg((p) => p.wasted)}; own units lost ${avg((p) => p.lost)}; Spice tokens spent ${avg((p) => p.spice)}`)
console.log(`  defeated nothing: ${plays.filter((p) => !p.killed).length}; played with no enemy unit: ${plays.filter((p) => !p.enemies).length}`)
console.log(`  by round: ${Object.entries(plays.reduce<Record<number, number>>((m, p) => ((m[p.round] = (m[p.round] ?? 0) + 1), m), {})).map(([r, n]) => `r${r}:${n}`).join(' ')}`)
