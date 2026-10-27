// Runs the server against a throwaway Postgres on this computer: npm test
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'
import { setPool, initDB, DEFAULT_QUOTA } from '../db.js'
import { createApp } from '../app.js'

const dir = mkdtempSync(join(tmpdir(), 'swu-pg-'))
const postgres = new EmbeddedPostgres({ databaseDir: dir, user: 'test', password: 'test', port: 54329, persistent: false })
let pool, server, base

before(async () => {
  await postgres.initialise()
  await postgres.start()
  pool = new pg.Pool({ connectionString: 'postgresql://test:test@localhost:54329/postgres' })
  setPool(pool)
  await initDB()
  // Run twice, as on every start
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

const call = async (method, path, body, token, origin) => {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(origin && { Origin: origin }),
    },
    body: body && JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers }
}

test('register, log in, and read the account', async () => {
  const made = await call('POST', '/auth/register', { username: 'Alice', password: 'longenough' })
  assert.equal(made.status, 201)
  assert.equal(made.body.user.username, 'Alice')
  assert.equal(made.body.user.isAdmin, false)
  assert.equal(made.body.user.quotaBytes, DEFAULT_QUOTA)

  assert.equal((await call('POST', '/auth/register', { username: 'alice', password: 'longenough' })).status, 409)
  assert.equal((await call('POST', '/auth/register', { username: 'bob', password: 'short' })).status, 400)
  assert.equal((await call('POST', '/auth/register', { username: 'b o', password: 'longenough' })).status, 400)

  assert.equal((await call('POST', '/auth/login', { username: 'alice', password: 'wrongpass' })).status, 401)
  assert.equal((await call('POST', '/auth/login', { username: 'nobody', password: 'longenough' })).status, 401)
  const login = await call('POST', '/auth/login', { username: 'ALICE', password: 'longenough' })
  assert.equal(login.status, 200)

  const me = await call('GET', '/auth/me', null, login.body.token)
  assert.equal(me.status, 200)
  assert.equal(me.body.user.username, 'Alice')
  assert.equal(me.body.usedBytes, 0)
  assert.equal((await call('GET', '/auth/me')).status, 401)
  assert.equal((await call('GET', '/auth/me', null, 'not-a-token')).status, 401)
})

test('prieur is a permanent admin with no limit', async () => {
  const made = await call('POST', '/auth/register', { username: 'Prieur', password: 'longenough' })
  assert.equal(made.status, 201)
  assert.equal(made.body.user.isAdmin, true)
  assert.equal(made.body.user.quotaBytes, null)
  const admin = made.body.token

  const alice = (await call('POST', '/auth/login', { username: 'alice', password: 'longenough' })).body
  assert.equal((await call('GET', '/admin/users', null, alice.token)).status, 403)

  const list = await call('GET', '/admin/users', null, admin)
  assert.equal(list.status, 200)
  assert.deepEqual(list.body.users.map((user) => user.username).sort(), ['Alice', 'Prieur'])

  const raised = await call('PATCH', `/admin/users/${alice.user.id}`, { quotaBytes: 100 * 1024 * 1024 }, admin)
  assert.equal(raised.status, 200)
  assert.equal(raised.body.user.quotaBytes, 100 * 1024 * 1024)
  assert.equal(raised.body.user.isAdmin, false)

  // Rights come from the table: Alice made admin can use them with her old token
  assert.equal((await call('PATCH', `/admin/users/${alice.user.id}`, { isAdmin: true }, admin)).status, 200)
  assert.equal((await call('GET', '/admin/users', null, alice.token)).status, 200)
  // ...and can't take them from prieur
  const prieurId = list.body.users.find((user) => user.username === 'Prieur').id
  assert.equal((await call('PATCH', `/admin/users/${prieurId}`, { isAdmin: false }, alice.token)).status, 403)
  assert.equal((await call('PATCH', `/admin/users/${alice.user.id}`, { quotaBytes: -1 }, admin)).status, 400)

  // Taken away in the table, prieur gets the rights back when signing in
  await pool.query('UPDATE dune.users SET is_admin = FALSE, quota_bytes = 10 WHERE id = $1', [prieurId])
  const back = await call('POST', '/auth/login', { username: 'prieur', password: 'longenough' })
  assert.equal(back.body.user.isAdmin, true)
  assert.equal(back.body.user.quotaBytes, null)
})

test('only the app may call it from a browser', async () => {
  const ok = await call('GET', '/health', null, null, 'http://localhost:5173')
  assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:5173')
  const other = await call('GET', '/health', null, null, 'https://evil.example')
  assert.equal(other.headers.get('access-control-allow-origin'), null)
  const bad = await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })
  assert.equal(bad.status, 400)
})
