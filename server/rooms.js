import { randomBytes } from 'node:crypto'
import { Router } from 'express'
import { query, SCHEMA } from './db.js'
import { optionalUser } from './auth.js'
import { setDefs } from './sets.js'
import { createGame } from './engine/game.ts'
import { recordAction, startRecord, summarize } from './engine/record.ts'
import { viewFor } from './engine/view.ts'

// Online games, as on The Chrome Grid: a player opens a room with a deck, another joins it with
// theirs, and the server plays the game between them, the engine checking every move. Rooms
// live in memory: a restart of the server ends the games under way.
//
// Each player holds their seat's key, and follows the game on a stream (server-sent events)
// that sends what they see of it after every move; spectators follow the same way, as neither
// player. Moves, chat and leaving are posted. The game is saved like the Simulator's games, as
// it starts, each new round and as it ends, for the In Progress list and the Admin panel.
const router = Router()

// Rooms one address may open in an hour
const OPENS_AN_HOUR = 30
const opens = new Map()
// A room waiting for a second player goes once no one has waited in it for this long; a
// player gone from a game this long has left it, and loses; a game over goes after a while
const WAIT_GONE = 2 * 60 * 1000
const PLAY_GONE = 5 * 60 * 1000
const OVER_KEPT = 15 * 60 * 1000
// What keeps a stream open through proxies when nothing happens
const HEARTBEAT = 25 * 1000
const MAX_DECK = 100
const MAX_CHAT = 200

const rooms = new Map()
const isDev = (req) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.origin ?? '')
const newKey = () => randomBytes(16).toString('hex')
const newId = () => randomBytes(6).toString('base64url')

// The room a live game's saved row belongs to, for the In Progress list
export function roomOfGame(gameId) {
  for (const room of rooms.values()) if (room.saved?.id === gameId && room.state?.phase !== 'over') return room.id
  return null
}

// A deck as the engine takes it, checked against the set: { name, leader, base, deck, printings? }
function checkDeck(list, defs) {
  const byId = new Map(defs.map((d) => [d.id, d]))
  if (!list || typeof list !== 'object') return { error: 'A deck is needed' }
  const leader = byId.get(list.leader)
  const base = byId.get(list.base)
  if (leader?.type !== 'leader') return { error: 'Unknown leader' }
  if (base?.type !== 'base') return { error: 'Unknown base' }
  if (!Array.isArray(list.deck) || !list.deck.length || list.deck.length > MAX_DECK) return { error: 'The deck has no cards, or too many' }
  if (!list.deck.every((id) => ['unit', 'upgrade', 'event'].includes(byId.get(id)?.type))) return { error: 'A card of the deck is not in the set' }
  const printings = Array.isArray(list.printings)
    ? list.deck.map((_, i) => (['prescient', 'foil', 'prescient-foil'].includes(list.printings[i]) ? list.printings[i] : null))
    : undefined
  return { leader: list.leader, base: list.base, deck: list.deck.map(String), ...(printings?.some(Boolean) && { printings }) }
}

const deckName = (body) => String(body?.deckName ?? '').slice(0, 80) || 'Deck'
const seatOf = (room, key) => (key ? room.seats.findIndex((seat) => seat?.key === key) : -1)

// What a room says of itself in the lists
const about = (room) => ({
  id: room.id,
  host: room.seats[0].name,
  deck: room.seats[0].deckName,
  leader: room.seats[0].deck.leader,
  base: room.seats[0].deck.base,
  public: room.isPublic,
  spectators: room.spectators,
  status: room.state ? (room.state.phase === 'over' ? 'over' : 'playing') : 'waiting',
  createdAt: room.createdAt,
})

// What one stream is sent: the room, and the game as that seat (or a spectator) sees it
function snapshot(room, seat) {
  const watching = seat === null
  return {
    ...about(room),
    seat,
    players: room.seats.map((s, p) => s && { name: s.name, deck: s.deckName, gone: !!room.state && !s.streams && p !== seat }),
    watchers: [...room.streams].filter((s) => s.seat === null).length,
    view: room.state && viewFor(room.state, watching ? 0 : seat, watching),
    last: room.last,
  }
}

function send(stream, event, data) {
  stream.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}
function broadcast(room) {
  for (const stream of room.streams) send(stream, 'room', snapshot(room, stream.seat))
}

// The game saved as the Simulator's are: once as it starts, again each new round and as it ends
async function save(room) {
  const { state, record } = room
  const summary = summarize(record, state, { decks: room.seats.map((s) => s.deckName) })
  const json = JSON.stringify(record)
  const values = [summary.status, summary.winner === 0 || summary.winner === 1 ? summary.winner : null, summary.winner === 'draw', summary.rounds]
  try {
    if (!room.saved) {
      const key = newKey()
      const { rows } = await query(
        `INSERT INTO ${SCHEMA}.games (user_id, key, mode, status, winner, draw, rounds, sides, names, record, bytes, is_dev, is_public, spectators, finished_at)
         VALUES ($1, $2, 'online', $3::VARCHAR, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CASE WHEN $3::VARCHAR = 'playing' THEN NULL ELSE NOW() END)
         RETURNING id`,
        [room.seats[0].userId, key, ...values, JSON.stringify(summary.sides), JSON.stringify(summary.names), json, json.length, room.isDev, room.isPublic, room.spectators],
      )
      room.saved = { id: rows[0].id, key }
    } else {
      await query(
        `UPDATE ${SCHEMA}.games SET status = $2::VARCHAR, winner = $3, draw = $4, rounds = $5, sides = $6, record = $7, bytes = $8, updated_at = NOW(),
           finished_at = CASE WHEN $2::VARCHAR = 'playing' THEN NULL ELSE NOW() END
         WHERE id = $1`,
        [room.saved.id, ...values, JSON.stringify(summary.sides), json, json.length],
      )
    }
  } catch (err) {
    console.error('Online game save error:', err)
  }
}
// One after another, the last always going through
function saveLater(room) {
  room.saving = (room.saving ?? Promise.resolve()).then(() => save(room))
}

// A move by a seat: the engine says whether it may; the game is saved each new round and at its end
function move(room, seat, action) {
  const before = room.state
  const played = action.type === 'play' ? before.players[seat].hand.find((c) => c.id === action.card)?.def : undefined
  room.state = recordAction(room.record, before, seat, action)
  if (played) room.last = room.last.map((def, p) => (p === seat ? played : def))
  room.movedAt = Date.now()
  if (room.state.phase === 'over' || room.state.round !== before.round) saveLater(room)
  broadcast(room)
}

router.get('/rooms', (req, res) => {
  const dev = isDev(req)
  const waiting = [...rooms.values()].filter((room) => room.isPublic && !room.state && (dev || !room.isDev))
  res.json({ rooms: waiting.sort((a, b) => b.createdAt - a.createdAt).map(about) })
})

// Opened with a deck: { deck, deckName, public, spectators } → { id, key, seat }
router.post('/rooms', optionalUser, async (req, res) => {
  const now = Date.now()
  const recent = (opens.get(req.ip) ?? []).filter((t) => now - t < 3600_000)
  if (recent.length >= OPENS_AN_HOUR) return res.status(429).json({ error: 'Too many games opened; try again later' })
  let defs
  try {
    defs = await setDefs()
  } catch (err) {
    console.error('Set load error:', err)
    return res.status(503).json({ error: 'The cards could not be read; try again shortly' })
  }
  const deck = checkDeck(req.body?.deck, defs)
  if (deck.error) return res.status(400).json({ error: deck.error })
  opens.set(req.ip, [...recent, now])
  const room = {
    id: newId(),
    createdAt: now,
    movedAt: now,
    isPublic: req.body?.public !== false,
    spectators: req.body?.spectators === true,
    isDev: isDev(req),
    defs,
    seats: [{ key: newKey(), userId: req.user?.id ?? null, name: req.user?.username ?? 'Guest', deck, deckName: deckName(req.body), streams: 0, goneAt: now }, null],
    state: null,
    record: null,
    last: [null, null],
    streams: new Set(),
  }
  rooms.set(room.id, room)
  res.json({ id: room.id, key: room.seats[0].key, seat: 0 })
})

router.get('/rooms/:id', (req, res) => {
  const room = rooms.get(req.params.id)
  if (!room) return res.status(404).json({ error: 'This game is over or was never opened' })
  res.json({ room: about(room) })
})

// Joined with a deck: { deck, deckName } → { key, seat }; the game starts
router.post('/rooms/:id/join', optionalUser, (req, res) => {
  const room = rooms.get(req.params.id)
  if (!room) return res.status(404).json({ error: 'This game is over or was never opened' })
  if (room.state || room.seats[1]) return res.status(409).json({ error: 'Someone joined this game first' })
  const deck = checkDeck(req.body?.deck, room.defs)
  if (deck.error) return res.status(400).json({ error: deck.error })
  const host = room.seats[0]
  let name = req.user?.username ?? 'Guest'
  if (name === host.name) name = `${name} (2)`
  room.seats[1] = { key: newKey(), userId: req.user?.id ?? null, name, deck, deckName: deckName(req.body), streams: 0, goneAt: Date.now() }
  // Each player named in the game by their account
  const decks = room.seats.map((seat) => ({ name: seat.name, ...seat.deck }))
  const seed = Date.now()
  room.record = startRecord(seed, decks, [
    { kind: 'human', name: host.name },
    { kind: 'human', name },
  ])
  room.state = createGame({ seed, defs: room.defs, decks })
  room.movedAt = Date.now()
  saveLater(room)
  broadcast(room)
  res.json({ key: room.seats[1].key, seat: 1 })
})

// The game followed: a seat's key in X-Seat-Key, or none to watch (when the room lets anyone)
router.get('/rooms/:id/stream', (req, res) => {
  const room = rooms.get(req.params.id)
  if (!room) return res.status(404).json({ error: 'This game is over or was never opened' })
  const at = seatOf(room, req.headers['x-seat-key'])
  const seat = at >= 0 ? at : null
  if (seat === null && !room.spectators) return res.status(403).json({ error: 'This game is not open to spectators' })
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  const stream = { res, seat }
  room.streams.add(stream)
  if (seat !== null) {
    room.seats[seat].streams++
    room.seats[seat].goneAt = null
  }
  broadcast(room)
  for (const line of room.chat ?? []) send(stream, 'chat', line)
  const beat = setInterval(() => res.write(': still here\n\n'), HEARTBEAT)
  req.on('close', () => {
    clearInterval(beat)
    room.streams.delete(stream)
    if (seat !== null && room.seats[seat] && !--room.seats[seat].streams) room.seats[seat].goneAt = Date.now()
    if (rooms.has(room.id)) broadcast(room)
  })
})

// The room and the seat whose key is posted; or null, the answer sent
function seatOrFail(req, res) {
  const room = rooms.get(req.params.id)
  if (!room) {
    res.status(404).json({ error: 'This game is over or was never opened' })
    return null
  }
  const seat = seatOf(room, String(req.body?.key ?? ''))
  if (seat < 0) {
    res.status(403).json({ error: 'Not a player of this game' })
    return null
  }
  return { room, seat }
}

// A move: { key, action }
router.post('/rooms/:id/act', (req, res) => {
  const found = seatOrFail(req, res)
  if (!found) return
  const { room, seat } = found
  if (!room.state) return res.status(409).json({ error: 'The game has not started' })
  try {
    move(room, seat, req.body?.action)
    res.json({ ok: true })
  } catch (err) {
    res.status(409).json({ error: err?.message ?? 'Not a move' })
  }
})

// A line of chat: { key, text }, for both players and those watching
router.post('/rooms/:id/chat', (req, res) => {
  const found = seatOrFail(req, res)
  if (!found) return
  const { room, seat } = found
  const text = String(req.body?.text ?? '').trim().slice(0, 300)
  if (!text) return res.status(400).json({ error: 'Nothing to say' })
  const line = { seat, name: room.seats[seat].name, text }
  room.chat = [...(room.chat ?? []), line].slice(-MAX_CHAT)
  for (const stream of room.streams) send(stream, 'chat', line)
  res.json({ ok: true })
})

// Leaving: a room still waiting closes; a game under way is conceded
router.post('/rooms/:id/leave', (req, res) => {
  const found = seatOrFail(req, res)
  if (!found) return
  const { room, seat } = found
  if (!room.state) close(room)
  else if (room.state.phase !== 'over') move(room, seat, { type: 'concede' })
  res.json({ ok: true })
})

function close(room) {
  rooms.delete(room.id)
  for (const stream of room.streams) {
    send(stream, 'closed', {})
    stream.res.end()
  }
}

// Rooms no one waits in any more, players gone too long (who lose), games long over
setInterval(() => {
  const now = Date.now()
  for (const room of rooms.values()) {
    if (!room.state) {
      if (room.seats[0].goneAt && now - room.seats[0].goneAt > WAIT_GONE) close(room)
    } else if (room.state.phase !== 'over') {
      const gone = room.seats.findIndex((seat) => seat.goneAt && now - seat.goneAt > PLAY_GONE)
      if (gone >= 0) move(room, gone, { type: 'concede' })
    } else if (now - room.movedAt > OVER_KEPT) close(room)
  }
}, 30 * 1000).unref()

export default router
