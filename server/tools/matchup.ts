// AI against AI with two Featured Decks, each game kept as a record, one per line, in
// server/records/<name>.jsonl (not committed). Seats are swapped each game.
//
//   node tools/matchup.ts rabban jessica 100 [seed] [name]
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chooseAction, type Weighed } from '../engine/ai.ts'
import { createGame } from '../engine/game.ts'
import { recordAction, startRecord } from '../engine/record.ts'
import { deckList, loadDefs } from './dune.ts'

const [a = 'rabban', b = 'jessica', count = '20', seedArg = '1', nameArg] = process.argv.slice(2)
const defs = loadDefs()
const decks = [deckList(a, defs), deckList(b, defs)]
const name = nameArg ?? `${a}-${b}`
const dir = fileURLToPath(new URL('../records/', import.meta.url))
mkdirSync(dir, { recursive: true })
const file = `${dir}${name}.jsonl`
writeFileSync(file, '')

const wins = [0, 0]
let draws = 0
let rounds = 0
for (let g = 0; g < Number(count); g++) {
  const seed = Number(seedArg) * 1000 + g
  // Deck a sits first in even games, second in odd ones
  const seats = g % 2 === 0 ? [0, 1] : [1, 0]
  const lists = [decks[seats[0]], decks[seats[1]]] as [typeof decks[0], typeof decks[0]]
  const record = startRecord(seed, lists, [{ kind: 'ai' }, { kind: 'ai' }], name)
  let state = createGame({ seed, defs, decks: lists })
  for (let steps = 0; state.phase !== 'over' && steps < 5000; steps++) {
    let moved = false
    for (const p of [0, 1] as const) {
      const why: Weighed[] = []
      const action = chooseAction(state, p, why)
      if (!action) continue
      state = recordAction(record, state, p, action, why.slice(0, 3))
      moved = true
      break
    }
    if (!moved) break
  }
  appendFileSync(file, JSON.stringify(record) + '\n')
  rounds += state.round
  if (state.phase !== 'over' || state.winner === 'draw' || state.winner == null) draws++
  else wins[seats[state.winner]]++
}
console.log(`${decks[0].name} ${wins[0]}, ${decks[1].name} ${wins[1]}, other ${draws}; ${(rounds / Number(count)).toFixed(1)} rounds a game`)
console.log(`Records: ${file}`)
