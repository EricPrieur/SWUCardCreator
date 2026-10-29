import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { asset } from './asset'
import { useAccount, type Session } from './api'
import { Modal } from './account'
import { loadAccountDecks } from './accountCards'
import { loadDecks, type Deck } from './cards'
import { chooseAction } from '../server/engine/ai.ts'
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
type SetCards = { defs: CardDef[]; images: Record<string, { image: string; back?: string }> }
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
            Cards play with their cost, power, HP and keywords. The text of {set.defs.filter((d) => !d.token && scriptStatus(d) === 'scripted').length} of {set.defs.filter((d) => !d.token && scriptStatus(d) !== 'blank').length} cards works so far; on the others it doesn't do anything yet.
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
type Mode = { kind: 'attack'; attacker: string } | { kind: 'attach'; card: string; smuggle?: boolean } | null

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

let soundOn = (() => {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off'
  } catch {
    return true
  }
})()

function playDraw() {
  if (!soundOn) return
  const audio = new Audio(drawSound)
  audio.volume = 0.35
  // A browser may refuse sound until the page has been clicked: silent, then
  audio.play().catch(() => {})
}

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
  const [sound, setSound] = useState(soundOn)
  // Leaving or conceding, asked before it is done
  const [asking, setAsking] = useState<'leave' | 'concede' | null>(null)
  // How many of each player's drawn cards have reached the hand; the others are on their way,
  // hidden in the hand until they land
  const [landed, setLanded] = useState<[number, number]>([0, 0])
  const landedNow = useRef(landed)
  landedNow.current = landed
  const [message, setMessage] = useState('')

  const view = useMemo(() => viewFor(game, YOU), [game])
  const me = view.players[YOU]
  const opp = view.players[AI]
  const defOf = (id: string) => game.defs[id]
  const mine = view.waitingFor.includes(YOU)
  // A question an ability asks you: what you may pick, on the board or among cards shown apart
  const asked = view.prompt && 'options' in view.prompt && view.prompt.player === YOU ? view.prompt : null
  const boardIds = new Set([...me.units, ...opp.units].map((u) => u.id).concat('base0', 'base1'))
  const askedOn = (id: string) => !!asked && asked.kind === 'pick' && asked.options.some((o) => o.id === id)
  const shown = asked?.kind === 'pick' ? asked.options.filter((o) => !boardIds.has(o.id)) : []
  // A question about a card off the board is asked beside it, apart from the board
  const apart = !!shown.length || !!asked?.card

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
    }
    // The hovered card may leave the board without a mouseleave
    setHover(null)
  }
  const can = (action: Action) => view.actions.some((a) => sameAction(a, action))
  // In the engine's order of keys, which sameAction compares
  const attachAction = (attach: { card: string; smuggle?: boolean }, unit: string): Action =>
    attach.smuggle ? { type: 'play', card: attach.card, attachTo: unit, smuggle: true } : { type: 'play', card: attach.card, attachTo: unit }

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
      prompt = mine ? `Choose ${pickCount} cards to resource (${picked.length}/${pickCount})` : waitText
      buttons = [
        {
          label: 'Done',
          kind: 'go',
          disabled: !mine || picked.length !== pickCount,
          onClick: () => act(YOU, { type: 'resource', cards: picked }),
        },
      ]
      break
    case 'regroup':
      prompt = mine ? `Regroup: choose a card to resource, or skip (${picked.length}/1)` : waitText
      buttons = [
        { label: 'Skip', disabled: !mine, onClick: () => act(YOU, { type: 'resource', cards: [] }) },
        {
          label: 'Resource',
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
            ...view.abilities.map((a) => ({
              label: `${defOf(a.source === 'leader' ? me.leader.def : ([...me.units, ...me.spice].find((c) => c.id === a.source)?.def ?? '')).name}: ${a.label}`,
              kind: 'ability',
              onClick: () => act(YOU, { type: 'ability', source: a.source, index: a.index }),
            })),
            ...(can({ type: 'deploy' })
              ? [{ label: 'Deploy Leader', kind: 'go', onClick: () => act(YOU, { type: 'deploy' }) }]
              : []),
          ]
      break
  }

  const playsOf = (id: string) => view.actions.filter((a) => a.type === 'play' && a.card === id)
  // A resource played using Smuggle: a unit or event at once, an upgrade once its unit is chosen
  const clickResource = (id: string) => {
    if (mode || asked || pickCount) return
    const plays = playsOf(id)
    if (!plays.length) return
    if (plays.some((a) => a.type === 'play' && a.attachTo)) setMode({ kind: 'attach', card: id, smuggle: true })
    else act(YOU, plays[0])
  }
  const clickHand = (id: string) => {
    if (pickCount) {
      setPicked((now) => (now.includes(id) ? now.filter((i) => i !== id) : now.length < pickCount ? [...now, id] : now))
      return
    }
    const plays = playsOf(id)
    if (!plays.length) return
    if (plays.some((a) => a.type === 'play' && a.attachTo)) setMode({ kind: 'attach', card: id })
    else act(YOU, plays[0])
  }
  const clickUnit = (id: string) => {
    if (asked) {
      if (askedOn(id)) pickAnswer(id)
    } else if (mode && isTarget(id)) {
      act(YOU, mode.kind === 'attack' ? { type: 'attack', attacker: mode.attacker, target: id } : attachAction(mode, id))
    } else if (mode?.kind === 'attack' && mode.attacker === id) {
      setMode(null)
    } else if (!mode && attackActions.some((a) => a.type === 'attack' && a.attacker === id)) {
      setMode({ kind: 'attack', attacker: id })
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
    const ready = !mode && !asked && ours && attackActions.some((a) => a.type === 'attack' && a.attacker === u.id)
    const classes = [
      'sim-unit',
      u.exhausted && 'exhausted',
      target && 'target',
      chosen && 'chosen',
      mode?.kind === 'attack' && !ours && arena === attacker?.arena && !target && 'blocked',
      attacker?.id === u.id && 'attacker',
      ready && 'can-act',
    ]
    const tags = [
      keywords.sentinel && 'Sentinel',
      keywords.saboteur && 'Saboteur',
      keywords.overwhelm && 'Overwhelm',
      keywords.grit && 'Grit',
      keywords.ambush && 'Ambush',
      keywords.hidden && 'Hidden',
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
        <div className="sim-pile" title="Discard pile">
          {top ? (
            <img src={img(imageOf(top.def) ?? '')} alt={defOf(top.def).name} onMouseEnter={look(imageOf(top.def))} onMouseLeave={leave} />
          ) : (
            <div className="sim-empty">Discard</div>
          )}
          <span className="sim-count">{side.discard.length}</span>
        </div>
        <div className="sim-pile deck" title="Deck">
          {side.deckCount ? <Back /> : <div className="sim-empty">Deck</div>}
          <span className="sim-count">{side.deckCount}</span>
        </div>
        <div className="sim-resources" title={`${ready} of ${side.resources.length} resources ready`}>
          <div className="sim-resource-cards">
            {side.resources.map((r, i) => {
              const smuggle = !!r.card && who === 'me' && !mode && !asked && !pickCount && playsOf(r.card.id).length > 0
              return (
                <div
                  key={i}
                  className={['sim-resource', r.exhausted && 'used', smuggle && 'playable'].filter(Boolean).join(' ')}
                  title={smuggle ? 'Play it using Smuggle' : undefined}
                  onMouseEnter={r.card ? look(imageOf(r.card.def)) : undefined}
                  onMouseLeave={leave}
                  onClick={smuggle ? () => clickResource(r.card!.id) : undefined}
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
                    !pickCount && !mode && playsOf(c.id).length && 'playable',
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
                </button>
              ))
            : Array.from({ length: side.handCount }, (_, i) => (
                <div key={i} className="sim-hand-back" data-arriving={i >= side.handCount - arriving || undefined}>
                  <Back />
                </div>
              ))}
          {!side.hand && <span className="sim-count hand">{side.handCount}</span>}
        </div>
        {who === 'me' && !apart && (
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
    const deploy = side === me && !mode && can({ type: 'deploy' })
    const classes = ['sim-landscape', 'leader', side.leader.deployed && 'deployed', side.leader.exhausted && 'exhausted', deploy && 'can-act']
    return (
      <button
        type="button"
        className={classes.filter(Boolean).join(' ')}
        title={side.leader.deployed ? 'Deployed' : deploy ? 'Deploy this leader' : undefined}
        onMouseEnter={look(image, true)}
        onMouseLeave={leave}
        onClick={deploy ? () => act(YOU, { type: 'deploy' }) : undefined}
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
    return (
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
        {!!side.spice.length && (
          <span className="sim-spice" title={`${side.spice.length} Spice token${side.spice.length > 1 ? 's' : ''}`}>
            <img src={img(imageOf(side.spice[0].def) ?? '')} alt="" onMouseEnter={look(imageOf(side.spice[0].def))} onMouseLeave={leave} />
            {side.spice.length}
          </span>
        )}
        {!!side.base.damage && <span className="sim-damage big">{side.base.damage}</span>}
      </button>
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

  // A player's name, where a line starts with it, in their colour
  const logLine = (text: string, player?: PlayerId) => {
    const name = player === undefined ? '' : view.players[player].name
    if (!name || !text.startsWith(name)) return text
    return (
      <>
        <b className={player === YOU ? 'me' : 'opp'}>{name}</b>
        {text.slice(name.length)}
      </>
    )
  }

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
            setChat((now) => [...now, { who: 'me', text: message.trim() }])
            setMessage('')
          }}
        >
          <input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Say something" />
          <div className="sim-quick">
            {['gg', 'gl hf', 'thinking…', 'nice play'].map((text) => (
              <button key={text} type="button" onClick={() => setChat((now) => [...now, { who: 'me', text }])}>
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
            <div className="sim-prompt">{prompt && <span>{apart ? 'Choose…' : prompt}</span>}</div>
            {baseCard(me)}
            {leaderCard(me)}
          </div>
          {arena('ground')}
          <div className="sim-last">
            {lastCard(last[AI], opp.name)}
            <div className={`sim-initiative-track ${view.initiative === YOU ? 'me' : 'opp'}`}>
              {/* No one holds it until the first player is chosen */}
              <span hidden={view.phase === 'first'} className={`sim-initiative${view.initiativeTaken ? ' taken' : ''}`} title={view.initiativeTaken ? 'Claimed this round' : undefined}>
                Initiative
              </span>
            </div>
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
        <h2>Log</h2>
        <ol ref={(list) => list?.scrollTo(0, list.scrollHeight)}>
          {view.log.map((entry, i) => (
            <li key={i} className={entry.player === undefined && /^Round /.test(entry.text) ? 'round' : undefined}>
              {logLine(entry.text, entry.player)}
            </li>
          ))}
        </ol>
      </aside>

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
