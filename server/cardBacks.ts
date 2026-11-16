// The card back a deck shows in the Simulator, for the server's games and the site's alike: the
// back of the set most of its cards are of. Each card's back is its set's (an image id), or
// DUNE's (null) for a DUNE card or a set with none; on a tie, DUNE's.
export function deckBack(ids: (string | null | undefined)[], backOf: (id: string) => string | null | undefined): string | null {
  const counts = new Map<string | null, number>()
  for (const id of ids) {
    if (!id) continue
    const back = backOf(id) ?? null
    counts.set(back, (counts.get(back) ?? 0) + 1)
  }
  let best: string | null = null
  let most = counts.get(null) ?? 0
  let tied = false
  for (const [back, count] of counts) {
    if (back === null) continue
    if (count > most) {
      best = back
      most = count
      tied = false
    } else if (count === most) tied = true
  }
  return tied ? null : best
}

// A set code as a set back is kept under: as typed on the card line, in capitals
export const setCode = (code: unknown) => String(code ?? '').trim().toUpperCase().slice(0, 32)
