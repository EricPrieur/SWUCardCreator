import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { cardDef } from './engine/cards.ts'

// The DUNE set as the Simulator plays it, for the games the server runs (online games): the
// cards exported to public/showcase/DUNE. On this computer they are read there; on Railway,
// which has only the server, from the site, which has them as soon as they are pushed. Kept a
// while, then read again, so an export is played without a restart.
const localDir = fileURLToPath(new URL('../public/showcase/DUNE/', import.meta.url))
const SET_URL = (process.env.SET_URL ?? 'https://ericprieur.github.io/SWUCardCreator/showcase/DUNE/').replace(/\/?$/, '/')
const KEEP_FOR = 10 * 60 * 1000

let kept = null
let loading = null

async function readFile(name) {
  if (existsSync(localDir + 'showcase.json')) return JSON.parse(readFileSync(localDir + name, 'utf8'))
  const res = await fetch(SET_URL + encodeURIComponent(name), { cache: 'no-cache' })
  if (!res.ok) throw new Error(`${name}: ${res.status}`)
  return res.json()
}

// Each card's definition, a two-sided base's back as a card of its own (id#back), as in the
// Simulator
async function load() {
  const list = (await readFile('showcase.json')).cards
  const cards = await Promise.all(list.map((entry) => readFile(`${entry.image}.json`).catch(() => null)))
  const defs = []
  for (const card of cards) {
    const def = card && cardDef(card)
    if (!def) continue
    defs.push(def)
    const back = def.type === 'base' && card.backFrameId && cardDef({ ...card, id: `${card.id}#back`, frameId: card.backFrameId })
    if (back) defs.push(back)
  }
  return defs
}

export async function setDefs() {
  if (kept && Date.now() - kept.at < KEEP_FOR) return kept.defs
  loading ??= load()
    .then((defs) => {
      kept = { defs, at: Date.now() }
      return defs
    })
    .finally(() => {
      loading = null
    })
  // A read that fails keeps the cards read before, when there are some
  return loading.catch((err) => {
    if (kept) return kept.defs
    throw err
  })
}
