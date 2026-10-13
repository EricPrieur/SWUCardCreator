import { useEffect, useRef, useState } from 'react'
import artFiles from 'virtual:art-list'
import { asset } from './asset'
import './App.css'
import { CardView } from './CardView'
import { defaultLook, loadCards, readArtFile, storeCards, type Art, type Card, type Look } from './cards'
import { aspects, canBeUnique, frames, type Arena, type Aspect, type FrameType } from './frames'

const tabs = [
  { id: 'showroom', label: 'Showroom' },
  { id: 'creator', label: 'Card Creator' },
] as const

type TabId = (typeof tabs)[number]['id']

// The card being edited; it has an id once it has been saved to the showroom
type Draft = Omit<Card, 'id'> & { id?: string }

const typeFilters: { label: string; value: FrameType }[] = [
  { label: 'Units', value: 'Unit' },
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

function findFrame(frameId: string) {
  return frames.find((frame) => frame.id === frameId) ?? frames[0]
}

function tabFromHash(): TabId {
  const id = window.location.hash.slice(1)
  return tabs.find((tab) => tab.id === id)?.id ?? 'showroom'
}

function Showroom(props: { cards: Card[]; onEdit: (card: Card) => void; onRemove: (card: Card) => void }) {
  const { cards, onEdit, onRemove } = props
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
      <ul className="showroom-grid">
        {cards.map((card) => (
          <li key={card.id}>
            <CardView
              frame={findFrame(card.frameId)}
              name={card.name}
              trait={card.trait}
              text={card.text}
              unique={card.unique}
              subtitle={card.subtitle}
              cost={card.cost}
              power={card.power}
              hp={card.hp}
              art={card.art}
              look={card.look}
            />
            <div className="showroom-actions">
              <button className="button" onClick={() => onEdit(card)}>
                Edit
              </button>
              <button className="button" onClick={() => onRemove(card)}>
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>
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
  const frame = findFrame(draft.frameId)
  const shown = frames.filter(
    (candidate) =>
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
          <ArtControls art={draft.art} onChange={(art) => onChange({ ...draft, art })} />
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

        <div className="editor-preview">
          <CardView
            frame={frame}
            name={draft.name}
            trait={draft.trait}
            text={draft.text}
            unique={draft.unique}
            subtitle={draft.subtitle}
            cost={draft.cost}
            power={draft.power}
            hp={draft.hp}
            art={draft.art}
            look={draft.look}
          />
        </div>

        <div className="editor-fields">
          <h2>{frame.name}</h2>
          <div className="name-row">
            <label>
              Name
              <input value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} />
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
          {frame.subtitle && draft.unique && (
            <label>
              Subtitle
              <input
                value={draft.subtitle ?? ''}
                onChange={(event) => onChange({ ...draft, subtitle: event.target.value })}
              />
            </label>
          )}
          {stats.some(({ kind }) => frame[kind]) && (
            <div className="stats">
              {stats.map(
                ({ kind, label }) =>
                  frame[kind] && (
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
            <input value={draft.trait} onChange={(event) => onChange({ ...draft, trait: event.target.value })} />
            {frame.type !== 'Base' && <span>Separate several traits with commas: Trooper, Atreides</span>}
          </label>
          {frame.textBox ? (
            <label>
              Game text
              <textarea
                rows={7}
                value={draft.text}
                onChange={(event) => onChange({ ...draft, text: event.target.value })}
              />
              <span>In brackets: [Hidden] or [Raid 2] prints a keyword in red, [1] the cost icon, anything else bold.</span>
            </label>
          ) : (
            <p className="empty-note">This frame has no game text box.</p>
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
                  onClick={() => onChange({ ...draft, frameId: candidate.id })}
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
  const sliders = [
    { label: 'Zoom', key: 'zoom', min: 0.5, max: 3, step: 0.01 },
    { label: 'Left / right', key: 'x', min: -100, max: 100, step: 1 },
    { label: 'Up / down', key: 'y', min: -100, max: 100, step: 1 },
  ] as const

  return (
    <div className="art-controls">
      {/* Images in public/art: picking one stores only its path, not a copy.
          New art starts filling the whole card. */}
      <ul className="art-folder">
        {artFiles.map((src) => (
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
          <button className="button" type="button" onClick={() => onChange({ ...art, zoom: 1, x: 0, y: 0 })}>
            Reset position
          </button>
        )}
      </div>
      {art &&
        sliders.map(({ label, key, min, max, step }) => (
          <Slider
            key={key}
            label={label}
            min={min}
            max={max}
            step={step}
            value={art[key]}
            onChange={(value) => onChange({ ...art, [key]: value })}
          />
        ))}
    </div>
  )
}

function App() {
  const [tab, setTab] = useState<TabId>(tabFromHash)
  const [cards, setCards] = useState<Card[]>(loadCards)
  const [draft, setDraft] = useState<Draft>(blankDraft)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    const onHashChange = () => setTab(tabFromHash())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

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
