// A recorded game rebuilt up to one of its moves, and what the AI as it is now would do there,
// beside what was done: to see what a change to the AI changes.
//
//   node tools/whatif.ts records/rabban-jessica.jsonl <game number, from 1> <move number, from 1>
// Move numbers are those of the record's actions; replay.ts shows the rounds they fall in.
import { readFileSync } from 'node:fs'
import { chooseAction, type Weighed } from '../engine/ai.ts'
import { replay, type GameRecord } from '../engine/record.ts'
import { describe, loadDefs } from './dune.ts'

const [file, gameArg = '1', moveArg = '1'] = process.argv.slice(2)
if (!file) throw new Error('Which records file?')
const records: GameRecord[] = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
const record = records[Number(gameArg) - 1]
const index = Number(moveArg) - 1
const step = record?.actions[index]
if (!step) throw new Error(`No move ${moveArg} in game ${gameArg} (${record?.actions.length ?? 0} moves)`)
const state = replay(record, loadDefs(), index)
const who = state.players[step.p].name
console.log(`Game ${gameArg}, move ${moveArg}: round ${state.round}, ${state.phase} phase, ${who} to act`)
if (state.prompt) console.log(`  Asked: ${state.prompt.text}`)
console.log(`  Recorded: ${describe(state, step.p, step.action)}`)
for (const w of step.why ?? []) console.log(`    weighed then: ${describe(state, step.p, w.action)}, ${w.gain}`)
const why: Weighed[] = []
const now = chooseAction(state, step.p, why)
console.log(`  The AI now: ${now ? describe(state, step.p, now) : 'nothing'}`)
for (const w of why.slice(0, 5)) console.log(`    weighs: ${describe(state, step.p, w.action)}, ${w.gain}`)
