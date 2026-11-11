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
  // Rare and legendary cards carry a holographic stamp on the line; false leaves it off
  foil?: boolean
  // A Sealed print run's code, printed in place of the artist: "A07-12" is run A, pack 07,
  // the pack's 12th card. Set only while drawing a print run, never saved with the card.
  code?: string
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
  // A Legends card: the gold bar along the bottom of its frame
  legends?: boolean
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
  // Where the boxes were moved to on each side, from where the frame has them: the Prescient
  // version's, put here by prescientOf to draw it. Never saved on the card itself.
  layout?: Layout
  backLayout?: Layout
  // The Prescient version, a booster's full-art card: its own art or placing of the art,
  // and its own look. Left out, it is the card's art with prescientLook (see prescientOf).
  prescient?: Prescient
}

// backArt: a leader's Leader Unit side, as art is its Leader side. Both sides share the look.
// layout and backLayout: each side's boxes, moved to suit the art, as a Showcase leader has them.
export type Prescient = { art?: Art; backArt?: Art; look?: Look; layout?: Layout; backLayout?: Layout }

// The parts of a card that can be moved about over full art, each with what it carries: the
// words in the top bar, the name with its subtitle, the traits, the game text, a leader's Epic
// Action box with its power and HP, and the icons
export const boxParts = ['label', 'name', 'trait', 'text', 'epic', 'cost', 'aspects', 'power', 'hp'] as const
export type BoxPart = (typeof boxParts)[number]
// How far each part is moved, in the frame's pixels
export type Layout = Partial<Record<BoxPart, { x: number; y: number }>>

// The Prescient look: the frame see-through, its icons solid, the text on a half-filled panel
export const prescientLook: Look = {
  ...defaultLook,
  frameOpacity: 0,
  solidIcons: true,
  panelFill: 0.5,
  lightText: true,
}

// Any card may have a Prescient version. A leader is Prescient one pack in 6, and a base, with
// the token on its back; leaders, bases and tokens are never a booster's wild card (see sealedEvent.ts).
export const canBePrescient = (_type: string) => true

// A base's or a token's Prescient look: no panel behind its text, a base being mostly a view of
// a place, and a token's text short
export const prescientBaseLook: Look = { ...prescientLook, panelFill: 0 }

// A card as its Prescient version shows it. A card already full art, as legendaries
// are, keeps its own look until it is given one.
export function prescientOf<
  T extends { frameId?: string; art?: Art; backArt?: Art; look?: Look; layout?: Layout; backLayout?: Layout; prescient?: Prescient },
>(card: T): T {
  const frame = frames.find((each) => each.id === card.frameId)
  const base = frame?.type === 'Base' || frame?.type === 'Token' || frame?.token === true
  const look = card.prescient?.look ?? (card.look?.frameOpacity === 0 ? card.look : base ? prescientBaseLook : prescientLook)
  return {
    ...card,
    art: card.prescient?.art ?? card.art,
    backArt: card.prescient?.backArt ?? card.backArt,
    look,
    layout: card.prescient?.layout,
    backLayout: card.prescient?.backLayout,
  }
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
    return draft && typeof draft.frameId === 'string' ? withPilotingLine(withBothSides(draft)) : undefined
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

// A card's printings beside the plain one: a booster's Prescient card, a foil, or both at once
export const cardVersions = ['prescient', 'foil', 'prescient-foil'] as const
export type CardVersion = (typeof cardVersions)[number]

// A card in a deck: a saved card, by its id, and how many copies; of those, how many are
// each of its other printings. The rest are plain.
export type DeckEntry = { id: string; count: number; versions?: Partial<Record<CardVersion, number>> }

export type Deck = {
  id: string
  name: string
  // Who made it, shown on the deck image
  author?: string
  // The set codes, in capitals, its cards may come from; empty, any card in the Showroom
  sets: string[]
  leader?: string
  base?: string
  cards: DeckEntry[]
  sideboard: DeckEntry[]
}

// A Sealed pool: the cards opened, each by its id and how many, and how many of those came
// Prescient or foil. Its decks are made of these alone. Its boosters: how many it has (6
// unless more were added), how many are opened, and of which set.
export type SealedPool = {
  id: string
  name: string
  cards: DeckEntry[]
  boosters?: number
  opened?: number
  set?: string
}

// Decks live in this browser too, beside the cards they are made of
export const DECKS_KEY = 'dune-unlimited.decks'

// The Showroom's decks are under DECKS_KEY; a Showcase's under a key of its own. Sealed
// pools, and each pool's decks, are kept the same way, under keys of their own
export function loadDecks<T = Deck>(key = DECKS_KEY): T[] {
  try {
    const decks = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(decks) ? decks : []
  } catch {
    return []
  }
}

// Every Deck Builder's decks kept in this browser, by the key they are under
export function localDeckLists() {
  const lists: { key: string; decks: Deck[] }[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key === DECKS_KEY || key?.startsWith(`${DECKS_KEY}.`)) lists.push({ key, decks: loadDecks(key) })
    }
  } catch {
    // Nothing to read, then
  }
  return lists.filter(({ decks }) => decks.length)
}

export function storeDecks<T = Deck>(decks: T[], key = DECKS_KEY) {
  try {
    localStorage.setItem(key, JSON.stringify(decks))
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
