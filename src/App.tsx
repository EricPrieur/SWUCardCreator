import { useEffect, useRef, useState, type RefObject } from 'react'
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

// What tells one card from another: its name and subtitle together
const cardTitle = (card: Draft) => `${card.name.trim()}|${(card.subtitle ?? '').trim()}`.toLowerCase()
const cardLabel = (card: Draft) =>
  [card.name.trim() || 'Unnamed card', (card.subtitle ?? '').trim()].filter(Boolean).join(', ')

function findFrame(frameId: string) {
  return frames.find((frame) => frame.id === frameId) ?? frames[0]
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
      pilotCost={card.pilotCost}
      pilotText={card.pilotText}
      upgradePower={card.upgradePower}
      upgradeHp={card.upgradeHp}
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

async function cardImage(card: HTMLElement, frame: Frame, format: ImageFormat) {
  const { toCanvas } = await import('html-to-image')
  const options = {
    pixelRatio: (frame.width * 2) / card.clientWidth,
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

function ShowroomCard(props: {
  card: Card
  format: ImageFormat
  onFormat: (format: ImageFormat) => void
  onEdit: () => void
  onRemove: () => void
}) {
  const { card, format, onFormat, onEdit, onRemove } = props
  const [back, setBack] = useState(false)
  // Remove asks once more before it does anything
  const [removing, setRemoving] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const side = cardSide(card, back)

  return (
    <li>
      <div ref={ref}>
        <CardFace card={card} back={back} />
      </div>
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
          fileName={`${side.name.trim() || 'card'}${side.isBack ? ' (unit)' : ''}`}
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

const splitTraits = (trait?: string) =>
  (trait ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)

// What a card can be found and sorted by. A leader counts for what either of its sides says.
function cardFacts(card: Card) {
  const frame = findFrame(card.frameId)
  const back = frame.backId ? cardSide(card, true) : undefined
  return {
    // A token unit is listed with the tokens
    type: (frame.token ? 'Token' : frame.pilotBox ? 'Pilot' : frame.type) as FrameFilter,
    names: [card.name, back?.name ?? ''].map((name) => name.toLowerCase()),
    traits: [...splitTraits(card.trait), ...splitTraits(back?.trait)].map((trait) => trait.toLowerCase()),
    aspects: [...frame.aspects, ...(back?.frame.aspects ?? [])],
    cost: card.cost,
  }
}

const sorts = [
  { value: 'saved', label: 'Order saved' },
  { value: 'name', label: 'Name' },
  { value: 'cost', label: 'Cost' },
  { value: 'type', label: 'Type' },
] as const
type SortKey = (typeof sorts)[number]['value']

function Showroom(props: { cards: Card[]; onEdit: (card: Card) => void; onRemove: (card: Card) => void }) {
  const { cards, onEdit, onRemove } = props
  const [query, setQuery] = useState('')
  const [types, setTypes] = useState<FrameFilter[]>([])
  const [traits, setTraits] = useState<string[]>([])
  const [costs, setCosts] = useState<number[]>([])
  const [picked, setPicked] = useState<Aspect[]>([])
  const [sort, setSort] = useState<SortKey>('saved')
  const [descending, setDescending] = useState(false)
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

  const listed = cards.map((card, index) => ({ card, index, facts: cardFacts(card) }))
  // The dropdowns only offer what some card has. Traits keep the spelling first typed.
  const traitNames = new Map<string, string>()
  for (const { card } of listed) {
    for (const trait of [...splitTraits(card.trait), ...splitTraits(card.backTrait)]) {
      if (!traitNames.has(trait.toLowerCase())) traitNames.set(trait.toLowerCase(), trait)
    }
  }
  const traitOptions = [...traitNames]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label))
  const typeOptions = typeFilters.filter(({ value }) => listed.some(({ facts }) => facts.type === value))
  const costOptions = [...new Set(listed.flatMap(({ facts }) => (facts.cost === undefined ? [] : [facts.cost])))]
    .sort((a, b) => a - b)
    .map((cost) => ({ value: cost, label: String(cost) }))

  const search = query.trim().toLowerCase()
  // Within Type, Trait and Cost any ticked box will do; every picked aspect must be on the card
  const found = listed.filter(
    ({ facts }) =>
      (search === '' || facts.names.some((name) => name.includes(search))) &&
      (types.length === 0 || types.includes(facts.type)) &&
      (traits.length === 0 || traits.some((trait) => facts.traits.includes(trait))) &&
      (costs.length === 0 || (facts.cost !== undefined && costs.includes(facts.cost))) &&
      picked.every((aspect) => facts.aspects.includes(aspect)),
  )
  const typeOrder = typeFilters.map(({ value }) => value)
  const compare: Record<SortKey, (a: (typeof found)[number], b: (typeof found)[number]) => number> = {
    saved: () => 0,
    name: (a, b) => a.card.name.localeCompare(b.card.name),
    // Cards without a cost come after the ones with one
    cost: (a, b) => (a.facts.cost ?? Infinity) - (b.facts.cost ?? Infinity),
    type: (a, b) => typeOrder.indexOf(a.facts.type) - typeOrder.indexOf(b.facts.type),
  }
  const sorted = [...found].sort((a, b) => compare[sort](a, b) || a.index - b.index)
  if (descending) sorted.reverse()
  const filtered = search !== '' || types.length + traits.length + costs.length + picked.length > 0

  return (
    <section className="showroom">
      <div className="filters showroom-filters">
        <input
          className="search"
          type="search"
          placeholder="Search by name"
          aria-label="Search by name"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="filter-group">
          <CheckDropdown label="Type" options={typeOptions} selected={types} onChange={setTypes} />
          <CheckDropdown label="Trait" options={traitOptions} selected={traits} onChange={setTraits} />
          <CheckDropdown label="Cost" options={costOptions} selected={costs} onChange={setCosts} />
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
              onClick={() =>
                setPicked(picked.includes(aspect) ? picked.filter((other) => other !== aspect) : [...picked, aspect])
              }
            >
              <img src={aspectIcon(aspect)} alt="" />
            </button>
          ))}
        </div>
        <div className="filter-group">
          <label className="filter-label" htmlFor="showroom-sort">
            Sort
          </label>
          <select id="showroom-sort" value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
            {sorts.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
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
          <span className="filter-label">
            {sorted.length === cards.length ? `${cards.length} cards` : `${sorted.length} of ${cards.length} cards`}
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
                setPicked([])
              }}
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {sorted.length === 0 ? (
        <p className="empty-note">No card matches these filters.</p>
      ) : (
        <ul className="showroom-grid">
          {sorted.map(({ card }) => (
            <ShowroomCard
              key={card.id}
              card={card}
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
  const [type, setType] = useState<FrameFilter | null>(null)
  const [arena, setArena] = useState<Arena | null>(null)
  // 'Neutral' asks for frames with no aspect icons; otherwise frames carrying every
  // picked aspect, as many times as it was picked
  const [picked, setPicked] = useState<Aspect[] | 'Neutral'>([])
  // The frame picker shows a page of frames at a time: drawing them all is slow, and
  // the filters are the quicker way to the right one
  const [page, setPage] = useState(0)
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
              fileName={`${side.name.trim() || 'card'}${side.isBack ? ' (unit)' : ''}`}
              format={format}
              onFormat={changeFormat}
              onNote={setImageNote}
            />
          </div>
          {imageNote && <p className="saved-note">{imageNote}</p>}
            <div className="editor-actions">
              <button className="button button-primary" type="button" onClick={() => save(!original)}>
                {original ? 'Update in Showroom' : 'Save to Showroom'}
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
                In brackets: [Hidden] or [Raid 2] prints a keyword in red, as does [Keywords]; [3] a cost on the yellow icon, [#3] a cost as
                a number alone, [+1/+0] a change to power and HP, [P3] a power and [H7] an HP alone, [Arrow] the exhaust arrow, [Villainy] or another aspect its icon, anything else bold. Doubled brackets print
                the brackets too: {"[Action [[Arrow]]:]"} or {"[Action [[1, Arrow]]:]"}.
                In curly brackets, text is italic: {"{reminder text}"}, or {"[{Imperial}]"} for bold italic. A line
                between {"< >"} gets Sentinel's red box, between {"<< >>"} the tinted one; a line that is only
                [Sentinel] gets it by itself.
              </span>
            </label>
          ) : (
            <p className="empty-note">This frame has no game text box.</p>
          )}
          {bothSides.some((each) => each.pilotBox) && (
            <>
              <h3 className="editor-subhead">Played as an upgrade</h3>
              <div className="stats">
                {!front.backId && (
                  <NumberPicker
                    label="Piloting cost"
                    value={draft.pilotCost}
                    options={numbers}
                    onChange={(pilotCost) => onChange({ ...draft, pilotCost })}
                  />
                )}
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
                  onChange={(event) => onChange({ ...draft, pilotText: event.target.value })}
                />
                <span>
                  Printed in the Piloting box, under PILOTING and its cost. The box grows with the text, leaving the
                  game text above the rest of the space.
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
        <Slider
          key={key}
          label={label}
          min={min}
          max={max}
          step={0.01}
          value={look[key]}
          display={`${Math.round(look[key] * 100)}%`}
          onChange={(value) => onChange({ ...look, [key]: value })}
        />
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
  useEffect(() => {
    import.meta.hot?.on('art-list', setFiles)
    return () => import.meta.hot?.off('art-list', setFiles)
  }, [])
  const sliders = [
    { label: 'Zoom', key: 'zoom', min: 0.5, max: 3, step: 0.01 },
    { label: 'Left / right', key: 'x', min: -100, max: 100, step: 1 },
    { label: 'Up / down', key: 'y', min: -100, max: 100, step: 1 },
    { label: 'Turn', key: 'rotate', min: -180, max: 180, step: 1 },
  ] as const

  return (
    <div className="art-controls">
      {/* Images in public/art: picking one stores only its path, not a copy.
          New art starts filling the whole card. */}
      <ul className="art-folder">
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
  const [cards, setCards] = useState<Card[]>(loadCards)
  const [draft, setDraft] = useState<Draft>(() => loadDraft() ?? blankDraft)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    const onHashChange = () => setTab(tabFromHash())
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
    const card: Card = { ...draft, id: (asNew ? undefined : draft.id) ?? crypto.randomUUID() }
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
          onNew={() => changeDraft({ frameId: draft.frameId, name: '', trait: '', text: '' })}
        />
      )}
    </main>
  )
}

export default App
