import { useState, type ReactNode } from 'react'
import { asset } from './asset'
import './Simulator.css'

// A mock of the simulator's screen: a made-up game between two DUNE decks, to try the
// layout and each phase before the engine exists. Nothing here follows the rules.

type Card = { name: string; image: string; cost?: number; landscape?: boolean }
type Unit = Card & { id: string; damage?: number; exhausted?: boolean; shield?: number; experience?: number; sentinel?: boolean }
type Side = 'me' | 'opp'
type Player = {
  name: string
  leader: Card
  base: Card & { damage: number; spice: number }
  deck: number
  discard: Card | null
  discardCount: number
  resources: number
  ready: number
  hand: Card[] | number
  space: Unit[]
  ground: Unit[]
  last: Card | null
}

const img = (card: Card) => asset(`/showcase/DUNE/${card.image}.jpg`)
const card = (name: string, image = name, cost?: number): Card => ({ name, image, cost })
const unit = (id: string, name: string, image = name, extra: Partial<Unit> = {}): Unit => ({ id, name, image, ...extra })

const myHand: Card[] = [
  card('Spice Hunter', 'Spice Hunter', 2),
  card('Fremen Saboteurs', 'Fremen Saboteurs', 4),
  card('Kanly', 'Kanly', 2),
  card('Crysknife', 'Crysknife', 1),
  card('Fedaykin Death Commando', 'Fedaykin Death Commando', 3),
  card('Fremen Worm Riders', 'Fremen Worm Riders', 7),
]

function board(fresh: boolean): Record<Side, Player> {
  const me: Player = {
    name: 'You',
    leader: { ...card('Chani', 'Chani - Sihaya'), landscape: true },
    base: { ...card('Sietch Tabr'), landscape: true, damage: fresh ? 0 : 4, spice: 1 },
    deck: fresh ? 44 : 38,
    discard: fresh ? null : card('Spice Raid'),
    discardCount: fresh ? 0 : 2,
    resources: fresh ? 0 : 5,
    ready: fresh ? 0 : 5,
    hand: myHand,
    space: fresh ? [] : [unit('m1', "Spotter 'Thopter")],
    ground: fresh
      ? []
      : [
          unit('m2', 'Fremen'),
          unit('m3', 'Fremen Warrior', 'Fremen Warrior', { experience: 1 }),
          unit('m4', 'Sietch Raiders', 'Sietch Raiders', { exhausted: true, damage: 2 }),
        ],
    last: fresh ? null : card('Fremen Warrior'),
  }
  const opp: Player = {
    name: 'Rabban',
    leader: { ...card('Glossu Rabban', 'Glossu Rabban - Governor of Arrakis'), landscape: true },
    base: { ...card('Carthag'), landscape: true, damage: fresh ? 0 : 7, spice: 1 },
    deck: fresh ? 44 : 37,
    discard: fresh ? null : card('Sabotage'),
    discardCount: fresh ? 0 : 3,
    resources: fresh ? 0 : 5,
    ready: fresh ? 0 : 3,
    hand: fresh ? 6 : 4,
    space: fresh ? [] : [unit('o1', "Harkonnen Assault 'Thopter", "Harkonnen Assault 'Thopter", { exhausted: true })],
    ground: fresh
      ? []
      : [
          unit('o2', 'Harkonnen Troops'),
          unit('o3', 'Harkonnen Sergeant', 'Harkonnen Sergeant', { damage: 1 }),
          unit('o4', 'Feyd-Rautha Harkonnen', 'Feyd-Rautha Harkonnen - na-Baron', { shield: 1, sentinel: true }),
        ],
    last: fresh ? null : card('Feyd-Rautha Harkonnen', 'Feyd-Rautha Harkonnen - na-Baron'),
  }
  return { me, opp }
}

const phases = [
  { id: 'mulligan', label: 'Setup: mulligan' },
  { id: 'resource', label: 'Setup: choose 2 resources' },
  { id: 'action', label: 'Action phase: your turn' },
  { id: 'attack', label: 'Action phase: choose a target' },
  { id: 'trigger', label: 'Action phase: a "you may" trigger' },
  { id: 'waiting', label: "Action phase: opponent's turn" },
  { id: 'regroup', label: 'Regroup phase: resource a card' },
  { id: 'over', label: 'Game over' },
] as const
type Phase = (typeof phases)[number]['id']

type Hover = { card: Card; right: boolean } | null

const cardBack = asset('/sim/DuneCardBack01.jpg')

function Back() {
  return <div className="sim-back" style={{ backgroundImage: `url("${cardBack}")` }} />
}

export function Simulator() {
  const [phase, setPhase] = useState<Phase>('action')
  const [picked, setPicked] = useState<number[]>([])
  const [attacker, setAttacker] = useState<string>('m3')
  const [hover, setHover] = useState<Hover>(null)
  const [log, setLog] = useState<ReactNode[]>([])
  const [chat, setChat] = useState([
    { who: 'opp', text: 'gl hf' },
    { who: 'me', text: 'you too!' },
  ])
  const [message, setMessage] = useState('')

  const fresh = phase === 'mulligan' || phase === 'resource'
  const players = board(fresh)
  const myInitiative = phase !== 'waiting'
  const go = (next: Phase) => {
    setPhase(next)
    setPicked([])
    // The hovered card may leave the board without a mouseleave
    setHover(null)
  }
  const note = (entry: ReactNode) => setLog((entries) => [...entries, entry])
  const look = (c: Card) => (event: React.MouseEvent) => setHover({ card: c, right: event.clientX < window.innerWidth / 2 })
  const leave = () => setHover(null)

  // What each phase asks, and the buttons that answer it (always at the bottom right)
  const pickCount = phase === 'resource' ? 2 : phase === 'regroup' ? 1 : 0
  const prompt: Record<Phase, string> = {
    mulligan: 'Keep your starting hand?',
    resource: `Choose 2 cards to resource (${picked.length}/2)`,
    action: 'Choose an action',
    attack: 'Choose a target for the attack',
    trigger: 'Chani: exhaust her to deal 1 damage to an enemy base?',
    waiting: 'Rabban is choosing an action…',
    regroup: `Regroup: choose a card to resource, or skip (${picked.length}/1)`,
    over: '',
  }
  const buttons: Record<Phase, { label: string; kind?: string; onClick?: () => void; disabled?: boolean }[]> = {
    mulligan: [
      { label: 'Mulligan', onClick: () => go('resource') },
      { label: 'Keep', kind: 'go', onClick: () => go('resource') },
    ],
    resource: [{ label: 'Done', kind: 'go', disabled: picked.length !== 2, onClick: () => go('action') }],
    action: [
      { label: 'Pass', kind: 'pass', onClick: () => go('waiting') },
      { label: 'Claim Initiative', kind: 'claim', onClick: () => go('waiting') },
    ],
    attack: [{ label: 'Cancel', onClick: () => go('action') }],
    trigger: [
      { label: 'Skip', onClick: () => go('action') },
      { label: 'Deal 1 damage', kind: 'go', onClick: () => go('action') },
    ],
    waiting: [
      { label: 'Pass', kind: 'pass', disabled: true },
      { label: 'Claim Initiative', kind: 'claim', disabled: true },
    ],
    regroup: [
      { label: 'Skip', onClick: () => go('action') },
      { label: 'Resource', kind: 'go', disabled: picked.length !== 1, onClick: () => go('action') },
    ],
    over: [],
  }

  const me = players.me
  const playable = (c: Card) => phase === 'action' && (c.cost ?? 99) <= me.ready
  const attackFrom = [...me.space, ...me.ground].find((u) => u.id === attacker)
  const attackArena = me.space.some((u) => u.id === attacker) ? 'space' : 'ground'
  const enemies = players.opp[attackArena]
  const sentinels = enemies.filter((u) => u.sentinel)
  // Sentinel: while an enemy in the arena has it, only it can be attacked
  const targetable = (u: Unit | 'base', arena: 'space' | 'ground') =>
    phase === 'attack' && arena === attackArena && (sentinels.length ? u !== 'base' && u.sentinel : true)

  const clickHand = (index: number, c: Card) => {
    if (pickCount) {
      setPicked((now) =>
        now.includes(index) ? now.filter((i) => i !== index) : now.length < pickCount ? [...now, index] : now,
      )
    } else if (playable(c)) {
      note(
        <>
          <b className="me">You</b> play <i>{c.name}</i>
        </>,
      )
      if (c.name === 'Spice Hunter' || c.name === 'Fedaykin Death Commando') go('trigger')
    }
  }
  const clickUnit = (side: Side, u: Unit, arena: 'space' | 'ground') => {
    if (phase === 'action' && side === 'me' && !u.exhausted) {
      setAttacker(u.id)
      go('attack')
    } else if (side === 'opp' && targetable(u, arena)) {
      note(
        <>
          <b className="me">You</b> attack <i>{u.name}</i> with <i>{attackFrom?.name}</i>
        </>,
      )
      go('action')
    }
  }
  const clickBase = () => {
    if (targetable('base', attackArena)) {
      note(
        <>
          <b className="me">You</b> attack <i>{players.opp.base.name}</i> with <i>{attackFrom?.name}</i>
        </>,
      )
      go('action')
    }
  }

  const unitView = (side: Side, arena: 'space' | 'ground') => (u: Unit) => {
    const target = side === 'opp' && targetable(u, arena)
    const ready = phase === 'action' && side === 'me' && !u.exhausted
    const classes = [
      'sim-unit',
      u.exhausted && 'exhausted',
      target && 'target',
      phase === 'attack' && side === 'opp' && arena === attackArena && !target && 'blocked',
      phase === 'attack' && u.id === attacker && 'attacker',
      ready && 'can-act',
    ]
    return (
      <button
        key={u.id}
        type="button"
        className={classes.filter(Boolean).join(' ')}
        onMouseEnter={look(u)}
        onMouseLeave={leave}
        onClick={() => clickUnit(side, u, arena)}
      >
        <img src={img(u)} alt={u.name} />
        <span className="sim-tokens">
          {!!u.shield && <span className="sim-token shield" title="Shield">⛨</span>}
          {!!u.experience && <span className="sim-token xp" title="Experience">+{u.experience}</span>}
        </span>
        {!!u.damage && <span className="sim-damage">{u.damage}</span>}
      </button>
    )
  }

  // One player's row of discard, deck, resources and hand; the opponent's is the same, mirrored
  const strip = (side: Side) => {
    const p = players[side]
    const hand = p.hand
    return (
      <div className={`sim-strip ${side}`}>
        <div className="sim-pile" title="Discard pile">
          {p.discard ? (
            <img src={img(p.discard)} alt={p.discard.name} onMouseEnter={look(p.discard)} onMouseLeave={leave} />
          ) : (
            <div className="sim-empty">Discard</div>
          )}
          <span className="sim-count">{p.discardCount}</span>
        </div>
        <div className="sim-pile" title="Deck">
          <Back />
          <span className="sim-count">{p.deck}</span>
        </div>
        <div className="sim-resources" title={`${p.ready} of ${p.resources} resources ready`}>
          <div className="sim-resource-cards">
            {Array.from({ length: p.resources }, (_, i) => (
              <div key={i} className={i < p.ready ? 'sim-resource' : 'sim-resource used'}>
                <Back />
              </div>
            ))}
          </div>
          <span className="sim-resource-count">
            {p.ready}/{p.resources}
          </span>
        </div>
        <div className="sim-hand">
          {typeof hand === 'number'
            ? Array.from({ length: hand }, (_, i) => <Back key={i} />)
            : hand.map((c, i) => (
                <button
                  key={c.name}
                  type="button"
                  className={[
                    'sim-hand-card',
                    playable(c) && 'playable',
                    picked.includes(i) && 'picked',
                    pickCount && 'pickable',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onMouseEnter={look(c)}
                  onMouseLeave={leave}
                  onClick={() => clickHand(i, c)}
                >
                  <img src={img(c)} alt={c.name} />
                </button>
              ))}
          {typeof hand === 'number' && <span className="sim-count hand">{hand}</span>}
        </div>
        {side === 'me' && (
          <div className="sim-actions">
            {buttons[phase].map((b) => (
              <button key={b.label} type="button" className={`sim-button ${b.kind ?? ''}`} disabled={b.disabled} onClick={b.onClick}>
                {b.label}
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  const landscape = (c: Card & { damage?: number; spice?: number }, kind: string, onClick?: () => void, target = false) => (
    <button
      type="button"
      className={`sim-landscape ${kind}${target ? ' target' : ''}`}
      onMouseEnter={look(c)}
      onMouseLeave={leave}
      onClick={onClick}
    >
      <img src={img(c)} alt={c.name} />
      {c.damage !== undefined && <span className="sim-damage big">{c.damage}</span>}
      {!!c.spice && (
        <span className="sim-spice" title={`${c.spice} Spice token`}>
          <img src={asset('/showcase/DUNE/Spice.jpg')} alt="" />×{c.spice}
        </span>
      )}
    </button>
  )

  const arena = (kind: 'space' | 'ground') => (
    <section className={`sim-arena ${kind}`}>
      <span className="sim-arena-name">{kind === 'space' ? 'Space' : 'Ground'}</span>
      <div className="sim-half opp">{players.opp[kind].map(unitView('opp', kind))}</div>
      <div className="sim-half me">{players.me[kind].map(unitView('me', kind))}</div>
    </section>
  )

  return (
    <div className="sim">
      <aside className="sim-chat">
        <h2>Chat</h2>
        <div className="sim-messages">
          {chat.map((m, i) => (
            <p key={i} className={m.who}>
              <b>{m.who === 'me' ? 'You' : 'Rabban'}:</b> {m.text}
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
        {strip('opp')}
        <div className="sim-play">
          {arena('space')}
          <div className="sim-centre">
            {landscape(players.opp.leader, 'leader')}
            {landscape(players.opp.base, 'base', clickBase, targetable('base', attackArena))}
            <div className="sim-prompt">{prompt[phase] && <span>{prompt[phase]}</span>}</div>
            {landscape(me.base, 'base')}
            {landscape(me.leader, 'leader', phase === 'action' ? () => go('trigger') : undefined)}
          </div>
          {arena('ground')}
          <div className="sim-last">
            <div className="sim-last-card" title="Last card played by Rabban">
              {players.opp.last ? (
                <img src={img(players.opp.last)} alt={players.opp.last.name} onMouseEnter={look(players.opp.last)} onMouseLeave={leave} />
              ) : (
                <div className="sim-empty">Last played</div>
              )}
            </div>
            <div className={myInitiative ? 'sim-initiative-track me' : 'sim-initiative-track opp'}>
              <span className="sim-initiative">Initiative</span>
            </div>
            <div className="sim-last-card" title="Last card you played">
              {me.last ? (
                <img src={img(me.last)} alt={me.last.name} onMouseEnter={look(me.last)} onMouseLeave={leave} />
              ) : (
                <div className="sim-empty">Last played</div>
              )}
            </div>
          </div>
        </div>
        {strip('me')}
      </div>

      <aside className="sim-log">
        <div className="sim-mock">
          <label>
            Mock phase
            <select value={phase} onChange={(event) => go(event.target.value as Phase)}>
              {phases.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <a href="#showroom">Exit</a>
        </div>
        <h2>Log</h2>
        <ol>
          <li className="round">Round 1: Action phase</li>
          <li>
            <b className="opp">Rabban</b> plays <i>Harkonnen Troops</i>
          </li>
          <li>
            <b className="me">You</b> play <i>Fremen Warrior</i>
          </li>
          <li>
            <b className="opp">Rabban</b> attacks <i>Sietch Tabr</i> with <i>Harkonnen Assault 'Thopter</i> for 3
          </li>
          <li className="round">Round 2: Regroup phase</li>
          <li>Both players draw 2 cards and resource 1</li>
          <li className="round">Round 3: Action phase</li>
          <li>
            <b className="opp">Rabban</b> plays <i>Feyd-Rautha Harkonnen</i>
          </li>
          {log.map((entry, i) => (
            <li key={i}>{entry}</li>
          ))}
        </ol>
      </aside>

      {hover && (
        <div className={`sim-preview ${hover.right ? 'right' : 'left'}${hover.card.landscape ? ' landscape' : ''}`}>
          <img src={img(hover.card)} alt="" />
        </div>
      )}
      {phase === 'over' && (
        <div className="sim-over">
          <div>
            <h2>Victory</h2>
            <p>Carthag is destroyed.</p>
            <button type="button" className="sim-button go" onClick={() => go('mulligan')}>
              Play again
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
