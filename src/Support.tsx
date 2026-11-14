import { useAccount } from './api'
import { STEP_CENTS, TIER_NAMES, tierOf } from '../server/tiers.ts'

export const KOFI = 'https://ko-fi.com/ericprieur'

// The support tiers and their perks (server/tiers.ts holds the numbers): shown on the Support page
// (#support) and, shorter, on the Ko-fi link's hover
const dollars = (cents: number) => `$${cents / 100}`
export const TIERS = [
  {
    id: 'visitor',
    price: 'Free',
    perks: ['Make cards in the Card Creator', 'Build decks, and play the Simulator against the AI or online', 'Your cards and decks kept in this browser'],
  },
  {
    id: 'member',
    price: 'Free account',
    perks: [
      'Your cards, their art and your decks saved to your account: 50 MB, on any computer',
      'Share your cards on the Community tab and your own Showroom page',
      'Submit your cards to be played in the Community Deck Builder and Simulator',
      'Notifications and mail',
    ],
  },
  {
    id: 'supporter',
    price: `${dollars(STEP_CENTS)} or more in tips`,
    perks: [
      `50 MB more storage for each ${dollars(STEP_CENTS)}`,
      "The Deck Builder's Prescient (full art) and Foil copies",
      'A card back of your own, shown to both players in the Simulator',
      'My thanks: you keep the server running',
    ],
  },
] as const

export function SupportPage() {
  const account = useAccount()
  const mine = account ? tierOf(account.user) : 'visitor'
  return (
    <section className="support-page">
      <h2>Support the project</h2>
      <p className="support-intro">
        The site is free, and stays free. Tips on Ko-fi pay for the server that keeps your cards and runs the online games, and they come
        with a few perks.
      </p>
      <div className="support-tiers">
        {TIERS.map((tier) => (
          <div key={tier.id} className={`support-tier${tier.id === mine ? ' support-mine' : ''}`}>
            <h3>{TIER_NAMES[tier.id]}</h3>
            <div className="support-price">{tier.price}</div>
            <ul>
              {tier.perks.map((perk) => (
                <li key={perk}>{perk}</li>
              ))}
            </ul>
            {tier.id === mine && <div className="support-you">{account ? 'Your tier' : 'You, now'}</div>}
          </div>
        ))}
      </div>
      <h3>How to</h3>
      <ol className="support-how">
        <li>{account ? 'You have an account: you are set.' : 'Register an account (top right): it is free.'}</li>
        <li>
          Tip on{' '}
          <a href={KOFI} target="_blank" rel="noopener noreferrer">
            Ko-fi
          </a>
          , with your username on this site in the tip's message.
        </li>
        <li>I add it to your account by hand, usually within a few days. Your tips add up: each {dollars(STEP_CENTS)} is 50 MB more.</li>
      </ol>
      <p className="support-intro">Your tier and your tips are in your account's Settings.</p>
      <a className="button button-primary support-kofi" href={KOFI} target="_blank" rel="noopener noreferrer">
        Support on Ko-fi
      </a>
    </section>
  )
}

// The Ko-fi link's hover: the tiers in a line each, and the way to the Support page
export function KofiHover() {
  return (
    <div className="kofi-pop" role="tooltip">
      <strong>Tips come with perks</strong>
      <p className="kofi-pop-line">
        <b>Supporter</b>, from {dollars(STEP_CENTS)}:
      </p>
      <ul>
        <li>50 MB more storage for each {dollars(STEP_CENTS)}</li>
        <li>Prescient and Foil copies in the Deck Builder</li>
        <li>A card back of your own in the Simulator</li>
      </ul>
      <span className="kofi-pop-note">Put your username in the tip's message.</span>
      <a href="#support">See the tiers</a>
    </div>
  )
}
