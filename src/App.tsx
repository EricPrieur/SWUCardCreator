import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal, flushSync } from 'react-dom'
import artFiles from 'virtual:art-list'
import { asset } from './asset'
import './App.css'
import { CardView } from './CardView'
import {
  defaultLook,
  loadCards,
  loadDraft,
  readArtFile,
  storeCards,
  storeDraft,
  loadCardLine,
  storeCardLine,
  type CardLine,
  type Art,
  type Card,
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
  const back = front.backId ? findFrame(card.backFrameId ?? front.backId) : undefined
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

// A leader is one card with two sides, which share everything but the frame, the
// game text and where the art sits. Every other card only has a front.
function cardSide(card: Draft, back: boolean) {
  const front = findFrame(card.frameId)
  const shared = { name: card.name, subtitle: card.subtitle, trait: card.trait }
  if (!front.backId) return { ...shared, frame: front, text: card.text, art: card.art, isBack: false }
  // A side with no art of its own shows the other side's image, not yet placed
  const borrowed = (art?: Art): Art | undefined => art && { src: art.src, zoom: 1, x: 0, y: 0 }
  if (!back) return { ...shared, frame: front, text: card.text, art: card.art ?? borrowed(card.backArt), isBack: false }
  return {
    // The Leader Unit side says what the Leader side says, unless it was given its own
    name: card.backName ?? card.name,
    subtitle: card.backSubtitle ?? card.subtitle,
    trait: card.backTrait ?? card.trait,
    frame: findFrame(card.backFrameId ?? front.backId + (card.backArena === 'Space' ? '-space' : '')),
    text: card.backText ?? '',
    art: card.backArt ?? borrowed(card.art),
    isBack: true,
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
        {findFrame(card.frameId).backId && (
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
}

// A saved card's facts. A leader counts for what either of its sides says.
function cardFacts(card: Card): Facts {
  const frame = findFrame(card.frameId)
  const back = frame.backId ? cardSide(card, true) : undefined
  const traitLabels = [...splitTraits(card.trait), ...splitTraits(back?.trait)]
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

// The Set filter's choice for the cards whose card line has no set
const NO_SET = '\u0000none'

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
function useCardFilters<T>(name: string, items: { item: T; facts: Facts }[], firstSort = 'Order saved') {
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
  const [sort, setSort] = useRemembered<SortKey>(`${name}.sort`, 'saved')
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
  const filtered =
    search !== '' || neutral || types.length + traits.length + costs.length + sets.length + arenas.length + picked.length > 0

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
          {shown.length === items.length ? `${items.length} cards` : `${shown.length} of ${items.length} cards`}
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
// leader's other side, without the characters file names cannot have
function cardFileName(card: Draft, back: boolean) {
  const side = cardSide(card, back)
  const subtitle = side.subtitle?.trim()
  const name = `${side.name.trim() || 'card'}${subtitle ? ` - ${subtitle}` : ''}${side.isBack ? ' (unit)' : ''}`
  return name.replace(/[\\/:*?"<>|]/g, '')
}

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
  aspects: Aspect[]
  cost?: number
  traits: string[]
  text?: string
  set?: string
  number?: string
  arena?: Arena
}
type ShowcaseList = { title: string; cards: ShowcaseCard[] }

// A Showcase entry for a saved card: what the showcase page searches and filters
// by, and the names of its images
function showcaseEntry(card: Card): ShowcaseCard {
  const facts = cardFacts(card)
  const frame = findFrame(card.frameId)
  const back = frame.backId ? cardSide(card, true) : undefined
  return {
    id: card.id,
    image: cardFileName(card, false),
    back: back && cardFileName(card, true),
    name: card.name,
    backName: back && back.name !== card.name ? back.name : undefined,
    subtitle: card.subtitle?.trim() || undefined,
    type: facts.type,
    aspects: facts.aspects,
    cost: card.cost,
    traits: facts.traitLabels,
    text: facts.text || undefined,
    set: facts.set || undefined,
    number: facts.number || undefined,
    arena: facts.arena,
  }
}

// On this computer only (the dev server): publishes the cards shown, set by set, as
// showcases. Each card side is drawn as a JPG; the images and the set's list go into
// public/showcase/<SET>, to be committed to make them part of the site.
function PublishSets(props: { cards: Card[] }) {
  const { cards } = props
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Replace the whole set with the cards shown, rather than update the cards shown in it
  const [replace, setReplace] = useState(false)
  // The card side being drawn, off the page
  const [drawing, setDrawing] = useState<{ card: Card; back: boolean } | null>(null)
  const stage = useRef<HTMLDivElement>(null)
  const bySet = new Map<string, Card[]>()
  for (const card of cards) {
    const set = card.setCode?.trim().toUpperCase()
    if (set && /^[A-Z0-9_-]+$/.test(set)) bySet.set(set, [...(bySet.get(set) ?? []), card])
  }
  const skipped = cards.length - [...bySet.values()].reduce((count, list) => count + list.length, 0)

  const send = async (set: string, file: string, body: BodyInit, method = 'PUT') => {
    const response = await fetch(`/__publish/${set}/${encodeURIComponent(file)}`, { method, body })
    if (!response.ok) throw new Error(await response.text())
  }

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

  const publish = async () => {
    setBusy(true)
    try {
      for (const [set, list] of bySet) {
        // What the set has already: the cards published now update it, the rest stay
        // as they are, unless the whole set is being replaced
        let already: ShowcaseCard[] = []
        if (!replace) {
          const response = await fetch(`/showcase/${set}/showcase.json`, { cache: 'no-store' })
          if (response.ok) already = ((await response.json()) as ShowcaseList).cards
        }
        let done = 0
        for (const card of list) {
          const sides = findFrame(card.frameId).backId ? [false, true] : [false]
          for (const back of sides) {
            setStatus(`Publishing ${set}: card ${done + 1} of ${list.length}…`)
            const file = `${cardFileName(card, back)}.jpg`
            await send(set, file, await draw(card, back))
          }
          done++
        }
        // A card published before keeps its place in the set; a new one goes at the end
        const cards = [...already]
        for (const entry of list.map(showcaseEntry)) {
          const at = cards.findIndex((other) => (other.id ? other.id === entry.id : other.image === entry.image))
          if (at >= 0) cards[at] = entry
          else cards.push(entry)
        }
        const showcase: ShowcaseList = { title: set, cards }
        await send(set, 'showcase.json', JSON.stringify(showcase, null, 2))
        // The set's images now, which leaves out those of cards renamed since
        const files = cards.flatMap((card) => [card.image, ...(card.back ? [card.back] : [])].map((name) => `${name}.jpg`))
        await send(set, 'finish', JSON.stringify([...files, 'showcase.json']), 'POST')
      }
      setStatus(
        `${replace ? 'Replaced' : 'Updated'} ${[...bySet].map(([set, list]) => `${set} (${list.length})`).join(', ')} in public/showcase.` +
          (skipped ? ` ${skipped} card${skipped === 1 ? '' : 's'} with no set left out.` : ''),
      )
    } catch (error) {
      setStatus(`Could not publish: ${error instanceof Error ? error.message : error}`)
    }
    setDrawing(null)
    setBusy(false)
  }

  return (
    <div className="publish-sets">
      <button className="chip" type="button" disabled={busy || bySet.size === 0} onClick={publish}>
        {busy ? 'Publishing…' : `Publish ${bySet.size === 1 ? `set ${[...bySet.keys()][0]}` : `${bySet.size} sets`}`}
      </button>
      <label className="toggle filter-label" title="Otherwise the cards shown are added to their set or updated in it">
        <input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} />
        Replace the whole set
      </label>
      <span className="filter-label">
        {status ?? 'Dev only: the cards shown go into their sets in public/showcase. Commit to put them on the site.'}
      </span>
      {drawing && (
        <div className="publish-stage" ref={stage}>
          <CardFace card={drawing.card} back={drawing.back} />
        </div>
      )}
    </div>
  )
}

function Showroom(props: { cards: Card[]; onEdit: (card: Card) => void; onRemove: (card: Card) => void }) {
  const { cards, onEdit, onRemove } = props
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
      </section>
    )
  }

  return (
    <section className="showroom">
      {bar}
      {import.meta.env.DEV && <PublishSets cards={shown.map(({ item }) => item)} />}

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
    (list?.cards ?? []).map((card) => ({
      item: card,
      facts: {
        name: card.name,
        type: card.type,
        names: [card.name, card.backName ?? ''].map((name) => name.toLowerCase()),
        traits: card.traits.map((trait) => trait.toLowerCase()),
        traitLabels: card.traits,
        text: card.text ?? '',
        aspects: card.aspects,
        cost: card.cost,
        set: card.set ?? '',
        number: card.number ?? '',
        arena: card.arena,
      },
    })),
    'Showcase order',
  )
  useEffect(() => {
    if (list) document.title = list.title
  }, [list])

  if (missing) return <p className="empty-note">There is no showcase here.</p>
  if (!list) return <p className="empty-note">Loading…</p>
  return (
    <section className="showroom">
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
  const bothSides = front.backId ? [front, cardSide(draft, true).frame] : [front]
  // Each side of a leader has its own art. Changing it changes that side alone; a
  // side that has never been given art shows the other side's (see cardSide).
  const setArt = (art?: Art) => onChange(side.isBack ? { ...draft, backArt: art } : { ...draft, art })
  // Name, subtitle and trait: typed on the Leader Unit side, they are kept for that
  // side only, and typed back to what the Leader side says, they follow it again
  const setShared = (key: 'name' | 'subtitle' | 'trait', value: string) => {
    if (!side.isBack) return onChange({ ...draft, [key]: value })
    const backKey = ({ name: 'backName', subtitle: 'backSubtitle', trait: 'backTrait' } as const)[key]
    onChange({ ...draft, [backKey]: value === (draft[key] ?? '') ? undefined : value })
  }
  // Each side of a leader has its own frame. The Leader Unit side's is the one
  // matching the Leader side until another is picked for it, which leaves the
  // Leader side as it is.
  const pickFrame = (candidate: Frame) => {
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
          {side.isBack && (
            <p className="empty-note">
              Name, subtitle, trait and art are the Leader side's until you change them here. Pick a frame below
              to change this side's frame alone: a Space one, or other aspects.
            </p>
          )}
          <div className="name-row">
            <label>
              Name
              <input value={side.name} onChange={(event) => setShared('name', event.target.value)} />
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
              <input
                value={side.subtitle ?? ''}
                onChange={(event) => setShared('subtitle', event.target.value)}
              />
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
            <input value={side.trait} onChange={(event) => setShared('trait', event.target.value)} />
            {frame.type !== 'Base' && <span>Separate several traits with commas: Trooper, Atreides</span>}
          </label>
          {frame.textBox ? (
            <label>
              Game text
              <textarea
                rows={7}
                value={side.text}
                onChange={(event) =>
                  onChange({ ...draft, [side.isBack ? 'backText' : 'text']: event.target.value })
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
        <h1>SWU Card Creator</h1>
        <nav className="tabs">
          {tabs.map(({ id, label }) => (
            <a key={id} href={`#${id}`} aria-current={tab === id ? 'page' : undefined}>
              {label}
            </a>
          ))}
        </nav>
      </header>

      {tab === 'showroom' && <Showroom cards={cards} onEdit={editCard} onRemove={removeCard} />}
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
