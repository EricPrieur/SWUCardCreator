import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import { Router } from 'express'
import { query, SCHEMA } from './db.js'

const SALT_ROUNDS = 10
// Accounts that are always admins, with no storage limit, whatever the table says
export const PERMANENT_ADMINS = new Set(['prieur'])

function secret() {
  const value = process.env.JWT_SECRET
  if (value) return value
  if (process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET is not set')
  return 'swu-card-creator-dev-secret'
}

const USER_COLUMNS = 'id, username, is_admin, quota_bytes, created_at'

// What the app is told about an account
export function userPublic(user) {
  return {
    id: user.id,
    username: user.username,
    isAdmin: !!user.is_admin,
    // null: no limit
    quotaBytes: user.quota_bytes === null ? null : Number(user.quota_bytes),
    createdAt: user.created_at,
  }
}

const signToken = (user) =>
  jwt.sign({ id: user.id, username: user.username, isAdmin: !!user.is_admin }, secret(), { expiresIn: '30d' })

// A permanent admin gets the flag and loses the limit the moment it signs in
async function withPermanentRights(user) {
  if (!PERMANENT_ADMINS.has(user.username.toLowerCase())) return user
  if (user.is_admin && user.quota_bytes === null) return user
  const { rows } = await query(
    `UPDATE ${SCHEMA}.users SET is_admin = TRUE, quota_bytes = NULL WHERE id = $1 RETURNING ${USER_COLUMNS}`,
    [user.id],
  )
  return rows[0]
}

export async function enforcePermanentAdmins() {
  const names = [...PERMANENT_ADMINS]
  await query(
    `UPDATE ${SCHEMA}.users SET is_admin = TRUE, quota_bytes = NULL
     WHERE LOWER(username) = ANY($1) AND (is_admin = FALSE OR quota_bytes IS NOT NULL)`,
    [names],
  )
}

const router = Router()

router.post('/register', async (req, res) => {
  const { username, password } = req.body ?? {}
  if (typeof username !== 'string' || typeof password !== 'string')
    return res.status(400).json({ error: 'Username and password required' })
  if (username.length < 3 || username.length > 20)
    return res.status(400).json({ error: 'Username must be 3-20 characters' })
  if (!/^[a-zA-Z0-9_-]+$/.test(username))
    return res.status(400).json({ error: 'Username can only contain letters, numbers, hyphens and underscores' })
  if (password.length < 8 || password.length > 200)
    return res.status(400).json({ error: 'Password must be at least 8 characters' })

  try {
    const taken = await query(`SELECT 1 FROM ${SCHEMA}.users WHERE LOWER(username) = LOWER($1)`, [username])
    if (taken.rows.length) return res.status(409).json({ error: 'Username already taken' })
    const hash = await bcrypt.hash(password, SALT_ROUNDS)
    const { rows } = await query(
      `INSERT INTO ${SCHEMA}.users (username, password_hash, last_login_at) VALUES ($1, $2, NOW()) RETURNING ${USER_COLUMNS}`,
      [username, hash],
    )
    const user = await withPermanentRights(rows[0])
    res.status(201).json({ token: signToken(user), user: userPublic(user) })
  } catch (err) {
    // Two people taking the same name at once: the index refuses the second
    if (err.code === '23505') return res.status(409).json({ error: 'Username already taken' })
    console.error('Register error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/login', async (req, res) => {
  const { username, password } = req.body ?? {}
  if (typeof username !== 'string' || typeof password !== 'string')
    return res.status(400).json({ error: 'Username and password required' })

  try {
    const { rows } = await query(
      `SELECT ${USER_COLUMNS}, password_hash FROM ${SCHEMA}.users WHERE LOWER(username) = LOWER($1)`,
      [username],
    )
    const found = rows[0]
    if (!found?.password_hash || !(await bcrypt.compare(password, found.password_hash)))
      return res.status(401).json({ error: 'Invalid username or password' })
    await query(`UPDATE ${SCHEMA}.users SET last_login_at = NOW() WHERE id = $1`, [found.id])
    const user = await withPermanentRights(found)
    res.json({ token: signToken(user), user: userPublic(user) })
  } catch (err) {
    console.error('Login error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// Checks the token and puts its account on req.user
export function verifyToken(req, res, next) {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' })
  try {
    req.user = jwt.verify(auth.slice(7), secret())
    next()
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
}

// Admin rights are read from the table, not the token, so taking them away works at once
export async function requireAdmin(req, res, next) {
  try {
    const { rows } = await query(`SELECT is_admin FROM ${SCHEMA}.users WHERE id = $1`, [req.user.id])
    if (!rows[0]?.is_admin) return res.status(403).json({ error: 'Admin access required' })
    next()
  } catch (err) {
    console.error('Admin check error:', err)
    res.status(500).json({ error: 'Server error' })
  }
}

// The account signed in, as it is now, with the storage it uses
router.get('/me', verifyToken, async (req, res) => {
  try {
    const { rows } = await query(`SELECT ${USER_COLUMNS} FROM ${SCHEMA}.users WHERE id = $1`, [req.user.id])
    if (!rows.length) return res.status(404).json({ error: 'User not found' })
    // Cards and images come in step 2; nothing is stored yet
    res.json({ user: userPublic(rows[0]), usedBytes: 0 })
  } catch (err) {
    console.error('Me error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
