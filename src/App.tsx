import { useEffect, useRef, useState } from 'react'
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
  type FrameType,
} from './frames'

const tabs = [
  { id: 'creator', label: 'Card Creator' },
  { id: 'showroom', label: 'Showroom' },
] as const

type TabId = (typeof tabs)[number]['id']

const typeFilters: { label: string; value: FrameType }[] = [
  { label: 'Units', value: 'Unit' },
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

// The editor opens on a blank neutral unit
const blankDraft: Draft = { frameId: 'unit-neutral', name: '', trait: '', text: '' }

// A Leader side has no power or HP icon, but prints both numbers in its Epic Action box
const hasStat = (frame: Frame, kind: (typeof stats)[number]['kind']) =>
  frame[kind] !== undefined || (kind !== 'cost' && frame.stats !== undefined)

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
      art={art}
      look={card.look}
    />
  )
}

function ShowroomCard(props: { card: Card; onEdit: () => void; onRemove: () => void }) {
  const { card, onEdit, onRemove } = props
  const [back, setBack] = useState(false)
  return (
    <li>
      <CardFace card={card} back={back} />
      <div className="showroom-actions">
        {findFrame(card.frameId).backId && (
          <button className="button" onClick={() => setBack(!back)}>
            Flip
          </button>
        )}
        <button className="button" onClick={onEdit}>
          Edit
        </button>
        <button className="button" onClick={onRemove}>
          Remove
        </button>
      </div>
    </li>
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
    type: frame.token ? ('Token' as FrameType) : frame.type,
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
  const [types, setTypes] = useState<FrameType[]>([])
  const [traits, setTraits] = useState<string[]>([])
  const [costs, setCosts] = useState<number[]>([])
  const [picked, setPicked] = useState<Aspect[]>([])
  const [sort, setSort] = useState<SortKey>('saved')
  const [descending, setDescending] = useState(false)

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
            <ShowroomCard key={card.id} card={card} onEdit={() => onEdit(card)} onRemove={() => onRemove(card)} />
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
  onChange: (draft: Draft) => void
  onSave: () => void
  onNew: () => void
}) {
  const { draft, saved, saveError, onChange, onSave, onNew } = props
  const [type, setType] = useState<FrameType | null>(null)
  const [arena, setArena] = useState<Arena | null>(null)
  // 'Neutral' asks for frames with no aspect icons; otherwise frames carrying every
  // picked aspect, as many times as it was picked
  const [picked, setPicked] = useState<Aspect[] | 'Neutral'>([])
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
      (type === null || candidate.type === type || (type === 'Token' && candidate.token === true)) &&
      (arena === null || candidate.arena === arena) &&
      (picked === 'Neutral'
        ? candidate.aspects.length === 0
        : picked.every((aspect) => countOf(candidate.aspects, aspect) >= countOf(picked, aspect))),
  )

  return (
    <div className="creator">
      <section className="editor">
        <div className="editor-fields editor-side">
          <h2>Art</h2>
          <ArtControls art={side.art} onChange={setArt} />
          <h2>Frame &amp; text</h2>
          <LookControls look={draft.look ?? defaultLook} onChange={(look) => onChange({ ...draft, look })} />
          <div className="editor-actions">
            <button className="button button-primary" type="button" onClick={onSave}>
              {draft.id ? 'Update in Showroom' : 'Save to Showroom'}
            </button>
            <button className="button" type="button" onClick={onNew}>
              New card
            </button>
          </div>
          {saveError && <p className="error-note">{saveError}</p>}
          {saved && (
            <p className="saved-note">
              Saved. <a href="#showroom">See it in the Showroom</a>
            </p>
          )}
        </div>

        <ArtDrag art={side.art} onChange={setArt}>
          <CardFace card={draft} back={back} />
        </ArtDrag>

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
                In brackets: [Hidden] or [Raid 2] prints a keyword in red, [3] a cost on the yellow icon, [#3] a cost as
                a number alone, [+1/+0] a change to power and HP, [Arrow] the exhaust arrow, anything else bold. Doubled brackets print
                the brackets too: {"[Action [[Arrow]]:]"} or {"[Action [[1, Arrow]]:]"}.
                In curly brackets, text is italic: {"{reminder text}"}, or {"[{Imperial}]"} for bold italic. A line
                between {"< >"} gets Sentinel's red box, between {"<< >>"} the tinted one; a line that is only
                [Sentinel] gets it by itself.
              </span>
            </label>
          ) : (
            <p className="empty-note">This frame has no game text box.</p>
          )}
          {frame.epicBox && (
            <label>
              Epic Action
              <textarea
                rows={3}
                value={draft.epic ?? epicText(draft.cost)}
                onChange={(event) =>
                  // Text left as the usual one is not kept, so its number goes on following the cost
                  onChange({
                    ...draft,
                    epic: event.target.value === epicText(draft.cost) ? undefined : event.target.value,
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
          <FilterGroup label="Type" options={typeFilters} selected={type} onSelect={setType} />
          <FilterGroup label="Arena" options={arenaFilters} selected={arena} onSelect={setArena} />
          <AspectFilter picked={picked} onPick={setPicked} />
        </div>

        {shown.length === 0 ? (
          <p className="empty-note">No frame for this combination yet.</p>
        ) : (
          <ul className="frame-grid">
            {shown.map((candidate) => (
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
      </section>
    </div>
  )
}

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
              if (file) onChange({ src: await readArtFile(file), zoom: 1, x: 0, y: 0 })
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

  const saveDraft = () => {
    const card: Card = { ...draft, id: draft.id ?? crypto.randomUUID() }
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
      {tab === 'creator' && (
        <CardCreator
          draft={draft}
          saved={saved}
          saveError={saveError}
          onChange={changeDraft}
          onSave={saveDraft}
          onNew={() => changeDraft({ frameId: draft.frameId, name: '', trait: '', text: '' })}
        />
      )}
    </main>
  )
}

export default App
