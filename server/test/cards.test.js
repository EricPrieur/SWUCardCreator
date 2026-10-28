// Cards and art of an account, against a throwaway Postgres: npm test
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'

const dir = mkdtempSync(join(tmpdir(), 'swu-cards-'))
process.env.IMAGE_DIR = join(dir, 'images')
// Images no card names are removed at once, so the test can see it
process.env.ORPHAN_GRACE = '0 seconds'
const { setPool, initDB } = await import('../db.js')
const { createApp } = await import('../app.js')

const postgres = new EmbeddedPostgres({ databaseDir: join(dir, 'db'), user: 'test', password: 'test', port: 54331, persistent: false })
let pool, server, base

before(async () => {
  await postgres.initialise()
  await postgres.start()
  pool = new pg.Pool({ connectionString: 'postgresql://test:test@localhost:54331/postgres' })
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
  const raw = body instanceof Uint8Array
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body !== undefined && { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' }),
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  })
  const type = res.headers.get('content-type') ?? ''
  return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) }
}

const register = async (username) =>
  (await call('POST', '/auth/register', { username, password: 'longenough' })).body.token

// The smallest files each kind of image starts with, padded to a size
const png = (size, fill = 1) => {
  const bytes = Buffer.alloc(size, fill)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
  return bytes
}
const webp = (size) => {
  const bytes = Buffer.alloc(size, 2)
  bytes.write('RIFF', 0, 'ascii')
  bytes.write('WEBP', 8, 'ascii')
  return bytes
}

test('cards and art are kept per account, and count against its storage', async () => {
  const alice = await register('alice')
  const bob = await register('bob')

  assert.equal((await call('GET', '/cards')).status, 401)
  assert.deepEqual((await call('GET', '/cards', undefined, alice)).body, { cards: [], usedBytes: 0 })

  // Art first, then the card that names it
  const art = png(1000)
  const up = await call('POST', '/images', art, alice)
  assert.equal(up.status, 201)
  assert.match(up.body.id, /^[0-9a-f]{64}$/)
  // The same image again is kept once
  const again = await call('POST', '/images', art, alice)
  assert.equal(again.status, 200)
  assert.equal(again.body.usedBytes, 1000)
  assert.equal((await call('POST', '/images', Buffer.from('not an image'), alice)).status, 400)

  const card = { frameId: 'unit-command', name: 'Fremen', text: '', trait: '', art: { src: `account:${up.body.id}`, zoom: 1, x: 0, y: 0 } }
  const saved = await call('PUT', '/cards/card-1', { data: card }, alice)
  assert.equal(saved.status, 200)
  assert.ok(saved.body.usedBytes > 1000)

  const list = (await call('GET', '/cards', undefined, alice)).body
  assert.equal(list.cards.length, 1)
  assert.equal(list.cards[0].data.name, 'Fremen')
  assert.equal(list.cards[0].data.id, 'card-1')
  assert.equal(list.cards[0].isPublic, false)

  const image = await call('GET', `/images/${up.body.id}`, undefined, alice)
  assert.equal(image.status, 200)
  assert.ok(image.body.equals(art))

  // Bob sees none of it, can't name Alice's art, and can hold a card with the same id
  assert.equal((await call('GET', '/cards', undefined, bob)).body.cards.length, 0)
  assert.equal((await call('GET', `/images/${up.body.id}`, undefined, bob)).status, 404)
  assert.equal((await call('PUT', '/cards/card-1', { data: card }, bob)).status, 400)
  assert.equal((await call('PUT', '/cards/card-1', { data: { ...card, art: undefined } }, bob)).status, 200)

  // Art left in the card instead of uploaded is refused
  const inline = { ...card, art: { src: 'data:image/webp;base64,' + 'A'.repeat(70000) } }
  assert.equal((await call('PUT', '/cards/card-2', { data: inline }, alice)).status, 413)
  assert.equal((await call('PUT', '/cards/bad id!', { data: card }, alice)).status, 400)

  // New art replaces the old, which goes once no card names it
  const next = await call('POST', '/images', webp(500), alice)
  await call('PUT', '/cards/card-1', { data: { ...card, art: { src: `account:${next.body.id}` } } }, alice)
  assert.equal((await call('GET', `/images/${up.body.id}`, undefined, alice)).status, 404)
  assert.ok(!existsSync(join(process.env.IMAGE_DIR, up.body.id)))

  // Removing the card frees its art too
  const gone = await call('DELETE', '/cards/card-1', undefined, alice)
  assert.equal(gone.body.usedBytes, 0)
  assert.deepEqual(readdirSync(process.env.IMAGE_DIR), [])
})

test('an account can’t go over its limit', async () => {
  const carol = await register('carol')
  await pool.query(`UPDATE dune.users SET quota_bytes = 3000 WHERE username = 'carol'`)

  const first = await call('POST', '/images', png(2000, 3), carol)
  assert.equal(first.status, 201)
  const full = await call('POST', '/images', png(2000, 4), carol)
  assert.equal(full.status, 413)
  assert.equal(full.body.quota, true)

  const card = { frameId: 'event-cunning', name: 'Coriolis Storm', text: 'x'.repeat(1500), trait: '', art: { src: `account:${first.body.id}` } }
  assert.equal((await call('PUT', '/cards/c', { data: card }, carol)).status, 413)
  assert.equal((await call('PUT', '/cards/c', { data: { ...card, text: 'short' } }, carol)).status, 200)

  const me = (await call('GET', '/auth/me', undefined, carol)).body
  assert.ok(me.usedBytes > 2000 && me.usedBytes <= 3000)
})

test('a public card shows to everyone until it is made private or hidden', async () => {
  const dave = await register('dave')
  const eve = await register('eve')
  const art = await call('POST', '/images', png(800, 5), dave)
  const card = { frameId: 'unit-cunning', name: 'Face Dancer', text: '', trait: '', art: { src: `account:${art.body.id}` } }
  await call('PUT', '/cards/fd', { data: card }, dave)

  const front = await call('POST', '/images', webp(300), dave)
  const entry = { id: 'fd', image: 'Face Dancer', name: 'Face Dancer', type: 'Unit', aspects: ['Cunning'], traits: [] }
  // Only its owner can make it public, with images the owner uploaded
  assert.equal((await call('PUT', '/cards/fd/public', { entry, image: front.body.id }, eve)).status, 400)
  assert.equal((await call('PUT', '/cards/nope/public', { entry, image: front.body.id }, dave)).status, 404)
  // An entry missing what the Community tab reads is refused
  assert.equal((await call('PUT', '/cards/fd/public', { entry: { name: 'Face Dancer' }, image: front.body.id }, dave)).status, 400)
  assert.equal((await call('PUT', '/cards/fd/public', { entry, image: front.body.id }, dave)).status, 200)

  // Seen without signing in, image and all; the source art stays private
  const list = (await call('GET', '/public/cards')).body.cards
  assert.equal(list.length, 1)
  assert.equal(list[0].owner, 'dave')
  assert.equal(list[0].entry.name, 'Face Dancer')
  assert.equal((await call('GET', `/public/images/${front.body.id}`)).status, 200)
  assert.equal((await call('GET', `/public/images/${art.body.id}`)).status, 404)
  assert.equal((await call('GET', '/cards', undefined, dave)).body.cards[0].isPublic, true)

  // An admin can hide it, and still sees it, marked
  const admin = (await call('POST', '/auth/register', { username: 'prieur', password: 'longenough' })).body.token
  const key = `/admin/cards/${list[0].userId}/fd`
  assert.equal((await call('PATCH', key, { hidden: true }, eve)).status, 403)
  assert.equal((await call('PATCH', key, { hidden: true }, admin)).status, 200)
  assert.equal((await call('GET', '/public/cards')).body.cards.length, 0)
  assert.equal((await call('GET', `/public/images/${front.body.id}`)).status, 404)
  assert.equal((await call('GET', '/public/cards', undefined, admin)).body.cards[0].hidden, true)
  await call('PATCH', key, { hidden: false }, admin)

  // Private again: gone from the list, and its JPG freed
  assert.equal((await call('DELETE', '/cards/fd/public', undefined, dave)).status, 200)
  assert.equal((await call('GET', '/public/cards')).body.cards.length, 0)
  assert.equal((await call('GET', `/images/${front.body.id}`, undefined, dave)).status, 404)
  assert.equal((await call('GET', `/images/${art.body.id}`, undefined, dave)).status, 200)
})

test('an admin can stop an account making cards public', async () => {
  const frank = await register('frank')
  const admin = (await call('POST', '/auth/login', { username: 'prieur', password: 'longenough' })).body.token
  const me = (await call('GET', '/auth/me', undefined, frank)).body.user
  assert.equal(me.canPublish, true)

  await call('PUT', '/cards/f1', { data: { frameId: 'event-cunning', name: 'Coriolis Storm', text: '', trait: '' } }, frank)
  const front = await call('POST', '/images', webp(400), frank)
  const entry = { id: 'f1', image: 'Coriolis Storm', name: 'Coriolis Storm', type: 'Event', aspects: [], traits: [] }
  assert.equal((await call('PUT', '/cards/f1/public', { entry, image: front.body.id }, frank)).status, 200)

  assert.equal((await call('PATCH', `/admin/users/${me.id}`, { canPublish: 'no' }, admin)).status, 400)
  const off = await call('PATCH', `/admin/users/${me.id}`, { canPublish: false }, admin)
  assert.equal(off.body.user.canPublish, false)
  assert.equal((await call('GET', '/auth/me', undefined, frank)).body.user.canPublish, false)

  // Its cards leave the tab for everyone but admins, who can still load the image
  assert.ok(!(await call('GET', '/public/cards')).body.cards.some((card) => card.owner === 'frank'))
  assert.equal((await call('GET', `/public/images/${front.body.id}`)).status, 404)
  const seen = (await call('GET', '/public/cards', undefined, admin)).body.cards.find((card) => card.owner === 'frank')
  assert.equal(seen.ownerBlocked, true)
  assert.equal((await call('GET', `/admin/public-images/${front.body.id}`, undefined, admin)).status, 200)
  assert.equal((await call('GET', `/admin/public-images/${front.body.id}`, undefined, frank)).status, 403)
  // ...and it can't make another public
  assert.equal((await call('PUT', '/cards/f1/public', { entry, image: front.body.id }, frank)).status, 403)

  await call('PATCH', `/admin/users/${me.id}`, { canPublish: true }, admin)
  assert.ok((await call('GET', '/public/cards')).body.cards.some((card) => card.owner === 'frank'))
})

test('decks are kept per account and per Deck Builder, and count against its storage', async () => {
  const decker = await register('decker')
  const stranger = await register('stranger')
  const deck = { name: 'Spice Rush', sets: ['DUNE'], cards: [{ id: 'a', count: 3 }], sideboard: [] }

  assert.equal((await call('PUT', '/decks/showroom/d1', { data: deck }, decker)).status, 200)
  assert.equal((await call('PUT', '/decks/showcase:DUNE/d2', { data: { ...deck, name: 'Set deck' } }, decker)).status, 200)
  assert.equal((await call('PUT', '/decks/showroom/d1', { data: { ...deck, name: 'Renamed' } }, decker)).status, 200)

  const mine = (await call('GET', '/decks/showroom', undefined, decker)).body.decks
  assert.deepEqual(
    mine.map((each) => [each.id, each.name]),
    [['d1', 'Renamed']],
  )
  assert.equal((await call('GET', '/decks/showcase:DUNE', undefined, decker)).body.decks[0].name, 'Set deck')
  assert.equal((await call('GET', '/decks/showroom', undefined, stranger)).body.decks.length, 0)
  assert.equal((await call('GET', '/decks/showroom')).status, 401)
  assert.equal((await call('PUT', '/decks/bad scope/d1', { data: deck }, decker)).status, 400)

  const used = (await call('GET', '/auth/me', undefined, decker)).body.usedBytes
  assert.ok(used > 100)
  await pool.query(`UPDATE dune.users SET quota_bytes = $1 WHERE username = 'decker'`, [used + 50])
  assert.equal((await call('PUT', '/decks/showroom/d3', { data: { ...deck, name: 'x'.repeat(200) } }, decker)).status, 413)

  assert.equal((await call('DELETE', '/decks/showroom/d1', undefined, decker)).status, 200)
  assert.equal((await call('GET', '/decks/showroom', undefined, decker)).body.decks.length, 0)
})
