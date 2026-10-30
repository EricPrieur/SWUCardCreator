import { useEffect, useState } from 'react'
import { api, type Session } from './api'
import { describe } from '../server/engine/describe.ts'
import { replay, type GameRecord, type Step } from '../server/engine/record.ts'

// The Admin panel's tabs about the Simulator's games, as on The Chrome Grid: what is being
// played (Stats), each game (Games), the leaders and decks played (Decks) and each card (Cards)

// Which games are counted: those of the last days (0: all of them), and those played on a
// developer's computer too or not (on this computer they are the only ones there are)
export type GameFilter = { days: number; dev: boolean }
export const defaultFilter: GameFilter = { days: 0, dev: import.meta.env.DEV }
const queryOf = (filter: GameFilter, more = '') => `?days=${filter.days}&dev=${filter.dev ? 1 : 0}${more}`

type Tally = { games: number; wins: number }
type Side = { name: string; deck: string; seat: 'human' | 'ai'; leader: string; base: string; cardCount?: number; playedCount?: number }
type GameRow = {
  id: number
  status: string
  winner: number | null
  draw: boolean
  rounds: number
  ai_version: string | null
  sides: Side[]
  names: Record<string, string>
  bytes: number
  is_dev: boolean
  started_at: string
  updated_at: string
  finished_at: string | null
  username: string | null
  moves?: number
}

const pct = (wins: number, games: number) => (games ? `${Math.round((100 * wins) / games)}%` : '—')
const when = (date: string | null) => (date ? new Date(date).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '—')
const minutes = (seconds: number | null) => (seconds == null ? '—' : `${Math.round(seconds / 60)} min`)

function useAdmin<T>(session: Session, path: string | null) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!path) return
    setData(null)
    setError(null)
    api<T>(path, { token: session.token })
      .then(setData)
      .catch((err: Error) => setError(err.message))
  }, [session.token, path])
  return { data, error }
}

function Loading(props: { error: string | null }) {
  return props.error ? <p className="account-error">{props.error}</p> : <p className="account-note">Loading…</p>
}

export function FilterBar(props: { filter: GameFilter; onChange: (filter: GameFilter) => void }) {
  const { filter, onChange } = props
  return (
    <div className="admin-filter">
      <label>
        Period{' '}
        <select value={filter.days} onChange={(event) => onChange({ ...filter, days: Number(event.target.value) })}>
          <option value={0}>All time</option>
          <option value={30}>Last 30 days</option>
          <option value={7}>Last 7 days</option>
          <option value={1}>Last day</option>
        </select>
      </label>
      <label title="Games played with the site running on a developer's computer (localhost)">
        <input type="checkbox" checked={filter.dev} onChange={(event) => onChange({ ...filter, dev: event.target.checked })} /> Count local
        test games
      </label>
    </div>
  )
}

type GameStats = {
  hour: number
  day: number
  week: number
  total: number
  accounts: number
  anonymous: number
  live: number
  statuses: Record<string, number>
  averageRounds: number | null
  averageSeconds: number | null
  humans: { games: number; wins: number; draws: number }
  aiVersions: { version: string; games: number; wins: number }[]
  perDay: { day: string; games: number }[]
}

function Tile(props: { label: string; value: string | number; note?: string }) {
  return (
    <div className="admin-tile">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      {props.note && <small>{props.note}</small>}
    </div>
  )
}

export function StatsTab(props: { session: Session; filter: GameFilter }) {
  const { data, error } = useAdmin<GameStats>(props.session, `/api/admin/game-stats${queryOf(props.filter)}`)
  if (!data) return <Loading error={error} />
  const most = Math.max(1, ...data.perDay.map((d) => d.games))
  const statusNames: Record<string, string> = { finished: 'Finished', conceded: 'Conceded', left: 'Left', abandoned: 'Abandoned', playing: 'Playing now' }
  return (
    <div className="admin-stats">
      <div className="admin-tiles">
        <Tile label="Last hour" value={data.hour} />
        <Tile label="Last day" value={data.day} />
        <Tile label="Last 7 days" value={data.week} />
        <Tile label="Games" value={data.total} note={`${data.live} playing now`} />
        <Tile label="Players" value={data.accounts} note={`accounts; ${data.anonymous} games signed out`} />
        <Tile label="A game lasts" value={data.averageRounds == null ? '—' : `${data.averageRounds.toFixed(1)} rounds`} note={minutes(data.averageSeconds)} />
        <Tile
          label="People vs the AI"
          value={pct(data.humans.wins, data.humans.games)}
          note={`won ${data.humans.wins} of ${data.humans.games}${data.humans.draws ? `, ${data.humans.draws} draws` : ''}`}
        />
      </div>
      <div className="admin-columns">
        <section>
          <h3>How games end</h3>
          <table className="admin-table">
            <tbody>
              {Object.entries(statusNames).map(([status, name]) => (
                <tr key={status}>
                  <td>{name}</td>
                  <td className="num">{data.statuses[status] ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section>
          <h3>The AI's versions</h3>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Version</th>
                <th className="num">Games</th>
                <th className="num">AI wins</th>
              </tr>
            </thead>
            <tbody>
              {data.aiVersions.map((v) => (
                <tr key={v.version}>
                  <td>{v.version}</td>
                  <td className="num">{v.games}</td>
                  <td className="num">{pct(v.wins, v.games)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section>
          <h3>Games a day, last 14 days</h3>
          {data.perDay.length ? (
            <div className="admin-bars">
              {data.perDay.map((d) => (
                <div key={d.day} title={`${d.day}: ${d.games}`}>
                  <span style={{ height: `${(100 * d.games) / most}%` }} />
                  <small>{d.day.slice(5)}</small>
                </div>
              ))}
            </div>
          ) : (
            <p className="account-note">None yet.</p>
          )}
        </section>
      </div>
    </div>
  )
}

const statusLabel = (game: GameRow) => {
  if (game.status === 'finished' || game.status === 'conceded') {
    if (game.draw) return 'Draw'
    const winner = game.winner == null ? undefined : game.sides[game.winner]
    return `${winner?.seat === 'human' ? 'Player won' : 'AI won'}${game.status === 'conceded' ? ' (concede)' : ''}`
  }
  return { left: 'Left', abandoned: 'Abandoned', playing: 'Playing' }[game.status] ?? game.status
}
const sideText = (side: Side, names: Record<string, string>) => `${names[side.leader] ?? side.leader} · ${side.deck}`

export function GamesTab(props: { session: Session; filter: GameFilter }) {
  const { data, error } = useAdmin<{ games: GameRow[] }>(props.session, `/api/admin/games${queryOf(props.filter)}`)
  const [open, setOpen] = useState<number | null>(null)
  if (open !== null) return <GameView session={props.session} id={open} onBack={() => setOpen(null)} />
  if (!data) return <Loading error={error} />
  if (!data.games.length) return <p className="account-note">No games yet.</p>
  return (
    <div className="admin-table-wrap">
      <table className="admin-table admin-clickable">
        <thead>
          <tr>
            <th>#</th>
            <th>Started</th>
            <th>Player</th>
            <th>Player's deck</th>
            <th>AI's deck</th>
            <th>Result</th>
            <th className="num">Rounds</th>
            <th className="num">Moves</th>
          </tr>
        </thead>
        <tbody>
          {data.games.map((game) => {
            const human = game.sides.find((s) => s.seat === 'human') ?? game.sides[0]
            const ai = game.sides.find((s) => s.seat === 'ai') ?? game.sides[1]
            return (
              <tr key={game.id} onClick={() => setOpen(game.id)} title="Open this game">
                <td>
                  {game.id}
                  {game.is_dev && <span className="admin-badge dim">local</span>}
                </td>
                <td>{when(game.started_at)}</td>
                <td>{game.username ?? <span className="dim">signed out</span>}</td>
                <td>{sideText(human, game.names)}</td>
                <td>{sideText(ai, game.names)}</td>
                <td>{statusLabel(game)}</td>
                <td className="num">{game.rounds}</td>
                <td className="num">{game.moves}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// A game's moves, each with what it did, round by round; rebuilt from the record with the cards
// as they are today (a card changed since may make the rest of the game go differently)
type Move = { step: Step; text: string; why: { text: string; gain: number }[]; log: string[]; who: string; round: number; phase: string }

function GameView(props: { session: Session; id: number; onBack: () => void }) {
  const { data, error } = useAdmin<{ game: GameRow & { record: GameRecord } }>(props.session, `/api/admin/games/${props.id}`)
  const [moves, setMoves] = useState<{ list: Move[]; broke?: string } | null>(null)
  const game = data?.game
  useEffect(() => {
    if (!game) return
    let gone = false
    import('./Simulator').then(async ({ loadSet }) => {
      const set = await loadSet()
      const list: Move[] = []
      let logged = 0
      let broke: string | undefined
      try {
        const end = replay(game.record, set.defs, undefined, (state, step) => {
          const last = list.at(-1)
          if (last) last.log = state.log.slice(logged).map((l) => l.text)
          logged = state.log.length
          list.push({
            step,
            text: describe(state, step.p, step.action),
            why: (step.why ?? []).map((w) => ({ text: describe(state, step.p, w.action), gain: w.gain })),
            log: [],
            who: state.players[step.p].name,
            round: state.round,
            phase: state.phase,
          })
        })
        const last = list.at(-1)
        if (last) last.log = end.log.slice(logged).map((l) => l.text)
      } catch (err) {
        broke = (err as Error).message
      }
      if (!gone) setMoves({ list, broke })
    })
    return () => {
      gone = true
    }
  }, [game])

  const download = () => {
    if (!game) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(game.record)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `game-${game.id}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="admin-game">
      <div className="admin-game-head">
        <button className="chip" type="button" onClick={props.onBack}>
          ← All games
        </button>
        {game && (
          <button className="chip" type="button" onClick={download} title="The record, to replay with the server's game tools">
            Download record
          </button>
        )}
      </div>
      {!game ? (
        <Loading error={error} />
      ) : (
        <>
          <p>
            Game {game.id}, {when(game.started_at)}, by {game.username ?? 'someone signed out'}: <strong>{statusLabel(game)}</strong> in {game.rounds} rounds.
            {game.ai_version && <span className="dim"> AI {game.ai_version}.</span>}
          </p>
          <div className="admin-columns">
            {game.sides.map((side, p) => (
              <section key={p}>
                <h3>
                  {side.seat === 'human' ? 'Player' : 'AI'}: {side.deck}
                  {game.winner === p && <span className="admin-badge">winner</span>}
                </h3>
                <p>
                  {game.names[side.leader] ?? side.leader}
                  <br />
                  {game.names[side.base] ?? side.base}
                </p>
              </section>
            ))}
          </div>
          {!moves ? (
            <p className="account-note">Replaying…</p>
          ) : (
            <>
              {moves.broke && (
                <p className="account-error">
                  The replay stopped at move {moves.list.length}: {moves.broke}. A card may have changed since this game.
                </p>
              )}
              <ol className="admin-moves">
                {moves.list.map((move, i) => {
                  const newRound = i === 0 || moves.list[i - 1].round !== move.round || moves.list[i - 1].phase !== move.phase
                  return [
                    newRound && (
                      <li key={`round${i}`} className="admin-round">
                        Round {move.round}, {move.phase} phase
                      </li>
                    ),
                    <li key={i} value={i + 1}>
                      <div>
                        <strong>{move.who}</strong>: {move.text}
                        {move.why.length > 1 && (
                          <span className="dim" title="The moves the AI weighed, best first, and what each was worth to it">
                            {' '}
                            (weighed {move.why.map((w) => `${w.text} ${w.gain}`).join('; ')})
                          </span>
                        )}
                      </div>
                      {move.log.map((line, j) => (
                        <div key={j} className="admin-log">
                          {line}
                        </div>
                      ))}
                    </li>,
                  ]
                })}
              </ol>
            </>
          )}
        </>
      )}
    </div>
  )
}

type DeckStats = {
  games: number
  names: Record<string, string>
  leaders: { leader: string; human: Tally; ai: Tally; bases: Record<string, number> }[]
  decks: { deck: string; leader: string; base: string; human: Tally; ai: Tally }[]
}

const TallyCells = (props: { tally: Tally }) => (
  <>
    <td className="num">{props.tally.games}</td>
    <td className="num">{pct(props.tally.wins, props.tally.games)}</td>
  </>
)

export function DecksTab(props: { session: Session; filter: GameFilter }) {
  const { data, error } = useAdmin<DeckStats>(props.session, `/api/admin/deck-stats${queryOf(props.filter)}`)
  if (!data) return <Loading error={error} />
  if (!data.games) return <p className="account-note">No games over yet.</p>
  const name = (id: string) => data.names[id] ?? id
  const head = (
    <>
      <th className="num">Player games</th>
      <th className="num">Player wins</th>
      <th className="num">AI games</th>
      <th className="num">AI wins</th>
    </>
  )
  return (
    <div className="admin-stats">
      <p className="account-note">{data.games} games over. Each side of a game counts once for its deck.</p>
      <h3>Leaders</h3>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Leader</th>
              <th>Bases played</th>
              {head}
            </tr>
          </thead>
          <tbody>
            {data.leaders.map((row) => (
              <tr key={row.leader}>
                <td>{name(row.leader)}</td>
                <td className="admin-wrap">
                  {Object.entries(row.bases)
                    .sort((a, b) => b[1] - a[1])
                    .map(([base, n]) => `${name(base)} (${n})`)
                    .join(', ')}
                </td>
                <TallyCells tally={row.human} />
                <TallyCells tally={row.ai} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Decks</h3>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Deck</th>
              <th>Leader</th>
              <th>Base</th>
              {head}
            </tr>
          </thead>
          <tbody>
            {data.decks.map((row) => (
              <tr key={`${row.deck}|${row.leader}|${row.base}`}>
                <td>{row.deck}</td>
                <td>{name(row.leader)}</td>
                <td>{name(row.base)}</td>
                <TallyCells tally={row.human} />
                <TallyCells tally={row.ai} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

type CardRow = { id: string; name: string; decks: number; copies: number; wins: number; played: number; winsPlayed: number }
type CardSort = 'decks' | 'played' | 'win' | 'winPlayed' | 'name'

export function CardsTab(props: { session: Session; filter: GameFilter }) {
  const [seat, setSeat] = useState<'all' | 'human' | 'ai'>('all')
  const [sort, setSort] = useState<CardSort>('decks')
  const [search, setSearch] = useState('')
  const { data, error } = useAdmin<{ games: number; cards: CardRow[] }>(
    props.session,
    `/api/admin/card-stats${queryOf(props.filter, seat === 'all' ? '' : `&seat=${seat}`)}`,
  )
  const rate = (wins: number, games: number) => (games ? wins / games : -1)
  const notPlayed = (c: CardRow) => ({ wins: c.wins - c.winsPlayed, games: c.decks - c.played })
  const sorters: Record<CardSort, (a: CardRow, b: CardRow) => number> = {
    decks: (a, b) => b.decks - a.decks,
    played: (a, b) => b.played - a.played,
    win: (a, b) => rate(b.wins, b.decks) - rate(a.wins, a.decks),
    winPlayed: (a, b) => rate(b.winsPlayed, b.played) - rate(a.winsPlayed, a.played),
    name: (a, b) => a.name.localeCompare(b.name),
  }
  const th = (key: CardSort, label: string, title?: string) => (
    <th className={key === 'name' ? undefined : 'num'} title={title}>
      <button type="button" className={`admin-sort${sort === key ? ' on' : ''}`} onClick={() => setSort(key)}>
        {label}
      </button>
    </th>
  )
  const shown = data?.cards.filter((c) => c.name.toLowerCase().includes(search.toLowerCase())).sort(sorters[sort])
  return (
    <div className="admin-stats">
      <div className="admin-filter">
        <label>
          Decks of{' '}
          <select value={seat} onChange={(event) => setSeat(event.target.value as typeof seat)}>
            <option value="all">Players and the AI</option>
            <option value="human">Players</option>
            <option value="ai">The AI</option>
          </select>
        </label>
        <input type="search" placeholder="Find a card" value={search} onChange={(event) => setSearch(event.target.value)} />
      </div>
      {!data || !shown ? (
        <Loading error={error} />
      ) : !data.games ? (
        <p className="account-note">No games over yet.</p>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                {th('name', 'Card')}
                {th('decks', 'In decks', 'Games with the card in the deck')}
                <th className="num" title="Copies a deck, on average">
                  Copies
                </th>
                {th('win', 'Win rate', 'Wins of the decks with the card')}
                {th('played', 'Played', 'Games the card was played in')}
                {th('winPlayed', 'Win when played')}
                <th className="num">Win when not</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => {
                const not = notPlayed(c)
                return (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td className="num">{c.decks}</td>
                    <td className="num">{(c.copies / c.decks).toFixed(1)}</td>
                    <td className="num">{pct(c.wins, c.decks)}</td>
                    <td className="num">
                      {c.played} <span className="dim">({pct(c.played, c.decks)})</span>
                    </td>
                    <td className="num">{pct(c.winsPlayed, c.played)}</td>
                    <td className="num">{pct(not.wins, not.games)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
