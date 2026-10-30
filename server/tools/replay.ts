// A recorded game, round by round: the board as each round's action phase starts, each action
// with what came of it (the game's log), and for the AI's moves the others it weighed.
//
//   node tools/replay.ts records/rabban-jessica.jsonl [game number, from 1] [first round] [last round]
import { readFileSync } from 'node:fs'
import { hpOf, powerOf } from '../engine/game.ts'
import { replay, type GameRecord } from '../engine/record.ts'
import type { GameState, PlayerId } from '../engine/types.ts'
import { describe, loadDefs } from './dune.ts'

const [file, gameArg = '1', fromArg = '1', toArg = '99'] = process.argv.slice(2)
if (!file) throw new Error('Which records file?')
const records: GameRecord[] = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
const record = records[Number(gameArg) - 1]
if (!record) throw new Error(`There are ${records.length} games in ${file}`)
const [from, to] = [Number(fromArg), Number(toArg)]
const defs = loadDefs()

const winner = record.result?.winner
console.log(`Game ${gameArg} of ${records.length}, seed ${record.seed}: ${record.decks[0].name} vs ${record.decks[1].name}`)
console.log(`  ${winner === 0 || winner === 1 ? `${record.decks[winner].name} wins` : 'no winner'} in round ${record.result?.rounds ?? '?'}`)

const board = (state: GameState) => {
  for (const p of [0, 1] as PlayerId[]) {
    const player = state.players[p]
    const base = state.defs[player.base.def]
    const units = player.units.map((u) => {
      const d = state.defs[u.def]
      const tags = [
        u.exhausted && 'exhausted',
        u.damage && `${u.damage} damage`,
        u.upgrades.length && u.upgrades.map((x) => state.defs[x.def].name).join('+'),
      ].filter(Boolean)
      return `${d.name} ${powerOf(state, u)}/${hpOf(state, u)}${tags.length ? ` (${tags.join(', ')})` : ''}`
    })
    console.log(
      `    ${player.name}: base ${base.hp - player.base.damage}/${base.hp}, ${player.hand.length} in hand, ` +
        `${player.resources.length} resources, ${player.spice.length} Spice${player.leader.deployed ? '' : ', leader not deployed'}`,
    )
    console.log(`      ${units.join(' · ') || 'no units'}`)
  }
}

let round = 0
let logged = 0
const show = (state: GameState) => state.round >= from && state.round <= to
replay(record, defs, record.actions.length, (state, step) => {
  // What the last action led to, from the game's own log
  if (show(state)) for (const entry of state.log.slice(logged)) console.log(`        · ${entry.text}`)
  logged = state.log.length
  if (state.phase === 'action' && state.round !== round) {
    round = state.round
    if (show(state)) {
      console.log(`\n  Round ${round}`)
      board(state)
    }
  }
  if (!show(state) || state.phase !== 'action') return
  const same = (w: { action: unknown }) => JSON.stringify(w.action) === JSON.stringify(step.action)
  const chosen = step.why?.find(same)
  console.log(`    ${state.players[step.p].name}: ${describe(state, step.p, step.action)}${chosen ? ` (${chosen.gain})` : ''}`)
  for (const other of step.why?.filter((w) => !same(w)) ?? []) console.log(`        (weighed: ${describe(state, step.p, other.action)}, ${other.gain})`)
})
