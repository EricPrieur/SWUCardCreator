// The production Community queue, read from here: the cards players submitted to be played that
// still need a script, with what a script needs (key, frame, stats, traits, text, the lines the
// engine doesn't play yet). Through the same admin API the Admin panel uses, signed in as an admin.
//
//   node tools/prod-queue.ts          the cards that need a script (or a script brought up to date)
//   node tools/prod-queue.ts --all    every card in the queue
//   node tools/prod-queue.ts --json   as JSON, every field
//
// server/.env (gitignored) holds PROD_ADMIN_TOKEN: an admin's sign-in token, from the site's
// browser console: JSON.parse(localStorage['dune-unlimited.account']).token. It lasts 30 days.
// PROD_API_URL: the production API (default below).
import 'dotenv/config'

const API = (process.env.PROD_API_URL ?? 'https://swu-api-production.up.railway.app').replace(/\/$/, '')
const token = process.env.PROD_ADMIN_TOKEN
if (!token) {
  console.error("Set PROD_ADMIN_TOKEN in server/.env: on the site, signed in as an admin, run in the browser console\n  JSON.parse(localStorage['dune-unlimited.account']).token")
  process.exit(1)
}

const res = await fetch(`${API}/api/admin/community`, { headers: { Authorization: `Bearer ${token}` } })
if (!res.ok) {
  console.error(`${res.status} ${res.statusText}: ${res.status === 401 ? 'the token has expired or is not an admin one; take a new one' : await res.text()}`)
  process.exit(1)
}
const { cards } = (await res.json()) as { cards: any[] }
const all = process.argv.includes('--all')
const shown = all || process.argv.includes('--json') ? cards : cards.filter((c) => c.engine === 'none' || c.engine === 'outdated')

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(shown, null, 2))
} else if (!shown.length) {
  console.log(`No card needs a script (${cards.length} in the queue; --all to list them).`)
} else {
  for (const c of shown) {
    const card = c.card ?? {}
    console.log(`--- ${[c.entry.name, c.entry.subtitle].filter(Boolean).join(', ')}  [${c.status}${c.auto ? ', automatically' : ''}, ${c.engine}]`)
    console.log(`key: ${c.key}   version ${c.version}, by ${c.owner}`)
    console.log(`type: ${c.entry.type}, frame ${card.frameId ?? '?'}${card.unique ? ', unique' : ''}`)
    console.log(
      `cost ${card.cost ?? '?'}, power ${card.power ?? '?'}, HP ${card.hp ?? '?'}` +
        (card.upgradePower !== undefined || card.upgradeHp !== undefined ? `, as an upgrade +${card.upgradePower ?? 0}/+${card.upgradeHp ?? 0}` : ''),
    )
    console.log(`traits: ${card.trait || '-'}`)
    if (card.text !== undefined) {
      for (const [label, value] of [['text', card.text], ['pilotText', card.pilotText], ['backText', card.backText]] as const)
        if (value) console.log(`${label}: ${JSON.stringify(value)}`)
    } else console.log(`text:\n${(c.text || '(none)').replace(/^/gm, '  ')}`)
    if (c.unplayed?.length) console.log(`not played yet:\n${c.unplayed.map((l: string) => `  - ${l}`).join('\n')}`)
    console.log()
  }
}
