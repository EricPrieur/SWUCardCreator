import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseAction, type Weighed } from './ai.ts'
import { createGame } from './game.ts'
import { recordAction, replay, startRecord } from './record.ts'
import { deckList, loadDefs } from '../tools/dune.ts'

test('A recorded game replays to exactly the same game, the AI noting the moves it weighed', () => {
  const defs = loadDefs()
  const decks = [deckList('rabban', defs), deckList('jessica', defs)] as [ReturnType<typeof deckList>, ReturnType<typeof deckList>]
  const record = startRecord(7, decks, [{ kind: 'ai' }, { kind: 'ai' }])
  let state = createGame({ seed: 7, defs, decks })
  // The first rounds are enough
  for (let steps = 0; state.phase !== 'over' && state.round < 4 && steps < 2000; steps++) {
    const p = ([0, 1] as const).find((q) => chooseAction(state, q))!
    const why: Weighed[] = []
    state = recordAction(record, state, p, chooseAction(state, p, why)!, why.slice(0, 3))
  }
  assert.ok(record.actions.some((step) => step.why?.length), 'the AI noted what it weighed')
  const again = replay(JSON.parse(JSON.stringify(record)), defs)
  const { defs: _a, ...was } = state
  const { defs: _b, ...is } = again
  assert.deepEqual(is, was)
  // Kept in Postgres, whose JSONB puts each action's keys in its own order
  const reordered = { ...record, actions: record.actions.map((step) => ({ ...step, action: Object.fromEntries(Object.entries(step.action).reverse()) as typeof step.action })) }
  const { defs: _c, ...kept } = replay(reordered, defs)
  assert.deepEqual(kept, was)
})
