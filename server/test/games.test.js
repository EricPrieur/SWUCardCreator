// The Simulator's games saved, and the Admin panel's counts of them, against a throwaway
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
import { chooseAction } from '../engine/ai.ts'
import { createGame } from '../engine/game.ts'
import { recordAction, startRecord, summarize } from '../engine/record.ts'
import { deckList, loadDefs } from '../tools/dune.ts'

const dir = mkdtempSync(join(tmpdir(), 'swu-games-'))
const postgres = new EmbeddedPostgres({ databaseDir: dir, user: 'test', password: 'test', port: 54333, persistent: false })
let pool, server, base

before(async () => {
  await postgres.initialise()
  await postgres.start()
  pool = new pg.Pool({ connectionString: 'postgresql://test:test@localhost:54333/postgres' })
  setPool(pool)
  await initDB()
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
    headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

// A game of the AI against itself, the first seat counted as a person's
function playGame(seed, upTo = Infinity) {
  const defs = loadDefs()
  const decks = [deckList('rabban', defs), deckList('jessica', defs)]
  const record = startRecord(seed, decks, [{ kind: 'human' }, { kind: 'ai', version: 'test' }])
  let state = createGame({ seed, defs, decks })
  for (let steps = 0; state.phase !== 'over' && state.round <= upTo && steps < 5000; steps++) {
    const p = [0, 1].find((q) => chooseAction(state, q))
    state = recordAction(record, state, p, chooseAction(state, p))
  }
  return { record, state, decks: ['Rabban', 'Jessica BG'] }
}

test('a game is saved as it starts and as it ends, and counted in the stats', async () => {
  // Both games played first: a request after a long pause may find its connection closed
  const { record, state, decks } = playGame(3)
  const half = playGame(4, 2)
  const admin = (await call('POST', '/auth/register', { username: 'prieur', password: 'longenough' })).body.token
  const alice = (await call('POST', '/auth/register', { username: 'alice', password: 'longenough' })).body.token

  assert.equal(state.phase, 'over')
  const summary = summarize(record, state, { decks })
  assert.ok(summary.sides[0].played.length, 'the cards played are named')
  assert.equal(summary.sides[1].deck, 'Jessica BG')

  // Started: saved with no account (anyone may play), then by the browser holding its key
  const start = await call('POST', '/games', { record: { ...record, actions: [] }, summary: { ...summary, status: 'playing', winner: null } })
  assert.equal(start.status, 200)
  assert.match(start.body.key, /^[0-9a-f]{32}$/)
  assert.equal((await call('PUT', `/games/${start.body.id}`, { record, summary, key: 'nope' })).status, 404)
  assert.equal((await call('PUT', `/games/${start.body.id}`, { record, summary, key: start.body.key })).status, 200)
  // Over, it stays as it ended
  assert.equal((await call('PUT', `/games/${start.body.id}`, { record, summary, key: start.body.key })).status, 404)

  // One left halfway, by an account
  const left = summarize(half.record, half.state, { left: true, decks: half.decks })
  assert.equal(left.status, 'left')
  assert.equal((await call('POST', '/games', { record: half.record, summary: left }, alice)).status, 200)
  assert.equal((await call('POST', '/games', { record: 'no', summary })).status, 400)

  assert.equal((await call('GET', '/admin/games', undefined, alice)).status, 403)
  const games = (await call('GET', '/admin/games', undefined, admin)).body.games
  assert.equal(games.length, 2)
  assert.equal(games[0].username, 'alice')
  assert.equal(games[0].status, 'left')
  assert.equal(games[1].moves, record.actions.length)
  assert.equal(games[1].sides[0].cards, undefined, 'the list leaves the cards out')

  const one = (await call('GET', `/admin/games/${games[1].id}`, undefined, admin)).body.game
  assert.equal(one.record.actions.length, record.actions.length)

  const stats = (await call('GET', '/admin/game-stats', undefined, admin)).body
  assert.equal(stats.total, 2)
  assert.equal(stats.statuses.finished, 1)
  assert.equal(stats.humans.games, 1)
  assert.equal(stats.humans.wins, state.winner === 0 ? 1 : 0)
  assert.deepEqual(stats.aiVersions.map((v) => v.version), ['test'])

  const deckStats = (await call('GET', '/admin/deck-stats', undefined, admin)).body
  assert.equal(deckStats.games, 1)
  assert.equal(deckStats.decks.length, 2)
  assert.equal(deckStats.decks.find((d) => d.deck === 'Rabban').human.games, 1)

  const cardStats = (await call('GET', '/admin/card-stats?seat=human', undefined, admin)).body
  const card = cardStats.cards.find((c) => c.id === summary.sides[0].played[0])
  assert.equal(card.decks, 1)
  assert.equal(card.played, 1)
  assert.ok(card.name && card.name !== card.id, 'named')

  const users = (await call('GET', '/admin/users', undefined, admin)).body.users
  assert.equal(users.find((u) => u.username === 'alice').gameCount, 1)
})
