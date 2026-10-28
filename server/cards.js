import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import express, { Router } from 'express'
import { query, SCHEMA, usedBytes } from './db.js'
import { verifyToken } from './auth.js'

// A card's data, without its art, is a few KB; anything this big is art that wasn't uploaded
const MAX_CARD_BYTES = 64 * 1024
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
// An image no card names is removed after this long: long enough for the card that will
// name it to be saved after it is uploaded
const ORPHAN_GRACE = process.env.ORPHAN_GRACE ?? '1 hour'

// Where the image files are kept: a Railway volume in production
export const imageDir = () => process.env.IMAGE_DIR ?? fileURLToPath(new URL('./.localdata/images', import.meta.url))

// The type an image file really is, from its first bytes
function imageType(bytes) {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png'
  if (bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp'
  return null
}

// Card ids are made by the app (UUIDs); an image id is the SHA-256 of its bytes
const CARD_ID = /^[\w-]{1,64}$/
const IMAGE_ID = /^[0-9a-f]{64}$/
// How a card names an uploaded image in its art
export const IMAGE_REF = /account:([0-9a-f]{64})/g

async function quotaOf(userId) {
  const { rows } = await query(`SELECT quota_bytes FROM ${SCHEMA}.users WHERE id = $1`, [userId])
  if (!rows.length) return undefined
  return rows[0].quota_bytes === null ? null : Number(rows[0].quota_bytes)
}

// True when adding `extra` bytes keeps the account within its limit
export async function fits(userId, extra) {
  const quota = await quotaOf(userId)
  if (quota === undefined) return false
  return quota === null || (await usedBytes(userId)) + extra <= quota
}

export const quotaError = (res) =>
  res.status(413).json({ error: 'Your account storage is full. Remove some cards or art to make room.', quota: true })

// Removes the account's images that no card names any more, once they are old enough
async function dropOrphanImages(userId) {
  const { rows } = await query(
    `DELETE FROM ${SCHEMA}.images i
     WHERE i.user_id = $1
       AND i.created_at < NOW() - $2::INTERVAL
       AND NOT EXISTS (
         SELECT 1 FROM ${SCHEMA}.cards c
         WHERE c.user_id = i.user_id
           AND (c.data::TEXT LIKE '%account:' || i.id || '%' OR c.public_image = i.id OR c.public_back_image = i.id)
       )
     RETURNING i.id`,
    [userId, ORPHAN_GRACE],
  )
  // A file stays while another account has the same image
  for (const { id } of rows) {
    const { rows: others } = await query(`SELECT 1 FROM ${SCHEMA}.images WHERE id = $1 LIMIT 1`, [id])
    if (!others.length) await rm(join(imageDir(), id), { force: true })
  }
}

const router = Router()
// Every card of the account
router.get('/cards', verifyToken, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, data, is_public, hidden, updated_at FROM ${SCHEMA}.cards WHERE user_id = $1 ORDER BY created_at`,
      [req.user.id],
    )
    res.json({
      cards: rows.map((row) => ({
        id: row.id,
        data: row.data,
        isPublic: row.is_public,
        hidden: row.hidden,
        updatedAt: row.updated_at,
      })),
      usedBytes: await usedBytes(req.user.id),
    })
  } catch (err) {
    console.error('Cards error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Adds a card, or replaces it: { data }, the card as the app keeps it, art as account: images
router.put('/cards/:id', verifyToken, async (req, res) => {
  const { id } = req.params
  const data = req.body?.data
  if (!CARD_ID.test(id)) return res.status(400).json({ error: 'Bad card id' })
  if (!data || typeof data !== 'object' || Array.isArray(data)) return res.status(400).json({ error: 'Card data required' })
  const text = JSON.stringify({ ...data, id })
  const bytes = Buffer.byteLength(text)
  if (bytes > MAX_CARD_BYTES) return res.status(413).json({ error: 'This card is too big. Is its art uploaded?' })

  try {
    // Its images must be ones this account uploaded
    const named = [...new Set([...text.matchAll(IMAGE_REF)].map((match) => match[1]))]
    if (named.length) {
      const { rows } = await query(`SELECT id FROM ${SCHEMA}.images WHERE user_id = $1 AND id = ANY($2)`, [req.user.id, named])
      if (rows.length !== named.length) return res.status(400).json({ error: 'The card names art that was not uploaded' })
    }
    const { rows: old } = await query(`SELECT bytes FROM ${SCHEMA}.cards WHERE user_id = $1 AND id = $2`, [req.user.id, id])
    if (!(await fits(req.user.id, bytes - (old[0]?.bytes ?? 0)))) return quotaError(res)
    const { rows } = await query(
      `INSERT INTO ${SCHEMA}.cards (user_id, id, data, bytes) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, id) DO UPDATE SET data = EXCLUDED.data, bytes = EXCLUDED.bytes, updated_at = NOW()
       RETURNING updated_at`,
      [req.user.id, id, text, bytes],
    )
    await dropOrphanImages(req.user.id)
    res.json({ id, updatedAt: rows[0].updated_at, usedBytes: await usedBytes(req.user.id) })
  } catch (err) {
    console.error('Card save error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.delete('/cards/:id', verifyToken, async (req, res) => {
  try {
    await query(`DELETE FROM ${SCHEMA}.cards WHERE user_id = $1 AND id = $2`, [req.user.id, req.params.id])
    await dropOrphanImages(req.user.id)
    res.json({ usedBytes: await usedBytes(req.user.id) })
  } catch (err) {
    console.error('Card delete error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// The fields of a showcase entry the Community tab reads, so one card can't break the tab
const isEntry = (entry) =>
  !!entry &&
  typeof entry === 'object' &&
  !Array.isArray(entry) &&
  typeof entry.name === 'string' &&
  typeof entry.type === 'string' &&
  Array.isArray(entry.traits) &&
  entry.traits.every((trait) => typeof trait === 'string') &&
  Array.isArray(entry.aspects) &&
  (entry.backName == null || typeof entry.backName === 'string') &&
  (entry.backAspects == null || Array.isArray(entry.backAspects)) &&
  (entry.text == null || typeof entry.text === 'string')

// Makes a card public, or updates what is shown of it: { entry, image, backImage? },
// its showcase entry and the JPG of each side, uploaded first as images
router.put('/cards/:id/public', verifyToken, async (req, res) => {
  const { entry, image, backImage } = req.body ?? {}
  if (!isEntry(entry)) return res.status(400).json({ error: 'Entry required' })
  if (Buffer.byteLength(JSON.stringify(entry)) > MAX_CARD_BYTES) return res.status(413).json({ error: 'Entry too big' })
  if (!IMAGE_ID.test(image ?? '') || (backImage != null && !IMAGE_ID.test(backImage)))
    return res.status(400).json({ error: 'The card’s image is required' })

  try {
    const { rows: user } = await query(`SELECT can_publish FROM ${SCHEMA}.users WHERE id = $1`, [req.user.id])
    if (!user[0]?.can_publish)
      return res.status(403).json({ error: 'An admin has turned off making cards public for this account.' })
    const images = [image, backImage].filter(Boolean)
    const { rows: owned } = await query(`SELECT id FROM ${SCHEMA}.images WHERE user_id = $1 AND id = ANY($2)`, [req.user.id, images])
    if (owned.length !== new Set(images).size) return res.status(400).json({ error: 'The card’s image was not uploaded' })
    const { rows } = await query(
      `UPDATE ${SCHEMA}.cards SET is_public = TRUE, public_entry = $3, public_image = $4, public_back_image = $5,
         published_at = COALESCE(published_at, NOW())
       WHERE user_id = $1 AND id = $2
       RETURNING hidden`,
      [req.user.id, req.params.id, JSON.stringify(entry), image, backImage ?? null],
    )
    if (!rows.length) return res.status(404).json({ error: 'Card not found' })
    await dropOrphanImages(req.user.id)
    res.json({ isPublic: true, hidden: rows[0].hidden, usedBytes: await usedBytes(req.user.id) })
  } catch (err) {
    console.error('Publish error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Makes a card private again; its JPGs go with the next clean-up
router.delete('/cards/:id/public', verifyToken, async (req, res) => {
  try {
    await query(
      `UPDATE ${SCHEMA}.cards SET is_public = FALSE, public_entry = NULL, public_image = NULL, public_back_image = NULL,
         published_at = NULL
       WHERE user_id = $1 AND id = $2`,
      [req.user.id, req.params.id],
    )
    await dropOrphanImages(req.user.id)
    res.json({ isPublic: false, usedBytes: await usedBytes(req.user.id) })
  } catch (err) {
    console.error('Unpublish error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Uploads an image: the file itself as the body. The same image twice is kept once.
router.post('/images', verifyToken, express.raw({ type: () => true, limit: MAX_IMAGE_BYTES }), async (req, res) => {
  const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
  const type = imageType(bytes)
  if (!type) return res.status(400).json({ error: 'Art must be a JPEG, PNG or WebP image' })
  const id = createHash('sha256').update(bytes).digest('hex')

  try {
    const { rows: had } = await query(`SELECT 1 FROM ${SCHEMA}.images WHERE user_id = $1 AND id = $2`, [req.user.id, id])
    if (!had.length) {
      if (!(await fits(req.user.id, bytes.length))) return quotaError(res)
      await mkdir(imageDir(), { recursive: true })
      await writeFile(join(imageDir(), id), bytes)
      await query(
        `INSERT INTO ${SCHEMA}.images (user_id, id, content_type, bytes) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, id) DO NOTHING`,
        [req.user.id, id, type, bytes.length],
      )
    } else {
      // Uploaded again: it counts as new, so it isn't removed before its card is saved
      await query(`UPDATE ${SCHEMA}.images SET created_at = NOW() WHERE user_id = $1 AND id = $2`, [req.user.id, id])
    }
    res.status(had.length ? 200 : 201).json({ id, usedBytes: await usedBytes(req.user.id) })
  } catch (err) {
    console.error('Image upload error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// One of the account's images. They never change, so the browser may keep them.
router.get('/images/:id', verifyToken, async (req, res) => {
  const { id } = req.params
  if (!IMAGE_ID.test(id)) return res.status(400).json({ error: 'Bad image id' })
  try {
    const { rows } = await query(`SELECT content_type FROM ${SCHEMA}.images WHERE user_id = $1 AND id = $2`, [req.user.id, id])
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    const bytes = await readFile(join(imageDir(), id))
    res.set('Content-Type', rows[0].content_type)
    res.set('Cache-Control', 'private, max-age=31536000, immutable')
    res.send(bytes)
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Not found' })
    console.error('Image error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
