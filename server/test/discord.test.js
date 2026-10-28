// Discord sign-in, with Discord's two answers faked: npm test
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'
import { setPool, initDB } from '../db.js'
import { createApp } from '../app.js'

const dir = mkdtempSync(join(tmpdir(), 'swu-pg-'))
const postgres = new EmbeddedPostgres({ databaseDir: dir, user: 'test', password: 'test', port: 54332, persistent: false })
const APP = 'http://localhost:5173'
let pool, server, base

// The Discord account the next sign-in comes back as
let discordUser = null
const realFetch = globalThis.fetch
globalThis.fetch = async (url, options) => {
  const href = String(url)
  if (href === 'https://discord.com/api/oauth2/token') return Response.json({ access_token: 'discord-token' })
  if (href === 'https://discord.com/api/users/@me') return Response.json(discordUser)
  return realFetch(url, options)
}

before(async () => {
  process.env.DISCORD_CLIENT_ID = 'client'
  process.env.DISCORD_CLIENT_SECRET = 'secret'
  process.env.DISCORD_REDIRECT_URI = 'http://localhost/api/auth/discord/callback'
  await postgres.initialise()
  await postgres.start()
  pool = new pg.Pool({ connectionString: 'postgresql://test:test@localhost:54332/postgres' })
  setPool(pool)
  await initDB()
  server = createApp().listen(0)
  base = `http://localhost:${server.address().port}/api`
})

after(async () => {
  server?.close()
  await pool?.end()
  await postgres.stop()
  rmSync(dir, { recursive: true, force: true })
})

const call = async (method, path, body, token) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: APP, ...(token && { Authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

// Goes through Discord as discordUser, and gives back the token the window hands the app
async function signIn(body = {}, token) {
  const { body: start } = await call('POST', '/auth/discord/url', { returnTo: `${APP}/#creator`, ...body }, token)
  const state = new URL(start.url).searchParams.get('state')
  const page = await (await fetch(`${base}/auth/discord/callback?code=abc&state=${state}`)).text()
  const message = JSON.parse(page.match(/var message = (\{.*?\}), origin/)[1])
  return message
}

test('Discord makes an account, signs it in again, and links to a password account', async () => {
  assert.equal((await call('GET', '/auth/discord/status')).body.enabled, true)

  discordUser = { id: '111', username: 'prieur', global_name: 'Eric' }
  const first = await signIn()
  assert.ok(first.token)
  const me = (await call('GET', '/auth/me', null, first.token)).body.user
  // Never a permanent admin's name, whatever the Discord name
  assert.equal(me.username, 'prieur-2')
  assert.equal(me.isAdmin, false)
  assert.equal(me.discordName, 'Eric')
  assert.equal(me.hasPassword, false)

  // The same Discord account signs in to the same account
  const again = await signIn()
  assert.equal((await call('GET', '/auth/me', null, again.token)).body.user.id, me.id)

  // A password account links a second Discord account, then signs in with it
  const bob = (await call('POST', '/auth/register', { username: 'bob', password: 'longenough' })).body
  assert.equal((await call('POST', '/auth/discord/url', { link: true })).status, 401)
  discordUser = { id: '222', username: 'bobby', global_name: null }
  const link = await signIn({ link: true }, bob.token)
  assert.equal(link.linked, true)
  const viaDiscord = await signIn()
  const bobMe = (await call('GET', '/auth/me', null, viaDiscord.token)).body.user
  assert.equal(bobMe.username, 'bob')
  assert.equal(bobMe.discordName, 'bobby')

  // Discord account 111 can't be linked to bob as well
  discordUser = { id: '111', username: 'prieur' }
  assert.match((await signIn({ link: true }, bob.token)).error, /already linked/)

  // Unlinking needs a password to fall back on
  assert.equal((await call('DELETE', '/auth/discord', null, first.token)).status, 409)
  const unlinked = await call('DELETE', '/auth/discord', null, bob.token)
  assert.equal(unlinked.status, 200)
  assert.equal(unlinked.body.user.discordName, null)

  // Only the app's own sites may start a sign-in
  const elsewhere = await fetch(`${base}/auth/discord/url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: '{}',
  })
  assert.equal(elsewhere.status, 403)
  // A made-up state is refused
  const forged = await (await fetch(`${base}/auth/discord/callback?code=abc&state=nope`)).text()
  assert.match(forged, /took too long or came from elsewhere/)
})
