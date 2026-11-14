import { asset } from './asset'

// A deck's numbers at a glance, beside its leader in the deck menus: the cost curve,
// the card types, and the aspects, small

export type GlanceKind = 'Ground' | 'Space' | 'Event' | 'Upgrade'
export type GlanceCard = { cost: number; kind?: GlanceKind; aspects: string[]; count: number }

const kinds: GlanceKind[] = ['Ground', 'Space', 'Event', 'Upgrade']

// Each aspect's colour, as in the Deck Builder's Math tab; a card with two takes a mix of both
const colors: Record<string, string> = {
  Vigilance: '#3f7fd6',
  Command: '#2e9b52',
  Aggression: '#cc3d2e',
  Cunning: '#e3b33a',
  Heroism: '#eee6d2',
  Villainy: '#2c2733',
}
const colorOf = (aspects: string[]) =>
  aspects.length === 0
    ? '#8a8a8a'
    : aspects.length === 1 || aspects[0] === aspects[1]
      ? (colors[aspects[0]] ?? '#8a8a8a')
      : `color-mix(in srgb, ${colors[aspects[0]] ?? '#8a8a8a'} 60%, ${colors[aspects[1]] ?? '#8a8a8a'})`

export function DeckGlance(props: { cards: GlanceCard[] }) {
  const cards = props.cards.filter(({ kind }) => kind)
  const total = cards.reduce((sum, { count }) => sum + count, 0)
  if (!total) return null
  const sum = (keep: (card: GlanceCard) => boolean) => cards.reduce((n, card) => n + (keep(card) ? card.count : 0), 0)

  const curve = Array.from({ length: 8 }, (_, cost) => sum((card) => Math.min(card.cost, 7) === cost))
  const tallest = Math.max(1, ...curve)
  const types = kinds.map((kind) => ({ kind, count: sum((card) => card.kind === kind) }))
  const widest = Math.max(1, ...types.map(({ count }) => count))

  // The aspects as printed on each card, a combination counted as one, most first
  const combos = new Map<string, { aspects: string[]; count: number }>()
  for (const card of cards) {
    const key = card.aspects.join(' ') || 'Neutral'
    combos.set(key, { aspects: card.aspects, count: (combos.get(key)?.count ?? 0) + card.count })
  }
  const slices = [...combos.values()].sort((a, b) => b.count - a.count)
  let from = 0
  const stops = slices.map(({ aspects, count }) => {
    const to = from + (count / total) * 360
    const stop = `${colorOf(aspects)} ${from}deg ${to}deg`
    from = to
    return stop
  })
  const average = cards.reduce((n, card) => n + card.cost * card.count, 0) / total

  return (
    <div className="deck-glance">
      <div className="deck-glance-title">
        {total} cards · average cost {average.toFixed(1)}
      </div>
      <div className="deck-glance-curve">
        {curve.map((count, cost) => (
          <div key={cost} className="deck-glance-bar">
            <span className="deck-glance-count">{count || ''}</span>
            <span className="deck-glance-fill" style={{ height: `${(count / tallest) * 100}%` }} />
            <span className="deck-glance-cost">{cost === 7 ? '7+' : cost}</span>
          </div>
        ))}
      </div>
      <ul className="deck-glance-types">
        {types.map(({ kind, count }) => (
          <li key={kind}>
            <span>{kind}</span>
            <span className="deck-glance-track">
              <span style={{ width: `${(count / widest) * 100}%` }} />
            </span>
            <span className="deck-glance-n">{count}</span>
          </li>
        ))}
      </ul>
      <div className="deck-glance-aspects">
        <span className="deck-glance-pie" style={{ background: `conic-gradient(${stops.join(', ')})` }} />
        <ul>
          {slices.map(({ aspects, count }) => (
            <li key={aspects.join(' ') || 'Neutral'}>
              <span className="deck-glance-icons">
                {aspects.length
                  ? aspects.map((aspect, index) => <img key={index} src={asset(`/icons/aspect/${aspect.toLowerCase()}.png`)} alt={aspect} />)
                  : 'Neutral'}
              </span>
              <span className="deck-glance-n">{count}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
