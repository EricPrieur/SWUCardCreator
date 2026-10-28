import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import { Router } from 'express'
import { query, SCHEMA, usedBytes } from './db.js'

const SALT_ROUNDS = 10
// Accounts that are always admins, with no storage limit, whatever the table says
export const PERMANENT_ADMINS = new Set(['prieur'])

function secret() {
  const value = process.env.JWT_SECRET
  if (value) return value
  if (process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET is not set')
  return 'swu-card-creator-dev-secret'
}

const USER_COLUMNS =
  'id, username, is_admin, quota_bytes, can_publish, created_at, discord_username, (password_hash IS NOT NULL) AS has_password'

// The sites allowed to call this server: the app on GitHub Pages and the dev server
const DEFAULT_ORIGINS = ['https://ericprieur.github.io', 'http://localhost:5173']

export const allowedOrigins = () =>
  new Set(
    (process.env.ALLOWED_ORIGINS ?? DEFAULT_ORIGINS.join(','))
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  )

// What the app is told about an account
export function userPublic(user) {
  return {
    id: user.id,
    username: user.username,
    isAdmin: !!user.is_admin,
    // null: no limit
    quotaBytes: user.quota_bytes === null ? null : Number(user.quota_bytes),
    // May make cards public
    canPublish: user.can_publish !== false,
    // The Discord account it signs in with; null when none is linked
    discordName: user.discord_username ?? null,
    // A Discord account can only be unlinked from one that also has a password
    hasPassword: !!user.has_password,
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

// ── Discord ──
// The app opens a window on the URL /discord/url gives; Discord sends it back to
// /discord/callback, which signs in (making the account the first time) or links the
// Discord account to the one signed in, then hands the token to the app's window.
const DISCORD_AUTHORIZE = 'https://discord.com/oauth2/authorize'
const DISCORD_TOKEN = 'https://discord.com/api/oauth2/token'
const DISCORD_ME = 'https://discord.com/api/users/@me'

function discordConfig() {
  const clientId = process.env.DISCORD_CLIENT_ID
  const clientSecret = process.env.DISCORD_CLIENT_SECRET
  const redirectUri = process.env.DISCORD_REDIRECT_URI
  return { clientId, clientSecret, redirectUri, enabled: !!(clientId && clientSecret && redirectUri) }
}

// Whether to show the Discord buttons
router.get('/discord/status', (req, res) => res.json({ enabled: discordConfig().enabled }))

// Where to send the window: Discord's page, with a signed state saying what to do after,
// and which page of the app to answer
router.post('/discord/url', optionalUser, (req, res) => {
  const config = discordConfig()
  if (!config.enabled) return res.status(501).json({ error: 'Discord login is not set up' })
  const origin = req.headers.origin
  if (!origin || !allowedOrigins().has(origin)) return res.status(403).json({ error: 'Unknown site' })
  const { link, returnTo } = req.body ?? {}
  if (link && !req.user) return res.status(401).json({ error: 'Log in first to link Discord' })
  // The app page to come back to if the window lost track of the app
  const back = typeof returnTo === 'string' && returnTo.startsWith(origin + '/') ? returnTo : origin + '/'
  const state = jwt.sign({ origin, returnTo: back, linkUserId: link ? req.user.id : null }, secret(), {
    expiresIn: '10m',
  })
  const url = new URL(DISCORD_AUTHORIZE)
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', config.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'identify')
  url.searchParams.set('state', state)
  res.json({ url: url.toString() })
})

const escapeHtml = (text) => text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`)

// The page the window ends on: it hands the result to the app's window and closes;
// opened on its own, it goes back to the app with the token after the #
function discordDone(res, state, { token = null, linked = false, error = null }) {
  const message = { type: 'swu-discord', token, linked, error }
  const json = (value) => JSON.stringify(value).replace(/</g, '\\u003c')
  const back = state ? `${state.returnTo.split('#')[0]}#${token ? `discord=${token}` : 'discord-error=1'}` : null
  res
    .status(200)
    .type('html')
    .send(`<!doctype html><html><head><meta charset="utf-8"><title>Discord</title>
<style>
  body { margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #1a120b; color: #f0dcc0; font-family: system-ui, sans-serif; }
  p { max-width: 28rem; text-align: center; line-height: 1.5; }
</style></head><body>
<p>${error ? escapeHtml(error) : 'Signed in with Discord. You can close this window.'}</p>
<script>
  var message = ${json(message)}, origin = ${json(state?.origin ?? null)}, back = ${json(back)}
  if (origin && window.opener && !window.opener.closed) {
    window.opener.postMessage(message, origin)
    window.close()
  } else if (back && message.token) {
    window.location.replace(back)
  }
</script></body></html>`)
}

// A name for a new account from the Discord one, in the app's rules, free, and never
// one of the permanent admins
async function freeUsername(discordName) {
  let base = discordName.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 17)
  if (base.length < 3) base = `${base}user`.slice(0, 17)
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? base : `${base}-${n}`
    if (PERMANENT_ADMINS.has(name.toLowerCase())) continue
    const { rows } = await query(`SELECT 1 FROM ${SCHEMA}.users WHERE LOWER(username) = LOWER($1)`, [name])
    if (!rows.length) return name
  }
  throw new Error('No free username')
}

router.get('/discord/callback', async (req, res) => {
  const config = discordConfig()
  let state = null
  try {
    state = jwt.verify(String(req.query.state ?? ''), secret())
  } catch {
    return discordDone(res, null, { error: 'That sign-in took too long or came from elsewhere. Try again.' })
  }
  if (!config.enabled) return discordDone(res, state, { error: 'Discord login is not set up' })
  // Cancelled on Discord's page
  if (!req.query.code) return discordDone(res, state, { error: 'Discord sign-in was cancelled.' })

  try {
    const tokenRes = await fetch(DISCORD_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'authorization_code',
        code: String(req.query.code),
        redirect_uri: config.redirectUri,
      }),
    })
    if (!tokenRes.ok) {
      console.error('Discord token error:', tokenRes.status, await tokenRes.text().catch(() => ''))
      return discordDone(res, state, { error: 'Discord refused the sign-in. Try again.' })
    }
    const { access_token } = await tokenRes.json()
    const meRes = await fetch(DISCORD_ME, { headers: { Authorization: `Bearer ${access_token}` } })
    if (!meRes.ok) return discordDone(res, state, { error: 'Discord didn’t say who you are. Try again.' })
    const discord = await meRes.json()
    const discordId = String(discord.id)
    const discordName = discord.global_name || discord.username || 'discord'

    const { rows: linked } = await query(`SELECT id, username FROM ${SCHEMA}.users WHERE discord_id = $1`, [discordId])

    if (state.linkUserId) {
      if (linked.length && linked[0].id !== state.linkUserId)
        return discordDone(res, state, { error: `That Discord account is already linked to ${linked[0].username}.` })
      const { rows } = await query(
        `UPDATE ${SCHEMA}.users SET discord_id = $1, discord_username = $2 WHERE id = $3 RETURNING ${USER_COLUMNS}`,
        [discordId, discordName, state.linkUserId],
      )
      if (!rows.length) return discordDone(res, state, { error: 'That account no longer exists.' })
      return discordDone(res, state, { token: signToken(rows[0]), linked: true })
    }

    let user
    if (linked.length) {
      const { rows } = await query(
        `UPDATE ${SCHEMA}.users SET discord_username = $1, last_login_at = NOW() WHERE id = $2 RETURNING ${USER_COLUMNS}`,
        [discordName, linked[0].id],
      )
      user = rows[0]
    } else {
      const { rows } = await query(
        `INSERT INTO ${SCHEMA}.users (username, discord_id, discord_username, last_login_at)
         VALUES ($1, $2, $3, NOW()) RETURNING ${USER_COLUMNS}`,
        [await freeUsername(discord.username || discordName), discordId, discordName],
      )
      user = rows[0]
    }
    user = await withPermanentRights(user)
    discordDone(res, state, { token: signToken(user) })
  } catch (err) {
    console.error('Discord callback error:', err)
    discordDone(res, state, { error: 'Discord sign-in failed. Try again.' })
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

// The account, if a valid token came with the request; anyone may call on without one
export function optionalUser(req, res, next) {
  const auth = req.headers.authorization
  if (auth?.startsWith('Bearer ')) {
    try {
      req.user = jwt.verify(auth.slice(7), secret())
    } catch {
      // As anyone else, then
    }
  }
  next()
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
// Stop signing in with Discord; only for an account that has a password to fall back on
router.delete('/discord', verifyToken, async (req, res) => {
  try {
    const { rows } = await query(
      `UPDATE ${SCHEMA}.users SET discord_id = NULL, discord_username = NULL
       WHERE id = $1 AND password_hash IS NOT NULL RETURNING ${USER_COLUMNS}`,
      [req.user.id],
    )
    if (!rows.length) return res.status(409).json({ error: 'Set a password first: this account signs in only with Discord.' })
    res.json({ user: userPublic(rows[0]) })
  } catch (err) {
    console.error('Unlink Discord error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

router.get('/me', verifyToken, async (req, res) => {
  try {
    const { rows } = await query(`SELECT ${USER_COLUMNS} FROM ${SCHEMA}.users WHERE id = $1`, [req.user.id])
    if (!rows.length) return res.status(404).json({ error: 'User not found' })
    res.json({ user: userPublic(rows[0]), usedBytes: await usedBytes(req.user.id) })
  } catch (err) {
    console.error('Me error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
