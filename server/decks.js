import { Router } from 'express'
import { query, SCHEMA } from './db.js'
import { verifyToken } from './auth.js'
import { fits, quotaError } from './cards.js'

// A deck names its cards by id, so it stays small
const MAX_DECK_BYTES = 32 * 1024
// Which Deck Builder a deck belongs to: "showroom", or "showcase:<folder>" for a set's
const SCOPE = /^[\w:.-]{1,64}$/
const DECK_ID = /^[\w-]{1,64}$/

const router = Router()

// The account's decks of one Deck Builder, oldest first, as the app lists them
router.get('/decks/:scope', verifyToken, async (req, res) => {
  if (!SCOPE.test(req.params.scope)) return res.status(400).json({ error: 'Bad deck scope' })
  try {
    const { rows } = await query(
      `SELECT data FROM ${SCHEMA}.decks WHERE user_id = $1 AND scope = $2 ORDER BY created_at`,
      [req.user.id, req.params.scope],
    )
    res.json({ decks: rows.map((row) => row.data) })
  } catch (err) {
    console.error('Decks error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Adds a deck, or replaces it: { data }, the deck as the app keeps it
router.put('/decks/:scope/:id', verifyToken, async (req, res) => {
  const { scope, id } = req.params
  const data = req.body?.data
  if (!SCOPE.test(scope) || !DECK_ID.test(id)) return res.status(400).json({ error: 'Bad deck id' })
  if (!data || typeof data !== 'object' || Array.isArray(data)) return res.status(400).json({ error: 'Deck data required' })
  const text = JSON.stringify({ ...data, id })
  const bytes = Buffer.byteLength(text)
  if (bytes > MAX_DECK_BYTES) return res.status(413).json({ error: 'This deck is too big to save.' })
  try {
    const { rows: old } = await query(`SELECT bytes FROM ${SCHEMA}.decks WHERE user_id = $1 AND scope = $2 AND id = $3`, [
      req.user.id,
      scope,
      id,
    ])
    if (!(await fits(req.user.id, bytes - (old[0]?.bytes ?? 0)))) return quotaError(res)
    await query(
      `INSERT INTO ${SCHEMA}.decks (user_id, scope, id, data, bytes) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, scope, id) DO UPDATE SET data = EXCLUDED.data, bytes = EXCLUDED.bytes, updated_at = NOW()`,
      [req.user.id, scope, id, text, bytes],
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('Save deck error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.delete('/decks/:scope/:id', verifyToken, async (req, res) => {
  try {
    await query(`DELETE FROM ${SCHEMA}.decks WHERE user_id = $1 AND scope = $2 AND id = $3`, [
      req.user.id,
      req.params.scope,
      req.params.id,
    ])
    res.json({ ok: true })
  } catch (err) {
    console.error('Delete deck error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
