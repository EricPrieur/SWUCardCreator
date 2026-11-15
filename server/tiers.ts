// The support tiers, for the server and the site alike. Tips come through Ko-fi, and an admin
// adds them to the account by hand (Admin panel, Users): a tip makes a Supporter, and each $5
// adds storage.
//   Visitor: not signed in, cards kept in this browser
//   Member: a free account, cards saved on the server
//   Supporter: $5 or more, 50 MB more storage and 50 more cards in play for each $5, the Deck
//   Builder's Prescient and Foil copies, and a card back of one's own

export const MB = 1024 * 1024
export const BASE_STORAGE = 50 * MB
export const STORAGE_PER_STEP = 50 * MB
export const STEP_CENTS = 500

export type Tier = 'member' | 'supporter'
export const TIER_NAMES: Record<Tier | 'visitor', string> = {
  visitor: 'Visitor',
  member: 'Member',
  supporter: 'Supporter',
}

// An admin has every perk
export function tierOf(user: { isAdmin?: boolean; donatedCents?: number }): Tier {
  return user.isAdmin || (user.donatedCents ?? 0) >= STEP_CENTS ? 'supporter' : 'member'
}
export const isSupporter = (user: { isAdmin?: boolean; donatedCents?: number } | null | undefined) => !!user && tierOf(user) === 'supporter'

// The storage tips give: the base, and 50 MB for each $5
export const storageFor = (cents: number) => BASE_STORAGE + STORAGE_PER_STEP * Math.floor(Math.max(0, cents) / STEP_CENTS)

// The cards an account may have in play (submitted to the Community Deck Builder and Simulator,
// supported or waiting): 50, and 50 more for each $5. An admin's have no limit (null).
export const BASE_PLAY_CARDS = 50
export const PLAY_CARDS_PER_STEP = 50
export const playCardsFor = (user: { isAdmin?: boolean; donatedCents?: number }) =>
  user.isAdmin ? null : BASE_PLAY_CARDS + PLAY_CARDS_PER_STEP * Math.floor(Math.max(0, user.donatedCents ?? 0) / STEP_CENTS)
