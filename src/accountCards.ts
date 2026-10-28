import { api, API_URL, type Session } from './api'
import { asset } from './asset'
import { readArtFile, type Art, type Card } from './cards'

// Cards on an account name their art as account:<SHA-256 of the image>. In the page the
// art is a data: URL, as for cards kept in the browser; it is uploaded when a card is saved.
const REF = 'account:'
const ART_KEYS = ['art', 'backArt'] as const

// The images already fetched or uploaded, kept in the browser: they never change, so
// opening the page again doesn't fetch them again. IndexedDB holds far more than localStorage.
const DB_NAME = 'dune-unlimited.images'

function openCache(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1)
      request.onupgradeneeded = () => request.result.createObjectStore('images')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

let cache: Promise<IDBDatabase | null> | undefined
const theCache = () => (cache ??= openCache())

async function cached(id: string): Promise<string | undefined> {
  const db = await theCache()
  if (!db) return undefined
  return new Promise((resolve) => {
    const request = db.transaction('images').objectStore('images').get(id)
    request.onsuccess = () => resolve(typeof request.result === 'string' ? request.result : undefined)
    request.onerror = () => resolve(undefined)
  })
}

async function keep(id: string, dataUrl: string) {
  const db = await theCache()
  if (!db) return
  await new Promise<void>((resolve) => {
    const transaction = db.transaction('images', 'readwrite')
    transaction.objectStore('images').put(dataUrl, id)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => resolve()
  })
}

const asDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })

async function sha256(blob: Blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

// Which image each data: URL in the page is, so saving a card again doesn't upload it again
const knownIds = new Map<string, string>()

// The art of a card from the account, as the page shows it
async function fetchArt(session: Session, id: string): Promise<string> {
  const kept = await cached(id)
  if (kept) {
    knownIds.set(kept, id)
    return kept
  }
  const res = await fetch(`${API_URL}/api/images/${id}`, { headers: { Authorization: `Bearer ${session.token}` } })
  if (!res.ok) throw new Error(`Art ${id} could not be fetched`)
  const dataUrl = await asDataUrl(await res.blob())
  knownIds.set(dataUrl, id)
  await keep(id, dataUrl)
  return dataUrl
}

async function mapArt(card: Card, change: (art: Art) => Promise<Art>): Promise<Card> {
  const next = { ...card }
  for (const key of ART_KEYS) {
    const art = card[key]
    if (art) next[key] = await change(art)
  }
  return next
}

// The account's cards, ready to show, and the storage it uses
// Which of the account's cards are public, and whether an admin hid them
export type Published = Record<string, { hidden: boolean }>

export async function loadAccountCards(session: Session): Promise<{ cards: Card[]; published: Published; usedBytes: number }> {
  const data = await api<{ cards: { data: Card; isPublic: boolean; hidden: boolean }[]; usedBytes: number }>('/api/cards', {
    token: session.token,
  })
  const published: Published = {}
  for (const { data: card, isPublic, hidden } of data.cards) if (isPublic) published[card.id] = { hidden }
  const cards = await Promise.all(
    data.cards.map(({ data: card }) =>
      mapArt(card, async (art) => {
        if (!art.src.startsWith(REF)) return art
        try {
          return { ...art, src: await fetchArt(session, art.src.slice(REF.length)) }
        } catch {
          // Shown without its art rather than not at all
          return art
        }
      }),
    ),
  )
  return { cards, published, usedBytes: data.usedBytes }
}

// Uploads one piece of art, if the account doesn't have it yet, and names it
async function uploadArt(session: Session, art: Art): Promise<Art> {
  const { src } = art
  if (src.startsWith(REF)) return art
  let dataUrl = src
  // Art picked from the public/art folder is shrunk as uploaded art is
  if (!src.startsWith('data:')) {
    const res = await fetch(asset(src))
    if (!res.ok) throw new Error(`The art ${src} could not be read`)
    dataUrl = await readArtFile(new File([await res.blob()], src.split('/').pop() ?? 'art'))
  }
  let id = knownIds.get(dataUrl)
  if (!id) {
    const blob = await (await fetch(dataUrl)).blob()
    id = await sha256(blob)
    await api('/api/images', { method: 'POST', raw: blob, token: session.token })
    knownIds.set(dataUrl, id)
    await keep(id, dataUrl)
  }
  return { ...art, src: REF + id }
}

// Saves what changed between two lists of the account's cards: the cards added or
// changed, with their art, and the cards removed
export async function syncAccountCards(session: Session, before: Card[], after: Card[]) {
  const was = new Map(before.map((card) => [card.id, card]))
  const now = new Set(after.map((card) => card.id))
  for (const card of after) {
    if (was.get(card.id) === card) continue
    const stored = await mapArt(card, (art) => uploadArt(session, art))
    await api(`/api/cards/${encodeURIComponent(card.id)}`, { method: 'PUT', body: { data: stored }, token: session.token })
  }
  for (const card of before) {
    if (now.has(card.id)) continue
    await api(`/api/cards/${encodeURIComponent(card.id)}`, { method: 'DELETE', token: session.token })
  }
}

// Makes a saved card public, or shows its latest version: the JPG of each side, and
// the entry the Community tab searches and filters by
export async function publishCard(session: Session, id: string, entry: unknown, sides: Blob[]) {
  const [image, backImage] = await Promise.all(
    sides.map(async (blob) => (await api<{ id: string }>('/api/images', { method: 'POST', raw: blob, token: session.token })).id),
  )
  return api<{ hidden: boolean }>(`/api/cards/${encodeURIComponent(id)}/public`, {
    method: 'PUT',
    body: { entry, image, backImage },
    token: session.token,
  })
}

export const unpublishCard = (session: Session, id: string) =>
  api(`/api/cards/${encodeURIComponent(id)}/public`, { method: 'DELETE', token: session.token })
