// The games the server kept (the games table), of one pool, as a records file the other tools read
// (impact.ts, analyze.ts, replay.ts): your Simulator games against the AI, on the SWU tab, say.
// Finished games only. Reads the database in DATABASE_URL: this computer's, from `npm run local`,
// unless set.
//
//   node tools/stored-games.ts [pool=SWU] [records file=records/stored-<pool>.jsonl]
//   POOL=SWU node tools/impact.ts records/stored-SWU.jsonl
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const [pool = 'SWU', outArg] = process.argv.slice(2)
const out = outArg ?? fileURLToPath(new URL(`../records/stored-${pool}.jsonl`, import.meta.url))
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgresql://local:local@localhost:54330/postgres' })
await db.connect()
const { rows } = await db.query(`SELECT record, finished_at FROM dune.games WHERE pool = $1 AND status IN ('finished', 'conceded') ORDER BY started_at`, [pool])
await db.end()
const lines = rows.map((r) => (typeof r.record === 'string' ? r.record : JSON.stringify(r.record)))
writeFileSync(out, lines.join('\n') + (lines.length ? '\n' : ''))
console.log(`${lines.length} finished ${pool} games written to ${out}`)
