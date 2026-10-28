import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  api,
  ApiError,
  onAdminRequest,
  onDiscordDone,
  setSession,
  startDiscord,
  useDiscordEnabled,
  useServerOnline,
  useSession,
  type Session,
  type User,
} from './api'

type AdminUser = User & { lastLoginAt: string | null; usedBytes: number; cardCount: number; permanent: boolean }

export function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  const mb = bytes / (1024 * 1024)
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

const formatDate = (date: string | null) => (date ? new Date(date).toLocaleDateString() : '—')

const discordIcon = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
    <path d="M19.6 5.3A17 17 0 0 0 15.4 4l-.5 1a15.7 15.7 0 0 0-5.8 0l-.5-1a17 17 0 0 0-4.2 1.3C1.7 9.3 1 13.2 1.3 17a17 17 0 0 0 5.2 2.6l1.1-1.8a11 11 0 0 1-1.7-.8l.4-.3a12.2 12.2 0 0 0 11.4 0l.4.3-1.7.8 1.1 1.8a17 17 0 0 0 5.2-2.6c.4-4.4-.7-8.3-3-11.7zM8.7 14.7c-1 0-1.9-1-1.9-2.1s.8-2.1 1.9-2.1 1.9 1 1.9 2.1-.8 2.1-1.9 2.1zm6.6 0c-1 0-1.9-1-1.9-2.1s.8-2.1 1.9-2.1 1.9 1 1.9 2.1-.8 2.1-1.9 2.1z" />
  </svg>
)

// Starts the Discord window; its outcome comes back through onDiscordDone
function useDiscord() {
  const [error, setError] = useState<string | null>(null)
  const [waiting, setWaiting] = useState(false)
  useEffect(
    () =>
      onDiscordDone((next) => {
        setWaiting(false)
        setError(next)
      }),
    [],
  )
  const start = async (link?: Session) => {
    setError(null)
    setWaiting(true)
    try {
      const popup = await startDiscord(link)
      // Closed before the end: nothing more is coming
      const watch = window.setInterval(() => {
        if (!popup || popup.closed) {
          window.clearInterval(watch)
          window.setTimeout(() => setWaiting(false), 500)
        }
      }, 500)
    } catch (err) {
      setWaiting(false)
      setError((err as Error).message)
    }
  }
  return { start, waiting, error }
}

// A window over the page; Escape or a click outside closes it
function Modal(props: { title: string; wide?: boolean; onClose: () => void; children: ReactNode }) {
  const { title, wide, onClose, children } = props
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  return (
    <dialog
      ref={ref}
      className={`account-modal${wide ? ' account-modal-wide' : ''}`}
      onClose={onClose}
      onClick={(event) => event.target === ref.current && onClose()}
    >
      <div className="account-modal-content">
        <h2>{title}</h2>
        {children}
      </div>
    </dialog>
  )
}

function AuthModal(props: { mode: 'login' | 'register'; onDone: (session: Session) => void; onClose: () => void }) {
  const { onDone, onClose } = props
  const [mode, setMode] = useState(props.mode)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const registering = mode === 'register'
  const discordEnabled = useDiscordEnabled()
  const discord = useDiscord()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onDone(await api<Session>(`/api/auth/${mode}`, { method: 'POST', body: { username, password } }))
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal title={registering ? 'Register' : 'Log In'} onClose={onClose}>
      <form className="account-form" onSubmit={submit}>
        {discordEnabled && (
          <>
            <button className="button discord-button" type="button" disabled={discord.waiting} onClick={() => discord.start()}>
              {discordIcon}
              {discord.waiting ? 'Waiting for Discord…' : registering ? 'Sign up with Discord' : 'Continue with Discord'}
            </button>
            {discord.error && <p className="account-error">{discord.error}</p>}
            <p className="account-divider">or with a username</p>
          </>
        )}
        <input
          type="text"
          placeholder="Username"
          autoComplete="username"
          autoFocus
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
        <input
          type="password"
          placeholder="Password"
          autoComplete={registering ? 'new-password' : 'current-password'}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {registering && <p className="account-note">3-20 letters, numbers, - or _. Password 8 characters or more.</p>}
        {error && <p className="account-error">{error}</p>}
        <div className="account-buttons">
          <button className="button button-primary" type="submit" disabled={busy || !username || !password}>
            {registering ? 'Register' : 'Log In'}
          </button>
          <button className="button" type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
        <button className="account-switch" type="button" onClick={() => setMode(registering ? 'login' : 'register')}>
          {registering ? 'Already have an account? Log in' : 'No account yet? Register'}
        </button>
      </form>
    </Modal>
  )
}

function SettingsModal(props: {
  session: Session
  localCards: number
  onCopyLocal: () => Promise<string>
  onUser: (user: User) => void
  onLogOut: () => void
  onClose: () => void
}) {
  const { session, localCards, onCopyLocal, onUser, onLogOut, onClose } = props
  const [copying, setCopying] = useState<string | null>(null)
  const [used, setUsed] = useState<number | null>(null)
  const { user } = session
  const discordEnabled = useDiscordEnabled()
  const discord = useDiscord()
  const [unlinkError, setUnlinkError] = useState<string | null>(null)

  const unlink = async () => {
    setUnlinkError(null)
    try {
      const data = await api<{ user: User }>('/api/auth/discord', { method: 'DELETE', token: session.token })
      onUser(data.user)
    } catch (err) {
      setUnlinkError((err as Error).message)
    }
  }

  const readUsage = () =>
    api<{ user: User; usedBytes: number }>('/api/auth/me', { token: session.token })
      .then((data) => {
        setUsed(data.usedBytes)
        onUser(data.user)
      })
      .catch(() => setUsed(null))
  // Once, when it opens
  useEffect(() => {
    readUsage()
  }, [])

  const copy = async () => {
    setCopying('Copying…')
    setCopying(await onCopyLocal())
    readUsage()
  }

  const share = used !== null && user.quotaBytes ? Math.min(1, used / user.quotaBytes) : 0
  return (
    <Modal title="Settings" onClose={onClose}>
      <section className="account-section">
        <h3>Account</h3>
        <div className="account-row">
          <span>Username</span>
          <span>{user.username}</span>
        </div>
        {user.isAdmin && (
          <div className="account-row">
            <span>Role</span>
            <span>Admin</span>
          </div>
        )}
        <div className="account-row">
          <span>Member since</span>
          <span>{formatDate(user.createdAt)}</span>
        </div>
        {(discordEnabled || user.discordName) && (
          <div className="account-row">
            <span>Discord</span>
            {user.discordName ? (
              <span>
                {user.discordName}
                {user.hasPassword && (
                  <>
                    {' '}
                    <button className="account-switch" type="button" title="Sign in with the password only" onClick={unlink}>
                      Unlink
                    </button>
                  </>
                )}
              </span>
            ) : (
              <button className="button discord-button" type="button" disabled={discord.waiting} onClick={() => discord.start(session)}>
                {discordIcon}
                {discord.waiting ? 'Waiting…' : 'Link Discord'}
              </button>
            )}
          </div>
        )}
        {(discord.error || unlinkError) && <p className="account-error">{discord.error || unlinkError}</p>}
      </section>
      <section className="account-section">
        <h3>Storage</h3>
        <div className="account-row">
          <span>Used</span>
          <span>
            {used === null ? '…' : formatBytes(used)} of {user.quotaBytes === null ? 'unlimited' : formatBytes(user.quotaBytes)}
          </span>
        </div>
        {user.quotaBytes !== null && (
          <div className="account-meter" aria-hidden="true">
            <div style={{ width: `${share * 100}%` }} />
          </div>
        )}
        <p className="account-note">Signed in, your cards and their art are saved to your account.</p>
      </section>
      <section className="account-section">
        <h3>This browser</h3>
        <p className="account-note">
          {localCards
            ? `${localCards} card${localCards === 1 ? ' is' : 's are'} kept in this browser, from before you signed in. A copy can go to your account; a card already there with the same id is replaced.`
            : 'No cards are kept in this browser.'}
        </p>
        {localCards > 0 && (
          <div className="account-buttons">
            <button className="button" type="button" disabled={copying === 'Copying…'} onClick={copy}>
              Copy them to my account
            </button>
          </div>
        )}
        {copying && <p className="account-note">{copying}</p>}
      </section>
      <div className="account-buttons">
        <button className="button" type="button" onClick={onLogOut}>
          Log Out
        </button>
        <button className="button button-primary" type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  )
}

const MB = 1024 * 1024

function AdminModal(props: { session: Session; focus?: number; onClose: () => void }) {
  const { session, focus, onClose } = props
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The account asked for, scrolled to and marked once the list is in
  const focused = useRef<HTMLTableRowElement>(null)
  const loaded = !!users
  useEffect(() => {
    focused.current?.scrollIntoView({ block: 'center' })
  }, [loaded])

  useEffect(() => {
    api<{ users: AdminUser[] }>('/api/admin/users', { token: session.token })
      .then((data) => setUsers(data.users))
      .catch((err) => setError(err.message))
  }, [session.token])

  const change = async (user: AdminUser, body: { isAdmin?: boolean; quotaBytes?: number | null; canPublish?: boolean }) => {
    setError(null)
    try {
      const data = await api<{ user: User }>(`/api/admin/users/${user.id}`, { method: 'PATCH', body, token: session.token })
      setUsers((list) => list && list.map((other) => (other.id === user.id ? { ...other, ...data.user } : other)))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <Modal title="Admin" wide onClose={onClose}>
      {error && <p className="account-error">{error}</p>}
      {!users ? (
        !error && <p className="account-note">Loading…</p>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Admin</th>
                <th title="May make cards public">Public?</th>
                <th>Cards</th>
                <th>Storage</th>
                <th>Joined</th>
                <th>Last login</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} ref={user.id === focus ? focused : undefined} className={user.id === focus ? 'admin-focus' : undefined}>
                  <td>
                    {user.username}
                    {user.permanent && <span className="admin-badge">permanent</span>}
                    {user.discordName && <div className="admin-discord">Discord: {user.discordName}</div>}
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`${user.username} is an admin`}
                      checked={user.isAdmin}
                      disabled={user.permanent}
                      onChange={(event) => change(user, { isAdmin: event.target.checked })}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`${user.username} may make cards public`}
                      title="Off: their cards leave the Community tab, and they can't make others public"
                      checked={user.canPublish}
                      disabled={user.permanent}
                      onChange={(event) => change(user, { canPublish: event.target.checked })}
                    />
                  </td>
                  <td>{user.cardCount}</td>
                  <td>
                    {formatBytes(user.usedBytes)} of{' '}
                    {user.permanent ? (
                      'unlimited'
                    ) : (
                      <QuotaInput quota={user.quotaBytes} onChange={(quotaBytes) => change(user, { quotaBytes })} />
                    )}
                  </td>
                  <td>{formatDate(user.createdAt)}</td>
                  <td>{formatDate(user.lastLoginAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="account-buttons">
        <button className="button button-primary" type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  )
}

// A limit in MB, applied when the box is left; empty is no limit
function QuotaInput(props: { quota: number | null; onChange: (quota: number | null) => void }) {
  const { quota, onChange } = props
  const shown = quota === null ? '' : String(Math.round(quota / MB))
  const [text, setText] = useState(shown)
  useEffect(() => setText(shown), [shown])
  const apply = () => {
    const next = text.trim() === '' ? null : Math.round(Number(text) * MB)
    if (next !== null && !(Number.isFinite(next) && next >= 0)) return setText(shown)
    if (next !== quota) onChange(next)
  }
  return (
    <span className="quota-input">
      <input
        type="number"
        min="0"
        placeholder="∞"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={apply}
        onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
      />{' '}
      MB
    </span>
  )
}

// The account buttons in the top right corner, as on The Chrome Grid:
// Log In and Register, or the name (opening the settings) and, for admins, Admin
export function AccountBar(props: { localCards: number; onCopyLocal: () => Promise<string> }) {
  const session = useSession()
  const online = useServerOnline()
  const [open, setOpen] = useState<'login' | 'register' | 'settings' | 'admin' | null>(null)
  // The account the Admin panel opens at, when asked from elsewhere on the page
  const [focus, setFocus] = useState<number | undefined>()
  const isAdmin = !!session?.user.isAdmin
  useEffect(() => {
    if (!isAdmin) return
    onAdminRequest((userId) => {
      setFocus(userId)
      setOpen('admin')
    })
    return () => onAdminRequest(null)
  }, [isAdmin])

  // A token the server no longer takes (expired, or the account removed) signs out;
  // otherwise the account is read again, in case an admin changed it
  useEffect(() => {
    if (!online || !session) return
    api<{ user: User }>('/api/auth/me', { token: session.token })
      .then((data) => setSession({ ...session, user: data.user }))
      .catch((err) => err instanceof ApiError && err.status === 401 && setSession(null))
  }, [online, session?.token])

  const change = setSession
  const signedIn = !!session
  useEffect(() => {
    if (signedIn) setOpen((now) => (now === 'login' || now === 'register' ? null : now))
  }, [signedIn])

  if (!online) return null
  return (
    <div className="account-bar">
      {session ? (
        <>
          <button className="account-name" type="button" title="Open account settings" onClick={() => setOpen('settings')}>
            {session.user.username}
            <span className="account-gear" aria-hidden="true">
              ⚙
            </span>
          </button>
          {session.user.isAdmin && (
            <button
              className="chip"
              type="button"
              onClick={() => {
                setFocus(undefined)
                setOpen('admin')
              }}
            >
              Admin
            </button>
          )}
        </>
      ) : (
        <>
          <button className="chip" type="button" onClick={() => setOpen('login')}>
            Log In
          </button>
          <button className="chip" type="button" onClick={() => setOpen('register')}>
            Register
          </button>
        </>
      )}

      {(open === 'login' || open === 'register') && (
        <AuthModal
          mode={open}
          onDone={(next) => {
            change(next)
            setOpen(null)
          }}
          onClose={() => setOpen(null)}
        />
      )}
      {open === 'settings' && session && (
        <SettingsModal
          session={session}
          localCards={props.localCards}
          onCopyLocal={props.onCopyLocal}
          onUser={(user) => change({ ...session, user })}
          onLogOut={() => {
            change(null)
            setOpen(null)
          }}
          onClose={() => setOpen(null)}
        />
      )}
      {open === 'admin' && session && <AdminModal session={session} focus={focus} onClose={() => setOpen(null)} />}
    </div>
  )
}
