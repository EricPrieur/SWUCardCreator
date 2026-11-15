import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  api,
  API_URL,
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
import { CardsTab, DecksTab, defaultFilter, FilterBar, GamesTab, StatsTab, type GameFilter } from './AdminGames'
import { CommunityTab, useAdminPending, type AdminPending } from './AdminCommunity'
import { MailTab, NotificationsTab, useUnread, type Unread } from './Messages'
import { KofiHover, SupporterMark } from './Support'
import { isSupporter, STEP_CENTS, TIER_NAMES, tierOf } from '../server/tiers.ts'

type AdminUser = User & {
  lastLoginAt: string | null
  usedBytes: number
  cardCount: number
  gameCount: number
  lastGameAt: string | null
  permanent: boolean
}

export function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  const mb = bytes / (1024 * 1024)
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

const formatDate = (date: string | null) => (date ? new Date(date).toLocaleDateString() : '—')

// The project's Discord server, as The Chrome Grid has its own
const DISCORD_INVITE = 'https://discord.gg/5aMudhGRW5'

// Support for the project, as on The Chrome Grid
const KOFI = 'https://ko-fi.com/ericprieur'

const kofiIcon = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
    <path d="M2 4h13a4 4 0 0 1 4 4v.5h.5A3.5 3.5 0 0 1 23 12v.5a4.5 4.5 0 0 1-4.5 4.5h-.61A6 6 0 0 1 12 21H8a6 6 0 0 1-6-6V4Zm17 11h-.5a4 4 0 0 0 .5-2v-3.5h.5a2 2 0 0 1 2 2V12a3 3 0 0 1-2.5 3ZM7.5 8.25a2 2 0 0 1 1.62.82A2 2 0 0 1 12.5 8.5a2.25 2.25 0 0 1 0 4.5L9.12 16.35l-3.37-3.35a2.25 2.25 0 0 1 1.75-4.75Z" />
  </svg>
)

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
export function Modal(props: { title: string; wide?: boolean; onClose: () => void; children: ReactNode }) {
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

// The account's window: its Settings, its Notifications and its Mail, each tab with its unread
type AccountTab = 'settings' | 'notification' | 'mail'
function AccountModal(props: {
  session: Session
  tab: AccountTab
  unread: Unread
  onUnreadChange: () => void
  localCards: number
  localDecks: number
  onCopyLocal: () => Promise<string>
  onUser: (user: User) => void
  onLogOut: () => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<AccountTab>(props.tab)
  const { session, unread, onUnreadChange, onClose } = props
  const tabs: [AccountTab, string, number][] = [
    ['settings', 'Settings', 0],
    ['notification', 'Notifications', unread.notification],
    ['mail', 'Mail', unread.mail],
  ]
  const nav = (
    <nav className="tabs admin-tabs account-tabs">
      {tabs.map(([value, label, count]) => (
        <a
          key={value}
          href="#"
          aria-current={tab === value ? 'page' : undefined}
          onClick={(event) => {
            event.preventDefault()
            setTab(value)
          }}
        >
          {label}
          {count > 0 && <span className="tab-count">{count > 99 ? '99+' : count}</span>}
        </a>
      ))}
    </nav>
  )
  if (tab === 'settings') return <SettingsModal {...props} nav={nav} />
  return (
    <Modal title="Account" onClose={onClose}>
      {nav}
      {tab === 'notification' ? (
        <NotificationsTab session={session} onChange={onUnreadChange} onGo={onClose} />
      ) : (
        <MailTab session={session} onChange={onUnreadChange} />
      )}
      <div className="account-buttons">
        <button className="button button-primary" type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  )
}

function SettingsModal(props: {
  nav: ReactNode
  session: Session
  localCards: number
  localDecks: number
  onCopyLocal: () => Promise<string>
  onUser: (user: User) => void
  onLogOut: () => void
  onClose: () => void
}) {
  const { session, localCards, localDecks, onCopyLocal, onUser, onLogOut, onClose } = props
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
    <Modal title="Account" onClose={onClose}>
      {props.nav}
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
      <SupportSection session={session} onUser={onUser} />
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
        <p className="account-note">Signed in, your cards, their art and your decks are saved to your account.</p>
      </section>
      <section className="account-section">
        <h3>This browser</h3>
        <p className="account-note">
          {localCards || localDecks
            ? `${[
                localCards && `${localCards} card${localCards === 1 ? '' : 's'}`,
                localDecks && `${localDecks} deck${localDecks === 1 ? '' : 's'}`,
              ]
                .filter(Boolean)
                .join(' and ')} kept in this browser, from before you signed in. A copy can go to your account; one already there with the same id is replaced.`
            : 'No cards or decks are kept in this browser.'}
        </p>
        {(localCards > 0 || localDecks > 0) && (
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

// A card back, as the Simulator draws it: made 600 x 840 (a card's shape) as a JPEG
async function cardBackImage(file: File) {
  const bitmap = await createImageBitmap(file)
  const canvas = document.createElement('canvas')
  canvas.width = 600
  canvas.height = 840
  const context = canvas.getContext('2d')!
  // Covering the card, cut to its shape
  const scale = Math.max(canvas.width / bitmap.width, canvas.height / bitmap.height)
  const width = bitmap.width * scale
  const height = bitmap.height * scale
  context.drawImage(bitmap, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height)
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not read the image'))), 'image/jpeg', 0.9))
}

// The account's tier and its perks (see #support), and a Supporter's card back
function SupportSection(props: { session: Session; onUser: (user: User) => void }) {
  const { session, onUser } = props
  const { user } = session
  const tier = user.tier ?? tierOf(user)
  const supporter = isSupporter(user)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const setBack = async (image: string | null) => {
    const data = await api<{ user: User }>('/api/auth/me/card-back', { method: 'PUT', body: { image }, token: session.token })
    onUser(data.user)
  }
  const upload = async (file: File) => {
    setBusy(true)
    setError(null)
    try {
      const blob = await cardBackImage(file)
      const res = await fetch(`${API_URL}/api/images`, { method: 'POST', headers: { Authorization: `Bearer ${session.token}` }, body: blob })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error ?? 'Could not upload the image')
      await setBack(data.id)
    } catch (err) {
      setError((err as Error).message)
    }
    setBusy(false)
  }
  const dollars = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`
  return (
    <section className="account-section">
      <h3>Support</h3>
      <div className="account-row">
        <span>Tier</span>
        <span>
          {TIER_NAMES[tier]}{' '}
          <a className="account-switch" href="#support">
            See the tiers
          </a>
        </span>
      </div>
      {(user.donatedCents ?? 0) > 0 && (
        <div className="account-row">
          <span>Tips</span>
          <span>{dollars(user.donatedCents ?? 0)}, thank you!</span>
        </div>
      )}
      {!supporter && (
        <p className="account-note">
          A {dollars(STEP_CENTS)} tip on Ko-fi, with your username in its message, makes you a Supporter: 50 MB more storage for each{' '}
          {dollars(STEP_CENTS)}, the Deck Builder's Prescient and Foil copies, and a card back of your own.
        </p>
      )}
      {supporter && (
        <div className="account-row card-back-row">
          <span>Card back</span>
          <span className="card-back-pick">
            {user.cardBack && <img className="card-back-preview" src={`${API_URL}/api/public/images/${user.cardBack}`} alt="Your card back" />}
            <label className="button">
              {busy ? 'Uploading…' : user.cardBack ? 'Change' : 'Upload'}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                hidden
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file) upload(file)
                }}
              />
            </label>
            {user.cardBack && (
              <button className="account-switch" type="button" disabled={busy} onClick={() => setBack(null).catch((err) => setError(err.message))}>
                Use the set's
              </button>
            )}
          </span>
        </div>
      )}
      {supporter && <p className="account-note">Your card back shows on your deck, resources and hand in the Simulator, to both players.</p>}
      {error && <p className="account-error">{error}</p>}
    </section>
  )
}

const ADMIN_TABS = [
  ['users', 'Users'],
  ['stats', 'Stats'],
  ['games', 'Games'],
  ['decks', 'Decks'],
  ['cards', 'Cards'],
  ['community', 'Community'],
] as const
type AdminTab = (typeof ADMIN_TABS)[number][0]

function AdminModal(props: { session: Session; focus?: number; pending: AdminPending; onPendingChange: () => void; onClose: () => void }) {
  const { session, focus, pending, onClose } = props
  const [tab, setTab] = useState<AdminTab>('users')
  const [filter, setFilter] = useState<GameFilter>(defaultFilter)
  return (
    <Modal title="Admin" wide onClose={onClose}>
      <nav className="tabs admin-tabs">
        {ADMIN_TABS.map(([value, label]) => (
          <a
            key={value}
            href="#"
            aria-current={tab === value ? 'page' : undefined}
            onClick={(event) => {
              event.preventDefault()
              setTab(value)
            }}
          >
            {label}
            {value === 'community' && pending.community > 0 && <span className="tab-count">{pending.community}</span>}
          </a>
        ))}
      </nav>
      {tab !== 'users' && tab !== 'community' && <FilterBar filter={filter} onChange={setFilter} />}
      {tab === 'users' && <UsersTab session={session} focus={focus} />}
      {tab === 'stats' && <StatsTab session={session} filter={filter} />}
      {tab === 'games' && <GamesTab session={session} filter={filter} />}
      {tab === 'decks' && <DecksTab session={session} filter={filter} />}
      {tab === 'cards' && <CardsTab session={session} filter={filter} />}
      {tab === 'community' && <CommunityTab session={session} onReviewed={props.onPendingChange} />}
      <div className="account-buttons">
        <button className="button button-primary" type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  )
}

function UsersTab(props: { session: Session; focus?: number }) {
  const { session, focus } = props
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

  const change = async (
    user: AdminUser,
    body: { isAdmin?: boolean; isTester?: boolean; quotaBytes?: number | null; canPublish?: boolean; donatedCents?: number },
  ) => {
    setError(null)
    try {
      const data = await api<{ user: User }>(`/api/admin/users/${user.id}`, { method: 'PATCH', body, token: session.token })
      setUsers((list) => list && list.map((other) => (other.id === user.id ? { ...other, ...data.user } : other)))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <>
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
                <th title="Games played in the Simulator">Games</th>
                <th>Storage</th>
                <th title="Tips given on Ko-fi, in dollars: $5 makes a Supporter, and each $5 adds 50 MB of storage">Tips</th>
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
                  <td title={user.lastGameAt ? `Last game ${formatDate(user.lastGameAt)}` : undefined}>{user.gameCount}</td>
                  <td>
                    {formatBytes(user.usedBytes)} of{' '}
                    {user.permanent ? (
                      'unlimited'
                    ) : (
                      <QuotaInput quota={user.quotaBytes} onChange={(quotaBytes) => change(user, { quotaBytes })} />
                    )}
                  </td>
                  <td>
                    <DonationInput cents={user.donatedCents ?? 0} onChange={(donatedCents) => change(user, { donatedCents })} />
                    <div className="admin-tier">{TIER_NAMES[tierOf({ isAdmin: user.isAdmin, donatedCents: user.donatedCents })]}</div>
                  </td>
                  <td>{formatDate(user.createdAt)}</td>
                  <td>{formatDate(user.lastLoginAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

// A limit in MB, applied when the box is left; empty is no limit
// The tips an account gave, in dollars: set, they make its tier and its storage
function DonationInput(props: { cents: number; onChange: (cents: number) => void }) {
  const { cents, onChange } = props
  const shown = cents ? String(cents / 100) : ''
  const [text, setText] = useState(shown)
  useEffect(() => setText(shown), [shown])
  const apply = () => {
    const next = text.trim() === '' ? 0 : Math.round(Number(text) * 100)
    if (!(Number.isFinite(next) && next >= 0)) return setText(shown)
    if (next !== cents) onChange(next)
  }
  return (
    <span className="quota-input">
      ${' '}
      <input
        type="number"
        min="0"
        step="5"
        placeholder="0"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={apply}
        onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
      />
    </span>
  )
}

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
export function AccountBar(props: { localCards: number; localDecks: number; onCopyLocal: () => Promise<string> }) {
  const session = useSession()
  const online = useServerOnline()
  const [open, setOpen] = useState<'login' | 'register' | 'settings' | 'notification' | 'mail' | 'admin' | null>(null)
  const { unread, refresh } = useUnread(session, online)
  const unreadTotal = unread.notification + unread.mail
  // An admin's count on Admin: community cards to review, mail to the Admins unread
  const { pending, refresh: refreshPending } = useAdminPending(session)
  const pendingTotal = pending.community + pending.mail
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

  return (
    <div className="account-bar">
      {online && (
        <div className="account-bar-row">
          {session ? (
            <>
              <button
                className="account-name"
                type="button"
                title={
                  unreadTotal
                    ? `${[unread.notification && `${unread.notification} notification${unread.notification === 1 ? '' : 's'}`, unread.mail && `${unread.mail} mail`].filter(Boolean).join(' and ')} unread`
                    : 'Open your account: settings, notifications and mail'
                }
                // Straight to what is unread, notifications first
                onClick={() => setOpen(unread.notification ? 'notification' : unread.mail ? 'mail' : 'settings')}
              >
                {session.user.username}
                <SupporterMark on={(session.user.donatedCents ?? 0) >= STEP_CENTS} />
                {unreadTotal > 0 ? (
                  <span className="tab-count">{unreadTotal > 99 ? '99+' : unreadTotal}</span>
                ) : (
                  <span className="account-gear" aria-hidden="true">
                    ⚙
                  </span>
                )}
              </button>
              {session.user.isAdmin && (
                <button
                  className="chip"
                  type="button"
                  title={
                    pendingTotal
                      ? [pending.community && `${pending.community} community card${pending.community === 1 ? '' : 's'} to review`, pending.mail && `${pending.mail} mail to the Admins unread`]
                          .filter(Boolean)
                          .join(', ')
                      : 'Open the Admin panel'
                  }
                  onClick={() => {
                    setFocus(undefined)
                    setOpen('admin')
                  }}
                >
                  Admin
                  {pendingTotal > 0 && <span className="tab-count">{pendingTotal > 99 ? '99+' : pendingTotal}</span>}
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
        </div>
      )}
      <a className="discord-join" href={DISCORD_INVITE} target="_blank" rel="noopener noreferrer">
        {discordIcon}
        Join the Discord for feedback
      </a>
      <span className="kofi-wrap">
        <a className="kofi-link" href={KOFI} target="_blank" rel="noopener noreferrer">
          {kofiIcon}
          Support on Ko-fi
        </a>
        <KofiHover />
      </span>

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
      {(open === 'settings' || open === 'notification' || open === 'mail') && session && (
        <AccountModal
          tab={open}
          unread={unread}
          onUnreadChange={refresh}
          session={session}
          localCards={props.localCards}
          localDecks={props.localDecks}
          onCopyLocal={props.onCopyLocal}
          onUser={(user) => change({ ...session, user })}
          onLogOut={() => {
            change(null)
            setOpen(null)
          }}
          onClose={() => {
            setOpen(null)
            refreshPending()
          }}
        />
      )}
      {open === 'admin' && session && (
        <AdminModal
          session={session}
          focus={focus}
          pending={pending}
          onPendingChange={refreshPending}
          onClose={() => {
            setOpen(null)
            refreshPending()
          }}
        />
      )}
    </div>
  )
}
