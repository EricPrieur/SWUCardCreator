import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'

// The accounts server: VITE_API_URL when built, the one `npm run local` starts otherwise
const API_URL = (import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:3001' : '')).replace(/\/$/, '')
const SESSION_KEY = 'dune-unlimited.account'

export type User = {
  id: number
  username: string
  isAdmin: boolean
  // null: no limit
  quotaBytes: number | null
  createdAt: string
}
type Session = { token: string; user: User }
type AdminUser = User & { lastLoginAt: string | null; usedBytes: number; permanent: boolean }

function loadSession(): Session | null {
  try {
    const session = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null')
    return session?.token && session.user ? session : null
  } catch {
    return null
  }
}

function storeSession(session: Session | null) {
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session))
    else localStorage.removeItem(SESSION_KEY)
  } catch {
    // Signed in for this visit only, then
  }
}

class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function api<T>(path: string, options: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(API_URL + path, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body !== undefined && { 'Content-Type': 'application/json' }),
        ...(options.token && { Authorization: `Bearer ${options.token}` }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
  } catch {
    throw new ApiError('The server can’t be reached. Try again in a moment.', 0)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(data.error ?? `Server error (${res.status})`, res.status)
  return data
}

export function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  const mb = bytes / (1024 * 1024)
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

const formatDate = (date: string | null) => (date ? new Date(date).toLocaleDateString() : '—')

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

function SettingsModal(props: { session: Session; onUser: (user: User) => void; onLogOut: () => void; onClose: () => void }) {
  const { session, onUser, onLogOut, onClose } = props
  const [used, setUsed] = useState<number | null>(null)
  const { user } = session

  useEffect(() => {
    api<{ user: User; usedBytes: number }>('/api/auth/me', { token: session.token })
      .then((data) => {
        setUsed(data.usedBytes)
        onUser(data.user)
      })
      .catch(() => setUsed(null))
    // Once, when it opens
  }, [])

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
        <p className="account-note">Cards are still kept in this browser. Saving them to your account comes next.</p>
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

function AdminModal(props: { session: Session; onClose: () => void }) {
  const { session, onClose } = props
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api<{ users: AdminUser[] }>('/api/admin/users', { token: session.token })
      .then((data) => setUsers(data.users))
      .catch((err) => setError(err.message))
  }, [session.token])

  const change = async (user: AdminUser, body: { isAdmin?: boolean; quotaBytes?: number | null }) => {
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
                <th>Storage</th>
                <th>Joined</th>
                <th>Last login</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>
                    {user.username}
                    {user.permanent && <span className="admin-badge">permanent</span>}
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
export function AccountBar() {
  const [session, setSession] = useState<Session | null>(loadSession)
  const [open, setOpen] = useState<'login' | 'register' | 'settings' | 'admin' | null>(null)
  // Hidden until the server answers, so a site without one looks as it always did
  const [online, setOnline] = useState(false)

  useEffect(() => {
    if (!API_URL) return
    api('/api/health')
      .then(() => setOnline(true))
      .catch(() => setOnline(false))
  }, [])

  // A token the server no longer takes (expired, or the account removed) signs out
  useEffect(() => {
    if (!online || !session) return
    api<{ user: User }>('/api/auth/me', { token: session.token })
      .then((data) => change({ ...session, user: data.user }))
      .catch((err) => err instanceof ApiError && err.status === 401 && change(null))
    // Once the server is known to be there
  }, [online])

  const change = (next: Session | null) => {
    storeSession(next)
    setSession(next)
  }

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
            <button className="chip" type="button" onClick={() => setOpen('admin')}>
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
          onUser={(user) => change({ ...session, user })}
          onLogOut={() => {
            change(null)
            setOpen(null)
          }}
          onClose={() => setOpen(null)}
        />
      )}
      {open === 'admin' && session && <AdminModal session={session} onClose={() => setOpen(null)} />}
    </div>
  )
}
