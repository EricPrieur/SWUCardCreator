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
      `SELECT u.id, u.username, u.is_admin, u.quota_bytes, u.can_publish, u.created_at, u.last_login_at,
         COALESCE((SELECT SUM(bytes) FROM ${SCHEMA}.cards c WHERE c.user_id = u.id), 0)
       + COALESCE((SELECT SUM(bytes) FROM ${SCHEMA}.images i WHERE i.user_id = u.id), 0) AS used_bytes,
         (SELECT COUNT(*) FROM ${SCHEMA}.cards c WHERE c.user_id = u.id)::INT AS card_count
       FROM ${SCHEMA}.users u ORDER BY u.created_at DESC`,
    )
    res.json({
      users: rows.map((row) => ({
        ...userPublic(row),
        lastLoginAt: row.last_login_at,
        usedBytes: Number(row.used_bytes),
        cardCount: row.card_count,
        permanent: PERMANENT_ADMINS.has(row.username.toLowerCase()),
      })),
    })
  } catch (err) {
    console.error('Admin users error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Change an account's admin flag, storage limit (quotaBytes null: no limit), or whether
// it may make cards public
router.patch('/users/:id', async (req, res) => {
  const id = Number(req.params.id)
  const { isAdmin, quotaBytes, canPublish } = req.body ?? {}
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad user id' })
  if (isAdmin !== undefined && typeof isAdmin !== 'boolean') return res.status(400).json({ error: 'isAdmin must be true or false' })
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
         can_publish = COALESCE($5, can_publish)
       WHERE id = $1
       RETURNING id, username, is_admin, quota_bytes, can_publish, created_at`,
      [id, isAdmin ?? null, quotaBytes !== undefined, quotaBytes ?? null, canPublish ?? null],
    )
    res.json({ user: userPublic(rows[0]) })
  } catch (err) {
    console.error('Admin update error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
