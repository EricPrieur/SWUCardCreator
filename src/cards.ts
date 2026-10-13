// Card art and how it is placed behind the frame
export type Art = {
  // A file under public/, or an uploaded image stored as a data URL
  src: string
  // 1 fills the card; x and y shift the art, in percent of the card's size
  zoom: number
  x: number
  y: number
}

// How see-through the frame is, and what keeps the text readable over the art.
// Every setting runs from 0 to 1.
export type Look = {
  // 1 is a solid frame; lower lets the art show through it
  frameOpacity: number
  // A flat backing behind the text panels
  panelFill: number
  // Blurs the art behind the text panels, like frosted glass
  panelBlur: number
  // A soft glow around the letters, in the opposite tone to the text
  textGlow: number
  lightText: boolean
}

export const defaultLook: Look = { frameOpacity: 1, panelFill: 0, panelBlur: 0, textGlow: 0, lightText: false }

export type Card = {
  id: string
  frameId: string
  name: string
  trait: string
  text: string
  // Units only: prints the unique star before the name
  unique?: boolean
  // Unique units only: the line under the name
  subtitle?: string
  // 0 to 15 each, on frames that have the matching icon
  cost?: number
  power?: number
  hp?: number
  art?: Art
  look?: Look
}

// Saved cards live in this browser only, until the site has a shared store.
const STORAGE_KEY = 'dune-unlimited.cards'

export function loadCards(): Card[] {
  try {
    const cards = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(cards)) return []
    // Cards saved before the other look settings existed only had a frame opacity
    return cards.map(({ frameOpacity, ...card }) =>
      frameOpacity === undefined ? card : { ...card, look: { ...defaultLook, frameOpacity } },
    )
  } catch {
    return []
  }
}

// False when the browser refuses, which happens once its storage quota is full
export function storeCards(cards: Card[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cards))
    return true
  } catch {
    return false
  }
}

const MAX_ART_SIDE = 1400

// Uploaded art is shrunk and re-encoded so several cards fit in browser storage
export async function readArtFile(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_ART_SIDE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return canvas.toDataURL('image/webp', 0.85)
}
