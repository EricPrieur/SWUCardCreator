// Which cards win games, from records: for each deck, each of its cards played in how many games,
// the deck's win rate in those games and in the others, and the difference (its impact). Then the
// same across every deck that plays the card. A card that wins far more often when played is
// where to look for a nerf; one that loses, for a buff. A high impact can also mean "played in
// longer games" (dear cards), so the cheap cards' numbers say more.
//
//   node tools/impact.ts [records files…]   (default: the last full gauntlet's)
//
// TOP: how many cards to show for each deck (10). VARIANT: as for matchup.ts, the same one the
// games were played with. Also writes server/records/impact.md.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { replay, type GameRecord } from '../engine/record.ts'
import { scripts } from '../engine/scripts.ts'
import { loadDefs } from './dune.ts'

const records = fileURLToPath(new URL('../records/', import.meta.url))
let files = process.argv.slice(2)
if (!files.length) files = JSON.parse(readFileSync(`${records}gauntlet.json`, 'utf8')).results.map((r: { records: string }) => r.records)
const top = Number(process.env.TOP ?? 10)
const defs = loadDefs()
if (process.env.VARIANT) (await import(pathToFileURL(process.env.VARIANT).href)).default(defs, scripts)
const nameOf = (id: string) => defs.find((d) => d.id === id)?.name ?? id

type Count = { plays: number; games: number; wins: number }
type Deck = { games: number; wins: number; cards: Record<string, Count> }
const decks: Record<string, Deck> = {}
for (const file of files) {
  for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
    const record: GameRecord = JSON.parse(line)
    const state = replay(record, defs)
    for (const p of [0, 1] as const) {
      const list = record.decks[p]
      const deck = (decks[list.name] ??= { games: 0, wins: 0, cards: {} })
      const won = state.winner === p
      deck.games++
      if (won) deck.wins++
      const mine = state.log.filter((l) => l.player === p).map((l) => l.text)
      for (const name of new Set(list.deck.map(nameOf))) {
        // Upgrades and Fortifications are logged as attached, not played
        const plays = mine.filter((text) => text.includes(` plays ${name}`) || text.includes(` attaches ${name} to `)).length
        const count = (deck.cards[name] ??= { plays: 0, games: 0, wins: 0 })
        count.plays += plays
        if (plays) {
          count.games++
          if (won) count.wins++
        }
      }
    }
  }
}

const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : NaN)
type Row = { name: string; plays: number; games: number; withRate: number; withoutRate: number; impact: number }
// Rows a deck has enough games for, both ways, to say anything
function rows(deck: Deck, least = Math.max(5, Math.round(deck.games / 20))): Row[] {
  return Object.entries(deck.cards)
    .filter(([, c]) => c.games >= least && deck.games - c.games >= least)
    .map(([name, c]) => {
      const withRate = pct(c.wins, c.games)
      const withoutRate = pct(deck.wins - c.wins, deck.games - c.games)
      return { name, plays: c.plays, games: c.games, withRate, withoutRate, impact: withRate - withoutRate }
    })
    .sort((a, b) => b.impact - a.impact)
}
const line = (r: Row) =>
  `| ${r.name} | ${r.plays} | ${r.games} | ${r.withRate}% | ${r.withoutRate}% | ${r.impact > 0 ? '+' : ''}${r.impact} |`
const head = '| Card | Played | In games | Won with | Won without | Impact |\n|---|---|---|---|---|---|'

const out: string[] = [`# Card impact\n\n${files.length} records files, ${Object.values(decks).reduce((s, d) => s + d.games, 0) / 2} games.\n`]
for (const [name, deck] of Object.entries(decks).sort((a, b) => b[1].wins / b[1].games - a[1].wins / a[1].games)) {
  const list = rows(deck)
  out.push(`## ${name}: ${deck.wins}/${deck.games} (${pct(deck.wins, deck.games)}%)\n`)
  out.push(`Most impact:\n\n${head}\n${list.slice(0, top).map(line).join('\n')}\n`)
  out.push(`Least impact:\n\n${head}\n${list.slice(-3).reverse().map(line).join('\n')}\n`)
}

// Across decks: a card's impact in each deck that plays it, weighted by the games it was played in
const across: Record<string, { games: number; weighted: number; decks: string[] }> = {}
for (const [name, deck] of Object.entries(decks)) {
  for (const r of rows(deck)) {
    const a = (across[r.name] ??= { games: 0, weighted: 0, decks: [] })
    a.games += r.games
    a.weighted += r.impact * r.games
    a.decks.push(name.split(' ')[0])
  }
}
const set = Object.entries(across)
  .map(([name, a]) => ({ name, games: a.games, impact: Math.round(a.weighted / a.games), decks: a.decks.join(', ') }))
  .sort((a, b) => b.impact - a.impact)
const setLine = (s: (typeof set)[number]) => `| ${s.name} | ${s.impact > 0 ? '+' : ''}${s.impact} | ${s.games} | ${s.decks} |`
const setHead = '| Card | Impact | In games | Decks |\n|---|---|---|---|'
out.push(`## Across the decks\n\nMost impact (nerf candidates):\n\n${setHead}\n${set.slice(0, 15).map(setLine).join('\n')}\n`)
out.push(`Least impact (buff candidates):\n\n${setHead}\n${set.slice(-10).reverse().map(setLine).join('\n')}\n`)

const text = out.join('\n')
writeFileSync(`${records}impact.md`, text)
console.log(text)
