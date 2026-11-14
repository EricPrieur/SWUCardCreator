import { useEffect, useState } from 'react'
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
}

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
    fetch(`${API_URL}/api/admin/public-images/${props.id}`, { headers: { Authorization: `Bearer ${props.session.token}` } })
      .then((res) => (res.ok ? res.blob() : Promise.reject()))
      .then((blob) => setSrc((url = URL.createObjectURL(blob))))
      .catch(() => setSrc(null))
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [props.id, props.session.token])
  return src ? <img className="community-queue-image" src={src} alt="" /> : <div className="community-queue-image" />
}

export function CommunityTab(props: { session: Session }) {
  const { session } = props
  const [list, setList] = useState<Submission[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const load = () =>
    api<{ cards: Submission[] }>('/api/admin/community', { token: session.token })
      .then((data) => setList(data.cards))
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
    } catch (err) {
      setError((err as Error).message)
    }
    setBusy(null)
  }

  if (error && !list) return <p className="account-error">{error}</p>
  if (!list) return <p className="account-note">Loading…</p>
  if (!list.length) return <p className="account-note">No card has been submitted to be played yet.</p>
  return (
    <div className="community-queue">
      {error && <p className="account-error">{error}</p>}
      <p className="account-note">
        A card the engine plays already (keywords only, or no text) is supported as it is submitted; you may still decline it. For
        the others, write the script in <code>server/engine/community.ts</code> under its key, restart the server, then Support it here.
      </p>
      {list.map((row) => {
        const id = `${row.key}/${row.version}`
        const playable = row.engine === 'scripted' || row.engine === 'blank'
        return (
          <div key={id} className={`community-queue-row community-${row.status}`}>
            <AdminImage session={session} id={row.image} />
            {row.backImage && <AdminImage session={session} id={row.backImage} />}
            <div className="community-queue-info">
              <strong>
                {[row.entry.name, row.entry.subtitle].filter(Boolean).join(', ')}
              </strong>{' '}
              · {row.entry.type} · {row.entry.set || 'no set'} · by {row.owner} · version {row.version} ·{' '}
              <span className={`community-status community-${row.status}`}>{row.status === 'supported' && row.auto ? 'supported automatically' : row.status}</span>
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
                <button
                  className="button button-primary"
                  type="button"
                  disabled={busy === id || row.status === 'supported'}
                  title={playable ? 'Make this version playable in the Community Deck Builder' : 'The engine does not play all of it yet'}
                  onClick={() => review(row, 'supported')}
                >
                  Support{playable ? '' : ' anyway'}
                </button>
                <button className="button" type="button" disabled={busy === id || row.status === 'declined'} onClick={() => review(row, 'declined')}>
                  Decline
                </button>
                {row.status !== 'awaiting' && (
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
