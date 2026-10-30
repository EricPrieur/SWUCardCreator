import { api, type Session } from './api'
import { summarize, type GameRecord } from '../server/engine/record.ts'
import type { GameState } from '../server/engine/types.ts'

// A Simulator game saved to the server as it is played, for the Admin panel's stats: once as it
// starts, again each new round, and as it ends (or is left). The saves go one after another;
// one that fails is let go, the next carrying the whole record anyway. Signed out, the game is
// saved without an account.
export function gameLog(session: Session | null, record: GameRecord, decks: [string, string]) {
  let saved: { id: number; key: string } | null = null
  let round = -1
  let done = false
  let chain = Promise.resolve()
  const send = (state: GameState, left = false) => {
    const summary = summarize(record, state, { left, decks })
    chain = chain
      .then(async () => {
        const body = { record, summary }
        if (!saved) saved = await api<{ id: number; key: string }>('/api/games', { method: 'POST', body, token: session?.token })
        else await api(`/api/games/${saved.id}`, { method: 'PUT', body: { ...body, key: saved.key } })
      })
      .catch(() => undefined)
  }
  return {
    // The game as it is after each action
    moved(state: GameState) {
      if (done) return
      if (state.phase === 'over') {
        done = true
        send(state)
      } else if (state.round !== round) {
        round = state.round
        send(state)
      }
    },
    // Left before it was over
    left(state: GameState) {
      if (done) return
      done = true
      send(state, true)
    },
  }
}
