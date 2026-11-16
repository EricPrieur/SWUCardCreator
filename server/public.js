import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Router } from 'express'
import { query, SCHEMA } from './db.js'
import { optionalUser, verifyToken, requireAdmin } from './auth.js'
import { imageDir } from './cards.js'
import { STEP_CENTS } from './tiers.ts'

const IMAGE_ID = /^[0-9a-f]{64}$/

const router = Router()

// A public card as the Community tab and a public Showroom show it
const publicCard = (row) => ({
  // A card's id is only unique within its account
  key: `${row.user_id}/${row.id}`,
  userId: row.user_id,
  cardId: row.id,
  owner: row.username,
  entry: row.public_entry,
  image: row.public_image,
  backImage: row.public_back_image,
  publishedAt: row.published_at,
  hidden: row.hidden,
  // Its owner may no longer make cards public: off the tab for everyone but admins
  ownerBlocked: !row.can_publish,
  // Its owner's Showroom has a page of its own
  ownerShowroom: !!row.showroom_public,
  // Its owner tipped: a Supporter, marked by their name
  ownerSupporter: !!row.supporter,
})

// Everyone's public cards, newest first, for the Community tab. Admins also get the
// cards they hid, marked so.
router.get('/public/cards', optionalUser, async (req, res) => {
  try {
    let admin = false
    if (req.user) {
      const { rows } = await query(`SELECT is_admin FROM ${SCHEMA}.users WHERE id = $1`, [req.user.id])
      admin = !!rows[0]?.is_admin
    }
    const { rows } = await query(
      `SELECT c.user_id, c.id, u.username, c.public_entry, c.public_image, c.public_back_image, c.published_at, c.hidden,
         u.can_publish, u.showroom_public, (u.donated_cents >= ${STEP_CENTS}) AS supporter
       FROM ${SCHEMA}.cards c JOIN ${SCHEMA}.users u ON u.id = c.user_id
       WHERE c.is_public ${admin ? '' : 'AND NOT c.hidden AND u.can_publish'}
       ORDER BY c.published_at DESC`,
    )
    res.json({ cards: rows.map(publicCard) })
  } catch (err) {
    console.error('Public cards error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// An account's public Showroom: its public cards, in the order it made them, for anyone, while
// it keeps the page public. Its owner sees it too while it isn't, to see what others would.
router.get('/public/showroom/:username', optionalUser, async (req, res) => {
  try {
    const { rows: users } = await query(
      `SELECT id, username, showroom_public, can_publish, donated_cents FROM ${SCHEMA}.users WHERE LOWER(username) = LOWER($1)`,
      [req.params.username],
    )
    const user = users[0]
    const own = !!user && req.user?.id === user.id
    if (!user || (!own && (!user.showroom_public || !user.can_publish)))
      return res.status(404).json({ error: 'This Showroom is not public.' })
    const { rows } = await query(
      `SELECT c.user_id, c.id, u.username, c.public_entry, c.public_image, c.public_back_image, c.published_at, c.hidden,
         u.can_publish, u.showroom_public, (u.donated_cents >= ${STEP_CENTS}) AS supporter
       FROM ${SCHEMA}.cards c JOIN ${SCHEMA}.users u ON u.id = c.user_id
       WHERE c.user_id = $1 AND c.is_public AND NOT c.hidden
       ORDER BY c.created_at`,
      [user.id],
    )
    res.json({ owner: user.username, ownerSupporter: user.donated_cents >= STEP_CENTS, public: user.showroom_public, cards: rows.map(publicCard) })
  } catch (err) {
    console.error('Public showroom error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// The image of a public card's side, for anyone
router.get('/public/images/:id', async (req, res) => {
  const { id } = req.params
  if (!IMAGE_ID.test(id)) return res.status(400).json({ error: 'Bad image id' })
  try {
    const { rows } = await query(
      `SELECT i.content_type FROM ${SCHEMA}.cards c
       JOIN ${SCHEMA}.images i ON i.user_id = c.user_id AND i.id = $1
       JOIN ${SCHEMA}.users u ON u.id = c.user_id
       WHERE NOT c.hidden AND u.can_publish
         AND ((c.is_public AND (c.public_image = $1 OR c.public_back_image = $1))
           -- A supported community card's copy, the card changed since or not
           OR EXISTS (SELECT 1 FROM ${SCHEMA}.community_cards cc
             WHERE cc.user_id = c.user_id AND cc.card_id = c.id AND cc.status = 'supported'
               AND (cc.image = $1 OR cc.back_image = $1 OR cc.prescient_image = $1)))
       LIMIT 1`,
      [id],
    )
    // A Supporter's card back, which their opponents see in the Simulator
    if (!rows.length) {
      const { rows: backs } = await query(
        `SELECT i.content_type FROM ${SCHEMA}.users u JOIN ${SCHEMA}.images i ON i.user_id = u.id AND i.id = u.card_back
         WHERE u.card_back = $1 LIMIT 1`,
        [id],
      )
      rows.push(...backs)
    }
    // A set's card back
    if (!rows.length) {
      const { rows: backs } = await query(
        `SELECT i.content_type FROM ${SCHEMA}.set_backs b JOIN ${SCHEMA}.images i ON i.user_id = b.user_id AND i.id = b.image
         JOIN ${SCHEMA}.users u ON u.id = b.user_id
         WHERE b.image = $1 AND u.can_publish LIMIT 1`,
        [id],
      )
      rows.push(...backs)
    }
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    const bytes = await readFile(join(imageDir(), id))
    res.set('Content-Type', rows[0].content_type)
    // A day: a card made private again stops showing soon after
    res.set('Cache-Control', 'public, max-age=86400')
    res.send(bytes)
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Not found' })
    console.error('Public image error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Admins: the image of any public card's side, hidden or not, to show it greyed out
router.get('/admin/public-images/:id', verifyToken, requireAdmin, async (req, res) => {
  const { id } = req.params
  if (!IMAGE_ID.test(id)) return res.status(400).json({ error: 'Bad image id' })
  try {
    const { rows } = await query(
      `SELECT i.content_type FROM ${SCHEMA}.cards c
       JOIN ${SCHEMA}.images i ON i.user_id = c.user_id AND i.id = $1
       WHERE (c.is_public AND (c.public_image = $1 OR c.public_back_image = $1))
         -- A community card's copy, in the Admin panel's queue
         OR EXISTS (SELECT 1 FROM ${SCHEMA}.community_cards cc
           WHERE cc.user_id = c.user_id AND cc.card_id = c.id AND (cc.image = $1 OR cc.back_image = $1))
       LIMIT 1`,
      [id],
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.set('Content-Type', rows[0].content_type)
    res.set('Cache-Control', 'private, max-age=3600')
    res.send(await readFile(join(imageDir(), id)))
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Not found' })
    console.error('Admin image error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Admins: hide a public card from the Community tab, or show it again
router.patch('/admin/cards/:userId/:cardId', verifyToken, requireAdmin, async (req, res) => {
  const { hidden } = req.body ?? {}
  if (typeof hidden !== 'boolean') return res.status(400).json({ error: 'hidden must be true or false' })
  try {
    const { rows } = await query(
      `UPDATE ${SCHEMA}.cards SET hidden = $3 WHERE user_id = $1 AND id = $2 RETURNING hidden`,
      [Number(req.params.userId), req.params.cardId, hidden],
    )
    if (!rows.length) return res.status(404).json({ error: 'Card not found' })
    res.json({ hidden: rows[0].hidden })
  } catch (err) {
    console.error('Hide card error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
