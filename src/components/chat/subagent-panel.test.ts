import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { subagentPanelWarning, isCurrentPanelFrame, describeSubagentPanelError } from './subagent-panel'

/*
 * Futó jobba írva a subagent kap egy sort a queue-jába, miközben a szülő
 * ügynök a handle.promise-ra vár -- az eredmény más lesz, mint amit a szülő
 * kért. Nem tiltjuk, de megmondjuk, mielőtt a felhasználó beleír.
 */
describe('subagentPanelWarning', () => {
  it('warns while the job is still running', () => {
    const text = subagentPanelWarning(true, 'Sidekick')
    assert.ok(text)
    assert.match(text as string, /Sidekick/)
  })

  it('says nothing once the job has finished', () => {
    assert.equal(subagentPanelWarning(false, 'Sidekick'), null)
  })

  it('falls back to a generic subject when the parent has no name', () => {
    const text = subagentPanelWarning(true, null)
    assert.ok(text)
    assert.doesNotMatch(text as string, /null/)
  })
})

/*
 * A panel breadcrumb-verme lehetővé teszi, hogy a felhasználó egy beágyazott
 * subagentet megnyisson (frame B), majd MIELŐTT B lekérése lefutna,
 * visszalépjen a szülőre (frame A). `isCurrentPanelFrame` a `load()` egyetlen
 * védelme az ellen, hogy egy elavult (elhagyott frame-hez tartozó) válasz
 * felülírja az időközben aktívvá vált frame adatait.
 *
 * A React-effektus bekötése (hogy `load()` ténylegesen ezt a függvényt
 * hívja meg lezáráskor, és hogy `activeSessionIdRef` frame-váltáskor tényleg
 * frissül) `renderToStaticMarkup`-pal NEM ellenőrizhető -- az nem futtat
 * effektusokat. Ez a teszt csak a kivont, tiszta döntési logikát pinneli le;
 * a tényleges huzalozást az élő ellenőrzés (session 6c24aacf) igazolja.
 */
describe('isCurrentPanelFrame', () => {
  it('accepts a response for the frame the user is still looking at', () => {
    assert.equal(isCurrentPanelFrame('session-a', 'session-a'), true)
  })

  it('rejects a response for a frame the user has already left', () => {
    // Nested open (A -> B) then back (B -> A) before B's slower fetch
    // resolves: B's response must not be applied once A is active again.
    assert.equal(isCurrentPanelFrame('session-b', 'session-a'), false)
  })
})

/*
 * `load`, `send` és `stop` mindegyike az `api<T>()`-re támaszkodik, ami nem
 * 2xx válaszon vagy hálózati hibán dob. A panelnek nincs hova jelentenie a
 * hibát -- ez a szöveg jelenik meg a felületén, retryelhető állapotban.
 */
describe('describeSubagentPanelError', () => {
  it('names the failed action and includes the underlying message for load', () => {
    const text = describeSubagentPanelError('load', new Error('Request failed (500)'))
    assert.match(text, /betölteni/)
    assert.match(text, /Request failed \(500\)/)
  })

  it('names the failed action for send', () => {
    const text = describeSubagentPanelError('send', new Error('Unauthorized — invalid access key'))
    assert.match(text, /elküldeni/)
    assert.match(text, /Unauthorized/)
  })

  it('names the failed action for stop', () => {
    const text = describeSubagentPanelError('stop', new Error('Request timed out after 12000ms'))
    assert.match(text, /leállítani/)
    assert.match(text, /timed out/)
  })

  it('falls back to a generic detail for a non-Error rejection', () => {
    const text = describeSubagentPanelError('load', 'network down')
    assert.match(text, /ismeretlen hiba/)
  })
})
