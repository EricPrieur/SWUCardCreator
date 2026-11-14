import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal, flushSync } from 'react-dom'
import artFiles from 'virtual:art-list'
import { asset } from './asset'
import { DeckGlance, type GlanceCard, type GlanceKind } from './DeckGlance'
import './App.css'
import { CardView, partBoxes } from './CardView'
import { AccountBar, Modal } from './account'
import { leaveGuard, setLeaveGuard } from './leaveGuard'
import { EVENT_PACK_SIZE, EVENT_PACKS, planSealedEvent, playerBases, seededRandom, type EventPlan } from './sealedEvent'
import { playClick, Simulator } from './Simulator'
import {
  copyLocalDecks,
  deckScope,
  loadAccountCards,
  loadAccountDecks,
  publishCard,
  syncAccountCards,
  syncAccountDecks,
  unpublishCard,
  type Published,
} from './accountCards'
import { api, API_URL, openAdminPanel, setSession, useAccount, useServerOnline, type Session, type User } from './api'
import {
  defaultLook,
  loadCards,
  loadDraft,
  readArtFile,
  storeCards,
  storeDraft,
  loadCardLine,
  storeCardLine,
  loadDecks,
  localDeckLists,
  storeDecks,
  DECKS_KEY,
  canBePrescient,
  cardVersions,
  prescientOf,
  type CardVersion,
  type SealedPool,
  type CardLine,
  type Art,
  type Card,
  type Deck,
  type DeckEntry,
  type Draft,
  type BoxPart,
  type Layout,
  type Look,
} from './cards'
import {
  aspects,
  canBeUnique,
  epicText,
  frames,
  isUnique,
  type Arena,
  type Aspect,
  type Frame,
  type FrameFilter,
} from './frames'

const tabs = [
  { id: 'creator', label: 'Card Creator' },
  { id: 'showroom', label: 'Showroom' },
  { id: 'decks', label: 'Deck Builder' },
  // Everyone's public cards; only where the accounts server answers
  { id: 'community', label: 'Community' },
  // The DUNE set's own page (#DuneSWU), with its Deck Builder and the game simulator
  { id: 'dune', label: 'Dune SWU' },
  { id: 'projects', label: 'My Other Projects' },
] as const

type TabId = (typeof tabs)[number]['id']

const typeFilters: { label: string; value: FrameFilter }[] = [
  { label: 'Units', value: 'Unit' },
  { label: 'Pilots', value: 'Pilot' },
  { label: 'Leaders', value: 'Leader' },
  { label: 'Events', value: 'Event' },
  { label: 'Tokens', value: 'Token' },
  { label: 'Upgrades', value: 'Upgrade' },
  { label: 'Fortifications', value: 'Fortification' },
  { label: 'Bases', value: 'Base' },
]

const aspectIcon = (aspect: Aspect) => asset(`/icons/aspect/${aspect.toLowerCase()}.png`)

const arenaFilters: { label: string; value: Arena }[] = [
  { label: 'Ground', value: 'Ground' },
  { label: 'Space', value: 'Space' },
]

// A card carries at most two colour aspect icons, plus Heroism or Villainy
const MAX_COLOURS = 2

// Upgrades change power and HP rather than set them
const modifiers = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5]
// A base's HP is far above a unit's
const baseHp = Array.from({ length: 21 }, (_, index) => index + 15)
const formatModifier = (value: number) => (value < 0 ? `−${-value}` : `+${value}`)

const numbers = Array.from({ length: 16 }, (_, number) => number)

const stats = [
  { kind: 'cost', label: 'Cost' },
  { kind: 'power', label: 'Power' },
  { kind: 'hp', label: 'HP' },
] as const

// The editor opens on a blank Command and Heroism ground unit
const blankDraft: Draft = { frameId: 'unit-command-heroism', name: '', trait: '', text: '' }

// A Leader side has no power or HP icon, but prints both numbers in its Epic Action box
const hasStat = (frame: Frame, kind: (typeof stats)[number]['kind']) =>
  frame[kind] !== undefined || (kind !== 'cost' && frame.stats !== undefined)

// Whether two versions of a card say the same, whatever order their fields are in
// and leaving out fields that are not set
function sameCard(a: Draft, b: Draft) {
  const plain = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(plain)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([, field]) => field !== undefined)
              .sort(([x], [y]) => x.localeCompare(y))
              .map(([key, field]) => [key, plain(field)]),
          )
        : value
  return JSON.stringify(plain(a)) === JSON.stringify(plain(b))
}

// What tells one card from another: its name and subtitle together
const cardTitle = (card: Draft) => `${card.name.trim()}|${(card.subtitle ?? '').trim()}`.toLowerCase()
const cardLabel = (card: Draft) =>
  [card.name.trim() || 'Unnamed card', (card.subtitle ?? '').trim()].filter(Boolean).join(', ')

function findFrame(frameId: string) {
  return frames.find((frame) => frame.id === frameId) ?? frames[0]
}

// The card as its frame prints it. Moving a card to another frame keeps what only
// the old frame had, a back or a Piloting box, so moving back loses nothing; saving
// leaves it out, so it is not found by a search or published with the showcase.
function forFrame(card: Draft): Draft {
  const front = findFrame(card.frameId)
  const back = backFrameOf(card)
  const kept: Draft = { ...card }
  if (!back) {
    delete kept.backText
    delete kept.backArt
    delete kept.backName
    delete kept.backSubtitle
    delete kept.backTrait
    delete kept.backFrameId
    delete kept.backArena
  }
  if (!front.epicBox) delete kept.epic
  if (!canBePrescient(front.type)) delete kept.prescient
  if (!front.pilotBox && !back?.pilotBox) {
    delete kept.pilotText
    delete kept.pilotCost
    delete kept.upgradePower
    delete kept.upgradeHp
  }
  return kept
}

// What both sides of a leader say, unless its Leader Unit side was given its own
type SharedKey = 'name' | 'subtitle' | 'trait'

// A base frame of that aspect, with a game text box or without
const baseFrameOf = (aspect: Aspect, withText: boolean) => findFrame(`base-${aspect.toLowerCase()}${withText ? '-text' : ''}`)

// A card's other side, if it has one: a leader's Leader Unit side, or a two-sided
// base's second side. A base's second side is kept as the frame of its aspect; it has
// a game text box when the first side has one.
function backFrameOf(card: Draft): Frame | undefined {
  const front = findFrame(card.frameId)
  if (front.backId) return findFrame(card.backFrameId ?? front.backId + (card.backArena === 'Space' ? '-space' : ''))
  if (front.type !== 'Base' || !card.backFrameId) return undefined
  const [aspect] = findFrame(card.backFrameId).aspects
  return aspect ? baseFrameOf(aspect, front.textBox !== undefined) : undefined
}

// A two-sided base: the same base, played with the aspect of the side its deck chooses
const isTwoSidedBase = (card: Draft) => findFrame(card.frameId).type === 'Base' && backFrameOf(card) !== undefined

// A leader is one card with two sides, which share everything but the frame, the
// game text and where the art sits. A two-sided base's sides share everything but the
// aspect; the second side shows the first side's art until it is given its own.
// Every other card only has a front. "mirrors" is true on a side whose name, trait
// and text are the other side's.
function cardSide(card: Draft, back: boolean) {
  const front = findFrame(card.frameId)
  const shared = { name: card.name, subtitle: card.subtitle, trait: card.trait, mirrors: false }
  if (front.type === 'Base') {
    const second = back ? backFrameOf(card) : undefined
    if (!second) return { ...shared, frame: front, text: card.text, art: card.art, isBack: false }
    return { ...shared, frame: second, text: card.text, art: card.backArt ?? card.art, isBack: true, mirrors: true }
  }
  if (!front.backId) return { ...shared, frame: front, text: card.text, art: card.art, isBack: false }
  // A side with no art of its own shows the other side's image, not yet placed
  const borrowed = (art?: Art): Art | undefined => art && { src: art.src, zoom: 1, x: 0, y: 0 }
  if (!back) return { ...shared, frame: front, text: card.text, art: card.art ?? borrowed(card.backArt), isBack: false }
  return {
    // The Leader Unit side says what the Leader side says, unless it was given its own
    name: card.backName ?? card.name,
    subtitle: card.backSubtitle ?? card.subtitle,
    trait: card.backTrait ?? card.trait,
    frame: backFrameOf(card)!,
    text: card.backText ?? '',
    art: card.backArt ?? borrowed(card.art),
    isBack: true,
    mirrors: false,
  }
}

function CardFace(props: { card: Draft; back?: boolean }) {
  const { card } = props
  const { frame, name, subtitle, trait, text, art } = cardSide(card, props.back === true)
  return (
    <CardView
      frame={frame}
      name={name}
      trait={trait}
      text={text}
      unique={card.unique}
      subtitle={subtitle}
      epic={card.epic}
      cost={card.cost}
      power={card.power}
      hp={card.hp}
      pilotText={card.pilotText}
      upgradePower={card.upgradePower}
      upgradeHp={card.upgradeHp}
      line={card}
      legends={card.legends}
      art={art}
      look={card.look}
      layout={props.back ? card.backLayout : card.layout}
    />
  )
}

const imageFormats = [
  { value: 'png', label: 'PNG', type: 'image/png' },
  // Far smaller, at the price of a little detail. It has no see-through, so the
  // corners outside the card's rounding are black.
  { value: 'jpg', label: 'JPG', type: 'image/jpeg' },
  // Ready for a print service such as MakePlayingCards: see printImage
  { value: 'print', label: 'Print', type: 'image/png' },
] as const
type ImageFormat = (typeof imageFormats)[number]['value']
// The file name ending for each format
const extensions: Record<ImageFormat, string> = { png: 'png', jpg: 'jpg', print: 'png' }
const FORMAT_KEY = 'dune-unlimited.export-format'

function loadFormat(): ImageFormat {
  try {
    const saved = localStorage.getItem(FORMAT_KEY)
    return imageFormats.find(({ value }) => value === saved)?.value ?? 'png'
  } catch {
    return 'png'
  }
}

// A card on the page is art, a frame and text laid over each other, not a picture.
// This draws what is shown into an image, twice the size of the frame's own image
// so the text stays sharp. In a PNG the corners outside the card's rounding are see-through.
// Safari, and every browser on an iPhone or iPad, which all run on Safari's engine
const webKit = /AppleWebKit/.test(navigator.userAgent) && !/(Chrome|Chromium|Edg)\//.test(navigator.userAgent)

// A print-ready card, sized for poker-size cards (2.5 by 3.5 inches) at 300 dpi as
// MakePlayingCards and similar services take them: the card fills 750 by 1050
// pixels, and a bleed of 1/8 inch (36 pixels) runs around it, so a cut that lands a
// little off still shows card rather than white. The bleed is the card's own edge
// mirrored outward. Corners are square: the service rounds them when it cuts.
const PRINT = { width: 750, height: 1050, bleed: 36 }

function printImage(card: HTMLCanvasElement, landscape: boolean) {
  const [w, h] = landscape ? [PRINT.height, PRINT.width] : [PRINT.width, PRINT.height]
  const b = PRINT.bleed
  const inner = document.createElement('canvas')
  inner.width = w
  inner.height = h
  const fit = inner.getContext('2d')!
  fit.imageSmoothingQuality = 'high'
  fit.drawImage(card, 0, 0, w, h)
  const out = document.createElement('canvas')
  out.width = w + 2 * b
  out.height = h + 2 * b
  const ctx = out.getContext('2d')!
  ctx.drawImage(inner, b, b)
  // Each strip of bleed is the strip of card next to it, flipped across the cut line
  const strip = (sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, flipX: boolean, flipY: boolean) => {
    ctx.save()
    ctx.translate(dx + (flipX ? sw : 0), dy + (flipY ? sh : 0))
    ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1)
    ctx.drawImage(inner, sx, sy, sw, sh, 0, 0, sw, sh)
    ctx.restore()
  }
  strip(0, 0, w, b, b, 0, false, true) // top
  strip(0, h - b, w, b, b, h + b, false, true) // bottom
  strip(0, 0, b, h, 0, b, true, false) // left
  strip(w - b, 0, b, h, w + b, b, true, false) // right
  strip(0, 0, b, b, 0, 0, true, true) // corners
  strip(w - b, 0, b, b, w + b, 0, true, true)
  strip(0, h - b, b, b, 0, h + b, true, true)
  strip(w - b, h - b, b, b, w + b, h + b, true, true)
  return out
}

// scale: how many times the frame's own size; 2 keeps the text sharp in print
async function cardImage(card: HTMLElement, frame: Frame, format: ImageFormat, scale = 2) {
  const { toCanvas } = await import('html-to-image')
  const options = {
    pixelRatio: (frame.width * scale) / card.clientWidth,
    backgroundColor: format === 'jpg' ? '#000' : undefined,
    // For print the corners are square; the art and frame already reach them
    style: format === 'print' ? { borderRadius: '0', boxShadow: 'none' } : undefined,
  }
  // Safari draws the card before its pictures have loaded, leaving the art and the
  // frame out and only the text. Drawn again, the pictures are ready and come out.
  if (webKit) {
    await toCanvas(card, options)
    await toCanvas(card, options)
  }
  const drawn = await toCanvas(card, options)
  const canvas = format === 'print' ? printImage(drawn, frame.width > frame.height) : drawn
  const type = imageFormats.find(({ value }) => value === format)!.type
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.92))
  if (!blob) throw new Error('The card could not be drawn')
  return blob
}

// The image format picked last, kept for next time, wherever images are saved
function useImageFormat() {
  const [format, setFormat] = useState<ImageFormat>(loadFormat)
  const change = (next: ImageFormat) => {
    setFormat(next)
    try {
      localStorage.setItem(FORMAT_KEY, next)
    } catch {
      // Not kept, then
    }
  }
  return [format, change] as const
}

// Small line icons for the Showroom's card buttons, drawn in the text colour
const saveIcon = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z" />
    <path d="M8 3v5h7V3" />
    <rect x="8" y="13" width="8" height="6" rx="1" />
  </svg>
)
const flipIcon = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 12a8 8 0 0 1 14-5.3L20 9" />
    <path d="M20 4v5h-5" />
    <path d="M20 12a8 8 0 0 1-14 5.3L4 15" />
    <path d="M4 20v-5h5" />
  </svg>
)
const copyIcon = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h9" />
  </svg>
)
const trashIcon = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 7h16" />
    <path d="M9 7V4h6v3" />
    <path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
    <path d="M10 11v6M14 11v6" />
  </svg>
)

// Save (with its choice of format) and Copy, for a card shown on the page. A middle
// click on Save opens the image in a new tab instead.
function ImageButtons(props: {
  // Holds the card to draw
  holder: RefObject<HTMLElement | null>
  frame: Frame
  fileName: string
  format: ImageFormat
  onFormat: (format: ImageFormat) => void
  // What came of the last click, to show near the buttons
  onNote: (note: string | null) => void
  // Save as an icon, where room is short
  compact?: boolean
}) {
  const { holder, frame, fileName, format, onFormat, onNote, compact } = props
  // What the buttons are up to, shown in place of their labels
  const [busy, setBusy] = useState<'save' | 'copy' | null>(null)

  // Saves the image, copies it, or shows it in a tab opened for it beforehand: a
  // tab opened only once the image is ready would be stopped as a pop-up
  const image = async (action: 'save' | 'copy', tab?: Window | null) => {
    const el = holder.current?.querySelector<HTMLElement>('.card')
    if (!el || busy) return tab?.close()
    setBusy(action)
    onNote(null)
    try {
      // Browsers' clipboards take PNG and, most of them, nothing else: the chosen
      // format is copied where the browser allows it, and PNG where it does not
      const copied = format === 'jpg' && !ClipboardItem.supports?.('image/jpeg') ? 'png' : format
      const blob = await cardImage(el, frame, action === 'copy' ? copied : format)
      if (action === 'copy') {
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
        onNote(copied === format ? 'Copied' : 'Copied as PNG: this browser cannot copy a JPG')
      } else if (tab) {
        tab.location.href = URL.createObjectURL(blob)
      } else {
        const link = document.createElement('a')
        link.href = URL.createObjectURL(blob)
        link.download = `${fileName}${format === 'print' ? ' (print)' : ''}.${extensions[format]}`
        link.click()
        URL.revokeObjectURL(link.href)
      }
    } catch {
      tab?.close()
      onNote('Could not make the image')
    }
    setBusy(null)
  }

  const copyButton = (
    <button
      className={compact ? 'button icon-button' : 'button'}
      type="button"
      disabled={busy !== null}
      aria-label="Copy the image"
      title="Copy the image"
      onClick={() => image('copy')}
    >
      {busy === 'copy' ? (compact ? '…' : 'Drawing…') : compact ? copyIcon : 'Copy'}
    </button>
  )
  // Compact, Copy comes first: Save, wider with its format, then wraps as a whole
  return (
    <>
      {compact && copyButton}
      <span className="split-button">
        <button
          className={compact ? 'button icon-button' : 'button'}
          type="button"
          disabled={busy !== null}
          aria-label="Save the image"
          title="Click to save the image; middle-click to open it in a new tab"
          onClick={() => image('save')}
          // A middle click shows the image in a new tab instead of scrolling the page
          onMouseDown={(event) => event.button === 1 && event.preventDefault()}
          onAuxClick={(event) => event.button === 1 && image('save', window.open('', '_blank'))}
        >
          {busy === 'save' ? (compact ? '…' : 'Drawing…') : compact ? saveIcon : 'Save'}
        </button>
        <ChoiceDropdown
          label="Image format"
          title="Print: 822 × 1122 px with a mirrored bleed edge and square corners, for MakePlayingCards and similar services"
          options={[...imageFormats]}
          selected={format}
          onChange={onFormat}
          buttonClass="split-choice"
        />
      </span>
      {!compact && copyButton}
    </>
  )
}

// With small or medium cards, a large copy of the card under the mouse follows the
// pointer, beside it and kept inside the window. Touch screens do without.
const PREVIEW_WIDTH = 345
const PREVIEW_GAP = 20

// width: the preview's, wider for a leader or base on its side
function HoverPreview(props: { enabled: boolean; preview: ReactNode; children: ReactNode; width?: number }) {
  const { enabled, preview, children, width = PREVIEW_WIDTH } = props
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const place = (x: number, y: number) => {
    const boxWidth = box.current?.offsetWidth ?? width
    const height = box.current?.offsetHeight ?? width * 1.4
    // Right of the pointer, or left of it near the window's right edge
    const left = x + PREVIEW_GAP + boxWidth < window.innerWidth ? x + PREVIEW_GAP : x - PREVIEW_GAP - boxWidth
    const top = Math.max(PREVIEW_GAP / 2, Math.min(y - height / 2, window.innerHeight - height - PREVIEW_GAP / 2))
    return { left: Math.max(PREVIEW_GAP / 2, left), top }
  }
  return (
    <div
      onPointerMove={(event) => enabled && event.pointerType === 'mouse' && setAt(place(event.clientX, event.clientY))}
      onPointerLeave={() => setAt(null)}
      onPointerDown={() => setAt(null)}
    >
      {children}
      {enabled &&
        at &&
        createPortal(
          <div className="hover-preview" ref={box} style={{ width, ...at }}>
            {preview}
          </div>,
          document.body,
        )}
    </div>
  )
}

// A two-sided card's preview shows both its sides: a leader's side by side, as tall as each
// other (the landscape leader side about two thirds of the width, the unit side the rest); a
// two-sided base's one above the other. Its width, for HoverPreview, with it.
function bothSides(first: ReactNode, second: ReactNode, base: boolean) {
  return {
    preview: (
      <div className={base ? 'preview-sides preview-sides-stacked' : 'preview-sides'}>
        <div className={base ? 'preview-side-base' : 'preview-side-leader'}>{first}</div>
        <div className={base ? 'preview-side-base' : 'preview-side-unit'}>{second}</div>
      </div>
    ),
    width: base ? Math.round(PREVIEW_WIDTH * 1.4) : PREVIEW_WIDTH * 2,
  }
}

// Drawn large, a card needs no preview, but a two-sided card's other side still shows: the
// side not shown, as wide as its frame (a leader side and a base are landscape)
function otherSide(face: ReactNode, landscape: boolean) {
  return { preview: face, width: landscape ? Math.round(PREVIEW_WIDTH * 1.4) : PREVIEW_WIDTH }
}
const hoverOf = (preview: boolean, sides: { preview: ReactNode; width?: number }, other?: { preview: ReactNode; width: number }) =>
  preview ? { enabled: true, ...sides } : other ? { enabled: true, ...other } : { enabled: false, ...sides }

// A card submitted to be played (Community Deck Builder): its latest version's state, whether a
// version of it is playable, and whether the card changed since it was last submitted
type CommunityState = { version: number; status: 'awaiting' | 'supported' | 'declined' | 'replaced'; note: string | null; changed: boolean; playable: boolean }

// Submit for play, and where the card stands: under a public card in the Showroom
function CommunityControls(props: { state?: CommunityState; busy: boolean; onSubmit: () => void; onWithdraw: () => void }) {
  const { state, busy, onSubmit, onWithdraw } = props
  const [withdrawing, setWithdrawing] = useState(false)
  if (!state)
    return (
      <div className="community-controls">
        <button className="button" type="button" disabled={busy} title="Ask for this card to be made playable in the Community Deck Builder" onClick={onSubmit}>
          Submit for play
        </button>
      </div>
    )
  const label =
    state.status === 'awaiting'
      ? state.playable
        ? 'Playable · new version awaiting support'
        : 'Awaiting support'
      : state.status === 'declined'
        ? state.playable
          ? 'Playable · new version declined'
          : 'Declined'
        : 'Playable'
  return (
    <div className="community-controls">
      <span className={`community-status community-${state.status}`} title={`Version ${state.version}`}>
        {label}
      </span>
      {state.note && <span className="community-note">“{state.note}”</span>}
      {(state.changed || state.status === 'declined') && (
        <button
          className="button"
          type="button"
          disabled={busy}
          title={state.status === 'awaiting' ? 'Bring the version waiting up to date with your changes' : 'Submit the card as it is now, as a new version'}
          onClick={onSubmit}
        >
          {state.status === 'awaiting' ? 'Update submission' : 'Submit again'}
        </button>
      )}
      {withdrawing ? (
        <span className="confirm">
          Withdraw{state.playable ? ', and take it out of decks' : ''}?
          <button className="button button-primary" type="button" onClick={() => (setWithdrawing(false), onWithdraw())}>
            Yes
          </button>
          <button className="button" type="button" onClick={() => setWithdrawing(false)}>
            No
          </button>
        </span>
      ) : (
        <button className="button" type="button" disabled={busy} title="Take this card out of the community, every version" onClick={() => setWithdrawing(true)}>
          Withdraw
        </button>
      )}
    </div>
  )
}

function ShowroomCard(props: {
  card: Card
  // Show a large copy of the card while the mouse is over it
  preview: boolean
  format: ImageFormat
  onFormat: (format: ImageFormat) => void
  onEdit: () => void
  onRemove: () => void
  // Signed in: whether the card is public (hidden: an admin took it off the Community tab)
  published?: { hidden: boolean } | null
  publishing?: boolean
  // An admin turned off making cards public for the account
  blocked?: boolean
  onPublic?: (makePublic: boolean) => void
  // Signed in, a public card: submitting it to be played, and where it stands
  community?: { state?: CommunityState; busy: boolean; onSubmit: () => void; onWithdraw: () => void }
}) {
  const { card, preview, format, onFormat, onEdit, onRemove, published, publishing, blocked, onPublic, community } = props
  const [back, setBack] = useState(false)
  // Remove asks once more before it does anything
  const [removing, setRemoving] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const side = cardSide(card, back)
  const isBase = findFrame(card.frameId).type === 'Base'
  const sides = backFrameOf(card)
    ? bothSides(<CardFace card={card} />, <CardFace card={card} back />, isBase)
    : { preview: <CardFace card={card} back={back} />, width: undefined }
  const hover = hoverOf(preview, sides, backFrameOf(card) && otherSide(<CardFace card={card} back={!back} />, isBase || back))

  return (
    <li>
      <HoverPreview enabled={hover.enabled} preview={hover.preview} width={hover.width}>
        <div ref={ref}>
          <CardFace card={card} back={back} />
        </div>
      </HoverPreview>
      <div className="showroom-actions">
        {backFrameOf(card) && (
          <button className="button icon-button" aria-label="Flip" title="Show the other side" onClick={() => setBack(!back)}>
            {flipIcon}
          </button>
        )}
        <button className="button" onClick={onEdit}>
          Edit
        </button>
        {removing ? (
          <span className="confirm">
            Remove?
            <button className="button button-primary" onClick={onRemove}>
              Yes
            </button>
            <button className="button" onClick={() => setRemoving(false)}>
              No
            </button>
          </span>
        ) : (
          <button className="button icon-button" aria-label="Remove" title="Remove this card" onClick={() => setRemoving(true)}>
            {trashIcon}
          </button>
        )}
        <ImageButtons
          holder={ref}
          frame={side.frame}
          fileName={cardFileName(card, back)}
          format={format}
          onFormat={onFormat}
          onNote={setNote}
          compact
        />
        {onPublic && (
          // Stays pressed, in colour, while the card shows on the Community tab
          <button
            className="button public-button"
            type="button"
            aria-pressed={!!published}
            disabled={publishing || (blocked && !published)}
            title={
              blocked
                ? 'An admin has turned off making cards public for your account'
                : published
                  ? 'Shown on the Community tab. Click to make it private again.'
                  : 'Show this card on the Community tab, for everyone'
            }
            onClick={() => onPublic(!published)}
          >
            {/* Says what the card is now, and on hover what a click does: a lone "Public" read as a
                caption, so private cards looked public */}
            {publishing ? (
              'Drawing…'
            ) : published ? (
              <>
                <span className="public-now">Public</span>
                <span className="public-undo">Make private</span>
              </>
            ) : (
              'Make public'
            )}
          </button>
        )}
      </div>
      {community && (published || community.state) && !published?.hidden && <CommunityControls {...community} />}
      {note && <p className="saved-note showroom-note">{note}</p>}
      {published?.hidden && <p className="saved-note showroom-note">Hidden from the Community tab by an admin</p>}
    </li>
  )
}

// The author's other games, and where to support the work
const projects = [
  {
    name: 'The Chrome Grid',
    url: 'https://thechromegrid.com/',
    image: '/projects/the-chrome-grid.jpg',
    text: 'A free Cyberpunk trading card game simulator in your browser. Build decks, call legends like Panam, Goro and Jackie, and play online or against the AI.',
  },
  {
    name: 'CCG Quest',
    url: 'https://ericprieur.github.io/ccgQuest/',
    image: '/projects/ccg-quest.jpg',
    text: 'A collectible card game you can play right in your browser.',
  },
]

function Projects() {
  return (
    <section className="projects">
      <ul className="project-grid">
        {projects.map(({ name, url, image, text }) => (
          // A screenshot of the game behind its card, darkened where the text sits
          <li key={url} style={{ backgroundImage: `url("${asset(image)}")` }}>
            <h2>{name}</h2>
            <p>{text}</p>
            <a className="button button-primary" href={url} target="_blank" rel="noopener noreferrer">
              Open {name}
            </a>
          </li>
        ))}
      </ul>
      <div className="support">
        <h2>Like what you see?</h2>
        <p>These projects are free. If they have given you some fun, you can buy me a coffee.</p>
        <a className="button" href="https://ko-fi.com/ericprieur" target="_blank" rel="noopener noreferrer">
          Support me on Ko-fi
        </a>
      </div>
    </section>
  )
}

function tabFromHash(): TabId {
  const id = window.location.hash.slice(1)
  if (showroomOwnerFromHash()) return 'community'
  return tabs.find((tab) => tab.id === id)?.id ?? 'creator'
}

// Someone's public Showroom: #showroom/<their name>, shown under the Community tab
function showroomOwnerFromHash() {
  const name = /^showroom\/([A-Za-z0-9_-]+)\/*$/.exec(window.location.hash.slice(1))?.[1]
  return name ?? null
}
const showroomLink = (name: string) => `${window.location.origin}${window.location.pathname}#showroom/${name}`

// Showcases on the site that no menu links to: the address's name, and its folder in public/showcase
// A published set is at #set/<SET>; some also have a name of their own
// (#simulator: the Simulator had its own tab before it moved to the DUNE page)
const showcases: Record<string, string> = { DuneSWU: 'DUNE', simulator: 'DUNE' }
// A slash at the end, or other capitals, still find it: #DuneSWU/, #duneswu, #set/dune
const showcaseFromHash = () => {
  const asked = window.location.hash.slice(1).replace(/\/+$/, '')
  const set = /^set\/([A-Za-z0-9_-]+)$/.exec(asked)?.[1]
  if (set) return set.toUpperCase()
  return Object.entries(showcases).find(([name]) => name.toLowerCase() === asked.toLowerCase())?.[1]
}

// A dropdown of checkboxes: a button that opens a list, any number of which can be ticked
function CheckDropdown<T extends string | number>(props: {
  label: string
  options: { label: string; value: T }[]
  selected: T[]
  onChange: (selected: T[]) => void
}) {
  const { label, options, selected, onChange } = props
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="check-dropdown" ref={ref}>
      <button
        className="chip"
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-pressed={selected.length > 0}
        disabled={options.length === 0}
        onClick={() => setOpen(!open)}
      >
        {label}
        {selected.length > 0 && ` (${selected.length})`} ▾
      </button>
      {open && (
        <div className="check-options">
          {options.map((option) => (
            <label className="toggle" key={option.value}>
              <input
                type="checkbox"
                checked={selected.includes(option.value)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, option.value]
                      : selected.filter((value) => value !== option.value),
                  )
                }
              />
              {option.label}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

// A dropdown to pick one of a few choices, in the look of the filter dropdowns: the
// button shows the choice, the list opens under it with the choice marked
// An option's icons (a deck's aspects) show after its label, small
function ChoiceDropdown<T extends string>(props: {
  label: string
  options: { label: string; value: T; icons?: Aspect[]; preview?: ReactNode }[]
  selected: T
  onChange: (value: T) => void
  // In place of the chip look, for a dropdown joined to another button
  buttonClass?: string
  title?: string
}) {
  const { label, options, selected, onChange, buttonClass, title } = props
  const [open, setOpen] = useState(false)
  // The option the pointer is on, whose preview shows beside the list
  const [hovered, setHovered] = useState<T | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const preview = open && hovered !== null ? options.find((option) => option.value === hovered)?.preview : undefined

  useEffect(() => {
    if (!open) setHovered(null)
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="check-dropdown" ref={ref}>
      <button
        className={buttonClass ?? 'chip'}
        type="button"
        aria-label={label}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {options.find((option) => option.value === selected)?.label}
        <OptionIcons icons={options.find((option) => option.value === selected)?.icons} /> ▾
      </button>
      {open && (
        <div className="check-options choice-options" role="listbox" aria-label={label} ref={listRef} onPointerLeave={() => setHovered(null)}>
          {options.map((option) => (
            <button
              type="button"
              role="option"
              key={option.value}
              aria-selected={option.value === selected}
              onPointerEnter={() => setHovered(option.value)}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
            >
              {option.label}
              <OptionIcons icons={option.icons} />
            </button>
          ))}
        </div>
      )}
      {preview && (
        <div className="choice-preview" style={{ left: (listRef.current?.offsetWidth ?? 0) + 8 }} aria-hidden>
          {preview}
        </div>
      )}
    </div>
  )
}

// A deck's leader, both its sides, and its numbers at a glance, for the deck menu's hover
function leaderPreview(leader: DeckCard | undefined, cards: GlanceCard[]) {
  if (!leader) return undefined
  return (
    <>
      <div className="choice-preview-sides">
        <div className="choice-preview-face">{leader.face}</div>
        {leader.backFace && <div className="choice-preview-face">{leader.backFace}</div>}
      </div>
      <DeckGlance cards={cards} />
    </>
  )
}

// A deck card as the glance counts it
const glanceKinds: Record<DeckGroup, GlanceKind> = { 'Ground units': 'Ground', 'Space units': 'Space', Events: 'Event', Upgrades: 'Upgrade' }
function glanceOf(card: DeckCard, count: number): GlanceCard {
  const group = deckGroup(card)
  return { cost: card.cost ?? 0, kind: group && glanceKinds[group], aspects: card.icons, count }
}

function OptionIcons(props: { icons?: Aspect[] }) {
  if (!props.icons?.length) return null
  return (
    <span className="option-icons" title={props.icons.join(', ')}>
      {props.icons.map((aspect, index) => (
        <img key={index} src={aspectIcon(aspect)} alt={aspect} />
      ))}
    </span>
  )
}

const splitTraits = (trait?: string) =>
  (trait ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)

// Game text without its markup, for searching: brackets and the like taken out
const plainText = (...texts: (string | undefined)[]) =>
  texts
    .filter(Boolean)
    .join(' ')
    .replace(/[[\]{}<>]/g, '')
    .toLowerCase()

// What a card can be found and sorted by
type Facts = {
  name: string
  type: FrameFilter
  // Lower-case, for matching
  names: string[]
  traits: string[]
  // As first typed, for the Trait dropdown
  traitLabels: string[]
  text: string
  aspects: Aspect[]
  cost?: number
  // The set code from the card line, as typed; empty when the card has none
  set: string
  // The card's number in its set, as typed (001/100); empty when it has none
  number: string
  // Where a unit fights; a leader's is its unit side's. None for the other cards.
  arena?: Arena
  // The rarity's letter (C, U, R, S, L); empty when the card has none
  rarity: string
}

// A saved card's facts. A leader, or a two-sided base, counts for what either of its sides says.
function cardFacts(card: Card): Facts {
  const frame = findFrame(card.frameId)
  const back = backFrameOf(card) ? cardSide(card, true) : undefined
  // A base's second side says what its first says: its location is not listed twice
  const traitLabels = [...splitTraits(card.trait), ...(back?.mirrors ? [] : splitTraits(back?.trait))]
  return {
    name: card.name,
    // A token unit is listed with the tokens
    type: (frame.token ? 'Token' : frame.pilotBox ? 'Pilot' : frame.type) as FrameFilter,
    names: [card.name, back?.name ?? ''].map((name) => name.toLowerCase()),
    traits: traitLabels.map((trait) => trait.toLowerCase()),
    traitLabels,
    // A back's text stays saved when a card moves to a one-sided frame, but is not on the card
    text: plainText(card.text, back && card.backText, card.pilotText, card.epic),
    aspects: [...frame.aspects, ...(back?.frame.aspects ?? [])],
    cost: card.cost,
    set: card.setCode?.trim() ?? '',
    number: card.number?.trim() ?? '',
    arena: frame.arena ?? back?.frame.arena,
    rarity: card.rarity?.trim().toUpperCase().slice(0, 1) ?? '',
  }
}

// How big the cards are drawn: large is the full width a card can have, medium two
// thirds of it, small half. Kept for next time.
const cardSizes = [
  { value: 's', label: 'S', title: 'Small cards' },
  { value: 'm', label: 'M', title: 'Medium cards' },
  { value: 'l', label: 'L', title: 'Large cards' },
] as const
type CardSize = (typeof cardSizes)[number]['value']
const SIZE_KEY = 'dune-unlimited.card-size'

function loadCardSize(): CardSize {
  try {
    const saved = localStorage.getItem(SIZE_KEY)
    return cardSizes.find(({ value }) => value === saved)?.value ?? 'm'
  } catch {
    return 'm'
  }
}

// The Set filter's choice for the cards whose card line has no set, and the Rarity
// filter's for the cards with no rarity
const NO_SET = '\u0000none'
const NO_RARITY = '\u0000none'

const sorts = [
  { value: 'saved', label: 'Order saved' },
  { value: 'name', label: 'Name' },
  { value: 'cost', label: 'Cost' },
  { value: 'type', label: 'Type' },
  { value: 'number', label: 'Set number' },
] as const
type SortKey = (typeof sorts)[number]['value']

// A setting remembered in this browser under a name: it is the same after going to
// another tab, or coming back another day
function useRemembered<T>(name: string, first: T) {
  const key = `dune-unlimited.remember.${name}`
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(key)
      return saved === null ? first : (JSON.parse(saved) as T)
    } catch {
      return first
    }
  })
  const change = (next: T) => {
    setValue(next)
    try {
      localStorage.setItem(key, JSON.stringify(next))
    } catch {
      // Not remembered, then
    }
  }
  return [value, change] as const
}

// Search, filters and sort over a list of cards, as the Showroom and a Showcase
// show them: the bar to put above the cards, and the cards it lets through, in order.
// Each list remembers its own choices under its name.
function useCardFilters<T>(
  name: string,
  items: { item: T; facts: Facts }[],
  firstSort = 'Order saved',
  // The sort until one is picked
  startSort: SortKey = 'saved',
  // The card an item is a side of, so the count names each card once
  cardOf?: (item: T) => string,
  // Put at the end of the bar, after the count: a Showcase's print button
  extra?: ReactNode,
  // Whether a card has no image yet: offers a "Missing image" filter, to put where the caller likes
  noImage?: (item: T) => boolean,
) {
  const [query, setQuery] = useRemembered(`${name}.search`, '')
  const [types, setTypes] = useRemembered<FrameFilter[]>(`${name}.types`, [])
  const [traits, setTraits] = useRemembered<string[]>(`${name}.traits`, [])
  const [costs, setCosts] = useRemembered<number[]>(`${name}.costs`, [])
  // Set codes ticked; NO_SET stands for the cards with none
  const [sets, setSets] = useRemembered<string[]>(`${name}.sets`, [])
  const [picked, setPicked] = useRemembered<Aspect[]>(`${name}.aspects`, [])
  // Only the cards with no aspect at all; picking an aspect turns it off, and the other way round
  const [neutral, setNeutral] = useRemembered(`${name}.neutral`, false)
  const [arenas, setArenas] = useRemembered<Arena[]>(`${name}.arenas`, [])
  // Rarity letters ticked; NO_RARITY stands for the cards with none
  const [rarityPicks, setRarityPicks] = useRemembered<string[]>(`${name}.rarities`, [])
  const [sort, setSort] = useRemembered<SortKey>(`${name}.sort`, startSort)
  const [descending, setDescending] = useRemembered(`${name}.descending`, false)
  const [onlyNoImage, setOnlyNoImage] = useRemembered(`${name}.noImage`, false)
  const [size, setSize] = useState<CardSize>(loadCardSize)
  const changeSize = (next: CardSize) => {
    setSize(next)
    try {
      localStorage.setItem(SIZE_KEY, next)
    } catch {
      // Not kept, then
    }
  }

  const listed = items.map((entry, index) => ({ ...entry, index }))
  // The dropdowns only offer what some card has. Traits keep the spelling first typed.
  const traitNames = new Map<string, string>()
  for (const { facts } of listed) {
    for (const trait of facts.traitLabels) {
      if (!traitNames.has(trait.toLowerCase())) traitNames.set(trait.toLowerCase(), trait)
    }
  }
  const traitOptions = [...traitNames]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label))
  const typeOptions = typeFilters.filter(({ value }) => listed.some(({ facts }) => facts.type === value))
  const arenaOptions = arenaFilters.filter(({ value }) => listed.some(({ facts }) => facts.arena === value))
  const costOptions = [...new Set(listed.flatMap(({ facts }) => (facts.cost === undefined ? [] : [facts.cost])))]
    .sort((a, b) => a - b)
    .map((cost) => ({ value: cost, label: String(cost) }))
  // Each set some card is in, compared without regard to capitals, then the cards in none
  const setNames = new Map<string, string>()
  for (const { facts } of listed) {
    if (facts.set && !setNames.has(facts.set.toUpperCase())) setNames.set(facts.set.toUpperCase(), facts.set)
  }
  const setOptions = [
    ...[...setNames]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([value, label]) => ({ value, label: label.toUpperCase() })),
    ...(listed.some(({ facts }) => !facts.set) ? [{ value: NO_SET, label: 'No set' }] : []),
  ]
  // In the order of the Card Creator's picker, then the cards with none; only offered
  // once some card has a rarity
  const rarityOptions = [
    ...rarities.filter(({ value }) => listed.some(({ facts }) => facts.rarity === value)),
    ...(listed.some(({ facts }) => !facts.rarity) ? [{ value: NO_RARITY, label: 'No rarity' }] : []),
  ]
  const hasRarity = listed.some(({ facts }) => facts.rarity)

  const search = query.trim().toLowerCase()
  // Within Type, Trait and Cost any ticked box will do; every picked aspect must be on the card
  const found = listed.filter(
    ({ item, facts }) =>
      (search === '' || facts.names.some((name) => name.includes(search)) || facts.text.includes(search)) &&
      (types.length === 0 || types.includes(facts.type)) &&
      (traits.length === 0 || traits.some((trait) => facts.traits.includes(trait))) &&
      (costs.length === 0 || (facts.cost !== undefined && costs.includes(facts.cost))) &&
      (sets.length === 0 || sets.includes(facts.set ? facts.set.toUpperCase() : NO_SET)) &&
      (arenas.length === 0 || (facts.arena !== undefined && arenas.includes(facts.arena))) &&
      (rarityPicks.length === 0 || rarityPicks.includes(facts.rarity || NO_RARITY)) &&
      (!neutral || facts.aspects.length === 0) &&
      (!onlyNoImage || !noImage || noImage(item)) &&
      picked.every((aspect) => facts.aspects.includes(aspect)),
  )
  const typeOrder = typeFilters.map(({ value }) => value)
  const compare: Record<SortKey, (a: (typeof found)[number], b: (typeof found)[number]) => number> = {
    saved: () => 0,
    name: (a, b) => a.facts.name.localeCompare(b.facts.name),
    // Cards without a cost come after the ones with one
    cost: (a, b) => (a.facts.cost ?? Infinity) - (b.facts.cost ?? Infinity),
    type: (a, b) => typeOrder.indexOf(a.facts.type) - typeOrder.indexOf(b.facts.type),
    // Set by set, then by number as a number would count (9 before 10); cards without one come after
    number: (a, b) =>
      Number(!a.facts.number) - Number(!b.facts.number) ||
      a.facts.set.localeCompare(b.facts.set, undefined, { sensitivity: 'base' }) ||
      a.facts.number.localeCompare(b.facts.number, undefined, { numeric: true }),
  }
  const shown = [...found].sort((a, b) => compare[sort](a, b) || a.index - b.index)
  if (descending) shown.reverse()
  // Cards with no cost (bases, tokens) or no number stay after the others, the other way round as well
  const missing = (facts: Facts) => (sort === 'cost' ? facts.cost === undefined : sort === 'number' ? !facts.number : false)
  if (descending) shown.sort((a, b) => Number(missing(a.facts)) - Number(missing(b.facts)))
  // The two sides of a base are one card
  const cardCount = (list: { item: T }[]) => (cardOf ? new Set(list.map(({ item }) => cardOf(item))).size : list.length)
  const itemCount = cardCount(items)
  const shownCount = cardCount(shown)
  const filtered =
    search !== '' ||
    neutral ||
    (onlyNoImage && !!noImage) ||
    types.length + traits.length + costs.length + sets.length + arenas.length + rarityPicks.length + picked.length > 0

  const bar = (
    <div className="filters showroom-filters">
      <input
        className="search"
        type="search"
        placeholder="Search by name or text"
        aria-label="Search by name or text"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="filter-group">
        <CheckDropdown label="Type" options={typeOptions} selected={types} onChange={setTypes} />
        <CheckDropdown label="Trait" options={traitOptions} selected={traits} onChange={setTraits} />
        <CheckDropdown label="Cost" options={costOptions} selected={costs} onChange={setCosts} />
        {hasRarity && (
          <CheckDropdown label="Rarity" options={rarityOptions} selected={rarityPicks} onChange={setRarityPicks} />
        )}
        <CheckDropdown label="Set" options={setOptions} selected={sets} onChange={setSets} />
        {arenaOptions.length > 0 && <CheckDropdown label="Arena" options={arenaOptions} selected={arenas} onChange={setArenas} />}
      </div>
      <div className="filter-group">
        {aspects.map((aspect) => (
          <button
            className="chip aspect-chip"
            type="button"
            key={aspect}
            title={aspect}
            aria-label={aspect}
            aria-pressed={picked.includes(aspect)}
            onClick={() => {
              setPicked(picked.includes(aspect) ? picked.filter((other) => other !== aspect) : [...picked, aspect])
              setNeutral(false)
            }}
          >
            <img src={aspectIcon(aspect)} alt="" />
          </button>
        ))}
        <button
          className="chip aspect-chip"
          type="button"
          title="Neutral: no aspect"
          aria-label="Neutral"
          aria-pressed={neutral}
          onClick={() => {
            setNeutral(!neutral)
            setPicked([])
          }}
        >
          <span className="aspect-none" />
        </button>
      </div>
      <div className="filter-group">
        <span className="filter-label">Sort</span>
        <ChoiceDropdown
          label="Sort"
          options={sorts.map(({ value, label }) => ({ value, label: value === 'saved' ? firstSort : label }))}
          selected={sort}
          onChange={setSort}
        />
        <button
          className="chip"
          type="button"
          title={descending ? 'Descending' : 'Ascending'}
          aria-label={descending ? 'Descending' : 'Ascending'}
          onClick={() => setDescending(!descending)}
        >
          {descending ? '↓' : '↑'}
        </button>
      </div>
      <div className="filter-group">
        <span className="filter-label">Size</span>
        {cardSizes.map(({ value, label, title }) => (
          <button
            className="chip size-chip"
            type="button"
            key={value}
            title={title}
            aria-pressed={size === value}
            onClick={() => changeSize(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="filter-group">
        <span className="filter-label">
          {shownCount === itemCount ? `${itemCount} cards` : `${shownCount} of ${itemCount} cards`}
        </span>
        {filtered && (
          <button
            className="chip"
            type="button"
            onClick={() => {
              setQuery('')
              setTypes([])
              setTraits([])
              setCosts([])
              setSets([])
              setArenas([])
              setRarityPicks([])
              setNeutral(false)
              setPicked([])
              setOnlyNoImage(false)
            }}
          >
            Clear filters
          </button>
        )}
      </div>
      {extra && <div className="filter-group">{extra}</div>}
    </div>
  )
  // The class for the grid of cards, which sets their size
  const missingImage = noImage && (
    <button
      className="chip"
      type="button"
      aria-pressed={onlyNoImage}
      title={`Only the cards with no image yet (${items.filter(({ item }) => noImage(item)).length})`}
      onClick={() => setOnlyNoImage(!onlyNoImage)}
    >
      Missing image
    </button>
  )
  return { bar, shown, grid: `showroom-grid card-size-${size}`, preview: size !== 'l', missingImage }
}

// The name a card's image is saved under: its name and subtitle, and "(unit)" for a
// leader's other side or the aspect for a base's second side, "(Cunning)", without
// the characters file names cannot have
function cardFileName(card: Draft, back: boolean) {
  const side = cardSide(card, back)
  const subtitle = side.subtitle?.trim()
  const which = !side.isBack ? '' : side.mirrors ? ` (${side.frame.aspects[0]})` : ' (unit)'
  const name = `${side.name.trim() || 'card'}${subtitle ? ` - ${subtitle}` : ''}${which}`
  return name.replace(/[\\/:*?"<>|]/g, '')
}
// What cardFileName adds for a card's other side
const sideSuffix = / \((?:unit|Vigilance|Command|Aggression|Cunning)\)$/

// A Showcase's list of cards, kept as showcase.json beside the cards' images, which
// are saved from the Showroom as JPG under the names given here.
type ShowcaseCard = {
  // The saved card it was published from, to update it in place when published again
  id?: string
  image: string
  back?: string
  name: string
  backName?: string
  subtitle?: string
  type: FrameFilter
  // A two-sided base's first side's aspects here, its second side's in backAspects
  aspects: Aspect[]
  backAspects?: Aspect[]
  cost?: number
  traits: string[]
  text?: string
  set?: string
  number?: string
  arena?: Arena
  rarity?: string
}
type ShowcaseList = { title: string; cards: ShowcaseCard[] }

// A Showcase entry for a saved card: what the showcase page searches and filters
// by, and the names of its images
function showcaseEntry(card: Card): ShowcaseCard {
  const facts = cardFacts(card)
  const frame = findFrame(card.frameId)
  const back = backFrameOf(card) ? cardSide(card, true) : undefined
  return {
    id: card.id,
    image: cardFileName(card, false),
    back: back && cardFileName(card, true),
    name: card.name,
    backName: back && back.name !== card.name ? back.name : undefined,
    subtitle: card.subtitle?.trim() || undefined,
    type: facts.type,
    aspects: back?.mirrors ? frame.aspects : facts.aspects,
    backAspects: back?.mirrors ? back.frame.aspects : undefined,
    cost: card.cost,
    traits: facts.traitLabels,
    text: facts.text || undefined,
    set: facts.set || undefined,
    number: facts.number || undefined,
    arena: facts.arena,
    rarity: facts.rarity || undefined,
  }
}

// Where Export writes a set: its folder of card images, a .json file per card and the
// card's art, for Import to bring back, and the set's showcase.json
type ExportTarget = {
  // The set's showcase.json already there, to update rather than replace
  read: (set: string) => Promise<ShowcaseList | null>
  write: (set: string, file: string, body: Blob | string) => Promise<void>
  // Once a set is written, with the files it has now
  finish: (set: string, keep: string[]) => Promise<void>
  // Where it all went, for the note after an export
  done: () => Promise<string>
}

// On this computer (the dev server): public/showcase/<SET>, which is the site once committed
function devTarget(): ExportTarget {
  const send = async (set: string, file: string, body: BodyInit, method = 'PUT') => {
    const response = await fetch(`/__publish/${set}/${encodeURIComponent(file)}`, { method, body })
    if (!response.ok) throw new Error(await response.text())
  }
  return {
    read: async (set) => {
      const response = await fetch(`/showcase/${set}/showcase.json`, { cache: 'no-store' })
      return response.ok ? response.json() : null
    },
    write: (set, file, body) => send(set, file, body),
    finish: (set, keep) => send(set, 'finish', JSON.stringify(keep), 'POST'),
    done: async () => 'public/showcase',
  }
}

type SavePicker = (options: {
  id?: string
  suggestedName: string
  types: { description: string; accept: Record<string, string[]> }[]
}) => Promise<FileSystemFileHandle>
const showSaveFilePicker = (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker
type DirectoryPicker = (options?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>
const showDirectoryPicker = (window as Window & { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker

// On the site: one .zip, a folder per set in it. Where the browser can (Chrome and Edge
// on a computer) it is saved where the person picks, under a name they may change;
// elsewhere, phones among them, it is downloaded. The place is asked for at once: a
// browser only shows its Save box straight after a click, not once the cards are drawn.
async function zipTarget(sets: string[]): Promise<ExportTarget> {
  const suggestedName = `${sets.length === 1 ? sets[0] : 'Cards'}.zip`
  const handle = await showSaveFilePicker?.({
    id: 'export',
    suggestedName,
    types: [{ description: 'Zip file', accept: { 'application/zip': ['.zip'] } }],
  })
  const files: Record<string, [Uint8Array, { level: 0 | 6 }]> = {}
  return {
    read: async () => null,
    write: async (set, file, body) => {
      const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(await body.arrayBuffer())
      // A JPG is already as small as it gets
      files[`${set}/${file}`] = [bytes, { level: file.endsWith('.jpg') ? 0 : 6 }]
    },
    finish: async () => {},
    done: async () => {
      const { zipSync } = await import('fflate')
      const zip = new Blob([zipSync(files) as Uint8Array<ArrayBuffer>], { type: 'application/zip' })
      if (handle) {
        const writable = await handle.createWritable()
        await writable.write(zip)
        await writable.close()
        return handle.name
      }
      const link = document.createElement('a')
      link.href = URL.createObjectURL(zip)
      link.download = suggestedName
      link.click()
      URL.revokeObjectURL(link.href)
      return suggestedName
    },
  }
}

// Where a print job's files go, each written as soon as it is made so a big job never has to be
// held whole. Where the browser can, a folder the person picks, with one for the job made in it;
// elsewhere a .zip downloaded at the end. Asked for at once, straight after the click.
type PrintSink = {
  // Whether a file is already there from a run that was cut off, so it is not drawn again
  has: (path: string) => Promise<boolean>
  put: (path: string, data: Uint8Array) => Promise<void>
  finish: () => Promise<string>
  partial: boolean // What is written stays when the job is stopped
  where: string
}
async function printSink(name: string): Promise<PrintSink | null> {
  // For a scripted test on the dev server: each file to public/showcase/PRINTRUN, its path flattened
  if (import.meta.env.DEV && (window as unknown as { __printToDisk?: boolean }).__printToDisk) {
    let count = 0
    const flatOf = (path: string) => path.replace(/\//g, '~') + (path.endsWith('.jpg') ? '' : '.json')
    return {
      // A missing file comes back as the page itself
      has: async (path) => {
        const res = await fetch(`/showcase/PRINTRUN/${encodeURIComponent(flatOf(path))}`, { method: 'HEAD', cache: 'no-store' })
        return res.ok && (res.headers.get('content-type') ?? '').startsWith('image/') && Number(res.headers.get('content-length')) > 0
      },
      put: async (path, data) => {
        const flat = flatOf(path)
        const res = await fetch(`/__publish/PRINTRUN/${encodeURIComponent(flat)}`, { method: 'PUT', body: data as Uint8Array<ArrayBuffer> })
        if (!res.ok) throw new Error(`${path}: ${res.status}`)
        count++
      },
      finish: async () => `Written: ${count} files to public/showcase/PRINTRUN`,
      partial: true,
      where: 'public/showcase/PRINTRUN',
    }
  }
  if (showDirectoryPicker) {
    let parent: FileSystemDirectoryHandle
    try {
      parent = await showDirectoryPicker({ id: 'print', mode: 'readwrite' })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return null
      throw err
    }
    const root = await parent.getDirectoryHandle(name, { create: true })
    const folders = new Map<string, Promise<FileSystemDirectoryHandle>>([['', Promise.resolve(root)]])
    const folderOf = (path: string): Promise<FileSystemDirectoryHandle> => {
      if (!folders.has(path)) {
        const cut = path.lastIndexOf('/')
        folders.set(path, folderOf(path.slice(0, Math.max(cut, 0))).then((up) => up.getDirectoryHandle(path.slice(cut + 1), { create: true })))
      }
      return folders.get(path)!
    }
    let count = 0
    const where = `${parent.name}/${name}`
    return {
      // A file is only there once it was written whole: a writable is kept apart until closed
      has: async (path) => {
        const cut = path.lastIndexOf('/')
        try {
          const folder = await folderOf(cut < 0 ? '' : path.slice(0, cut))
          return (await (await folder.getFileHandle(path.slice(cut + 1))).getFile()).size > 0
        } catch {
          return false
        }
      },
      put: async (path, data) => {
        const cut = path.lastIndexOf('/')
        const folder = await folderOf(cut < 0 ? '' : path.slice(0, cut))
        const writable = await (await folder.getFileHandle(path.slice(cut + 1), { create: true })).createWritable()
        await writable.write(data as Uint8Array<ArrayBuffer>)
        await writable.close()
        count++
      },
      finish: async () => `Saved ${count} files in ${where}`,
      partial: true,
      where,
    }
  }
  const files: Record<string, [Uint8Array, { level: 0 | 6 }]> = {}
  return {
    has: async () => false,
    put: async (path, data) => {
      files[path] = [data, { level: path.endsWith('.jpg') ? 0 : 6 }]
    },
    finish: async () => {
      const { zipSync } = await import('fflate')
      const link = document.createElement('a')
      link.href = URL.createObjectURL(new Blob([zipSync(files) as Uint8Array<ArrayBuffer>], { type: 'application/zip' }))
      link.download = `${name}.zip`
      link.click()
      URL.revokeObjectURL(link.href)
      return `Downloaded ${name}.zip`
    },
    partial: false,
    where: '',
  }
}

// The names a card's art is exported under, beside its image: either kind a browser
// may have written it as
const artFileNames = (image: string, kind = 'art') => ['webp', 'jpg'].map((extension) => `${image} (${kind}).${extension}`)

// A card ready to be imported anywhere: its art as files of their own, which the card
// names, rather than in this browser's storage or this computer's art folder
async function portableCard(
  card: Card,
  // The names of its images in the set
  names: { image: string; back?: string },
): Promise<{ card: Card; files: { name: string; body: Blob }[] }> {
  const files: { name: string; body: Blob }[] = []
  const separate = async (art: Art | undefined, back: boolean, kind?: string) => {
    if (!art?.src) return art
    // Shrunk the way uploaded art is, so a large original does not weigh on the export
    const original = await (await fetch(art.src.startsWith('data:') ? art.src : asset(art.src))).blob()
    // A missing file comes back as the app's page, which no picture can be made of
    if (!original.type.startsWith('image/')) throw new Error(`the art of ${card.name}, ${art.src}, was not found`)
    const body = await (await fetch(await readArtFile(new File([original], 'art')))).blob()
    const name = artFileNames((back && names.back) || names.image, kind)[body.type === 'image/webp' ? 0 : 1]
    files.push({ name, body })
    return { ...art, src: name }
  }
  const art = await separate(card.art, false)
  // The Prescient version's art: the card's file again when it is the same picture
  const ownArt = card.prescient?.art
  const prescient = ownArt && {
    ...card.prescient,
    art: art && ownArt.src === card.art?.src ? { ...ownArt, src: art.src } : await separate(ownArt, false, 'prescient art'),
  }
  return { card: { ...card, art, backArt: await separate(card.backArt, true), ...(prescient && { prescient }) }, files }
}

// Cards in the files Export wrote: cards' .json and their art, or a .zip of them.
// Anything else among them is passed over.
async function cardsInFiles(picked: File[]): Promise<Card[]> {
  // Every file by its path in a .zip and by its name alone, for a card to find its art
  const files = new Map<string, Blob>()
  const add = (path: string, blob: Blob) => {
    files.set(path, blob)
    files.set(path.split('/').pop()!, blob)
  }
  for (const file of picked) {
    if (!/\.zip$/i.test(file.name)) {
      add(file.name, file)
      continue
    }
    const { unzipSync } = await import('fflate')
    for (const [path, bytes] of Object.entries(unzipSync(new Uint8Array(await file.arrayBuffer())))) {
      add(path, new Blob([bytes as Uint8Array<ArrayBuffer>]))
    }
  }
  const isCard = (value: unknown): value is Card =>
    typeof value === 'object' && value !== null && typeof (value as Card).frameId === 'string' && typeof (value as Card).name === 'string'
  const cards: Card[] = []
  // Each .json once, under its full path
  const jsons = new Map<Blob, string>()
  for (const [path, blob] of files) if (path.endsWith('.json') && !jsons.has(blob)) jsons.set(blob, path)
  for (const [blob, path] of jsons) {
    let value: unknown
    try {
      value = JSON.parse(await blob.text())
    } catch {
      continue
    }
    const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''
    // Art named by the card comes into this browser's storage; art it cannot find is left off
    const art = async (placed?: Art) => {
      if (!placed || placed.src.startsWith('data:') || placed.src.startsWith('/')) return placed
      const file = files.get(folder + placed.src) ?? files.get(placed.src)
      return file && { ...placed, src: await readArtFile(new File([file], placed.src)) }
    }
    for (const card of (Array.isArray(value) ? value : [value]).filter(isCard)) {
      const prescient = card.prescient?.art && { ...card.prescient, art: await art(card.prescient.art) }
      cards.push({ ...card, art: await art(card.art), backArt: await art(card.backArt), ...(prescient && { prescient }) })
    }
  }
  return cards
}

// Draws a card side as a JPG at the frame's own size, off the page: what Export writes
// and what a public card shows (or, asked, in another format and size: the print files).
// The stage must be on the page while drawing.
function useCardDrawer() {
  const [drawing, setDrawing] = useState<{ card: Card; back: boolean } | null>(null)
  const holder = useRef<HTMLDivElement>(null)
  // Once its pictures have loaded
  const draw = async (card: Card, back: boolean, format: ImageFormat = 'jpg', scale = 1) => {
    flushSync(() => setDrawing({ card, back }))
    // Asked from an effect, while React is still putting the page up, the stage only comes a frame later
    if (!holder.current) await new Promise(requestAnimationFrame)
    const el = holder.current?.querySelector<HTMLElement>('.card')
    if (!el) throw new Error('Nothing to draw')
    await document.fonts.ready
    await Promise.all(
      [...el.querySelectorAll('img')].map((img) => (img.complete ? null : new Promise((done) => img.addEventListener('load', done, { once: true })))),
    )
    await new Promise((done) => setTimeout(done, 150)) // the art's size is worked out once it has loaded
    return cardImage(el, cardSide(card, back).frame, format, scale)
  }
  const stage = drawing && (
    <div className="publish-stage" ref={holder}>
      <CardFace card={drawing.card} back={drawing.back} />
    </div>
  )
  return { draw, stage, done: () => setDrawing(null) }
}

// The Simulator's Prescient copies: each card drawn in full art, once, as an image. The stage
// must be on the page.
function usePrescientDrawer() {
  const drawer = useCardDrawer()
  const drawCard = async (card: Card) => {
    try {
      return URL.createObjectURL(await drawer.draw(prescientOf(card), false))
    } finally {
      drawer.done()
    }
  }
  return { drawCard, stage: drawer.stage }
}

// Export: the cards shown, set by set. Each card side is drawn as a JPG and kept with
// a .json of the card, for Import to bring back. On this computer (the dev server)
// they go into public/showcase/<SET>; on the site into a .zip.
// Import: brings cards back from those .json or .zip files.
// first: put before the buttons (the Showroom's Missing image filter)
function CardFiles(props: { cards: Card[]; onImport: (cards: Card[]) => string; first?: ReactNode }) {
  const { cards, onImport } = props
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Replace the whole set with the cards shown, rather than update the cards shown in it
  const [replace, setReplace] = useState(false)
  const { draw, stage, done: doneDrawing } = useCardDrawer()
  const picker = useRef<HTMLInputElement>(null)
  const mode = import.meta.env.DEV ? 'dev' : 'zip'
  const bySet = new Map<string, Card[]>()
  for (const card of cards) {
    const set = card.setCode?.trim().toUpperCase()
    // The site's showcases are by set; elsewhere a card without one still goes out
    const folder = set && /^[A-Z0-9_-]+$/.test(set) ? set : mode === 'dev' ? undefined : 'Cards'
    if (folder) bySet.set(folder, [...(bySet.get(folder) ?? []), card])
  }
  const skipped = cards.length - [...bySet.values()].reduce((count, list) => count + list.length, 0)

  const exportCards = async () => {
    setBusy(true)
    try {
      const target = mode === 'dev' ? devTarget() : await zipTarget([...bySet.keys()])
      for (const [set, list] of bySet) {
        // What the set has already: the cards exported now update it, the rest stay
        // as they are, unless the whole set is being replaced
        const already = (!replace && (await target.read(set))?.cards) || []
        // A card exported before keeps its place in the set; a new one goes at the end
        const cards = [...already]
        for (const entry of list.map(showcaseEntry)) {
          const at = cards.findIndex((other) => (other.id ? other.id === entry.id : other.image === entry.image))
          if (at >= 0) cards[at] = entry
          else cards.push(entry)
        }
        // Two cards of a name in one set, drafts of a card say, would write over each
        // other's files: those exported now are numbered, the set's others keep the
        // names their files have
        const exporting = (entry: ShowcaseCard) => list.some((card) => card.id === entry.id)
        const used = new Set<string>()
        for (const entry of [...cards.filter((entry) => !exporting(entry)), ...cards.filter(exporting)]) {
          let number = 1
          const named = (name: string) =>
            number === 1 ? name : name.replace(sideSuffix, '') + ` (${number})` + (sideSuffix.exec(name)?.[0] ?? '')
          while (used.has(named(entry.image).toLowerCase())) number++
          entry.image = named(entry.image)
          entry.back = entry.back && named(entry.back)
          used.add(entry.image.toLowerCase())
        }
        let done = 0
        for (const card of list) {
          setStatus(`Exporting ${set}: card ${done + 1} of ${list.length}…`)
          const names = cards.find((entry) => entry.id === card.id)!
          const sides = backFrameOf(card) ? [false, true] : [false]
          for (const back of sides) await target.write(set, `${back ? names.back : names.image}.jpg`, await draw(card, back))
          const portable = await portableCard(card, names)
          for (const { name, body } of portable.files) await target.write(set, name, body)
          await target.write(set, `${names.image}.json`, JSON.stringify(portable.card, null, 2))
          done++
        }
        const showcase: ShowcaseList = { title: set, cards }
        await target.write(set, 'showcase.json', JSON.stringify(showcase, null, 2))
        // The set's files now, which leaves out those of cards renamed since
        const files = cards.flatMap((card) => [
          ...[card.image, ...(card.back ? [card.back] : [])].flatMap((name) => [`${name}.jpg`, ...artFileNames(name)]),
          ...artFileNames(card.image, 'prescient art'),
          `${card.image}.json`,
        ])
        await target.finish(set, [...files, 'showcase.json'])
      }
      const where = await target.done()
      setStatus(
        `Exported ${[...bySet].map(([set, list]) => `${set} (${list.length})`).join(', ')} to ${where}.` +
          (skipped ? ` ${skipped} card${skipped === 1 ? '' : 's'} with no set left out.` : ''),
      )
    } catch (error) {
      // Closing the Save box is not a failure
      setStatus(
        error instanceof DOMException && error.name === 'AbortError'
          ? null
          : `Could not export: ${error instanceof Error ? error.message : error}`,
      )
    }
    doneDrawing()
    setBusy(false)
  }

  const importFiles = async (files: File[]) => {
    if (files.length === 0) return
    setBusy(true)
    try {
      const found = await cardsInFiles(files)
      setStatus(found.length ? onImport(found) : 'No cards in these files')
    } catch (error) {
      setStatus(`Could not import: ${error instanceof Error ? error.message : error}`)
    }
    setBusy(false)
  }

  return (
    <div className="card-files">
      {props.first}
      {cards.length > 0 && (
        <>
          <button
            className="chip"
            type="button"
            disabled={busy || bySet.size === 0}
            title={
              mode === 'dev'
                ? 'Into public/showcase on this computer'
                : 'As a .zip: the card images, and for Import, each card as a .json with its art'
            }
            onClick={exportCards}
          >
            {busy && stage ? 'Exporting…' : `Export ${bySet.size === 1 ? [...bySet.keys()][0] : `${bySet.size} sets`}`}
          </button>
          {mode === 'dev' && (
            <label className="toggle filter-label" title="Otherwise the cards shown are added to their set or updated in it">
              <input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} />
              Replace the whole set
            </label>
          )}
        </>
      )}
      <button
        className="chip"
        type="button"
        disabled={busy}
        title="Cards from the .json or .zip files Export makes"
        onClick={() => picker.current?.click()}
      >
        Import
      </button>
      <input
        ref={picker}
        type="file"
        accept=".json,.zip,application/json,application/zip"
        multiple
        hidden
        onChange={(event) => {
          importFiles([...(event.target.files ?? [])])
          event.target.value = ''
        }}
      />
      {status && <span className="filter-label">{status}</span>}
      {stage}
    </div>
  )
}

function Showroom(props: {
  cards: Card[]
  onEdit: (card: Card) => void
  onRemove: (card: Card) => void
  onImport: (cards: Card[]) => string
  // Signed in: the cards made public, the one being drawn, and how to change one
  published?: Published
  publishing?: string | null
  blocked?: boolean
  onPublic?: (card: Card, makePublic: boolean) => void
  // Signed in: making the Showroom's own page public, and its link
  share?: ReactNode
  // Signed in: each card's submission to be played, and how to submit or withdraw one
  community?: { states: Record<string, CommunityState>; busy: string | null; onSubmit: (card: Card) => void; onWithdraw: (card: Card) => void }
}) {
  const { cards, onEdit, onRemove, onImport, published, publishing, blocked, onPublic, share, community } = props
  // Signed in: only the public cards, the private ones, or those submitted to be played
  const [visibility, setVisibility] = useRemembered<'all' | 'public' | 'private' | 'submitted'>('showroom.visibility', 'all')
  const isPublic = (card: Card) => !!published?.[card.id!]
  const seen = !published
    ? cards
    : cards.filter((card) =>
        visibility === 'public'
          ? isPublic(card)
          : visibility === 'private'
            ? !isPublic(card)
            : visibility === 'submitted'
              ? !!community?.states[card.id!]
              : true,
      )
  const visibilityChips = published && (
    <>
      {(
        [
          ['public', 'Public', cards.filter(isPublic).length],
          ['private', 'Private', cards.filter((card) => !isPublic(card)).length],
          ...(community ? [['submitted', 'Submitted for play', Object.keys(community.states).length] as const] : []),
        ] as const
      ).map(([value, label, count]) => (
        <button
          key={value}
          className="chip"
          type="button"
          aria-pressed={visibility === value}
          title={`Only the ${label.toLowerCase()} cards (${count})`}
          onClick={() => setVisibility(visibility === value ? 'all' : value)}
        >
          {label}
        </button>
      ))}
    </>
  )
  const { bar, shown, grid, preview, missingImage } = useCardFilters(
    'showroom',
    seen.map((card) => ({ item: card, facts: cardFacts(card) })),
    undefined,
    undefined,
    undefined,
    undefined,
    // A card with no art (a back side without its own borrows the front's)
    (card) => !card.art?.src,
  )
  // One choice of image format for every card
  const [format, changeFormat] = useImageFormat()

  if (cards.length === 0) {
    return (
      <section className="empty">
        <h2>No cards yet</h2>
        <p>
          Cards saved from the <a href="#creator">Card Creator</a> are displayed here.
        </p>
        <CardFiles cards={[]} onImport={onImport} />
      </section>
    )
  }

  return (
    <section className="showroom">
      {share}
      {bar}
      <CardFiles
        cards={shown.map(({ item }) => item)}
        onImport={onImport}
        first={
          <>
            {missingImage}
            {visibilityChips}
          </>
        }
      />

      {shown.length === 0 ? (
        <p className="empty-note">
          No card matches these filters.
          {visibility !== 'all' && published && (
            <>
              {' '}
              <button className="chip" type="button" onClick={() => setVisibility('all')}>
                Show all cards
              </button>
            </>
          )}
        </p>
      ) : (
        <ul className={grid}>
          {shown.map(({ item: card }) => (
            <ShowroomCard
              key={card.id}
              card={card}
              preview={preview}
              format={format}
              onFormat={changeFormat}
              onEdit={() => onEdit(card)}
              onRemove={() => onRemove(card)}
              published={published?.[card.id] ?? null}
              publishing={publishing === card.id}
              blocked={blocked}
              onPublic={onPublic && ((makePublic) => onPublic(card, makePublic))}
              community={
                community && {
                  state: community.states[card.id!],
                  busy: community.busy === card.id || publishing === card.id,
                  onSubmit: () => community.onSubmit(card),
                  onWithdraw: () => community.onWithdraw(card),
                }
              }
            />
          ))}
        </ul>
      )}
    </section>
  )
}

// What a Showcase card can be found and sorted by, from its showcase.json entry
function showcaseFacts(card: ShowcaseCard): Facts {
  return {
    name: card.name,
    type: card.type,
    names: [card.name, card.backName ?? ''].map((name) => name.toLowerCase()),
    traits: card.traits.map((trait) => trait.toLowerCase()),
    traitLabels: card.traits,
    text: card.text ?? '',
    aspects: [...card.aspects, ...(card.backAspects ?? [])],
    cost: card.cost,
    set: card.set ?? '',
    number: card.number ?? '',
    arena: card.arena,
    rarity: card.rarity ?? '',
  }
}

// One card of a Showcase: its image, and Flip for a leader's other side. code: shown with a
// print run's code in place of the artist, drawn from its .json, as a Sealed event prints it.
function ShowcaseItem(props: { folder: string; card: ShowcaseCard; preview: boolean; code?: string }) {
  const { folder, card, preview, code } = props
  const [back, setBack] = useState(false)
  const [prescient, setPrescient] = useState(false)
  const [foil, setFoil] = useState(false)
  const file = back && card.back ? card.back : card.image
  const src = asset(`${folder}/${encodeURIComponent(file)}.jpg`)
  if (code && !back) {
    const drawn = <ShowcaseDrawn folder={folder} image={card.image} fallback={src} code={code} />
    return (
      <li>
        <HoverPreview enabled={preview} preview={drawn}>
          <div className="showcase-drawn" title={`${card.name}: printed with the code ${code}`}>
            {drawn}
          </div>
        </HoverPreview>
        {card.back && (
          <div className="showroom-actions">
            <button className="button" type="button" onClick={() => setBack(true)}>
              Flip
            </button>
          </div>
        )}
      </li>
    )
  }
  // Its Prescient (full art) and foil versions, as the Deck Builder shows them, for anyone
  const side = (name: string, second: boolean) =>
    prescient ? (
      <ShowcaseDrawn folder={folder} image={card.image} fallback={asset(`${folder}/${encodeURIComponent(name)}.jpg`)} prescient back={second} />
    ) : (
      <img className="showcase-image" src={asset(`${folder}/${encodeURIComponent(name)}.jpg`)} alt="" />
    )
  const foiled = (face: ReactNode) => (foil ? <div className="foil">{face}</div> : face)
  const sides = card.back
    ? bothSides(foiled(side(card.image, false)), foiled(side(card.back, true)), card.type === 'Base')
    : { preview: foiled(side(card.image, false)), width: undefined }
  const hover = hoverOf(preview, sides, card.back ? otherSide(foiled(side(back ? card.image : card.back, !back)), card.type === 'Base' || back) : undefined)
  const shown = prescient ? (
    <ShowcaseDrawn folder={folder} image={card.image} fallback={src} prescient back={back && !!card.back} />
  ) : (
    <img
      className="showcase-image"
      src={src}
      alt={back && card.backName ? card.backName : card.name}
      loading="lazy"
      // A PNG saved in place of the JPG
      onError={(event) => {
        const img = event.currentTarget
        if (img.src.endsWith('.jpg')) img.src = img.src.replace(/\.jpg$/, '.png')
      }}
    />
  )
  return (
    <li className="showcase-item">
      <HoverPreview enabled={hover.enabled} preview={hover.preview} width={hover.width}>
        <a href={src} target="_blank" rel="noopener noreferrer" title="Open the full image" className={foil ? 'foil' : undefined}>
          {shown}
        </a>
      </HoverPreview>
      <div className="deck-printings">
        {canBePrescient(card.type) && (
          <button
            className="deck-printing printing-prescient"
            type="button"
            aria-pressed={prescient}
            title={prescient ? 'Prescient: on' : 'Prescient: show the full-art version'}
            onClick={() => setPrescient(!prescient)}
          >
            ◈
          </button>
        )}
        <button
          className="deck-printing printing-foil"
          type="button"
          aria-pressed={foil}
          title={foil ? 'Foil: on' : 'Foil: show the foil version'}
          onClick={() => setFoil(!foil)}
        >
          ✦
        </button>
      </div>
      {card.back && (
        <div className="showroom-actions">
          <button className="button" type="button" onClick={() => setBack(!back)}>
            Flip
          </button>
        </div>
      )}
    </li>
  )
}

// A set of cards shown as images, at an address only those given it know:
// Print files: every card of a Showcase, for a print service such as MakePlayingCards, in a .zip.
// Each side is drawn from its card's .json at twice the frame's size, then made 822 x 1122 with
// the mirrored bleed (see printImage); a card on its side is turned upright, as the card is cut.
// A card with a second side (a leader, a two-sided base) has its own back; a common base has a
// token on its back, so the tokens aren't printed alone; every other card shares the card back.
const PRINT_BACK = asset('/sim/DuneCardBack01.jpg')
const PRINT_QUALITY = 0.95

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`${src} could not be loaded`))
    image.src = src
  })

const canvasBlob = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The card could not be drawn'))), 'image/jpeg', PRINT_QUALITY),
  )

// Upright, as a JPG: a leader or base comes out of printImage on its side
async function uprightJpg(blob: Blob) {
  const url = URL.createObjectURL(blob)
  const image = await loadImage(url).finally(() => URL.revokeObjectURL(url))
  const turn = image.width > image.height
  const canvas = document.createElement('canvas')
  canvas.width = turn ? image.height : image.width
  canvas.height = turn ? image.width : image.height
  const ctx = canvas.getContext('2d')!
  if (turn) {
    ctx.translate(canvas.width, 0)
    ctx.rotate(Math.PI / 2)
  }
  ctx.drawImage(image, 0, 0)
  return canvasBlob(canvas)
}

// The shared card back, covering the card (cropped, not stretched), with the bleed around it
async function printBack() {
  const image = await loadImage(PRINT_BACK)
  const card = document.createElement('canvas')
  card.width = PRINT.width
  card.height = PRINT.height
  const scale = Math.max(PRINT.width / image.width, PRINT.height / image.height)
  const [w, h] = [image.width * scale, image.height * scale]
  const ctx = card.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image, (PRINT.width - w) / 2, (PRINT.height - h) / 2, w, h)
  return canvasBlob(printImage(card, false))
}

// Which token goes on the back of a common base: Sietch Tabr's is the Fremen token, the others' Spice
function tokensBehindBases(cards: ShowcaseCard[]) {
  const tokens = cards.filter((card) => card.type === 'Token')
  const behind = new Map<ShowcaseCard, ShowcaseCard>()
  if (tokens.length === 0) return behind
  const named = (name: string) => tokens.find((token) => token.name === name)
  for (const base of cards.filter((card) => card.type === 'Base' && !card.back))
    behind.set(base, (base.name === 'Sietch Tabr' && named('Fremen')) || named('Spice') || tokens[0])
  return behind
}

// What a print .zip holds: every card to print, one file each, in the order they are printed
// (for a Sealed event, pack after pack), and text files beside. tag: put before the card's name,
// "P1-2" for player 1's pack 2. prescient: drawn as its full-art Prescient version. code: printed
// in place of the artist (see printCode).
type PrintCard = { entry: ShowcaseCard; prescient?: boolean; tag?: string; code?: string }

// A Sealed print run's code on each card, to put the packs back together and reprint one:
// "A07-12" is run A, pack 07 of the event, its 12th card. The next event is run B.
const printCode = (run: string, pack: number, card: number) =>
  `${run}${String(pack).padStart(2, '0')}-${String(card).padStart(2, '0')}`
const PRINT_RUNS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
type PrintJob = {
  name: string
  cards: PrintCard[]
  // Cards in a deck at most (MakePlayingCards' biggest holds 612); more go into a second deck
  deckSize: number
  // Spare two-sided tokens filling each deck's free slots up to the size it is priced at
  // (see PRINT_DECK_SIZES), at most `max` in all
  spares?: { front: ShowcaseCard; back: ShowcaseCard; max: number }
  notes: (decks: number[], spares: number) => Record<string, string>
}

// The deck sizes MakePlayingCards prices Custom Game Cards at: a deck costs what the next size up
// from its count does, so the slots left to that size are free
const PRINT_DECK_SIZES = [18, 36, 55, 72, 90, 108, 126, 144, 162, 180, 198, 216, 234, 396, 504, 612]
// Spare Fremen / Spice tokens a Sealed event's decks are filled with, at most
const PRINT_SPARE_TOKENS = 20

const EVENT_MAX_PLAYERS = 8
// MakePlayingCards' biggest deck
const PRINT_DECK_MAX = 612

function PrintFiles(props: { folder: string; cards: ShowcaseCard[] }) {
  const { folder, cards } = props
  const { draw, stage, done: doneDrawing } = useCardDrawer()
  const [status, setStatus] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ at: number; of: number; name: string } | null>(null)
  const [asking, setAsking] = useState(false)
  const [players, setPlayers] = useRemembered(`showcase.${folder}.event-players`, '8')
  const [printRun, setPrintRun] = useRemembered(`showcase.${folder}.event-run`, 'A')
  const runLetter = PRINT_RUNS.includes(printRun) ? printRun : 'A'
  // Each run's deal: run, players and this number seed it, so a run deals the same packs every
  // time it is opened; Deal again moves the run on to its next deal
  const [deals, setDeals] = useRemembered<Record<string, number>>(`showcase.${folder}.event-deals`, {})
  // Shown counting from 1
  const dealNumber = (deals[runLetter] ?? 0) + 1
  // The deal shown in the Sealed event window, and whose packs; Make the files prints this one
  const [plan, setPlan] = useState<EventPlan<ShowcaseCard> | null>(null)
  const [viewed, setViewed] = useState(1)
  // Pressed again while drawing: it stops after the card being drawn, and nothing is saved
  const stopping = useRef(false)
  const set = folder.split('/').pop() ?? 'Cards'
  const sorted = [...cards].sort((a, b) => (a.number ?? '').localeCompare(b.number ?? '', undefined, { numeric: true }))
  const behind = tokensBehindBases(sorted)
  // Tokens all on the backs of bases aren't printed again alone
  const printable = behind.size > 0 ? sorted.filter((card) => card.type !== 'Token') : sorted
  // Spare tokens for a Sealed event: Fremen on one side, Spice on the other
  const tokenNamed = (name: string) => sorted.find((card) => card.type === 'Token' && card.name === name)
  const spareFront = tokenNamed('Fremen')
  const spareBack = tokenNamed('Spice')
  const spareTokens = spareFront && spareBack ? { front: spareFront, back: spareBack } : undefined
  const tokenNote = [...new Set(behind.values())]
    .map((token) => `${token.name} behind ${[...behind].filter(([, t]) => t === token).map(([base]) => base.name).join(', ')}`)
    .join('; ')
  const label = (entry: ShowcaseCard) => [entry.name, entry.subtitle].filter(Boolean).join(', ')
  const layoutNote = (count: number, deckCounts: number[], spares = 0) => {
    const decks = deckCounts.length
    return [
    'Each image is 822 x 1122 pixels at 300 dpi: a poker-size card (2.5 x 3.5 inches; fits 63 x 88 mm) with a 1/8 inch',
    'mirrored bleed on each side. Corners are square: the printer rounds them when it cuts.',
    '',
    `One file per card to print, ${count} in all, numbered in the order they are printed: fronts/ and backs/ hold the same`,
    `names, each back for the front of the same name: a leader's unit side, a two-sided base's second side${tokenNote ? `, a common base's token (${tokenNote})` : ''},`,
    'or else the card back.',
    ...(decks > 1
      ? ['', `${decks} decks: more cards than one MakePlayingCards deck holds (${PRINT_DECK_MAX}). Each deck has its own folder; order each one apart.`]
      : []),
    ...(spares
      ? [
          `${spares} spare two-sided tokens fill the decks' free slots (a deck costs what the next size up from its count does):`,
          `${deckCounts.join(' + ')} cards, ordered as decks of ${deckCounts.map((n) => PRINT_DECK_SIZES.find((size) => size >= n) ?? n).join(' + ')}.`,
        ]
      : []),
    '',
    'On MakePlayingCards: Custom Game Cards (63 x 88 mm), the deck size the next one up from the card count, Different images',
    'for the fronts: Upload images, select all of fronts/ (Ctrl+A, sorted by name), then "Help me autofill images". Then the',
    'same for the backs with backs/. The autofill fills the cards in the order the images were uploaded, so upload them sorted',
    'by name, all at once or in batches in order, and each card gets its own back. Placing 360 images takes it a few minutes.',
    '',
  ]
  }

  const setJob = (): PrintJob => ({
    name: `${set} print files.zip`,
    cards: printable.map((entry) => ({ entry })),
    deckSize: PRINT_DECK_MAX,
    notes: (decks) => ({ 'README.txt': [`${set}: ${printable.length} cards, one of each, in set order.`, ...layoutNote(printable.length, decks)].join('\n') }),
  })

  const eventJob = (count: number, run: string, deal: number, { packs, copies, prescient }: EventPlan<ShowcaseCard>): PrintJob => {
    const total = packs.length * EVENT_PACK_SIZE
    const different = copies.size + prescient.size
    const packsText = [
      `${set} Sealed event, print run ${run}, deal ${deal}: ${count} player${count === 1 ? '' : 's'}, ${EVENT_PACKS} packs each, ${EVENT_PACK_SIZE} cards a pack.`,
      'The cards are printed in this order: each pack is the next 15 cards off the deck. On each line: the file number, the',
      `code printed on the card in place of the artist (${printCode(run, 7, 12)}: run ${run}, pack 07, its 12th card), and the set number.`,
      '',
      ...packs.flatMap((pack, p) => [
        `Pack ${run}${String(p + 1).padStart(2, '0')}: player ${pack.player}, pack ${pack.pack}`,
        ...pack.cards.map(
          ({ card, slot, prescient }, c) =>
            `  [ ] ${String(p * EVENT_PACK_SIZE + c + 1).padStart(4, '0')}  ${printCode(run, p + 1, c + 1)}  ${card.number ?? '---'} ${label(card)} (${slot === 'Wild' ? `Wild ${card.rarity ?? ''}, prescient` : prescient ? `${slot}, prescient` : slot})`,
        ),
        '',
      ]),
    ].join('\n')
    const csv = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)
    const runRows = [
      ...[...copies.entries()].map(([entry, n]) => ({ entry, n, printing: 'normal' })),
      ...[...prescient.entries()].map(([entry, n]) => ({ entry, n, printing: 'prescient' })),
    ].sort((a, b) => (a.entry.number ?? '').localeCompare(b.entry.number ?? '', undefined, { numeric: true }))
    const runCsv = [
      'number,name,type,rarity,printing,copies',
      ...runRows.map(({ entry, n, printing }) => [entry.number ?? '', label(entry), entry.type, entry.rarity ?? '', printing, String(n)].map(csv).join(',')),
    ].join('\n')
    return {
      name: `${set} Sealed event ${run} deal ${deal} ${count} player${count === 1 ? '' : 's'}.zip`,
      cards: packs.flatMap((pack, p) =>
        pack.cards.map(({ card, prescient }, c) => {
          const code = printCode(run, p + 1, c + 1)
          return { entry: card, prescient: !!prescient, tag: `${code} P${pack.player}-${pack.pack}`, code }
        }),
      ),
      // A deck ends with a whole pack
      deckSize: Math.floor(PRINT_DECK_MAX / EVENT_PACK_SIZE) * EVENT_PACK_SIZE,
      spares: spareTokens && { ...spareTokens, max: PRINT_SPARE_TOKENS },
      notes: (decks, spares) => ({
        'packs.txt': packsText,
        'print run.csv': runCsv + '\n',
        'README.txt': [
          `${set} Sealed event for ${count} player${count === 1 ? '' : 's'}: ${packs.length} packs of ${EVENT_PACK_SIZE}, ${total} cards, ${different} different.`,
          'A pack: a leader (rare one pack in 6) and a base (each player gets the 4 common bases and 2 different two-sided rare ones), 8 commons, 3 uncommons, a rare or legendary, and a wild card',
          '(any rarity, as often as each is in a pack, printed as its full-art Prescient version). One leader in 6 is Prescient too,',
          'both sides, and one base in 6, with its token Prescient on the back. No pack has the same card twice.',
          'The cards go pack after pack, so the printed deck comes in packs: "P1-2" in a file name is player 1, pack 2.',
          `Each card carries its code where the artist goes: ${printCode(run, 7, 12)} is print run ${run}, pack 07, its 12th card. Sort a`,
          'mixed pile by code to put the packs back together; to reprint a pack, print its 15 files again.',
          'packs.txt lists each pack, print run.csv how many of each card.',
          `These are print run ${run}, deal ${deal}. The Sealed event window deals the same packs again for run ${run}, deal ${deal} and`,
          `${count} player${count === 1 ? '' : 's'}, as long as the set's cards have not changed since; packs.txt is the record either way.`,
          '',
          ...layoutNote(total + spares, decks, spares),
        ].join('\n'),
      }),
    }
  }

  const run = async (job: () => PrintJob) => {
    if (progress) {
      stopping.current = true
      return
    }
    setAsking(false)
    // Planned before the folder is asked for, which must come straight after the click
    const plan = job()
    const sink = await printSink(plan.name.replace(/\.zip$/, ''))
    if (!sink) return // Cancelled
    stopping.current = false
    setStatus(null)
    let written = 0
    let resumed = 0
    try {
      const loaded = new Map<string, Card>()
      const cardOf = async (entry: ShowcaseCard) => {
        const found = loaded.get(entry.image) ?? (await loadShowcaseCard(folder, entry.image))
        if (!found) throw new Error(`${entry.image}.json could not be loaded`)
        loaded.set(entry.image, found)
        return found
      }
      const drawn = async (card: Card, back: boolean) => new Uint8Array(await (await uprightJpg(await draw(card, back, 'print', 2))).arrayBuffer())
      // The cards deck by deck, then each deck's free slots up to the size it is priced at filled
      // with spare tokens, as many as the job allows
      type Slot = { card?: PrintCard; label: string }
      const decks: Slot[][] = []
      for (const [index, card] of plan.cards.entries()) {
        if (index % plan.deckSize === 0) decks.push([])
        const label = `${card.tag ? `${card.tag} ` : ''}${card.entry.number ?? '000'} ${card.entry.image}${card.prescient ? ' (prescient)' : ''}`
        decks[decks.length - 1].push({ card, label })
      }
      let spares = 0
      if (plan.spares) {
        const room = decks.map((deck) => (PRINT_DECK_SIZES.find((size) => size >= deck.length) ?? deck.length) - deck.length)
        const total = Math.min(plan.spares.max, room.reduce((sum, n) => sum + n, 0))
        const label = `TOKEN ${plan.spares.front.name} - ${plan.spares.back.name}`
        for (const [d, free] of room.entries()) for (let i = 0; i < free && spares < total; i++, spares++) decks[d].push({ label })
      }
      // Each card is written as soon as it is drawn, so only a few are ever held: the backs, which
      // are few and shared, and a front drawn for several cards (one with a print run's code is its own)
      const fronts = new Map<string, Uint8Array>()
      const backs = new Map<string, Uint8Array>()
      const cardBack = new Uint8Array(await (await printBack()).arrayBuffer())
      const spareSide = async (which: 'front' | 'back') => {
        const key = `spare|${which}`
        if (!backs.has(key)) backs.set(key, await drawn(await cardOf(plan.spares![which]), false))
        return backs.get(key)!
      }
      const sidesOf = async (card: PrintCard) => {
        const { entry, prescient, code } = card
        const full = await cardOf(entry)
        // A wild card: its Prescient version, with the shared card back. A Prescient base: its token
        // on the back is Prescient too. A Prescient leader: both its sides
        const face = prescient && canBePrescient(entry.type) ? prescientOf(full) : full
        const frontKey = `${entry.image}${prescient ? '|prescient' : ''}`
        const front = code ? await drawn({ ...face, code }, false) : (fronts.get(frontKey) ?? (await drawn(face, false)))
        if (!code && plan.cards.filter((each) => each.entry === entry && !!each.prescient === !!prescient).length > 1) fronts.set(frontKey, front)
        const token = behind.get(entry)
        if (prescient && !token && !entry.back) return { front, back: cardBack }
        const backKey = `${entry.image}${prescient ? '|prescient' : ''}`
        if (!backs.has(backKey)) {
          const tokenCard = token && (await cardOf(token))
          backs.set(
            backKey,
            tokenCard ? await drawn(prescient ? prescientOf(tokenCard) : tokenCard, false) : entry.back ? await drawn(face, true) : cardBack,
          )
        }
        return { front, back: backs.get(backKey)! }
      }
      const total = decks.reduce((sum, deck) => sum + deck.length, 0)
      // One file per card, numbered in order, the same name in fronts/ and backs/; a deck to a folder
      for (const [d, deck] of decks.entries())
        for (const [index, slot] of deck.entries()) {
          if (stopping.current) {
            setStatus(sink.partial ? `Stopped: ${written} of ${total} cards written to ${sink.where}` : 'Stopped: nothing saved')
            return
          }
          setProgress({ at: written + 1, of: total, name: slot.card?.entry.name ?? 'Spare token' })
          const name = `${String(index + 1).padStart(4, '0')} ${slot.label}.jpg`.replace(/[\\/:*?"<>|]/g, '-')
          const dir = decks.length > 1 ? `deck ${d + 1}/` : ''
          // Picking up a run that was cut off: a card written whole is not drawn again
          if ((await sink.has(`${dir}fronts/${name}`)) && (await sink.has(`${dir}backs/${name}`))) {
            written++
            resumed++
            continue
          }
          const sides = slot.card ? await sidesOf(slot.card) : { front: await spareSide('front'), back: await spareSide('back') }
          await sink.put(`${dir}fronts/${name}`, sides.front)
          await sink.put(`${dir}backs/${name}`, sides.back)
          written++
        }
      for (const [name, text] of Object.entries(plan.notes(decks.map((deck) => deck.length), spares)))
        await sink.put(name, new TextEncoder().encode(text))
      const saved = await sink.finish()
      setStatus(resumed ? `${saved} (${resumed} cards were already there)` : saved)
    } catch (err) {
      setStatus(`Not made: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      doneDrawing()
      setProgress(null)
    }
  }

  const count = Math.min(EVENT_MAX_PLAYERS, Math.max(1, Number(players) || 8))
  const eventCards = count * EVENT_PACKS * EVENT_PACK_SIZE
  const dealFor = (players: number, run = runLetter, deal = deals[run] ?? 0) => {
    setPlan(planSealedEvent(printable, players, seededRandom(`${folder}|${run}|${players}|${deal}`)))
    setViewed((was) => Math.min(was, players))
  }
  const dealAgain = () => {
    const deal = (deals[runLetter] ?? 0) + 1
    setDeals({ ...deals, [runLetter]: deal })
    dealFor(count, runLetter, deal)
  }
  const openEvent = () => {
    dealFor(count)
    setAsking(true)
  }
  return (
    <>
      {progress ? (
        <button className="chip" type="button" aria-pressed title={`Drawing ${progress.name}. Press to stop: nothing is saved`} onClick={() => run(setJob)}>
          Stop printing ({progress.at}/{progress.of})
        </button>
      ) : (
        <>
          <button
            className="chip"
            type="button"
            title="Every card once at 822 x 1122 px with a mirrored bleed, upright, fronts and backs, in one .zip for MakePlayingCards and similar services"
            onClick={() => run(setJob)}
          >
            Print files
          </button>
          <button
            className="chip"
            type="button"
            title="The packs of a Sealed event for up to 8 players, and the cards to print for them"
            onClick={openEvent}
          >
            Sealed event
          </button>
        </>
      )}
      {status && !progress && <span className="filter-label print-status">{status}</span>}
      {asking && plan && (
        <Modal title="Sealed event" wide onClose={() => setAsking(false)}>
          <div className="event-preview">
            <p className="account-note">
              Each player opens {EVENT_PACKS} packs of {EVENT_PACK_SIZE}: a leader, a base, 8 commons, 3 uncommons, a rare or legendary and a
              wild card in full art (Prescient). Across their packs, each player gets every common base once and two different two-sided rare bases. Make the files prints the deal shown here: one file per card, pack after pack, so the printed
              deck comes in packs, and a list of what goes in each pack.
            </p>
            <div className="event-bar">
              <label className="event-players">
                Players{' '}
                <select
                  value={String(count)}
                  onChange={(event) => {
                    setPlayers(event.target.value)
                    dealFor(Number(event.target.value))
                  }}
                >
                  {Array.from({ length: EVENT_MAX_PLAYERS }, (_, i) => String(i + 1)).map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label
                className="event-players"
                title={`The letter starting each card's code, printed in place of the artist: ${printCode(runLetter, 7, 12)} is pack 07, its 12th card. Take the next letter for the next event.`}
              >
                Print run{' '}
                <select
                  value={runLetter}
                  onChange={(event) => {
                    setPrintRun(event.target.value)
                    dealFor(count, event.target.value)
                  }}
                >
                  {PRINT_RUNS.map((letter) => (
                    <option key={letter} value={letter}>
                      {letter}
                    </option>
                  ))}
                </select>
              </label>
              <span className="account-note">
                Run {runLetter}, deal {dealNumber}: {plan.packs.length} packs, {eventCards} cards to print, {plan.copies.size + plan.prescient.size} different
                {eventCards > PRINT_DECK_MAX ? ` (two MakePlayingCards decks: one holds ${PRINT_DECK_MAX})` : ''}
              </span>
              <button
                className="chip"
                type="button"
                title={`Run ${runLetter} deals the same packs each time; this moves it on to new ones`}
                onClick={dealAgain}
              >
                Deal again
              </button>
            </div>
            <div className="deck-tabs" role="tablist" aria-label="Player">
              {Array.from({ length: count }, (_, i) => i + 1).map((player) => (
                <button key={player} type="button" role="tab" aria-selected={viewed === player} onClick={() => setViewed(player)}>
                  Player {player}
                </button>
              ))}
            </div>
            {(() => {
              const mine = plan.packs.filter((pack) => pack.player === viewed)
              const names = mine.flatMap((pack) => pack.cards.map(({ card }) => card.name))
              const repeats = names.length - new Set(names).size
              const tops = mine.flatMap((pack) => pack.cards.filter(({ card }) => card.rarity === 'L' || card.rarity === 'R'))
              return (
                <>
                  <p className="account-note">
                    {tops.filter(({ card }) => card.rarity === 'L').length} legendary, {tops.filter(({ card }) => card.rarity === 'R').length} rare
                    {repeats ? `, ${repeats} card${repeats === 1 ? '' : 's'} twice in the pool` : ', no card twice in the pool'}.
                  </p>
                  {mine.map((pack) => {
                    const number = plan.packs.indexOf(pack) + 1
                    return (
                    <section className="event-pack" key={pack.pack}>
                      <h3>
                        Pack {pack.pack} <span className="account-note">({runLetter}{String(number).padStart(2, '0')})</span>
                      </h3>
                      <ul>
                        {pack.cards.map(({ card, slot, prescient }, index) => (
                          <li
                            key={index}
                            className={`event-card event-${slot.toLowerCase()}${prescient ? ' event-wild' : ''}${card.type === 'Leader' || card.type === 'Base' ? ' event-landscape' : ''}`}
                            title={`${[card.name, card.subtitle].filter(Boolean).join(', ')} (${slot}${slot === 'Wild' ? `, ${card.rarity}` : ''}${prescient ? ', Prescient' : ''})`}
                          >
                            {prescient && canBePrescient(card.type) ? (
                              <div className="event-face">
                                <ShowcasePrescient folder={folder} image={card.image} fallback={asset(`${folder}/${encodeURIComponent(card.image)}.jpg`)} />
                              </div>
                            ) : (
                              <img src={asset(`${folder}/${encodeURIComponent(card.image)}.jpg`)} alt={card.name} loading="lazy" />
                            )}
                            <span>{slot === 'Wild' ? `Wild ${card.rarity ?? ''}, Prescient` : prescient ? `${slot}, Prescient` : slot}</span>
                            <span className="event-code">{printCode(runLetter, number, index + 1)}</span>
                          </li>
                        ))}
                      </ul>
                    </section>
                    )
                  })}
                </>
              )
            })()}
            <div className="leave-buttons">
              <button className="button" type="button" onClick={() => setAsking(false)}>
                Cancel
              </button>
              <button className="button button-primary" type="button" onClick={() => run(() => eventJob(count, runLetter, dealNumber, plan))}>
                Make the files
              </button>
            </div>
          </div>
        </Modal>
      )}
      {stage}
    </>
  )
}

// #showcase/<folder>, the folder being public/showcase/<folder> with showcase.json in it
function Showcase(props: { folder: string }) {
  const folder = `/showcase/${props.folder}`
  const [list, setList] = useState<ShowcaseList | null>(null)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    // Asked again of the server each time: the browser keeps it for a while, so a new export would not show
    fetch(asset(`${folder}/showcase.json`), { cache: 'no-cache' })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((data: ShowcaseList) => setList(data))
      .catch(() => setMissing(true))
  }, [folder])
  useEffect(() => {
    // Kept out of search engines, but for DUNE, which has a tab of its own
    if (props.folder === 'DUNE') return
    const robots = document.createElement('meta')
    robots.name = 'robots'
    robots.content = 'noindex'
    document.head.append(robots)
    return () => robots.remove()
  }, [props.folder])
  // The cards shown with an example print run's codes, as a Sealed event prints them
  const [printRunView, setPrintRunView] = useState(false)
  const { bar, shown, grid, preview } = useCardFilters(
    `showcase.${props.folder}`,
    (list?.cards ?? []).map((card) => ({ item: card, facts: showcaseFacts(card) })),
    'Showcase order',
    undefined,
    undefined,
    list && (
      <>
        <PrintFiles folder={folder} cards={list.cards} />
        <button
          className="chip"
          type="button"
          aria-pressed={printRunView}
          title="Show the cards as a Sealed event prints them: a code in place of the artist, A07-12 for run A, pack 07, its 12th card (here the cards shown, 15 to a pack)"
          onClick={() => setPrintRunView(!printRunView)}
        >
          Print run
        </button>
      </>
    ),
  )
  // The set's cards, a Deck Builder that only uses them, and for DUNE, the game simulator, which
  // plays its cards: open to anyone here. The author's other games are in the site's tabs above.
  const [stored, setView] = useRemembered<'cards' | 'decks' | 'play' | 'projects'>(`showcase.${props.folder}.view`, 'cards')
  // My Other Projects was a view here before the site's tabs were on this page
  const view = stored === 'projects' ? 'cards' : stored
  const playable = props.folder === 'DUNE'
  const prescient = usePrescientDrawer()
  useEffect(() => {
    if (list) document.title = list.title
  }, [list])

  if (missing) return <p className="empty-note">There is no showcase here.</p>
  if (!list) return <p className="empty-note">Loading…</p>
  const views = (
    <nav className="tabs showcase-views">
      {(playable ? (['cards', 'decks', 'play'] as const) : (['cards', 'decks'] as const)).map((value) => (
        <a
          key={value}
          href={window.location.hash}
          aria-current={view === value ? 'page' : undefined}
          onClick={(event) => {
            event.preventDefault()
            setView(value)
          }}
        >
          {value === 'cards' ? 'Cards' : value === 'decks' ? 'Deck Builder' : 'Simulator'}
        </a>
      ))}
    </nav>
  )
  if (view === 'play' && playable) {
    return (
      <>
        {views}
        <Simulator drawCard={prescient.drawCard} />
        {prescient.stage}
      </>
    )
  }
  if (view === 'decks') {
    return (
      <>
        {views}
        <DeckFormats
          cards={list.cards.flatMap((card) => deckCardOfShowcase(folder, card))}
          prefix={`showcase.${props.folder}.decks`}
          storageKey={`dune-unlimited.decks.${props.folder}`}
          source="set"
        />
      </>
    )
  }
  return (
    <section className="showroom">
      {views}
      {bar}
      {shown.length === 0 ? (
        <p className="empty-note">No card matches these filters.</p>
      ) : (
        <ul className={grid}>
          {shown.map(({ item: card }, index) => (
            <ShowcaseItem
              key={card.image}
              folder={folder}
              card={card}
              preview={preview}
              code={printRunView ? printCode('A', Math.floor(index / EVENT_PACK_SIZE) + 1, (index % EVENT_PACK_SIZE) + 1) : undefined}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

// A card someone made public, as the server lists it
type PublicCard = {
  key: string
  userId: number
  cardId: string
  owner: string
  entry: ShowcaseCard
  image: string
  backImage: string | null
  publishedAt: string
  hidden: boolean
  // Its owner may no longer make cards public
  ownerBlocked: boolean
  // Its owner's Showroom has a page of its own
  ownerShowroom?: boolean
}

// A public card the Community tab can show; an older or odd one is left out rather than
// breaking the tab
const showable = (card: PublicCard) => {
  const entry = card.entry as Partial<ShowcaseCard> | null
  return (
    !!entry &&
    typeof entry.name === 'string' &&
    typeof entry.type === 'string' &&
    Array.isArray(entry.traits) &&
    Array.isArray(entry.aspects) &&
    (entry.backAspects == null || Array.isArray(entry.backAspects))
  )
}

const publicImage = (id: string) => `${API_URL}/api/public/images/${id}`

// Copies a link, saying so for a moment
function CopyLinkButton(props: { link: string; label?: string }) {
  const { link, label = 'Copy link' } = props
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="button"
      type="button"
      title={link}
      onClick={() =>
        navigator.clipboard.writeText(link).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        })
      }
    >
      {copied ? 'Copied' : label}
    </button>
  )
}

// Everyone's public cards, as a Showcase shows a set: newest first, with the same
// search and filters, and who made each. Admins can hide a card from it.
// When this browser last looked at the Community tab: the newest card it showed then
const COMMUNITY_SEEN = 'dune-unlimited.community-seen'

const newestPublished = (cards: PublicCard[]) => Math.max(0, ...cards.map((card) => Date.parse(card.publishedAt)))

function communitySeen() {
  try {
    const seen = localStorage.getItem(COMMUNITY_SEEN)
    return seen === null ? 0 : Number(seen)
  } catch {
    return 0
  }
}

function markCommunitySeen(cards: PublicCard[]) {
  const newest = newestPublished(cards)
  if (newest <= communitySeen()) return
  try {
    localStorage.setItem(COMMUNITY_SEEN, String(newest))
  } catch {
    // Shown as new again next time, then
  }
}

// The cards made public since the Community tab was last looked at, other than the
// account's own and those only admins see. Asked when the page opens, then every few minutes.
function useCommunityNew(session: Session | null, online: boolean, looking: boolean) {
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (!online || looking) {
      setCount(0)
      return
    }
    const check = () =>
      api<{ cards: PublicCard[] }>('/api/public/cards', { token: session?.token })
        .then(({ cards }) => {
          const seen = communitySeen()
          setCount(
            cards.filter(
              (card) =>
                showable(card) &&
                !card.hidden && !card.ownerBlocked && card.userId !== session?.user.id && Date.parse(card.publishedAt) > seen,
            ).length,
          )
        })
        .catch(() => {})
    check()
    const timer = window.setInterval(check, 5 * 60 * 1000)
    return () => window.clearInterval(timer)
  }, [online, looking, session?.token])
  return count
}

// A supported community card, as the Community Deck Builder plays it: the copy an admin
// supported, its images from the server
type CommunityCard = {
  key: string
  userId: number
  cardId: string
  version: number
  owner: string
  entry: ShowcaseCard
  image: string
  backImage: string | null
}

// Its set in the Community Deck Builder: the set code its maker gave it, with the maker's name, so
// two makers' sets of the same code stay apart
const communitySet = (card: CommunityCard) => `${card.entry.set?.toUpperCase() || 'NO SET'} (${card.owner})`

function deckCardOfCommunity(card: CommunityCard): DeckCard[] {
  const entry = card.entry
  const set = communitySet(card)
  const make = (side: ShowcaseCard, id: string, image: string, backImage?: string | null): DeckCard => {
    const label = [side.name, side.subtitle].filter(Boolean).join(', ')
    const src = publicImage(image)
    const deckCard: DeckCard = {
      id,
      name: side.name,
      subtitle: side.subtitle,
      label,
      type: side.type,
      arena: side.arena,
      icons: side.type === 'Leader' ? [...new Set(side.aspects)] : side.aspects,
      cost: side.cost,
      rarity: side.rarity ?? '',
      traits: side.traits,
      set,
      number: side.number,
      max: maxCopies(side.text ?? ''),
      facts: { ...showcaseFacts(side), set },
      face: <img className="showcase-image" src={src} alt={label} loading="lazy" />,
      backFace:
        side.type === 'Leader' && backImage ? (
          <img className="showcase-image" src={publicImage(backImage)} alt={side.backName ?? label} loading="lazy" />
        ) : undefined,
    }
    return {
      ...deckCard,
      // The deck image is laid out out of sight, where a lazy image never loads: loaded first
      forImage: async () => {
        const picture = new Image()
        picture.src = src
        await picture.decode().catch(() => undefined)
        return { ...deckCard, face: <img className="showcase-image" src={src} alt={label} /> }
      },
    }
  }
  const id = `community:${card.key}`
  // A two-sided base is two bases, one per side, as in a Showcase
  if (entry.type === 'Base' && card.backImage && entry.backAspects)
    return [
      { ...make({ ...entry, back: undefined, backAspects: undefined }, id, card.image), label: sideLabel(entry.name, entry.aspects) },
      {
        ...make({ ...entry, aspects: entry.backAspects }, id + BACK_SIDE, card.backImage),
        label: sideLabel(entry.name, entry.backAspects),
        back: true,
      },
    ]
  return [make(entry, id, card.image, card.backImage)]
}

// The Community Deck Builder: the supported community cards, each maker's set its own, and
// DUNE's, left out of a deck until it is ticked
function CommunityDecks() {
  const [cards, setCards] = useState<DeckCard[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    Promise.all([
      api<{ cards: CommunityCard[] }>('/api/community/cards'),
      fetch(asset('/showcase/DUNE/showcase.json'), { cache: 'no-cache' })
        .then((response) => (response.ok ? (response.json() as Promise<ShowcaseList>) : null))
        .catch(() => null),
    ])
      .then(([community, dune]) => {
        if (!live) return
        setCards([
          ...community.cards.filter((card) => showable({ entry: card.entry } as PublicCard)).flatMap(deckCardOfCommunity),
          ...(dune?.cards ?? []).flatMap((card) => deckCardOfShowcase('/showcase/DUNE', card)),
        ])
      })
      .catch((err) => live && setError(err.message))
    return () => {
      live = false
    }
  }, [])
  if (error) return <p className="empty-note">{error}</p>
  if (!cards) return <p className="empty-note">Loading the community's cards…</p>
  return (
    <>
      {!cards.some((card) => card.id.startsWith('community:')) && (
        <p className="account-note community-intro">
          No community card is playable yet. Make a card public in your Showroom, then Submit for play: once it is supported, it is
          here. DUNE's cards are here too, for a deck that ticks DUNE in its Sets.
        </p>
      )}
      <DeckBuilder cards={cards} prefix="community.decks" storageKey="dune-unlimited.decks.community" offByDefault={['DUNE']} />
    </>
  )
}

// The Community tab: everyone's public cards, a Deck Builder of the cards made playable, and a
// Simulator that plays them against the AI, as the DUNE page's does
function CommunityPage(props: { session: Session | null }) {
  const [view, setView] = useRemembered<'cards' | 'decks' | 'play'>('community.view', 'cards')
  // DUNE's cards drawn in full art, for the Prescient copies a deck plays
  const prescient = usePrescientDrawer()
  const views = (
    <nav className="tabs showcase-views">
      {(['cards', 'decks', 'play'] as const).map((value) => (
        <a
          key={value}
          href={window.location.hash}
          aria-current={view === value ? 'page' : undefined}
          onClick={(event) => {
            event.preventDefault()
            setView(value)
          }}
        >
          {value === 'cards' ? 'Cards' : value === 'decks' ? 'Deck Builder' : 'Simulator'}
        </a>
      ))}
    </nav>
  )
  return (
    <>
      {views}
      {view === 'cards' && <Community session={props.session} />}
      {view === 'decks' && <CommunityDecks />}
      {view === 'play' && (
        <>
          <Simulator pool="community" drawCard={prescient.drawCard} />
          {prescient.stage}
        </>
      )}
    </>
  )
}

// owner: one account's public Showroom (#showroom/<name>) instead of everyone's cards: its
// public cards, in the order it made them
function Community(props: { session: Session | null; owner?: string | null }) {
  const { session, owner } = props
  const [list, setList] = useState<PublicCard[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The Showroom's page as its owner sees it while it isn't public yet
  const [ownerOnly, setOwnerOnly] = useState(false)
  const admin = !!session?.user.isAdmin
  useEffect(() => {
    setList(null)
    setError(null)
    if (owner)
      api<{ owner: string; public: boolean; cards: PublicCard[] }>(`/api/public/showroom/${encodeURIComponent(owner)}`, {
        token: session?.token,
      })
        .then((data) => {
          setList(data.cards.filter(showable))
          setOwnerOnly(!data.public)
        })
        .catch((err) => setError(err.message))
    else
      api<{ cards: PublicCard[] }>('/api/public/cards', { token: session?.token })
        .then((data) => {
          setList(data.cards.filter(showable))
          // Seen now: the tab's count starts again from these
          markCommunitySeen(data.cards)
        })
        .catch((err) => setError(err.message))
  }, [session?.token, owner])
  const { bar, shown, grid, preview } = useCardFilters(
    owner ? 'public-showroom' : 'community',
    (list ?? []).map((card) => ({
      item: card,
      // The maker's name is searched with the card's
      facts: (() => {
        const facts = showcaseFacts(card.entry)
        return { ...facts, names: [...facts.names, card.owner.toLowerCase()] }
      })(),
    })),
    owner ? undefined : 'Newest first',
  )

  const hide = async (card: PublicCard, hidden: boolean) => {
    try {
      await api(`/api/admin/cards/${card.userId}/${encodeURIComponent(card.cardId)}`, {
        method: 'PATCH',
        body: { hidden },
        token: session?.token,
      })
      setList((cards) => cards && cards.map((other) => (other.key === card.key ? { ...other, hidden } : other)))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const own = !!owner && owner.toLowerCase() === session?.user.username.toLowerCase()
  const heading = owner && (
    <div className="public-showroom-head">
      <h2>{list && list[0] ? list[0].owner : owner}'s Showroom</h2>
      <CopyLinkButton link={showroomLink(owner)} />
      <a className="button" href="#community">
        Community
      </a>
      {own && ownerOnly && <p className="account-note">Only you see this page: your Showroom isn't public.</p>}
    </div>
  )
  if (owner && error && !list)
    return (
      <section className="showroom">
        {heading}
        <p className="empty-note">{error}</p>
      </section>
    )
  if (error && !list) return <p className="empty-note">{error}</p>
  if (!list) return <p className="empty-note">Loading…</p>
  if (owner && list.length === 0)
    return (
      <section className="showroom">
        {heading}
        <p className="empty-note">
          {own ? 'None of your cards is public yet: make some public in your Showroom.' : 'No public cards here yet.'}
        </p>
      </section>
    )
  if (list.length === 0)
    return (
      <section className="empty">
        <h2>No public cards yet</h2>
        <p>Signed in, a card in your Showroom can be made public: it then shows here, for everyone.</p>
      </section>
    )
  return (
    <section className="showroom">
      {heading}
      {bar}
      {error && <p className="account-error">{error}</p>}
      {shown.length === 0 ? (
        <p className="empty-note">No card matches these filters.</p>
      ) : (
        <ul className={grid}>
          {shown.map(({ item: card }) => (
            <CommunityItem
              key={card.key}
              card={card}
              preview={preview}
              byline={!owner}
              session={admin ? session : null}
              onHide={(hidden) => hide(card, hidden)}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

// byline: who made it, under it (not in their own Showroom)
function CommunityItem(props: {
  card: PublicCard
  preview: boolean
  byline: boolean
  session: Session | null
  onHide: (hidden: boolean) => void
}) {
  const { card, preview, byline, session, onHide } = props
  const admin = !!session
  const [back, setBack] = useState(false)
  const id = back && card.backImage ? card.backImage : card.image
  const name = back && card.entry.backName ? card.entry.backName : card.entry.name
  // Off the tab for everyone else: an admin still sees it, greyed out
  const off = card.hidden || card.ownerBlocked
  // Its image isn't public any more, so an admin fetches it signed in
  const [adminSrc, setAdminSrc] = useState<string | null>(null)
  useEffect(() => {
    if (!off || !session) return
    let url: string | null = null
    fetch(`${API_URL}/api/admin/public-images/${id}`, { headers: { Authorization: `Bearer ${session.token}` } })
      .then((res) => (res.ok ? res.blob() : Promise.reject()))
      .then((blob) => setAdminSrc((url = URL.createObjectURL(blob))))
      .catch(() => setAdminSrc(null))
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [off, session, id])
  const src = off ? adminSrc : publicImage(id)
  const image = src && <img className="showcase-image" src={src} alt={name} loading="lazy" />
  const sides = card.backImage
    ? bothSides(
        <img className="showcase-image" src={publicImage(card.image)} alt="" />,
        <img className="showcase-image" src={publicImage(card.backImage)} alt="" />,
        card.entry.type === 'Base',
      )
    : { preview: <img className="showcase-image" src={src!} alt="" />, width: undefined }
  const hover = hoverOf(
    preview,
    sides,
    card.backImage
      ? otherSide(<img className="showcase-image" src={publicImage(back ? card.image : card.backImage)} alt="" />, card.entry.type === 'Base' || back)
      : undefined,
  )

  return (
    <li className={off ? 'community-off' : undefined}>
      {off ? (
        <div title={card.hidden ? 'Hidden by an admin' : 'Its owner may not make cards public'}>
          {image ?? <div className="community-placeholder">{name}</div>}
        </div>
      ) : (
        <HoverPreview enabled={hover.enabled} preview={hover.preview} width={hover.width}>
          <a href={src!} target="_blank" rel="noopener noreferrer" title="Open the full image">
            {image}
          </a>
        </HoverPreview>
      )}
      {byline && (
        <p className="community-owner">
          by{' '}
          {admin ? (
            <button className="community-owner-link" type="button" title="Open this account in the Admin panel" onClick={() => openAdminPanel(card.userId)}>
              {card.owner}
            </button>
          ) : card.ownerShowroom ? (
            <a className="community-owner-link" href={`#showroom/${card.owner}`} title={`See ${card.owner}'s Showroom`}>
              {card.owner}
            </a>
          ) : (
            card.owner
          )}
          {admin && card.ownerShowroom && (
            <>
              {' · '}
              <a className="community-owner-link" href={`#showroom/${card.owner}`} title={`See ${card.owner}'s Showroom`}>
                Showroom
              </a>
            </>
          )}
          {card.ownerBlocked && <span className="community-flag"> · may not publish</span>}
        </p>
      )}
      {(card.backImage || admin) && (
        <div className="showroom-actions">
          {card.backImage && (
            <button className="button icon-button" type="button" aria-label="Flip" title="Show the other side" onClick={() => setBack(!back)}>
              {flipIcon}
            </button>
          )}
          {admin && (
            <button
              className="button"
              type="button"
              title={card.hidden ? 'Put this card back on the Community tab' : 'Take this card off the Community tab for everyone; its owner keeps it'}
              onClick={() => onHide(!card.hidden)}
            >
              {card.hidden ? 'Show again' : 'Hide'}
            </button>
          )}
        </div>
      )}
    </li>
  )
}

// Premier: at least 50 cards, up to 3 copies of a card counting the sideboard, and
// up to 10 cards in the sideboard
const DECK_SIZE = 50
const MAX_COPIES = 3
const SIDEBOARD_SIZE = 10
// A Sealed deck: at least 30 cards, as many copies as the pool has, the rest of the pool its sideboard
const SEALED_DECK_SIZE = 30
// Each aspect icon a card has that the leader and base don't cover costs this much more
const ASPECT_PENALTY = 2

// A card as the Deck Builder knows it, whether a card saved in the Showroom or a card
// of a Showcase, which only has its image and its showcase.json entry: what a deck needs
// to know of it, and how to draw it
type DeckCard = {
  id: string
  name: string
  subtitle?: string
  // The name and subtitle, as the deck's list shows them
  label: string
  type: FrameFilter
  arena?: Arena
  // The aspect icons it is played with; a leader's are its Leader side's
  icons: Aspect[]
  cost?: number
  // The rarity's letter, or empty
  rarity: string
  traits: string[]
  // The set code in capitals, or NO_SET
  set: string
  number?: string
  // How many copies a deck may have
  max: number
  // A two-sided base's second side, offered as a base of its own
  back?: boolean
  facts: Facts
  face: ReactNode
  // A leader's other side, its unit side
  backFace?: ReactNode
  // The card as a booster's Prescient card shows it, for the cards that can be one
  prescientFace?: ReactNode
  // Sealed: the pool's copies of it, and how many of each printing
  pooled?: DeckEntry
  // The same card drawn lighter, for the deck image; its Prescient face too when asked
  forImage?: (prescient?: boolean) => Promise<DeckCard>
}

// How many copies a deck may have: 3, or what the card says ("A deck can have up to 15
// copies of this card", "any number of copies")
function maxCopies(text: string) {
  const rule = /a deck can (?:have|include) (?:up to (\d+)|any number of) copies/.exec(plainText(text))
  if (!rule) return MAX_COPIES
  return rule[1] ? Number(rule[1]) : Infinity
}

// A two-sided base is two bases in the Deck Builder, one per side, each with the aspect
// it is played with: the second's id is the card's with this after it
const BACK_SIDE = '#back'
// The label of one side of a two-sided base: its name, and the aspect of that side
const sideLabel = (label: string, icons: Aspect[]) => `${label} (${icons.join(' ')})`

// A card saved in the Showroom, drawn as it is on the page: one card, or a base's two sides
function deckCardOf(card: Card): DeckCard[] {
  const frame = findFrame(card.frameId)
  const facts = cardFacts(card)
  const deckCard: DeckCard = {
    id: card.id,
    name: card.name,
    subtitle: card.subtitle?.trim() || undefined,
    label: cardLabel(card),
    type: facts.type,
    arena: facts.arena,
    icons: frame.aspects,
    cost: card.cost,
    rarity: facts.rarity,
    traits: splitTraits(card.trait),
    set: facts.set.toUpperCase() || NO_SET,
    number: facts.number || undefined,
    max: maxCopies(card.text),
    facts,
    face: <CardFace card={card} />,
    backFace: facts.type === 'Leader' ? <CardFace card={card} back /> : undefined,
    prescientFace: canBePrescient(facts.type) ? <CardFace card={prescientOf(card)} /> : undefined,
  }
  const second = isTwoSidedBase(card) ? backFrameOf(card) : undefined
  if (!second)
    return [
      {
        ...deckCard,
        forImage: async (prescient) => {
          const small = await withSmallArt(card)
          return { ...deckCard, face: <CardFace card={small} />, prescientFace: prescient ? <CardFace card={prescientOf(small)} /> : undefined }
        },
      },
    ]
  const side = (back: boolean): DeckCard => {
    const icons = back ? second.aspects : frame.aspects
    const each: DeckCard = {
      ...deckCard,
      id: back ? card.id + BACK_SIDE : card.id,
      label: sideLabel(deckCard.label, icons),
      icons,
      back: back || undefined,
      facts: { ...facts, aspects: icons },
      face: <CardFace card={card} back={back} />,
    }
    return { ...each, forImage: async () => ({ ...each, face: <CardFace card={await withSmallArt(card)} back={back} /> }) }
  }
  return [side(false), side(true)]
}

// A card of a Showcase: its saved image, and what showcase.json says of it. A leader's
// aspects are listed for both its sides there, the same ones twice: kept once. A
// two-sided base is its two sides, as in deckCardOf.
function deckCardOfShowcase(folder: string, card: ShowcaseCard): DeckCard[] {
  if (card.type === 'Base' && card.back && card.backAspects) {
    const sides = [
      { ...card, back: undefined, backAspects: undefined },
      { ...card, id: (card.id ?? card.image) + BACK_SIDE, image: card.back, aspects: card.backAspects, back: undefined, backAspects: undefined },
    ]
    return sides.map((side, index) => {
      const [deckCard] = deckCardOfShowcase(folder, side)
      const which = { label: sideLabel(deckCard.label, side.aspects), back: index === 1 || undefined }
      return { ...deckCard, ...which, forImage: async () => ({ ...(await deckCard.forImage!()), ...which }) }
    })
  }
  const label = [card.name, card.subtitle].filter(Boolean).join(', ')
  const src = asset(`${folder}/${encodeURIComponent(card.image)}.jpg`)
  const deckCard: DeckCard = {
    id: card.id ?? card.image,
    name: card.name,
    subtitle: card.subtitle,
    label,
    type: card.type,
    arena: card.arena,
    icons: card.type === 'Leader' ? [...new Set(card.aspects)] : card.aspects,
    cost: card.cost,
    rarity: card.rarity ?? '',
    traits: card.traits,
    set: card.set?.toUpperCase() || NO_SET,
    number: card.number,
    max: maxCopies(card.text ?? ''),
    facts: showcaseFacts(card),
    face: <img className="showcase-image" src={src} alt={label} loading="lazy" />,
    backFace:
      card.type === 'Leader' && card.back ? (
        <img className="showcase-image" src={asset(`${folder}/${encodeURIComponent(card.back)}.jpg`)} alt={card.backName ?? label} loading="lazy" />
      ) : undefined,
    prescientFace: canBePrescient(card.type) ? <ShowcasePrescient folder={folder} image={card.image} fallback={src} /> : undefined,
  }
  // The deck image is laid out out of sight, where a lazy image never loads: loaded first
  return [
    {
      ...deckCard,
      forImage: async (prescient) => {
        const image = new Image()
        image.src = src
        await image.decode().catch(() => undefined)
        // The Prescient version drawn from the card's .json, its art loaded first
        const full = prescient && canBePrescient(card.type) ? await loadShowcaseCard(folder, card.image) : null
        const art = full && prescientOf(full).art
        if (art) {
          const picture = new Image()
          picture.src = art.src
          await picture.decode().catch(() => undefined)
        }
        return {
          ...deckCard,
          face: <img className="showcase-image" src={src} alt={label} />,
          prescientFace: full ? <CardFace card={prescientOf(full)} /> : undefined,
        }
      },
    },
  ]
}

// A Showcase card as its .json has it, its art found in the Showcase's folder
async function loadShowcaseCard(folder: string, image: string): Promise<Card | null> {
  const inFolder = (art?: Art) => art && { ...art, src: asset(`${folder}/${encodeURIComponent(art.src)}`) }
  try {
    const res = await fetch(asset(`${folder}/${encodeURIComponent(image)}.json`), { cache: 'no-cache' })
    if (!res.ok) return null
    const found: Card = await res.json()
    const prescient = found.prescient && { ...found.prescient, art: inFolder(found.prescient.art) }
    return { ...found, art: inFolder(found.art), backArt: inFolder(found.backArt), prescient }
  } catch {
    return null
  }
}

// A Showcase card's Prescient version: drawn from its .json, as the Showroom draws its cards.
// Its image is shown until the .json has come.
function ShowcasePrescient(props: { folder: string; image: string; fallback: string }) {
  return <ShowcaseDrawn {...props} prescient />
}

// A Showcase card drawn from its .json rather than shown as its image: in full art (prescient),
// or with a print run's code in place of the artist. Its image is shown until the .json has come.
// back: its other side (a leader's unit side, a base's second side)
function ShowcaseDrawn(props: { folder: string; image: string; fallback: string; prescient?: boolean; code?: string; back?: boolean }) {
  const { folder, image, fallback, prescient, code, back } = props
  const [card, setCard] = useState<Card | null>(null)
  useEffect(() => {
    let live = true
    loadShowcaseCard(folder, image).then((found) => live && setCard(found))
    return () => {
      live = false
    }
  }, [folder, image])
  if (!card) return <img className="showcase-image" src={fallback} alt="" />
  // Already full art, with no Prescient art or look of its own: its Prescient version is the card
  // as it is, so its image is shown rather than drawn again, which renders text a little differently
  if (prescient && !code && !card.prescient && card.look?.frameOpacity === 0)
    return <img className="showcase-image" src={fallback} alt="" />
  const face = prescient ? prescientOf(card) : card
  return <CardFace card={code ? { ...face, code } : face} back={back} />
}

const deckGroups = ['Ground units', 'Space units', 'Events', 'Upgrades'] as const
type DeckGroup = (typeof deckGroups)[number]

// Where a card is listed in a deck; leaders, bases and tokens are not deck cards
function deckGroup(card: DeckCard): DeckGroup | undefined {
  if (card.type === 'Unit' || card.type === 'Pilot') return card.arena === 'Space' ? 'Space units' : 'Ground units'
  if (card.type === 'Event') return 'Events'
  if (card.type === 'Upgrade' || card.type === 'Fortification') return 'Upgrades'
  return undefined
}

// How many of a card's aspect icons the leader and base leave uncovered: two Vigilance
// icons need two Vigilance between them
function missingAspects(card: DeckCard, covered: Aspect[]) {
  return aspects.reduce((sum, aspect) => sum + Math.max(0, countOf(card.icons, aspect) - countOf(covered, aspect)), 0)
}

const copiesOf = (entries: DeckEntry[], id: string) => entries.find((entry) => entry.id === id)?.count ?? 0

const deckCount = (entries: DeckEntry[]) => entries.reduce((sum, { count }) => sum + count, 0)

// A copy's printing: plain, or one of the card's other versions
type Printing = 'plain' | CardVersion
// The order a copy is taken out in when none is asked for: plain ones first
const printings: Printing[] = ['plain', ...cardVersions]
const printingLabel: Record<Printing, string> = { plain: 'plain', prescient: 'Prescient', foil: 'foil', 'prescient-foil': 'Prescient foil' }

// How many copies of a card are of that printing
function printingCopies(entries: DeckEntry[], id: string, printing: Printing) {
  const entry = entries.find((each) => each.id === id)
  if (!entry) return 0
  const versions = cardVersions.reduce((sum, version) => sum + (entry.versions?.[version] ?? 0), 0)
  return printing === 'plain' ? entry.count - versions : (entry.versions?.[printing] ?? 0)
}

// The list with one copy more or less of that printing
function withPrinting(entries: DeckEntry[], id: string, printing: Printing, change: number): DeckEntry[] {
  const entry = entries.find((each) => each.id === id) ?? { id, count: 0 }
  const count = entry.count + change
  if (count <= 0) return entries.filter((each) => each.id !== id)
  const versions = { ...entry.versions }
  if (printing !== 'plain') {
    const left = (versions[printing] ?? 0) + change
    if (left > 0) versions[printing] = left
    else delete versions[printing]
  }
  const next: DeckEntry = { id, count, ...(Object.keys(versions).length > 0 && { versions }) }
  return entries.some((each) => each.id === id) ? entries.map((each) => (each.id === id ? next : each)) : [...entries, next]
}

// The printing a copy is taken out as: the one asked for if there is one, else the first there is
const printingToTake = (entries: DeckEntry[], id: string, wanted?: Printing) =>
  wanted && printingCopies(entries, id, wanted) > 0 ? wanted : printings.find((each) => printingCopies(entries, id, each) > 0)

// A card as a printing shows it: Prescient in full art, a foil with its sheen
function printingFace(card: DeckCard, printing: Printing) {
  const face = printing === 'prescient' || printing === 'prescient-foil' ? (card.prescientFace ?? card.face) : card.face
  return printing === 'foil' || printing === 'prescient-foil' ? <div className="foil">{face}</div> : face
}

// The marks of a deck row: how many copies of each printing besides the plain ones
function PrintingMarks(props: { entry?: DeckEntry }) {
  const versions = cardVersions.filter((version) => (props.entry?.versions?.[version] ?? 0) > 0)
  if (!versions.length) return null
  return (
    <span className="printing-marks" title={versions.map((version) => `${props.entry!.versions![version]} ${printingLabel[version]}`).join(', ')}>
      {versions.map((version) => (
        <span key={version} className={`printing-mark printing-${version}`}>
          {props.entry!.versions![version]}
        </span>
      ))}
    </span>
  )
}

function downloadText(fileName: string, text: string) {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
  link.download = fileName.replace(/[\\/:*?"<>|]/g, '')
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 1000)
}

// A deck as a file: each card by its name, set and number as well as its id, so the
// deck still finds its cards in another browser whose cards were imported, not copied
// back: the second side of a two-sided base
type DeckFileCard = {
  count: number
  versions?: DeckEntry['versions']
  name: string
  subtitle?: string
  set?: string
  number?: string
  id: string
  back?: boolean
}
type DeckFile = {
  deck: string
  author?: string
  sets: string[]
  leader?: Omit<DeckFileCard, 'count'>
  base?: Omit<DeckFileCard, 'count'>
  cards: DeckFileCard[]
  sideboard: DeckFileCard[]
}

const fileCard = (card: DeckCard) => ({
  name: card.name,
  subtitle: card.subtitle,
  set: card.set === NO_SET ? undefined : card.set,
  number: card.number,
  id: card.id,
  back: card.back,
})

// The saved card a deck file means: the same id, or else the same set and number, or
// else the same name and subtitle, on the same side for a two-sided base
function findDeckCard(cards: DeckCard[], wanted: Omit<DeckFileCard, 'count'>) {
  const same = (a?: string, b?: string) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase()
  const sameSide = cards.filter((card) => (card.back ?? false) === (wanted.back ?? false))
  return (
    cards.find((card) => card.id === wanted.id) ??
    sameSide.find((card) => wanted.number && same(card.set, wanted.set) && same(card.number, wanted.number)) ??
    sameSide.find((card) => same(card.name, wanted.name) && same(card.subtitle, wanted.subtitle))
  )
}

// A card of the deck's list: how many, its name with a large copy under the mouse, its
// cost (and the aspect penalty), and the buttons that change it. A click on the name adds
// a copy, a right click takes one out.
function DeckRow(props: {
  card: DeckCard
  count: number
  // Its copies by printing, marked after its name
  entry?: DeckEntry
  penalty: number
  onAdd: () => void
  onTake: () => void
  children: ReactNode
}) {
  const { card, count, penalty, onAdd, onTake, children } = props
  return (
    <li className="deck-row">
      <span className="deck-row-count">{count}×</span>
      <HoverPreview enabled preview={card.face}>
        <span
          className="deck-row-name"
          title="Click to add a copy, right click to take one out"
          onClick={onAdd}
          onContextMenu={(event) => {
            event.preventDefault()
            onTake()
          }}
        >
          <PrintingMarks entry={props.entry} />
          {card.label}
        </span>
      </HoverPreview>
      <span className="deck-row-cost" title={penalty ? `Costs ${penalty} more: an aspect the deck lacks` : undefined}>
        {card.cost ?? ''}
        {penalty > 0 && <span className="deck-penalty">+{penalty}</span>}
      </span>
      <span className="deck-row-buttons">{children}</span>
    </li>
  )
}

// The leader or the base at the top of the deck's list: a button that goes back to
// choosing it among the cards
type DeckStep = 'Leader' | 'Base'

// A leader's preview shows both its sides side by side, as tall as each other: the leader side
// (landscape) takes about two thirds of the width, the unit side the rest
function withBack(card: DeckCard, face: ReactNode) {
  if (!card.backFace) return face
  return (
    <div className="preview-sides">
      <div className="preview-side-leader">{face}</div>
      <div className="preview-side-unit">{card.backFace}</div>
    </div>
  )
}
const previewWidth = (card: DeckCard) => (card.backFace ? PREVIEW_WIDTH * 2 : undefined)

function DeckChoice(props: { label: DeckStep; card?: DeckCard; active: boolean; onPick: () => void }) {
  const { label, card, active, onPick } = props
  return (
    <button className="deck-choice" type="button" aria-pressed={active} title={`Choose another ${label.toLowerCase()}`} onClick={onPick}>
      <span className="filter-label">{label}</span>
      {card ? (
        <HoverPreview enabled preview={withBack(card, card.face)} width={previewWidth(card)}>
          <span className="deck-row-name">{card.label}</span>
        </HoverPreview>
      ) : (
        <span className="deck-missing">None yet: choose one</span>
      )}
    </button>
  )
}

// One card to pick from. A click adds a copy and a right click takes one out; a leader
// or a base is chosen with a click. Its toggles, under the count, pick the printing a
// click adds: Prescient, foil, or both.
function DeckPoolCard(props: {
  card: DeckCard
  preview: boolean
  // Leaders and bases are chosen, the other cards counted
  choice?: DeckStep
  chosen: boolean
  count: number
  max: number
  penalty: number
  onAdd: (printing: Printing) => void
  onTake: (printing: Printing) => void
  // Adds a copy to the sideboard rather than the deck; without it, no sideboard button
  onSideboard?: (printing: Printing) => void
  // The toggles there are, and whether a copy of a printing can still be added
  toggles?: { prescient: boolean; foil: boolean }
  room?: (printing: Printing) => boolean
  // This one printing alone, without toggles: a Sealed pool's copies of it, count and max theirs
  printing?: Printing
}) {
  const { card, preview, choice, chosen, count, max, penalty, onAdd, onTake, onSideboard, toggles, room } = props
  const [prescient, setPrescient] = useState(false)
  const [foil, setFoil] = useState(false)
  const printing: Printing =
    props.printing ??
    (toggles?.prescient && prescient ? (toggles.foil && foil ? 'prescient-foil' : 'prescient') : toggles?.foil && foil ? 'foil' : 'plain')
  const face = printingFace(card, printing)
  const full = count >= max || (room !== undefined && !room(printing))
  return (
    <li className={`deck-pool-card${!choice && full ? ' deck-full' : ''}`}>
      {/* Drawn large, the card needs no preview, but a leader's other side still shows */}
      <HoverPreview
        enabled={preview || !!card.backFace}
        preview={preview ? withBack(card, face) : card.backFace}
        width={preview ? previewWidth(card) : undefined}
      >
        <button
          className="deck-pool-image"
          type="button"
          aria-disabled={!choice && full}
          title={
            choice
              ? `Choose as the ${choice.toLowerCase()}`
              : full
                ? props.printing
                  ? `The pool's ${printingLabel[printing]} ${max === 1 ? 'copy is' : 'copies are'} in the deck. Right click to take one out.`
                  : count >= max
                  ? `${max} copies already. Right click to take one out.`
                  : `No ${printingLabel[printing]} copy left to add. Right click to take one out.`
                : `Click to add a${printing === 'plain' ? '' : ` ${printingLabel[printing]}`} copy, right click to take one out`
          }
          onClick={() => (choice || !full) && onAdd(printing)}
          onContextMenu={(event) => {
            event.preventDefault()
            if (!choice && count > 0) onTake(printing)
          }}
        >
          {face}
          {count > 0 && <span className="deck-badge">{count}</span>}
        </button>
      </HoverPreview>
      {!choice && toggles && (toggles.prescient || toggles.foil) && (
        <div className="deck-printings">
          {toggles.prescient && (
            <button
              className="deck-printing printing-prescient"
              type="button"
              aria-pressed={prescient}
              title={prescient ? 'Prescient: on' : 'Prescient: show and add the full-art version'}
              onClick={() => setPrescient(!prescient)}
            >
              ◈
            </button>
          )}
          {toggles.foil && (
            <button
              className="deck-printing printing-foil"
              type="button"
              aria-pressed={foil}
              title={foil ? 'Foil: on' : 'Foil: show and add a foil copy'}
              onClick={() => setFoil(!foil)}
            >
              ✦
            </button>
          )}
        </div>
      )}
      <div className="showroom-actions deck-pool-actions">
        {choice ? (
          chosen && <span className="filter-label">The deck's {choice.toLowerCase()}</span>
        ) : (
          <>
            <button className="deck-button" type="button" disabled={count === 0} aria-label="Take a copy out" onClick={() => onTake(printing)}>
              −
            </button>
            <span className="deck-pool-count" title={props.printing ? `${count} of the pool's ${max} ${printingLabel[printing]}` : undefined}>
              {props.printing && printing !== 'plain' && <span className={`printing-mark printing-${printing}`} />}
              {count}
              {props.printing && `/${max}`}
            </span>
            <button className="deck-button" type="button" disabled={full} aria-label="Add a copy" onClick={() => onAdd(printing)}>
              +
            </button>
            {onSideboard && (
              <button
                className="deck-button"
                type="button"
                disabled={full}
                title="Add a copy to the sideboard"
                onClick={() => onSideboard(printing)}
              >
                SB
              </button>
            )}
            {penalty > 0 && (
              <span className="deck-penalty" title="Costs more: an aspect the leader and base lack">
                +{penalty}
              </span>
            )}
          </>
        )}
      </div>
    </li>
  )
}

// The deck list's tabs: the cards, test draws, and the deck's numbers
const deckPanelTabs = [
  { value: 'list', label: 'Cards' },
  { value: 'draw', label: 'Draw' },
  { value: 'math', label: 'Math' },
] as const
type DeckPanelTab = (typeof deckPanelTabs)[number]['value']

type DeckCards = { card: DeckCard; count: number }[]

// Test draws from the main deck, shuffled: Draw 6 deals a new opening hand, Draw 2 and
// Draw 1 add to it from what is left, Clear puts everything back
function DeckDraw(props: { cards: DeckCards }) {
  const [library, setLibrary] = useState<DeckCard[]>([])
  const [hand, setHand] = useState<DeckCard[]>([])
  const shuffled = () => {
    const all = props.cards.flatMap(({ card, count }) => Array.from({ length: count }, () => card))
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[all[i], all[j]] = [all[j], all[i]]
    }
    return all
  }
  const draw = (count: number, fresh = false) => {
    // Before the first draw, or after Clear, the deck is shuffled
    const from = fresh || hand.length === 0 ? shuffled() : library
    setHand([...(fresh ? [] : hand), ...from.slice(0, count)])
    setLibrary(from.slice(count))
  }
  const total = deckCount(props.cards.map(({ card, count }) => ({ id: card.id, count })))
  return (
    <div className="deck-draw">
      <div className="deck-draw-buttons">
        <button className="button" type="button" disabled={total === 0} onClick={() => draw(6, true)}>
          Draw 6
        </button>
        <button className="button" type="button" disabled={total === 0 || (hand.length > 0 && library.length === 0)} onClick={() => draw(2)}>
          Draw 2
        </button>
        <button className="button" type="button" disabled={total === 0 || (hand.length > 0 && library.length === 0)} onClick={() => draw(1)}>
          Draw 1
        </button>
        <button
          className="button"
          type="button"
          disabled={hand.length === 0}
          onClick={() => {
            setHand([])
            setLibrary([])
          }}
        >
          Clear
        </button>
      </div>
      {total === 0 ? (
        <p className="empty-note">Add cards to the deck to draw.</p>
      ) : (
        hand.length > 0 && (
          <>
            <p className="filter-label">
              {hand.length} drawn · {library.length} left in the deck
            </p>
            <ul className="deck-hand">
              {hand.map((card, index) => (
                <li key={index}>
                  <HoverPreview enabled preview={card.face}>
                    {card.face}
                  </HoverPreview>
                </li>
              ))}
            </ul>
          </>
        )
      )}
    </div>
  )
}

// A bar chart: one bar for each label, as tall as its count
function DeckBars(props: { title: string; bars: { label: string; count: number }[] }) {
  const tallest = Math.max(1, ...props.bars.map(({ count }) => count))
  return (
    <figure className="deck-chart">
      <figcaption>{props.title}</figcaption>
      <div className="deck-curve" style={{ gridTemplateColumns: `repeat(${props.bars.length}, 1fr)` }}>
        {props.bars.map(({ label, count }) => (
          <div key={label} className="deck-curve-bar" title={`${label}: ${count}`}>
            <span className="deck-curve-count">{count || ''}</span>
            <span className="deck-curve-fill" style={{ height: `${(count / tallest) * 100}%` }} />
            <span className="deck-curve-cost">{label}</span>
          </div>
        ))}
      </div>
    </figure>
  )
}

// A pie chart, with a legend that gives each slice's count and share
function DeckPie(props: { title: string; slices: { label: ReactNode; key: string; count: number; color: string }[] }) {
  const slices = props.slices.filter(({ count }) => count > 0)
  const total = slices.reduce((sum, { count }) => sum + count, 0)
  // Each slice from where the ones before it end
  const stops = slices.map(({ count, color }, index) => {
    const from = (slices.slice(0, index).reduce((sum, slice) => sum + slice.count, 0) / total) * 360
    return `${color} ${from}deg ${from + (count / total) * 360}deg`
  })
  return (
    <figure className="deck-chart">
      <figcaption>{props.title}</figcaption>
      <div className="deck-pie-row">
        <div className="deck-pie" style={{ background: `conic-gradient(${stops.join(', ')})` }} />
        <ul className="deck-legend">
          {slices.map(({ label, key, count, color }) => (
            <li key={key}>
              <span className="deck-swatch" style={{ background: color }} />
              <span className="deck-legend-label">{label}</span>
              <span className="deck-legend-count">
                {count} · {Math.round((count / total) * 100)}%
              </span>
            </li>
          ))}
        </ul>
      </div>
    </figure>
  )
}

// Each aspect's colour in the charts; a card with two takes a mix of both
const aspectColors: Record<Aspect, string> = {
  Vigilance: '#3f7fd6',
  Command: '#2e9b52',
  Aggression: '#cc3d2e',
  Cunning: '#e3b33a',
  Heroism: '#eee6d2',
  Villainy: '#2c2733',
}
const rarityColors: Record<string, string> = { C: '#8e4f1c', U: '#cfcfcf', R: '#e6b83c', S: '#111111', L: '#16c2ee' }

// The main deck's numbers: by cost, by type, by aspect, by rarity, and its most common traits
function DeckMath(props: { cards: DeckCards }) {
  const { cards } = props
  if (cards.length === 0) return <p className="empty-note">Add cards to the deck to see its numbers.</p>
  const sum = (keep: (card: DeckCard) => boolean) => cards.reduce((total, { card, count }) => total + (keep(card) ? count : 0), 0)

  // The aspects as printed on each card, a combination counted as one
  const combos = new Map<string, { icons: Aspect[]; count: number }>()
  for (const { card, count } of cards) {
    const icons = card.icons
    const key = icons.join(' ') || 'Neutral'
    combos.set(key, { icons, count: (combos.get(key)?.count ?? 0) + count })
  }
  const traits = new Map<string, number>()
  for (const { card, count } of cards) {
    for (const trait of card.traits) traits.set(trait, (traits.get(trait) ?? 0) + count)
  }

  return (
    <div className="deck-math">
      <DeckBars
        title="Cards by cost"
        bars={Array.from({ length: 8 }, (_, cost) => ({
          label: cost === 7 ? '7+' : String(cost),
          count: sum((card) => Math.min(card.cost ?? 0, 7) === cost),
        }))}
      />
      <DeckBars title="Cards by type" bars={deckGroups.map((group) => ({ label: group.replace(' units', ''), count: sum((card) => deckGroup(card) === group) }))} />
      <DeckPie
        title="Cards by aspect"
        slices={[...combos]
          .sort(([, a], [, b]) => b.count - a.count)
          .map(([key, { icons, count }]) => ({
            key,
            count,
            label:
              icons.length === 0 ? (
                'Neutral'
              ) : (
                <span className="deck-legend-icons" title={key}>
                  {icons.map((aspect, index) => (
                    <img key={index} src={aspectIcon(aspect)} alt={aspect} />
                  ))}
                </span>
              ),
            color:
              icons.length === 0
                ? '#8a8a8a'
                : icons.length === 1 || icons[0] === icons[1]
                  ? aspectColors[icons[0]]
                  : `color-mix(in srgb, ${aspectColors[icons[0]]} 60%, ${aspectColors[icons[1]]})`,
          }))}
      />
      <DeckPie
        title="Cards by rarity"
        slices={[...rarities, { value: '', label: 'No rarity' }].map(({ value, label }) => ({
          key: value || 'none',
          label,
          color: rarityColors[value] ?? '#555',
          count: sum((card) => card.rarity === value),
        }))}
      />
      <figure className="deck-chart">
        <figcaption>Traits</figcaption>
        <ul className="deck-traits">
          {[...traits]
            .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
            .map(([trait, count]) => (
              <li key={trait}>
                <span>{trait}</span>
                <span className="deck-legend-count">{count}</span>
              </li>
            ))}
        </ul>
      </figure>
    </div>
  )
}

// The deck as one picture to share, like SWUDB's: drawn at this size on the page,
// off-screen, and saved at twice it (2880 × 1620)
const DECK_IMAGE = { width: 1440, height: 810, scale: 2 }
// The main deck's cards fill this much of the right side; the sideboard's, what the left
// side has under the deck's name, leader and base (less with an author's line)
const DECK_IMAGE_GRID = { width: 920, height: 762, gap: 10 }
const DECK_IMAGE_SIDEBOARD = { width: 440, height: 430, author: 40, heading: 54 }
// A card's height for its width
const CARD_RATIO = 1.4

// The biggest a card can be drawn when that many fill that space, with as many to a row
// as draws them biggest (6, when that is as big)
function deckImageFit(cards: number, width: number, height: number) {
  const gap = DECK_IMAGE_GRID.gap
  const size = (columns: number) => {
    const rows = Math.max(1, Math.ceil(cards / columns))
    return Math.min((width - gap * (columns - 1)) / columns, (height - gap * (rows - 1)) / rows / CARD_RATIO)
  }
  const columns = [6, 5, 7, 4, 3, 8, 2, 9, 10, 1, 11, 12].reduce((best, columns) => (size(columns) > size(best) + 0.5 ? columns : best))
  return Math.floor(size(columns))
}

// The deck's, the sideboard's and the tokens' cards drawn at one size, the biggest they
// all fit at, and how many to a row that makes in each. The sideboard and the tokens
// share the left side, under one heading each.
function deckImageGrids(cards: number, sideboard: number, tokens: number, author: boolean) {
  const { gap } = DECK_IMAGE_GRID
  const headings = (sideboard ? 1 : 0) + (tokens ? 1 : 0)
  const side = {
    width: DECK_IMAGE_SIDEBOARD.width,
    height:
      DECK_IMAGE_SIDEBOARD.height -
      (author ? DECK_IMAGE_SIDEBOARD.author : 0) -
      Math.max(0, headings - 1) * DECK_IMAGE_SIDEBOARD.heading,
  }
  const columns = (count: number, width: number, card: number) =>
    Math.max(1, Math.min(count, Math.floor((width + gap) / (card + gap))))
  // The left side's cards fit when the rows of both groups, each started afresh, fit its height
  const sideFits = (card: number) => {
    const rows = (count: number) => (count ? Math.ceil(count / columns(count, side.width, card)) : 0)
    const all = rows(sideboard) + rows(tokens)
    return all * card * CARD_RATIO + gap * Math.max(0, all - headings) <= side.height
  }
  let card = deckImageFit(cards, DECK_IMAGE_GRID.width, DECK_IMAGE_GRID.height)
  while (card > 40 && sideboard + tokens > 0 && !sideFits(card)) card--
  return {
    card,
    deck: columns(cards, DECK_IMAGE_GRID.width, card),
    sideboard: columns(sideboard, side.width, card),
    tokens: columns(tokens, side.width, card),
  }
}

// Art files are drawn smaller for the deck image, which would otherwise carry every
// picture at full size and take long to make. Kept for the next image.
const deckImageArt = new Map<string, Promise<string>>()

function smallArt(src: string) {
  let small = deckImageArt.get(src)
  if (!small) {
    small = new Promise<string>((resolve) => {
      const image = new Image()
      image.onload = () => {
        const scale = Math.min(1, 520 / image.naturalWidth)
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(image.naturalWidth * scale)
        canvas.height = Math.round(image.naturalHeight * scale)
        canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/webp', 0.85))
      }
      // A picture that will not load is drawn as it is
      image.onerror = () => resolve(src)
      image.src = src
    })
    deckImageArt.set(src, small)
  }
  return small
}

// The card with its art, both sides', drawn smaller
async function withSmallArt(card: Card): Promise<Card> {
  const shrink = async (art?: Art) => art && { ...art, src: await smallArt(art.src) }
  const prescient = card.prescient?.art && { ...card.prescient, art: await shrink(card.prescient.art) }
  return { ...card, art: await shrink(card.art), backArt: await shrink(card.backArt), ...(prescient && { prescient }) }
}

// The background: the leader and base's colours, paler toward the middle
function deckImageBackground(covered: Aspect[]) {
  const colours = [...new Set(covered.filter((aspect) => aspect !== 'Heroism' && aspect !== 'Villainy'))]
  const [first, second] = (colours.length ? colours : [...new Set(covered)]).map((aspect) => aspectColors[aspect])
  const pale = (colour: string) => `color-mix(in srgb, ${colour} 25%, #f3efe6)`
  return `linear-gradient(110deg, ${first ?? '#8a7a60'} 0%, ${pale(first ?? '#8a7a60')} 45%, ${second ? pale(second) : '#f3efe6'} 60%, ${second ?? pale(first ?? '#8a7a60')} 100%)`
}

// A card of the picture, with how many copies on a hexagon at its foot
function DeckImageCard(props: { card: DeckCard; count?: number }) {
  return (
    <div className="deck-image-card">
      {props.card.face}
      {props.count !== undefined && (
        <span className="deck-image-count">
          <span>{props.count}</span>
        </span>
      )}
    </div>
  )
}

function DeckImage(props: {
  name: string
  author?: string
  leader?: DeckCard
  base?: DeckCard
  covered: Aspect[]
  cards: DeckCards
  sideboard: DeckCards
  // The tokens the deck's cards make or use, shown so they need no explaining
  tokens: DeckCard[]
}) {
  const { name, author, leader, base, covered, cards, sideboard, tokens } = props
  const byCost = (a: { card: DeckCard }, b: { card: DeckCard }) =>
    (a.card.cost ?? 0) - (b.card.cost ?? 0) || a.card.name.localeCompare(b.card.name)
  const grid = deckImageGrids(cards.length, sideboard.length, tokens.length, Boolean(author))
  return (
    <div className="deck-image" style={{ width: DECK_IMAGE.width, height: DECK_IMAGE.height, background: deckImageBackground(covered) }}>
      <div className="deck-image-side">
        <h2 className="deck-image-name">{name}</h2>
        {author && <p className="deck-image-author">by {author}</p>}
        <div className="deck-image-choices">
          {leader && <DeckImageCard card={leader} />}
          {base && <DeckImageCard card={base} />}
        </div>
        {sideboard.length > 0 && (
          <>
            <h3 className="deck-image-heading">Sideboard</h3>
            <div
              className="deck-image-sideboard"
              style={{ gap: DECK_IMAGE_GRID.gap, gridTemplateColumns: `repeat(${grid.sideboard}, ${grid.card}px)` }}
            >
              {[...sideboard].sort(byCost).map(({ card, count }) => (
                <DeckImageCard key={card.id} card={card} count={count} />
              ))}
            </div>
          </>
        )}
        {tokens.length > 0 && (
          <>
            <h3 className="deck-image-heading">Tokens</h3>
            <div
              className="deck-image-sideboard"
              style={{ gap: DECK_IMAGE_GRID.gap, gridTemplateColumns: `repeat(${grid.tokens}, ${grid.card}px)` }}
            >
              {tokens.map((card) => (
                <DeckImageCard key={card.id} card={card} />
              ))}
            </div>
          </>
        )}
      </div>
      <div
        className="deck-image-deck"
        style={{
          width: DECK_IMAGE_GRID.width,
          gap: DECK_IMAGE_GRID.gap,
          gridTemplateColumns: `repeat(${grid.deck}, ${grid.card}px)`,
        }}
      >
        {[...cards].sort(byCost).map(({ card, count }) => (
          <DeckImageCard key={card.id} card={card} count={count} />
        ))}
      </div>
      <span className="deck-image-credit">SWU Card Creator</span>
    </div>
  )
}

// The finished picture over the page: it is already copied, Download saves it
function DeckImageView(props: { url: string; fileName: string; note: string; onClose: () => void }) {
  const { url, fileName, note, onClose } = props
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])
  return createPortal(
    <div className="deck-image-view" role="dialog" aria-label="Deck image" onClick={onClose}>
      <div className="deck-image-view-bar" onClick={(event) => event.stopPropagation()}>
        <span className="saved-note">{note}</span>
        <a className="button button-primary" href={url} download={fileName}>
          Download
        </a>
        <button className="button" type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <img src={url} alt="The deck" onClick={(event) => event.stopPropagation()} />
    </div>,
    document.body,
  )
}

// Decks made of the Showroom's cards, where a deck can keep to some sets (the DUNE cards
// for one) and then only offers theirs; or of a Showcase's cards, all of one set.
// The Simulator's Featured Decks, decks anyone may play there: on this computer an admin puts
// the deck shown in them, or updates or takes out its copy there (public/sim/featured-decks.json,
// which reaches the site with the next push)
type FeaturedDeck = { id: string; name: string; leader: string; base: string; cards: { id: string; count: number }[] }
function FeatureButton(props: { deck: Deck; onNote: (note: string) => void }) {
  const { deck, onNote } = props
  const [featured, setFeatured] = useState<FeaturedDeck[] | null>(null)
  const load = () =>
    fetch(asset('/sim/featured-decks.json'), { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : []))
      .then(setFeatured, () => setFeatured([]))
  useEffect(() => {
    load()
  }, [])
  if (!featured || !deck.leader || !deck.base) return null
  const copy: FeaturedDeck = {
    id: deck.id,
    name: deck.name,
    leader: deck.leader,
    base: deck.base,
    cards: deck.cards.map(({ id, count }) => ({ id, count })),
  }
  const there = featured.find((d) => d.id === deck.id)
  const same = there && JSON.stringify(there) === JSON.stringify(copy)
  // A deck that can't be played isn't offered to everyone
  const short = copy.cards.reduce((sum, { count }) => sum + count, 0) < 50
  const send = async (method: 'PUT' | 'DELETE') => {
    const response = await fetch(method === 'PUT' ? '/__featured' : `/__featured/${encodeURIComponent(deck.id)}`, {
      method,
      body: method === 'PUT' ? JSON.stringify(copy) : undefined,
    })
    if (!response.ok) return onNote(`Could not change the Featured Decks: ${await response.text()}`)
    onNote(
      method === 'DELETE'
        ? `${deck.name} is out of the Featured Decks; the site follows with the next push.`
        : `${deck.name} is ${there ? 'updated in' : 'in'} the Featured Decks; the site gets it with the next push.`,
    )
    load()
  }
  return (
    <>
      <button
        className="button"
        type="button"
        disabled={same || short}
        title={
          short
            ? 'A Featured Deck needs at least 50 cards'
            : "The Simulator's Featured Decks, which anyone may play: written in public/sim/featured-decks.json"
        }
        onClick={() => send('PUT')}
      >
        {same ? 'Featured' : there ? 'Update Featured' : 'Feature'}
      </button>
      {there && (
        <button className="button" type="button" onClick={() => send('DELETE')}>
          Unfeature
        </button>
      )}
    </>
  )
}

function DeckBuilder(props: {
  cards: DeckCard[]
  // Where its choices are remembered, and its decks kept
  prefix?: string
  storageKey?: string
  // Where the cards come from, for the messages: "Showroom", or "set" for a Showcase,
  // whose cards are all of one set and offer no choice of sets
  source?: 'Showroom' | 'set'
  // Sealed: the cards are a pool's, each card's max what the pool has
  sealed?: boolean
  // Sets a deck leaves out until they are ticked: with no set ticked, every other set (the
  // Community Deck Builder's DUNE)
  offByDefault?: string[]
}) {
  const { cards, prefix = 'decks', storageKey, source = 'Showroom', sealed = false, offByDefault = [] } = props
  const fixedSet = source === 'set' || sealed
  const deckSize = sealed ? SEALED_DECK_SIZE : DECK_SIZE
  const sourceName = sealed ? 'pool' : source
  // Signed in, the decks are the account's; otherwise this browser's
  const account = useAccount()
  const scope = deckScope(storageKey)
  const [decks, setDecks] = useState<Deck[]>(() => (account ? [] : loadDecks(storageKey)))
  const [deckState, setDeckState] = useState<'loading' | 'ready' | 'failed'>(account ? 'loading' : 'ready')
  // Saves to the account, one after another, in the order made, each from the list the
  // last one left
  const deckSaving = useRef(Promise.resolve())
  const savedDecks = useRef(decks)
  useEffect(() => {
    if (!account) {
      setDecks(loadDecks(storageKey))
      setDeckState('ready')
      return
    }
    let live = true
    setDeckState('loading')
    loadAccountDecks(account, scope)
      .then((found) => {
        if (!live) return
        savedDecks.current = found
        setDecks(found)
        setDeckState('ready')
      })
      .catch(() => {
        if (!live) return
        setDeckState('failed')
        setNote('Could not load the decks on your account. Reload the page to try again.')
      })
    return () => {
      live = false
    }
  }, [account?.token, scope, storageKey])
  const [currentId, setCurrentId] = useRemembered(`${prefix}.current`, '')
  // On each time the Deck Builder opens: cards a deck can't play at their cost are left out
  const [onAspect, setOnAspect] = useState(true)
  // The author last typed, for the next new deck
  const [lastAuthor, setLastAuthor] = useRemembered('decks.author', '')
  const [deleting, setDeleting] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  // Choosing another leader or base, from its button in the deck's list
  const [changing, setChanging] = useState<DeckStep | null>(null)
  const [panelTab, setPanelTab] = useRemembered<DeckPanelTab>(`${prefix}.panel`, 'list')
  // The deck image: on the page, off-screen, while it is drawn; then shown, with whether it was copied
  const [drawing, setDrawing] = useState(false)
  // The deck's cards as the image draws them, their art smaller; set while it is drawn
  const [pictureCards, setPictureCards] = useState<Map<string, DeckCard> | null>(null)
  const [picture, setPicture] = useState<{ url: string; note: string } | null>(null)
  const pictureRef = useRef<HTMLDivElement>(null)
  const importInput = useRef<HTMLInputElement>(null)

  // With no deck yet, a new one is open straight away; it is kept once something is picked
  const [firstDeck] = useState<Deck>(() => ({
    id: crypto.randomUUID(),
    name: 'Deck 1',
    author: lastAuthor || undefined,
    sets: [],
    cards: [],
    sideboard: [],
  }))
  // Changes are drafts until saved, kept in this browser by deck: leaving the page without
  // saving keeps them, to save or undo on coming back. A deck never saved is a draft too.
  const draftsKey = `dune-unlimited.deck-drafts.${scope}`
  const [drafts, setDrafts] = useState<Record<string, Deck>>(() => {
    try {
      const found = JSON.parse(localStorage.getItem(draftsKey) ?? '{}')
      return found && typeof found === 'object' ? found : {}
    } catch {
      return {}
    }
  })
  const storeDrafts = (next: Record<string, Deck>) => {
    setDrafts(next)
    try {
      localStorage.setItem(draftsKey, JSON.stringify(next))
    } catch {
      setNote('Could not keep the changes: this browser has run out of storage. Save them now.')
    }
  }
  const withoutDraft = (id: string) => Object.fromEntries(Object.entries(drafts).filter(([key]) => key !== id))
  // While the account's decks load, a draft of a saved deck is not yet known to be one
  const unsavedNew = deckState === 'ready' ? Object.values(drafts).filter((d) => !decks.some((saved) => saved.id === d.id)) : []
  const allDecks = [...decks.map((saved) => drafts[saved.id] ?? saved), ...unsavedNew]
  const deck = allDecks.find(({ id }) => id === currentId) ?? allDecks[0] ?? firstDeck
  const unsaved = !!drafts[deck.id]
  const byId = new Map(cards.map((card) => [card.id, card]))

  const saveDecks = (next: Deck[]) => {
    if (account) {
      if (deckState !== 'ready') {
        setNote('Your account’s decks are still loading. Try again in a moment.')
        return
      }
      const before = savedDecks.current
      savedDecks.current = next
      setDecks(next)
      deckSaving.current = deckSaving.current
        .then(() => syncAccountDecks(account, scope, before, next))
        .catch((err) => setNote(`Could not save to your account: ${(err as Error).message}`))
      return
    }
    if (!storeDecks(next, storageKey)) {
      setNote('Could not save: this browser has run out of storage.')
      return
    }
    setDecks(next)
  }
  const changeDeck = (next: Deck) => {
    const saved = decks.find((other) => other.id === next.id)
    // Changed back to what is saved: nothing left to save
    if (saved && JSON.stringify(saved) === JSON.stringify(next)) storeDrafts(withoutDraft(next.id))
    else storeDrafts({ ...drafts, [next.id]: next })
    // The new deck opened for want of any, kept now that it has something
    if (!saved) setCurrentId(next.id)
  }
  // Every deck with changes, saved at once when leaving the page asks to
  const saveDrafts = (ids: string[]) => {
    if (account && deckState !== 'ready') {
      setNote('Your account’s decks are still loading. Try again in a moment.')
      return
    }
    const next = [...decks.map((saved) => (ids.includes(saved.id) ? (drafts[saved.id] ?? saved) : saved))]
    for (const id of ids) if (!decks.some((saved) => saved.id === id) && drafts[id]) next.push(drafts[id])
    saveDecks(next)
    storeDrafts(Object.fromEntries(Object.entries(drafts).filter(([id]) => !ids.includes(id))))
  }
  const unsavedDecks = allDecks.filter((d) => drafts[d.id])
  useEffect(() => {
    if (!unsavedDecks.length) return setLeaveGuard(null)
    setLeaveGuard({
      what: unsavedDecks.length === 1 ? unsavedDecks[0].name || 'Your deck' : `${unsavedDecks.length} decks`,
      save: () => saveDrafts(unsavedDecks.map((d) => d.id)),
    })
  })
  useEffect(() => () => setLeaveGuard(null), [])
  const addDeck = (next: Deck) => {
    saveDecks([...decks, next])
    setCurrentId(next.id)
    setDeleting(false)
    setChanging(null)
  }
  // A new deck keeps to the sets of the one open, as the next deck is likely for the same game
  const newDeck = () =>
    addDeck({
      id: crypto.randomUUID(),
      name: `Deck ${decks.length + 1}`,
      author: lastAuthor || undefined,
      sets: fixedSet ? [] : (deck?.sets ?? []),
      cards: [],
      sideboard: [],
    })

  // Every set some card is in, for the deck to keep to
  const setOptions = [
    ...[...new Set(cards.map((card) => card.set))]
      .filter((set) => set !== NO_SET)
      .sort()
      .map((set) => ({ value: set, label: set })),
    ...(cards.some((card) => card.set === NO_SET) ? [{ value: NO_SET, label: 'No set' }] : []),
  ]

  const leader = deck?.leader ? byId.get(deck.leader) : undefined
  const base = deck?.base ? byId.get(deck.base) : undefined
  // What the leader and base cover; until both are chosen there is no penalty to show
  const covered = leader && base ? [...leader.icons, ...base.icons] : undefined
  const penaltyOf = (card: DeckCard) => (covered ? missingAspects(card, covered) * ASPECT_PENALTY : 0)
  const inSets = (card: DeckCard) =>
    fixedSet || !deck || (deck.sets.length === 0 ? !offByDefault.includes(card.set) : deck.sets.includes(card.set))

  // A deck starts with its leader, then its base, then the cards
  const step: DeckStep | null = changing ?? (!leader ? 'Leader' : !base ? 'Base' : null)
  const inPool = (card: DeckCard) => card.type !== 'Token' && inSets(card)
  // Each list keeps its own filters: a Type filter for the cards is no use for leaders
  const choosing = useCardFilters(
    `${prefix}.choose`,
    cards.filter((card) => inPool(card) && card.type === step).map((card) => ({ item: card, facts: card.facts })),
    'Order saved',
    'number',
    (card) => card.id.replace(BACK_SIDE, ''),
  )
  const picking = useCardFilters(
    prefix,
    cards
      .filter((card) => inPool(card) && deckGroup(card) !== undefined && (!onAspect || penaltyOf(card) === 0))
      .map((card) => ({ item: card, facts: card.facts })),
    'Order saved',
    'cost',
  )
  const { bar, shown, grid, preview } = step ? choosing : picking

  const copies = (id: string) => copiesOf(deck.cards, id) + copiesOf(deck.sideboard, id)
  // Prescient and foil copies: in Sealed those the pool has; otherwise any, once signed in
  const printingsOn = sealed || account !== null
  const usedOf = (id: string, printing: Printing) => printingCopies(deck.cards, id, printing) + printingCopies(deck.sideboard, id, printing)
  const ownedOf = (card: DeckCard, printing: Printing) => (card.pooled ? printingCopies([card.pooled], card.pooled.id, printing) : Infinity)
  const room = (card: DeckCard) => (printing: Printing) => usedOf(card.id, printing) < ownedOf(card, printing)
  // The toggles, outside Sealed: a Sealed pool's printings each have a tile of their own
  const togglesOf = (card: DeckCard) => (printingsOn && !card.pooled ? { prescient: card.prescientFace !== undefined, foil: true } : undefined)
  // Without a printing asked for, the first one with a copy left
  const add = (card: DeckCard, printing = printings.find(room(card))) => {
    if (card.type === 'Leader' || card.type === 'Base') {
      changeDeck(card.type === 'Leader' ? { ...deck, leader: card.id } : { ...deck, base: card.id })
      setChanging(null)
    } else if (printing && copies(card.id) < card.max && room(card)(printing))
      changeDeck({ ...deck, cards: withPrinting(deck.cards, card.id, printing, 1) })
  }
  const addToSideboard = (card: DeckCard, printing = printings.find(room(card))) => {
    if (printing && copies(card.id) < card.max && room(card)(printing))
      changeDeck({ ...deck, sideboard: withPrinting(deck.sideboard, card.id, printing, 1) })
  }
  // The Leader or Base button: choose another, or, pressed again, keep it and go back to the cards
  const pickChoice = (choice: DeckStep) =>
    setChanging(step === choice && (choice === 'Leader' ? leader : base) ? null : choice)
  // From the deck first, then from the sideboard: of the printing asked for if either has one
  const take = (card: DeckCard, printing?: Printing) => {
    if (printing && printingCopies(deck.cards, card.id, printing) === 0 && printingCopies(deck.sideboard, card.id, printing) > 0)
      return takeFromSideboard(card, printing)
    const fromMain = printingToTake(deck.cards, card.id, printing)
    if (fromMain) return changeDeck({ ...deck, cards: withPrinting(deck.cards, card.id, fromMain, -1) })
    takeFromSideboard(card, printing)
  }
  const takeFromSideboard = (card: DeckCard, printing?: Printing) => {
    const taken = printingToTake(deck.sideboard, card.id, printing)
    if (taken) changeDeck({ ...deck, sideboard: withPrinting(deck.sideboard, card.id, taken, -1) })
  }
  // One copy from the deck to the sideboard, or back, as the printing it is
  const move = (card: DeckCard, toSideboard: boolean) => {
    const [from, to] = toSideboard ? [deck.cards, deck.sideboard] : [deck.sideboard, deck.cards]
    const printing = printingToTake(from, card.id)
    if (!printing) return
    const moved = {
      from: withPrinting(from, card.id, printing, -1),
      to: withPrinting(to, card.id, printing, 1),
    }
    changeDeck(
      toSideboard ? { ...deck, cards: moved.from, sideboard: moved.to } : { ...deck, cards: moved.to, sideboard: moved.from },
    )
  }

  const known = (entries: DeckEntry[]) =>
    entries.flatMap((entry) => {
      const card = byId.get(entry.id)
      return card ? [{ card, count: entry.count, entry }] : []
    })
  const main = known(deck.cards)
  const sideboard = known(deck.sideboard)
  const mainCount = deckCount(deck.cards)
  const sideboardCount = deckCount(deck.sideboard)
  // Cards removed from the Showroom since they were put in the deck
  const lost = deckCount([...deck.cards, ...deck.sideboard].filter(({ id }) => !byId.has(id)))
  const byCost = (a: { card: DeckCard }, b: { card: DeckCard }) =>
    (a.card.cost ?? 0) - (b.card.cost ?? 0) || a.card.name.localeCompare(b.card.name)
  // The tokens a card of the deck names ("Create a Fremen token", "a Spice Token"): new
  // to most players, so shown with the deck
  const namedText = [leader, base, ...main.map(({ card }) => card), ...sideboard.map(({ card }) => card)]
    .map((card) => card?.facts.text ?? '')
    .join(' ')
  const tokens = cards.filter(
    (card) => card.type === 'Token' && inSets(card) && namedText.includes(`${card.name.trim().toLowerCase()} token`),
  )

  const problems = [
    !leader && 'Choose a leader.',
    !base && 'Choose a base.',
    mainCount < deckSize && `${deckSize - mainCount} more card${deckSize - mainCount === 1 ? '' : 's'} needed: a deck has at least ${deckSize}.`,
    !sealed && sideboardCount > SIDEBOARD_SIZE && `${sideboardCount - SIDEBOARD_SIZE} too many in the sideboard: it holds ${SIDEBOARD_SIZE}.`,
    ...[...new Set([...main, ...sideboard].map(({ card }) => card))]
      .filter((card) => copies(card.id) > card.max)
      .map((card) => (sealed ? `${card.label}: the pool has only ${card.max}.` : `${card.label}: more than ${card.max} copies.`)),
    ...[...new Set([...main, ...sideboard].map(({ card }) => card))].flatMap((card) =>
      cardVersions
        .filter((version) => usedOf(card.id, version) > ownedOf(card, version))
        .map((version) => `${card.label}: the pool has ${ownedOf(card, version) || 'no'} ${printingLabel[version]} cop${ownedOf(card, version) === 1 ? 'y' : 'ies'}.`),
    ),
    ...[leader, base, ...main.map(({ card }) => card), ...sideboard.map(({ card }) => card)]
      .filter((card): card is DeckCard => card !== undefined && !inSets(card))
      .map((card) => `${card.label} is not in the deck's sets.`),
    lost > 0 && `${lost} card${lost === 1 ? ' is' : 's are'} no longer in the ${sourceName}.`,
  ].filter((problem): problem is string => Boolean(problem))

  const deckFile = (): DeckFile => ({
    deck: deck.name,
    author: deck.author || undefined,
    sets: deck.sets,
    leader: leader && fileCard(leader),
    base: base && fileCard(base),
    cards: main.map(({ card, count, entry }) => ({ count, versions: entry.versions, ...fileCard(card) })),
    sideboard: sideboard.map(({ card, count, entry }) => ({ count, versions: entry.versions, ...fileCard(card) })),
  })
  const deckText = () =>
    [
      deck.name,
      `Leader: ${leader ? leader.label : '—'}`,
      `Base: ${base ? base.label : '—'}`,
      '',
      `Deck (${mainCount})`,
      ...[...main].sort(byCost).map(({ card, count }) => `${count} ${card.label}`),
      ...(sideboard.length
        ? ['', `Sideboard (${sideboardCount})`, ...[...sideboard].sort(byCost).map(({ card, count }) => `${count} ${card.label}`)]
        : []),
    ].join('\n')

  // Draws the deck image and copies it. The copy starts on the click, with the image
  // still to come: browsers only let a page write to the clipboard right after a click.
  const deckImage = () => {
    if (drawing) return
    setDrawing(true)
    const drawn = (async () => {
      const used = [leader, base, ...main.map(({ card }) => card), ...sideboard.map(({ card }) => card), ...tokens].filter(
        (card): card is DeckCard => card !== undefined,
      )
      // Only the cards with a Prescient copy need that face drawn
      const prescientIds = new Set(
        [...deck.cards, ...deck.sideboard]
          .filter((entry) => printingCopies([entry], entry.id, 'prescient') + printingCopies([entry], entry.id, 'prescient-foil') > 0)
          .map((entry) => entry.id),
      )
      const small = new Map(
        (await Promise.all(used.map((card) => (card.forImage ? card.forImage(prescientIds.has(card.id)) : card)))).map((card) => [card.id, card]),
      )
      flushSync(() => setPictureCards(small))
      const node = pictureRef.current?.firstElementChild as HTMLElement | null
      if (!node) throw new Error('No deck image')
      // The card text fits itself to its box once on the page: a frame or two, and the fonts
      await document.fonts.ready
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const { toCanvas } = await import('html-to-image')
      const options = { pixelRatio: DECK_IMAGE.scale, width: DECK_IMAGE.width, height: DECK_IMAGE.height }
      // Safari leaves the pictures out the first time, as with the cards
      if (webKit) await toCanvas(node, options)
      const canvas = await toCanvas(node, options)
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('The deck image could not be drawn')
      return blob
    })()
    const copied = navigator.clipboard
      .write([new ClipboardItem({ 'image/png': drawn })])
      .then(
        () => true,
        () => false,
      )
    Promise.all([drawn, copied])
      .then(([blob, ok]) =>
        setPicture({
          url: URL.createObjectURL(blob),
          note: ok ? 'Copied to the clipboard.' : 'Could not copy it: this browser would not allow it. Download it instead.',
        }),
      )
      .catch(() => setNote('Could not make the deck image.'))
      .finally(() => {
        setDrawing(false)
        setPictureCards(null)
      })
  }
  // The deck image's cards: each printing of a card a card of its own, with its own count
  const byPrinting = (rows: typeof main, drawn: Map<string, DeckCard>) =>
    rows.flatMap(({ card, entry }) =>
      printings.flatMap((printing) => {
        const count = printingCopies([entry], entry.id, printing)
        if (!count) return []
        const small = drawn.get(card.id) ?? card
        const id = printing === 'plain' ? small.id : `${small.id}:${printing}`
        return [{ card: { ...small, id, face: printingFace(small, printing) }, count }]
      }),
    )
  const closePicture = () => {
    if (picture) URL.revokeObjectURL(picture.url)
    setPicture(null)
  }

  const importDeck = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const data = JSON.parse(await file.text()) as DeckFile
      let missing = 0
      const entries = (list: DeckFileCard[] = []) =>
        list.flatMap((wanted) => {
          const card = findDeckCard(cards, wanted)
          if (!card) missing += wanted.count
          return card ? [{ id: card.id, count: wanted.count, ...(wanted.versions && { versions: wanted.versions }) }] : []
        })
      const found = (wanted?: Omit<DeckFileCard, 'count'>) => {
        const card = wanted && findDeckCard(cards, wanted)
        if (wanted && !card) missing++
        return card?.id
      }
      addDeck({
        id: crypto.randomUUID(),
        name: data.deck || file.name.replace(/\.json$/i, ''),
        author: typeof data.author === 'string' ? data.author : undefined,
        sets: !fixedSet && Array.isArray(data.sets) ? data.sets : [],
        leader: found(data.leader),
        base: found(data.base),
        cards: entries(data.cards),
        sideboard: entries(data.sideboard),
      })
      setNote(missing ? `Imported. ${missing} card${missing === 1 ? ' was' : 's were'} not found in the ${sourceName}.` : 'Imported.')
    } catch {
      setNote('That file is not a deck.')
    }
  }

  return (
    <section className="decks">
      {pictureCards &&
        createPortal(
          <div className="deck-image-holder" ref={pictureRef} aria-hidden="true">
            <DeckImage
              name={deck.name}
              author={deck.author?.trim()}
              leader={leader && pictureCards.get(leader.id)}
              base={base && pictureCards.get(base.id)}
              covered={covered ?? [...(leader?.icons ?? []), ...(base?.icons ?? [])]}
              cards={byPrinting(main, pictureCards)}
              sideboard={byPrinting(sideboard, pictureCards)}
              tokens={tokens.map((card) => pictureCards.get(card.id) ?? card)}
            />
          </div>,
          document.body,
        )}
      {picture && (
        <DeckImageView url={picture.url} fileName={`${deck.name || 'Deck'}.png`.replace(/[\\/:*?"<>|]/g, '')} note={picture.note} onClose={closePicture} />
      )}

      {/* The deck's fields over the cards to pick from; its buttons over its list */}
      <div className="deck-main">
        <div className="deck-bar">
          <ChoiceDropdown
            label="Deck"
            options={allDecks.map(({ id, name, leader, base, cards }) => ({
              value: id,
              label: `${name || 'Unnamed deck'}${drafts[id] ? ' (not saved)' : ''}`,
              icons: [...(leader ? (byId.get(leader)?.icons ?? []) : []), ...(base ? (byId.get(base)?.icons ?? []) : [])],
              preview: leaderPreview(
                leader ? byId.get(leader) : undefined,
                cards.flatMap(({ id, count }) => {
                  const card = byId.get(id)
                  return card ? [glanceOf(card, count)] : []
                }),
              ),
            }))}
            selected={deck.id}
            onChange={(id) => {
              setCurrentId(id)
              setDeleting(false)
              setChanging(null)
            }}
          />
          <input
            className="deck-name"
            aria-label="Deck name"
            value={deck.name}
            onChange={(event) => changeDeck({ ...deck, name: event.target.value })}
          />
          <input
            className="deck-name deck-author"
            aria-label="Author"
            placeholder="Author"
            value={deck.author ?? ''}
            onChange={(event) => {
              changeDeck({ ...deck, author: event.target.value })
              setLastAuthor(event.target.value)
            }}
          />
          {!fixedSet && (
            <>
              <CheckDropdown label="Sets" options={setOptions} selected={deck.sets} onChange={(sets) => changeDeck({ ...deck, sets })} />
              <span className="filter-label">
                {deck.sets.length
                  ? deck.sets.map((set) => (set === NO_SET ? 'No set' : set)).join(', ')
                  : offByDefault.length
                    ? `All sets but ${offByDefault.join(', ')}`
                    : 'All sets'}
              </span>
            </>
          )}
          <label className="toggle deck-toggle" title="Leave out the cards that would cost more with this leader and base">
            <input type="checkbox" checked={onAspect} onChange={(event) => setOnAspect(event.target.checked)} />
            In aspect only
          </label>
          {note && <p className="saved-note">{note}</p>}
        </div>

        <div className="deck-pool">
          {step && (
            <div className="deck-step">
              <h2>Choose {step === 'Leader' ? 'a leader' : 'a base'}</h2>
              {changing && (step === 'Leader' ? leader : base) && (
                <button className="button" type="button" onClick={() => setChanging(null)}>
                  Keep the {step.toLowerCase()} and go back to the cards
                </button>
              )}
            </div>
          )}
          {bar}
          {shown.length === 0 ? (
            <p className="empty-note">No card matches these filters.</p>
          ) : (
            <ul className={step ? `${grid} deck-landscape` : grid}>
              {shown.flatMap(({ item: card }) =>
                // A Sealed pool's card: a tile for each of its printings the pool has
                !step && card.pooled ? (
                  printings
                    .filter((printing) => ownedOf(card, printing) > 0)
                    .map((printing) => (
                      <DeckPoolCard
                        key={`${card.id}:${printing}`}
                        card={card}
                        preview={preview}
                        chosen={false}
                        count={usedOf(card.id, printing)}
                        max={ownedOf(card, printing)}
                        penalty={penaltyOf(card)}
                        onAdd={() => add(card, printing)}
                        onTake={() => take(card, printing)}
                        onSideboard={() => addToSideboard(card, printing)}
                        room={room(card)}
                        printing={printing}
                      />
                    ))
                ) : (
                  <DeckPoolCard
                    key={card.id}
                    card={card}
                    preview={preview}
                    choice={step ?? undefined}
                    chosen={card.id === deck.leader || card.id === deck.base}
                    count={step ? 0 : copies(card.id)}
                    max={card.max}
                    penalty={step ? 0 : penaltyOf(card)}
                    onAdd={(printing) => add(card, printing)}
                    onTake={(printing) => take(card, printing)}
                    onSideboard={(printing) => addToSideboard(card, printing)}
                    toggles={step ? undefined : togglesOf(card)}
                    room={room(card)}
                  />
                ),
              )}
            </ul>
          )}
        </div>
      </div>

      <div className="deck-side">
        {/* What can be done with the deck, over its list */}
        <div className="deck-bar-buttons">
          {unsaved && (
            <>
              <button className="button button-primary" type="button" onClick={() => saveDrafts([deck.id])}>
                Save
              </button>
              {decks.some((saved) => saved.id === deck.id) && (
                <button className="button" type="button" title="Back to the deck as last saved" onClick={() => storeDrafts(withoutDraft(deck.id))}>
                  Undo changes
                </button>
              )}
            </>
          )}
          <button className="button" type="button" onClick={newDeck}>
            New
          </button>
          <button
            className="button"
            type="button"
            onClick={() => addDeck({ ...structuredClone(deck), id: crypto.randomUUID(), name: `${deck.name} (copy)` })}
          >
            Duplicate
          </button>
          <button
            className="button"
            type="button"
            disabled={drawing}
            title="Copies a picture of the deck to share, and shows it"
            onClick={deckImage}
          >
            {drawing ? 'Drawing…' : 'Deck image'}
          </button>
          <button className="button" type="button" onClick={() => downloadText(`${deck.name}.json`, JSON.stringify(deckFile(), null, 2))}>
            Export
          </button>
          <button className="button" type="button" onClick={() => importInput.current?.click()}>
            Import
          </button>
          {import.meta.env.DEV && account?.user.isAdmin && <FeatureButton deck={deck} onNote={setNote} />}
          <input ref={importInput} type="file" accept=".json,application/json" hidden onChange={importDeck} />
          <button
            className="button"
            type="button"
            onClick={() =>
              navigator.clipboard.writeText(deckText()).then(
                () => setNote('The list is copied.'),
                () => setNote('Could not copy the list.'),
              )
            }
          >
            Copy list
          </button>
          {deleting ? (
            <span className="confirm">
              Delete this deck?
              <button
                className="button button-primary"
                type="button"
                onClick={() => {
                  saveDecks(decks.filter((other) => other.id !== deck.id))
                  storeDrafts(withoutDraft(deck.id))
                  setDeleting(false)
                }}
              >
                Yes
              </button>
              <button className="button" type="button" onClick={() => setDeleting(false)}>
                No
              </button>
            </span>
          ) : (
            <button className="button" type="button" onClick={() => setDeleting(true)}>
              Delete
            </button>
          )}
        </div>

        <aside className="deck-panel">
          <DeckChoice label="Leader" card={leader} active={step === 'Leader'} onPick={() => pickChoice('Leader')} />
          <DeckChoice label="Base" card={base} active={step === 'Base'} onPick={() => pickChoice('Base')} />
          {covered && (
            <div className="deck-aspects" title="The aspects the leader and base cover">
              {covered.map((aspect, index) => (
                <img key={index} src={aspectIcon(aspect)} alt={aspect} />
              ))}
            </div>
          )}

          <p className="deck-totals">
            <strong className={mainCount < deckSize ? 'deck-short' : undefined}>
              {mainCount}/{deckSize}
            </strong>{' '}
            cards · sideboard {sealed ? sideboardCount : `${sideboardCount}/${SIDEBOARD_SIZE}`}
          </p>
          {problems.length === 0 ? (
            <p className="deck-legal">Ready to play: the deck follows the {sealed ? 'Sealed' : 'Premier'} rules.</p>
          ) : (
            <ul className="deck-problems">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
          {lost > 0 && (
            <button
              className="button"
              type="button"
              onClick={() =>
                changeDeck({
                  ...deck,
                  cards: deck.cards.filter(({ id }) => byId.has(id)),
                  sideboard: deck.sideboard.filter(({ id }) => byId.has(id)),
                })
              }
            >
              Take the missing cards out
            </button>
          )}

          <div className="deck-tabs" role="tablist">
            {deckPanelTabs.map(({ value, label }) => (
              <button key={value} type="button" role="tab" aria-selected={panelTab === value} onClick={() => setPanelTab(value)}>
                {label}
              </button>
            ))}
          </div>

          {panelTab === 'draw' && <DeckDraw key={deck.id} cards={main} />}
          {panelTab === 'math' && <DeckMath cards={main} />}
          {panelTab === 'list' && deckGroups.map((group) => {
            const rows = main.filter(({ card }) => deckGroup(card) === group).sort(byCost)
            if (rows.length === 0) return null
            return (
              <div key={group}>
                <h3 className="deck-group">
                  {group} ({rows.reduce((sum, { count }) => sum + count, 0)})
                </h3>
                <ul className="deck-rows">
                  {rows.map(({ card, count, entry }) => (
                    <DeckRow
                      key={card.id}
                      card={card}
                      count={count}
                      entry={entry}
                      penalty={penaltyOf(card)}
                      onAdd={() => add(card)}
                      onTake={() => take(card)}
                    >
                      <button className="deck-button" type="button" aria-label="Take a copy out" onClick={() => take(card)}>
                        −
                      </button>
                      <button
                        className="deck-button"
                        type="button"
                        aria-label="Add a copy"
                        disabled={copies(card.id) >= card.max || !printings.some(room(card))}
                        onClick={() => add(card)}
                      >
                        +
                      </button>
                      <button className="deck-button" type="button" title="Move a copy to the sideboard" onClick={() => move(card, true)}>
                        SB
                      </button>
                    </DeckRow>
                  ))}
                </ul>
              </div>
            )
          })}
          {panelTab === 'list' && sideboard.length > 0 && (
            <div>
              <h3 className="deck-group">Sideboard ({sideboardCount})</h3>
              <ul className="deck-rows">
                {[...sideboard].sort(byCost).map(({ card, count, entry }) => (
                  <DeckRow
                    key={card.id}
                    card={card}
                    count={count}
                    entry={entry}
                    penalty={penaltyOf(card)}
                    onAdd={() => addToSideboard(card)}
                    onTake={() => takeFromSideboard(card)}
                  >
                    <button className="deck-button" type="button" aria-label="Take a copy out" onClick={() => takeFromSideboard(card)}>
                      −
                    </button>
                    <button className="deck-button" type="button" title="Move a copy to the deck" onClick={() => move(card, false)}>
                      Deck
                    </button>
                  </DeckRow>
                ))}
              </ul>
            </div>
          )}
          {panelTab === 'list' && tokens.length > 0 && (
            <div>
              <h3 className="deck-group" title="Tokens the deck's cards name">
                Tokens ({tokens.length})
              </h3>
              <ul className="deck-rows">
                {tokens.map((card) => (
                  <li key={card.id} className="deck-row deck-token-row">
                    <HoverPreview enabled preview={card.face}>
                      <span className="deck-row-name">{card.label}</span>
                    </HoverPreview>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>
    </section>
  )
}

// The Deck Builder's formats: Premier, from every card, and Sealed, from a pool of cards opened
type DeckBuilderProps = Parameters<typeof DeckBuilder>[0]
type DeckFormat = 'premier' | 'sealed'

function DeckFormats(props: DeckBuilderProps) {
  const { prefix = 'decks' } = props
  const [format, setFormat] = useRemembered<DeckFormat>(`${prefix}.format`, 'premier')
  return (
    <div className="deck-formats">
      <div className="deck-tabs deck-format-tabs" role="tablist" aria-label="Format">
        {(['premier', 'sealed'] as const).map((value) => (
          <button key={value} type="button" role="tab" aria-selected={format === value} onClick={() => setFormat(value)}>
            {value === 'premier' ? 'Premier' : 'Sealed'}
          </button>
        ))}
      </div>
      {format === 'premier' ? <DeckBuilder {...props} /> : <SealedPools {...props} />}
    </div>
  )
}

// Sealed pools are kept beside the Deck Builder's decks, and each pool's decks under a key of their own
const sealedKey = (storageKey: string | undefined, what: string) => `${storageKey ?? DECKS_KEY}.${what}`

const poolGroups = ['Leaders', 'Bases', ...deckGroups] as const
const poolGroup = (card: DeckCard) => (card.type === 'Leader' ? 'Leaders' : card.type === 'Base' ? 'Bases' : deckGroup(card))
// Saved to the account this long after the last change
const POOL_SAVE_DELAY = 600

// A booster as Star Wars: Unlimited prints them, 16 cards: a leader, a base (a token on its back),
// 8 commons, 3 uncommons, a Prescient card (a full-art card, most often a common), a rare or
// legendary, and last a foil of any rarity. A legendary takes
// the rare slot one pack in 6 (one in 8 in Star Wars: Unlimited); a rare leader or base one in 6
// is a guess, there are no odds published for those. The Prescient card is a foil one pack in 6
// (a legendary there always), and the foil Prescient one pack in 6. The leader and the base are each
// Prescient one pack in 6, as Showcase leaders are Star Wars: Unlimited's full-art leaders.
const BOOSTERS = 6
const LEGENDARY_ODDS = 1 / 6
const RARE_LEADER_ODDS = 1 / 6
const PRESCIENT_FOIL_ODDS = 1 / 6
const PRESCIENT_SIDE_ODDS = 1 / 6
type PackSlot = 'Leader' | 'Base' | 'Common' | 'Uncommon' | 'Prescient' | 'Rare' | 'Legendary' | 'Foil'
type PackCard = { card: DeckCard; slot: PackSlot; printing: Printing }
const boosterBack = asset('/sim/DuneCardBack01.jpg')

const pickOne = <T,>(list: T[]): T | undefined => list[Math.floor(Math.random() * list.length)]
// So many different ones while there are enough, then again from the start
function pickSome<T>(list: T[], count: number) {
  const bag: T[] = []
  const picked: T[] = []
  while (picked.length < count && list.length) {
    if (!bag.length) bag.push(...list)
    picked.push(bag.splice(Math.floor(Math.random() * bag.length), 1)[0])
  }
  return picked
}

// The cards a booster can give: of the set, with a rarity, not a token nor a base's second side
const boosterCards = (cards: DeckCard[], set?: string) =>
  cards.filter((card) => !card.back && card.type !== 'Token' && (!set || card.set === set) && ['C', 'U', 'R', 'L'].includes(card.rarity))

// A Sealed pool's bases, one a booster: each common base once (the Arrakis base of each aspect),
// two-sided rare ones in the boosters left, each a different one
function plannedBases(cards: DeckCard[], set: string | undefined, boosters: number) {
  const bases = boosterCards(cards, set).filter((card) => card.type === 'Base')
  const rares = bases.filter((card) => card.rarity === 'R')
  const commons = bases.filter((card) => card.rarity === 'C')
  return playerBases(commons.length ? commons : rares, [...rares].sort(() => Math.random() - 0.5), boosters, Math.random).map(
    (card) => card.id,
  )
}

// base: the base this booster gives, planned for its pool (see plannedBases); without one, a base
// rare one pack in 6
function openBooster(cards: DeckCard[], set?: string, base?: DeckCard): PackCard[] {
  const offered = boosterCards(cards, set)
  const of = (type: 'Leader' | 'Base' | 'Other', rarity: string) =>
    offered.filter(
      (card) => (type === 'Other' ? card.type !== 'Leader' && card.type !== 'Base' : card.type === type) && card.rarity === rarity,
    )
  // The rarity wanted, or another when the set has none of it
  const firstOf = (...lists: DeckCard[][]) => lists.find((list) => list.length) ?? []
  const pack: PackCard[] = []
  const add = (card: DeckCard | undefined, slot: PackSlot, printing: Printing = 'plain') => card && pack.push({ card, slot, printing })
  for (const type of ['Leader', 'Base'] as const) {
    const rare = Math.random() < RARE_LEADER_ODDS
    const card =
      type === 'Base' && base ? base : pickOne(rare ? firstOf(of(type, 'R'), of(type, 'C')) : firstOf(of(type, 'C'), of(type, 'R')))
    // A leader or a base is Prescient one pack in 6
    add(card, type, card?.prescientFace && Math.random() < PRESCIENT_SIDE_ODDS ? 'prescient' : 'plain')
  }
  // Of any rarity, as often as each is in a pack: 9 commons to 3 uncommons to 1 rare or legendary
  const anyRarity = () => {
    const roll = Math.random() * 13
    return roll < 9 ? 'C' : roll < 12 ? 'U' : Math.random() < LEGENDARY_ODDS ? 'L' : 'R'
  }
  for (const card of pickSome(of('Other', 'C'), 8)) add(card, 'Common')
  for (const card of pickSome(of('Other', 'U'), 3)) add(card, 'Uncommon')
  const prescient = pickOne(firstOf(of('Other', anyRarity()), of('Other', 'C')))
  // A legendary is full art already: as the Prescient card it comes as a foil too
  add(prescient, 'Prescient', prescient?.rarity === 'L' || Math.random() < PRESCIENT_FOIL_ODDS ? 'prescient-foil' : 'prescient')
  const legendary = Math.random() < LEGENDARY_ODDS && of('Other', 'L').length > 0
  const rare = pickOne(legendary ? of('Other', 'L') : firstOf(of('Other', 'R'), of('Other', 'L')))
  add(rare, rare?.rarity === 'L' ? 'Legendary' : 'Rare')
  const foil = pickOne(firstOf(of('Other', anyRarity()), of('Other', 'C')))
  add(foil, 'Foil', foil?.prescientFace && Math.random() < PRESCIENT_FOIL_ODDS ? 'prescient-foil' : 'foil')
  return pack
}

// A booster: the card back in a foil wrapper crimped at both ends
function Booster(props: { label: string; big?: boolean; left?: number; onOpen?: () => void; title?: string }) {
  const { label, big, left, onOpen, title } = props
  return (
    <button
      type="button"
      className={`booster${big ? ' booster-big' : ''}`}
      title={title}
      onClick={(event) => {
        event.stopPropagation()
        onOpen?.()
      }}
    >
      <span className="booster-art" style={{ backgroundImage: `url("${boosterBack}")` }} />
      <span className="booster-sheen" />
      <span className="booster-band">{label}</span>
      <span className="booster-name">Booster</span>
      {left !== undefined && <span className="booster-left">{left} cards left</span>}
    </button>
  )
}


// A card of the pack: its back, turned over to its face
function PackCardView(props: { pack: PackCard; flipped: boolean; leaving?: boolean; delay?: number; onLeft?: () => void }) {
  const { pack, flipped, leaving, delay = 0, onLeft } = props
  const landscape = pack.card.type === 'Leader' || pack.card.type === 'Base'
  const prescient = (pack.printing === 'prescient' || pack.printing === 'prescient-foil') && pack.card.prescientFace !== undefined
  // A leader, a base or the foil that came Prescient glows as the Prescient card does, and says so
  const glows = prescient && pack.slot !== 'Prescient'
  return (
    <div
      className={`pack-card slot-${pack.slot.toLowerCase()}${glows ? ' slot-prescient' : ''}${pack.printing === 'foil' || pack.printing === 'prescient-foil' ? ' pack-foil' : ''}${landscape ? ' pack-landscape' : ''}${leaving ? ' pack-leaving' : ''}`}
      style={{ '--delay': `${delay}ms` } as CSSProperties}
      onAnimationEnd={(event) => event.animationName === 'pack-to-pool' && onLeft?.()}
    >
      <div className={`pack-flip${flipped ? ' pack-flipped' : ''}`}>
        <div className="pack-back" style={{ backgroundImage: `url("${boosterBack}")` }} />
        <div className="pack-front">{(prescient && pack.card.prescientFace) || pack.card.face}</div>
      </div>
      <span className="pack-slot">{glows ? `Prescient ${pack.slot}` : pack.slot}</span>
    </div>
  )
}

// Opening a booster, over the page: a click turns the next card over, the next puts it in the
// pool. Its cards are in the pool already: closing early loses nothing.
function BoosterOpening(props: { pack: PackCard[]; label: string; fast: boolean; onDone: () => void }) {
  const { pack, label, fast, onDone } = props
  const [index, setIndex] = useState(0)
  const [phase, setPhase] = useState<'pack' | 'shown' | 'leaving' | 'all'>(fast ? 'all' : 'pack')
  const [flipped, setFlipped] = useState(false)
  // Turned over a frame after it is drawn, so the turn shows
  useEffect(() => {
    if (phase !== 'shown' && phase !== 'all') return
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => setFlipped(true)))
    return () => cancelAnimationFrame(frame)
  }, [phase, index])
  const advance = () => {
    if (phase === 'pack' || phase === 'shown') playClick()
    if (phase === 'pack') {
      setFlipped(false)
      setPhase('shown')
    } else if (phase === 'shown') setPhase('leaving')
  }
  const left = () => {
    if (index + 1 >= pack.length) return onDone()
    setIndex(index + 1)
    setPhase('pack')
  }
  const revealAll = () => {
    playClick()
    setFlipped(false)
    setPhase('all')
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDone()
      else if (event.key === ' ' || event.key === 'Enter' || event.key === 'ArrowRight') {
        event.preventDefault()
        if (phase === 'all') onDone()
        else advance()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const rest = pack.slice(index)
  return createPortal(
    <div className="booster-stage" role="dialog" aria-label={`Opening a ${label} booster`} onClick={phase === 'all' ? onDone : advance}>
      <div className="booster-stage-bar" onClick={(event) => event.stopPropagation()}>
        <span>
          {label} booster · {phase === 'all' ? `${rest.length} cards` : `card ${index + 1} of ${pack.length}`}
        </span>
        {phase !== 'all' && (
          <button className="button" type="button" onClick={revealAll}>
            Reveal all
          </button>
        )}
        <button className="button button-primary" type="button" onClick={onDone}>
          {phase === 'all' ? 'Add to the pool' : 'Done'}
        </button>
      </div>
      {phase === 'all' ? (
        <div className="pack-all">
          {rest.map((each, i) => (
            <HoverPreview
              key={i}
              enabled
              preview={withBack(each.card, printingFace(each.card, each.printing))}
              width={
                each.card.backFace
                  ? previewWidth(each.card)
                  : each.card.type === 'Leader' || each.card.type === 'Base'
                    ? PREVIEW_WIDTH * 1.4
                    : PREVIEW_WIDTH
              }
            >
              <PackCardView pack={each} flipped={flipped} delay={i * 90} />
            </HoverPreview>
          ))}
        </div>
      ) : (
        <div className={`booster-table${phase === 'pack' ? '' : ' booster-table-card'}`}>
          <Booster label={label} big left={pack.length - index} onOpen={advance} />
          {phase !== 'pack' && (
            <PackCardView key={index} pack={pack[index]} flipped={flipped} leaving={phase === 'leaving'} onLeft={left} />
          )}
        </div>
      )}
      <p className="booster-hint">
        {phase === 'all' ? 'The whole pack, in the pool. Click to close.' : phase === 'pack' ? 'Click to turn over the next card.' : 'Click to put it in your pool.'}
      </p>
    </div>,
    document.body,
  )
}

// Sealed: pools of cards opened from boosters, six to a pool unless more are added, and decks
// built from a pool alone. A pool is saved as it changes.
function SealedPools(props: DeckBuilderProps) {
  const { cards, prefix = 'decks', storageKey, source } = props
  const account = useAccount()
  const poolsKey = sealedKey(storageKey, 'sealed-pools')
  const scope = deckScope(poolsKey)
  const [pools, setPools] = useState<SealedPool[]>(() => (account ? [] : loadDecks<SealedPool>(poolsKey)))
  const [poolState, setPoolState] = useState<'loading' | 'ready' | 'failed'>(account ? 'loading' : 'ready')
  const [note, setNote] = useState<string | null>(null)
  // On the account: what is saved there, the list still to send, and the sends, one after another
  const savedPools = useRef(pools)
  const pending = useRef<SealedPool[] | null>(null)
  const timer = useRef(0)
  const saving = useRef(Promise.resolve())
  const flush = () => {
    window.clearTimeout(timer.current)
    const next = pending.current
    if (!account || !next) return
    pending.current = null
    const before = savedPools.current
    savedPools.current = next
    saving.current = saving.current
      .then(() => syncAccountDecks(account, scope, before, next))
      .catch((err) => setNote(`Could not save to your account: ${(err as Error).message}`))
  }
  useEffect(() => {
    if (!account) {
      setPools(loadDecks<SealedPool>(poolsKey))
      setPoolState('ready')
      return
    }
    let live = true
    setPoolState('loading')
    loadAccountDecks<SealedPool>(account, scope)
      .then((found) => {
        if (!live) return
        savedPools.current = found
        setPools(found)
        setPoolState('ready')
      })
      .catch(() => {
        if (!live) return
        setPoolState('failed')
        setNote('Could not load the pools on your account. Reload the page to try again.')
      })
    return () => {
      live = false
      flush()
    }
  }, [account?.token, scope, poolsKey])

  const [currentId, setCurrentId] = useRemembered(`${prefix}.sealed.pool`, '')
  const [mode, setMode] = useRemembered<'decks' | 'pool'>(`${prefix}.sealed.mode`, 'pool')
  const [fast, setFast] = useRemembered(`${prefix}.sealed.fast`, false)
  const [deleting, setDeleting] = useState(false)
  const [opening, setOpening] = useState<PackCard[] | null>(null)

  // The sets a booster can be of; a Showcase's cards are all of one
  const sets = [...new Set(cards.filter((card) => card.set !== NO_SET).map((card) => card.set))].sort()
  const commonestSet = sets
    .map((set) => ({ set, count: cards.filter((card) => card.set === set).length }))
    .sort((a, b) => b.count - a.count)[0]?.set
  // With no pool yet, a new one is open straight away; it is kept once it has something
  const [firstPool] = useState<SealedPool>(() => ({ id: crypto.randomUUID(), name: 'Pool 1', cards: [] }))
  const pool = pools.find(({ id }) => id === currentId) ?? pools[0] ?? firstPool
  const kept = pools.some(({ id }) => id === pool.id)
  const boosters = pool.boosters ?? BOOSTERS
  const opened = pool.opened ?? 0
  const poolSet = source === 'set' ? undefined : (pool.set ?? commonestSet)

  const storePools = (next: SealedPool[]) => {
    if (account && poolState !== 'ready') {
      setNote('Your account’s pools are still loading. Try again in a moment.')
      return false
    }
    setPools(next)
    if (!account) {
      if (!storeDecks(next, poolsKey)) setNote('Could not save: this browser has run out of storage.')
      return true
    }
    pending.current = next
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(flush, POOL_SAVE_DELAY)
    return true
  }
  const changePool = (next: SealedPool) => {
    const done = storePools(kept ? pools.map((each) => (each.id === next.id ? next : each)) : [...pools, next])
    if (done) setCurrentId(next.id)
    return done
  }
  const newPool = () => {
    const next = { id: crypto.randomUUID(), name: `Pool ${pools.length + 1}`, cards: [] }
    if (!storePools([...pools, next])) return
    setCurrentId(next.id)
    setMode('pool')
    setDeleting(false)
  }
  // A pool goes with its decks
  const deletePool = () => {
    if (!storePools(pools.filter(({ id }) => id !== pool.id))) return
    setDeleting(false)
    const decksKey = sealedKey(storageKey, `sealed.${pool.id}`)
    const decksScope = deckScope(decksKey)
    try {
      localStorage.removeItem(`dune-unlimited.deck-drafts.${decksScope}`)
      if (!account) localStorage.removeItem(decksKey)
    } catch {
      // Nothing kept, then
    }
    if (account)
      loadAccountDecks(account, decksScope)
        .then((found) => syncAccountDecks(account, decksScope, found, []))
        .catch(() => setNote('The pool is deleted, but its decks could not be.'))
  }
  // A booster's cards go in the pool as it is opened; showing them is for the fun of it
  const openNext = () => {
    if (opened >= boosters) return
    // The pool's bases, chosen as its first booster is opened
    const bases = pool.bases ?? (opened === 0 ? plannedBases(cards, poolSet, boosters) : undefined)
    const base = bases?.[opened] ? cards.find((card) => card.id === bases[opened]) : undefined
    const pack = openBooster(cards, poolSet, base)
    if (!pack.length) return setNote('There are no cards to open: no card has a rarity in this set.')
    let entries = pool.cards
    for (const each of pack) entries = withPrinting(entries, each.card.id, each.printing, 1)
    if (changePool({ ...pool, set: poolSet, opened: opened + 1, cards: entries, ...(bases && { bases }) })) setOpening(pack)
  }

  // The pool, card by card
  const byId = new Map(cards.map((card) => [card.id, card]))
  const total = deckCount(pool.cards)
  const inPool = pool.cards.flatMap(({ id, count }) => {
    const card = byId.get(id)
    return card ? [{ card, count }] : []
  })
  const poolFilters = useCardFilters(
    `${prefix}.sealed.opened`,
    inPool.map(({ card }) => ({ item: card, facts: card.facts })),
    'Order saved',
    'number',
  )
  // What a deck of the pool can use: the pool's cards, as many as it has, both sides of its
  // two-sided bases, any common base (as at any Sealed event), and the tokens its cards name
  const counts = new Map(pool.cards.map(({ id, count }) => [id, count]))
  const pooled = new Map(pool.cards.map((entry) => [entry.id, entry]))
  const foilCount = (id: string) => printingCopies(pool.cards, id, 'foil') + printingCopies(pool.cards, id, 'prescient-foil')
  const prescientCount = (id: string) => printingCopies(pool.cards, id, 'prescient') + printingCopies(pool.cards, id, 'prescient-foil')
  // A card the pool has a Prescient copy of shows as that one
  const poolFace = (card: DeckCard) => (prescientCount(card.id) && card.prescientFace) || card.face
  const kinds = (card: DeckCard) =>
    cardVersions
      .flatMap((version) => {
        const count = printingCopies(pool.cards, card.id, version)
        return count ? [`${count} ${printingLabel[version]}`] : []
      })
      .join(', ')
  const poolCards = cards.flatMap((card) => {
    const count = counts.get(card.id.replace(BACK_SIDE, ''))
    if (count) return [{ ...card, max: count, pooled: pooled.get(card.id.replace(BACK_SIDE, '')) }]
    return card.type === 'Token' || (card.type === 'Base' && card.rarity === 'C' && (!poolSet || card.set === poolSet)) ? [card] : []
  })

  const label = poolSet ?? cards.find((card) => card.set !== NO_SET)?.set ?? 'DUNE'
  const poolChoices = (kept ? pools : [...pools, pool]).map(({ id, name }) => ({ value: id, label: name || 'Unnamed pool' }))
  return (
    <div className="sealed">
      {opening && <BoosterOpening pack={opening} label={label} fast={fast} onDone={() => setOpening(null)} />}
      <div className="deck-bar sealed-bar">
        <ChoiceDropdown
          label="Pool"
          options={poolChoices}
          selected={pool.id}
          onChange={(id) => {
            setCurrentId(id)
            setDeleting(false)
          }}
        />
        <input className="deck-name" aria-label="Pool name" value={pool.name} onChange={(event) => changePool({ ...pool, name: event.target.value })} />
        {source !== 'set' && sets.length > 1 && (
          <ChoiceDropdown
            label="Set"
            options={sets.map((set) => ({ value: set, label: set }))}
            selected={poolSet ?? ''}
            onChange={(set) => changePool({ ...pool, set })}
          />
        )}
        <span className="filter-label sealed-boosters" title="Boosters opened">
          {opened}/{boosters} boosters
        </span>
        <button className="button" type="button" title="One more booster for this pool" onClick={() => changePool({ ...pool, boosters: boosters + 1 })}>
          + Booster
        </button>
        <div className="deck-tabs sealed-modes" role="tablist" aria-label="Pool or decks">
          <button type="button" role="tab" aria-selected={mode === 'pool'} onClick={() => setMode('pool')}>
            Pool
          </button>
          <button type="button" role="tab" aria-selected={mode === 'decks'} onClick={() => setMode('decks')}>
            Build decks
          </button>
        </div>
        <div className="deck-bar-buttons">
          <button className="button" type="button" onClick={newPool}>
            New pool
          </button>
          {deleting ? (
            <span className="confirm">
              Delete this pool and its decks?
              <button className="button button-primary" type="button" onClick={deletePool}>
                Yes
              </button>
              <button className="button" type="button" onClick={() => setDeleting(false)}>
                No
              </button>
            </span>
          ) : (
            <button className="button" type="button" disabled={!kept} onClick={() => setDeleting(true)}>
              Delete pool
            </button>
          )}
        </div>
        {note && <p className="saved-note">{note}</p>}
      </div>

      {mode === 'decks' ? (
        total === 0 ? (
          <div className="sealed-empty">
            <p className="empty-note">This pool has no cards yet. Open its boosters, then build decks from them.</p>
            <button className="button button-primary" type="button" onClick={() => setMode('pool')}>
              Open boosters
            </button>
          </div>
        ) : (
          <DeckBuilder
            key={pool.id}
            cards={poolCards}
            prefix={`${prefix}.sealed`}
            storageKey={sealedKey(storageKey, `sealed.${pool.id}`)}
            source={source}
            sealed
          />
        )
      ) : (
        <>
          <div className="booster-shelf">
            {opened < boosters ? (
              <div className="booster-pile">
                {Array.from({ length: boosters - opened }, (_, i) => (
                  <Booster
                    key={i}
                    label={label}
                    onOpen={() => {
                      playClick()
                      openNext()
                    }}
                    title="Open this booster"
                  />
                ))}
              </div>
            ) : (
              <p className="empty-note">Every booster is open. Build decks from the pool, or add a booster.</p>
            )}
            <div className="booster-shelf-side">
              <p className="filter-label">
                {opened < boosters ? 'Click a booster to open it.' : ''} {opened}/{boosters} opened · {total} card{total === 1 ? '' : 's'} in the pool
              </p>
              <label className="toggle deck-toggle" title="Show the whole pack at once">
                <input type="checkbox" checked={fast} onChange={(event) => setFast(event.target.checked)} />
                Fast open
              </label>
            </div>
          </div>
          {total > 0 && (
            <section className="decks">
              <div className="deck-main">
                <div className="deck-pool">
                  {poolFilters.bar}
                  {poolFilters.shown.length === 0 ? (
                    <p className="empty-note">No card matches these filters.</p>
                  ) : (
                    <ul className={poolFilters.grid}>
                      {poolFilters.shown.map(({ item: card }) => (
                        <li key={card.id} className="deck-pool-card">
                          <HoverPreview
                            enabled={poolFilters.preview}
                            preview={withBack(card, foilCount(card.id) ? <div className="foil">{poolFace(card)}</div> : poolFace(card))}
                            width={previewWidth(card)}
                          >
                            <div className={`deck-pool-image${foilCount(card.id) ? ' foil' : ''}`} title={kinds(card) || undefined}>
                              {poolFace(card)}
                              {(counts.get(card.id) ?? 0) > 1 && <span className="deck-badge">{counts.get(card.id)}</span>}
                            </div>
                          </HoverPreview>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
              <div className="deck-side">
                <aside className="deck-panel">
                  <p className="deck-totals">
                    <strong>{total}</strong> card{total === 1 ? '' : 's'} in the pool
                  </p>
                  {poolGroups.map((group) => {
                    const rows = inPool
                      .filter(({ card }) => poolGroup(card) === group)
                      .sort((a, b) => (a.card.cost ?? 0) - (b.card.cost ?? 0) || a.card.name.localeCompare(b.card.name))
                    if (rows.length === 0) return null
                    return (
                      <div key={group}>
                        <h3 className="deck-group">
                          {group} ({rows.reduce((sum, { count }) => sum + count, 0)})
                        </h3>
                        <ul className="deck-rows">
                          {rows.map(({ card, count }) => (
                            <li key={card.id} className="deck-row">
                              <span className="deck-row-count">{count}×</span>
                              <HoverPreview enabled preview={withBack(card, poolFace(card))} width={previewWidth(card)}>
                                <span className="deck-row-name" title={kinds(card) || undefined}>
                                  {prescientCount(card.id) > 0 && <span className="pool-prescient">◈ </span>}
                                  {foilCount(card.id) > 0 && <span className="pool-foil">✦ </span>}
                                  {card.label}
                                </span>
                              </HoverPreview>
                              <span className="deck-row-cost">{card.cost ?? ''}</span>
                              <span className="deck-row-buttons pool-rarity" title="Rarity">{card.rarity}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )
                  })}
                </aside>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}


function FilterGroup<T extends string>(props: {
  label: string
  options: { label: string; value: T; icon?: string }[]
  selected: T | null
  onSelect: (value: T | null) => void
}) {
  const { label, options, selected, onSelect } = props
  return (
    <div className="filter-group">
      <span className="filter-label">{label}</span>
      <button className="chip" aria-pressed={selected === null} onClick={() => onSelect(null)}>
        All
      </button>
      {options.map((option) => (
        <button
          className="chip"
          key={option.value}
          aria-pressed={selected === option.value}
          onClick={() => onSelect(option.value)}
        >
          {option.icon && <img src={option.icon} alt="" />}
          {option.label}
        </button>
      ))}
    </div>
  )
}

function CardCreator(props: {
  draft: Draft
  // True right after a save, until the card is edited again
  saved: boolean
  // Why the last save failed, if it did
  saveError: string | null
  // The showroom's cards, to warn before one is replaced or doubled
  cards: Card[]
  onChange: (draft: Draft) => void
  // As a new card, or in place of the saved card being edited
  onSave: (asNew: boolean) => void
  onNew: () => void
}) {
  const { draft, saved, saveError, cards, onChange, onSave, onNew } = props
  // The preview, for Save and Copy
  const preview = useRef<HTMLDivElement>(null)
  const [format, changeFormat] = useImageFormat()
  const [imageNote, setImageNote] = useState<string | null>(null)
  // A question put before saving, which only stands while the card is left as it was
  const [asked, setAsked] = useState<{ about: 'replace' | 'twin'; asNew: boolean; draft: Draft } | null>(null)
  const question = asked?.draft === draft ? asked : null
  // The saved card being edited, if any. Saving over it as another kind of card, a
  // leader as a unit say, loses what the old kind had: that is asked about first.
  // A new name or subtitle is not, as that is how a card is renamed.
  const original = cards.find((card) => card.id === draft.id)
  // Whether the card in the editor differs from what the Showroom has: always so for
  // a card not saved yet, once anything is typed or picked on it
  const changed = original ? sameCard(original, draft) === false : draft.name.trim() !== '' || draft.art !== undefined
  const replaces = original !== undefined && findFrame(original.frameId).type !== findFrame(draft.frameId).type
  // Name and subtitle together tell cards apart: another card with both the same
  const twinOf = (asNew: boolean) =>
    draft.name.trim() === ''
      ? undefined
      : cards.find((card) => (asNew || card.id !== draft.id) && cardTitle(card) === cardTitle(draft))
  const save = (asNew: boolean, sure = false) => {
    if (!sure && !asNew && replaces) return setAsked({ about: 'replace', asNew, draft })
    if (!sure && twinOf(asNew)) return setAsked({ about: 'twin', asNew, draft })
    setAsked(null)
    onSave(asNew)
  }
  // The frame picker's filters and page are remembered, like the Showroom's
  const [type, setType] = useRemembered<FrameFilter | null>('frames.type', null)
  const [arena, setArena] = useRemembered<Arena | null>('frames.arena', null)
  // 'Neutral' asks for frames with no aspect icons; otherwise frames carrying every
  // picked aspect, as many times as it was picked
  const [picked, setPicked] = useRemembered<Aspect[] | 'Neutral'>('frames.aspects', [])
  // The frame picker shows a page of frames at a time: drawing them all is slow, and
  // the filters are the quicker way to the right one
  const [page, setPage] = useRemembered('frames.page', 0)
  // Which side of a leader is being edited
  const [back, setBack] = useState(false)
  const front = findFrame(draft.frameId)
  // Whether the Prescient version is being edited: only its art and look are its own
  const [prescientTab, setPrescientTab] = useState(false)
  const prescientable = canBePrescient(front.type)
  const onPrescient = prescientTab && prescientable
  const shownCard = onPrescient ? prescientOf(draft) : draft
  const side = cardSide(shownCard, back)
  const { frame } = side
  const bothSides = backFrameOf(draft) ? [front, cardSide(draft, true).frame] : [front]
  // Each side of a leader has its own art. Changing it changes that side alone; a
  // side that has never been given art shows the other side's (see cardSide).
  const setArt = (art?: Art) =>
    onChange(
      onPrescient
        ? { ...draft, prescient: { ...draft.prescient, [side.isBack ? 'backArt' : 'art']: art } }
        : side.isBack
          ? { ...draft, backArt: art }
          : { ...draft, art },
    )
  const setLook = (look: Look) => onChange(onPrescient ? { ...draft, prescient: { ...draft.prescient, look } } : { ...draft, look })
  // On the Prescient tab, the boxes can be moved about over the art in place of the art itself,
  // each side's on its own
  const [movingBoxes, setMovingBoxes] = useState(false)
  const moveBoxes = onPrescient && movingBoxes
  const layoutKey = side.isBack ? 'backLayout' : 'layout'
  const layout = draft.prescient?.[layoutKey]
  const setLayout = (next?: Layout) => {
    const moved = next && Object.fromEntries(Object.entries(next).filter(([, at]) => at && (at.x || at.y)))
    const prescient = { ...draft.prescient, [layoutKey]: moved && Object.keys(moved).length ? moved : undefined }
    // Nothing of its own left, the Prescient version is the card's again
    onChange({ ...draft, prescient: Object.values(prescient).some((value) => value !== undefined) ? prescient : undefined })
  }
  // Name, subtitle and trait: typed on the Leader Unit side, they are kept for that
  // side only, and typed back to what the Leader side says, they follow it again.
  // A field that was empty on the other side when typing began is typed on both.
  const backKeys = { name: 'backName', subtitle: 'backSubtitle', trait: 'backTrait' } as const
  const bothWays = useRef(new Set<SharedKey>())
  const otherIsEmpty = (key: SharedKey) =>
    !front.backId ? false : side.isBack ? !draft[key]?.trim() : draft[backKeys[key]]?.trim() === ''
  const setShared = (key: SharedKey, value: string) => {
    if (bothWays.current.has(key)) return onChange({ ...draft, [key]: value, [backKeys[key]]: undefined })
    if (!side.isBack || side.mirrors) return onChange({ ...draft, [key]: value })
    onChange({ ...draft, [backKeys[key]]: value === (draft[key] ?? '') ? undefined : value })
  }
  // What the shared fields' inputs need: their value, and noting when typing begins and ends
  const sharedInput = (key: SharedKey) => ({
    value: side[key] ?? '',
    onFocus: () => {
      if (otherIsEmpty(key)) bothWays.current.add(key)
    },
    onBlur: () => bothWays.current.delete(key),
    onChange: (event: ChangeEvent<HTMLInputElement>) => setShared(key, event.target.value),
  })
  // Each side of a leader has its own frame. The Leader Unit side's is the one
  // matching the Leader side until another is picked for it, which leaves the
  // Leader side as it is.
  const pickFrame = (candidate: Frame) => {
    // A base frame picked on a base's second side changes that side's aspect alone
    if (side.mirrors && candidate.type === 'Base') return onChange({ ...draft, backFrameId: candidate.id })
    if (!candidate.backOf) return onChange({ ...draft, frameId: candidate.id })
    setBack(true)
    // Picked for a card that is not a leader yet, it brings its Leader side along
    const frameId = front.backId ? draft.frameId : candidate.backOf
    onChange({
      ...draft,
      frameId,
      backFrameId: candidate.id === findFrame(frameId).backId ? undefined : candidate.id,
      backArena: undefined,
    })
  }
  // The card line is remembered for the next card as it is typed
  const setLine = (key: keyof CardLine, value: string) => {
    const next = { ...draft, [key]: value }
    storeCardLine(next)
    onChange(next)
  }
  const shown = frames.filter(
    (candidate) =>
      // Leader Unit frames are offered while that side is being edited, in place of
      // the Leader side ones, and whenever an arena is asked for
      (candidate.backOf ? side.isBack || arena !== null : !(side.isBack && candidate.backId)) &&
      (type === null ||
        candidate.type === type ||
        (type === 'Token' && candidate.token === true) ||
        (type === 'Pilot' && candidate.pilotBox !== undefined)) &&
      (arena === null || candidate.arena === arena) &&
      (picked === 'Neutral'
        ? candidate.aspects.length === 0
        : picked.every((aspect) => countOf(candidate.aspects, aspect) >= countOf(picked, aspect))),
  )
  const pages = Math.ceil(shown.length / FRAMES_PER_PAGE)
  // New filters start again from the first page
  const filter = <T,>(set: (value: T) => void, value: T) => {
    set(value)
    setPage(0)
  }
  // A change of filters can leave fewer pages than the one shown
  const onPage = Math.min(page, Math.max(0, pages - 1))

  return (
    <div className="creator">
      <section className="editor">
        <div className="editor-fields editor-side">
          {prescientable && (
            <div className="side-toggle" title="A booster's Prescient card: this card in full art">
              <button className="chip" type="button" aria-pressed={!onPrescient} onClick={() => setPrescientTab(false)}>
                Card
              </button>
              <button className="chip" type="button" aria-pressed={onPrescient} onClick={() => setPrescientTab(true)}>
                Prescient
              </button>
            </div>
          )}
          {onPrescient && (
            <p className="empty-note prescient-note">
              {draft.prescient
                ? 'This card’s Prescient version has art, a look or a layout of its own. The rest is the card’s.'
                : 'The card’s art with the Prescient look, until you change them here. The rest is the card’s.'}
              {draft.prescient && (
                <button className="button" type="button" onClick={() => onChange({ ...draft, prescient: undefined })}>
                  Back to the card’s art
                </button>
              )}
            </p>
          )}
          {onPrescient && (
            <div className="move-boxes">
              <button
                className="chip"
                type="button"
                aria-pressed={movingBoxes}
                title="Hold the art where it is and drag the name, text, icons and other boxes over it instead"
                onClick={() => setMovingBoxes(!movingBoxes)}
              >
                Move boxes
              </button>
              {layout && (
                <button className="button" type="button" onClick={() => setLayout(undefined)}>
                  Put the boxes back
                </button>
              )}
              {moveBoxes && (
                <p className="empty-note">
                  Drag a box on the card to move it; double-click it to put it back. The art stays where it is
                  {backFrameOf(draft) ? ', and each side has its own layout' : ''}.
                </p>
              )}
            </div>
          )}
          <h2>Art</h2>
          <ArtControls art={side.art} onChange={setArt} />
          <h2>Frame &amp; text</h2>
          <LookControls look={shownCard.look ?? defaultLook} onChange={setLook} />
        </div>

        <div className="editor-preview-column">
          <div ref={preview}>
            {moveBoxes ? (
              <BoxDrag frame={frame} layout={layout} onChange={setLayout}>
                <CardFace card={shownCard} back={back} />
              </BoxDrag>
            ) : (
              <ArtDrag art={side.art} onChange={setArt}>
                <CardFace card={shownCard} back={back} />
              </ArtDrag>
            )}
          </div>
          <div className="editor-actions preview-actions">
            <ImageButtons
              holder={preview}
              frame={frame}
              fileName={cardFileName(draft, back) + (onPrescient ? ' (Prescient)' : '')}
              format={format}
              onFormat={changeFormat}
              onNote={setImageNote}
            />
          </div>
          {imageNote && <p className="saved-note">{imageNote}</p>}
            <div className="editor-actions">
              <button
                className={changed ? 'button button-primary button-pending' : 'button'}
                type="button"
                title={changed ? 'This card has changes the Showroom does not have yet' : 'The Showroom has this card as it is'}
                onClick={() => save(!original)}
              >
                {original ? (changed ? 'Update in Showroom •' : 'Up to date') : 'Save to Showroom'}
              </button>
              {original && (
                <button className="button" type="button" onClick={() => save(true)}>
                  Save as new card
                </button>
              )}
              <button className="button" type="button" onClick={onNew}>
                New card
              </button>
            </div>
            {original && !question && (
              <p className="saved-note">
                Editing <strong>{cardLabel(original)}</strong>. Update changes that card; Save as new card leaves it as
                it is and adds this one.
              </p>
            )}
            {question?.about === 'replace' && original && (
              <div className="save-question">
                <p>
                  <strong>{cardLabel(original)}</strong> is a {findFrame(original.frameId).type.toLowerCase()} in the
                  Showroom. Updating it would turn it into this {findFrame(draft.frameId).type.toLowerCase()}.
                </p>
                <div className="editor-actions">
                  <button className="button button-primary" type="button" onClick={() => save(true)}>
                    Save as new card
                  </button>
                  <button className="button" type="button" onClick={() => save(false, true)}>
                    Replace it
                  </button>
                  <button className="button" type="button" onClick={() => setAsked(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {question?.about === 'twin' && (
              <div className="save-question">
                <p>
                  <strong>{cardLabel(draft)}</strong> is already in the Showroom. Name and subtitle together should
                  be one card's alone.
                </p>
                <div className="editor-actions">
                  <button className="button" type="button" onClick={() => save(question.asNew, true)}>
                    Save anyway
                  </button>
                  <button className="button" type="button" onClick={() => setAsked(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {saveError && <p className="error-note">{saveError}</p>}
            {saved && (
              <p className="saved-note">
                Saved. <a href="#showroom">See it in the Showroom</a>
              </p>
            )}
        </div>

        <div className="editor-fields">
          <h2>{frame.name}</h2>
          {front.backId && (
            <div className="side-toggle">
              <button className="chip" type="button" aria-pressed={!side.isBack} onClick={() => setBack(false)}>
                Leader side
              </button>
              <button className="chip" type="button" aria-pressed={side.isBack} onClick={() => setBack(true)}>
                Leader Unit side
              </button>
            </div>
          )}
          {front.type === 'Base' && (
            <div className="side-toggle" title="A two-sided base has the same name, text and HP on both sides; a deck plays the aspect of the side it chooses">
              <span className="filter-label">Second side</span>
              {[undefined, ...aspects.slice(0, 4).filter((aspect) => !front.aspects.includes(aspect))].map((aspect) => {
                const pressed = (bothSides[1]?.aspects[0] ?? undefined) === aspect
                return (
                  <button
                    key={aspect ?? 'none'}
                    className="chip"
                    type="button"
                    aria-pressed={pressed}
                    onClick={() => {
                      if (!aspect) setBack(false)
                      onChange({ ...draft, backFrameId: aspect && baseFrameOf(aspect, front.textBox !== undefined).id })
                    }}
                  >
                    {aspect ?? 'None'}
                  </button>
                )
              })}
            </div>
          )}
          {front.type === 'Base' && bothSides[1] && (
            <div className="side-toggle">
              <button className="chip" type="button" aria-pressed={!side.isBack} onClick={() => setBack(false)}>
                {front.aspects[0]} side
              </button>
              <button className="chip" type="button" aria-pressed={side.isBack} onClick={() => setBack(true)}>
                {bothSides[1].aspects[0]} side
              </button>
            </div>
          )}
          {side.isBack && side.mirrors && (
            <p className="empty-note">
              Both sides share the name, location, HP and game text: changed here, they change on both. The art is
              the first side's until you give this side its own.
            </p>
          )}
          {side.isBack && !side.mirrors && (
            <p className="empty-note">
              Name, subtitle, trait and art are the Leader side's until you change them here. Pick a frame below
              to change this side's frame alone: a Space one, or other aspects.
            </p>
          )}
          <div className="name-row">
            <label>
              Name
              <input {...sharedInput('name')} />
            </label>
            {canBeUnique(frame) && (
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={draft.unique ?? false}
                  onChange={(event) => onChange({ ...draft, unique: event.target.checked })}
                />
                Unique
              </label>
            )}
          </div>
          {frame.subtitle && isUnique(frame, draft.unique) && (
            <label>
              Subtitle
              <input {...sharedInput('subtitle')} />
            </label>
          )}
          {stats.some(({ kind }) => bothSides.some((each) => hasStat(each, kind))) && (
            <div className="stats">
              {stats.map(
                ({ kind, label }) =>
                  bothSides.some((each) => hasStat(each, kind)) && (
                    <NumberPicker
                      key={kind}
                      label={label}
                      value={draft[kind]}
                      options={frame.type === 'Base' ? baseHp : kind !== 'cost' && frame.modifiers ? modifiers : numbers}
                      format={kind !== 'cost' && frame.modifiers ? formatModifier : undefined}
                      digits={frame.type === 'Base' ? 2 : undefined}
                      onChange={(value) => onChange({ ...draft, [kind]: value })}
                    />
                  ),
              )}
            </div>
          )}
          <label>
            {frame.type === 'Base' ? 'Location' : 'Trait'}
            <input {...sharedInput('trait')} />
            {frame.type !== 'Base' && <span>Separate several traits with commas: Trooper, Atreides</span>}
          </label>
          {frame.textBox ? (
            <label>
              Game text
              <textarea
                rows={7}
                value={side.text}
                onChange={(event) =>
                  onChange({ ...draft, [side.isBack && !side.mirrors ? 'backText' : 'text']: event.target.value })
                }
              />
              <span>
                In brackets: [Hidden] or [Raid 2] prints a keyword in red, as does [Keywords], and so does a keyword of
                your own with # before it, [#Elusive]; [3] a cost on the yellow icon, [#3] a cost as
                a number alone, [+1/+0] a change to power and HP, [P3] a power and [H7] an HP alone, [Arrow] the exhaust arrow, [Villainy] or another aspect its icon, anything else bold. Doubled brackets print
                the brackets too: {"[Action [[Arrow]]:]"} or {"[Action [[1, Arrow]]:]"}.
                In curly brackets, text is italic: {"{reminder text}"}, or {"[{Imperial}]"} for bold italic. A line
                between {"< >"} gets Sentinel's red box, between {"<< >>"} the tinted one; a line that is only
                [Sentinel] gets it by itself. A line starting with - prints a dot, for a choice in a list.
              </span>
            </label>
          ) : (
            <p className="empty-note">This frame has no game text box.</p>
          )}
          {bothSides.some((each) => each.pilotBox) && (
            <>
              <h3 className="editor-subhead">Played as an upgrade</h3>
              <div className="stats">
                <NumberPicker
                  label="Power"
                  value={draft.upgradePower}
                  options={modifiers}
                  format={formatModifier}
                  onChange={(upgradePower) => onChange({ ...draft, upgradePower })}
                />
                <NumberPicker
                  label="HP"
                  value={draft.upgradeHp}
                  options={modifiers}
                  format={formatModifier}
                  onChange={(upgradeHp) => onChange({ ...draft, upgradeHp })}
                />
              </div>
              <label>
                Piloting text
                <textarea
                  rows={4}
                  value={draft.pilotText ?? ''}
                  placeholder={'[Piloting] [[2 Command Villainy]]'}
                  onChange={(event) => onChange({ ...draft, pilotText: event.target.value })}
                />
                <span>
                  Printed in the Piloting box, which grows with it, leaving the game text above the rest of the space.
                  Start it with PILOTING and its cost and aspects: {"[Piloting] [[2 Command Villainy]]"}.
                </span>
              </label>
            </>
          )}
          {frame.epicBox && (
            <label>
              Epic Action
              <textarea
                rows={3}
                value={draft.epic ?? epicText(draft.cost, front.deploysAsUpgrade)}
                onChange={(event) =>
                  // Text left as the usual one is not kept, so its number goes on following the cost
                  onChange({
                    ...draft,
                    epic:
                      event.target.value === epicText(draft.cost, front.deploysAsUpgrade)
                        ? undefined
                        : event.target.value,
                  })
                }
              />
              <span>Until you change it, the number of resources follows the cost.</span>
            </label>
          )}
          <h3 className="editor-subhead">Card line</h3>
          <div className="card-line-fields">
            {(
              [
                ['artist', 'Artist', 'artist'],
                ['block', 'Block', 'block'],
                ['number', 'Number', 'number'],
                ['setCode', 'Set', 'set'],
                ['language', 'Lang.', 'language'],
              ] as const
            ).map(([key, label, area]) => (
              <label key={key} style={{ gridArea: area }}>
                {label}
                <input
                  value={draft[key] ?? ''}
                  maxLength={key === 'block' ? 1 : undefined}
                  onChange={(event) => setLine(key, event.target.value)}
                />
              </label>
            ))}
            <div style={{ gridArea: 'rarity' }}>
              <RarityPicker value={draft.rarity} onChange={(rarity) => setLine('rarity', rarity)} />
            </div>
            {(draft.rarity === 'R' || draft.rarity === 'L') && (
              <label className="toggle card-line-foil-toggle" title="The holographic stamp of rare and legendary cards">
                <input
                  type="checkbox"
                  checked={draft.foil !== false}
                  onChange={(event) => onChange({ ...draft, foil: event.target.checked })}
                />
                Foil
              </label>
            )}
            <label className="toggle card-line-legends-toggle" title="A Legends card: the gold bar along the bottom of its frame">
              <input type="checkbox" checked={draft.legends === true} onChange={(event) => onChange({ ...draft, legends: event.target.checked || undefined })} />
              Legends
            </label>
          </div>
        </div>
      </section>

      <section>
        <h2>Frame</h2>
        <div className="filters">
          <FilterGroup label="Type" options={typeFilters} selected={type} onSelect={(next) => filter(setType, next)} />
          <FilterGroup label="Arena" options={arenaFilters} selected={arena} onSelect={(next) => filter(setArena, next)} />
          <AspectFilter picked={picked} onPick={(next) => filter(setPicked, next)} />
        </div>

        {shown.length === 0 ? (
          <p className="empty-note">No frame for this combination yet.</p>
        ) : (
          <ul className="frame-grid">
            {shown.slice(onPage * FRAMES_PER_PAGE, (onPage + 1) * FRAMES_PER_PAGE).map((candidate) => (
              <li key={candidate.id}>
                <button
                  className="frame-option"
                  aria-pressed={candidate.id === frame.id}
                  onClick={() => pickFrame(candidate)}
                >
                  <CardView frame={candidate} thumb />
                  <span className="card-caption">
                    {candidate.name}
                    <span>
                      {candidate.arena ?? candidate.type}
                      {candidate.aspects.length === 0
                        ? ' · Neutral'
                        : candidate.aspects.map((name, index) => (
                            <img key={index} src={aspectIcon(name)} alt={name} title={name} />
                          ))}
                    </span>
                  </span>
                  {candidate.notes && <span className="card-notes">{candidate.notes}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {pages > 1 && (
          <div className="pager">
            <button className="button" type="button" disabled={onPage === 0} onClick={() => setPage(onPage - 1)}>
              Previous
            </button>
            <span>
              Page {onPage + 1} of {pages} · {shown.length} frames
            </span>
            <button
              className="button"
              type="button"
              disabled={onPage === pages - 1}
              onClick={() => setPage(onPage + 1)}
            >
              Next
            </button>
          </div>
        )}
      </section>
    </div>
  )
}

const FRAMES_PER_PAGE = 20

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

// The card being edited. Over it, the art can be dragged into place with the mouse
// or a finger, zoomed with the scroll wheel, and turned with Shift and the wheel;
// the sliders do the same more finely.
function ArtDrag(props: { art?: Art; onChange: (art: Art) => void; children: React.ReactNode }) {
  const { art, onChange, children } = props
  const ref = useRef<HTMLDivElement>(null)
  // Where the drag started, and where the art was then
  const start = useRef<{ x: number; y: number; art: Art }>(null)
  // The wheel listener is attached once, so it reads the latest art from here
  const latest = useRef({ art, onChange })
  useEffect(() => {
    latest.current = { art, onChange }
  })

  // React's own wheel handler cannot stop the page scrolling under the card
  const hasArt = art !== undefined
  useEffect(() => {
    const el = ref.current
    if (!el || !hasArt) return
    const onWheel = (event: WheelEvent) => {
      const { art, onChange } = latest.current
      if (!art) return
      event.preventDefault()
      // With Shift held, some browsers report the wheel as sideways scrolling
      const steps = (event.deltaY || event.deltaX) / 100
      if (event.shiftKey) {
        onChange({ ...art, rotate: clamp(Math.round((art.rotate ?? 0) + steps * 2), -180, 180) })
      } else {
        onChange({ ...art, zoom: clamp(Math.round((art.zoom - steps * 0.05) * 100) / 100, 0.5, 3) })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [hasArt])

  if (!art) return <div className="editor-preview">{children}</div>
  return (
    <div
      ref={ref}
      className="editor-preview art-drag"
      title="Drag to move the art, scroll to zoom, Shift + scroll to turn"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId)
        start.current = { x: event.clientX, y: event.clientY, art }
      }}
      onPointerMove={(event) => {
        const from = start.current
        if (!from) return
        const card = event.currentTarget.getBoundingClientRect()
        onChange({
          ...art,
          x: clamp(Math.round(from.art.x + ((event.clientX - from.x) / card.width) * 100), -100, 100),
          y: clamp(Math.round(from.art.y + ((event.clientY - from.y) / card.height) * 100), -100, 100),
        })
      }}
      onPointerUp={() => (start.current = null)}
      onPointerCancel={() => (start.current = null)}
    >
      {children}
    </div>
  )
}

// The card being edited, its boxes moved instead of its art: each part the card has is
// outlined over it, to drag where the art wants it. Double-clicking one puts it back.
const partNames: Record<BoxPart, string> = {
  label: 'Top bar words',
  name: 'Name',
  trait: 'Traits',
  text: 'Game text',
  epic: 'Epic Action',
  cost: 'Cost',
  aspects: 'Aspects',
  power: 'Power',
  hp: 'HP',
}

// How close to the card's edge, in the frame's pixels, its own frames print anything: where the
// card line along the bottom starts
const SAFE_MARGIN = 30

function BoxDrag(props: { frame: Frame; layout?: Layout; onChange: (layout: Layout) => void; children: React.ReactNode }) {
  const { frame, layout = {}, onChange, children } = props
  const ref = useRef<HTMLDivElement>(null)
  const start = useRef<{ part: BoxPart; x: number; y: number; at: { x: number; y: number } }>(null)
  const [dragging, setDragging] = useState<BoxPart | null>(null)
  // The biggest underneath, so a small box over a big one can still be grabbed
  const parts = partBoxes(frame).sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)
  const pct = (value: number, of: number) => `${(value / of) * 100}%`
  return (
    <div ref={ref} className="editor-preview box-drag">
      {children}
      {/* Keep what the card says inside this line: past it, a print's trim may cut into it */}
      <div
        className="box-safe"
        style={{
          left: pct(SAFE_MARGIN, frame.width),
          right: pct(SAFE_MARGIN, frame.width),
          top: pct(SAFE_MARGIN, frame.height),
          bottom: pct(SAFE_MARGIN, frame.height),
        }}
      />
      {parts.map(({ part, box }) => {
        const at = layout[part] ?? { x: 0, y: 0 }
        return (
          <div
            key={part}
            className={`box-handle${dragging === part ? ' dragging' : ''}`}
            style={{
              left: pct(box.x + at.x, frame.width),
              top: pct(box.y + at.y, frame.height),
              width: pct(box.w, frame.width),
              height: pct(box.h, frame.height),
            }}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId)
              start.current = { part, x: event.clientX, y: event.clientY, at }
              setDragging(part)
            }}
            onPointerMove={(event) => {
              const from = start.current
              const card = ref.current?.getBoundingClientRect()
              if (!from || !card) return
              onChange({
                ...layout,
                [from.part]: {
                  x: clamp(Math.round(from.at.x + ((event.clientX - from.x) / card.width) * frame.width), -frame.width, frame.width),
                  y: clamp(Math.round(from.at.y + ((event.clientY - from.y) / card.height) * frame.height), -frame.height, frame.height),
                },
              })
            }}
            onPointerUp={() => {
              start.current = null
              setDragging(null)
            }}
            onPointerCancel={() => {
              start.current = null
              setDragging(null)
            }}
            onDoubleClick={() => onChange({ ...layout, [part]: undefined })}
          >
            <span>{partNames[part]}</span>
          </div>
        )
      })}
    </div>
  )
}

// A themed replacement for a <select> of numbers: a button that opens a small grid
const allegiances: Aspect[] = ['Heroism', 'Villainy']
const countOf = (list: Aspect[], aspect: Aspect) => list.filter((other) => other === aspect).length

// A card has up to two colour aspects, which can be the same one twice, and
// may add Heroism or Villainy. Clicking a colour goes once, twice, off.
function AspectFilter(props: { picked: Aspect[] | 'Neutral'; onPick: (picked: Aspect[] | 'Neutral') => void }) {
  const { picked, onPick } = props
  const chosen = picked === 'Neutral' ? [] : picked
  const colours = chosen.filter((aspect) => !allegiances.includes(aspect))

  const click = (aspect: Aspect) => {
    const others = chosen.filter((other) => other !== aspect)
    if (allegiances.includes(aspect)) {
      // Heroism and Villainy exclude each other
      onPick(chosen.includes(aspect) ? others : [...others.filter((other) => !allegiances.includes(other)), aspect])
    } else if (chosen.includes(aspect) && colours.length === MAX_COLOURS) {
      onPick(others)
    } else {
      onPick([...chosen, aspect])
    }
  }

  return (
    <div className="filter-group">
      <span className="filter-label">Aspect</span>
      <button className="chip" aria-pressed={picked !== 'Neutral' && chosen.length === 0} onClick={() => onPick([])}>
        All
      </button>
      <button
        className="chip"
        aria-pressed={picked === 'Neutral'}
        onClick={() => onPick(picked === 'Neutral' ? [] : 'Neutral')}
      >
        Neutral
      </button>
      {aspects.map((aspect) => {
        const count = countOf(chosen, aspect)
        const isColour = !allegiances.includes(aspect)
        return (
          <button
            className="chip"
            key={aspect}
            aria-pressed={count > 0}
            disabled={isColour && count === 0 && colours.length === MAX_COLOURS}
            onClick={() => click(aspect)}
          >
            <img src={aspectIcon(aspect)} alt="" />
            {count === 2 && <img src={aspectIcon(aspect)} alt="" />}
            {aspect}
            {count === 2 && ' ×2'}
          </button>
        )
      })}
    </div>
  )
}

const rarities = [
  { value: 'C', label: 'Common' },
  { value: 'U', label: 'Uncommon' },
  { value: 'R', label: 'Rare' },
  { value: 'S', label: 'Special' },
  { value: 'L', label: 'Legendary' },
]

// The rarity, picked like the numbers: a button that opens a list, each with its symbol
function RarityPicker(props: { value?: string; onChange: (value: string) => void }) {
  const { value, onChange } = props
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const current = rarities.find((rarity) => rarity.value === value)
  const choose = (next: string) => {
    onChange(next)
    setOpen(false)
  }
  const symbol = (rarity: string) => (
    <img className="rarity-symbol" src={asset(`/icons/rarity/${rarity.toLowerCase()}.png`)} alt="" />
  )

  return (
    <div className="picker rarity-picker" ref={ref}>
      <span>Rarity</span>
      <button
        className="picker-button"
        type="button"
        aria-label="Rarity"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {current ? (
          <>
            {symbol(current.value)}
            {current.label}
          </>
        ) : (
          '–'
        )}
      </button>
      {open && (
        <div className="picker-options rarity-options" role="listbox" aria-label="Rarity">
          <button type="button" role="option" aria-selected={!current} onClick={() => choose('')}>
            –
          </button>
          {rarities.map((rarity) => (
            <button
              type="button"
              role="option"
              key={rarity.value}
              aria-selected={rarity.value === value}
              onClick={() => choose(rarity.value)}
            >
              {symbol(rarity.value)}
              {rarity.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function NumberPicker(props: {
  label: string
  value?: number
  options: number[]
  format?: (value: number) => string
  // A number can also be typed, up to this many digits
  digits?: number
  onChange: (value?: number) => void
}) {
  const { label, value, options, format = String, digits, onChange } = props
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const choose = (next?: number) => {
    onChange(next)
    setOpen(false)
  }

  return (
    <div className="picker" ref={ref}>
      <span>{label}</span>
      {digits ? (
        <input
          className="picker-button"
          inputMode="numeric"
          maxLength={digits}
          aria-label={label}
          aria-haspopup="listbox"
          aria-expanded={open}
          placeholder="–"
          value={value ?? ''}
          onClick={() => setOpen(!open)}
          onChange={(event) => {
            const typed = event.target.value.replace(/\D/g, '').slice(0, digits)
            onChange(typed === '' ? undefined : Number(typed))
          }}
        />
      ) : (
        <button
          className="picker-button"
          type="button"
          aria-label={label}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {value === undefined ? '–' : format(value)}
        </button>
      )}
      {open && (
        <div className="picker-options" role="listbox" aria-label={label}>
          <button type="button" role="option" aria-selected={value === undefined} onClick={() => choose()}>
            –
          </button>
          {options.map((number) => (
            <button
              type="button"
              role="option"
              key={number}
              aria-selected={value === number}
              onClick={() => choose(number)}
            >
              {format(number)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Slider(props: {
  label: string
  min: number
  max: number
  step: number
  value: number
  // Shown after the slider, for settings where the number means something
  display?: string
  onChange: (value: number) => void
}) {
  const { label, min, max, step, value, display, onChange } = props
  return (
    <label className="slider">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {display && <output>{display}</output>}
    </label>
  )
}

// Ways to keep the text readable when the frame is made see-through
function LookControls(props: { look: Look; onChange: (look: Look) => void }) {
  const { look, onChange } = props
  const sliders = [
    { label: 'Frame opacity', key: 'frameOpacity', min: 0, max: 1 },
    { label: 'Panel fill', key: 'panelFill', min: 0, max: 1 },
    { label: 'Panel blur', key: 'panelBlur', min: 0, max: 1 },
    { label: 'Text glow', key: 'textGlow', min: 0, max: 1 },
  ] as const

  return (
    <div className="art-controls">
      {sliders.map(({ label, key, min, max }) => (
        <div className="look-row" key={key}>
          <Slider
            label={label}
            min={min}
            max={max}
            step={0.01}
            value={look[key]}
            display={`${Math.round(look[key] * 100)}%`}
            onChange={(value) => onChange({ ...look, [key]: value })}
          />
          {/* Which parts of the frame its opacity applies to */}
          {key === 'frameOpacity' && (
            <div className="fade-parts">
              <button
                className="chip"
                type="button"
                title="Fade the top of the frame, down to the power and HP icons"
                aria-pressed={look.fadeTop !== false}
                onClick={() => onChange({ ...look, fadeTop: look.fadeTop === false })}
              >
                Top
              </button>
              <button
                className="chip"
                type="button"
                title="Fade the bottom of the frame, from the power and HP icons down"
                aria-pressed={look.fadeBottom !== false}
                onClick={() => onChange({ ...look, fadeBottom: look.fadeBottom === false })}
              >
                Bottom
              </button>
              <label className="toggle" title="The game text box, the name bar and the subtitle bar">
                <input
                  type="checkbox"
                  checked={look.solidText === true}
                  onChange={(event) => onChange({ ...look, solidText: event.target.checked })}
                />
                Solid text boxes
              </label>
              <label className="toggle" title="Cost, aspects, power and HP, and the bar saying the type and arena">
                <input
                  type="checkbox"
                  checked={look.solidIcons === true}
                  onChange={(event) => onChange({ ...look, solidIcons: event.target.checked })}
                />
                Solid icons
              </label>
            </div>
          )}
        </div>
      ))}
      <label className="toggle">
        <input
          type="checkbox"
          checked={look.lightText}
          onChange={(event) => onChange({ ...look, lightText: event.target.checked })}
        />
        Light text
      </label>
      <div className="editor-actions">
        <button className="button" type="button" onClick={() => onChange(defaultLook)}>
          Reset frame &amp; text
        </button>
      </div>
    </div>
  )
}

function ArtControls(props: { art?: Art; onChange: (art?: Art) => void }) {
  const { art, onChange } = props
  // The dev server sends the new list when an image is added to or removed from public/art
  const [files, setFiles] = useState(artFiles)
  const [uploadError, setUploadError] = useState<string | null>(null)
  // Newest art comes first, so the list goes back to its top to show what arrived
  const folder = useRef<HTMLUListElement>(null)
  useEffect(() => {
    const update = (list: string[]) => {
      setFiles(list)
      folder.current?.scrollTo({ top: 0, behavior: 'smooth' })
    }
    import.meta.hot?.on('art-list', update)
    return () => import.meta.hot?.off('art-list', update)
  }, [])
  const sliders = [
    { label: 'Zoom', key: 'zoom', min: 0.5, max: 3, step: 0.01 },
    { label: 'Left / right', key: 'x', min: -100, max: 100, step: 1 },
    { label: 'Up / down', key: 'y', min: -100, max: 100, step: 1 },
    { label: 'Turn', key: 'rotate', min: -180, max: 180, step: 1 },
  ] as const

  return (
    <div className="art-controls">
      {/* Images in public/art, on a computer that has the folder: picking one stores
          only its path, not a copy. New art starts filling the whole card. */}
      {files.length > 0 && (
        <ul className="art-folder" ref={folder}>
          {files.map((src) => (
            <li key={src}>
              <button
                type="button"
                title={src.slice('/art/'.length)}
                aria-pressed={art?.src === src}
                onClick={() => onChange({ src, zoom: 1, x: 0, y: 0 })}
              >
                <img src={asset(src)} alt={src.slice('/art/'.length)} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="editor-actions">
        <label className="button">
          Upload from computer
          <input
            type="file"
            accept="image/*"
            onChange={async (event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (!file) return
              setUploadError(null)
              try {
                onChange({ src: await readArtFile(file), zoom: 1, x: 0, y: 0 })
              } catch {
                setUploadError('This browser could not read that image. Try a JPG or PNG.')
              }
            }}
          />
        </label>
        {art && (
          <button className="button" type="button" onClick={() => onChange(undefined)}>
            Remove art
          </button>
        )}
        {art && (
          <button className="button" type="button" onClick={() => onChange({ ...art, zoom: 1, x: 0, y: 0, rotate: 0 })}>
            Reset position
          </button>
        )}
      </div>
      {uploadError && <p className="error-note">{uploadError}</p>}
      {art && (
        <label className="toggle">
          <input
            type="checkbox"
            checked={art.fill !== false}
            onChange={(event) => onChange({ ...art, fill: event.target.checked })}
          />
          Fill gaps around the art
        </label>
      )}
      {art &&
        sliders.map(({ label, key, min, max, step }) => (
          <Slider
            key={key}
            label={label}
            min={min}
            max={max}
            step={step}
            value={art[key] ?? 0}
            display={key === 'rotate' ? `${art.rotate ?? 0}°` : undefined}
            onChange={(value) => onChange({ ...art, [key]: value })}
          />
        ))}
    </div>
  )
}

function App() {
  const [tab, setTab] = useState<TabId>(tabFromHash)
  const [showcase, setShowcase] = useState(showcaseFromHash)
  const [viewing, setViewing] = useState(showroomOwnerFromHash)
  const [cards, setCards] = useState<Card[]>(loadCards)
  const [draft, setDraft] = useState<Draft>(() => loadDraft() ?? { ...blankDraft, ...loadCardLine() })
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Going to another page with changes not saved: the page stays while the question is asked
  const [leaving, setLeaving] = useState<{ hash: string; what: string } | null>(null)
  const shownHash = useRef(window.location.hash)
  useEffect(() => {
    const onHashChange = () => {
      const guard = leaveGuard()
      if (guard && window.location.hash !== shownHash.current) {
        setLeaving({ hash: window.location.hash, what: guard.what })
        history.replaceState(null, '', shownHash.current || window.location.pathname)
        return
      }
      shownHash.current = window.location.hash
      setTab(tabFromHash())
      setShowcase(showcaseFromHash())
      setViewing(showroomOwnerFromHash())
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])
  // Saved or not, the page the question was asked for opens; what wasn't saved stays as it was
  const leave = (save: boolean) => {
    if (!leaving) return
    if (save) leaveGuard()?.save()
    shownHash.current = leaving.hash
    setLeaving(null)
    window.location.hash = leaving.hash
    setTab(tabFromHash())
    setShowcase(showcaseFromHash())
    setViewing(showroomOwnerFromHash())
  }
  const leaveModal = leaving && (
    <Modal title="Save your changes?" onClose={() => setLeaving(null)}>
      <p className="account-note">{leaving.what} has changes that aren't saved.</p>
      <div className="leave-buttons">
        <button className="button" type="button" onClick={() => setLeaving(null)}>
          Cancel
        </button>
        <button className="button" type="button" onClick={() => leave(false)}>
          Don't save
        </button>
        <button className="button button-primary" type="button" onClick={() => leave(true)}>
          Save
        </button>
      </div>
    </Modal>
  )

  // Kept shortly after the last change rather than on every keystroke: art can be large
  useEffect(() => {
    const timer = setTimeout(() => storeDraft(draft), 300)
    return () => clearTimeout(timer)
  }, [draft])

  // Signed in, the cards are the account's: loaded from it, and each change saved to it.
  // Signed out, they are the ones kept in this browser, as they always were.
  const account = useAccount()
  const online = useServerOnline()
  const communityNew = useCommunityNew(account, online, tab === 'community')
  const [accountCards, setAccountCards] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [syncError, setSyncError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(0)
  // The account's public cards, and the card being drawn to be made public
  const [published, setPublished] = useState<Published>({})
  const [publishing, setPublishing] = useState<string | null>(null)
  const publishedNow = useRef<Published>({})
  publishedNow.current = published
  const drawer = useCardDrawer()
  const prescient = usePrescientDrawer()
  // What the account is known to hold, and the saves waiting their turn
  const synced = useRef<Card[]>([])
  const saving = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    setSyncError(null)
    setPublished({})
    if (!account) {
      setCards(loadCards())
      return
    }
    let live = true
    setAccountCards('loading')
    // Not the browser's cards meanwhile: they aren't the account's
    setCards([])
    loadAccountCards(account)
      .then(({ cards: found, published: shown }) => {
        if (!live) return
        synced.current = found
        setCards(found)
        setPublished(shown)
        setAccountCards('ready')
      })
      .catch((err) => {
        if (!live) return
        setAccountCards('failed')
        setSyncError(`Your account's cards could not be loaded: ${err.message}`)
      })
    return () => {
      live = false
    }
  }, [account?.token])

  const updateCards = (next: Card[]) => {
    if (!account) {
      if (!storeCards(next)) return false
      setCards(next)
      return true
    }
    // Until the account's cards are in, a change would be made to the wrong list
    if (accountCards !== 'ready') return false
    setCards(next)
    setSyncing((count) => count + 1)
    saving.current = saving.current
      .then(async () => {
        const before = new Map(synced.current.map((card) => [card.id, card]))
        await syncAccountCards(account, synced.current, next)
        synced.current = next
        // A public card changed: the Community tab gets its new look
        for (const card of next)
          if (before.get(card.id) !== card && publishedNow.current[card.id]) await showPublic(account, card)
        setSyncError(null)
      })
      .catch((err) =>
        setSyncError(
          err.quota ? err.message : `Not saved to your account: ${err.message} It will be saved with your next change.`,
        ),
      )
      .finally(() => setSyncing((count) => count - 1))
    return true
  }
  // Draws each side of a saved card and makes it public with those images
  const showPublic = async (session: NonNullable<typeof account>, card: Card) => {
    const sides: Blob[] = []
    try {
      for (const back of backFrameOf(card) ? [false, true] : [false]) sides.push(await drawer.draw(card, back))
    } finally {
      drawer.done()
    }
    const { hidden } = await publishCard(session, card.id, showcaseEntry(card), sides)
    setPublished((list) => ({ ...list, [card.id]: { hidden } }))
  }

  const changePublic = async (card: Card, makePublic: boolean) => {
    if (!account || publishing) return
    setPublishing(card.id)
    try {
      // Its last change saved first: only a saved card can be made public
      await saving.current
      if (makePublic) await showPublic(account, card)
      else {
        await unpublishCard(account, card.id)
        setPublished((list) => Object.fromEntries(Object.entries(list).filter(([id]) => id !== card.id)))
      }
    } catch (err) {
      setSyncError(`Could not make the card ${makePublic ? 'public' : 'private'}: ${(err as Error).message}`)
    }
    setPublishing(null)
  }

  // The Showroom's own page: made public, it shows the public cards. Asked then whether to make
  // every card public too; with no, cards are made public one by one as before.
  const [askAll, setAskAll] = useState(false)
  const [sharing, setSharing] = useState(false)
  // Making every card public: how many are done, of how many
  const [allProgress, setAllProgress] = useState<{ done: number; of: number } | null>(null)
  const privateCards = cards.filter((card) => card.id && !published[card.id])
  const changeShowroomPublic = async (shown: boolean) => {
    if (!account || sharing) return
    setSharing(true)
    try {
      const { user } = await api<{ user: User }>('/api/auth/me/showroom', { method: 'PUT', body: { public: shown }, token: account.token })
      setSession({ ...account, user })
      if (shown && privateCards.length) setAskAll(true)
    } catch (err) {
      setSyncError(`Could not change your Showroom: ${(err as Error).message}`)
    }
    setSharing(false)
  }
  const publishAll = async () => {
    setAskAll(false)
    if (!account || publishing) return
    const todo = privateCards
    setAllProgress({ done: 0, of: todo.length })
    try {
      await saving.current
      for (const [at, card] of todo.entries()) {
        setPublishing(card.id)
        await showPublic(account, card)
        setAllProgress({ done: at + 1, of: todo.length })
      }
    } catch (err) {
      setSyncError(`Could not make every card public: ${(err as Error).message}`)
    }
    setPublishing(null)
    setAllProgress(null)
  }
  // The account's cards submitted to be played (Community Deck Builder)
  const [communityStates, setCommunityStates] = useState<Record<string, CommunityState>>({})
  const [communityBusy, setCommunityBusy] = useState<string | null>(null)
  const loadCommunity = () =>
    account &&
    api<{ cards: Record<string, CommunityState> }>('/api/community/mine', { token: account.token })
      .then(({ cards }) => setCommunityStates(cards))
      .catch(() => {})
  useEffect(() => {
    setCommunityStates({})
    if (account && accountCards === 'ready') loadCommunity()
  }, [account?.token, accountCards])
  const communityChange = async (card: Card, withdraw: boolean) => {
    if (!account || !card.id || communityBusy) return
    setCommunityBusy(card.id)
    try {
      // Its last change saved and drawn first: what is submitted is the card as it is public
      await saving.current
      await api(`/api/community/${encodeURIComponent(card.id)}`, { method: withdraw ? 'DELETE' : 'POST', token: account.token })
      await loadCommunity()
    } catch (err) {
      setSyncError(`Could not ${withdraw ? 'withdraw' : 'submit'} the card: ${(err as Error).message}`)
    }
    setCommunityBusy(null)
  }
  // Submit for play, every public card in one go: those never submitted, and those changed since
  const toSubmit = cards.filter((card) => {
    const state = communityStates[card.id!]
    return published[card.id!] && !published[card.id!].hidden && (!state || state.changed)
  })
  const [submitProgress, setSubmitProgress] = useState<{ done: number; of: number } | null>(null)
  const submitAll = async () => {
    if (!account || communityBusy || submitProgress) return
    const todo = toSubmit
    setSubmitProgress({ done: 0, of: todo.length })
    try {
      await saving.current
      for (const [at, card] of todo.entries()) {
        setCommunityBusy(card.id!)
        await api(`/api/community/${encodeURIComponent(card.id!)}`, { method: 'POST', token: account.token })
        setSubmitProgress({ done: at + 1, of: todo.length })
      }
    } catch (err) {
      setSyncError(`Could not submit every card: ${(err as Error).message}`)
    }
    await loadCommunity()
    setCommunityBusy(null)
    setSubmitProgress(null)
  }
  const publicCount = Object.values(published).filter((card) => !card.hidden).length
  const showroomPublic = !!account?.user.showroomPublic
  const share = account && accountCards === 'ready' && account.user.canPublish !== false && (
    <div className="showroom-share">
      {showroomPublic ? (
        <>
          <span className="showroom-share-text">
            Your Showroom is public: {publicCount} of {cards.length} card{cards.length === 1 ? '' : 's'} show on{' '}
            <a href={`#showroom/${account.user.username}`}>its page</a>.
          </span>
          <CopyLinkButton link={showroomLink(account.user.username)} />
          {privateCards.length > 0 && (
            <button className="button" type="button" disabled={!!publishing} onClick={() => setAskAll(true)}>
              Make all public
            </button>
          )}
          <button className="button" type="button" disabled={sharing} onClick={() => changeShowroomPublic(false)}>
            Make private
          </button>
        </>
      ) : (
        <>
          <span className="showroom-share-text">Give your Showroom a page of its own, with a link to share. It shows only your public cards.</span>
          <button className="button button-primary" type="button" disabled={sharing} onClick={() => changeShowroomPublic(true)}>
            Make my Showroom public
          </button>
        </>
      )}
      {toSubmit.length > 0 && (
        <button
          className="button"
          type="button"
          disabled={!!communityBusy || !!submitProgress || !!publishing}
          title="Submit every public card not submitted yet, and bring changed submissions up to date, to be made playable in the Community Deck Builder"
          onClick={submitAll}
        >
          Submit all for play ({toSubmit.length})
        </button>
      )}
      {allProgress && (
        <span className="showroom-share-text">
          Making cards public… {allProgress.done} of {allProgress.of}
        </span>
      )}
      {submitProgress && (
        <span className="showroom-share-text">
          Submitting for play… {submitProgress.done} of {submitProgress.of}
        </span>
      )}
    </div>
  )
  const askAllModal = askAll && (
    <Modal title="Make all your cards public?" onClose={() => setAskAll(false)}>
      <p className="account-note">
        Your Showroom's page shows only your public cards. {privateCards.length} of your cards {privateCards.length === 1 ? 'is' : 'are'} private:
        make {privateCards.length === 1 ? 'it' : 'them all'} public now? Public cards also show on the Community tab.
      </p>
      <p className="account-note">With No, you can still make cards public one by one with their Public button.</p>
      <div className="leave-buttons">
        <button className="button" type="button" onClick={() => setAskAll(false)}>
          No, I'll choose
        </button>
        <button className="button button-primary" type="button" onClick={publishAll}>
          Make all public
        </button>
      </div>
    </Modal>
  )

  // The cards kept in this browser, which can be copied to the account
  const localCount = useMemo(() => (account ? loadCards().length : 0), [account?.token])
  // Counts the copies of this browser's decks to the account, so the Deck Builder reads them again
  const [decksCopied, setDecksCopied] = useState(0)
  const localDeckCount = useMemo(
    () => (account ? localDeckLists().reduce((sum, { decks }) => sum + decks.length, 0) : 0),
    [account?.token],
  )
  const storageFull = () =>
    account
      ? accountCards === 'ready'
        ? 'Could not save.'
        : 'Your account’s cards are still loading. Try again in a moment.'
      : 'this browser has run out of storage. Remove a card or use smaller art.'

  const changeDraft = (next: Draft) => {
    setDraft(next)
    setSaved(false)
    setSaveError(null)
  }

  const saveDraft = (asNew: boolean) => {
    const card: Card = { ...forFrame(draft), id: (asNew ? undefined : draft.id) ?? crypto.randomUUID() }
    const exists = cards.some((saved) => saved.id === card.id)
    const next = exists ? cards.map((saved) => (saved.id === card.id ? card : saved)) : [...cards, card]
    if (!updateCards(next)) {
      setSaveError(`Could not save: ${storageFull()}`)
      return
    }
    setDraft(card)
    setSaved(true)
  }

  const removeCard = (card: Card) => {
    updateCards(cards.filter((saved) => saved.id !== card.id))
    // The draft stays in the editor, but would now save as a new card
    if (draft.id === card.id) changeDraft({ ...draft, id: undefined })
  }

  // A card imported again replaces the one it was exported from; the others are added.
  // From the cards as stored, which another tab may have saved to since this one loaded.
  const importCards = (found: Card[]) => {
    const next = account ? [...cards] : loadCards()
    let replaced = 0
    for (const card of found) {
      const at = card.id ? next.findIndex((saved) => saved.id === card.id) : -1
      if (at >= 0) {
        next[at] = card
        replaced++
      } else next.push({ ...card, id: card.id || crypto.randomUUID() })
    }
    if (!updateCards(next)) return `Could not import: ${storageFull()}`
    return `Imported ${found.length} card${found.length === 1 ? '' : 's'}` + (replaced ? `, ${replaced} of them updated` : '')
  }

  const editCard = (card: Card) => {
    changeDraft(card)
    window.location.hash = 'creator'
    // The showroom may have been scrolled a long way down
    window.scrollTo(0, 0)
  }

  // Sign in, Ko-fi, Discord: in the top right corner of every page, the set's Showcase too
  const accountBar = (
    <AccountBar
      localCards={localCount}
      localDecks={localDeckCount}
      onCopyLocal={async () => {
        const done = localCount ? [importCards(loadCards())] : []
        await saving.current
        if (account && localDeckCount) {
          try {
            const copied = await copyLocalDecks(account)
            done.push(`copied ${copied} deck${copied === 1 ? '' : 's'}`)
            setDecksCopied((count) => count + 1)
          } catch (err) {
            done.push(`could not copy the decks: ${(err as Error).message}`)
          }
        }
        const text = done.join('; ')
        return text.charAt(0).toUpperCase() + text.slice(1)
      }}
    />
  )

  // The site's tabs, on the DUNE page too, so the way back is there
  const mainTabs = (
    <nav className="tabs">
      {tabs
        .filter(({ id }) => id !== 'community' || online)
        .map(({ id, label }) => (
        <a
          key={id}
          href={id === 'dune' ? '#DuneSWU' : `#${id}`}
          aria-current={(id === 'dune' ? showcase === 'DUNE' : !showcase && tab === id) ? 'page' : undefined}
        >
          {label}
          {id === 'community' && communityNew > 0 && (
            <span className="tab-count" title={`${communityNew} new card${communityNew === 1 ? '' : 's'} since you last looked`}>
              {communityNew > 99 ? '99+' : communityNew}
            </span>
          )}
        </a>
      ))}
    </nav>
  )

  if (showcase) {
    return (
      <main className="page">
        <header className="page-header">
          {accountBar}
          <h1>{showcase === 'DUNE' ? 'Dune SWU' : showcase}</h1>
          {mainTabs}
        </header>
        <Showcase folder={showcase} />
        {leaveModal}
      </main>
    )
  }

  return (
    <main className="page">
      <header className="page-header">
        {accountBar}
        <h1>SWU Card Creator</h1>
        {mainTabs}
      </header>

      {account && (accountCards === 'loading' || syncing > 0 || syncError) && (
        <p className={syncError ? 'account-status account-error' : 'account-status'}>
          {syncError ?? (accountCards === 'loading' ? 'Loading your cards…' : 'Saving to your account…')}
        </p>
      )}
      {tab === 'showroom' && (
        <Showroom
          cards={cards}
          onEdit={editCard}
          onRemove={removeCard}
          onImport={importCards}
          published={account ? published : undefined}
          publishing={publishing}
          blocked={account?.user.canPublish === false}
          onPublic={account && accountCards === 'ready' ? changePublic : undefined}
          share={share}
          community={
            account && accountCards === 'ready' && account.user.canPublish !== false
              ? {
                  states: communityStates,
                  busy: communityBusy,
                  onSubmit: (card) => communityChange(card, false),
                  onWithdraw: (card) => communityChange(card, true),
                }
              : undefined
          }
        />
      )}
      {tab === 'community' && (viewing ? <Community session={account} owner={viewing} /> : <CommunityPage session={account} />)}
      {askAllModal}
      {drawer.stage}
      {prescient.stage}
      {tab === 'decks' && <DeckFormats key={decksCopied} cards={cards.flatMap(deckCardOf)} />}
      {tab === 'projects' && <Projects />}
      {tab === 'creator' && (
        <CardCreator
          draft={draft}
          saved={saved}
          saveError={saveError}
          cards={cards}
          onChange={changeDraft}
          onSave={saveDraft}
          // A new card starts with the card line last typed, but for its number
          onNew={() => changeDraft({ frameId: draft.frameId, name: '', trait: '', text: '', ...loadCardLine() })}
        />
      )}
      {leaveModal}
    </main>
  )
}

export default App
