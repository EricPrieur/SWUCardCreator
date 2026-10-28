import { useSyncExternalStore } from 'react'

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

// The session to save cards to: signed in, with the server there
export function useAccount() {
  const current = useSession()
  return useServerOnline() && current ? current : null
}
