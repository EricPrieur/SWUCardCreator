import { Router } from 'express'
import { query, SCHEMA } from './db.js'
import { verifyToken } from './auth.js'
import { STEP_CENTS } from './tiers.ts'

// An account's notifications and mail, as on The Chrome Grid: what the site tells it (a card
// submitted for play is supported, or declined with a note) and mail from people. An admin may
// write to anyone; anyone may write to the admins (to: 'Admins', a copy to each), and answer a
// mail they were sent. Each counts as unread until opened,
// and the account's name in the corner shows how many are waiting.
const router = Router()

const KINDS = ['notification', 'mail']
const LIST = 100
const MAX_SUBJECT = 120
const MAX_BODY = 4000
// Mail one account may send in an hour
const SENDS_AN_HOUR = 30
const sends = new Map()

// A notification from the site, to an account: what happened, a few words more, and where to
// see it (a link in the site, #showroom). Never fails what made it.
export async function notify(userId, subject, body = '', link = null) {
  try {
    await query(`INSERT INTO ${SCHEMA}.messages (user_id, kind, subject, body, link) VALUES ($1, 'notification', $2, $3, $4)`, [
      userId,
      String(subject).slice(0, MAX_SUBJECT),
      String(body).slice(0, MAX_BODY),
      link,
    ])
  } catch (err) {
    console.error('Notify error:', err)
  }
}

const row = (r) => ({
  id: r.id,
  kind: r.kind,
  from: r.from_name ?? null,
  fromAdmin: !!r.from_admin,
  fromSupporter: !!r.from_supporter,
  to: r.to_admins ? 'Admins' : (r.to_name ?? null),
  toAdmins: !!r.to_admins,
  subject: r.subject,
  body: r.body,
  link: r.link,
  replyTo: r.reply_to,
  read: !!r.read_at,
  createdAt: r.created_at,
})

// How many are unread, of each kind: what the corner shows, asked again now and then
router.get('/messages/unread', verifyToken, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT kind, COUNT(*)::INT AS n FROM ${SCHEMA}.messages WHERE user_id = $1 AND read_at IS NULL GROUP BY kind`,
      [req.user.id],
    )
    const counts = Object.fromEntries(KINDS.map((kind) => [kind, rows.find((r) => r.kind === kind)?.n ?? 0]))
    res.json({ notification: counts.notification, mail: counts.mail })
  } catch (err) {
    console.error('Unread error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// The latest of a kind, newest first; ?sent=1: the mail this account sent
router.get('/messages', verifyToken, async (req, res) => {
  const kind = KINDS.includes(req.query.kind) ? req.query.kind : 'notification'
  const sent = req.query.sent === '1' && kind === 'mail'
  try {
    const { rows } = await query(
      `SELECT m.*, f.username AS from_name, f.is_admin AS from_admin, (f.donated_cents >= ${STEP_CENTS}) AS from_supporter, t.username AS to_name
       FROM ${SCHEMA}.messages m
       LEFT JOIN ${SCHEMA}.users f ON f.id = m.from_user_id
       LEFT JOIN ${SCHEMA}.users t ON t.id = m.user_id
       WHERE m.kind = $2 AND ${sent ? 'm.from_user_id = $1 AND m.copy_of IS NULL' : 'm.user_id = $1'}
       ORDER BY m.created_at DESC, m.id DESC LIMIT ${LIST}`,
      [req.user.id, kind],
    )
    res.json({ messages: rows.map(row) })
  } catch (err) {
    console.error('Messages error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Opened: read. { all: 'notification' | 'mail' } marks every one of the kind.
router.post('/messages/read', verifyToken, async (req, res) => {
  const { id, all } = req.body ?? {}
  try {
    if (KINDS.includes(all))
      await query(`UPDATE ${SCHEMA}.messages SET read_at = NOW() WHERE user_id = $1 AND kind = $2 AND read_at IS NULL`, [req.user.id, all])
    else if (Number.isInteger(id))
      await query(`UPDATE ${SCHEMA}.messages SET read_at = COALESCE(read_at, NOW()) WHERE user_id = $1 AND id = $2`, [req.user.id, id])
    else return res.status(400).json({ error: 'id or all is needed' })
    res.json({ ok: true })
  } catch (err) {
    console.error('Read error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.delete('/messages/:id', verifyToken, async (req, res) => {
  try {
    await query(`DELETE FROM ${SCHEMA}.messages WHERE user_id = $1 AND id = $2`, [req.user.id, Number(req.params.id)])
    res.json({ ok: true })
  } catch (err) {
    console.error('Delete message error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// A mail: { to: 'Admins', subject, body } from anyone, a copy to each admin; { to: username,
// subject, body } from an admin; or { replyTo: id, body } answering a mail this account was sent
// (to its sender)
router.post('/messages', verifyToken, async (req, res) => {
  const { to, replyTo } = req.body ?? {}
  const body = String(req.body?.body ?? '').trim().slice(0, MAX_BODY)
  if (!body) return res.status(400).json({ error: 'Write something first' })
  const now = Date.now()
  const recent = (sends.get(req.user.id) ?? []).filter((t) => now - t < 3600_000)
  if (recent.length >= SENDS_AN_HOUR) return res.status(429).json({ error: 'Too many mails sent; try again later' })
  try {
    let recipient
    let toAdmins = false
    let subject = String(req.body?.subject ?? '').trim().slice(0, MAX_SUBJECT)
    if (replyTo !== undefined) {
      const { rows } = await query(
        `SELECT from_user_id, subject FROM ${SCHEMA}.messages WHERE id = $1 AND user_id = $2 AND kind = 'mail' AND from_user_id IS NOT NULL`,
        [Number(replyTo), req.user.id],
      )
      if (!rows.length) return res.status(404).json({ error: 'That mail is not yours to answer' })
      recipient = rows[0].from_user_id
      if (!subject) subject = /^re:/i.test(rows[0].subject) ? rows[0].subject : `Re: ${rows[0].subject}`.slice(0, MAX_SUBJECT)
    } else if (String(to ?? '').trim().toLowerCase() === 'admins') {
      toAdmins = true
    } else {
      const { rows: me } = await query(`SELECT is_admin FROM ${SCHEMA}.users WHERE id = $1`, [req.user.id])
      if (!me[0]?.is_admin) return res.status(403).json({ error: 'Write to the Admins, or answer a mail you were sent' })
      const { rows } = await query(`SELECT id FROM ${SCHEMA}.users WHERE LOWER(username) = LOWER($1)`, [String(to ?? '')])
      if (!rows.length) return res.status(404).json({ error: `No account is named ${to}` })
      recipient = rows[0].id
    }
    if (!subject) return res.status(400).json({ error: 'A subject is needed' })
    // The admins: each one's copy, the first the one the Sent box shows (one sent to the admins by
    // an admin still keeps a copy, as the Sent box needs one)
    const recipients = toAdmins
      ? (await query(`SELECT id FROM ${SCHEMA}.users WHERE is_admin ORDER BY (id = $1), id`, [req.user.id])).rows.map((r) => r.id)
      : [recipient]
    if (!recipients.length) return res.status(404).json({ error: 'There is no admin to write to' })
    sends.set(req.user.id, [...recent, now])
    let first = null
    for (const to of recipients) {
      const { rows } = await query(
        `INSERT INTO ${SCHEMA}.messages (user_id, from_user_id, kind, subject, body, reply_to, to_admins, copy_of)
         VALUES ($1, $2, 'mail', $3, $4, $5, $6, $7) RETURNING id`,
        [to, req.user.id, subject, body, replyTo !== undefined ? Number(replyTo) : null, toAdmins, first],
      )
      first ??= rows[0].id
    }
    res.json({ id: first })
  } catch (err) {
    console.error('Send mail error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
