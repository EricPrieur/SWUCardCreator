import { useEffect, useRef, useState, type ChangeEvent, type ReactNode, type RefObject } from 'react'
import { createPortal, flushSync } from 'react-dom'
import artFiles from 'virtual:art-list'
import { asset } from './asset'
import './App.css'
import { CardView } from './CardView'
import { AccountBar } from './account'
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
  storeDecks,
  type CardLine,
  type Art,
  type Card,
  type Deck,
  type DeckEntry,
  type Draft,
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
      art={art}
      look={card.look}
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
}) {
  const { holder, frame, fileName, format, onFormat, onNote } = props
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

  return (
    <>
      <span className="split-button">
        <button
          className="button"
          type="button"
          disabled={busy !== null}
          title="Click to save the image; middle-click to open it in a new tab"
          onClick={() => image('save')}
          // A middle click shows the image in a new tab instead of scrolling the page
          onMouseDown={(event) => event.button === 1 && event.preventDefault()}
          onAuxClick={(event) => event.button === 1 && image('save', window.open('', '_blank'))}
        >
          {busy === 'save' ? 'Drawing…' : 'Save'}
        </button>
        <select
          aria-label="Image format"
          title="Print: 822 × 1122 px with a mirrored bleed edge and square corners, for MakePlayingCards and similar services"
          value={format}
          onChange={(event) => onFormat(event.target.value as ImageFormat)}
        >
          {imageFormats.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </span>
      <button className="button" type="button" disabled={busy !== null} onClick={() => image('copy')}>
        {busy === 'copy' ? 'Drawing…' : 'Copy'}
      </button>
    </>
  )
}

// With small or medium cards, a large copy of the card under the mouse follows the
// pointer, beside it and kept inside the window. Touch screens do without.
const PREVIEW_WIDTH = 345
const PREVIEW_GAP = 20

function HoverPreview(props: { enabled: boolean; preview: ReactNode; children: ReactNode }) {
  const { enabled, preview, children } = props
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const place = (x: number, y: number) => {
    const width = box.current?.offsetWidth ?? PREVIEW_WIDTH
    const height = box.current?.offsetHeight ?? PREVIEW_WIDTH * 1.4
    // Right of the pointer, or left of it near the window's right edge
    const left = x + PREVIEW_GAP + width < window.innerWidth ? x + PREVIEW_GAP : x - PREVIEW_GAP - width
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
          <div className="hover-preview" ref={box} style={{ width: PREVIEW_WIDTH, ...at }}>
            {preview}
          </div>,
          document.body,
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
}) {
  const { card, preview, format, onFormat, onEdit, onRemove } = props
  const [back, setBack] = useState(false)
  // Remove asks once more before it does anything
  const [removing, setRemoving] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const side = cardSide(card, back)

  return (
    <li>
      <HoverPreview enabled={preview} preview={<CardFace card={card} back={back} />}>
        <div ref={ref}>
          <CardFace card={card} back={back} />
        </div>
      </HoverPreview>
      <div className="showroom-actions">
        {backFrameOf(card) && (
          <button className="button" onClick={() => setBack(!back)}>
            Flip
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
          <button className="button" onClick={() => setRemoving(true)}>
            Remove
          </button>
        )}
        <ImageButtons
          holder={ref}
          frame={side.frame}
          fileName={cardFileName(card, back)}
          format={format}
          onFormat={onFormat}
          onNote={setNote}
        />
      </div>
      {note && <p className="saved-note showroom-note">{note}</p>}
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
  return tabs.find((tab) => tab.id === id)?.id ?? 'creator'
}

// Showcases on the site that no menu links to: the address's name, and its folder in public/showcase
// A published set is at #set/<SET>; some also have a name of their own
const showcases: Record<string, string> = { DuneSWU: 'DUNE' }
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
function ChoiceDropdown<T extends string>(props: {
  label: string
  options: { label: string; value: T }[]
  selected: T
  onChange: (value: T) => void
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
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {options.find((option) => option.value === selected)?.label} ▾
      </button>
      {open && (
        <div className="check-options choice-options" role="listbox" aria-label={label}>
          {options.map((option) => (
            <button
              type="button"
              role="option"
              key={option.value}
              aria-selected={option.value === selected}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
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
    ({ facts }) =>
      (search === '' || facts.names.some((name) => name.includes(search)) || facts.text.includes(search)) &&
      (types.length === 0 || types.includes(facts.type)) &&
      (traits.length === 0 || traits.some((trait) => facts.traits.includes(trait))) &&
      (costs.length === 0 || (facts.cost !== undefined && costs.includes(facts.cost))) &&
      (sets.length === 0 || sets.includes(facts.set ? facts.set.toUpperCase() : NO_SET)) &&
      (arenas.length === 0 || (facts.arena !== undefined && arenas.includes(facts.arena))) &&
      (rarityPicks.length === 0 || rarityPicks.includes(facts.rarity || NO_RARITY)) &&
      (!neutral || facts.aspects.length === 0) &&
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
            }}
          >
            Clear filters
          </button>
        )}
      </div>
    </div>
  )
  // The class for the grid of cards, which sets their size
  return { bar, shown, grid: `showroom-grid card-size-${size}`, preview: size !== 'l' }
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

// The names a card's art is exported under, beside its image: either kind a browser
// may have written it as
const artFileNames = (image: string) => ['webp', 'jpg'].map((extension) => `${image} (art).${extension}`)

// A card ready to be imported anywhere: its art as files of their own, which the card
// names, rather than in this browser's storage or this computer's art folder
async function portableCard(
  card: Card,
  // The names of its images in the set
  names: { image: string; back?: string },
): Promise<{ card: Card; files: { name: string; body: Blob }[] }> {
  const files: { name: string; body: Blob }[] = []
  const separate = async (art: Art | undefined, back: boolean) => {
    if (!art?.src) return art
    // Shrunk the way uploaded art is, so a large original does not weigh on the export
    const original = await (await fetch(art.src.startsWith('data:') ? art.src : asset(art.src))).blob()
    // A missing file comes back as the app's page, which no picture can be made of
    if (!original.type.startsWith('image/')) throw new Error(`the art of ${card.name}, ${art.src}, was not found`)
    const body = await (await fetch(await readArtFile(new File([original], 'art')))).blob()
    const name = artFileNames((back && names.back) || names.image)[body.type === 'image/webp' ? 0 : 1]
    files.push({ name, body })
    return { ...art, src: name }
  }
  return { card: { ...card, art: await separate(card.art, false), backArt: await separate(card.backArt, true) }, files }
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
      cards.push({ ...card, art: await art(card.art), backArt: await art(card.backArt) })
    }
  }
  return cards
}

// Export: the cards shown, set by set. Each card side is drawn as a JPG and kept with
// a .json of the card, for Import to bring back. On this computer (the dev server)
// they go into public/showcase/<SET>; on the site into a .zip.
// Import: brings cards back from those .json or .zip files.
function CardFiles(props: { cards: Card[]; onImport: (cards: Card[]) => string }) {
  const { cards, onImport } = props
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Replace the whole set with the cards shown, rather than update the cards shown in it
  const [replace, setReplace] = useState(false)
  // The card side being drawn, off the page
  const [drawing, setDrawing] = useState<{ card: Card; back: boolean } | null>(null)
  const stage = useRef<HTMLDivElement>(null)
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

  // Draws one side of a card at the frame's own size, once its pictures have loaded
  const draw = async (card: Card, back: boolean) => {
    flushSync(() => setDrawing({ card, back }))
    const el = stage.current?.querySelector<HTMLElement>('.card')
    if (!el) throw new Error('Nothing to draw')
    await document.fonts.ready
    await Promise.all(
      [...el.querySelectorAll('img')].map((img) => (img.complete ? null : new Promise((done) => img.addEventListener('load', done, { once: true })))),
    )
    await new Promise((done) => setTimeout(done, 150)) // the art's size is worked out once it has loaded
    return cardImage(el, cardSide(card, back).frame, 'jpg', 1)
  }

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
    setDrawing(null)
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
            {busy && drawing ? 'Exporting…' : `Export ${bySet.size === 1 ? [...bySet.keys()][0] : `${bySet.size} sets`}`}
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
      {drawing && (
        <div className="publish-stage" ref={stage}>
          <CardFace card={drawing.card} back={drawing.back} />
        </div>
      )}
    </div>
  )
}

function Showroom(props: {
  cards: Card[]
  onEdit: (card: Card) => void
  onRemove: (card: Card) => void
  onImport: (cards: Card[]) => string
}) {
  const { cards, onEdit, onRemove, onImport } = props
  const { bar, shown, grid, preview } = useCardFilters(
    'showroom',
    cards.map((card) => ({ item: card, facts: cardFacts(card) })),
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
      {bar}
      <CardFiles cards={shown.map(({ item }) => item)} onImport={onImport} />

      {shown.length === 0 ? (
        <p className="empty-note">No card matches these filters.</p>
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

// One card of a Showcase: its image, and Flip for a leader's other side
function ShowcaseItem(props: { folder: string; card: ShowcaseCard; preview: boolean }) {
  const { folder, card, preview } = props
  const [back, setBack] = useState(false)
  const file = back && card.back ? card.back : card.image
  const src = asset(`${folder}/${encodeURIComponent(file)}.jpg`)
  return (
    <li>
      <HoverPreview enabled={preview} preview={<img className="showcase-image" src={src} alt="" />}>
      <a href={src} target="_blank" rel="noopener noreferrer" title="Open the full image">
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
      </a>
      </HoverPreview>
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
// #showcase/<folder>, the folder being public/showcase/<folder> with showcase.json in it
function Showcase(props: { folder: string }) {
  const folder = `/showcase/${props.folder}`
  const [list, setList] = useState<ShowcaseList | null>(null)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    fetch(asset(`${folder}/showcase.json`))
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((data: ShowcaseList) => setList(data))
      .catch(() => setMissing(true))
  }, [folder])
  useEffect(() => {
    // Kept out of search engines
    const robots = document.createElement('meta')
    robots.name = 'robots'
    robots.content = 'noindex'
    document.head.append(robots)
    return () => robots.remove()
  }, [])
  const { bar, shown, grid, preview } = useCardFilters(
    `showcase.${props.folder}`,
    (list?.cards ?? []).map((card) => ({ item: card, facts: showcaseFacts(card) })),
    'Showcase order',
  )
  // The set's cards, or a Deck Builder that only uses them
  const [view, setView] = useRemembered<'cards' | 'decks'>(`showcase.${props.folder}.view`, 'cards')
  useEffect(() => {
    if (list) document.title = list.title
  }, [list])

  if (missing) return <p className="empty-note">There is no showcase here.</p>
  if (!list) return <p className="empty-note">Loading…</p>
  const views = (
    <nav className="tabs showcase-views">
      {(['cards', 'decks'] as const).map((value) => (
        <a
          key={value}
          href={window.location.hash}
          aria-current={view === value ? 'page' : undefined}
          onClick={(event) => {
            event.preventDefault()
            setView(value)
          }}
        >
          {value === 'cards' ? 'Cards' : 'Deck Builder'}
        </a>
      ))}
    </nav>
  )
  if (view === 'decks') {
    return (
      <>
        {views}
        <DeckBuilder
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
          {shown.map(({ item: card }) => (
            <ShowcaseItem key={card.image} folder={folder} card={card} preview={preview} />
          ))}
        </ul>
      )}
    </section>
  )
}

// Premier: at least 50 cards, up to 3 copies of a card counting the sideboard, and
// up to 10 cards in the sideboard
const DECK_SIZE = 50
const MAX_COPIES = 3
const SIDEBOARD_SIZE = 10
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
  // The same card drawn lighter, for the deck image
  forImage?: () => Promise<DeckCard>
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
  }
  const second = isTwoSidedBase(card) ? backFrameOf(card) : undefined
  if (!second) return [{ ...deckCard, forImage: async () => ({ ...deckCard, face: <CardFace card={await withSmallArt(card)} /> }) }]
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
  }
  // The deck image is laid out out of sight, where a lazy image never loads: loaded first
  return [
    {
      ...deckCard,
      forImage: async () => {
        const image = new Image()
        image.src = src
        await image.decode().catch(() => undefined)
        return { ...deckCard, face: <img className="showcase-image" src={src} alt={label} /> }
      },
    },
  ]
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

// The list with that card at that many copies, or without it at 0
function withCopies(entries: DeckEntry[], id: string, count: number): DeckEntry[] {
  if (count <= 0) return entries.filter((entry) => entry.id !== id)
  return entries.some((entry) => entry.id === id)
    ? entries.map((entry) => (entry.id === id ? { ...entry, count } : entry))
    : [...entries, { id, count }]
}

const deckCount = (entries: DeckEntry[]) => entries.reduce((sum, { count }) => sum + count, 0)

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
type DeckFileCard = { count: number; name: string; subtitle?: string; set?: string; number?: string; id: string; back?: boolean }
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

function DeckChoice(props: { label: DeckStep; card?: DeckCard; active: boolean; onPick: () => void }) {
  const { label, card, active, onPick } = props
  return (
    <button className="deck-choice" type="button" aria-pressed={active} title={`Choose another ${label.toLowerCase()}`} onClick={onPick}>
      <span className="filter-label">{label}</span>
      {card ? (
        <HoverPreview enabled preview={card.face}>
          <span className="deck-row-name">{card.label}</span>
        </HoverPreview>
      ) : (
        <span className="deck-missing">None yet: choose one</span>
      )}
    </button>
  )
}

// One card to pick from. A click adds a copy and a right click takes one out; a leader
// or a base is chosen with a click.
function DeckPoolCard(props: {
  card: DeckCard
  preview: boolean
  // Leaders and bases are chosen, the other cards counted
  choice?: DeckStep
  chosen: boolean
  count: number
  max: number
  penalty: number
  onAdd: () => void
  onTake: () => void
  // Adds a copy to the sideboard rather than the deck
  onSideboard: () => void
}) {
  const { card, preview, choice, chosen, count, max, penalty, onAdd, onTake, onSideboard } = props
  const full = count >= max
  return (
    <li className={`deck-pool-card${!choice && full ? ' deck-full' : ''}`}>
      <HoverPreview enabled={preview} preview={card.face}>
        <button
          className="deck-pool-image"
          type="button"
          aria-disabled={!choice && full}
          title={
            choice
              ? `Choose as the ${choice.toLowerCase()}`
              : full
                ? `${max} copies already. Right click to take one out.`
                : 'Click to add a copy, right click to take one out'
          }
          onClick={() => (choice || !full) && onAdd()}
          onContextMenu={(event) => {
            event.preventDefault()
            if (!choice && count > 0) onTake()
          }}
        >
          {card.face}
          {count > 0 && <span className="deck-badge">{count}</span>}
        </button>
      </HoverPreview>
      <div className="showroom-actions deck-pool-actions">
        {choice ? (
          chosen && <span className="filter-label">The deck's {choice.toLowerCase()}</span>
        ) : (
          <>
            <button className="deck-button" type="button" disabled={count === 0} aria-label="Take a copy out" onClick={onTake}>
              −
            </button>
            <span className="deck-pool-count">{count}</span>
            <button className="deck-button" type="button" disabled={full} aria-label="Add a copy" onClick={onAdd}>
              +
            </button>
            <button className="deck-button" type="button" disabled={full} title="Add a copy to the sideboard" onClick={onSideboard}>
              SB
            </button>
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
  return { ...card, art: await shrink(card.art), backArt: await shrink(card.backArt) }
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
function DeckBuilder(props: {
  cards: DeckCard[]
  // Where its choices are remembered, and its decks kept
  prefix?: string
  storageKey?: string
  // Where the cards come from, for the messages: "Showroom", or "set" for a Showcase,
  // whose cards are all of one set and offer no choice of sets
  source?: 'Showroom' | 'set'
}) {
  const { cards, prefix = 'decks', storageKey, source = 'Showroom' } = props
  const fixedSet = source === 'set'
  const [decks, setDecks] = useState<Deck[]>(() => loadDecks(storageKey))
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
  const deck = decks.find(({ id }) => id === currentId) ?? decks[0] ?? firstDeck
  const byId = new Map(cards.map((card) => [card.id, card]))

  const saveDecks = (next: Deck[]) => {
    if (!storeDecks(next, storageKey)) {
      setNote('Could not save: this browser has run out of storage.')
      return
    }
    setDecks(next)
  }
  const changeDeck = (next: Deck) => {
    if (decks.some((other) => other.id === next.id)) saveDecks(decks.map((other) => (other.id === next.id ? next : other)))
    else {
      // The new deck opened for want of any, kept now that it has something
      saveDecks([...decks, next])
      setCurrentId(next.id)
    }
  }
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
  const inSets = (card: DeckCard) => fixedSet || !deck || deck.sets.length === 0 || deck.sets.includes(card.set)

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
  const add = (card: DeckCard) => {
    if (card.type === 'Leader' || card.type === 'Base') {
      changeDeck(card.type === 'Leader' ? { ...deck, leader: card.id } : { ...deck, base: card.id })
      setChanging(null)
    } else if (copies(card.id) < card.max)
      changeDeck({ ...deck, cards: withCopies(deck.cards, card.id, copiesOf(deck.cards, card.id) + 1) })
  }
  const addToSideboard = (card: DeckCard) => {
    if (copies(card.id) < card.max)
      changeDeck({ ...deck, sideboard: withCopies(deck.sideboard, card.id, copiesOf(deck.sideboard, card.id) + 1) })
  }
  // The Leader or Base button: choose another, or, pressed again, keep it and go back to the cards
  const pickChoice = (choice: DeckStep) =>
    setChanging(step === choice && (choice === 'Leader' ? leader : base) ? null : choice)
  // From the deck first, then from the sideboard
  const take = (card: DeckCard) => {
    const main = copiesOf(deck.cards, card.id)
    if (main > 0) changeDeck({ ...deck, cards: withCopies(deck.cards, card.id, main - 1) })
    else changeDeck({ ...deck, sideboard: withCopies(deck.sideboard, card.id, copiesOf(deck.sideboard, card.id) - 1) })
  }
  // One copy from the deck to the sideboard, or back
  const move = (card: DeckCard, toSideboard: boolean) => {
    const [from, to] = toSideboard ? [deck.cards, deck.sideboard] : [deck.sideboard, deck.cards]
    const moved = {
      from: withCopies(from, card.id, copiesOf(from, card.id) - 1),
      to: withCopies(to, card.id, copiesOf(to, card.id) + 1),
    }
    changeDeck(
      toSideboard ? { ...deck, cards: moved.from, sideboard: moved.to } : { ...deck, cards: moved.to, sideboard: moved.from },
    )
  }

  const known = (entries: DeckEntry[]) =>
    entries.flatMap(({ id, count }) => {
      const card = byId.get(id)
      return card ? [{ card, count }] : []
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
    mainCount < DECK_SIZE && `${DECK_SIZE - mainCount} more card${DECK_SIZE - mainCount === 1 ? '' : 's'} needed: a deck has at least ${DECK_SIZE}.`,
    sideboardCount > SIDEBOARD_SIZE && `${sideboardCount - SIDEBOARD_SIZE} too many in the sideboard: it holds ${SIDEBOARD_SIZE}.`,
    ...[...new Set([...main, ...sideboard].map(({ card }) => card))]
      .filter((card) => copies(card.id) > card.max)
      .map((card) => `${card.label}: more than ${card.max} copies.`),
    ...[leader, base, ...main.map(({ card }) => card), ...sideboard.map(({ card }) => card)]
      .filter((card): card is DeckCard => card !== undefined && !inSets(card))
      .map((card) => `${card.label} is not in the deck's sets.`),
    lost > 0 && `${lost} card${lost === 1 ? ' is' : 's are'} no longer in the ${source}.`,
  ].filter((problem): problem is string => Boolean(problem))

  const deckFile = (): DeckFile => ({
    deck: deck.name,
    author: deck.author || undefined,
    sets: deck.sets,
    leader: leader && fileCard(leader),
    base: base && fileCard(base),
    cards: main.map(({ card, count }) => ({ count, ...fileCard(card) })),
    sideboard: sideboard.map(({ card, count }) => ({ count, ...fileCard(card) })),
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
      const small = new Map(
        (await Promise.all(used.map((card) => (card.forImage ? card.forImage() : card)))).map((card) => [card.id, card]),
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
          return card ? [{ id: card.id, count: wanted.count }] : []
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
      setNote(missing ? `Imported. ${missing} card${missing === 1 ? ' was' : 's were'} not found in the ${source}.` : 'Imported.')
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
              cards={main.map(({ card, count }) => ({ card: pictureCards.get(card.id) ?? card, count }))}
              sideboard={sideboard.map(({ card, count }) => ({ card: pictureCards.get(card.id) ?? card, count }))}
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
            options={decks.map(({ id, name }) => ({ value: id, label: name || 'Unnamed deck' }))}
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
                {deck.sets.length ? deck.sets.map((set) => (set === NO_SET ? 'No set' : set)).join(', ') : 'All sets'}
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
              {shown.map(({ item: card }) => (
                <DeckPoolCard
                  key={card.id}
                  card={card}
                  preview={preview}
                  choice={step ?? undefined}
                  chosen={card.id === deck.leader || card.id === deck.base}
                  count={step ? 0 : copies(card.id)}
                  max={card.max}
                  penalty={step ? 0 : penaltyOf(card)}
                  onAdd={() => add(card)}
                  onTake={() => take(card)}
                  onSideboard={() => addToSideboard(card)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="deck-side">
        {/* What can be done with the deck, over its list */}
        <div className="deck-bar-buttons">
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
            <strong className={mainCount < DECK_SIZE ? 'deck-short' : undefined}>
              {mainCount}/{DECK_SIZE}
            </strong>{' '}
            cards · sideboard {sideboardCount}/{SIDEBOARD_SIZE}
          </p>
          {problems.length === 0 ? (
            <p className="deck-legal">Ready to play: the deck follows the Premier rules.</p>
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
                  {rows.map(({ card, count }) => (
                    <DeckRow
                      key={card.id}
                      card={card}
                      count={count}
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
                        disabled={copies(card.id) >= card.max}
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
                {[...sideboard].sort(byCost).map(({ card, count }) => (
                  <DeckRow
                    key={card.id}
                    card={card}
                    count={count}
                    penalty={penaltyOf(card)}
                    onAdd={() => addToSideboard(card)}
                    onTake={() => changeDeck({ ...deck, sideboard: withCopies(deck.sideboard, card.id, count - 1) })}
                  >
                    <button
                      className="deck-button"
                      type="button"
                      aria-label="Take a copy out"
                      onClick={() => changeDeck({ ...deck, sideboard: withCopies(deck.sideboard, card.id, count - 1) })}
                    >
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
  const side = cardSide(draft, back)
  const { frame } = side
  const bothSides = backFrameOf(draft) ? [front, cardSide(draft, true).frame] : [front]
  // Each side of a leader has its own art. Changing it changes that side alone; a
  // side that has never been given art shows the other side's (see cardSide).
  const setArt = (art?: Art) => onChange(side.isBack ? { ...draft, backArt: art } : { ...draft, art })
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
          <h2>Art</h2>
          <ArtControls art={side.art} onChange={setArt} />
          <h2>Frame &amp; text</h2>
          <LookControls look={draft.look ?? defaultLook} onChange={(look) => onChange({ ...draft, look })} />
        </div>

        <div className="editor-preview-column">
          <div ref={preview}>
            <ArtDrag art={side.art} onChange={setArt}>
              <CardFace card={draft} back={back} />
            </ArtDrag>
          </div>
          <div className="editor-actions preview-actions">
            <ImageButtons
              holder={preview}
              frame={frame}
              fileName={cardFileName(draft, back)}
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
  onChange: (value?: number) => void
}) {
  const { label, value, options, format = String, onChange } = props
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
  const [cards, setCards] = useState<Card[]>(loadCards)
  const [draft, setDraft] = useState<Draft>(() => loadDraft() ?? { ...blankDraft, ...loadCardLine() })
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    const onHashChange = () => {
      setTab(tabFromHash())
      setShowcase(showcaseFromHash())
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  // Kept shortly after the last change rather than on every keystroke: art can be large
  useEffect(() => {
    const timer = setTimeout(() => storeDraft(draft), 300)
    return () => clearTimeout(timer)
  }, [draft])

  const updateCards = (next: Card[]) => {
    if (!storeCards(next)) return false
    setCards(next)
    return true
  }

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
      setSaveError('Could not save: this browser has run out of storage. Remove a card or use smaller art.')
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
    const next = loadCards()
    let replaced = 0
    for (const card of found) {
      const at = card.id ? next.findIndex((saved) => saved.id === card.id) : -1
      if (at >= 0) {
        next[at] = card
        replaced++
      } else next.push({ ...card, id: card.id || crypto.randomUUID() })
    }
    if (!updateCards(next)) return 'Could not import: this browser has run out of storage. Remove a card or use smaller art.'
    return `Imported ${found.length} card${found.length === 1 ? '' : 's'}` + (replaced ? `, ${replaced} of them updated` : '')
  }

  const editCard = (card: Card) => {
    changeDraft(card)
    window.location.hash = 'creator'
    // The showroom may have been scrolled a long way down
    window.scrollTo(0, 0)
  }

  if (showcase) {
    return (
      <main className="page">
        <header className="page-header">
          <h1>{showcase === 'DUNE' ? 'Dune SWU' : showcase}</h1>
        </header>
        <Showcase folder={showcase} />
      </main>
    )
  }

  return (
    <main className="page">
      <header className="page-header">
        <AccountBar />
        <h1>SWU Card Creator</h1>
        <nav className="tabs">
          {tabs.map(({ id, label }) => (
            <a key={id} href={`#${id}`} aria-current={tab === id ? 'page' : undefined}>
              {label}
            </a>
          ))}
        </nav>
      </header>

      {tab === 'showroom' && <Showroom cards={cards} onEdit={editCard} onRemove={removeCard} onImport={importCards} />}
      {tab === 'decks' && <DeckBuilder cards={cards.flatMap(deckCardOf)} />}
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
    </main>
  )
}

export default App
