import { Router } from 'express'
import { query, SCHEMA } from './db.js'
import { verifyToken, requireAdmin } from './auth.js'
import { notify } from './messages.js'
import { cardDef } from './engine/cards.ts'
import { scriptStatus, unplayedLines } from './engine/scripts.ts'
import { playCardsFor, STEP_CENTS } from './tiers.ts'
import { deckBack, setCode } from './cardBacks.ts'

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

// The supported community cards as the engine plays them, for the server's games (online rooms):
// each its own card, community:<account>/<card>, a two-sided base's back too. Read again after a
// little while, so a card supported is soon played.
const DEFS_KEPT = 60 * 1000
let keptDefs = null
export async function communityDefs() {
  if (keptDefs && Date.now() - keptDefs.at < DEFS_KEPT) return keptDefs.defs
  const { rows } = await query(
    `SELECT cc.user_id, cc.card_id, cc.data
     FROM ${SCHEMA}.community_cards cc
     JOIN ${SCHEMA}.cards c ON c.user_id = cc.user_id AND c.id = cc.card_id
     JOIN ${SCHEMA}.users u ON u.id = cc.user_id
     WHERE cc.status = 'supported' AND u.can_publish AND NOT c.hidden`,
  )
  const defs = []
  for (const row of rows) {
    const key = `${row.user_id}/${row.card_id}`
    const id = `community:${key}`
    const def = cardDef({ ...row.data, id })
    if (!def) continue
    defs.push({ ...def, community: key })
    const back = def.type === 'base' && row.data.backFrameId && cardDef({ ...row.data, id: `${id}#back`, frameId: row.data.backFrameId })
    if (back) defs.push({ ...back, community: key })
  }
  keptDefs = { defs, at: Date.now() }
  return defs
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
// already is supported at once (an admin may still decline it). { prescientImage }: its Prescient
// version, drawn by the browser and uploaded first, for the Deck Builder and the Simulator.
router.post('/community/:cardId', verifyToken, async (req, res) => {
  const { cardId } = req.params
  if (!CARD_ID.test(cardId)) return res.status(400).json({ error: 'Bad card id' })
  try {
    const { rows: cards } = await query(
      `SELECT c.data, c.is_public, c.public_entry, c.public_image, c.public_back_image, u.can_publish, u.is_admin, u.donated_cents
       FROM ${SCHEMA}.cards c JOIN ${SCHEMA}.users u ON u.id = c.user_id
       WHERE c.user_id = $1 AND c.id = $2`,
      [req.user.id, cardId],
    )
    const card = cards[0]
    if (!card) return res.status(404).json({ error: 'Card not found' })
    if (!card.can_publish) return res.status(403).json({ error: 'An admin has turned off making cards public for this account.' })
    if (!card.is_public || !card.public_image) return res.status(400).json({ error: 'Make the card public first: its public image is what is played.' })
    // So many cards in play, supported or waiting; a card already in play is brought up to date all the same
    const limit = playCardsFor({ isAdmin: card.is_admin, donatedCents: card.donated_cents ?? 0 })
    if (limit !== null) {
      const { rows: inPlay } = await query(
        `SELECT COUNT(DISTINCT card_id)::int AS n FROM ${SCHEMA}.community_cards
         WHERE user_id = $1 AND card_id <> $2 AND status IN ('awaiting', 'supported')`,
        [req.user.id, cardId],
      )
      const { rows: already } = await query(
        `SELECT 1 FROM ${SCHEMA}.community_cards WHERE user_id = $1 AND card_id = $2 AND status IN ('awaiting', 'supported') LIMIT 1`,
        [req.user.id, cardId],
      )
      if (!already.length && inPlay[0].n >= limit)
        return res.status(403).json({
          error: `You have ${inPlay[0].n} cards submitted for play, as many as your account may (${limit}). Each $5 tip adds 50 more; or withdraw one first.`,
        })
    }
    let prescient = req.body?.prescientImage ?? null
    if (prescient !== null) {
      if (!/^[0-9a-f]{64}$/.test(String(prescient))) return res.status(400).json({ error: 'Bad Prescient image' })
      const { rows: own } = await query(`SELECT 1 FROM ${SCHEMA}.images WHERE user_id = $1 AND id = $2`, [req.user.id, prescient])
      if (!own.length) prescient = null
    }
    const { rows: latest } = await query(
      `SELECT version, status FROM ${SCHEMA}.community_cards WHERE user_id = $1 AND card_id = $2 ORDER BY version DESC LIMIT 1`,
      [req.user.id, cardId],
    )
    // A card the engine plays already (keywords only, no text, or its script written) is
    // supported as it is submitted; the others wait for an admin
    const def = engineCard({ data: card.data, user_id: req.user.id, card_id: cardId })
    const auto = !!def && ['scripted', 'blank'].includes(scriptStatus(def))
    const status = auto ? 'supported' : 'awaiting'
    const values = [req.user.id, cardId, JSON.stringify(card.public_entry), JSON.stringify(card.data), card.public_image, card.public_back_image, status, auto, prescient]
    let version
    if (latest[0]?.status === 'awaiting') {
      version = latest[0].version
      await query(
        `UPDATE ${SCHEMA}.community_cards SET entry = $3, data = $4, image = $5, back_image = $6, status = $7, auto = $8,
           prescient_image = $9, submitted_at = NOW(), reviewed_at = CASE WHEN $8 THEN NOW() END
         WHERE user_id = $1 AND card_id = $2 AND version = $10`,
        [...values, version],
      )
    } else {
      version = (latest[0]?.version ?? 0) + 1
      await query(
        `INSERT INTO ${SCHEMA}.community_cards (user_id, card_id, version, entry, data, image, back_image, status, auto, prescient_image, reviewed_at)
         VALUES ($1, $2, $10, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $8 THEN NOW() END)`,
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
      `SELECT cc.user_id, cc.card_id, cc.version, cc.entry, cc.data, cc.image, cc.back_image, cc.prescient_image, u.username, (u.donated_cents >= ${STEP_CENTS}) AS supporter
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
        ownerSupporter: !!row.supporter,
        entry: row.entry,
        // The card as saved, for the Simulator's engine
        data: row.data,
        image: row.image,
        backImage: row.back_image,
        // Its Prescient (full art) version; null for one submitted before there was one
        prescientImage: row.prescient_image ?? null,
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
    // Each maker's cards in play: supported, and waiting, against their limit
    const { rows: counts } = await query(
      `SELECT u.id, u.username, u.is_admin, u.donated_cents,
         COUNT(DISTINCT cc.card_id) FILTER (WHERE cc.status = 'supported')::int AS supported,
         COUNT(DISTINCT cc.card_id) FILTER (WHERE cc.status IN ('awaiting', 'supported'))::int AS in_play
       FROM ${SCHEMA}.community_cards cc JOIN ${SCHEMA}.users u ON u.id = cc.user_id
       GROUP BY u.id
       ORDER BY supported DESC, u.username`,
    )
    res.json({
      makers: counts.map((row) => ({
        userId: row.id,
        owner: row.username,
        supported: row.supported,
        inPlay: row.in_play,
        limit: playCardsFor({ isAdmin: row.is_admin, donatedCents: row.donated_cents ?? 0 }),
      })),
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
          // The card's text as saved, the engine's card or not (one on a frame it doesn't know)
          text: [row.data?.text, row.data?.pilotText, row.data?.backText].filter(Boolean).join('\n'),
          // What a script needs besides the text; each text apart, as a script quotes it
          card: {
            frameId: row.data?.frameId,
            text: row.data?.text ?? '',
            pilotText: row.data?.pilotText ?? '',
            backText: row.data?.backText ?? '',
            cost: row.data?.cost,
            power: row.data?.power,
            hp: row.data?.hp,
            trait: row.data?.trait,
            unique: !!row.data?.unique,
            upgradePower: row.data?.upgradePower,
            upgradeHp: row.data?.upgradeHp,
          },
        }
      }),
    })
  } catch (err) {
    console.error('Community queue error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Admins: what waits for them, the count on the Admin button. Community cards waiting, and those
// supported automatically not yet confirmed; mail written to the Admins they have not opened.
router.get('/admin/pending', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT
         (SELECT COUNT(*)::INT FROM ${SCHEMA}.community_cards WHERE status = 'awaiting' OR (status = 'supported' AND auto)) AS community,
         (SELECT COUNT(*)::INT FROM ${SCHEMA}.messages WHERE user_id = $1 AND to_admins AND read_at IS NULL) AS mail`,
      [req.user.id],
    )
    res.json(rows[0])
  } catch (err) {
    console.error('Admin pending error:', err)
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
       WHERE user_id = $1 AND card_id = $2 AND version = $3 RETURNING version, entry, (SELECT status FROM ${SCHEMA}.community_cards p
         WHERE p.user_id = $1 AND p.card_id = $2 AND p.version = $3) AS before`,
      [...key, status, typeof note === 'string' && note.trim() ? note.trim().slice(0, 500) : null],
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    // Its owner told, when it changes: playable, or declined (with the note)
    const { entry, before } = rows[0]
    const name = [entry?.name, entry?.subtitle].filter(Boolean).join(', ') || 'Your card'
    const said = typeof note === 'string' ? note.trim() : ''
    if (status !== before && status === 'supported')
      await notify(key[0], `${name} is now playable`, 'It is in the Community Deck Builder and Simulator, for anyone to play.', '#showroom')
    else if (status !== before && status === 'declined')
      await notify(key[0], `${name} was declined`, said ? `The admin's note: ${said}` : 'Change it, then submit it again.', '#showroom')
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

// The Community Simulator's Featured Decks, for anyone: those of the accounts that may still publish
router.get('/community/featured', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT f.user_id, f.id, f.deck, u.username
       FROM ${SCHEMA}.featured_decks f JOIN ${SCHEMA}.users u ON u.id = f.user_id
       WHERE u.can_publish
       ORDER BY u.username, f.updated_at`,
    )
    res.json({ decks: rows.map((row) => ({ ...row.deck, id: row.id, userId: row.user_id, owner: row.username })) })
  } catch (err) {
    console.error('Featured decks error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Featuring a deck: its maker's cards are in it, and the other cards are DUNE's (or, for an admin,
// anyone's). Any number of cards: a short deck is still worth trying.
const DECK_ID = /^[\w-]{1,64}$/
const CARD_REF = /^(community:(\d+)\/[\w-]{1,64}|[\w-]{1,80})(#back)?$/
router.put('/community/featured/:id', verifyToken, async (req, res) => {
  const { id } = req.params
  const body = req.body ?? {}
  if (!DECK_ID.test(id)) return res.status(400).json({ error: 'Bad deck id' })
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : ''
  const cards = Array.isArray(body.cards) ? body.cards : []
  const refs = [body.leader, body.base, ...cards.map((c) => c?.id)]
  if (!name || !body.leader || !body.base) return res.status(400).json({ error: 'A Featured Deck needs a name, a leader and a base' })
  if (cards.length > 200 || refs.some((ref) => typeof ref !== 'string' || !CARD_REF.test(ref)))
    return res.status(400).json({ error: 'Bad cards' })
  if (cards.some((c) => !Number.isInteger(c.count) || c.count < 1 || c.count > 50)) return res.status(400).json({ error: 'Bad card counts' })
  const owners = refs.map((ref) => ref.match(CARD_REF)[2]).filter(Boolean).map(Number)
  if (!req.user.isAdmin) {
    if (!owners.includes(req.user.id)) return res.status(403).json({ error: 'Only a deck with your own community cards can be featured' })
    if (owners.some((owner) => owner !== req.user.id))
      return res.status(403).json({ error: "A Featured Deck may have your cards and DUNE's, not other makers' cards" })
  }
  const deck = { name, leader: body.leader, base: body.base, cards: cards.map(({ id, count }) => ({ id, count })) }
  try {
    const { rows } = await query(`SELECT can_publish FROM ${SCHEMA}.users WHERE id = $1`, [req.user.id])
    if (!rows[0]?.can_publish) return res.status(403).json({ error: 'An admin has turned off making cards public for this account.' })
    await query(
      `INSERT INTO ${SCHEMA}.featured_decks (user_id, id, deck) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, id) DO UPDATE SET deck = EXCLUDED.deck, updated_at = NOW()`,
      [req.user.id, id, deck],
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('Feature deck error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.delete('/community/featured/:id', verifyToken, async (req, res) => {
  if (!DECK_ID.test(req.params.id)) return res.status(400).json({ error: 'Bad deck id' })
  try {
    await query(`DELETE FROM ${SCHEMA}.featured_decks WHERE user_id = $1 AND id = $2`, [req.user.id, req.params.id])
    res.json({ ok: true })
  } catch (err) {
    console.error('Unfeature deck error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// The sets' card backs, for anyone: what the Community Simulator shows on a deck mostly of a set
router.get('/community/set-backs', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT b.user_id, b.set_code, b.image, u.username
       FROM ${SCHEMA}.set_backs b JOIN ${SCHEMA}.users u ON u.id = b.user_id
       WHERE u.can_publish
       ORDER BY u.username, b.set_code`,
    )
    res.json({ backs: rows.map((row) => ({ userId: row.user_id, owner: row.username, set: row.set_code, image: row.image })) })
  } catch (err) {
    console.error('Set backs error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// A set's card back, set by its maker: { image } one of their images, or null for DUNE's
router.put('/community/set-backs/:code', verifyToken, async (req, res) => {
  const code = setCode(req.params.code)
  if (!code) return res.status(400).json({ error: 'Bad set code' })
  const image = req.body?.image ?? null
  try {
    if (image === null) {
      await query(`DELETE FROM ${SCHEMA}.set_backs WHERE user_id = $1 AND set_code = $2`, [req.user.id, code])
    } else {
      if (!/^[0-9a-f]{64}$/.test(String(image))) return res.status(400).json({ error: 'Bad image' })
      const { rows: own } = await query(`SELECT 1 FROM ${SCHEMA}.images WHERE user_id = $1 AND id = $2`, [req.user.id, image])
      if (!own.length) return res.status(404).json({ error: 'Image not found' })
      await query(
        `INSERT INTO ${SCHEMA}.set_backs (user_id, set_code, image) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, set_code) DO UPDATE SET image = EXCLUDED.image`,
        [req.user.id, code, image],
      )
    }
    keptBacks = null
    res.json({ ok: true })
  } catch (err) {
    console.error('Set back error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// A deck's card back in the server's games: its set's, the set most of its cards are of (see
// cardBacks.ts); null for DUNE's. Each community card's set and the sets' backs read again after
// a little while.
let keptBacks = null
async function backsByCard() {
  if (keptBacks && Date.now() - keptBacks.at < DEFS_KEPT) return keptBacks.byCard
  const { rows } = await query(
    `SELECT cc.user_id, cc.card_id, b.image
     FROM ${SCHEMA}.community_cards cc
     JOIN ${SCHEMA}.set_backs b ON b.user_id = cc.user_id AND b.set_code = UPPER(TRIM(cc.entry->>'set'))
     WHERE cc.status = 'supported'`,
  )
  const byCard = new Map(rows.map((row) => [`community:${row.user_id}/${row.card_id}`, row.image]))
  keptBacks = { byCard, at: Date.now() }
  return byCard
}
export async function deckSetBack(deck) {
  try {
    const byCard = await backsByCard()
    if (!byCard.size) return null
    return deckBack([deck.leader, deck.base, ...deck.deck], (id) => byCard.get(id.replace(/#back$/, '')))
  } catch {
    return null
  }
}

export default router
