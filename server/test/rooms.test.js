// Online games: a room opened, joined and played through the server, against a throwaway
// Postgres: npm test
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'
import { setPool, initDB } from '../db.js'
import { createApp } from '../app.js'
import { deckList, loadDefs } from '../tools/dune.ts'

const dir = mkdtempSync(join(tmpdir(), 'swu-rooms-'))
const postgres = new EmbeddedPostgres({ databaseDir: dir, user: 'test', password: 'test', port: 54334, persistent: false })
let pool, server, base

before(async () => {
  await postgres.initialise()
  await postgres.start()
  pool = new pg.Pool({ connectionString: 'postgresql://test:test@localhost:54334/postgres' })
  setPool(pool)
  await initDB()
  server = createApp().listen(0)
  base = `http://localhost:${server.address().port}/api`
})

after(async () => {
  server?.closeAllConnections()
  server?.close()
  await pool?.end()
  await postgres.stop()
  rmSync(dir, { recursive: true, force: true })
})

const call = async (method, path, body, token) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

// A stream followed: each event as it comes, and the next one of a kind waited for
function follow(id, key) {
  const controller = new AbortController()
  const events = []
  const waiting = []
  const ready = fetch(`${base}/rooms/${id}/stream`, { headers: key ? { 'X-Seat-Key': key } : {}, signal: controller.signal }).then(async (res) => {
    if (!res.ok) return res.status
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    ;(async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          text += decoder.decode(value, { stream: true })
          let end
          while ((end = text.indexOf('\n\n')) >= 0) {
            const block = text.slice(0, end)
            text = text.slice(end + 2)
            const event = /^event: (.*)$/m.exec(block)?.[1]
            const data = /^data: (.*)$/m.exec(block)?.[1]
            if (!event || !data) continue
            events.push({ event, data: JSON.parse(data) })
            for (const w of waiting.splice(0)) w()
          }
        }
      } catch {
        // Stopped
      }
    })()
    return res.status
  })
  const next = async (kind, check = () => true) => {
    for (let at = 0; ; ) {
      for (; at < events.length; at++) if (events[at].event === kind && check(events[at].data)) return events[at++].data
      await new Promise((resolve) => waiting.push(resolve))
    }
  }
  return { ready, next, stop: () => controller.abort() }
}

test('a room is opened, joined, played and left', async () => {
  const defs = loadDefs()
  const alice = (await call('POST', '/auth/register', { username: 'alice', password: 'longenough' })).body.token
  const bob = (await call('POST', '/auth/register', { username: 'bob', password: 'longenough' })).body.token

  assert.equal((await call('POST', '/rooms', { deck: { leader: 'nope', base: 'nope', deck: [] } }, alice)).status, 400)
  const opened = await call('POST', '/rooms', { deck: deckList('rabban', defs), deckName: 'Rabban', public: true, spectators: false }, alice)
  assert.equal(opened.status, 200)
  const { id, key: aliceKey } = opened.body
  const listed = (await call('GET', '/rooms')).body.rooms
  assert.deepEqual(listed.map((r) => [r.id, r.host, r.deck, r.status]), [[id, 'alice', 'Rabban', 'waiting']])

  const aliceSees = follow(id, aliceKey)
  assert.equal(await aliceSees.ready, 200)
  assert.equal((await aliceSees.next('room')).status, 'waiting')
  // Closed to spectators
  assert.equal(await follow(id).ready, 403)

  const joined = await call('POST', `/rooms/${id}/join`, { deck: deckList('jessica', defs), deckName: 'Jessica BG' }, bob)
  assert.equal(joined.status, 200)
  assert.equal(joined.body.seat, 1)
  assert.equal((await call('POST', `/rooms/${id}/join`, { deck: deckList('jessica', defs) })).status, 409, 'one opponent')
  assert.deepEqual((await call('GET', '/rooms')).body.rooms, [], 'no longer waiting')

  const started = await aliceSees.next('room', (r) => r.status === 'playing')
  assert.equal(started.seat, 0)
  assert.equal(started.view.players[0].name, 'alice')
  assert.equal(started.view.players[1].name, 'bob')
  assert.equal(started.view.players[1].hand, null, "the opponent's hand unseen")

  // Whoever is asked first moves; a move out of turn, or by no one, is refused
  const bobSees = follow(id, joined.body.key)
  const bobView = (await bobSees.next('room')).view
  const keys = [aliceKey, joined.body.key]
  const views = [started.view, bobView]
  const mover = views.findIndex((v) => v.actions.length)
  assert.ok(mover >= 0)
  assert.equal((await call('POST', `/rooms/${id}/act`, { key: keys[1 - mover], action: views[mover].actions[0] })).status, 409)
  assert.equal((await call('POST', `/rooms/${id}/act`, { key: 'nope', action: views[mover].actions[0] })).status, 403)
  assert.equal((await call('POST', `/rooms/${id}/act`, { key: keys[mover], action: views[mover].actions[0] })).status, 200)
  await aliceSees.next('room', (r) => r.view?.log.length > started.view.log.length)

  assert.equal((await call('POST', `/rooms/${id}/chat`, { key: aliceKey, text: 'good luck' })).status, 200)
  assert.deepEqual(await bobSees.next('chat'), { seat: 0, name: 'alice', text: 'good luck' })

  // Saved as it started, and listed as going on with its room, for an admin
  const { rows } = await pool.query(`SELECT mode, status, sides FROM dune.games`)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].mode, 'online')
  assert.deepEqual(rows[0].sides.map((s) => [s.name, s.deck, s.seat]), [['alice', 'Rabban', 'human'], ['bob', 'Jessica BG', 'human']])
  await pool.query(`UPDATE dune.users SET is_admin = TRUE WHERE username = 'alice'`)
  const recent = (await call('GET', '/games/recent', undefined, alice)).body.games
  assert.equal(recent[0].room, id)

  // Bob leaves: he concedes, alice wins
  assert.equal((await call('POST', `/rooms/${id}/leave`, { key: joined.body.key })).status, 200)
  const over = await aliceSees.next('room', (r) => r.status === 'over')
  assert.equal(over.view.winner, 0)
  aliceSees.stop()
  bobSees.stop()
  // Saved as it ended, one save after another
  for (let i = 0; i < 50; i++) {
    const { rows: now } = await pool.query(`SELECT status, winner FROM dune.games`)
    if (now[0].status !== 'playing') {
      assert.deepEqual(now[0], { status: 'conceded', winner: 0 })
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.fail('the end was not saved')
})
