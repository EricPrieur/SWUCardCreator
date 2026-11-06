import { API_URL, api, type Session } from './api'
import type { DeckList } from '../server/engine/game.ts'
import type { Action, PlayerId } from '../server/engine/types.ts'
import type { PlayerView } from '../server/engine/view.ts'

// Online games, played on the server (server/rooms.js): a room is opened with a deck, joined with
// another, and followed on a stream that sends what this seat sees after every move.

// A room as the lists show it
export type RoomInfo = {
  id: string
  host: string
  deck: string
  leader: string
  base: string
  public: boolean
  spectators: boolean
  status: 'waiting' | 'playing' | 'over'
  createdAt: number
}
// What the stream sends: the room, each player (gone: lost their connection), and the game as
// this seat sees it (null while waiting), with the last card each player played
export type RoomSnapshot = RoomInfo & {
  seat: PlayerId | null
  players: ({ name: string; deck: string; gone: boolean } | null)[]
  watchers: number
  view: PlayerView | null
  last: [string | null, string | null]
}
export type ChatLine = { seat: PlayerId; name: string; text: string }

// A seat held in a room, kept in this tab so a reload finds the game again (each tab its own: two
// tabs can play each other); no key: watching
export type OnlineSeat = { room: string; key: string | null }
const SEAT_KEY = 'dune-unlimited.simulator.online'
export function keptSeat(): OnlineSeat | null {
  try {
    const seat = JSON.parse(sessionStorage.getItem(SEAT_KEY) ?? 'null')
    return seat?.room ? seat : null
  } catch {
    return null
  }
}
export function keepSeat(seat: OnlineSeat | null) {
  try {
    if (seat?.key) sessionStorage.setItem(SEAT_KEY, JSON.stringify(seat))
    else sessionStorage.removeItem(SEAT_KEY)
  } catch {
    // Not found again after a reload, then
  }
}

export const listRooms = () => api<{ rooms: RoomInfo[] }>('/api/rooms').then((found) => found.rooms)
export const roomInfo = (room: string) => api<{ room: RoomInfo }>(`/api/rooms/${encodeURIComponent(room)}`).then((found) => found.room)

// The deck as the engine takes it (named on the server by its player), and the name it goes by
type Opening = { deck: Omit<DeckList, 'name'>; deckName: string }
export const openRoom = (session: Session | null, opening: Opening & { public: boolean; spectators: boolean }) =>
  api<{ id: string; key: string }>('/api/rooms', { method: 'POST', body: opening, token: session?.token })
export const joinRoom = (session: Session | null, room: string, opening: Opening) =>
  api<{ key: string }>(`/api/rooms/${encodeURIComponent(room)}/join`, { method: 'POST', body: opening, token: session?.token })

const post = (seat: OnlineSeat, what: string, body: object) =>
  api(`/api/rooms/${encodeURIComponent(seat.room)}/${what}`, { method: 'POST', body: { key: seat.key, ...body } })
export const sendMove = (seat: OnlineSeat, action: Action) => post(seat, 'act', { action })
export const sendChat = (seat: OnlineSeat, text: string) => post(seat, 'chat', { text })
export const leaveRoom = (seat: OnlineSeat) => post(seat, 'leave', {})

// The room followed: each snapshot and line of chat as it comes. A stream cut is opened again,
// a little later each time; one the server refuses (the room gone, or closed to spectators)
// ends with `onEnd` and its status. Gives what stops following.
export function followRoom(
  seat: OnlineSeat,
  on: { room: (snapshot: RoomSnapshot) => void; chat: (line: ChatLine) => void; end: (status: number) => void; connected?: (live: boolean) => void },
) {
  const controller = new AbortController()
  let stopped = false
  let tries = 0
  const open = async () => {
    let status = 0
    try {
      const res = await fetch(`${API_URL}/api/rooms/${encodeURIComponent(seat.room)}/stream`, {
        headers: seat.key ? { 'X-Seat-Key': seat.key } : {},
        signal: controller.signal,
        cache: 'no-store',
      })
      status = res.status
      if (res.status === 404 || res.status === 403) return on.end(res.status)
      if (!res.ok || !res.body) throw new Error(String(res.status))
      tries = 0
      on.connected?.(true)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let text = ''
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
          if (event === 'room') on.room(JSON.parse(data))
          else if (event === 'chat') on.chat(JSON.parse(data))
          else if (event === 'closed') {
            stopped = true
            return on.end(404)
          }
        }
      }
    } catch {
      // Cut: opened again below
    }
    if (stopped) return
    on.connected?.(false)
    tries++
    window.setTimeout(() => !stopped && open(), Math.min(10_000, 500 * 2 ** Math.min(tries, 5)) + (status ? 0 : 500))
  }
  open()
  return () => {
    stopped = true
    controller.abort()
  }
}
