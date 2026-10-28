import { useEffect, useState, useSyncExternalStore } from 'react'

// The accounts server: VITE_API_URL when built, the one `npm run local` starts otherwise
export const API_URL = (import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:3001' : '')).replace(/\/$/, '')
const SESSION_KEY = 'dune-unlimited.account'

export type User = {
  id: number
  username: string
  isAdmin: boolean
  // null: no limit
  quotaBytes: number | null
  // May make cards public; an admin can turn it off
  canPublish: boolean
  // The Discord account it signs in with; null when none is linked
  discordName: string | null
  // Discord can only be unlinked from an account that also has a password
  hasPassword: boolean
  createdAt: string
}
export type Session = { token: string; user: User }

export class ApiError extends Error {
  status: number
  // The account's storage is full
  quota: boolean
  constructor(message: string, status: number, quota = false) {
    super(message)
    this.status = status
    this.quota = quota
  }
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; token?: string; raw?: Blob } = {},
): Promise<T> {
  let res: Response
  try {
    res = await fetch(API_URL + path, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body !== undefined && { 'Content-Type': 'application/json' }),
        ...(options.raw && { 'Content-Type': options.raw.type || 'application/octet-stream' }),
        ...(options.token && { Authorization: `Bearer ${options.token}` }),
      },
      body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    })
  } catch {
    throw new ApiError('The server can’t be reached. Try again in a moment.', 0)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(data.error ?? `Server error (${res.status})`, res.status, !!data.quota)
  return data
}

// The account signed in, shared by every part of the page that needs it
function loadSession(): Session | null {
  try {
    const session = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null')
    return session?.token && session.user ? session : null
  } catch {
    return null
  }
}

let session = loadSession()
const sessionListeners = new Set<() => void>()

export const getSession = () => session

export function setSession(next: Session | null) {
  try {
    if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next))
    else localStorage.removeItem(SESSION_KEY)
  } catch {
    // Signed in for this visit only, then
  }
  session = next
  sessionListeners.forEach((listener) => listener())
}

const subscribeSession = (listener: () => void) => {
  sessionListeners.add(listener)
  return () => sessionListeners.delete(listener)
}

export const useSession = () => useSyncExternalStore(subscribeSession, getSession)

// Signing in or out in another tab (or the Discord window) does it here too
if (typeof window !== 'undefined')
  window.addEventListener('storage', (event) => {
    if (event.key !== SESSION_KEY) return
    session = loadSession()
    sessionListeners.forEach((listener) => listener())
  })

// Whether the server answers, asked once per visit. A site without one looks as it always did.
let online: boolean | null = null
const onlineListeners = new Set<() => void>()

const subscribeOnline = (listener: () => void) => {
  onlineListeners.add(listener)
  if (online === null && API_URL) {
    online = false
    api('/api/health')
      .then(() => {
        online = true
        onlineListeners.forEach((each) => each())
      })
      .catch(() => {})
  }
  return () => onlineListeners.delete(listener)
}

export const useServerOnline = () => useSyncExternalStore(subscribeOnline, () => !!online)

// Asks the account bar to open the Admin panel, at one account if given
let adminRequest: ((userId?: number) => void) | null = null
export const onAdminRequest = (listener: ((userId?: number) => void) | null) => {
  adminRequest = listener
}
export const openAdminPanel = (userId?: number) => adminRequest?.(userId)

// ── Discord ──
// Whether the server has Discord sign-in set up, asked once
let discordEnabled: Promise<boolean> | null = null
export function useDiscordEnabled() {
  const online = useServerOnline()
  const [enabled, setEnabled] = useState(false)
  useEffect(() => {
    if (!online) return
    discordEnabled ??= api<{ enabled: boolean }>('/api/auth/discord/status')
      .then((data) => data.enabled)
      .catch(() => false)
    discordEnabled.then(setEnabled)
  }, [online])
  return enabled
}

// What came of the last Discord window, for whichever window of ours is open
const discordListeners = new Set<(error: string | null) => void>()
export function onDiscordDone(listener: (error: string | null) => void) {
  discordListeners.add(listener)
  return () => {
    discordListeners.delete(listener)
  }
}

async function signInWithToken(token: string) {
  try {
    const { user } = await api<{ user: User }>('/api/auth/me', { token })
    setSession({ token, user })
    discordListeners.forEach((listener) => listener(null))
  } catch (err) {
    discordListeners.forEach((listener) => listener((err as Error).message))
  }
}

// Opens Discord's page in a small window: to sign in, or with a session, to link
// Discord to that account. The window hands the result back by a message.
export async function startDiscord(link?: Session): Promise<Window | null> {
  // Opened at once, on the click, so the browser doesn't block it
  const popup = window.open('', 'swu-discord', 'width=520,height=760')
  try {
    const { url } = await api<{ url: string }>('/api/auth/discord/url', {
      method: 'POST',
      body: { link: !!link, returnTo: window.location.href },
      token: link?.token,
    })
    if (popup) popup.location.href = url
    else window.location.href = url
    return popup
  } catch (err) {
    popup?.close()
    throw err
  }
}

if (API_URL && typeof window !== 'undefined') {
  const serverOrigin = new URL(API_URL, window.location.href).origin
  window.addEventListener('message', (event) => {
    if (event.origin !== serverOrigin || event.data?.type !== 'swu-discord') return
    if (event.data.token) signInWithToken(event.data.token)
    else discordListeners.forEach((listener) => listener(event.data.error ?? 'Discord sign-in failed'))
  })
  // Back from Discord in this tab, when the window couldn't reach the one that opened it
  const back = window.location.hash.match(/^#discord=(.+)$/)
  if (back || window.location.hash === '#discord-error=1') {
    history.replaceState(null, '', window.location.pathname + window.location.search)
    if (back) signInWithToken(back[1])
  }
}

// The session to save cards to: signed in, with the server there
export function useAccount() {
  const current = useSession()
  return useServerOnline() && current ? current : null
}
