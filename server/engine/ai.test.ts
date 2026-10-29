import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chooseAction } from './ai.ts'
import { cardDef, printedKeywords, randomDeck, type SavedCard } from './cards.ts'
import { scripts, scriptStatus } from './scripts.ts'
import { applyAction, createGame } from './game.ts'
import type { CardDef, PlayerId } from './types.ts'

test('keywords are read from lines of their own, not from what a unit gains', () => {
  assert.deepEqual(printedKeywords('[Sentinel]\n[Raid 2]\n[On Attack:] Deal 1 damage.'), { sentinel: true, raid: 2 })
  assert.deepEqual(printedKeywords('While you control an [{Arrakis}] base, this unit gains [Raid 1].'), {})
  assert.deepEqual(printedKeywords('[Restore 1]\n[Restore 2]'), { restore: 3 })
})

test('a saved leader becomes a leader with its unit side on the back', () => {
  const leader = cardDef({
    id: 'mohiam',
    frameId: 'leader-vigilance-villainy',
    backFrameId: 'leader-vigilance-villainy-unit',
    name: 'Reverend Mother Mohiam',
    trait: 'Bene Gesserit, Emperor',
    text: '[Action [[1, Arrow]]:] Choose an enemy unit.',
    backText: '[Sentinel]\n[On Attack:] Choose an enemy unit.',
    cost: 7,
    power: 4,
    hp: 8,
  }) as CardDef
  assert.equal(leader.type, 'leader')
  assert.deepEqual(leader.aspects, ['Vigilance', 'Villainy'])
  assert.deepEqual(leader.traits, ['Bene Gesserit', 'Emperor'])
  assert.deepEqual(leader.unit, { power: 4, hp: 8, arena: 'ground', keywords: { sentinel: true } })
  assert.equal(cardDef({ id: 's', frameId: 'unit-cunning-space', name: 'Ship', power: 2, hp: 3 })?.arena, 'space')
  const fremen = cardDef({ id: 'f', frameId: 'unit-token-text-neutral', name: 'Fremen', text: 'While you control an [{Arrakis}] base, this unit gains [Raid 1].' })
  assert.equal(fremen?.type, 'unit')
  assert.equal(fremen?.token, true)
  assert.deepEqual(fremen?.arrakisKeywords, { raid: 1 })
  assert.equal(cardDef({ id: 'p', frameId: 'spice-token', name: 'Spice' })?.type, 'token')
})

// The DUNE set as exported, when it is there to read
function duneDefs(): CardDef[] | undefined {
  const folder = new URL('../../public/showcase/DUNE/', import.meta.url)
  try {
    const list: { image: string; type: string }[] = JSON.parse(readFileSync(new URL('showcase.json', folder), 'utf8')).cards
    return list
      .map((e) => cardDef(JSON.parse(readFileSync(new URL(`${e.image}.json`, folder), 'utf8')) as SavedCard))
      .filter((d): d is CardDef => !!d)
  } catch {
    return undefined
  }
}

test('two AIs play a game of random DUNE decks to the end', (t) => {
  const defs = duneDefs()
  if (!defs) return t.skip('no DUNE export')
  for (const seed of [1, 2, 3]) {
    // A seeded stand-in for Math.random, so the decks are the same each run
    let n = seed
    const random = () => ((n = (n * 16807) % 2147483647) / 2147483647)
    const decks = [0, 1].map((i) => {
      const deck = randomDeck(defs, random)
      assert.equal(deck.deck.length, 50)
      const [leader, base] = [deck.leader, deck.base].map((id) => defs.find((d) => d.id === id) as CardDef)
      assert.ok(!base.aspects.some((a) => leader.aspects.includes(a)), 'the base adds an aspect the leader lacks')
      for (const id of new Set(deck.deck)) assert.ok(deck.deck.filter((d) => d === id).length <= 3)
      return { name: `AI ${i}`, ...deck }
    })
    let state = createGame({ seed, defs, decks: decks as never })
    let steps = 0
    while (state.phase !== 'over' && steps++ < 2000) {
      const p = ([0, 1] as PlayerId[]).find((q) => chooseAction(state, q)) as PlayerId
      state = applyAction(state, p, chooseAction(state, p)!)
    }
    assert.equal(state.phase, 'over', `seed ${seed} ended`)
    assert.ok(state.round > 2, 'it took a few rounds')
  }
})

test('every script quotes its DUNE card exactly, so it plays it', (t) => {
  const defs = duneDefs()
  if (!defs) return t.skip('no DUNE export')
  for (const script of scripts) {
    const card: CardDef | undefined = defs.find((d: CardDef) => d.name === script.name && (d.subtitle ?? '') === (script.subtitle ?? ''))
    assert.ok(card, `${script.name} is a DUNE card`)
    assert.equal(scriptStatus(card), 'scripted', `${script.name}'s script quotes its text`)
  }
})
