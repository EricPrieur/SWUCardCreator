import { frames } from './frames'

// Card art and how it is placed behind the frame
export type Art = {
  // A file under public/, or an uploaded image stored as a data URL
  src: string
  // 1 fills the card; x and y shift the art, in percent of the card's size
  zoom: number
  x: number
  y: number
  // Degrees clockwise; left out, the art is upright
  rotate?: number
  // Where the art does not reach the card's edge, continue it to fill the gap. On unless false.
  fill?: boolean
}

// How see-through the frame is, and what keeps the text readable over the art.
// Every setting runs from 0 to 1.
export type Look = {
  // 1 is a solid frame; lower lets the art show through it
  frameOpacity: number
  // Which parts of the frame that applies to: the top, down to the power and HP
  // icons, and the rest below. Both, unless turned off.
  fadeTop?: boolean
  fadeBottom?: boolean
  // Leave solid, whatever the rest does: the text boxes (game text, name, subtitle),
  // and the icons (cost, aspects, power, HP). The letters themselves never fade.
  solidText?: boolean
  solidIcons?: boolean
  // A flat backing behind the text panels
  panelFill: number
  // Blurs the art behind the text panels, like frosted glass
  panelBlur: number
  // A soft glow around the letters, in the opposite tone to the text
  textGlow: number
  lightText: boolean
}

export const defaultLook: Look = { frameOpacity: 1, panelFill: 0, panelBlur: 0, textGlow: 0, lightText: false }

// The line along the bottom of a card: who drew it, and where it belongs. It shows
// as soon as any of it is filled in.
export type CardLine = {
  artist?: string
  // The rotation block, a letter in a small box
  block?: string
  setCode?: string
  language?: string
  // C, U, R, S or L
  rarity?: string
  number?: string
}
export const cardLineKeys = ['artist', 'block', 'setCode', 'language', 'rarity', 'number'] as const

// What was last typed in the card line, but the card's number, to start the next card with
const LINE_KEY = 'dune-unlimited.card-line'

export function loadCardLine(): CardLine {
  try {
    const line = JSON.parse(localStorage.getItem(LINE_KEY) ?? '{}')
    return typeof line === 'object' && line ? line : {}
  } catch {
    return {}
  }
}

export function storeCardLine(card: CardLine) {
  const { number: _number, ...line } = Object.fromEntries(cardLineKeys.map((key) => [key, card[key]])) as CardLine
  try {
    localStorage.setItem(LINE_KEY, JSON.stringify(line))
  } catch {
    // Not kept, then
  }
}

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
  // Leader side only: the Epic Action box's text, when it is not the usual one
  epic?: string
  // Pilots only: the text of the Piloting box, and the power and HP the card gives
  // the unit it is attached to. pilotCost is how the Piloting cost was once kept.
  pilotCost?: number
  pilotText?: string
  upgradePower?: number
  upgradeHp?: number
} & CardLine & {
  // A leader's other side, the Leader Unit. It has its own game text, and its own
  // art or placing of the art. Its name, subtitle and trait are the Leader side's
  // unless given here: Grand Moff Tarkin deploys as The Death Star, a Space unit.
  backText?: string
  backArt?: Art
  backName?: string
  backSubtitle?: string
  backTrait?: string
  // The Leader Unit side's frame, when it is not the Ground one matching the Leader side
  backFrameId?: string
  // How a Space Leader Unit was first recorded; backFrameId has replaced it
  backArena?: 'Ground' | 'Space'
  // 0 to 15 each, on frames that have the matching icon
  cost?: number
  power?: number
  hp?: number
  art?: Art
  look?: Look
}

// Leader Unit sides were once cards of their own. Such a card becomes a leader
// with that side as its back, and the same art, not yet placed, on its front.
function withBothSides<T extends { frameId: string; text: string; art?: Art }>(card: T) {
  const front = /^(leader-.+)-unit$/.exec(card.frameId)?.[1]
  if (!front) return card
  return {
    ...card,
    frameId: front,
    text: '',
    art: card.art && { src: card.art.src, zoom: 1, x: 0, y: 0 },
    backText: card.text,
    backArt: card.art,
  }
}

// The art in public/art is kept as JPG. A card saved while it was PNG names the
// PNG: it gets the JPG of the same name instead.
const asJpg = (art?: Art) =>
  art && /^\/art\/.+\.(png|webp|jpeg)$/i.test(art.src) ? { ...art, src: art.src.replace(/\.\w+$/, '.jpg') } : art

function withCurrentArt<T extends { art?: Art; backArt?: Art }>(card: T): T {
  return { ...card, art: asJpg(card.art), backArt: asJpg(card.backArt) }
}

// Pilots once had their Piloting cost as a number, the line printed from it and the
// card's aspects. That line is now typed with the Piloting text: it is written there.
function withPilotingLine<T extends { frameId: string; pilotCost?: number; pilotText?: string }>(card: T): T {
  if (card.pilotCost === undefined) return card
  const { pilotCost, ...rest } = card
  const icons = frames.find((frame) => frame.id === card.frameId)?.aspects ?? []
  const line = `[Piloting] [[${[pilotCost, ...icons].join(' ')}]]`
  return { ...rest, pilotText: card.pilotText ? `${line}\n${card.pilotText}` : line } as T
}

// Saved cards live in this browser only, until the site has a shared store.
const STORAGE_KEY = 'dune-unlimited.cards'

export function loadCards(): Card[] {
  try {
    const cards = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(cards)) return []
    // Cards saved before the other look settings existed only had a frame opacity
    return cards
      .map(({ frameOpacity, ...card }) =>
        frameOpacity === undefined ? card : { ...card, look: { ...defaultLook, frameOpacity } },
      )
      .map(withBothSides)
      .map(withCurrentArt)
      .map(withPilotingLine)
  } catch {
    return []
  }
}

// The card in the editor is kept as it is typed, so a reload does not lose it
const DRAFT_KEY = 'dune-unlimited.draft'
export type Draft = Omit<Card, 'id'> & { id?: string }

export function loadDraft(): Draft | undefined {
  try {
    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null')
    return draft && typeof draft.frameId === 'string' ? withPilotingLine(withCurrentArt(withBothSides(draft))) : undefined
  } catch {
    return undefined
  }
}

export function storeDraft(draft: Draft) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
  } catch {
    // Out of storage: the draft just is not kept
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

// An image file as something a canvas can draw. Some browsers cannot read every
// kind of photo this way (Safari and iPhone photos, at times): they get the slower route.
async function decodeImage(file: File): Promise<{ image: CanvasImageSource; width: number; height: number }> {
  try {
    const bitmap = await createImageBitmap(file)
    return { image: bitmap, width: bitmap.width, height: bitmap.height }
  } catch {
    const image = new Image()
    image.src = URL.createObjectURL(file)
    try {
      await image.decode()
      return { image, width: image.naturalWidth, height: image.naturalHeight }
    } finally {
      URL.revokeObjectURL(image.src)
    }
  }
}

// Uploaded art is shrunk and re-encoded so several cards fit in browser storage
export async function readArtFile(file: File): Promise<string> {
  const { image, width, height } = await decodeImage(file)
  const scale = Math.min(1, MAX_ART_SIDE / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(width * scale)
  canvas.height = Math.round(height * scale)
  canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height)
  if (image instanceof ImageBitmap) image.close()
  // Safari cannot write WebP and hands back a PNG, many times bigger: JPEG instead
  const webp = canvas.toDataURL('image/webp', 0.85)
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.85)
}
