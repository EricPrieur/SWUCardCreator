import { Router } from 'express'
import { query, SCHEMA } from './db.js'
import { verifyToken, requireAdmin } from './auth.js'
import { cardDef } from './engine/cards.ts'
import { scriptStatus, unplayedLines } from './engine/scripts.ts'

// Community cards: a public card its owner submits to be played. Each submission is a version, a
// copy of the card as it is then, waiting in the Admin panel's queue until an admin supports it
// (its script written in engine/community.ts, or none needed) or declines it. Supported, it is in
// the Community Deck Builder. An edit after that is submitted again as a new version; the
// supported one stays playable until the new one is supported, and is then replaced.
const router = Router()

const CARD_ID = /^[\w-]{1,64}$/
const STATUSES = ['awaiting', 'supported', 'declined']

// The card as the engine knows it, as a community card: its script found among the community ones
const engineCard = (row) => {
  const def = cardDef(row.data)
  return def && { ...def, community: `${row.user_id}/${row.card_id}` }
}

// The account's submissions, card by card: the latest version's state, whether a version of it is
// supported (playable), and whether the card changed since it was last submitted
router.get('/community/mine', verifyToken, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT DISTINCT ON (cc.card_id) cc.card_id, cc.version, cc.status, cc.note, cc.submitted_at,
         c.updated_at > cc.submitted_at AS changed,
         EXISTS (SELECT 1 FROM ${SCHEMA}.community_cards s
           WHERE s.user_id = cc.user_id AND s.card_id = cc.card_id AND s.status = 'supported') AS playable
       FROM ${SCHEMA}.community_cards cc
       JOIN ${SCHEMA}.cards c ON c.user_id = cc.user_id AND c.id = cc.card_id
       WHERE cc.user_id = $1
       ORDER BY cc.card_id, cc.version DESC`,
      [req.user.id],
    )
    res.json({
      cards: Object.fromEntries(
        rows.map((row) => [
          row.card_id,
          { version: row.version, status: row.status, note: row.note, changed: row.changed, playable: row.playable },
        ]),
      ),
    })
  } catch (err) {
    console.error('Community mine error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Submits a public card to be played: a copy of it as it is now, its public images with it. A
// version still waiting is brought up to date rather than a new one made. One the engine plays
// already is supported at once (an admin may still decline it).
router.post('/community/:cardId', verifyToken, async (req, res) => {
  const { cardId } = req.params
  if (!CARD_ID.test(cardId)) return res.status(400).json({ error: 'Bad card id' })
  try {
    const { rows: cards } = await query(
      `SELECT c.data, c.is_public, c.public_entry, c.public_image, c.public_back_image, u.can_publish
       FROM ${SCHEMA}.cards c JOIN ${SCHEMA}.users u ON u.id = c.user_id
       WHERE c.user_id = $1 AND c.id = $2`,
      [req.user.id, cardId],
    )
    const card = cards[0]
    if (!card) return res.status(404).json({ error: 'Card not found' })
    if (!card.can_publish) return res.status(403).json({ error: 'An admin has turned off making cards public for this account.' })
    if (!card.is_public || !card.public_image) return res.status(400).json({ error: 'Make the card public first: its public image is what is played.' })
    const { rows: latest } = await query(
      `SELECT version, status FROM ${SCHEMA}.community_cards WHERE user_id = $1 AND card_id = $2 ORDER BY version DESC LIMIT 1`,
      [req.user.id, cardId],
    )
    // A card the engine plays already (keywords only, no text, or its script written) is
    // supported as it is submitted; the others wait for an admin
    const def = engineCard({ data: card.data, user_id: req.user.id, card_id: cardId })
    const auto = !!def && ['scripted', 'blank'].includes(scriptStatus(def))
    const status = auto ? 'supported' : 'awaiting'
    const values = [req.user.id, cardId, JSON.stringify(card.public_entry), JSON.stringify(card.data), card.public_image, card.public_back_image, status, auto]
    let version
    if (latest[0]?.status === 'awaiting') {
      version = latest[0].version
      await query(
        `UPDATE ${SCHEMA}.community_cards SET entry = $3, data = $4, image = $5, back_image = $6, status = $7, auto = $8,
           submitted_at = NOW(), reviewed_at = CASE WHEN $8 THEN NOW() END
         WHERE user_id = $1 AND card_id = $2 AND version = $9`,
        [...values, version],
      )
    } else {
      version = (latest[0]?.version ?? 0) + 1
      await query(
        `INSERT INTO ${SCHEMA}.community_cards (user_id, card_id, version, entry, data, image, back_image, status, auto, reviewed_at)
         VALUES ($1, $2, $9, $3, $4, $5, $6, $7, $8, CASE WHEN $8 THEN NOW() END)`,
        [...values, version],
      )
    }
    if (auto)
      await query(
        `UPDATE ${SCHEMA}.community_cards SET status = 'replaced'
         WHERE user_id = $1 AND card_id = $2 AND version <> $3 AND status = 'supported'`,
        [req.user.id, cardId, version],
      )
    res.json({ ok: true, status })
  } catch (err) {
    console.error('Community submit error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Withdraws a card from the community: every version, the supported one too (decks lose it)
router.delete('/community/:cardId', verifyToken, async (req, res) => {
  try {
    await query(`DELETE FROM ${SCHEMA}.community_cards WHERE user_id = $1 AND card_id = $2`, [req.user.id, req.params.cardId])
    res.json({ ok: true })
  } catch (err) {
    console.error('Community withdraw error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// The supported community cards, for anyone: what the Community Deck Builder and Simulator play. Not those of
// an account that may no longer publish, nor a card an admin hid.
router.get('/community/cards', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT cc.user_id, cc.card_id, cc.version, cc.entry, cc.data, cc.image, cc.back_image, u.username
       FROM ${SCHEMA}.community_cards cc
       JOIN ${SCHEMA}.cards c ON c.user_id = cc.user_id AND c.id = cc.card_id
       JOIN ${SCHEMA}.users u ON u.id = cc.user_id
       WHERE cc.status = 'supported' AND u.can_publish AND NOT c.hidden
       ORDER BY u.username, cc.reviewed_at`,
    )
    res.json({
      cards: rows.map((row) => ({
        key: `${row.user_id}/${row.card_id}`,
        userId: row.user_id,
        cardId: row.card_id,
        version: row.version,
        owner: row.username,
        entry: row.entry,
        // The card as saved, for the Simulator's engine
        data: row.data,
        image: row.image,
        backImage: row.back_image,
      })),
    })
  } catch (err) {
    console.error('Community cards error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Admins: the queue, waiting versions first, then the others but those replaced, each with what
// the engine makes of it: 'scripted' when it plays the card already (its script written, or
// keywords only), else the lines still to script
router.get('/admin/community', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT cc.user_id, cc.card_id, cc.version, cc.status, cc.entry, cc.data, cc.image, cc.back_image, cc.note, cc.auto,
         cc.submitted_at, cc.reviewed_at, u.username
       FROM ${SCHEMA}.community_cards cc JOIN ${SCHEMA}.users u ON u.id = cc.user_id
       WHERE cc.status <> 'replaced'
       ORDER BY (cc.status = 'awaiting') DESC, cc.submitted_at DESC`,
    )
    res.json({
      cards: rows.map((row) => {
        const def = engineCard(row)
        return {
          key: `${row.user_id}/${row.card_id}`,
          userId: row.user_id,
          cardId: row.card_id,
          version: row.version,
          status: row.status,
          note: row.note,
          auto: row.auto,
          owner: row.username,
          entry: row.entry,
          image: row.image,
          backImage: row.back_image,
          submittedAt: row.submitted_at,
          reviewedAt: row.reviewed_at,
          engine: def ? scriptStatus(def) : 'none',
          unplayed: def ? unplayedLines(def) : [],
          text: def ? [def.text, def.backText].filter(Boolean).join('\n') : '',
        }
      }),
    })
  } catch (err) {
    console.error('Community queue error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Admins: supports a version (the one supported before is replaced by it), declines it with a
// note for its owner, or puts it back in the queue
router.patch('/admin/community/:userId/:cardId/:version', verifyToken, requireAdmin, async (req, res) => {
  const { status, note } = req.body ?? {}
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'status must be awaiting, supported or declined' })
  const key = [Number(req.params.userId), req.params.cardId, Number(req.params.version)]
  try {
    const { rows } = await query(
      `UPDATE ${SCHEMA}.community_cards SET status = $4, note = $5, auto = FALSE, reviewed_at = NOW()
       WHERE user_id = $1 AND card_id = $2 AND version = $3 RETURNING version`,
      [...key, status, typeof note === 'string' && note.trim() ? note.trim().slice(0, 500) : null],
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    if (status === 'supported')
      await query(
        `UPDATE ${SCHEMA}.community_cards SET status = 'replaced'
         WHERE user_id = $1 AND card_id = $2 AND version <> $3 AND status = 'supported'`,
        key,
      )
    res.json({ ok: true })
  } catch (err) {
    console.error('Community review error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
