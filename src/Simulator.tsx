import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { asset } from './asset'
import { api, useAccount, type Session } from './api'
import { Modal } from './account'
import { deckScope, loadAccountDecks } from './accountCards'
import { DECKS_KEY, loadDecks, type Card, type Deck, type SealedPool } from './cards'
import { AI_VERSION, chooseAction, CURVE_TOP, deckPlan, type Weighed } from '../server/engine/ai.ts'
import { cardDef, randomDeck, type SavedCard } from '../server/engine/cards.ts'
import { createGame, sameAction } from '../server/engine/game.ts'
import { recordAction, replay, startRecord, type GameRecord } from '../server/engine/record.ts'
import { viewFor, type PlayerView, type SideView } from '../server/engine/view.ts'
import type { Action, Arena, CardDef, GameState, PlayerId, Printing } from '../server/engine/types.ts'
import { gameLog, type SavedGame } from './gameLog'
import {
  followRoom,
  joinRoom,
  keepSeat,
  keptSeat,
  leaveRoom,
  listRooms,
  openRoom,
  roomInfo,
  sendChat,
  sendMove,
  type ChatLine,
  type OnlineSeat,
  type RoomInfo,
  type RoomSnapshot,
} from './online'
import { combatSounds } from './combatSounds'
import { DeckGlance, type GlanceCard } from './DeckGlance'
import './Simulator.css'

// The game simulator: you against a first AI, on the DUNE set as exported to the Showcase,
// with saved decks or decks made at random.
// The engine runs here in the browser for now; online games will run it on the server, and
// this screen only ever draws a player's view and sends their actions.

const SET = 'DUNE'
const YOU: PlayerId = 0
const AI: PlayerId = 1
// How long the AI seems to think before each action, in milliseconds
const AI_DELAY = 700

// A card's image by its name in the Showcase; a Prescient card's, drawn here, is a URL already
const img = (image: string) => (/^(blob|data):/.test(image) ? image : asset(`/showcase/${SET}/${image}.jpg`))
const isPrescient = (printing?: Printing) => printing === 'prescient' || printing === 'prescient-foil'
const isFoil = (printing?: Printing) => printing === 'foil' || printing === 'prescient-foil'
// A banner's colour: its card's first aspect, Vigilance to Command before Heroism or Villainy
const ASPECT_ORDER = ['Vigilance', 'Command', 'Aggression', 'Cunning', 'Heroism', 'Villainy']
const aspectClass = (aspects: string[]) => {
  const first = ASPECT_ORDER.find((a) => aspects.includes(a))
  return first ? ` aspect-${first.toLowerCase()}` : ''
}
// A stat's class beside its printed value: ' up' when raised, ' down' when lowered
const statShift = (now: number, printed = now) => (now > printed ? ' up' : now < printed ? ' down' : '')

// The set's cards, and each one's images: its front and a leader's unit side. A two-sided
// base is two cards, its second side's id ending in BACK_SIDE, as the Deck Builder has it.
// spiceArt: the Spice token's art, its pile of spice shown on the tokens on the board
// cards: each card as saved, its art found in the Showcase, to draw its Prescient version
type SetCards = { defs: CardDef[]; images: Record<string, { image: string; back?: string }>; spiceArt?: string; cards: Record<string, Card> }
const BACK_SIDE = '#back'

export async function loadSet(): Promise<SetCards> {
  // Asked again of the server each time, so a new export shows at once
  const response = await fetch(asset(`/showcase/${SET}/showcase.json`), { cache: 'no-cache' })
  if (!response.ok) throw new Error(`The ${SET} set isn't exported`)
  const entries: { image: string; back?: string }[] = (await response.json()).cards
  const cards = await Promise.all(
    entries.map(async (entry) => {
      const saved = await fetch(asset(`/showcase/${SET}/${entry.image}.json`), { cache: 'no-cache' })
      return { entry, card: saved.ok ? ((await saved.json()) as SavedCard) : undefined }
    }),
  )
  const set: SetCards = { defs: [], images: {}, cards: {} }
  for (const { entry, card } of cards) {
    const d = card && cardDef(card)
    if (!d) continue
    set.defs.push(d)
    set.images[d.id] = { image: entry.image, back: entry.back }
    const inSet = (art?: { src?: string }) => (art?.src ? { zoom: 1, x: 0, y: 0, ...art, src: asset(`/showcase/${SET}/${art.src}`) } : undefined)
    const saved = card as unknown as Card
    set.cards[d.id] = { ...saved, art: inSet(saved.art), prescient: saved.prescient && { ...saved.prescient, art: inSet(saved.prescient.art) } }
    if (card.frameId === 'spice-token' && card.art?.src) set.spiceArt = asset(`/showcase/${SET}/${card.art.src}`)
    const second = d.type === 'base' && card.backFrameId && cardDef({ ...card, id: card.id + BACK_SIDE, frameId: card.backFrameId })
    if (second && entry.back) {
      set.defs.push(second)
      set.images[second.id] = { image: entry.back }
    }
  }
  return set
}

// The decks made in the Deck Builder, and in the set's Showcase: the account's when signed in,
// this browser's otherwise. Only those whose leader and base are cards of the set, and that have
// cards to draw, can play.
type SavedDeck = Deck & { from: string }
const deckSources = [
  { from: 'Deck Builder', scope: 'showroom', key: undefined },
  { from: `${SET} Showcase`, scope: `showcase:${SET}`, key: `dune-unlimited.decks.${SET}` },
]

// The decks built from Sealed pools, the Deck Builder's and the Showcase's, each named with
// its pool's; the newest first, the pools and their decks being kept in the order they were made
const SEALED = 'Sealed Decks'
const sealedSources = [DECKS_KEY, `${DECKS_KEY}.${SET}`]
async function loadSealedDecks(account: Session | null): Promise<SavedDeck[]> {
  const lists = await Promise.all(
    sealedSources.map(async (prefix) => {
      const load = <T,>(key: string) => (account ? loadAccountDecks<T>(account, deckScope(key)).catch(() => [] as T[]) : Promise.resolve(loadDecks<T>(key)))
      const pools = await load<SealedPool>(`${prefix}.sealed-pools`)
      const decks = await Promise.all(
        pools.map(async (pool) => (await load<Deck>(`${prefix}.sealed.${pool.id}`)).map((deck) => ({ ...deck, name: `${deck.name} (${pool.name})`, from: SEALED }))),
      )
      return decks.flat()
    }),
  )
  return lists.flat().reverse()
}

// Decks anyone may try, signed in or not, which ship with the site
const FEATURED = 'Featured Decks'
async function loadFeaturedDecks(): Promise<SavedDeck[]> {
  const response = await fetch(asset('/sim/featured-decks.json'), { cache: 'no-cache' }).catch(() => undefined)
  if (!response?.ok) return []
  const decks: Pick<Deck, 'id' | 'name' | 'leader' | 'base' | 'cards'>[] = await response.json()
  return decks.map((deck) => ({ ...deck, id: `featured-${deck.id}`, sets: [SET], sideboard: [], from: FEATURED }))
}

async function loadSavedDecks(account: Session | null, set: SetCards): Promise<SavedDeck[]> {
  const lists = await Promise.all([
    loadFeaturedDecks(),
    loadSealedDecks(account),
    ...deckSources.map(async ({ from, scope, key }) => {
      const decks = account ? await loadAccountDecks(account, scope).catch(() => [] as Deck[]) : loadDecks(key)
      return decks.map((deck) => ({ ...deck, from }))
    }),
  ])
  const known = new Set(set.defs.map((d) => d.id))
  return lists
    .flat()
    .filter((deck) => deck.leader && deck.base && known.has(deck.leader) && known.has(deck.base))
    .filter((deck) => deckList(deck, set).deck.length)
}

// A deck as the engine takes it; cards that aren't in the set are left out
function deckList(deck: Deck, set: SetCards) {
  const playable = new Set(set.defs.filter((d) => ['unit', 'upgrade', 'event'].includes(d.type)).map((d) => d.id))
  const entries = deck.cards.filter((entry) => playable.has(entry.id))
  // Each copy's printing, in the deck's order: its Prescient and foil copies, then the plain ones
  const printings = entries.flatMap((entry) => {
    const kinds = (['prescient', 'foil', 'prescient-foil'] as const).flatMap((kind) => Array(entry.versions?.[kind] ?? 0).fill(kind) as Printing[])
    return [...kinds, ...Array(Math.max(0, entry.count - kinds.length)).fill(null)].slice(0, entry.count) as (Printing | null)[]
  })
  return {
    leader: deck.leader as string,
    base: deck.base as string,
    deck: entries.flatMap((entry) => Array(entry.count).fill(entry.id) as string[]),
    ...(printings.some(Boolean) && { printings }),
  }
}

// A deck chosen as the engine takes it, and the name it goes by: a saved deck, one of them at
// random (not `not`, when there are others), or one made at random
function resolveChoice(choice: Choice, set: SetCards, decks: SavedDeck[], not?: Deck) {
  const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)]
  let deck: Deck | undefined
  if (choice.startsWith('deck:')) deck = decks.find((d) => `deck:${d.id}` === choice)
  else if (choice === 'random' && decks.length) deck = pick(decks)
  else if (choice === 'different-random' && decks.length) deck = pick(decks.length > 1 ? decks.filter((d) => d !== not) : decks)
  return { deck, list: deck ? deckList(deck, set) : randomDeck(set.defs), name: deck?.name ?? 'Random' }
}

// What each side plays: a deck made at random, one of the saved decks at random (for the AI, a
// different one from yours when there are two), or a saved deck, as deck:<id>
type Choice = 'random-generated' | 'random' | 'different-random' | `deck:${string}`
const CHOICE_KEY = 'dune-unlimited.simulator.decks'

function rememberedChoices(): [Choice, Choice] {
  try {
    const saved = JSON.parse(localStorage.getItem(CHOICE_KEY) ?? 'null')
    if (Array.isArray(saved) && saved.length === 2) return saved as [Choice, Choice]
  } catch {
    // The defaults, then
  }
  return ['random-generated', 'random-generated']
}

// The game being played, kept in this browser after each move so that a reload (or coming back
// to the Simulator) can resume it, its server save going on too
const CURRENT_KEY = 'dune-unlimited.simulator.current'
type KeptGame = { record: GameRecord; deckNames: [string, string]; server: SavedGame | null }

function keptGame(): KeptGame | null {
  try {
    const kept = JSON.parse(localStorage.getItem(CURRENT_KEY) ?? 'null')
    return kept?.record?.actions ? kept : null
  } catch {
    return null
  }
}
function keepGame(kept: KeptGame | null) {
  try {
    if (kept) localStorage.setItem(CURRENT_KEY, JSON.stringify(kept))
    else localStorage.removeItem(CURRENT_KEY)
  } catch {
    // Not kept, then: a reload ends the game
  }
}

// A deck's aspects, its leader's then its base's, as small icons
function DeckIcons(props: { deck: Deck; set: SetCards }) {
  const def = (id?: string | null) => (id ? props.set.defs.find((d) => d.id === id) : undefined)
  const aspects = [...(def(props.deck.leader)?.aspects ?? []), ...(def(props.deck.base)?.aspects ?? [])]
  if (!aspects.length) return null
  return (
    <span className="sim-deck-icons" title={aspects.join(', ')}>
      {aspects.map((aspect, index) => (
        <img key={index} src={asset(`/icons/aspect/${aspect.toLowerCase()}.png`)} alt={aspect} />
      ))}
    </span>
  )
}

// The deck choices as a menu, each saved deck with its aspects (a <select> can't show pictures)
function DeckMenu(props: {
  title: string
  value: Choice
  fixed: { value: Choice; label: string }[]
  groups: { from: string; decks: SavedDeck[] }[]
  set: SetCards
  // Which side of the screen the menu is on: its leader preview opens toward the middle
  side: 'me' | 'opp'
  onChange: (choice: Choice) => void
}) {
  const [open, setOpen] = useState(false)
  // The deck the pointer is on, whose leader shows beside the list
  const [hovered, setHovered] = useState<SavedDeck | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) setHovered(null)
    if (!open) return
    const away = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', key)
    }
  }, [open])
  const decks = props.groups.flatMap((group) => group.decks)
  const chosen = decks.find((deck) => `deck:${deck.id}` === props.value)
  const pick = (choice: Choice) => {
    props.onChange(choice)
    setOpen(false)
  }
  return (
    <div className="sim-deck-menu" ref={ref}>
      <button type="button" aria-haspopup="listbox" aria-expanded={open} aria-label={props.title} onClick={() => setOpen(!open)}>
        <span className="sim-deck-menu-name">{chosen ? chosen.name : props.fixed.find((f) => f.value === props.value)?.label}</span>
        {chosen && <DeckIcons deck={chosen} set={props.set} />}
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="sim-deck-options" role="listbox" aria-label={props.title} onPointerLeave={() => setHovered(null)}>
          {props.fixed.map((option) => (
            <button key={option.value} type="button" role="option" aria-selected={option.value === props.value} onClick={() => pick(option.value)}>
              {option.label}
            </button>
          ))}
          {props.groups.map((group) => (
            <div key={group.from} role="group" aria-label={group.from}>
              <div className="sim-deck-group">{group.from}</div>
              {group.decks.map((deck) => (
                <button
                  key={deck.id}
                  type="button"
                  role="option"
                  aria-selected={`deck:${deck.id}` === props.value}
                  onPointerEnter={() => setHovered(deck)}
                  onClick={() => pick(`deck:${deck.id}`)}
                >
                  <span className="sim-deck-menu-name">{deck.name}</span>
                  <DeckIcons deck={deck} set={props.set} />
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      {open && hovered && <LeaderPreview deck={hovered} set={props.set} side={props.side} />}
    </div>
  )
}

// A deck's leader, both its sides, beside the open deck menu
function LeaderPreview(props: { deck: SavedDeck; set: SetCards; side: 'me' | 'opp' }) {
  const images = props.deck.leader ? props.set.images[props.deck.leader] : undefined
  if (!images) return null
  // The deck's cards, each once with its copies
  const counts = new Map<string, number>()
  for (const id of deckList(props.deck, props.set).deck) counts.set(id, (counts.get(id) ?? 0) + 1)
  const cards = [...counts].flatMap(([id, count]): GlanceCard[] => {
    const def = props.set.defs.find((d) => d.id === id)
    if (!def) return []
    const kind = def.type === 'unit' ? (def.arena === 'space' ? 'Space' : 'Ground') : def.type === 'event' ? 'Event' : def.type === 'upgrade' ? 'Upgrade' : undefined
    return [{ cost: def.cost, kind, aspects: def.aspects, count }]
  })
  return (
    <div className={`sim-deck-preview ${props.side}`} aria-hidden="true">
      <div className="sim-deck-preview-sides">
        <img src={img(images.image)} alt="" />
        {images.back && <img src={img(images.back)} alt="" />}
      </div>
      <DeckGlance cards={cards} />
    </div>
  )
}

function DeckPicker(props: {
  title: string
  side: 'me' | 'opp'
  value: Choice
  decks: SavedDeck[]
  set: SetCards
  onChange: (choice: Choice) => void
}) {
  const { decks, set } = props
  const chosen = props.value.startsWith('deck:') ? decks.find((deck) => `deck:${deck.id}` === props.value) : undefined
  // A remembered deck that is gone is a random one
  const value = props.value.startsWith('deck:') && !chosen ? 'random-generated' : props.value
  // Your own decks first, those built from Sealed pools after the Deck Builder's, the ones that
  // ship with the site last
  const groups = [deckSources[0].from, SEALED, ...deckSources.slice(1).map(({ from }) => from), FEATURED].map((from) => ({ from, decks: decks.filter((deck) => deck.from === from) }))
  const about: Record<string, string> = {
    'random-generated': `A random leader and base, with 50 cards of the ${SET} set they can pay for.`,
    random: decks.length ? 'One of the decks in this list, picked at random.' : 'There are no decks yet: a random deck is made instead.',
    'different-random':
      decks.length > 1 ? 'One of the decks in this list at random, not the one you play.' : 'One of the decks in this list, picked at random.',
  }
  return (
    <div className={`sim-picker ${props.side}`}>
      <div className="sim-picker-label">
        {props.title}
        <DeckMenu
          title={props.title}
          value={value}
          fixed={[
            { value: 'random-generated', label: 'Create a Random Deck' },
            ...(props.side === 'opp' ? [{ value: 'different-random' as Choice, label: 'Different Random (any)' }] : []),
            { value: 'random', label: 'Random (any)' },
          ]}
          groups={groups.filter((group) => group.decks.length)}
          set={set}
          side={props.side}
          onChange={props.onChange}
        />
      </div>
      {chosen ? (
        <>
          <div className="sim-seat-cards">
            {[chosen.leader as string, chosen.base as string].map((id) => (
              <img key={id} src={img(set.images[id].image)} alt="" />
            ))}
          </div>
          <p>{deckList(chosen, set).deck.length} cards</p>
        </>
      ) : (
        <>
          <div className="sim-seat-cards unknown">
            <span>?</span>
            <span>?</span>
          </div>
          <p>{about[value]}</p>
        </>
      )}
    </div>
  )
}

// The AI answers greetings and the like in kind
const replies: [RegExp, string[]][] = [
  [/\b(gl ?hf|glhf|good luck|have fun)\b/i, ['gl hf!', 'glhf', 'Good luck, have fun!', 'You too, gl hf']],
  [/\b(gg|good game|well played|wp)\b/i, ['gg', 'gg wp', 'Good game!', 'gg, well played']],
  [/\b(nice|great|good) (play|move|one)\b/i, ['Thanks!', 'ty', 'Thanks, I liked that one']],
  [/^(hi|hello|hey|yo)\b/i, ['Hi!', 'Hello!', 'Hey there']],
  [/\b(thinking|hmm+)\b/i, ['Take your time', 'No rush']],
  [/\b(sorry|oops)\b/i, ['No worries', 'np']],
  [/\b(thanks|thank you|ty)\b/i, ['np', 'Anytime']],
]
function replyTo(text: string) {
  const answers = replies.find(([pattern]) => pattern.test(text))?.[1]
  return answers?.[Math.floor(Math.random() * answers.length)]
}

// drawCard: draws a card as an image, for the Prescient copies in a game; without it they show plain
export function Simulator(props: { drawCard?: (card: Card) => Promise<string> }) {
  const account = useAccount()
  // The room a link invites to (?room=), and the seat held in a game online
  const [invited, setInvited] = useState(() => new URLSearchParams(window.location.search).get('room'))
  const [online, setOnline] = useState<OnlineSeat | null>(keptSeat)
  const [view, setView] = useState<'ai' | 'online'>(invited ? 'online' : 'ai')
  const takeSeat = (seat: OnlineSeat | null) => {
    keepSeat(seat)
    setOnline(seat)
    if (seat && invited) {
      setInvited(null)
      const url = new URL(window.location.href)
      url.searchParams.delete('room')
      window.history.replaceState(null, '', url)
    }
  }
  const [set, setSet] = useState<SetCards | null>(null)
  const [failed, setFailed] = useState('')
  const [decks, setDecks] = useState<SavedDeck[]>([])
  const [choices, setChoices] = useState<[Choice, Choice]>(rememberedChoices)
  // Others may watch your games against the AI: they are in the Online Game tab's In Progress
  const [spectators, setSpectators] = useFlag(SPECTATORS_KEY, true)
  const [game, setGame] = useState<GameState | null>(null)
  // Each game its own table, which starts with nothing drawn yet
  const [gameNumber, setGameNumber] = useState(0)
  // The game's record, each action added to it, and its saving to the server
  const record = useRef<GameRecord | null>(null)
  const log = useRef<ReturnType<typeof gameLog> | null>(null)
  const gameNow = useRef(game)
  gameNow.current = game
  // The game before each of your moves, and how long its record was then: Undo takes back your
  // last move and the AI's since, as many times as you like
  const history = useRef<{ state: GameState; steps: number }[]>([])
  // The game kept in this browser: the one being played, or one a reload left to resume
  const kept = useRef<KeptGame | null>(null)
  const [waiting, setWaiting] = useState<KeptGame | null>(keptGame)
  const keep = () => keepGame(kept.current)
  // The Prescient copies' images by card, drawn one at a time as a game needs them
  const [prescient, setPrescient] = useState<Record<string, string>>({})
  const drawing = useRef(new Set<string>())
  useEffect(() => {
    const decks = record.current?.decks
    const { drawCard } = props
    if (!set || !decks || !drawCard) return
    const wanted = [...new Set(decks.flatMap((list) => list.deck.filter((_, i) => isPrescient(list.printings?.[i] ?? undefined))))]
    const toDraw = wanted.filter((id) => set.cards[id] && !drawing.current.has(id))
    if (!toDraw.length) return
    for (const id of toDraw) drawing.current.add(id)
    ;(async () => {
      for (const id of toDraw) {
        try {
          const url = await drawCard(set.cards[id])
          setPrescient((now) => ({ ...now, [id]: url }))
        } catch {
          // Shown plain, then
          drawing.current.delete(id)
        }
      }
    })()
  }, [gameNumber, set])

  useEffect(() => {
    loadSet()
      .then(setSet)
      .catch((error: Error) => setFailed(error.message))
  }, [])
  useEffect(() => {
    if (set) loadSavedDecks(account, set).then(setDecks)
  }, [account, set])

  const choose = (side: number, choice: Choice) => {
    const next = choices.map((c, i) => (i === side ? choice : c)) as [Choice, Choice]
    setChoices(next)
    try {
      localStorage.setItem(CHOICE_KEY, JSON.stringify(next))
    } catch {
      // Not remembered, then
    }
  }

  const start = () => {
    if (!set) return
    let yours: Deck | undefined
    const deckNames: string[] = []
    const resolve = (choice: Choice, side: number) => {
      const { deck, list, name } = resolveChoice(choice, set, decks, yours)
      if (side === YOU) yours = deck
      deckNames[side] = name
      return list
    }
    const lists = choices.map(resolve)
    const names = lists.map((list) => set.defs.find((d) => d.id === list.leader)?.name ?? 'Player')
    setGameNumber((n) => n + 1)
    const seed = Date.now()
    const named = lists.map((list, i) => ({
      // Named after their leaders, the AI's marked when both play the same one
      name: i === AI && names[1] === names[0] ? `${names[1]} (AI)` : names[i],
      ...list,
    })) as GameRecord['decks']
    if (game) log.current?.left(game)
    else abandon()
    record.current = startRecord(seed, named, [{ kind: 'human' }, { kind: 'ai', version: AI_VERSION }])
    const game_: KeptGame = { record: record.current, deckNames: deckNames as [string, string], server: null }
    kept.current = game_
    log.current = gameLog(
      account,
      record.current,
      game_.deckNames,
      null,
      (saved) => {
        game_.server = saved
        if (kept.current === game_ && gameNow.current?.phase !== 'over') keep()
      },
      { spectators },
    )
    const next = createGame({ seed, defs: set.defs, decks: named })
    log.current.moved(next)
    keep()
    history.current = []
    setGame(next)
  }
  // The game kept as it is now, or no longer once it is over
  const keepAt = (state: GameState) => keepGame(state.phase === 'over' ? null : kept.current)
  const act = (state: GameState, p: PlayerId, action: Action, why?: Weighed[]) => {
    if (p === YOU) history.current.push({ state, steps: record.current!.actions.length })
    const next = recordAction(record.current!, state, p, action, why)
    log.current?.moved(next)
    keepAt(next)
    combatSounds(state, next, (sound, delay, cut) => setTimeout(() => play(sound, 0.6, cut), delay))
    setGame(next)
  }
  const undo = () => {
    const last = history.current.pop()
    const played = record.current
    if (!last || !played) return
    // The record as if those moves were never made, the times taken back counted
    played.actions.length = last.steps
    delete played.result
    played.undos = (played.undos ?? 0) + 1
    log.current?.undone()
    keepAt(last.state)
    setGame(last.state)
  }
  const leave = () => {
    if (game) log.current?.left(game)
    kept.current = null
    keep()
    setGame(null)
  }
  // The game a reload left, rebuilt from its record: your moves can still be taken back
  const rebuild = (waited: KeptGame) => {
    const before: { state: GameState; steps: number }[] = []
    try {
      const state = replay(waited.record, set!.defs, undefined, (s, step, i) => {
        if (step.p === YOU) before.push({ state: s, steps: i })
      })
      return { state, before }
    } catch {
      // Cards changed since in a way the game can't be played back
      return null
    }
  }
  const resume = () => {
    if (!waiting || !set) return
    const rebuilt = rebuild(waiting)
    setWaiting(null)
    if (!rebuilt || rebuilt.state.phase === 'over') return keepGame(null)
    const game_ = waiting
    kept.current = game_
    record.current = game_.record
    log.current = gameLog(account, game_.record, game_.deckNames, game_.server, (saved) => {
      game_.server = saved
      if (kept.current === game_ && gameNow.current?.phase !== 'over') keep()
    })
    log.current.moved(rebuilt.state)
    history.current = rebuilt.before
    setGameNumber((n) => n + 1)
    setGame(rebuilt.state)
  }
  // The game a reload left, not resumed: saved as left
  const abandon = () => {
    if (!waiting) return
    setWaiting(null)
    keepGame(null)
    const rebuilt = set && rebuild(waiting)
    if (rebuilt && rebuilt.state.phase !== 'over') gameLog(account, waiting.record, waiting.deckNames, waiting.server).left(rebuilt.state)
  }

  if (online && set) {
    return <OnlineGame key={online.room} seat={online} set={set} drawCard={props.drawCard} onDone={() => takeSeat(null)} />
  }
  if (game && set) {
    return (
      <div className="sim">
        <Table
          key={gameNumber}
          set={set}
          game={game}
          prescient={prescient}
          onAct={(p, action, why) => act(game, p, action, why)}
          onUndo={history.current.length ? undo : undefined}
          onNew={leave}
          onAgain={start}
        />
      </div>
    )
  }

  return (
    <div className="sim-menu">
      <div className="sim-menu-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={view === 'ai'} onClick={() => setView('ai')}>
          Play vs AI
        </button>
        <button type="button" role="tab" aria-selected={view === 'online'} onClick={() => setView('online')}>
          Online Game
        </button>
      </div>
      {failed || !set ? (
        <div className="sim-menu-panel">
          <p>{failed || `Loading the ${SET} cards…`}</p>
        </div>
      ) : view === 'online' ? (
        <OnlineLobby account={account} set={set} decks={decks} invited={invited} onSeat={takeSeat} />
      ) : (
        <div className="sim-menu-panel">
          {waiting && (
            <div className="sim-resume">
              <p>
                You have a game in progress: {waiting.record.decks[YOU].name} against {waiting.record.decks[AI].name}.
              </p>
              <button type="button" className="sim-button go" onClick={resume}>
                Resume game
              </button>
              <button type="button" className="sim-button" onClick={abandon}>
                Abandon it
              </button>
            </div>
          )}
          <div className="sim-pickers">
            <DeckPicker title="Your Deck" side="me" value={choices[0]} decks={decks} set={set} onChange={(c) => choose(0, c)} />
            <DeckPicker title="AI Deck" side="opp" value={choices[1]} decks={decks} set={set} onChange={(c) => choose(1, c)} />
          </div>
          <label className="sim-toggle" title="Others may watch this game: it is listed in the Online Game tab's In Progress">
            <input type="checkbox" checked={spectators} onChange={(event) => setSpectators(event.target.checked)} />
            Spectators
          </label>
          <button type="button" className="sim-button go" onClick={start}>
            Start game
          </button>
        </div>
      )}
    </div>
  )
}

// A line of the table's chat: yours or the other side's; named when it is neither's
type TableChat = { who: 'me' | 'opp'; text: string; name?: string }
// A game online as the table shows it: the game as the server shows your seat (or a spectator),
// its last cards played, its chat, and a word on the other player when there is one to say
type OnlineTable = {
  view: PlayerView
  seat: PlayerId
  watching: boolean
  last: [string | null, string | null]
  chat: TableChat[]
  say: (text: string) => void
  notice?: string
}

// A game online, followed from the server: the room waiting for an opponent, with its link to
// share, then the table. Leaving concedes a game under way; a spectator just goes.
function OnlineGame(props: { seat: OnlineSeat; set: SetCards; drawCard?: (card: Card) => Promise<string>; onDone: () => void }) {
  const { seat, set } = props
  const [room, setRoom] = useState<RoomSnapshot | null>(null)
  const [chat, setChat] = useState<ChatLine[]>([])
  const [ended, setEnded] = useState<number | null>(null)
  const [connected, setConnected] = useState(true)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(
    () =>
      followRoom(seat, {
        room: (snapshot) => {
          setRoom(snapshot)
          setError('')
        },
        chat: (line) => setChat((now) => [...now, line]),
        end: setEnded,
        connected: setConnected,
      }),
    [seat.room, seat.key],
  )
  // The Prescient copies seen, drawn once each
  const [prescient, setPrescient] = useState<Record<string, string>>({})
  const drawing = useRef(new Set<string>())
  useEffect(() => {
    const view = room?.view
    if (!view || !props.drawCard) return
    const seen: { id: string; def: string }[] = []
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk)
      else if (value && typeof value === 'object') {
        const card = value as { id?: unknown; def?: unknown }
        if (typeof card.id === 'string' && typeof card.def === 'string') seen.push(card as { id: string; def: string })
        Object.values(value).forEach(walk)
      }
    }
    walk(view.players)
    const toDraw = [...new Set(seen.filter((c) => isPrescient(view.printings[c.id])).map((c) => c.def))].filter(
      (def) => set.cards[def] && !drawing.current.has(def),
    )
    for (const def of toDraw) drawing.current.add(def)
    ;(async () => {
      for (const def of toDraw) {
        try {
          const url = await props.drawCard!(set.cards[def])
          setPrescient((now) => ({ ...now, [def]: url }))
        } catch {
          drawing.current.delete(def)
        }
      }
    })()
  }, [room?.view])

  const watching = !seat.key
  const leave = async () => {
    if (!watching && room && room.status !== 'over') await leaveRoom(seat).catch(() => undefined)
    props.onDone()
  }
  const link = (() => {
    const url = new URL(window.location.href)
    url.searchParams.set('room', seat.room)
    return url.toString()
  })()
  const copy = () => {
    navigator.clipboard?.writeText(link).then(
      () => setCopied(true),
      () => setCopied(false),
    )
  }

  if (ended !== null) {
    return (
      <div className="sim-menu">
        <div className="sim-menu-panel sim-room">
          <p>{ended === 403 ? 'This game is not open to spectators.' : 'This game is over, or was never opened.'}</p>
          <button type="button" className="sim-button" onClick={props.onDone}>
            Back to the menu
          </button>
        </div>
      </div>
    )
  }
  if (!room) {
    return (
      <div className="sim-menu">
        <div className="sim-menu-panel sim-room">
          <p>{connected ? 'Joining the game…' : 'The server can’t be reached. Trying again…'}</p>
          <button type="button" className="sim-button" onClick={props.onDone}>
            Back to the menu
          </button>
        </div>
      </div>
    )
  }
  if (!room.view) {
    return (
      <div className="sim-menu">
        <div className="sim-menu-panel sim-room">
          <h2>Waiting for an opponent…</h2>
          <p className="sim-note">
            {room.public ? 'Your game is listed in Public Games.' : 'Your game is not listed: only those you send its link to can join.'}{' '}
            Send this link to invite someone:
          </p>
          <div className="sim-room-link">
            <input readOnly value={link} onFocus={(event) => event.target.select()} />
            <button type="button" className="sim-button" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <button type="button" className="sim-button" onClick={leave}>
            Cancel the game
          </button>
        </div>
      </div>
    )
  }

  const me = room.seat ?? 0
  const them = me === 0 ? 1 : 0
  const other = room.players[them]
  const notice = !connected
    ? 'Your connection was lost. Trying again…'
    : error || (other?.gone ? `${other.name} lost their connection. If they're not back within 5 minutes, they lose.` : undefined)
  const online: OnlineTable = {
    view: room.view,
    seat: me,
    watching,
    last: room.last,
    chat: chat.map((line) => ({ who: line.seat === me ? 'me' : 'opp', text: line.text, ...(watching && { name: line.name }) })),
    say: (text) => {
      if (!watching) sendChat(seat, text).catch((err: Error) => setError(err.message))
    },
    notice,
  }
  return (
    <div className="sim">
      <Table
        set={set}
        online={online}
        prescient={prescient}
        onAct={(_, action) => {
          sendMove(seat, action).catch((err: Error) => setError(err.message))
        }}
        onNew={leave}
      />
    </div>
  )
}

// A yes or no remembered in this browser
const SPECTATORS_KEY = 'dune-unlimited.simulator.spectators'
function useFlag(key: string, first: boolean) {
  const [value, setValue] = useState(() => {
    try {
      const saved = localStorage.getItem(key)
      return saved === null ? first : saved === 'true'
    } catch {
      return first
    }
  })
  const change = (next: boolean) => {
    setValue(next)
    try {
      localStorage.setItem(key, String(next))
    } catch {
      // Not remembered, then
    }
  }
  return [value, change] as const
}

// A game of the last hour, as the server lists it
type RecentGame = {
  id: number
  mode: string
  status: 'playing' | 'finished' | 'conceded' | 'left'
  winner: number | null
  draw: boolean
  rounds: number
  sides: { name: string; deck: string; seat: 'human' | 'ai'; leader: string; base: string }[]
  is_public: boolean
  spectators: boolean
  started_at: string
  username: string | null
  // An online game still played: its room, to watch it
  room: string | null
}
// How often the list asks again, while it is shown
const RECENT_EVERY = 20_000

const ago = (date: string) => {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 60_000))
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`
}

const ONLINE_DECK_KEY = 'dune-unlimited.simulator.online-deck'

// The Online Game tab, as on The Chrome Grid: a game to create on the left (online play is on the
// way), and on the right the games to join (Public Games) and those of the last hour (In Progress),
// the newest first. Anyone sees the games open to spectators; an admin, every one.
function OnlineLobby(props: {
  account: Session | null
  set: SetCards
  decks: SavedDeck[]
  // The room a link invites to
  invited: string | null
  onSeat: (seat: OnlineSeat) => void
}) {
  const { account, set, decks } = props
  const [deck, setDeck] = useState<Choice>(() => {
    try {
      return (localStorage.getItem(ONLINE_DECK_KEY) as Choice | null) ?? 'random-generated'
    } catch {
      return 'random-generated'
    }
  })
  const chooseDeck = (choice: Choice) => {
    setDeck(choice)
    try {
      localStorage.setItem(ONLINE_DECK_KEY, choice)
    } catch {
      // Not remembered, then
    }
  }
  const [listed, setListed] = useFlag('dune-unlimited.simulator.online-public', true)
  const [spectators, setSpectators] = useFlag(SPECTATORS_KEY, true)
  const [tab, setTab] = useState<'public' | 'progress'>('public')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // The deck chosen, as the server takes it
  const opening = () => {
    const { list, name } = resolveChoice(deck, set, decks)
    return { deck: list, deckName: name }
  }
  const run = async (what: () => Promise<OnlineSeat>) => {
    setBusy(true)
    setError('')
    try {
      props.onSeat(await what())
    } catch (err) {
      setError((err as Error).message)
    }
    setBusy(false)
  }
  const create = () =>
    run(async () => {
      const opened = await openRoom(account, { ...opening(), public: listed, spectators })
      return { room: opened.id, key: opened.key }
    })
  const join = (room: string) => run(async () => ({ room, key: (await joinRoom(account, room, opening())).key }))

  // The room a link invites to, as it stands
  const [invite, setInvite] = useState<RoomInfo | null | 'gone'>(null)
  useEffect(() => {
    if (!props.invited) return
    roomInfo(props.invited).then(setInvite, () => setInvite('gone'))
  }, [props.invited])

  // The rooms waiting for a player, asked again while shown
  const [waiting, setWaiting] = useState<RoomInfo[] | null>(null)
  useEffect(() => {
    if (tab !== 'public') return
    let live = true
    const load = () =>
      listRooms()
        .then((found) => live && setWaiting(found))
        .catch(() => live && setWaiting((now) => now ?? []))
    load()
    const timer = window.setInterval(load, ROOMS_EVERY)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [tab])

  const [recent, setRecent] = useState<{ games: RecentGame[]; all: boolean } | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (tab !== 'progress') return
    let live = true
    const load = () =>
      api<{ games: RecentGame[]; all: boolean }>('/api/games/recent', { token: account?.token })
        .then((found) => {
          if (!live) return
          setRecent(found)
          setFailed(false)
        })
        .catch(() => live && setFailed(true))
    load()
    const timer = window.setInterval(load, RECENT_EVERY)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [tab, account?.token])

  const cardsOf = (ids: (string | undefined)[]) => (
    <div className="sim-recent-cards">
      {ids.map((id, at) =>
        id && set.images[id] ? <img key={at} src={img(set.images[id].image)} alt={set.defs.find((d) => d.id === id)?.name ?? ''} /> : <span key={at} />,
      )}
    </div>
  )

  return (
    <div className="sim-menu-panel sim-lobby">
      {props.invited && invite && (
        <div className="sim-resume sim-invite">
          {invite === 'gone' || invite.status !== 'waiting' ? (
            <p>The game you were invited to has already started or is over.</p>
          ) : (
            <>
              <p>
                {invite.host} invites you to a game, with {invite.deck}. Pick your deck, then join.
              </p>
              <button type="button" className="sim-button go" disabled={busy} onClick={() => join(invite.id)}>
                Join {invite.host}'s game
              </button>
            </>
          )}
        </div>
      )}
      <div className="sim-lobby-create">
        <DeckPicker title="Your Deck" side="me" value={deck} decks={decks} set={set} onChange={chooseDeck} />
        <div className="sim-toggles">
          <label
            className="sim-toggle"
            title="Public: your game is listed in Public Games for anyone to join. Otherwise only those you send its link to can."
          >
            <input type="checkbox" checked={listed} onChange={(event) => setListed(event.target.checked)} />
            Public
          </label>
          <label className="sim-toggle" title="Others may watch this game: it is listed in In Progress">
            <input type="checkbox" checked={spectators} onChange={(event) => setSpectators(event.target.checked)} />
            Spectators
          </label>
        </div>
        <button type="button" className="sim-button go" disabled={busy} onClick={create}>
          Create Game
        </button>
        {error && <p className="sim-error">{error}</p>}
        <p className="sim-note">{account ? 'You play as ' + account.user.username + '.' : 'Signed out, you play as Guest.'}</p>
      </div>
      <div className="sim-lobby-games">
        <div className="sim-lobby-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'public'} onClick={() => setTab('public')}>
            Public Games
          </button>
          <button type="button" role="tab" aria-selected={tab === 'progress'} onClick={() => setTab('progress')}>
            In Progress
          </button>
        </div>
        {tab === 'public' ? (
          !waiting ? (
            <p className="sim-note">Loading…</p>
          ) : waiting.length === 0 ? (
            <p className="sim-note">No public game is waiting for a player. Create one!</p>
          ) : (
            <ul className="sim-recent">
              {waiting.map((room) => (
                <li key={room.id} className="sim-recent-game sim-room-item">
                  <div className="sim-recent-head">
                    <span className="sim-recent-status">{room.host}</span>
                    <span className="sim-recent-when">{ago(new Date(room.createdAt).toISOString())}</span>
                  </div>
                  <div className="sim-room-row">
                    <div className="sim-recent-side me">
                      {cardsOf([room.leader, room.base])}
                      <span>{room.deck}</span>
                    </div>
                    <button type="button" className="sim-button go" disabled={busy} onClick={() => join(room.id)}>
                      Join
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )
        ) : failed && !recent ? (
          <p className="sim-note">Could not load the games. Trying again shortly…</p>
        ) : !recent ? (
          <p className="sim-note">Loading…</p>
        ) : (
          <>
            <p className="sim-note">
              {recent.all ? 'Every game of the last hour, as an admin sees them' : 'The games of the last hour open to spectators'}, the newest
              first.
            </p>
            {recent.games.length === 0 ? (
              <p className="sim-note">No game in the last hour.</p>
            ) : (
              <ul className="sim-recent">
                {recent.games.map((game) => (
                  <RecentGameItem
                    key={game.id}
                    game={game}
                    set={set}
                    admin={recent.all}
                    onWatch={game.room && game.spectators ? () => props.onSeat({ room: game.room!, key: null }) : undefined}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  )
}
// How often the rooms waiting are asked again, while shown
const ROOMS_EVERY = 5_000

// One game of the list: how it stands, when it started, and each side's leader, base and deck;
// an online game still played can be watched
function RecentGameItem(props: { game: RecentGame; set: SetCards; admin: boolean; onWatch?: () => void }) {
  const { game, set } = props
  // Online, each side is named by its player
  const who = (i: number) =>
    game.mode === 'online' ? game.sides[i]?.name : game.sides[i]?.seat === 'ai' ? 'AI' : (game.username ?? 'A visitor')
  const status =
    game.status === 'playing'
      ? `Live · round ${game.rounds}`
      : game.draw
        ? 'Draw'
        : game.status === 'left'
          ? `${who(0)} left`
          : game.winner !== null
            ? `${who(game.winner)} won${game.status === 'conceded' ? ' (conceded)' : ''}`
            : 'Over'
  return (
    <li className={`sim-recent-game${game.status === 'playing' ? ' live' : ''}`}>
      <div className="sim-recent-head">
        <span className="sim-recent-status">{status}</span>
        {game.mode === 'online' && <span className="sim-recent-flag">Online</span>}
        {props.admin && !game.is_public && <span className="sim-recent-flag">Not public</span>}
        {props.admin && !game.spectators && <span className="sim-recent-flag">No spectators</span>}
        <span className="sim-recent-when">{ago(game.started_at)}</span>
        {props.onWatch && (
          <button type="button" className="sim-button sim-watch" onClick={props.onWatch}>
            Watch
          </button>
        )}
      </div>
      <div className="sim-recent-sides">
        {[0, 1].map((i) => {
          const side = game.sides[i]
          return (
            <div key={i} className={`sim-recent-side ${i === 0 ? 'me' : 'opp'}`}>
              <div className="sim-recent-cards">
                {[side?.leader, side?.base].map((id, at) =>
                  id && set.images[id] ? (
                    <img key={at} src={img(set.images[id].image)} alt={set.defs.find((d) => d.id === id)?.name ?? ''} />
                  ) : (
                    <span key={at} />
                  ),
                )}
              </div>
              <strong>{who(i)}</strong>
              <span>{side?.deck || side?.name}</span>
            </div>
          )
        })}
      </div>
    </li>
  )
}

type Hover = { image: string; landscape: boolean; right: boolean; foil?: boolean } | null
// What a click on the board means now: choosing a target for an attack, or a unit for an upgrade
// How a card is played: using Smuggle, from the discard pile, for a Spice token instead of its cost
type Way = { smuggle?: boolean; discard?: boolean; spice?: boolean }
type Mode = { kind: 'attack'; attacker: string } | ({ kind: 'attach'; card: string } & Way) | null

const cardBack = asset('/sim/DuneCardBack01.jpg')

// A speaker, with sound waves while the sound is on and a cross while it is off
function SoundIcon(props: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" />
      {props.on ? (
        <>
          <path d="M16.5 8.5a5 5 0 0 1 0 7" />
          <path d="M19.5 5.5a9 9 0 0 1 0 13" />
        </>
      ) : (
        <path d="M17 9l5 6M22 9l-5 6" />
      )}
    </svg>
  )
}

function Back() {
  return <div className="sim-back" style={{ backgroundImage: `url("${cardBack}")` }} />
}

// Drawing a card, the starting hand and a mulligan's included: each flies from the deck to its
// place in the hand, one after another, with a sound (The Chrome Grid's, from Kenney's CC0 packs)
const DRAW_STAGGER = 110
const DRAW_FLIGHT = 380
const SOUND_KEY = 'dune-unlimited.simulator.sound'
const drawSound = asset('/sim/sounds/card-draw.ogg')
const clickSound = asset('/sim/sounds/click.ogg')
// CCG Quest's Vanish puff
const vanishSound = asset('/sim/sounds/vanish.ogg')
// A pile's cards shown smaller the more there are of them, to fit the window
const pileSize = (count: number) => (count <= 6 ? 'large' : count <= 12 ? 'medium' : count <= 24 ? 'small' : 'tiny')

// The most Spice tokens a pile shows; more only change its count
const SPICE_PILE = 5
// Each token in the pile a little off the one under it, always the same, as a pile is: never
// further left than the gap to the base
const SPICE_SHIFT = [0, 0.6, -0.3, 0.9, 0.2]

// The puffs of smoke around a Hidden unit: where each sits (% of the card) and which way it drifts
const SMOKE = [
  { x: -12, y: -10, dx: 8, dy: 6 },
  { x: 50, y: -14, dx: -6, dy: 8 },
  { x: -18, y: 32, dx: 10, dy: -4 },
  { x: 62, y: 28, dx: -10, dy: 4 },
  { x: -10, y: 70, dx: 6, dy: -8 },
  { x: 55, y: 74, dx: -8, dy: -6 },
  { x: 20, y: 86, dx: 4, dy: -10 },
  { x: 22, y: 20, dx: -4, dy: 6 },
]

let soundOn = (() => {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off'
  } catch {
    return true
  }
})()

// cut: stop it after this long (ms), fading out, for a sound that runs on (an engine's loop)
function play(sound: string, volume: number, cut?: number) {
  if (!soundOn) return
  const audio = new Audio(sound)
  audio.volume = volume
  // A browser may refuse sound until the page has been clicked: silent, then
  audio.play().catch(() => {})
  if (cut) {
    const FADE = 300
    setTimeout(() => {
      const start = performance.now()
      const fade = () => {
        const left = 1 - (performance.now() - start) / FADE
        if (left <= 0) return audio.pause()
        audio.volume = volume * left
        requestAnimationFrame(fade)
      }
      fade()
    }, Math.max(0, cut - FADE))
  }
}
const playDraw = () => play(drawSound, 0.35)
// The Simulator's click, for the boosters too; off when its sound is
export const playClick = () => play(clickSound, 0.5)

// What clicking makes a sound: a button, or a card that can be played, used or picked
const clickable = 'button, .playable, .can-act, .target'

// One card's flight, drawn over the page: from one box to another, then gone
function fly(image: string, from: DOMRect, to: DOMRect) {
  const card = document.createElement('div')
  card.className = 'sim-flying'
  card.style.backgroundImage = `url("${image}")`
  const place = (box: DOMRect) => {
    card.style.left = `${box.left}px`
    card.style.top = `${box.top}px`
    card.style.width = `${box.width}px`
    card.style.height = `${box.height}px`
  }
  place(from)
  document.body.appendChild(card)
  // Laid out where it starts before it moves
  void card.offsetWidth
  card.classList.add('moving')
  place(to)
  return card
}

function Table(props: {
  set: SetCards
  // The game against the AI, in full; online, the game is the server's and only `online` shows it
  game?: GameState
  online?: OnlineTable
  // The Prescient copies' images, by card
  prescient: Record<string, string>
  onAct: (p: PlayerId, action: Action, why?: Weighed[]) => void
  // Taking back your last move, when there is one
  onUndo?: () => void
  onNew: () => void
  // Another game the same way, against the AI
  onAgain?: () => void
}) {
  const { set, game, online } = props
  // Your seat, at the bottom; watching, the first player's
  const ME: PlayerId = online?.seat ?? YOU
  const THEM: PlayerId = ME === 0 ? 1 : 0
  const watching = !!online?.watching
  const [mode, setMode] = useState<Mode>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [hover, setHover] = useState<Hover>(null)
  // On a small screen, the chat or the log slides over the board when opened
  const [panel, setPanel] = useState<'chat' | 'log' | null>(null)
  // The last card each player played, which the engine doesn't keep
  const [last, setLast] = useState<[string | null, string | null]>([null, null])
  const lastPlayed = online?.last ?? last
  const [chat, setChat] = useState<TableChat[]>([])
  // What you say, and the AI's answer to the usual things players say
  const say = (text: string) => {
    if (online) return online.say(text)
    setChat((now) => [...now, { who: 'me', text }])
    const reply = replyTo(text)
    if (reply) window.setTimeout(() => setChat((now) => [...now, { who: 'opp', text: reply }]), 800 + Math.random() * 1200)
  }
  const [sound, setSound] = useState(soundOn)
  // Leaving or conceding, asked before it is done
  const [asking, setAsking] = useState<'leave' | 'concede' | null>(null)
  // How many of each player's drawn cards have reached the hand; the others are on their way,
  // hidden in the hand until they land
  const [landed, setLanded] = useState<[number, number]>([0, 0])
  const landedNow = useRef(landed)
  landedNow.current = landed
  const [message, setMessage] = useState('')
  // A card clicked that can do more than one thing: what it can do, to choose from
  // A pile opened to see each card in it: your resources, face up, to play one using Smuggle,
  // or either discard pile
  const [pileOpen, setPileOpen] = useState<'resources' | 'discard-me' | 'discard-opp' | null>(null)
  // An open pile closes with a click anywhere outside it, or Escape
  const pileWindow = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!pileOpen) return
    const outside = (event: MouseEvent) => {
      if (!pileWindow.current?.contains(event.target as Node)) setPileOpen(null)
    }
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && setPileOpen(null)
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [pileOpen])
  const [menu, setMenu] = useState<{ card: string; landscape?: boolean; options: { label: string; run: () => void }[] } | null>(null)
  // A number asked for, picked from a list; the window of cards apart moves, and hides
  const [number, setNumber] = useState<{ key: string; id: string } | null>(null)
  const [choiceAt, setChoiceAt] = useState({ x: 0, y: 0 })
  const [choiceHidden, setChoiceHidden] = useState<string | null>(null)
  // Where each unit sits in its half of an arena, by id: it keeps its place as others come and
  // go, a new one taking the first free place in the front row (from the centre out), then in
  // the rows behind. How many fit in a row, by arena, from its width.
  const places = useRef(new Map<string, number>())
  const [perRow, setPerRow] = useState<Record<Arena, number>>({ ground: 6, space: 6 })
  const arenas = useRef(new Map<Arena, HTMLElement>())
  useEffect(() => {
    const measure = () => {
      const unit = window.innerHeight * 0.13 * 0.718
      const gap = window.innerWidth * 0.008
      const fit = (kind: Arena) => {
        const width = (arenas.current.get(kind)?.clientWidth ?? 0) - window.innerHeight * 0.02
        return Math.max(1, Math.floor((width + gap) / (unit + gap)))
      }
      setPerRow((now) => {
        const next = { ground: fit('ground'), space: fit('space') }
        return now.ground === next.ground && now.space === next.space ? now : next
      })
    }
    const observer = new ResizeObserver(measure)
    for (const el of arenas.current.values()) observer.observe(el)
    measure()
    return () => observer.disconnect()
  }, [])
  const drag = (event: React.MouseEvent) => {
    if (event.button !== 0 || (event.target as Element).closest('button, select, img')) return
    event.preventDefault()
    const from = { x: event.clientX - choiceAt.x, y: event.clientY - choiceAt.y }
    const move = (e: MouseEvent) => setChoiceAt({ x: e.clientX - from.x, y: e.clientY - from.y })
    const up = () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }

  // Each click on something that answers it clicks
  useEffect(() => {
    const click = (event: MouseEvent) => {
      if ((event.target as Element | null)?.closest?.(clickable)) play(clickSound, 0.5)
    }
    document.addEventListener('click', click, true)
    return () => document.removeEventListener('click', click, true)
  }, [])

  const view = useMemo(() => online?.view ?? viewFor(game!, ME), [game, online?.view])
  // Each card by its id: the set's, and the game's (its tokens too)
  const setDefs = useMemo(() => Object.fromEntries(set.defs.map((d) => [d.id, d])), [set])
  // The names of the cards in this game, to find in the log: each name's card, one in a
  // player's deck before another of that name, and a pattern that finds them, longest first
  const cardNames = useMemo(() => {
    // Online, the cards seen so far stand for those in the decks
    const decks = new Set(
      game
        ? game.players.flatMap((pl) => [pl.leader, pl.base, ...pl.deck, ...pl.hand, ...pl.discard, ...pl.units, ...pl.resources.map((r) => r.card)].map((c) => c.def))
        : Object.keys(view.defs),
    )
    const byName = new Map<string, string>()
    for (const d of Object.values({ ...setDefs, ...(game?.defs ?? view.defs) })) if (!byName.has(d.name) || decks.has(d.id)) byName.set(d.name, d.id)
    const names = [...byName.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    return { byName, pattern: new RegExp(`(?<![\\w'])(${names.join('|')})(?![\\w'])`) }
  }, [game?.defs, game?.players, online ? view.defs : null, setDefs])
  const me = view.players[ME]
  const opp = view.players[THEM]

  // A unit that goes Hidden vanishes in a puff
  const hiddenUnits = view.players.flatMap((side) => side.units.filter((u) => u.hidden).map((u) => u.id))
  const wasHidden = useRef<string[]>(hiddenUnits)
  useEffect(() => {
    if (hiddenUnits.some((id) => !wasHidden.current.includes(id))) play(vanishSound, 0.6)
    wasHidden.current = hiddenUnits
  })
  const defOf = (id: string) => game?.defs[id] ?? view.defs[id] ?? setDefs[id]
  const mine = !watching && view.waitingFor.includes(ME)
  // A question an ability asks you: what you may pick, on the board or among cards shown apart
  const asked = view.prompt && 'options' in view.prompt && view.prompt.player === ME ? view.prompt : null
  const boardIds = new Set([...me.units, ...opp.units].map((u) => u.id).concat('base0', 'base1'))
  const askedOn = (id: string) => !!asked && asked.kind === 'pick' && asked.options.some((o) => o.id === id)
  // Cards in your hand are picked there, red for a discard
  const handIds = new Set(me.hand?.map((c) => c.id))
  // A deck searched shows every card looked at, those you may take framed green
  const shown: { id: string; label?: string; def?: string; can?: boolean }[] =
    asked?.kind !== 'pick'
      ? []
      : asked.seen
        ? asked.seen.map((c) => ({ ...c, can: askedOn(c.id) }))
        : asked.options.filter((o) => !boardIds.has(o.id) && !handIds.has(o.id))
  const harmful = !!asked && /discard/i.test(asked.text)
  // A question about a card off the board is asked beside it, apart from the board
  const apart = !!shown.length || !!asked?.card || !!menu
  // Every question you're asked is in the window that moves, a pick on the board too (an Ambush's
  // target): the board stays clickable, and the window says what for
  const windowed = apart || !!asked
  // Who goes first and the mulligan are asked big, in the middle of the board
  const setup = !view.prompt && (view.phase === 'first' || view.phase === 'mulligan')

  const act = (p: PlayerId, action: Action, why?: Weighed[]) => {
    if (action.type === 'play' && game) {
      const card = game.players[p].hand.find((c) => c.id === action.card)
      if (card) setLast((now) => (p === 0 ? [card.def, now[1]] : [now[0], card.def]))
    }
    props.onAct(p, action, why)
    // What you had picked stays while the AI acts, as in the setup resources chosen at once
    if (p === ME) {
      setMode(null)
      setPicked([])
      setMenu(null)
      setPileOpen(null)
    }
    // The hovered card may leave the board without a mouseleave
    setHover(null)
  }
  // Your last move taken back, and what you had begun choosing with it
  const undo = () => {
    setMode(null)
    setPicked([])
    setMenu(null)
    props.onUndo?.()
  }
  const can = (action: Action) => view.actions.some((a) => sameAction(a, action))
  // The play that attaches a card to a unit, played the way chosen, among those the engine allows
  const sameWay = (a: Way, b: Way) => !!a.smuggle === !!b.smuggle && !!a.discard === !!b.discard && !!a.spice === !!b.spice
  const attachAction = (attach: { card: string } & Way, unit: string): Action =>
    view.actions.find((a) => a.type === 'play' && a.card === attach.card && a.attachTo === unit && sameWay(a, attach)) ?? {
      type: 'play',
      card: attach.card,
      attachTo: unit,
    }

  // By seat, as the cards landed are
  const coming = view.players.map((side, p) => Math.min(side.handCount, side.drawn - landed[p]))
  // Each card drawn and not yet landed flies in, in the order drawn. Measured before the page is
  // painted, the hidden cards already holding their places in the hand.
  useLayoutEffect(() => {
    const timers: number[] = []
    const flying: HTMLElement[] = []
    const seats = [ME, THEM] as const
    let delay = 0
    for (const p of seats) {
      const side = view.players[p]
      const who = p === ME ? 'me' : 'opp'
      const deck = document.querySelector(`.sim-strip.${who} .sim-pile.deck`)
      const slots = [...document.querySelectorAll<HTMLElement>(`.sim-strip.${who} [data-arriving]`)]
      const pending = side.drawn - landedNow.current[p]
      for (let i = 0; i < pending; i++) {
        const slot = slots[slots.length - pending + i]
        const land = () => setLanded((now) => (p === 0 ? [now[0] + 1, now[1]] : [now[0], now[1] + 1]))
        timers.push(
          window.setTimeout(() => {
            if (!deck || !slot) return land()
            const image = slot.dataset.image ? img(slot.dataset.image) : cardBack
            // In a fanned hand the card's image is wider than its slot
            const target = (slot.querySelector('img') ?? slot).getBoundingClientRect()
            const card = fly(image, deck.getBoundingClientRect(), target)
            flying.push(card)
            playDraw()
            timers.push(
              window.setTimeout(() => {
                card.remove()
                land()
              }, DRAW_FLIGHT),
            )
          }, delay),
        )
        delay += DRAW_STAGGER
      }
    }
    // Started over, or the table left: what is in the air goes, to fly again if still to land
    return () => {
      for (const timer of timers) clearTimeout(timer)
      for (const card of flying) card.remove()
    }
  }, [me.drawn, opp.drawn])

  // The AI takes its turn after a moment
  useEffect(() => {
    if (!game || online || game.phase === 'over' || !view.waitingFor.includes(THEM)) return
    const timer = setTimeout(() => {
      const why: Weighed[] = []
      const action = chooseAction(game!, THEM, why)
      // The moves it weighed best kept with the game, to see why it did what it did
      if (action) act(THEM, action, why.slice(0, 3))
    }, AI_DELAY)
    return () => clearTimeout(timer)
  }, [game])

  const look = (image: string | undefined, landscape = false, foil = false) => (event: React.MouseEvent) =>
    image && setHover({ image, landscape, right: event.clientX < window.innerWidth / 2, foil })
  const leave = () => setHover(null)
  const imageOf = (id: string, unitSide = false) => {
    const images = set.images[id]
    return unitSide ? (images?.back ?? images?.image) : images?.image
  }
  // One copy of a card as it looks: Prescient in full art (once drawn), a foil with its sheen
  const printingOf = (id: string) => view.printings?.[id]
  const faceOf = (card: { id: string; def: string }) =>
    (isPrescient(printingOf(card.id)) && props.prescient[card.def]) || imageOf(card.def)
  const foil = (id: string) => isFoil(printingOf(id))
  const lookAt = (card: { id: string; def: string }) => look(faceOf(card), false, foil(card.id))

  // What the phase asks of you, and the buttons that answer it (always at the bottom right)
  const pickCount = asked ? 0 : mine && view.phase === 'resource' ? Math.min(2, me.handCount) : mine && view.phase === 'regroup' ? 1 : 0
  // The cards picked from the hand, by name: "Chani and Fremen Worm Riders"
  const pickedNames = picked.map((id) => defOf(me.hand?.find((c) => c.id === id)?.def ?? '')?.name ?? '').join(' and ')
  const attackActions = view.actions.filter((a) => a.type === 'attack')
  const attacker = mode?.kind === 'attack' ? me.units.find((u) => u.id === mode.attacker) : undefined
  const attachCard =
    mode?.kind === 'attach'
      ? (me.hand?.find((c) => c.id === mode.card) ?? me.resources.find((r) => r.card?.id === mode.card)?.card ?? undefined)
      : undefined
  const isTarget = (target: string) =>
    asked
      ? askedOn(target)
      : mode?.kind === 'attack'
      ? can({ type: 'attack', attacker: mode.attacker, target })
      : mode?.kind === 'attach'
        ? can(attachAction(mode, target))
        : false

  let prompt = ''
  let buttons: { label: string; kind?: string; onClick?: () => void; disabled?: boolean }[] = []
  let numbers: { value: string; options: { id: string; label: string }[]; onChange: (id: string) => void } | null = null
  const askedKey = asked ? `${asked.source ?? ''}|${asked.text}|${asked.options.map((o) => o.id).join(',')}` : ''
  // Watching, each player waited for is named
  const waited = watching ? view.waitingFor.map((p) => view.players[p].name).join(' and ') : opp.name
  const waitText =
    online?.notice ?? `${waited} ${watching && view.waitingFor.length > 1 ? 'are' : 'is'} ${view.phase === 'action' ? 'choosing an action' : 'deciding'}…`
  const answer = (picks: string[]) => act(ME, { type: 'answer', picks })
  const pickAnswer = (id: string) => {
    if (!asked) return
    if (asked.max === 1 && asked.min <= 1) return answer([id])
    setPicked((now) => (now.includes(id) ? now.filter((i) => i !== id) : now.length < asked.max ? [...now, id] : now))
  }
  // The card that asks, unless its question already starts with its name
  const askText = (prompt: { source?: string; text: string }) => {
    const name = prompt.source && view.defs[prompt.source]?.name
    return name && !prompt.text.startsWith(name) ? `${name}: ${prompt.text}` : prompt.text
  }
  if (view.prompt && !asked) {
    prompt = `${opp.name} is choosing…`
  } else if (asked?.kind === 'option' && asked.options.length > 2 && asked.options.every((o) => /^\d/.test(o.label ?? o.id))) {
    // How many: a list of the numbers, and Confirm
    prompt = askText(asked)
    const chosen = number?.key === askedKey && asked.options.some((o) => o.id === number.id) ? number.id : asked.options[0].id
    numbers = {
      value: chosen,
      options: asked.options.map((o) => ({ id: o.id, label: o.label ?? o.id })),
      onChange: (id) => setNumber({ key: askedKey, id }),
    }
    buttons = [{ label: 'Confirm', kind: 'go', onClick: () => answer([chosen]) }]
  } else if (asked?.kind === 'option') {
    prompt = askText(asked)
    buttons = asked.options.map((o, i) => ({
      label: o.label ?? o.id,
      kind: i === asked.options.length - 1 ? 'go' : undefined,
      onClick: () => answer([o.id]),
    }))
  } else if (asked) {
    const count = asked.max > 1 ? ` (${picked.length}/${asked.max})` : ''
    prompt = askText(asked) + count
    buttons = [
      ...(asked.min === 0 ? [{ label: asked.max === 0 ? 'OK' : asked.max === 1 ? 'Skip' : 'None', onClick: () => answer([]) }] : []),
      ...(asked.max > 1 || asked.min > 1
        ? [{ label: 'Done', kind: 'go', disabled: picked.length < asked.min || !picked.length, onClick: () => answer(picked) }]
        : []),
    ]
  } else switch (view.phase) {
    case 'first':
      prompt = mine ? 'You decide who goes first' : `${opp.name} decides who goes first…`
      buttons = [
        { label: 'Go second', disabled: !mine, onClick: () => act(ME, { type: 'first', goFirst: false }) },
        { label: 'Go first', kind: 'go', disabled: !mine, onClick: () => act(ME, { type: 'first', goFirst: true }) },
      ]
      break
    case 'mulligan':
      prompt = mine ? 'Keep your starting hand?' : waitText
      buttons = [
        { label: 'Mulligan', disabled: !mine, onClick: () => act(ME, { type: 'mulligan', take: true }) },
        { label: 'Keep', kind: 'go', disabled: !mine, onClick: () => act(ME, { type: 'mulligan', take: false }) },
      ]
      break
    case 'resource':
      prompt = !mine
        ? waitText
        : picked.length === pickCount
          ? `Resourcing ${pickedNames}: done choosing?`
          : `Choose ${pickCount} cards to resource (${picked.length}/${pickCount})${picked.length ? `: ${pickedNames}` : ''}`
      buttons = [
        {
          label: 'Done Choosing Resources',
          kind: 'go',
          disabled: !mine || picked.length !== pickCount,
          onClick: () => act(ME, { type: 'resource', cards: picked }),
        },
      ]
      break
    case 'regroup':
      prompt = !mine ? waitText : picked.length ? `Regroup: resource ${pickedNames}?` : 'Regroup: choose a card to resource, or skip'
      buttons = [
        { label: 'Skip', disabled: !mine, onClick: () => act(ME, { type: 'resource', cards: [] }) },
        {
          label: picked.length ? 'Resource It' : 'Resource',
          kind: 'go',
          disabled: !mine || picked.length !== 1,
          onClick: () => act(ME, { type: 'resource', cards: picked }),
        },
      ]
      break
    case 'action':
      if (!mine) {
        prompt = waitText
      } else if (attacker) {
        prompt = `Choose a target for ${defOf(attacker.def).name}`
      } else if (attachCard) {
        prompt = `Choose ${defOf(attachCard.def).keywords.fortify ? 'your base' : 'a unit'} for ${defOf(attachCard.def).name}`
      } else {
        prompt = 'Your turn: play a card, attack or pass'
      }
      buttons = mode
        ? [{ label: 'Cancel', onClick: () => setMode(null) }]
        : [
            { label: 'Pass', kind: 'pass', disabled: !mine, onClick: () => act(ME, { type: 'pass' }) },
            {
              label: 'Claim Initiative',
              kind: 'claim',
              disabled: !can({ type: 'initiative' }),
              onClick: () => act(ME, { type: 'initiative' }),
            },
          ]
      break
  }
  // A question the action may be taken back from
  if (asked?.cancel) buttons = [{ label: 'Cancel', onClick: () => act(ME, { type: 'cancel' }) }, ...buttons]
  const numberList = numbers && (
    <select className="sim-number" value={numbers.value} onChange={(e) => numbers?.onChange(e.target.value)}>
      {numbers.options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  )

  // What a card on the table can do, clicked: its Action abilities, and a leader's deploy or a
  // unit's attack. One is done at once; more are offered to choose from.
  const abilitiesOf = (source: string) =>
    !mode && !asked
      ? view.abilities.filter((a) => a.source === source).map((a) => ({ label: a.label, run: () => act(ME, { type: 'ability', source, index: a.index }) }))
      : []
  const offer = (card: string, options: { label: string; run: () => void }[], landscape?: boolean) => {
    if (options.length === 1) options[0].run()
    else if (options.length) setMenu({ card, landscape, options })
  }
  const leaderOptions = () => [
    ...abilitiesOf('leader'),
    ...(!mode && !asked && can({ type: 'deploy' }) ? [{ label: 'Deploy Leader', run: () => act(ME, { type: 'deploy' }) }] : []),
  ]
  const unitOptions = (id: string) => [
    ...(!mode && !asked && attackActions.some((a) => a.type === 'attack' && a.attacker === id)
      ? [{ label: 'Attack', run: () => setMode({ kind: 'attack', attacker: id }) }]
      : []),
    ...abilitiesOf(id),
  ]

  const playsOf = (id: string) => view.actions.filter((a) => a.type === 'play' && a.card === id)
  // Playing a card from wherever it is: a unit or event at once, an upgrade once its unit is
  // chosen. A card that can be played more than one way (paying, or for a Spice token) asks how.
  const playCard = (id: string) => {
    if (mode || asked || pickCount) return
    const ways: Way[] = []
    for (const a of playsOf(id)) if (a.type === 'play' && !ways.some((w) => sameWay(w, a))) ways.push(a)
    const playWay = (way: Way) => {
      const plays = playsOf(id).filter((a) => a.type === 'play' && sameWay(a, way))
      if (plays.some((a) => a.type === 'play' && a.attachTo))
        setMode({ kind: 'attach', card: id, ...(way.smuggle && { smuggle: true }), ...(way.discard && { discard: true }), ...(way.spice && { spice: true }) })
      else act(ME, plays[0])
    }
    const card = [...(me.hand ?? []), ...me.discard, ...me.resources.flatMap((r) => (r.card ? [r.card] : []))].find((c) => c.id === id)
    if (ways.length > 1 && card)
      setMenu({
        card: card.def,
        options: ways.map((way) => ({ label: way.spice ? 'Play it for a Spice token' : 'Pay for it', run: () => playWay(way) })),
      })
    else if (ways.length) playWay(ways[0])
  }
  const clickHand = (id: string) => {
    if (asked) {
      if (askedOn(id)) pickAnswer(id)
      // "Play it now?": the card answers yes
      else if (asked.play?.card === id) answer(['yes'])
      return
    }
    if (pickCount) {
      setPicked((now) => (now.includes(id) ? now.filter((i) => i !== id) : now.length < pickCount ? [...now, id] : now))
      return
    }
    playCard(id)
  }
  const clickUnit = (id: string) => {
    if (asked) {
      if (askedOn(id)) pickAnswer(id)
    } else if (mode && isTarget(id)) {
      act(ME, mode.kind === 'attack' ? { type: 'attack', attacker: mode.attacker, target: id } : attachAction(mode, id))
    } else if (mode?.kind === 'attack' && mode.attacker === id) {
      setMode(null)
    } else if (!mode) {
      const unit = me.units.find((u) => u.id === id)
      if (unit) offer(unit.def, unitOptions(id))
    }
  }
  const clickBase = (id: string) => {
    if (asked) return askedOn(id) && pickAnswer(id)
    if (id === 'base' && mode?.kind === 'attack' && isTarget('base')) act(ME, { type: 'attack', attacker: mode.attacker, target: 'base' })
    else if (mode?.kind === 'attach' && isTarget(id)) act(ME, attachAction(mode, id))
  }

  const unitView = (side: SideView, arena: Arena) => (u: SideView['units'][number]) => {
    const d = defOf(u.def)
    const tokenCount = (name: string) => u.upgrades.filter((up) => defOf(up.def).token && defOf(up.def).name === name).length
    const [experience, weakness, shields] = [tokenCount('Experience'), tokenCount('Weakness'), tokenCount('Shield')]
    const banners = u.upgrades.filter((up) => !(defOf(up.def).token && ['Experience', 'Weakness', 'Shield'].includes(defOf(up.def).name)))
    const keywords = u.keywords
    const printed = u.leader ? d.unit : d
    const target = isTarget(u.id)
    const ours = side === me
    const chosen = asked && picked.includes(u.id)
    const ready = ours && unitOptions(u.id).length > 0
    const classes = [
      'sim-unit',
      u.exhausted && 'exhausted',
      target && 'target',
      chosen && 'chosen',
      mode?.kind === 'attack' && !ours && arena === attacker?.arena && !target && 'blocked',
      attacker?.id === u.id && 'attacker',
      ready && 'can-act',
      u.hidden && 'hidden',
      // A blue aura while it has a Shield token, stronger with two or more
      shields > 0 && 'shielded',
      shields > 1 && 'shielded-more',
    ]
    const tags = [
      keywords.sentinel && 'Sentinel',
      keywords.saboteur && 'Saboteur',
      keywords.overwhelm && 'Overwhelm',
      keywords.grit && 'Grit',
      // Ambush and Hidden only count the phase it entered play
      keywords.ambush && u.entered === view.phaseCount && 'Ambush',
      u.hidden && 'Hidden',
      keywords.raid && `Raid ${keywords.raid}`,
      keywords.restore && `Restore ${keywords.restore}`,
    ].filter(Boolean)
    const image = u.leader ? imageOf(u.def, true) : faceOf(u)
    return (
      <div key={u.id} className={`sim-unit-slot${u.exhausted ? ' exhausted' : ''}`}>
        <button
          type="button"
          className={[...classes, foil(u.id) && 'sim-foil'].filter(Boolean).join(' ')}
          onMouseEnter={look(image, false, foil(u.id))}
          onMouseLeave={leave}
          onClick={() => clickUnit(u.id)}
        >
          <img src={img(image ?? '')} alt={d.name} />
          {u.hidden && (
            <span className="sim-smoke" aria-hidden="true" title="Hidden: it can't be attacked this phase">
              {SMOKE.map((puff, i) => (
                <i
                  key={i}
                  style={
                    {
                      left: `${puff.x}%`,
                      top: `${puff.y}%`,
                      '--dx': `${puff.dx}%`,
                      '--dy': `${puff.dy}%`,
                      animationDelay: `${-i * 0.9}s`,
                    } as React.CSSProperties
                  }
                />
              ))}
            </span>
          )}
          {/* What lies on the card, turned with it when it is exhausted: its power and HP now,
              larger than the printed ones they cover (hovered, the card shows them as printed),
              green when raised, red when lowered; its keywords; its tokens */}
          <span className="sim-face" aria-hidden="true">
            {!!tags.length && (
              <span className={`sim-tags${aspectClass(d.aspects)}`}>
                {tags.map((tag) => (
                  <span key={tag as string}>{tag}</span>
                ))}
              </span>
            )}
            {/* Top left: its Shield tokens */}
            {!!shields && (
              <span className="sim-shields" title={`${shields} Shield token${shields > 1 ? 's' : ''}`}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Z" />
                </svg>
                {shields}
              </span>
            )}
            {/* Top right: +1 for each Experience token, and to its left -1 for each Weakness token */}
            {!!(experience || weakness) && (
              <span className="sim-xp">
                {!!weakness && <i className="down">-{weakness}</i>}
                {!!experience && <i>+{experience}</i>}
              </span>
            )}
            <span className={`sim-stat power${statShift(u.power, printed?.power)}`}>
              <b>{u.power}</b>
            </span>
            <span className={`sim-stat hp${statShift(u.hp, printed?.hp)}`}>
              <b>{u.hp}</b>
            </span>
          </span>
          {!!u.damage && <span className="sim-damage">{u.damage}</span>}
        </button>
        {/* Its upgrades, banners tucked under the card's bottom edge as it lies, ready or
            exhausted, each hoverable for the full card. Experience and Weakness tokens are the
            badge above it, Shield tokens the badge at its top left. */}
        {!!banners.length && (
          <span className="sim-upgrades">
            {banners.map((up, i) => (
              <span
                key={up.id}
                className={defOf(up.def).token ? `token ${defOf(up.def).name.toLowerCase()}` : aspectClass(defOf(up.def).aspects).trim() || undefined}
                style={{ zIndex: 9 - i }}
                onMouseEnter={lookAt(up)}
                onMouseLeave={leave}
              >
                {defOf(up.def).name}
              </span>
            ))}
          </span>
        )}
      </div>
    )
  }

  // One player's row of discard, deck, resources and hand; the opponent's is the same, mirrored
  const strip = (side: SideView, who: 'me' | 'opp') => {
    const arriving = coming[who === 'me' ? ME : THEM]
    const top = side.discard[side.discard.length - 1]
    const ready = side.resources.filter((r) => !r.exhausted).length
    // A card in your discard pile you can play now (Crysknife, The Sleeper Has Awakened)
    const playable = who === 'me' && !mode && !asked && !pickCount && side.discard.some((c) => playsOf(c.id).length > 0)
    return (
      <div className={`sim-strip ${who}`}>
        <div
          className={['sim-pile', top && 'open', playable && 'playable', top && foil(top.id) && 'sim-foil'].filter(Boolean).join(' ')}
          title={playable ? 'Discard pile: a card in it can be played' : top ? 'Discard pile: click to see it' : 'Discard pile'}
          onClick={top ? () => setPileOpen(who === 'me' ? 'discard-me' : 'discard-opp') : undefined}
        >
          {top ? (
            <img src={img(faceOf(top) ?? '')} alt={defOf(top.def).name} onMouseEnter={lookAt(top)} onMouseLeave={leave} />
          ) : (
            <div className="sim-empty">Discard</div>
          )}
          <span className="sim-count">{side.discard.length}</span>
        </div>
        <div className="sim-pile deck" title="Deck">
          {side.topCard ? (
            <img
              src={img(faceOf(side.topCard) ?? '')}
              alt={defOf(side.topCard.def).name}
              title="The top card of your deck"
              onMouseEnter={lookAt(side.topCard)}
              onMouseLeave={leave}
            />
          ) : side.deckCount ? (
            <Back />
          ) : (
            <div className="sim-empty">Deck</div>
          )}
          <span className="sim-count">{side.deckCount}</span>
        </div>
        <div
          className={`sim-resources${who === 'me' ? ' open' : ''}`}
          title={`${ready} of ${side.resources.length} resources ready${who === 'me' ? ': click to see them' : ''}`}
          onClick={who === 'me' ? () => setPileOpen('resources') : undefined}
        >
          <div className="sim-resource-cards">
            {side.resources.map((r, i) => {
              const smuggle = !!r.card && who === 'me' && !mode && !asked && !pickCount && playsOf(r.card.id).length > 0
              return (
                <div
                  key={i}
                  className={['sim-resource', r.exhausted && 'used', smuggle && 'playable'].filter(Boolean).join(' ')}
                  onMouseEnter={r.card ? lookAt(r.card) : undefined}
                  onMouseLeave={leave}
                >
                  <Back />
                </div>
              )
            })}
          </div>
          <span className="sim-resource-count">
            {ready}/{side.resources.length}
          </span>
        </div>
        <div className="sim-hand">
          {side.hand
            ? side.hand.map((c, i) => (
                <button
                  key={c.id}
                  type="button"
                  data-arriving={i >= side.hand!.length - arriving || undefined}
                  data-image={faceOf(c)}
                  className={[
                    'sim-hand-card',
                    !pickCount && !mode && !asked && playsOf(c.id).length && 'playable',
                    askedOn(c.id) && (harmful ? 'asked harm' : 'asked'),
                    asked?.play?.card === c.id && 'asked',
                    picked.includes(c.id) && 'picked',
                    mode?.kind === 'attach' && mode.card === c.id && 'picked',
                    pickCount && 'pickable',
                    foil(c.id) && 'sim-foil',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onMouseEnter={lookAt(c)}
                  onMouseLeave={leave}
                  onClick={() => clickHand(c.id)}
                >
                  <img src={img(faceOf(c) ?? '')} alt={defOf(c.def).name} />
                  {priceBadge(c.id, defOf(c.def).cost)}
                </button>
              ))
            : Array.from({ length: side.handCount }, (_, i) => (
                <div key={i} className="sim-hand-back" data-arriving={i >= side.handCount - arriving || undefined}>
                  <Back />
                </div>
              ))}
          {!side.hand && <span className="sim-count hand">{side.handCount}</span>}
        </div>
        {who === 'me' && !watching && !windowed && !setup && (
          <div className="sim-actions">
            {/* First, so at the bottom: the move the game goes on with is on top */}
            {!online && (
              <button type="button" className="sim-button undo" disabled={!props.onUndo} title="Take back your last move (and the AI's since)" onClick={undo}>
                ↶ Undo
              </button>
            )}
            {numberList}
            {buttons.map((b, i) => (
              <button key={i} type="button" className={`sim-button ${b.kind ?? ''}`} disabled={b.disabled} onClick={b.onClick}>
                {b.label}
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  const leaderCard = (side: SideView) => {
    const image = imageOf(side.leader.def)
    const options = side === me ? leaderOptions() : []
    const classes = ['sim-landscape', 'leader', side.leader.deployed && 'deployed', side.leader.exhausted && 'exhausted', options.length && 'can-act']
    return (
      <button
        type="button"
        className={classes.filter(Boolean).join(' ')}
        title={side.leader.deployed ? 'Deployed' : options.map((o) => o.label).join(' or ') || undefined}
        onMouseEnter={look(image, true)}
        onMouseLeave={leave}
        onClick={options.length ? () => offer(side.leader.def, options, true) : undefined}
      >
        <img src={img(image ?? '')} alt={defOf(side.leader.def).name} />
        {side.leader.deployed && <span className="sim-flag">Deployed</span>}
      </button>
    )
  }
  const baseCard = (side: SideView) => {
    const image = imageOf(side.base.def)
    const hp = defOf(side.base.def).hp
    const id = side === me ? `base${ME}` : `base${THEM}`
    // Your own base is a target for a Fortification being played
    const target = asked ? askedOn(id) : side === opp ? isTarget('base') : mode?.kind === 'attach' && isTarget(id)
    const forts = side.base.upgrades ?? []
    // Your Spice tokens are alike: their Action is used on the first one that can
    const spiceUse = side === me ? side.spice.flatMap((t) => abilitiesOf(t.id))[0] : undefined
    const spice = side.spice.length
    const spiceImage = spice ? imageOf(side.spice[0].def) : undefined
    const pile = Math.min(spice, SPICE_PILE)
    // A question that would defeat one of these Spice tokens: red, and clicked it says yes
    const spiceAsked =
      !!spice && !!asked && /defeat .*Spice tokens?/i.test(asked.text) && (/enemy/i.test(asked.text) ? side === opp : side === me)
    const spiceYes = spiceAsked && asked?.options.some((o) => o.id === 'yes') ? () => answer(['yes']) : undefined
    return (
      <div className="sim-base-slot">
        {/* Its Fortifications, tucked under its top edge: a banner with each one's name */}
        {!!forts.length && (
          <div className="sim-fortifications">
            {forts.map((f) => (
              <span key={f.id} className={`sim-fortification${aspectClass(defOf(f.def).aspects)}`} onMouseEnter={lookAt(f)} onMouseLeave={leave}>
                {defOf(f.def).name}
              </span>
            ))}
          </div>
        )}
        <button
          type="button"
          className={`sim-landscape base${target ? ' target' : ''}${asked && picked.includes(id) ? ' chosen' : ''}`}
          title={`${hp - side.base.damage} of ${hp} HP left`}
          onMouseEnter={look(image, true)}
          onMouseLeave={leave}
          onClick={() => clickBase(side === opp && !asked ? 'base' : id)}
        >
          <img src={img(image ?? '')} alt={defOf(side.base.def).name} />
          <span className="sim-base-hp">{hp - side.base.damage}</span>
          {!!side.base.damage && <span className="sim-damage big">{side.base.damage}</span>}
        </button>
        {/* The Spice tokens, a pile beside the base: up to 5 shown, the count on the top one */}
        {!!spice && (
          <div
            className={`sim-spice-pile${spiceAsked ? ' harm' : spiceUse ? ' can-act' : ''}`}
            // In full: a url() in a custom property is read from the stylesheet's folder, which the
            // site's relative paths (./showcase/…) would miss
            style={{ '--spice-art': `url("${new URL(set.spiceArt ?? img(spiceImage ?? ''), document.baseURI).href}")` } as React.CSSProperties}
            title={spiceUse ? `Spice: ${spiceUse.label}` : `${spice} Spice token${spice > 1 ? 's' : ''}`}
            onMouseEnter={look(spiceImage)}
            onMouseLeave={leave}
            onClick={spiceYes ?? spiceUse?.run}
          >
            {Array.from({ length: pile }, (_, i) => (
              <span key={i} className="sim-spice-token" style={{ '--i': i, '--shift': `${SPICE_SHIFT[i]}vh` } as React.CSSProperties}>
                {i === pile - 1 && <b>{spice}</b>}
              </span>
            ))}
          </div>
        )}
      </div>
    )
  }

  // One side's half of an arena: each unit in its place, the front row by the centre line
  const half = (side: SideView, kind: Arena, who: 'opp' | 'me') => {
    const row = perRow[kind]
    const units = side.units.filter((u) => u.arena === kind)
    const key = (id: string) => `${who}|${kind}|${id}`
    // The places of units gone are free again
    const taken = new Set<number>()
    for (const u of units) {
      const at = places.current.get(key(u.id))
      if (at !== undefined && !taken.has(at)) taken.add(at)
      else places.current.delete(key(u.id))
    }
    for (const u of units) {
      if (places.current.has(key(u.id))) continue
      let at = 0
      while (taken.has(at)) at++
      places.current.set(key(u.id), at)
      taken.add(at)
    }
    const rows = Math.max(1, ...units.map((u) => Math.floor(places.current.get(key(u.id))! / row) + 1))
    // From the centre out: the middle place, then one to its left, one to its right…
    const middle = Math.floor(row / 2)
    const column = (i: number) => middle + (i % 2 ? -(i + 1) / 2 : i / 2) + 1
    return (
      <div className={`sim-half ${who}`} style={{ gridTemplateColumns: `repeat(${row}, minmax(var(--uw), auto))` }}>
        {units.map((u) => {
          const at = places.current.get(key(u.id))!
          const r = Math.floor(at / row)
          return (
            <div key={u.id} className="sim-place" style={{ gridColumn: column(at % row), gridRow: who === 'me' ? r + 1 : rows - r }}>
              {unitView(side, kind)(u)}
            </div>
          )
        })}
      </div>
    )
  }
  const arena = (kind: Arena) => (
    <section
      className={`sim-arena ${kind}`}
      ref={(el) => {
        if (el) arenas.current.set(kind, el)
      }}
    >
      <span className="sim-arena-name">{kind}</span>
      {half(opp, kind, 'opp')}
      {half(me, kind, 'me')}
    </section>
  )

  const lastCard = (id: string | null, who: string) => (
    <div className="sim-last-card" title={`Last card ${who} played`}>
      {id ? (
        <img src={img(imageOf(id) ?? '')} alt={defOf(id).name} onMouseEnter={look(imageOf(id))} onMouseLeave={leave} />
      ) : (
        <div className="sim-empty">Last played</div>
      )}
    </div>
  )

  // What a card in your hand costs now, over its printed cost when that has changed: green when
  // less, red when more (aspects missing). A "play it now?" question shows the cost it offers.
  const priceBadge = (id: string, cost: number) => {
    const price = asked?.play?.card === id ? asked.play.cost : me.prices?.[id]
    if (price === undefined || price === cost) return null
    return (
      <span className={`sim-price ${price < cost ? 'less' : 'more'}`} title={`Costs ${price} now (printed ${cost})`}>
        {price}
      </span>
    )
  }

  // The cards a player revealed last, small, beside the last card they played, until they reveal others
  const revealedCards = (side: SideView, who: string) =>
    side.revealed && (
      <div className="sim-revealed" title={`Last revealed by ${who}, for ${defOf(side.revealed.by).name}`}>
        <span>Revealed</span>
        <div>
          {side.revealed.cards.map((card, i) => (
            <img key={i} src={img(imageOf(card) ?? '')} alt={defOf(card).name} onMouseEnter={look(imageOf(card))} onMouseLeave={leave} />
          ))}
        </div>
      </div>
    )

  // The AI's deck analysis, made as the game starts: its cards by cost, and the resources it aims
  // for (its leader's cost, or its dearest card's)
  // (made once: the same game's turns share it)
  const plan = game && !online ? deckPlan(game, THEM) : null
  const tallest = Math.max(1, ...(plan?.curve ?? []))
  const deckAnalysis = plan && (
    <section
      className="sim-plan"
      title={`${opp.name}'s deck: average cost ${plan.average.toFixed(1)}. Leader deploys at ${plan.leader}, dearest card ${plan.top}: it aims for ${plan.target} resources.`}
    >
      <h2>{opp.name}'s deck</h2>
      <div className="sim-curve">
        {plan.curve.map((count, cost) => (
          <div key={cost} className={cost === Math.min(plan.target, CURVE_TOP) ? 'target' : undefined}>
            <i>{count || ''}</i>
            <span style={{ height: `${(count / tallest) * 100}%` }} />
            <b>
              {cost}
              {cost === CURVE_TOP && '+'}
            </b>
          </div>
        ))}
      </div>
      <p>
        Average {plan.average.toFixed(1)} · aims for {plan.target} resources
      </p>
    </section>
  )

  // A log line: the player's name, where it starts with it, in their colour; each card named in
  // it shown when hovered
  const logLine = (text: string, player?: PlayerId) => {
    const name = player === undefined ? '' : view.players[player].name
    const named = !!name && text.startsWith(name)
    const rest = named ? text.slice(name.length) : text
    return (
      <>
        {named && <b className={player === ME ? 'me' : 'opp'}>{name}</b>}
        {rest.split(cardNames.pattern).map((part, i) => {
          const card = i % 2 ? cardNames.byName.get(part) : undefined
          if (!card) return part
          const image = imageOf(card)
          return (
            <span key={i} className="sim-log-card" onMouseEnter={look(image, defOf(card).type === 'leader' || defOf(card).type === 'base')} onMouseLeave={leave}>
              {part}
            </span>
          )
        })}
      </>
    )
  }

  // The pile opened: copies of a card stacked as one, with how many in its corner. A resource
  // stacks with those as ready as it, and as playable using Smuggle.
  type Stack = { key: string; def: string; id: string; count: number; used?: boolean; play?: () => void }
  const stack = (cards: { def: string; id: string; used?: boolean; play?: boolean }[]) => {
    const stacks: Stack[] = []
    for (const card of cards) {
      const key = `${card.def}|${!!card.used}|${!!card.play}|${printingOf(card.id) ?? ''}`
      const found = stacks.find((s) => s.key === key)
      if (found) found.count++
      else
        stacks.push({
          key,
          def: card.def,
          id: card.id,
          count: 1,
          used: card.used,
          play: card.play
            ? () => {
                setPileOpen(null)
                playCard(card.id)
              }
            : undefined,
        })
    }
    return stacks
  }
  const opened =
    pileOpen === 'resources'
      ? {
          title: `Your resources: ${me.resources.filter((r) => !r.exhausted).length} of ${me.resources.length} ready`,
          stacks: stack(
            me.resources.flatMap((r) =>
              r.card ? [{ ...r.card, used: r.exhausted, play: !mode && !asked && !pickCount && playsOf(r.card.id).length > 0 }] : [],
            ),
          ),
        }
      : pileOpen
        ? {
            title: pileOpen === 'discard-me' ? 'Your discard pile' : `${opp.name}'s discard pile`,
            stacks: stack(
              [...(pileOpen === 'discard-me' ? me : opp).discard]
                .reverse()
                .map((c) => ({ ...c, play: pileOpen === 'discard-me' && !mode && !asked && !pickCount && playsOf(c.id).length > 0 })),
            ),
          }
        : { title: '', stacks: [] }

  // The card that asks, named first in its question, and the card it asks about (the top card
  // of a deck): hovered, they are shown
  const asker = asked?.source ? defOf(asked.source) : undefined
  const about = asked?.card ? defOf(asked.card) : undefined
  const named = (card: CardDef) => (
    <b className="sim-asker" onMouseEnter={look(imageOf(card.id), card.type === 'leader' || card.type === 'base')} onMouseLeave={leave}>
      {card.name}
    </b>
  )
  const rest = asker && prompt.startsWith(asker.name) ? prompt.slice(asker.name.length) : prompt
  const at = about ? rest.indexOf(about.name) : -1
  const promptText = (
    <>
      {rest !== prompt && named(asker!)}
      {at < 0 ? (
        rest
      ) : (
        <>
          {rest.slice(0, at)}
          {named(about!)}
          {rest.slice(at + about!.name.length)}
        </>
      )}
    </>
  )

  const result =
    view.winner === null
      ? ''
      : view.winner === 'draw'
        ? 'Draw'
        : watching
          ? `${view.players[view.winner].name} wins`
          : view.winner === ME
            ? 'Victory'
            : 'Defeat'

  return (
    <>
      <div className="sim-panel-toggles">
        {(['chat', 'log'] as const).map((which) => (
          <button key={which} type="button" className={`sim-panel-toggle ${which}`} aria-pressed={panel === which} onClick={() => setPanel(panel === which ? null : which)}>
            {which === 'chat' ? 'Chat' : 'Log'}
          </button>
        ))}
      </div>
      <div className="sim-turn-hint">Turn your phone sideways to play</div>
      <aside className={`sim-chat${panel === 'chat' ? ' open' : ''}`}>
        <h2>Chat</h2>
        <div className="sim-messages">
          {(online?.chat ?? chat).map((m, i) => (
            <p key={i} className={m.who}>
              <b>{m.name ?? (m.who === 'me' ? 'You' : opp.name)}:</b> {m.text}
            </p>
          ))}
        </div>
        {watching ? (
          <p className="sim-note">Watching: only the players can chat.</p>
        ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (!message.trim()) return
            say(message.trim())
            setMessage('')
          }}
        >
          <input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Say something" />
          <div className="sim-quick">
            {['gg', 'gl hf', 'thinking…', 'nice play'].map((text) => (
              <button key={text} type="button" onClick={() => say(text)}>
                {text}
              </button>
            ))}
          </div>
        </form>
        )}
      </aside>

      <div className="sim-board">
        {strip(opp, 'opp')}
        <div className="sim-play">
          {arena('space')}
          <div className="sim-centre">
            {leaderCard(opp)}
            {baseCard(opp)}
            <div className="sim-prompt">{prompt && !setup && <span>{windowed ? 'Choose…' : promptText}</span>}</div>
            {baseCard(me)}
            {leaderCard(me)}
          </div>
          {arena('ground')}
          {setup && (
            <div className="sim-setup">
              <p>{prompt}</p>
              {mine && (
                <div className="sim-setup-buttons">
                  {buttons.map((b) => (
                    <button key={b.label} type="button" className={`sim-button ${b.kind ?? ''}`} onClick={b.onClick}>
                      {b.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="sim-last">
            {lastCard(lastPlayed[THEM], opp.name)}
            {revealedCards(opp, opp.name)}
            <div className={`sim-initiative-track ${view.initiative === ME ? 'me' : 'opp'}`}>
              {/* No one holds it until the first player is chosen */}
              <span hidden={view.phase === 'first'} className={`sim-initiative${view.initiativeTaken ? ' taken' : ''}`} title={view.initiativeTaken ? 'Claimed this round' : undefined}>
                Initiative
              </span>
            </div>
            {revealedCards(me, 'you')}
            {lastCard(lastPlayed[ME], 'you')}
          </div>
        </div>
        {strip(me, 'me')}
      </div>

      <aside className={`sim-log${panel === 'log' ? ' open' : ''}`}>
        <div className="sim-tools">
          <span>Round {view.round}</span>
          <button
            type="button"
            className="sim-sound"
            title={sound ? 'Turn the sound off' : 'Turn the sound on'}
            aria-label={sound ? 'Turn the sound off' : 'Turn the sound on'}
            aria-pressed={!sound}
            onClick={() => {
              soundOn = !sound
              try {
                localStorage.setItem(SOUND_KEY, soundOn ? 'on' : 'off')
              } catch {
                // For this visit only, then
              }
              setSound(soundOn)
            }}
          >
            <SoundIcon on={sound} />
          </button>
          {!watching && (
            <button type="button" disabled={view.phase === 'over'} onClick={() => setAsking('concede')}>
              Concede
            </button>
          )}
          {/* Once the game is over there is nothing to lose by leaving */}
          <button type="button" onClick={() => (view.phase === 'over' || watching ? props.onNew() : setAsking('leave'))}>
            Leave
          </button>
        </div>
        {deckAnalysis}
        <h2>Log</h2>
        <ol ref={(list) => list?.scrollTo(0, list.scrollHeight)}>
          {view.log.map((entry, i) => (
            <li key={i} className={entry.player === undefined && /^Round /.test(entry.text) ? 'round' : undefined}>
              {logLine(entry.text, entry.player)}
            </li>
          ))}
        </ol>
      </aside>

      {pileOpen && (
        <div className="sim-choice sim-pile-window" ref={pileWindow}>
          <button type="button" className="sim-close" aria-label="Close" title="Close" onClick={() => setPileOpen(null)}>
            ×
          </button>
          <p>{opened.title}</p>
          <div className={`sim-choice-cards size-${pileSize(opened.stacks.length)}`}>
            {opened.stacks.map((stack) => (
              <button
                key={stack.key}
                type="button"
                className={[stack.play && 'playable', stack.used && 'used', foil(stack.id) && 'sim-foil'].filter(Boolean).join(' ') || undefined}
                title={stack.play ? (pileOpen === 'resources' ? 'Play it using Smuggle' : 'Play it from your discard pile') : stack.used ? 'Exhausted' : undefined}
                onMouseEnter={lookAt(stack)}
                onMouseLeave={leave}
                onClick={stack.play}
              >
                <img src={img(faceOf(stack) ?? '')} alt={defOf(stack.def).name} />
                {stack.count > 1 && (
                  <span className="sim-copies">
                    <span>{stack.count}</span>
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
      {menu && !asked && (
        // Moved like the other choices, and where they were last left
        <div
          className="sim-choice movable"
          style={{ transform: `translate(calc(-50% + ${choiceAt.x}px), calc(-50% + ${choiceAt.y}px))` }}
          onMouseDown={drag}
        >
          <p>{defOf(menu.card).name}: choose one</p>
          <div className="sim-choice-cards">
            <img
              className={menu.landscape ? 'landscape' : undefined}
              src={img(imageOf(menu.card) ?? '')}
              alt={defOf(menu.card).name}
              onMouseEnter={look(imageOf(menu.card), menu.landscape)}
              onMouseLeave={leave}
            />
          </div>
          <div className="sim-choice-buttons">
            <button type="button" className="sim-button" onClick={() => setMenu(null)}>
              Cancel
            </button>
            {menu.options.map((o) => (
              <button key={o.label} type="button" className="sim-button go" onClick={o.run}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {windowed && asked && choiceHidden === askedKey && (
        <button
          type="button"
          className="sim-button go sim-choice-reveal"
          style={{ transform: `translate(calc(-50% + ${choiceAt.x}px), calc(-50% + ${choiceAt.y}px))` }}
          onClick={() => setChoiceHidden(null)}
        >
          Reveal
        </button>
      )}
      {windowed && asked && choiceHidden !== askedKey && (
        <div
          className="sim-choice movable"
          style={{ transform: `translate(calc(-50% + ${choiceAt.x}px), calc(-50% + ${choiceAt.y}px))` }}
          onMouseDown={drag}
        >
          <p>{prompt}</p>
          <div className="sim-choice-cards">
            {asked.card && (
              <img src={img(imageOf(asked.card) ?? '')} alt={defOf(asked.card).name} onMouseEnter={look(imageOf(asked.card))} onMouseLeave={leave} />
            )}
            {/* A pick on the board: the card that asks, and what to click */}
            {!apart && asker && (
              <img src={img(imageOf(asker.id) ?? '')} alt={asker.name} onMouseEnter={look(imageOf(asker.id), asker.type === 'leader' || asker.type === 'base')} onMouseLeave={leave} />
            )}
            {shown.map((o) => {
              const image = o.def ? faceOf({ id: o.id, def: o.def }) : undefined
              return (
                <button
                  key={o.id}
                  type="button"
                  className={
                    [picked.includes(o.id) && 'picked', o.can && 'can-pick', o.can === false && 'cant-pick', foil(o.id) && 'sim-foil'].filter(Boolean).join(' ') ||
                    undefined
                  }
                  onMouseEnter={look(image, false, foil(o.id))}
                  onMouseLeave={leave}
                  onClick={() => o.can !== false && pickAnswer(o.id)}
                >
                  {image ? <img src={img(image)} alt={o.def ? defOf(o.def).name : ''} /> : <span>{o.label ?? o.id}</span>}
                </button>
              )
            })}
          </div>
          {!apart && asked.kind === 'pick' && (
            <p className="sim-choice-hint">
              {asked.max > 1 ? 'Click highlighted cards' : 'Click a highlighted card'}
              {asked.options.some((o) => boardIds.has(o.id)) ? ' on the board' : ' in your hand'}.
            </p>
          )}
          <div className="sim-choice-buttons">
            <button type="button" className="sim-button sim-choice-hide" onClick={() => setChoiceHidden(askedKey)}>
              Hide
            </button>
            {numberList}
            {buttons.map((b, i) => (
              <button key={i} type="button" className={`sim-button ${b.kind ?? ''}`} disabled={b.disabled} onClick={b.onClick}>
                {b.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {hover && (
        <div className={`sim-preview ${hover.right ? 'right' : 'left'}${hover.landscape ? ' landscape' : ''}${hover.foil ? ' sim-foil' : ''}`}>
          <img src={img(hover.image)} alt="" />
        </div>
      )}
      {asking && (
        <Modal title={asking === 'concede' ? 'Concede the game?' : 'Leave the game?'} onClose={() => setAsking(null)}>
          <p className="account-note">
            {asking === 'concede' || online
              ? `${opp.name} wins this game.`
              : 'The game ends here and can’t be picked up again.'}
          </p>
          <div className="leave-buttons">
            <button className="button" type="button" onClick={() => setAsking(null)}>
              Keep playing
            </button>
            <button
              className="button button-primary"
              type="button"
              onClick={() => {
                setAsking(null)
                if (asking === 'concede') act(ME, { type: 'concede' })
                else props.onNew()
              }}
            >
              {asking === 'concede' ? 'Concede' : 'Leave'}
            </button>
          </div>
        </Modal>
      )}
      {result && (
        <div className="sim-over">
          <div>
            <h2>{result}</h2>
            <p>{view.log[view.log.length - 1]?.text}</p>
            <div className="sim-over-actions">
              <button type="button" className="sim-button" onClick={props.onNew}>
                Back to the menu
              </button>
              {props.onAgain && (
                <button type="button" className="sim-button go" onClick={props.onAgain}>
                  Play again
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
