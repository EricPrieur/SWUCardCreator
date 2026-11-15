import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, API_URL, type Session } from './api'

// The Admin panel's Community queue: the cards players submitted to be played. Each version shows
// what the engine makes of it: playable already (its script in server/engine/community.ts, or
// keywords only), or the lines still to script. Supported, it is in the Community Deck Builder;
// declined, its owner sees the note.
type Submission = {
  key: string
  userId: number
  cardId: string
  version: number
  status: 'awaiting' | 'supported' | 'declined'
  note: string | null
  // Supported as submitted: the engine plays every line
  auto: boolean
  owner: string
  entry: { name: string; subtitle?: string; type: string; set?: string }
  image: string
  backImage: string | null
  submittedAt: string
  reviewedAt: string | null
  engine: 'scripted' | 'outdated' | 'none' | 'blank'
  unplayed: string[]
  text: string
  // What a script needs besides the text: its frame, cost, stats and traits
  card: {
    frameId: string
    cost?: number
    power?: number
    hp?: number
    trait?: string
    unique?: boolean
    upgradePower?: number
    upgradeHp?: number
  }
}

// Everything to write a card's script, to paste to Claude (or anyone writing it)
const forScript = (row: Submission) =>
  [
    `Community card to script, key ${row.key} (version ${row.version}, by ${row.owner})`,
    `Name: ${[row.entry.name, row.entry.subtitle].filter(Boolean).join(', ')}`,
    `Type: ${row.entry.type}, frame ${row.card.frameId}${row.card.unique ? ', unique' : ''}`,
    `Cost ${row.card.cost ?? 0}, power ${row.card.power ?? 0}, HP ${row.card.hp ?? 0}` +
      (row.card.upgradePower !== undefined || row.card.upgradeHp !== undefined
        ? `, as an upgrade +${row.card.upgradePower ?? 0}/+${row.card.upgradeHp ?? 0}`
        : ''),
    `Traits: ${row.card.trait || 'none'}`,
    'Text:',
    row.text || '(none)',
    row.unplayed.length ? `Lines the engine does not play yet:\n${row.unplayed.map((line) => `- ${line}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n')

const engineLabel: Record<Submission['engine'], string> = {
  scripted: 'The engine plays it',
  blank: 'No text: the engine plays it',
  outdated: 'Its script is for older text',
  none: 'Needs a script',
}

// A side's JPG, fetched signed in: a copy whose card has changed since is not public
function AdminImage(props: { session: Session; id: string }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let url: string | null = null
    fetch(`${API_URL}/api/admin/public-images/${props.id}`, {
      headers: { Authorization: `Bearer ${props.session.token}` },
    })
      .then((res) => (res.ok ? res.blob() : Promise.reject()))
      .then((blob) => setSrc((url = URL.createObjectURL(blob))))
      .catch(() => setSrc(null))
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [props.id, props.session.token])
  // Hovered, a larger copy over the page (not cut by the Admin window), kept on the screen
  const thumb = useRef<HTMLImageElement>(null)
  const [zoom, setZoom] = useState<{ left: number; top: number; width: number } | null>(null)
  const show = () => {
    const box = thumb.current?.getBoundingClientRect()
    const image = thumb.current
    if (!box || !image) return
    const width = Math.min(384, window.innerWidth * 0.7)
    const height = (width * image.naturalHeight) / (image.naturalWidth || 1)
    const left = box.right + 8 + width <= window.innerWidth ? box.right + 8 : Math.max(8, box.left - 8 - width)
    const top = Math.max(8, Math.min(box.top, window.innerHeight - height - 8))
    setZoom({ left, top, width })
  }
  if (!src) return <div className="community-queue-image" />
  return (
    <>
      <img ref={thumb} className="community-queue-image" src={src} alt="" onMouseEnter={show} onMouseLeave={() => setZoom(null)} />
      {zoom &&
        createPortal(
          <img className="community-queue-zoom" src={src} alt="" style={{ left: zoom.left, top: zoom.top, width: zoom.width }} />,
          // Inside the Admin window: a modal dialog is above everything else on the page
          thumb.current?.closest('dialog') ?? document.body,
        )}
    </>
  )
}

// The queue's views: what waits for an admin (waiting, or supported automatically and not yet
// confirmed), what is supported, what was declined
const VIEWS = [
  ['review', 'To review'],
  ['supported', 'Supported'],
  ['declined', 'Declined'],
] as const
type View = (typeof VIEWS)[number][0]
const viewOf = (row: Submission): View =>
  row.status === 'awaiting' || (row.status === 'supported' && row.auto) ? 'review' : row.status === 'supported' ? 'supported' : 'declined'

// What waits for an admin (server/community.js, /admin/pending): community cards waiting or
// supported automatically and not yet confirmed, and mail written to the Admins not yet opened.
// Asked as the page opens, every minute, and again after a review.
export type AdminPending = { community: number; mail: number }
const PENDING_EVERY = 60 * 1000
export function useAdminPending(session: Session | null) {
  const [pending, setPending] = useState<AdminPending>({
    community: 0,
    mail: 0,
  })
  const [asked, setAsked] = useState(0)
  const isAdmin = !!session?.user.isAdmin
  useEffect(() => {
    if (!session || !isAdmin) {
      setPending({ community: 0, mail: 0 })
      return
    }
    let live = true
    const ask = () =>
      api<AdminPending>('/api/admin/pending', { token: session.token })
        .then((found) => live && setPending(found))
        .catch(() => undefined)
    ask()
    const timer = window.setInterval(ask, PENDING_EVERY)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [session?.token, isAdmin, asked])
  return { pending, refresh: () => setAsked((n) => n + 1) }
}

export function CommunityTab(props: { session: Session; onReviewed?: () => void }) {
  const { session } = props
  const [list, setList] = useState<Submission[] | null>(null)
  // Each maker's cards in play (supported, or waiting) against their limit; null: no limit
  const [makers, setMakers] = useState<{ userId: number; owner: string; supported: number; inPlay: number; limit: number | null }[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [view, setView] = useState<View>('review')
  const [copied, setCopied] = useState<string | null>(null)
  const load = () =>
    api<{ cards: Submission[]; makers?: typeof makers }>('/api/admin/community', {
      token: session.token,
    })
      .then((data) => {
        setList(data.cards)
        setMakers(data.makers ?? [])
      })
      .catch((err) => setError(err.message))
  useEffect(() => {
    load()
  }, [session.token])

  const review = async (row: Submission, status: Submission['status']) => {
    const id = `${row.key}/${row.version}`
    setBusy(id)
    try {
      await api(`/api/admin/community/${row.userId}/${encodeURIComponent(row.cardId)}/${row.version}`, {
        method: 'PATCH',
        body: { status, note: notes[id] ?? row.note ?? '' },
        token: session.token,
      })
      await load()
      props.onReviewed?.()
    } catch (err) {
      setError((err as Error).message)
    }
    setBusy(null)
  }

  if (error && !list) return <p className="account-error">{error}</p>
  if (!list) return <p className="account-note">Loading…</p>
  if (!list.length) return <p className="account-note">No card has been submitted to be played yet.</p>
  const shown = list.filter((row) => viewOf(row) === view)
  return (
    <div className="community-queue">
      {error && <p className="account-error">{error}</p>}
      <p className="account-note community-makers">
        <b>{makers.reduce((sum, maker) => sum + maker.supported, 0)} supported cards</b>
        {makers.map((maker) => (
          <span
            key={maker.userId}
            title={`${maker.supported} supported, ${maker.inPlay - maker.supported} waiting; ${maker.limit === null ? 'no limit' : `${maker.limit} at most (50, and 50 more for each $5 tipped)`}`}
          >
            {' · '}
            {maker.owner} {maker.supported}
            {maker.inPlay > maker.supported && ` (+${maker.inPlay - maker.supported} waiting)`}
            {maker.limit !== null && `/${maker.limit}`}
          </span>
        ))}
      </p>
      <nav className="tabs community-views">
        {VIEWS.map(([value, label]) => {
          const n = list.filter((row) => viewOf(row) === value).length
          return (
            <a
              key={value}
              href="#"
              aria-current={view === value ? 'page' : undefined}
              onClick={(event) => {
                event.preventDefault()
                setView(value)
              }}
            >
              {label}
              {value === 'review' ? n > 0 && <span className="tab-count">{n}</span> : ` (${n})`}
            </a>
          )
        })}
      </nav>
      <p className="account-note">
        A card the engine plays already (keywords only, or no text) is supported as it is submitted: it is playable at once, and waits here
        until you Confirm it (or Decline it). For the others, write the script in <code>server/engine/community.ts</code> under its key,
        deploy the server, then Support it here.
      </p>
      {!shown.length && <p className="account-note">{view === 'review' ? 'Nothing waits for review.' : 'None.'}</p>}
      {shown.map((row) => {
        const id = `${row.key}/${row.version}`
        const playable = row.engine === 'scripted' || row.engine === 'blank'
        // Supported automatically: playable already, waiting for an admin to confirm it
        const toConfirm = row.status === 'supported' && row.auto
        return (
          <div key={id} className={`community-queue-row community-${row.status}`}>
            <AdminImage session={session} id={row.image} />
            {row.backImage && <AdminImage session={session} id={row.backImage} />}
            <div className="community-queue-info">
              <strong>{[row.entry.name, row.entry.subtitle].filter(Boolean).join(', ')}</strong> · {row.entry.type} ·{' '}
              {row.entry.set || 'no set'} · by {row.owner} · version {row.version} ·{' '}
              <span className={`community-status community-${row.status}`}>
                {row.status === 'supported' && row.auto ? 'supported automatically' : row.status}
              </span>
              <div className="community-queue-key">
                Key: <code>{row.key}</code>
              </div>
              <pre className="community-queue-text">{row.text || '(no text)'}</pre>
              <div className={playable ? 'community-engine-ok' : 'community-engine-todo'}>
                {engineLabel[row.engine]}
                {row.unplayed.length > 0 && (
                  <ul>
                    {row.unplayed.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="community-queue-actions">
                <input
                  className="community-queue-note"
                  placeholder="Note for its owner (shown if declined)"
                  value={notes[id] ?? row.note ?? ''}
                  onChange={(event) => setNotes({ ...notes, [id]: event.target.value })}
                />
                {(row.status !== 'supported' || toConfirm) && (
                  <button
                    className="button button-primary"
                    type="button"
                    disabled={busy === id}
                    title={
                      toConfirm
                        ? 'It is playable already: confirm it, so it no longer waits here'
                        : playable
                          ? 'Make this version playable in the Community Deck Builder'
                          : 'The engine does not play all of it yet'
                    }
                    onClick={() => review(row, 'supported')}
                  >
                    {toConfirm ? 'Confirm' : `Support${playable ? '' : ' anyway'}`}
                  </button>
                )}
                <button
                  className="button"
                  type="button"
                  disabled={busy === id || row.status === 'declined'}
                  onClick={() => review(row, 'declined')}
                >
                  Decline
                </button>
                {row.unplayed.length > 0 && (
                  <button
                    className="button"
                    type="button"
                    title="Copy its key, stats and text, to paste to Claude to write its script"
                    onClick={() => {
                      navigator.clipboard.writeText(forScript(row)).then(
                        () => setCopied(id),
                        () => setError('Could not copy'),
                      )
                    }}
                  >
                    {copied === id ? 'Copied' : 'Copy for script'}
                  </button>
                )}
                {row.status !== 'awaiting' && !toConfirm && (
                  <button className="button" type="button" disabled={busy === id} onClick={() => review(row, 'awaiting')}>
                    Back to the queue
                  </button>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
