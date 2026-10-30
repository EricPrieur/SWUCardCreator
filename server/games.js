import { randomBytes } from 'node:crypto'
import { Router } from 'express'
import { query, SCHEMA } from './db.js'
import { optionalUser } from './auth.js'

// The Simulator's games, saved as they are played: started, then saved again each round and
// at the end, by the browser holding the key it got when it started
const router = Router()

// What a record may weigh; a long game with the AI's reasons is well under it
const MAX_RECORD_BYTES = 900 * 1024
// Games one address may start in an hour
const STARTS_AN_HOUR = 60
const starts = new Map()

const STATUSES = new Set(['playing', 'finished', 'conceded', 'left'])
const isDev = (req) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.origin ?? '')

// The game as the browser sends it, checked: { record, summary }
function parse(body) {
  const { record, summary } = body ?? {}
  if (!record || typeof record !== 'object' || !Array.isArray(record.actions) || !Array.isArray(record.decks))
    return { error: 'record must be a game record' }
  if (!summary || typeof summary !== 'object' || !Array.isArray(summary.sides) || summary.sides.length !== 2)
    return { error: 'summary must have two sides' }
  if (!STATUSES.has(summary.status)) return { error: 'Unknown status' }
  const winner = summary.winner === 0 || summary.winner === 1 ? summary.winner : null
  const rounds = Number.isInteger(summary.rounds) && summary.rounds >= 0 ? summary.rounds : 0
  const json = JSON.stringify(record)
  if (json.length > MAX_RECORD_BYTES) return { error: 'The record is too big' }
  const side = (s) => ({
    name: String(s?.name ?? '').slice(0, 80),
    deck: String(s?.deck ?? '').slice(0, 80),
    seat: s?.seat === 'ai' ? 'ai' : 'human',
    leader: String(s?.leader ?? '').slice(0, 80),
    base: String(s?.base ?? '').slice(0, 80),
    cards: s?.cards && typeof s.cards === 'object' ? s.cards : {},
    played: Array.isArray(s?.played) ? s.played.map(String).slice(0, 200) : [],
  })
  const ai = Array.isArray(record.players) ? record.players.find((p) => p?.kind === 'ai') : undefined
  return {
    status: summary.status,
    winner,
    draw: summary.winner === 'draw',
    rounds,
    aiVersion: ai?.version ? String(ai.version).slice(0, 64) : null,
    sides: JSON.stringify(summary.sides.map(side)),
    names: JSON.stringify(summary.names && typeof summary.names === 'object' ? summary.names : {}),
    record: json,
    bytes: json.length,
  }
}

router.post('/games', optionalUser, async (req, res) => {
  const game = parse(req.body)
  if (game.error) return res.status(400).json({ error: game.error })
  const now = Date.now()
  const recent = (starts.get(req.ip) ?? []).filter((t) => now - t < 3600_000)
  if (recent.length >= STARTS_AN_HOUR) return res.status(429).json({ error: 'Too many games started; try again later' })
  starts.set(req.ip, [...recent, now])
  const key = randomBytes(16).toString('hex')
  try {
    const { rows } = await query(
      `INSERT INTO ${SCHEMA}.games (user_id, key, status, winner, draw, rounds, ai_version, sides, names, record, bytes, is_dev, finished_at)
       VALUES ($1, $2, $3::VARCHAR, $4, $5, $6, $7, $8, $9, $10, $11, $12, CASE WHEN $3::VARCHAR = 'playing' THEN NULL ELSE NOW() END)
       RETURNING id`,
      [req.user?.id ?? null, key, game.status, game.winner, game.draw, game.rounds, game.aiVersion, game.sides, game.names, game.record, game.bytes, isDev(req)],
    )
    res.json({ id: rows[0].id, key })
  } catch (err) {
    console.error('Game start error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Saved again; a game over stays as it ended
router.put('/games/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad game id' })
  const game = parse(req.body)
  if (game.error) return res.status(400).json({ error: game.error })
  try {
    const { rowCount } = await query(
      `UPDATE ${SCHEMA}.games SET status = $3::VARCHAR, winner = $4, draw = $5, rounds = $6, sides = $7, names = $8, record = $9, bytes = $10,
         updated_at = NOW(), finished_at = CASE WHEN $3::VARCHAR = 'playing' THEN NULL ELSE NOW() END
       WHERE id = $1 AND key = $2 AND status = 'playing'`,
      [id, String(req.body?.key ?? ''), game.status, game.winner, game.draw, game.rounds, game.sides, game.names, game.record, game.bytes],
    )
    if (!rowCount) return res.status(404).json({ error: 'Game not found' })
    res.json({ ok: true })
  } catch (err) {
    console.error('Game save error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
