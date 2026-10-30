import { Router } from 'express'
import { query, SCHEMA } from './db.js'
import { verifyToken, requireAdmin, enforcePermanentAdmins, userPublic, PERMANENT_ADMINS } from './auth.js'

const router = Router()
router.use(verifyToken, requireAdmin)

// Every account, newest first
router.get('/users', async (req, res) => {
  try {
    await enforcePermanentAdmins()
    const { rows } = await query(
      `SELECT u.id, u.username, u.is_admin, u.is_tester, u.quota_bytes, u.can_publish, u.created_at, u.last_login_at, u.discord_username,
         (u.password_hash IS NOT NULL) AS has_password,
         COALESCE((SELECT SUM(bytes) FROM ${SCHEMA}.cards c WHERE c.user_id = u.id), 0)
       + COALESCE((SELECT SUM(bytes) FROM ${SCHEMA}.images i WHERE i.user_id = u.id), 0)
       + COALESCE((SELECT SUM(bytes) FROM ${SCHEMA}.decks d WHERE d.user_id = u.id), 0) AS used_bytes,
         (SELECT COUNT(*) FROM ${SCHEMA}.cards c WHERE c.user_id = u.id)::INT AS card_count,
         (SELECT COUNT(*) FROM ${SCHEMA}.games g WHERE g.user_id = u.id)::INT AS game_count,
         (SELECT MAX(started_at) FROM ${SCHEMA}.games g WHERE g.user_id = u.id) AS last_game_at
       FROM ${SCHEMA}.users u ORDER BY u.created_at DESC`,
    )
    res.json({
      users: rows.map((row) => ({
        ...userPublic(row),
        lastLoginAt: row.last_login_at,
        usedBytes: Number(row.used_bytes),
        cardCount: row.card_count,
        gameCount: row.game_count,
        lastGameAt: row.last_game_at,
        permanent: PERMANENT_ADMINS.has(row.username.toLowerCase()),
      })),
    })
  } catch (err) {
    console.error('Admin users error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Change an account's admin or tester flag, storage limit (quotaBytes null: no limit), or
// whether it may make cards public
router.patch('/users/:id', async (req, res) => {
  const id = Number(req.params.id)
  const { isAdmin, isTester, quotaBytes, canPublish } = req.body ?? {}
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad user id' })
  if (isAdmin !== undefined && typeof isAdmin !== 'boolean') return res.status(400).json({ error: 'isAdmin must be true or false' })
  if (isTester !== undefined && typeof isTester !== 'boolean') return res.status(400).json({ error: 'isTester must be true or false' })
  if (canPublish !== undefined && typeof canPublish !== 'boolean')
    return res.status(400).json({ error: 'canPublish must be true or false' })
  if (quotaBytes !== undefined && quotaBytes !== null && !(Number.isInteger(quotaBytes) && quotaBytes >= 0))
    return res.status(400).json({ error: 'quotaBytes must be a whole number of bytes, or null' })

  try {
    const { rows: found } = await query(`SELECT username FROM ${SCHEMA}.users WHERE id = $1`, [id])
    if (!found.length) return res.status(404).json({ error: 'User not found' })
    if (PERMANENT_ADMINS.has(found[0].username.toLowerCase()))
      return res.status(403).json({ error: 'This account is a permanent admin' })
    const { rows } = await query(
      `UPDATE ${SCHEMA}.users SET
         is_admin = COALESCE($2, is_admin),
         quota_bytes = CASE WHEN $3 THEN $4::BIGINT ELSE quota_bytes END,
         can_publish = COALESCE($5, can_publish),
         is_tester = COALESCE($6, is_tester)
       WHERE id = $1
       RETURNING id, username, is_admin, is_tester, quota_bytes, can_publish, created_at, discord_username, (password_hash IS NOT NULL) AS has_password`,
      [id, isAdmin ?? null, quotaBytes !== undefined, quotaBytes ?? null, canPublish ?? null, isTester ?? null],
    )
    res.json({ user: userPublic(rows[0]) })
  } catch (err) {
    console.error('Admin update error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// The Simulator's games. Each list and count takes ?days= (none: all of them) and ?dev=1 to
// count the games played on a developer's computer too. A game still 'playing' an hour after it
// was last saved was left without a word: abandoned.
const ABANDONED = `status = 'playing' AND updated_at < NOW() - INTERVAL '1 hour'`
const statusOf = `CASE WHEN ${ABANDONED} THEN 'abandoned' ELSE status END`
function gameFilter(req, alias = '') {
  const a = alias ? `${alias}.` : ''
  const where = []
  if (req.query.dev !== '1') where.push(`NOT ${a}is_dev`)
  const days = Number(req.query.days)
  if (Number.isFinite(days) && days > 0) where.push(`${a}started_at > NOW() - INTERVAL '1 day' * ${Math.min(3650, Math.floor(days))}`)
  return where.length ? `WHERE ${where.join(' AND ')}` : ''
}
const OVER = `status IN ('finished', 'conceded')`
const and = (where, more) => (where ? `${where} AND ${more}` : `WHERE ${more}`)
// A side's cards left out of the lists, where they would only weigh
const slim = (sides) =>
  sides.map(({ cards, played, ...side }) => ({
    ...side,
    cardCount: Object.values(cards ?? {}).reduce((a, b) => a + b, 0),
    playedCount: played?.length ?? 0,
  }))
const fail = (res, what) => (err) => {
  console.error(`Admin ${what} error:`, err)
  res.status(500).json({ error: 'Server error' })
}

// What is being played: how many games lately, how they ended, how long they last, how people
// fare against the AI
router.get('/game-stats', async (req, res) => {
  const where = gameFilter(req)
  try {
    const [counts, statuses, lengths, humans, versions, days] = await Promise.all([
      query(
        `SELECT COUNT(*) FILTER (WHERE started_at > NOW() - INTERVAL '1 hour')::INT AS hour,
           COUNT(*) FILTER (WHERE started_at > NOW() - INTERVAL '1 day')::INT AS day,
           COUNT(*) FILTER (WHERE started_at > NOW() - INTERVAL '7 days')::INT AS week,
           COUNT(*)::INT AS total,
           COUNT(DISTINCT user_id)::INT AS accounts,
           COUNT(*) FILTER (WHERE user_id IS NULL)::INT AS anonymous,
           COUNT(*) FILTER (WHERE status = 'playing' AND NOT (${ABANDONED}))::INT AS live
         FROM ${SCHEMA}.games ${where}`,
      ),
      query(`SELECT ${statusOf} AS status, COUNT(*)::INT AS games FROM ${SCHEMA}.games ${where} GROUP BY 1`),
      query(
        `SELECT AVG(rounds)::FLOAT AS rounds, AVG(EXTRACT(EPOCH FROM finished_at - started_at))::FLOAT AS seconds
         FROM ${SCHEMA}.games ${and(where, OVER)}`,
      ),
      // A person against the AI: the side whose seat is human
      query(
        `SELECT COUNT(*)::INT AS games,
           COUNT(*) FILTER (WHERE winner IS NOT NULL AND sides -> winner ->> 'seat' = 'human')::INT AS wins,
           COUNT(*) FILTER (WHERE draw)::INT AS draws
         FROM ${SCHEMA}.games ${and(where, OVER)}`,
      ),
      query(
        `SELECT COALESCE(ai_version, '?') AS version, COUNT(*)::INT AS games,
           COUNT(*) FILTER (WHERE winner IS NOT NULL AND sides -> winner ->> 'seat' = 'ai')::INT AS wins
         FROM ${SCHEMA}.games ${and(where, OVER)} GROUP BY 1 ORDER BY 2 DESC`,
      ),
      query(
        `SELECT TO_CHAR(DATE_TRUNC('day', started_at), 'YYYY-MM-DD') AS day, COUNT(*)::INT AS games
         FROM ${SCHEMA}.games ${and(where, `started_at > NOW() - INTERVAL '14 days'`)} GROUP BY 1 ORDER BY 1`,
      ),
    ])
    res.json({
      ...counts.rows[0],
      statuses: Object.fromEntries(statuses.rows.map((r) => [r.status, r.games])),
      averageRounds: lengths.rows[0].rounds,
      averageSeconds: lengths.rows[0].seconds,
      humans: humans.rows[0],
      aiVersions: versions.rows,
      perDay: days.rows,
    })
  } catch (err) {
    fail(res, 'game stats')(err)
  }
})

// The latest games, newest first, without their records
router.get('/games', async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200))
  query(
    `SELECT g.id, g.mode, ${statusOf} AS status, g.winner, g.draw, g.rounds, g.ai_version, g.sides, g.names, g.bytes, g.is_dev,
       g.started_at, g.updated_at, g.finished_at, u.username, jsonb_array_length(g.record -> 'actions') AS moves
     FROM ${SCHEMA}.games g LEFT JOIN ${SCHEMA}.users u ON u.id = g.user_id
     ${gameFilter(req, 'g')} ORDER BY g.started_at DESC LIMIT ${limit}`,
  )
    .then(({ rows }) => res.json({ games: rows.map((row) => ({ ...row, sides: slim(row.sides) })) }))
    .catch(fail(res, 'games'))
})

// One game, its record too
router.get('/games/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad game id' })
  query(
    `SELECT g.id, g.mode, ${statusOf} AS status, g.winner, g.draw, g.rounds, g.ai_version, g.sides, g.names, g.record, g.bytes, g.is_dev,
       g.started_at, g.updated_at, g.finished_at, u.username
     FROM ${SCHEMA}.games g LEFT JOIN ${SCHEMA}.users u ON u.id = g.user_id WHERE g.id = $1`,
    [id],
  )
    .then(({ rows }) => (rows.length ? res.json({ game: rows[0] }) : res.status(404).json({ error: 'Game not found' })))
    .catch(fail(res, 'game'))
})

// The games over that the stats count, and each side's how it went
async function sidesOver(req) {
  const { rows } = await query(`SELECT winner, draw, sides, names FROM ${SCHEMA}.games ${and(gameFilter(req), OVER)} ORDER BY started_at`)
  const names = {}
  const sides = []
  // The oldest names first, so today's win
  for (const row of rows) {
    Object.assign(names, row.names)
    row.sides.forEach((side, p) => sides.push({ ...side, won: row.winner === p }))
  }
  return { sides, names, games: rows.length }
}
const tallyOf = () => ({ games: 0, wins: 0 })
const count = (tally, side) => {
  tally.games++
  if (side.won) tally.wins++
}

// Which leaders and decks are played, by people and by the AI, and how they fare
router.get('/deck-stats', async (req, res) => {
  try {
    const { sides, names, games } = await sidesOver(req)
    const leaders = new Map()
    const decks = new Map()
    for (const side of sides) {
      const leader = leaders.get(side.leader) ?? { leader: side.leader, human: tallyOf(), ai: tallyOf(), bases: {} }
      leaders.set(side.leader, leader)
      count(leader[side.seat], side)
      leader.bases[side.base] = (leader.bases[side.base] ?? 0) + 1
      const key = `${side.deck}|${side.leader}|${side.base}`
      const deck = decks.get(key) ?? { deck: side.deck, leader: side.leader, base: side.base, human: tallyOf(), ai: tallyOf() }
      decks.set(key, deck)
      count(deck[side.seat], side)
    }
    const plays = (row) => row.human.games + row.ai.games
    res.json({
      games,
      names,
      leaders: [...leaders.values()].sort((a, b) => plays(b) - plays(a)),
      decks: [...decks.values()].sort((a, b) => plays(b) - plays(a)),
    })
  } catch (err) {
    fail(res, 'deck stats')(err)
  }
})

// Each card: the games it was in a deck in, those it was played in, and the deck's wins then.
// ?seat=human or ai counts only that side's decks.
router.get('/card-stats', async (req, res) => {
  try {
    const { sides, names, games } = await sidesOver(req)
    const seat = req.query.seat === 'human' || req.query.seat === 'ai' ? req.query.seat : null
    const cards = new Map()
    for (const side of sides) {
      if (seat && side.seat !== seat) continue
      const played = new Set(side.played)
      for (const [id, copies] of Object.entries(side.cards ?? {})) {
        const card = cards.get(id) ?? { id, name: names[id] ?? id, decks: 0, copies: 0, wins: 0, played: 0, winsPlayed: 0 }
        cards.set(id, card)
        card.decks++
        card.copies += copies
        if (side.won) card.wins++
        if (played.has(id)) {
          card.played++
          if (side.won) card.winsPlayed++
        }
      }
    }
    res.json({ games, cards: [...cards.values()].sort((a, b) => b.decks - a.decks) })
  } catch (err) {
    fail(res, 'card stats')(err)
  }
})

export default router
