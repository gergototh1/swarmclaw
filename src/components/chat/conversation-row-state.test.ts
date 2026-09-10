import test, { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { conversationRowState } from './conversation-row-state'

test('semmi sem tortent -> se olvasatlan, se dolgozik', () => {
  assert.deepEqual(conversationRowState({}), { unread: false, isError: false, working: false })
})

test('olvasatlan valasz', () => {
  const s = conversationRowState({ lastAssistantAt: 200, lastReadAt: 100 })
  assert.equal(s.unread, true)
  assert.equal(s.isError, false)
})

test('hibas turn -> olvasatlan, hibakent', () => {
  const s = conversationRowState({ lastAssistantAt: 100, lastFailedTurnAt: 200, lastReadAt: 50 })
  assert.equal(s.unread, true)
  assert.equal(s.isError, true)
})

test('active -> dolgozik', () => {
  assert.equal(conversationRowState({ active: true }).working, true)
})

test('a dolgozik fuggetlen az olvasatlantol: egyszerre is igaz lehet', () => {
  const s = conversationRowState({ active: true, lastAssistantAt: 200, lastReadAt: 100 })
  assert.equal(s.working, true)
  assert.equal(s.unread, true)
})

test('active hianyzik vagy false -> nem dolgozik', () => {
  assert.equal(conversationRowState({ active: false }).working, false)
  assert.equal(conversationRowState({}).working, false)
})

import { conversationDot } from './conversation-dot'

/*
 * Egy pont egy dolgot tud mutatni, a `conversationRowState` viszont három
 * FÜGGETLEN boolt ad -- egy chat lehet egyszerre olvasatlan és dolgozó.
 * A precedencia tehát itt dől el, és abban a sorrendben, ami cselekvést kér:
 * a hiba magától nem múlik el, a "dolgozik" pár másodperc múlva úgyis
 * olvasatlanná válik.
 */
describe('conversationDot', () => {
  it('shows the error first, because it does not resolve on its own', () => {
    assert.equal(conversationDot({ unread: true, isError: true, working: true }), 'error')
  })

  it('shows working over a plain unread, because working is live', () => {
    assert.equal(conversationDot({ unread: true, isError: false, working: true }), 'working')
  })

  it('shows unread when nothing is running', () => {
    assert.equal(conversationDot({ unread: true, isError: false, working: false }), 'unread')
  })

  it('shows nothing on a settled conversation', () => {
    assert.equal(conversationDot({ unread: false, isError: false, working: false }), 'none')
  })

  it('shows working on a read conversation the agent picked back up', () => {
    assert.equal(conversationDot({ unread: false, isError: false, working: true }), 'working')
  })

  it('does not call it an error when the error is not the unread thing', () => {
    // isError csak akkor igaz, ha a hiba az UTOLSÓ esemény -- ezt a
    // sessionUnreadState dönti el, itt csak nem írjuk felül.
    assert.equal(conversationDot({ unread: true, isError: false, working: false }), 'unread')
  })
})
