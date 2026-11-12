// The full gauntlet: every Featured Deck against every other, so many games each, AI against AI.
// Each pairing is a matchup.ts run (its records in server/records/gauntlet-<a>-<b>.jsonl); a few
// run at once. Then the table of results and each deck's win rate, also kept in
// server/records/gauntlet.json for impact.ts and later comparison.
//
//   node tools/gauntlet.ts [games=50] [seed=1]
//
// JOBS: how many matchups run at once (3). RESUME=1: keep the pairings already played in full. DECKS: only these Featured Decks, comma separated
// (any part of each name). VARIANT and FEATURED are passed on to matchup.ts.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { featured } from './dune.ts'

const [gamesArg = '50', seedArg = '1'] = process.argv.slice(2)
const games = Number(gamesArg)
const jobs = Number(process.env.JOBS ?? 3)
const wanted = process.env.DECKS?.split(',').map((d) => d.trim().toLowerCase())
const decks = featured.map((d) => d.name).filter((name) => !wanted || wanted.some((w) => name.toLowerCase().includes(w)))
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const tools = fileURLToPath(new URL('.', import.meta.url))
const records = fileURLToPath(new URL('../records/', import.meta.url))

type Result = { a: string; b: string; winsA: number; winsB: number; other: number; rounds: number; records: string }
const pairs: [string, string][] = []
for (let i = 0; i < decks.length; i++) for (let j = i + 1; j < decks.length; j++) pairs.push([decks[i], decks[j]])

// A pairing already played in full (a run that was stopped): its results, read from its records
function done([a, b]: [string, string], name: string): Result | undefined {
  const file = `${records}${name}.jsonl`
  if (!existsSync(file)) return undefined
  const games_ = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  if (games_.length < games) return undefined
  const r: Result = { a, b, winsA: 0, winsB: 0, other: 0, rounds: 0, records: file }
  for (const g of games_.slice(0, games)) {
    const winner = g.result?.winner
    r.rounds += (g.result?.rounds ?? 0) / games
    if (winner === 0 || winner === 1) {
      if (g.decks[winner].name === a) r.winsA++
      else r.winsB++
    } else r.other++
  }
  return r
}

// One matchup in a process of its own; its first line says how it went. RESUME=1 keeps a pairing
// whose records are complete
function play([a, b]: [string, string]): Promise<Result> {
  const name = `gauntlet-${slug(a)}-${slug(b)}`
  const kept = process.env.RESUME ? done([a, b], name) : undefined
  if (kept) return Promise.resolve(kept)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`${tools}matchup.ts`, a, b, String(games), seedArg, name], { env: process.env })
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (out += chunk))
    child.on('close', (code) => {
      const m = out.match(/^(.+) (\d+), (.+) (\d+), other (\d+); ([\d.]+) rounds a game/m)
      if (code !== 0 || !m) return reject(new Error(`${a} vs ${b} failed:\n${out}`))
      resolve({ a, b, winsA: +m[2], winsB: +m[4], other: +m[5], rounds: +m[6], records: `${records}${name}.jsonl` })
    })
  })
}

const started = Date.now()
const results: Result[] = []
const queue = [...pairs]
await Promise.all(
  Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    for (let pair = queue.shift(); pair; pair = queue.shift()) {
      const r = await play(pair)
      results.push(r)
      const minutes = ((Date.now() - started) / 60000).toFixed(1)
      console.log(`[${results.length}/${pairs.length}, ${minutes} min] ${r.a} ${r.winsA} - ${r.winsB} ${r.b}`)
    }
  }),
)

// The table: each row's wins against each column
const short = (name: string) => name.split(' ')[0]
const wins = (x: string, y: string) => {
  const r = results.find((r) => (r.a === x && r.b === y) || (r.a === y && r.b === x))
  return r ? (r.a === x ? r.winsA : r.winsB) : NaN
}
console.log(`\n${games} games each pairing. Each row's wins against each column:\n`)
console.log(['', ...decks.map(short)].map((s) => s.padStart(9)).join(''))
for (const x of decks) console.log([short(x), ...decks.map((y) => (x === y ? '-' : String(wins(x, y))))].map((s) => s.padStart(9)).join(''))
const totals = decks
  .map((name) => {
    const won = decks.filter((y) => y !== name).reduce((sum, y) => sum + wins(name, y), 0)
    const played = (decks.length - 1) * games
    return { name, won, played, rate: won / played }
  })
  .sort((x, y) => y.rate - x.rate)
console.log('\nWin rate against the field:')
for (const t of totals) console.log(`  ${t.name.padEnd(22)} ${String(Math.round(100 * t.rate)).padStart(3)}%  (${t.won}/${t.played})`)
writeFileSync(`${records}gauntlet.json`, JSON.stringify({ games, seed: Number(seedArg), when: new Date().toISOString(), decks, results, totals }, null, 1))
console.log(`\nResults: ${records}gauntlet.json`)
