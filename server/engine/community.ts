import type { CardScript } from './scripts.ts'

// The scripts of community cards: cards players made in the Creator and submitted to be played
// (Showroom, Submit for play). Each names its card by '<account id>/<card id>', as the Admin
// panel's Community queue shows it, and quotes the card's text as submitted, like DUNE's
// scripts: an edited card waits for its script to be brought up to date. A card whose text the
// engine plays by itself (keywords only) needs none.
//
// Kept apart from DUNE's (scripts.ts): two cards of the same name, a DUNE one and a community
// one, or two players', each keep their own script.
export const communityScripts: (CardScript & { card: string })[] = [
  // {
  //   card: '7/3f2a…',
  //   name: 'Card name',
  //   text: '[When Played:] …',
  //   front: { whenPlayed: (g, self) => { … } },
  // },
]
