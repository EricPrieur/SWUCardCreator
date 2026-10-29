import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { asset } from './asset'
import { useAccount, type Session } from './api'
import { Modal } from './account'
import { loadAccountDecks } from './accountCards'
import { loadDecks, type Deck } from './cards'
import { chooseAction, CURVE_TOP, deckPlan } from '../server/engine/ai.ts'
import { cardDef, randomDeck, type SavedCard } from '../server/engine/cards.ts'
import { applyAction, createGame } from '../server/engine/game.ts'
import { scriptStatus } from '../server/engine/scripts.ts'
import { viewFor, type SideView } from '../server/engine/view.ts'
import type { Action, Arena, CardDef, GameState, PlayerId } from '../server/engine/types.ts'
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

const img = (image: string) => asset(`/showcase/${SET}/${image}.jpg`)

// The set's cards, and each one's images: its front and a leader's unit side. A two-sided
// base is two cards, its second side's id ending in BACK_SIDE, as the Deck Builder has it.
// spiceArt: the Spice token's art, its pile of spice shown on the tokens on the board
type SetCards = { defs: CardDef[]; images: Record<string, { image: string; back?: string }>; spiceArt?: string }
const BACK_SIDE = '#back'

async function loadSet(): Promise<SetCards> {
  const response = await fetch(asset(`/showcase/${SET}/showcase.json`))
  if (!response.ok) throw new Error(`The ${SET} set isn't exported`)
  const entries: { image: string; back?: string }[] = (await response.json()).cards
  const cards = await Promise.all(
    entries.map(async (entry) => {
      const saved = await fetch(asset(`/showcase/${SET}/${entry.image}.json`))
      return { entry, card: saved.ok ? ((await saved.json()) as SavedCard) : undefined }
    }),
  )
  const set: SetCards = { defs: [], images: {} }
  for (const { entry, card } of cards) {
    const d = card && cardDef(card)
    if (!d) continue
    set.defs.push(d)
    set.images[d.id] = { image: entry.image, back: entry.back }
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

async function loadSavedDecks(account: Session | null, set: SetCards): Promise<SavedDeck[]> {
  const lists = await Promise.all(
    deckSources.map(async ({ from, scope, key }) => {
      const decks = account ? await loadAccountDecks(account, scope).catch(() => [] as Deck[]) : loadDecks(key)
      return decks.map((deck) => ({ ...deck, from }))
    }),
  )
  const known = new Set(set.defs.map((d) => d.id))
  return lists
    .flat()
    .filter((deck) => deck.leader && deck.base && known.has(deck.leader) && known.has(deck.base))
    .filter((deck) => deckList(deck, set).deck.length)
}

// A deck as the engine takes it; cards that aren't in the set are left out
function deckList(deck: Deck, set: SetCards) {
  const playable = new Set(set.defs.filter((d) => ['unit', 'upgrade', 'event'].includes(d.type)).map((d) => d.id))
  return {
    leader: deck.leader as string,
    base: deck.base as string,
    deck: deck.cards.filter((entry) => playable.has(entry.id)).flatMap((entry) => Array(entry.count).fill(entry.id) as string[]),
  }
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
  const groups = deckSources.map(({ from }) => ({ from, decks: decks.filter((deck) => deck.from === from) }))
  const about: Record<string, string> = {
    'random-generated': `A random leader and base, with 50 cards of the ${SET} set they can pay for.`,
    random: decks.length ? 'One of your decks, picked at random.' : 'You have no decks yet: a random deck is made instead.',
    'different-random':
      decks.length > 1 ? 'One of your decks at random, not the one you play.' : 'One of your decks, picked at random.',
  }
  return (
    <div className={`sim-picker ${props.side}`}>
      <label>
        {props.title}
        <select value={value} onChange={(event) => props.onChange(event.target.value as Choice)}>
          <option value="random-generated">Create a Random Deck</option>
          {props.side === 'opp' && <option value="different-random">Different Random (any)</option>}
          <option value="random">Random (any)</option>
          {groups.map(
            (group) =>
              !!group.decks.length && (
                <optgroup key={group.from} label={group.from}>
                  {group.decks.map((deck) => (
                    <option key={deck.id} value={`deck:${deck.id}`}>
                      {deck.name}
                    </option>
                  ))}
                </optgroup>
              ),
          )}
        </select>
      </label>
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

export function Simulator() {
  const account = useAccount()
  const [view, setView] = useState<'ai' | 'online'>('ai')
  const [set, setSet] = useState<SetCards | null>(null)
  const [failed, setFailed] = useState('')
  const [decks, setDecks] = useState<SavedDeck[]>([])
  const [choices, setChoices] = useState<[Choice, Choice]>(rememberedChoices)
  const [game, setGame] = useState<GameState | null>(null)
  // Each game its own table, which starts with nothing drawn yet
  const [gameNumber, setGameNumber] = useState(0)

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
    const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)]
    let yours: Deck | undefined
    const resolve = (choice: Choice, side: number) => {
      let deck: Deck | undefined
      if (choice.startsWith('deck:')) deck = decks.find((d) => `deck:${d.id}` === choice)
      else if (choice === 'random' && decks.length) deck = pick(decks)
      else if (choice === 'different-random' && decks.length)
        deck = pick(decks.length > 1 ? decks.filter((d) => d !== yours) : decks)
      if (side === YOU) yours = deck
      return deck ? deckList(deck, set) : randomDeck(set.defs)
    }
    const lists = choices.map(resolve)
    const names = lists.map((list) => set.defs.find((d) => d.id === list.leader)?.name ?? 'Player')
    setGameNumber((n) => n + 1)
    setGame(
      createGame({
        seed: Date.now(),
        defs: set.defs,
        decks: lists.map((list, i) => ({
          // Named after their leaders, the AI's marked when both play the same one
          name: i === AI && names[1] === names[0] ? `${names[1]} (AI)` : names[i],
          ...list,
        })) as never,
      }),
    )
  }

  if (game && set) {
    return (
      <div className="sim">
        <Table key={gameNumber} set={set} game={game} onGame={setGame} onNew={() => setGame(null)} onAgain={start} />
      </div>
    )
  }

  // The cards whose text the engine plays, of those with text: a card changed in the Creator
  // since its script was written no longer counts
  const written = set ? set.defs.filter((d) => !d.token && scriptStatus(d) !== 'blank').length : 0
  const working = set ? set.defs.filter((d) => !d.token && scriptStatus(d) === 'scripted').length : 0

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
      {view === 'online' ? (
        <div className="sim-menu-panel">
          <p className="sim-wip">Work in progress: games against other players online are on the way.</p>
        </div>
      ) : failed || !set ? (
        <div className="sim-menu-panel">
          <p>{failed || `Loading the ${SET} cards…`}</p>
        </div>
      ) : (
        <div className="sim-menu-panel">
          <div className="sim-pickers">
            <DeckPicker title="Your Deck" side="me" value={choices[0]} decks={decks} set={set} onChange={(c) => choose(0, c)} />
            <DeckPicker title="AI Deck" side="opp" value={choices[1]} decks={decks} set={set} onChange={(c) => choose(1, c)} />
          </div>
          <p className="sim-note">
            {working < written
              ? `Cards play with their cost, power, HP and keywords. The text of ${working} of ${written} cards works so far; on the others it doesn't do anything yet.`
              : `Every card's text works, all ${written} of them.`}
          </p>
          <button type="button" className="sim-button go" onClick={start}>
            Start game
          </button>
        </div>
      )}
    </div>
  )
}

type Hover = { image: string; landscape: boolean; right: boolean } | null
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

const sameAction = (a: Action, b: Action) => JSON.stringify(a) === JSON.stringify(b)

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

function play(sound: string, volume: number) {
  if (!soundOn) return
  const audio = new Audio(sound)
  audio.volume = volume
  // A browser may refuse sound until the page has been clicked: silent, then
  audio.play().catch(() => {})
}
const playDraw = () => play(drawSound, 0.35)

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
  game: GameState
  onGame: (game: GameState) => void
  onNew: () => void
  onAgain: () => void
}) {
  const { set, game } = props
  const [mode, setMode] = useState<Mode>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [hover, setHover] = useState<Hover>(null)
  // The last card each player played, which the engine doesn't keep
  const [last, setLast] = useState<[string | null, string | null]>([null, null])
  const [chat, setChat] = useState<{ who: 'me' | 'opp'; text: string }[]>([])
  // What you say, and the AI's answer to the usual things players say
  const say = (text: string) => {
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

  // Each click on something that answers it clicks
  useEffect(() => {
    const click = (event: MouseEvent) => {
      if ((event.target as Element | null)?.closest?.(clickable)) play(clickSound, 0.5)
    }
    document.addEventListener('click', click, true)
    return () => document.removeEventListener('click', click, true)
  }, [])

  const view = useMemo(() => viewFor(game, YOU), [game])
  // The names of the cards in this game, to find in the log: each name's card, one in a
  // player's deck before another of that name, and a pattern that finds them, longest first
  const cardNames = useMemo(() => {
    const decks = new Set(
      game.players.flatMap((pl) => [pl.leader, pl.base, ...pl.deck, ...pl.hand, ...pl.discard, ...pl.units, ...pl.resources.map((r) => r.card)].map((c) => c.def)),
    )
    const byName = new Map<string, string>()
    for (const d of Object.values(game.defs)) if (!byName.has(d.name) || decks.has(d.id)) byName.set(d.name, d.id)
    const names = [...byName.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    return { byName, pattern: new RegExp(`(?<![\\w'])(${names.join('|')})(?![\\w'])`) }
  }, [game.defs, game.players])
  const me = view.players[YOU]
  const opp = view.players[AI]

  // A unit that goes Hidden vanishes in a puff
  const hiddenUnits = view.players.flatMap((side) => side.units.filter((u) => u.hidden).map((u) => u.id))
  const wasHidden = useRef<string[]>(hiddenUnits)
  useEffect(() => {
    if (hiddenUnits.some((id) => !wasHidden.current.includes(id))) play(vanishSound, 0.6)
    wasHidden.current = hiddenUnits
  })
  const defOf = (id: string) => game.defs[id]
  const mine = view.waitingFor.includes(YOU)
  // A question an ability asks you: what you may pick, on the board or among cards shown apart
  const asked = view.prompt && 'options' in view.prompt && view.prompt.player === YOU ? view.prompt : null
  const boardIds = new Set([...me.units, ...opp.units].map((u) => u.id).concat('base0', 'base1'))
  const askedOn = (id: string) => !!asked && asked.kind === 'pick' && asked.options.some((o) => o.id === id)
  // Cards in your hand are picked there, red for a discard
  const handIds = new Set(me.hand?.map((c) => c.id))
  const shown = asked?.kind === 'pick' ? asked.options.filter((o) => !boardIds.has(o.id) && !handIds.has(o.id)) : []
  const harmful = !!asked && /discard/i.test(asked.text)
  // A question about a card off the board is asked beside it, apart from the board
  const apart = !!shown.length || !!asked?.card || !!menu
  // Who goes first and the mulligan are asked big, in the middle of the board
  const setup = !view.prompt && (view.phase === 'first' || view.phase === 'mulligan')

  const act = (p: PlayerId, action: Action) => {
    if (action.type === 'play') {
      const card = game.players[p].hand.find((c) => c.id === action.card)
      if (card) setLast((now) => (p === 0 ? [card.def, now[1]] : [now[0], card.def]))
    }
    props.onGame(applyAction(game, p, action))
    // What you had picked stays while the AI acts, as in the setup resources chosen at once
    if (p === YOU) {
      setMode(null)
      setPicked([])
      setMenu(null)
      setPileOpen(null)
    }
    // The hovered card may leave the board without a mouseleave
    setHover(null)
  }
  const can = (action: Action) => view.actions.some((a) => sameAction(a, action))
  // In the engine's order of keys, which sameAction compares
  // The play that attaches a card to a unit, played the way chosen, among those the engine allows
  const sameWay = (a: Way, b: Way) => !!a.smuggle === !!b.smuggle && !!a.discard === !!b.discard && !!a.spice === !!b.spice
  const attachAction = (attach: { card: string } & Way, unit: string): Action =>
    view.actions.find((a) => a.type === 'play' && a.card === attach.card && a.attachTo === unit && sameWay(a, attach)) ?? {
      type: 'play',
      card: attach.card,
      attachTo: unit,
    }

  const coming = [me, opp].map((side, p) => Math.min(side.handCount, side.drawn - landed[p]))
  // Each card drawn and not yet landed flies in, in the order drawn. Measured before the page is
  // painted, the hidden cards already holding their places in the hand.
  useLayoutEffect(() => {
    const timers: number[] = []
    const flying: HTMLElement[] = []
    const seats = [YOU, AI] as const
    let delay = 0
    for (const p of seats) {
      const side = view.players[p]
      const who = p === YOU ? 'me' : 'opp'
      const deck = document.querySelector(`.sim-strip.${who} .sim-pile.deck`)
      const slots = [...document.querySelectorAll<HTMLElement>(`.sim-strip.${who} [data-arriving]`)]
      const pending = side.drawn - landedNow.current[p]
      for (let i = 0; i < pending; i++) {
        const slot = slots[slots.length - pending + i]
        const land = () => setLanded((now) => (p === YOU ? [now[0] + 1, now[1]] : [now[0], now[1] + 1]))
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
    if (game.phase === 'over' || !view.waitingFor.includes(AI)) return
    const timer = setTimeout(() => {
      const action = chooseAction(game, AI)
      if (action) act(AI, action)
    }, AI_DELAY)
    return () => clearTimeout(timer)
  }, [game])

  const look = (image: string | undefined, landscape = false) => (event: React.MouseEvent) =>
    image && setHover({ image, landscape, right: event.clientX < window.innerWidth / 2 })
  const leave = () => setHover(null)
  const imageOf = (id: string, unitSide = false) => {
    const images = set.images[id]
    return unitSide ? (images?.back ?? images?.image) : images?.image
  }

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
  const waitText = `${opp.name} is ${view.phase === 'action' ? 'choosing an action' : 'deciding'}…`
  const answer = (picks: string[]) => act(YOU, { type: 'answer', picks })
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
      ...(asked.min === 0 ? [{ label: asked.max === 1 ? 'Skip' : 'None', onClick: () => answer([]) }] : []),
      ...(asked.max > 1 || asked.min > 1
        ? [{ label: 'Done', kind: 'go', disabled: picked.length < asked.min || !picked.length, onClick: () => answer(picked) }]
        : []),
    ]
  } else switch (view.phase) {
    case 'first':
      prompt = mine ? 'You decide who goes first' : `${opp.name} decides who goes first…`
      buttons = [
        { label: 'Go second', disabled: !mine, onClick: () => act(YOU, { type: 'first', goFirst: false }) },
        { label: 'Go first', kind: 'go', disabled: !mine, onClick: () => act(YOU, { type: 'first', goFirst: true }) },
      ]
      break
    case 'mulligan':
      prompt = mine ? 'Keep your starting hand?' : waitText
      buttons = [
        { label: 'Mulligan', disabled: !mine, onClick: () => act(YOU, { type: 'mulligan', take: true }) },
        { label: 'Keep', kind: 'go', disabled: !mine, onClick: () => act(YOU, { type: 'mulligan', take: false }) },
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
          onClick: () => act(YOU, { type: 'resource', cards: picked }),
        },
      ]
      break
    case 'regroup':
      prompt = !mine ? waitText : picked.length ? `Regroup: resource ${pickedNames}?` : 'Regroup: choose a card to resource, or skip'
      buttons = [
        { label: 'Skip', disabled: !mine, onClick: () => act(YOU, { type: 'resource', cards: [] }) },
        {
          label: picked.length ? 'Resource It' : 'Resource',
          kind: 'go',
          disabled: !mine || picked.length !== 1,
          onClick: () => act(YOU, { type: 'resource', cards: picked }),
        },
      ]
      break
    case 'action':
      if (!mine) {
        prompt = waitText
      } else if (attacker) {
        prompt = `Choose a target for ${defOf(attacker.def).name}`
      } else if (attachCard) {
        prompt = `Choose a unit for ${defOf(attachCard.def).name}`
      } else {
        prompt = 'Your turn: play a card, attack or pass'
      }
      buttons = mode
        ? [{ label: 'Cancel', onClick: () => setMode(null) }]
        : [
            { label: 'Pass', kind: 'pass', disabled: !mine, onClick: () => act(YOU, { type: 'pass' }) },
            {
              label: 'Claim Initiative',
              kind: 'claim',
              disabled: !can({ type: 'initiative' }),
              onClick: () => act(YOU, { type: 'initiative' }),
            },
          ]
      break
  }

  // What a card on the table can do, clicked: its Action abilities, and a leader's deploy or a
  // unit's attack. One is done at once; more are offered to choose from.
  const abilitiesOf = (source: string) =>
    !mode && !asked
      ? view.abilities.filter((a) => a.source === source).map((a) => ({ label: a.label, run: () => act(YOU, { type: 'ability', source, index: a.index }) }))
      : []
  const offer = (card: string, options: { label: string; run: () => void }[], landscape?: boolean) => {
    if (options.length === 1) options[0].run()
    else if (options.length) setMenu({ card, landscape, options })
  }
  const leaderOptions = () => [
    ...abilitiesOf('leader'),
    ...(!mode && !asked && can({ type: 'deploy' }) ? [{ label: 'Deploy Leader', run: () => act(YOU, { type: 'deploy' }) }] : []),
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
      else act(YOU, plays[0])
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
      act(YOU, mode.kind === 'attack' ? { type: 'attack', attacker: mode.attacker, target: id } : attachAction(mode, id))
    } else if (mode?.kind === 'attack' && mode.attacker === id) {
      setMode(null)
    } else if (!mode) {
      const unit = me.units.find((u) => u.id === id)
      if (unit) offer(unit.def, unitOptions(id))
    }
  }
  const clickBase = (id: string) => {
    if (asked) return askedOn(id) && pickAnswer(id)
    if (id === 'base' && mode?.kind === 'attack' && isTarget('base')) act(YOU, { type: 'attack', attacker: mode.attacker, target: 'base' })
  }

  const unitView = (side: SideView, arena: Arena) => (u: SideView['units'][number]) => {
    const d = defOf(u.def)
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
    ]
    const tags = [
      keywords.sentinel && 'Sentinel',
      keywords.saboteur && 'Saboteur',
      keywords.overwhelm && 'Overwhelm',
      keywords.grit && 'Grit',
      keywords.ambush && 'Ambush',
      // Only while it protects the unit: the phase it entered play
      u.hidden && 'Hidden',
      keywords.raid && `Raid ${keywords.raid}`,
      keywords.restore && `Restore ${keywords.restore}`,
    ].filter(Boolean)
    const image = imageOf(u.def, u.leader)
    return (
      <div key={u.id} className="sim-unit-slot">
        <button
          type="button"
          className={classes.filter(Boolean).join(' ')}
          onMouseEnter={look(image)}
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
          {!!tags.length && (
            <span className="sim-tags">
              {tags.map((tag) => (
                <span key={tag as string}>{tag}</span>
              ))}
            </span>
          )}
          {(u.power !== printed?.power || u.hp !== printed?.hp) && (
            <span className="sim-stats" title="Power and HP now">
              {u.power}/{u.hp}
            </span>
          )}
          {!!u.damage && <span className="sim-damage">{u.damage}</span>}
        </button>
        {!!u.upgrades.length && (
          <span className="sim-upgrades">
            {u.upgrades.map((up) => (
              <span
                key={up.id}
                className={defOf(up.def).token ? `token ${defOf(up.def).name.toLowerCase()}` : undefined}
                onMouseEnter={look(imageOf(up.def))}
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
    const arriving = coming[who === 'me' ? YOU : AI]
    const top = side.discard[side.discard.length - 1]
    const ready = side.resources.filter((r) => !r.exhausted).length
    return (
      <div className={`sim-strip ${who}`}>
        <div
          className={`sim-pile${top ? ' open' : ''}`}
          title={top ? 'Discard pile: click to see it' : 'Discard pile'}
          onClick={top ? () => setPileOpen(who === 'me' ? 'discard-me' : 'discard-opp') : undefined}
        >
          {top ? (
            <img src={img(imageOf(top.def) ?? '')} alt={defOf(top.def).name} onMouseEnter={look(imageOf(top.def))} onMouseLeave={leave} />
          ) : (
            <div className="sim-empty">Discard</div>
          )}
          <span className="sim-count">{side.discard.length}</span>
        </div>
        <div className="sim-pile deck" title="Deck">
          {side.topCard ? (
            <img
              src={img(imageOf(side.topCard.def) ?? '')}
              alt={defOf(side.topCard.def).name}
              title="The top card of your deck"
              onMouseEnter={look(imageOf(side.topCard.def))}
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
                  onMouseEnter={r.card ? look(imageOf(r.card.def)) : undefined}
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
                  data-image={imageOf(c.def)}
                  className={[
                    'sim-hand-card',
                    !pickCount && !mode && !asked && playsOf(c.id).length && 'playable',
                    askedOn(c.id) && (harmful ? 'asked harm' : 'asked'),
                    asked?.play?.card === c.id && 'asked',
                    picked.includes(c.id) && 'picked',
                    mode?.kind === 'attach' && mode.card === c.id && 'picked',
                    pickCount && 'pickable',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onMouseEnter={look(imageOf(c.def))}
                  onMouseLeave={leave}
                  onClick={() => clickHand(c.id)}
                >
                  <img src={img(imageOf(c.def) ?? '')} alt={defOf(c.def).name} />
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
        {who === 'me' && !apart && !setup && (
          <div className="sim-actions">
            {buttons.map((b) => (
              <button key={b.label} type="button" className={`sim-button ${b.kind ?? ''}`} disabled={b.disabled} onClick={b.onClick}>
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
    const id = side === me ? `base${YOU}` : `base${AI}`
    const target = asked ? askedOn(id) : side === opp && isTarget('base')
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
            style={{ '--spice-art': `url("${set.spiceArt ?? img(spiceImage ?? '')}")` } as React.CSSProperties}
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

  const arena = (kind: Arena) => (
    <section className={`sim-arena ${kind}`}>
      <span className="sim-arena-name">{kind}</span>
      <div className="sim-half opp">{opp.units.filter((u) => u.arena === kind).map(unitView(opp, kind))}</div>
      <div className="sim-half me">{me.units.filter((u) => u.arena === kind).map(unitView(me, kind))}</div>
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
  const plan = deckPlan(game, AI)
  const tallest = Math.max(1, ...plan.curve)
  const deckAnalysis = (
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
        {named && <b className={player === YOU ? 'me' : 'opp'}>{name}</b>}
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
  type Stack = { key: string; def: string; count: number; used?: boolean; play?: () => void }
  const stack = (cards: { def: string; id: string; used?: boolean; play?: boolean }[]) => {
    const stacks: Stack[] = []
    for (const card of cards) {
      const key = `${card.def}|${!!card.used}|${!!card.play}`
      const found = stacks.find((s) => s.key === key)
      if (found) found.count++
      else
        stacks.push({
          key,
          def: card.def,
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
    view.winner === null ? '' : view.winner === 'draw' ? 'Draw' : view.winner === YOU ? 'Victory' : 'Defeat'

  return (
    <>
      <aside className="sim-chat">
        <h2>Chat</h2>
        <div className="sim-messages">
          {chat.map((m, i) => (
            <p key={i} className={m.who}>
              <b>{m.who === 'me' ? 'You' : opp.name}:</b> {m.text}
            </p>
          ))}
        </div>
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
      </aside>

      <div className="sim-board">
        {strip(opp, 'opp')}
        <div className="sim-play">
          {arena('space')}
          <div className="sim-centre">
            {leaderCard(opp)}
            {baseCard(opp)}
            <div className="sim-prompt">{prompt && !setup && <span>{apart ? 'Choose…' : promptText}</span>}</div>
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
            {lastCard(last[AI], opp.name)}
            {revealedCards(opp, opp.name)}
            <div className={`sim-initiative-track ${view.initiative === YOU ? 'me' : 'opp'}`}>
              {/* No one holds it until the first player is chosen */}
              <span hidden={view.phase === 'first'} className={`sim-initiative${view.initiativeTaken ? ' taken' : ''}`} title={view.initiativeTaken ? 'Claimed this round' : undefined}>
                Initiative
              </span>
            </div>
            {revealedCards(me, 'you')}
            {lastCard(last[YOU], 'you')}
          </div>
        </div>
        {strip(me, 'me')}
      </div>

      <aside className="sim-log">
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
          <button type="button" disabled={view.phase === 'over'} onClick={() => setAsking('concede')}>
            Concede
          </button>
          {/* Once the game is over there is nothing to lose by leaving */}
          <button type="button" onClick={() => (view.phase === 'over' ? props.onNew() : setAsking('leave'))}>
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
                className={[stack.play && 'playable', stack.used && 'used'].filter(Boolean).join(' ') || undefined}
                title={stack.play ? (pileOpen === 'resources' ? 'Play it using Smuggle' : 'Play it from your discard pile') : stack.used ? 'Exhausted' : undefined}
                onMouseEnter={look(imageOf(stack.def))}
                onMouseLeave={leave}
                onClick={stack.play}
              >
                <img src={img(imageOf(stack.def) ?? '')} alt={defOf(stack.def).name} />
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
        <div className="sim-choice">
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
      {apart && asked && (
        <div className="sim-choice">
          <p>{prompt}</p>
          <div className="sim-choice-cards">
            {asked.card && (
              <img src={img(imageOf(asked.card) ?? '')} alt={defOf(asked.card).name} onMouseEnter={look(imageOf(asked.card))} onMouseLeave={leave} />
            )}
            {shown.map((o) => {
              const image = o.def ? imageOf(o.def) : undefined
              return (
                <button
                  key={o.id}
                  type="button"
                  className={picked.includes(o.id) ? 'picked' : undefined}
                  onMouseEnter={look(image)}
                  onMouseLeave={leave}
                  onClick={() => pickAnswer(o.id)}
                >
                  {image ? <img src={img(image)} alt={o.def ? defOf(o.def).name : ''} /> : <span>{o.label ?? o.id}</span>}
                </button>
              )
            })}
          </div>
          <div className="sim-choice-buttons">
            {buttons.map((b) => (
              <button key={b.label} type="button" className={`sim-button ${b.kind ?? ''}`} disabled={b.disabled} onClick={b.onClick}>
                {b.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {hover && (
        <div className={`sim-preview ${hover.right ? 'right' : 'left'}${hover.landscape ? ' landscape' : ''}`}>
          <img src={img(hover.image)} alt="" />
        </div>
      )}
      {asking && (
        <Modal title={asking === 'concede' ? 'Concede the game?' : 'Leave the game?'} onClose={() => setAsking(null)}>
          <p className="account-note">
            {asking === 'concede'
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
                if (asking === 'concede') act(YOU, { type: 'concede' })
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
              <button type="button" className="sim-button go" onClick={props.onAgain}>
                Play again
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
