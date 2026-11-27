// Real Star Wars: Unlimited cards for the dev-only SWU tab: a swudb.com deck's cards, as the
// simulator and the Showcase page load a set (public/showcase/SWU, not in git: official cards
// and images stay on this computer). Each card's data comes from swudb.com, its image is the
// Hyperspace printing's (the normal one when there is none), and the deck joins the SWU
// Featured Decks (public/showcase/SWU/featured-decks.json).
//
//   node tools/swu-import.ts <swudb deck id or URL> [more decks…]
//   node tools/swu-import.ts https://swuforge.com/decks/<id> [more decks…]   (SWU Forge, id forge-<id>)
//   node tools/swu-import.ts https://www.swu-competitivehub.com/decklist/<id>/   (id hub-<id>)
//   node tools/swu-import.ts https://swudb.com/card/LAW/222 [more cards…]   (single cards, in no deck)
//
// Cached: each printing's data in public/showcase/SWU/raw, each image once. The card text is
// put in the Creator's markup ([When Played:], [Sentinel], [{Trait}]), so the engine reads its
// keywords and scripts (engine/swu.ts) are keyed by it as for DUNE.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const dir = `${root}public/showcase/SWU/`
const raw = `${dir}raw/`
mkdirSync(raw, { recursive: true })

// swudb's aspect numbers (checked on SOR cards: Vader Dark Lord of the Sith [1, 6], Han Solo [3, 5])
const ASPECTS = ['', 'Aggression', 'Command', 'Cunning', 'Vigilance', 'Heroism', 'Villainy']
const TYPES = ['Leader', 'Base', 'Unit', 'Event', 'Upgrade']
const RARITY = ['', 'C', 'U', 'R', 'L', 'S']
const KEYWORDS = ['sentinel', 'restore', 'ambush', 'shielded', 'saboteur', 'raid', 'overwhelm', 'grit', 'hidden', 'bounty', 'coordinate', 'piloting', 'exploit', 'smuggle', 'plot', 'support', 'fortify']

type Printing = {
  cardName: string
  title?: string
  isUnique: boolean
  isToken: boolean
  cardType: number
  cost: number | null
  traits?: string[]
  aspects: number[]
  power: number | null
  hitPoints: number | null
  // An upgrade's: what it gives the unit it is on
  powerBonus?: number | null
  hitPointBonus?: number | null
  arenaDescription?: string
  frontAbilityText?: string
  backAbilityText?: string
  frontImagePath?: string
  backImagePath?: string
  alternativePrintings: { expansionAbbreviation: string; cardNumber: string; variantType: number; foil: boolean; language: number; isCurrent: boolean; rarity: number }[]
}
type DeckCard = { defaultExpansionAbbreviation: string; defaultCardNumber: string; cardName: string; title?: string }
type Deck = { deckName: string; leader: DeckCard; base: DeckCard; shuffledDeck: { count: number; card: DeckCard }[] }

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function printing(set: string, number: string): Promise<Printing> {
  const file = `${raw}${set}-${number}.json`
  if (!existsSync(file)) {
    const response = await fetch('https://swudb.com/api/card/getPrintingInfo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expansionAbbreviation: set, cardNumber: number, isFoil: false, language: 'EN', stamp: null }),
    })
    if (!response.ok) throw new Error(`swudb: ${set} ${number}: ${response.status}`)
    writeFileSync(file, await response.text())
    await pause(250)
  }
  return JSON.parse(readFileSync(file, 'utf8'))
}

// An image saved as JPG (the Showcase page's), through Python's PIL
async function image(path: string, to: string) {
  if (existsSync(to)) return
  // Some paths start with ~ for the site root: ~/cards/TWI/489.png
  const response = await fetch(`https://swudb.com/images${path.replace(/^~/, "")}`)
  if (!response.ok) throw new Error(`swudb image ${path}: ${response.status}`)
  const png = `${to}.png`
  writeFileSync(png, Buffer.from(await response.arrayBuffer()))
  execFileSync('python', ['-I', '-c', 'import sys;from PIL import Image;Image.open(sys.argv[1]).convert("RGB").save(sys.argv[2],quality=90)', png, to])
  unlinkSync(png)
  await pause(250)
}

// swudb's markup to the Creator's: {p}…{/p} lines, {b}trigger:{/b} boxed, {i}reminders{/i} left
// out, {sentinel} / {restore:2} keywords, {trait}X{/trait} and {force} traits, {R1} costs, {T} exhaust
export function markup(text = '') {
  const lines: string[] = []
  for (const [, kind, body] of text.matchAll(/\{p([^}]*)\}([\s\S]*?)\{\/p\}/g)) {
    // The leader's deploy line ({p-epic-action-yellow}): its cost, which the engine knows
    if (kind.startsWith('-epic-action')) continue
    let line = body
      // "shares a TRAIT with this unit"
      .replace(/\{b\}\{i\}TRAIT\{\/i\}\{\/b\}/g, 'trait')
      // Reminder text, in brackets, goes; other italics stay
      .replace(/\{i\}\s*\([\s\S]*?\)\s*\{\/i\}/g, '')
      .replace(/\{\/?i\}/g, '')
      // "It gets {powerplus:2}/{hpplus:0}": +2/+0, boxed
      .replace(/\{powerplus:(\d+)\}\/\{hpplus:(\d+)\}/g, '[+$1/+$2]')
      .replace(/\{powerminus:(\d+)\}\/\{hpminus:(\d+)\}/g, '[-$1/-$2]')
      .replace(/<br\s*\/?>/g, '\n')
      .replace(/\{\/b\}\s*\{b\}/g, '')
      // Bold first (held as …), so the tag rule below doesn't take {b} for a keyword
      .replace(/\{b\}([\s\S]*?)\{\/b\}/g, '$1')
      .replace(/\{trait\}([^{]+)\{\/trait\}/g, '[{$1}]')
      .replace(/\{R(\d+)\}/g, '[$1]')
      .replace(/\{T\}/g, 'Arrow')
      .replace(/\{([a-z]+)(?::(\d+))?\}/g, (_, word: string, n?: string) => {
        const name = word.charAt(0).toUpperCase() + word.slice(1)
        if (KEYWORDS.includes(word)) return `[${name}${n ? ` ${n}` : ''}]`
        if (ASPECTS.includes(name)) return `[${name}]`
        return `[{${name}}]`
      })
      .replace(/\s*([\s\S]*?)\s*/g, '[$1] ')
      .replace(/\s+([.,])/g, '$1')
      // "[When you play a unit] :" (its colon left out of the bold): the trigger as the others are
      .replace(/\[(When [^\]]*?)\]\s*:/g, '[$1:]')
      // A trigger swudb didn't bold (Mon Cal Cruiser's "When Played: Choose one:")
      .replace(/^(When Played|On Attack|When Defeated|When Deployed)((?:\/[A-Z][A-Za-z ]+)*):/gm, '[$1$2:]')
    line = line
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n')
    if (line) lines.push(line)
  }
  return lines.join('\n')
}

const frameOf = (p: Printing) => {
  // A token unit (Beast, Clone Trooper): the frame the set's own tokens use, which cardDef reads;
  // a space one's (TIE Fighter, X-Wing: they came onto the ground, 2026-11-27)
  if (p.isToken && p.cardType === 2) return `unit-token-text-neutral${p.arenaDescription === 'Space' ? '-space' : ''}`
  // A token upgrade (Experience, Shield, Advantage): the engine's token frame, so it takes the
  // place of the built-in token of that name and never goes in a deck
  if (p.isToken && TYPES[p.cardType] === 'Upgrade') return 'token-upgrade'
  const type = TYPES[p.cardType]?.toLowerCase() ?? 'unit'
  const aspects = p.aspects.map((a) => ASPECTS[a].toLowerCase())
  const colors = aspects.filter((a) => !['heroism', 'villainy'].includes(a))
  const align = aspects.filter((a) => ['heroism', 'villainy'].includes(a))
  const words = [...new Set([...colors, ...align])]
  if (type === 'base') return `base-${words[0] ?? 'neutral'}-text`
  const space = type === 'unit' && p.arenaDescription === 'Space' ? ['space'] : []
  return [type, ...(words.length ? words : ['neutral']), ...space].join('-')
}

const fileName = (p: Printing) => `${p.cardName}${p.title ? ` - ${p.title}` : ''}`.replace(/[\\/:*?"<>|]/g, '')

async function card(set: string, number: string) {
  const p = await printing(set, number)
  const id = `swu-${set}-${number}`
  const name = fileName(p)
  const hyper = p.alternativePrintings.find((a) => a.variantType === 2 && !a.foil && a.language === 0)
  const art = hyper ? await printing(hyper.expansionAbbreviation, hyper.cardNumber) : p
  const front = art.frontImagePath ?? p.frontImagePath
  const back = p.backImagePath ? (art.backImagePath ?? p.backImagePath) : undefined
  if (front) await image(front, `${dir}${name}.jpg`)
  if (back) await image(back, `${dir}${name} (unit).jpg`)
  const type = TYPES[p.cardType]
  // A pilot (Han Solo, Has His Moments): a unit with an upgrade's +power/+HP too. Its Piloting box,
  // from the Piloting line on, is its pilotText, the cost as the Creator writes one: [[2 Cunning Heroism]]
  const pilot = type === 'Unit' && p.powerBonus != null
  const text = markup(p.frontAbilityText).split('\n')
  const box = pilot ? text.findIndex((line) => line.startsWith('[Piloting]')) : -1
  const pilotText =
    box >= 0
      ? text
          .slice(box)
          .join('\n')
          .replace(/^\[Piloting\] \[\[((?:\[[^\]]+\])+)\]\]/, (_, cost: string) => `[Piloting] [[${[...cost.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]).join(' ')}]]`)
      : undefined
  const saved = {
    id,
    frameId: pilot ? frameOf(p).replace(/^unit-/, 'pilot-') : frameOf(p),
    name: p.cardName,
    ...(p.title && { subtitle: p.title }),
    trait: (p.traits ?? []).join(', '),
    text: box >= 0 ? text.slice(0, box).join('\n') : text.join('\n'),
    ...(pilotText && { pilotText }),
    ...(p.backAbilityText && { backText: markup(p.backAbilityText) }),
    unique: p.isUnique,
    ...(p.cost !== null && { cost: p.cost }),
    ...(p.power !== null && { power: p.power }),
    ...(p.hitPoints !== null && { hp: p.hitPoints }),
    // An upgrade's +power/+HP are its stats; a pilot's, its upgrade stats
    ...(p.powerBonus != null && (pilot ? { upgradePower: p.powerBonus } : { power: p.powerBonus })),
    ...(p.hitPointBonus != null && (pilot ? { upgradeHp: p.hitPointBonus } : { hp: p.hitPointBonus })),
    setCode: set,
    number,
    rarity: RARITY[p.alternativePrintings.find((a) => a.isCurrent)?.rarity ?? 0] ?? '',
  }
  writeFileSync(`${dir}${name}.json`, JSON.stringify(saved, null, 2))
  const entry = {
    id,
    image: name,
    ...(back && { back: `${name} (unit)` }),
    name: p.cardName,
    ...(p.title && { subtitle: p.title }),
    type: p.isToken ? 'Token' : type,
    aspects: p.aspects.map((a) => ASPECTS[a]),
    ...(p.cost !== null && { cost: p.cost }),
    traits: p.traits ?? [],
    text: saved.text.toLowerCase().replace(/[[\]{}]/g, ''),
    set,
    number,
    ...(p.arenaDescription && { arena: p.arenaDescription }),
  }
  return { id, entry }
}

const showcaseFile = `${dir}showcase.json`
const showcase: { title: string; cards: { id: string }[] } = existsSync(showcaseFile)
  ? JSON.parse(readFileSync(showcaseFile, 'utf8'))
  : { title: 'Star Wars: Unlimited', cards: [] }
const featuredFile = `${dir}featured-decks.json`
const featured: { id?: string; name: string; leader: string; base: string; cards: { id: string; count: number }[] }[] = existsSync(featuredFile)
  ? JSON.parse(readFileSync(featuredFile, 'utf8'))
  : []

async function add(set: string, number: string) {
  const { id, entry } = await card(set, number)
  showcase.cards = [...showcase.cards.filter((c) => c.id !== id), entry]
  return id
}

// A token by name, its first printing on swudb
const tokensDone = new Set<string>()
async function token(name: string) {
  if (tokensDone.has(name) || ['Experience', 'Shield'].includes(name)) return
  tokensDone.add(name)
  const response = await fetch(`https://swudb.com/api/search/${encodeURIComponent(name)}?sortdir=asc&grouping=cards&sortorder=name`)
  const found: { printings: { cardName: string; isToken: boolean; expansionAbbreviation: string; cardNumber: string }[] } = await response.json()
  const t = found.printings.find((p) => p.isToken && p.cardName === name)
  if (!t) return console.log(`No ${name} token on swudb`)
  await add(t.expansionAbbreviation, t.cardNumber)
  console.log(`Token: ${name} (${t.expansionAbbreviation} ${t.cardNumber})`)
}

// The tokens a card creates or gives (Experience and Shield are the engine's own)
async function tokensOf(id: string) {
  const entry = showcase.cards.find((c) => c.id === id) as unknown as { image: string }
  const text = JSON.parse(readFileSync(`${dir}${entry.image}.json`, 'utf8'))
  for (const [, name] of `${text.text ?? ''}
${text.backText ?? ''}`.matchAll(/(?:[Cc]reate|[Gg]ive) (?:a|an|\d+) ([A-Z][\w-]*(?: [A-Z][\w-]*)*) tokens?/g)) await token(name)
}

for (const arg of process.argv.slice(2)) {
  // A single card: swudb.com/card/<set>/<number>[/name], added to the Showcase, in no deck
  const single = arg.match(/\/card\/([A-Za-z0-9]+)\/([A-Za-z0-9]+)/)
  if (single) {
    const id = await add(single[1].toUpperCase(), single[2])
    await tokensOf(id)
    console.log(`Card: ${id}`)
    continue
  }
  // A deck on SWU Forge: swuforge.com/decks/<id>, read from the page's data (SvelteKit's
  // __data.json, its values flattened into one array, each object's fields pointing into it)
  const forge = arg.match(/swuforge\.com\/decks\/([A-Za-z0-9]+)/)
  if (forge) {
    const forgeId = forge[1]
    const response = await fetch(`https://swuforge.com/decks/${forgeId}/__data.json`)
    if (!response.ok) throw new Error(`SWU Forge deck ${forgeId}: ${response.status}`)
    const doc: { nodes: ({ type: string; data: unknown[] } | null)[] } = await response.json()
    writeFileSync(`${raw}forge-${forgeId}.json`, JSON.stringify(doc))
    type ForgeCard = { cardNumber: number; title: string; type: { name: string }; expansion: { code: string } }
    type ForgeDeck = { name: string; mainDeck: { card: ForgeCard; count: number }[] }
    let deck: ForgeDeck | undefined
    for (const node of doc.nodes) {
      if (node?.type !== 'data') continue
      const data = node.data
      const memo = new Map<number, unknown>()
      const at = (i: unknown): unknown => {
        if (typeof i !== 'number' || i < 0) return undefined
        if (memo.has(i)) return memo.get(i)
        const v = data[i]
        if (Array.isArray(v)) {
          const out: unknown[] = []
          memo.set(i, out)
          for (const x of v) out.push(at(x))
          return out
        }
        if (v && typeof v === 'object') {
          const out: Record<string, unknown> = {}
          memo.set(i, out)
          for (const [k, x] of Object.entries(v)) out[k] = at(x)
          return out
        }
        return v
      }
      const root = at(0) as { deck?: ForgeDeck } | undefined
      if (root?.deck?.mainDeck) deck = root.deck
    }
    if (!deck) throw new Error(`SWU Forge deck ${forgeId}: no deck in its data`)
    const card = (c: ForgeCard) => add(c.expansion.code, String(c.cardNumber).padStart(3, '0'))
    // Its leader and base are in its main deck, one copy each; the sideboard stays out
    const leaderCard = deck.mainDeck.find((e) => e.card.type?.name === 'Leader')?.card
    const baseCard = deck.mainDeck.find((e) => e.card.type?.name === 'Base')?.card
    if (!leaderCard || !baseCard) throw new Error(`SWU Forge deck ${forgeId}: no leader or base`)
    const leader = await card(leaderCard)
    const base = await card(baseCard)
    const cards: { id: string; count: number }[] = []
    for (const { count, card: c } of deck.mainDeck) if (c !== leaderCard && c !== baseCard && count > 0) cards.push({ id: await card(c), count })
    for (const id of [leader, base, ...cards.map((c) => c.id)]) await tokensOf(id)
    const name = deck.name
    const id = `forge-${forgeId}`
    featured.splice(0, featured.length, ...featured.filter((d) => d.id !== id && d.name !== name), { id, name, leader, base, cards })
    console.log(`${name}: ${cards.reduce((s, c) => s + c.count, 0)} cards, ${cards.length + 2} distinct`)
    continue
  }
  // A decklist on SWU Competitive Hub: swu-competitivehub.com/decklist/<id>/, its "Copy JSON"
  // (the SWU deck format: metadata, leader, base, deck, sideboard; ids like LOF_002) read from
  // the page, where it sits escaped twice inside the page's data
  const hub = arg.match(/swu-competitivehub\.com\/decklist\/(\d+)/)
  if (hub) {
    const hubId = hub[1]
    const response = await fetch(`https://www.swu-competitivehub.com/decklist/${hubId}/`, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!response.ok) throw new Error(`SWU Competitive Hub decklist ${hubId}: ${response.status}`)
    const page = await response.text()
    const start = page.indexOf('metadata')
    if (start < 0) throw new Error(`SWU Competitive Hub decklist ${hubId}: no deck JSON in the page`)
    // Its escaping undone (\\\" to "), then the object read to its closing brace
    const tail = page.slice(page.lastIndexOf('{', start)).replaceAll('\\\\\\"', '"').replaceAll('\\\\"', '"').replaceAll('\\"', '"')
    let depth = 0
    let end = 0
    for (let i = 0; i < tail.length; i++) {
      if (tail[i] === '{') depth++
      else if (tail[i] === '}' && --depth === 0) {
        end = i + 1
        break
      }
    }
    type HubDeck = { metadata: { name: string }; leader: { id: string }; base: { id: string }; deck: { id: string; count: number }[] }
    const deck: HubDeck = JSON.parse(tail.slice(0, end))
    writeFileSync(`${raw}hub-${hubId}.json`, JSON.stringify(deck))
    const card = (code: string) => {
      const [set, number] = code.split('_')
      return add(set, number)
    }
    const leader = await card(deck.leader.id)
    const base = await card(deck.base.id)
    const cards: { id: string; count: number }[] = []
    for (const { id: code, count } of deck.deck) if (count > 0) cards.push({ id: await card(code), count })
    for (const id of [leader, base, ...cards.map((c) => c.id)]) await tokensOf(id)
    const name = deck.metadata.name
    const id = `hub-${hubId}`
    featured.splice(0, featured.length, ...featured.filter((d) => d.id !== id && d.name !== name), { id, name, leader, base, cards })
    console.log(`${name}: ${cards.reduce((s, c) => s + c.count, 0)} cards, ${cards.length + 2} distinct`)
    continue
  }
  const deckId = arg.replace(/^.*\/deck\//, '').replace(/[/?#].*$/, '')
  const response = await fetch(`https://swudb.com/api/deck/${deckId}`)
  if (!response.ok) throw new Error(`swudb deck ${deckId}: ${response.status}`)
  const deck: Deck = await response.json()
  writeFileSync(`${raw}deck-${deckId}.json`, JSON.stringify(deck))
  const at = (c: DeckCard) => add(c.defaultExpansionAbbreviation, c.defaultCardNumber)
  const leader = await at(deck.leader)
  const base = await at(deck.base)
  const cards: { id: string; count: number }[] = []
  // Sideboard cards are listed with no copies in the deck
  for (const { count, card: c } of deck.shuffledDeck) if (count > 0) cards.push({ id: await at(c), count })
  for (const id of [leader, base, ...cards.map((c) => c.id)]) await tokensOf(id)
  const name = deck.deckName
  // Its id is swudb's: importing it again replaces it, and the SWU Deck Builder knows it
  const id = `swudb-${deckId}`
  featured.splice(0, featured.length, ...featured.filter((d) => d.id !== id && d.name !== name), { id, name, leader, base, cards })
  console.log(`${name}: ${cards.reduce((s, c) => s + c.count, 0)} cards, ${cards.length + 2} distinct`)
}
showcase.cards.sort((a, b) => (a as unknown as { set: string; number: string }).set.localeCompare((b as unknown as { set: string }).set) || (a as unknown as { number: string }).number.localeCompare((b as unknown as { number: string }).number))
writeFileSync(showcaseFile, JSON.stringify(showcase, null, 2))
writeFileSync(featuredFile, JSON.stringify(featured, null, 2))
console.log(`${showcase.cards.length} SWU cards in ${dir}`)
