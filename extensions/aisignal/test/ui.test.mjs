import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'

import { renderToStaticMarkup } from 'react-dom/server'
import { jsx } from 'react/jsx-runtime'

import { readBoard, readItemsPage, readManagedStatus } from '../ui/api.ts'
import { bundle } from '../scripts/build.mjs'
import { Deck } from '../ui/deck.tsx'
import {
  UNDO_DEPTH, beginDecision, createDeckController, deckKeyAction, deckKeyListener, initialDeck, remainingUndecided, stampFor,
} from '../ui/deck-state.ts'
import { cappedNote, describeGmail, describeManaged, describeOutcome, formatDate, formatScore, noteSegments, statusBadge, sweepOutcome } from '../ui/format.ts'
import { ListBody } from '../ui/list.tsx'
import { loadList } from '../ui/list-state.ts'
import { MANAGED_RESOURCES_URL, loadManagedStatus } from '../ui/managed-state.ts'
import { StatusBar, StatusBarBody } from '../ui/status-bar.tsx'

/**
 * The page, driven without a browser.
 *
 * The state that a click or a key press changes lives in plain modules
 * (deck-state.ts, list-state.ts, format.ts) and is driven directly. What a
 * state looks like once drawn is pinned by rendering the component for it to
 * static markup and reading the string: that is enough to see a stranger's
 * headline arrive as text, a refused query arrive as its message, and a
 * capped list say so.
 */

function item(overrides = {}) {
  return {
    id: 'i1', headline: 'h', summary: 's', url: 'https://example.test/a', source_name: 'src', sent_at: '2026-09-01T10:00:00.000Z',
    score: 0.4, apply_score: 0.8, why: 'w', link_read: 1, status: 'new', decided_at: null, created_at: '2026-09-01T10:00:00.000Z',
    ...overrides,
  }
}

function sweep(overrides = {}) {
  return {
    id: 'sw1', ran_at: '2026-09-01T10:00:00.000Z', label: 'AI hírlevél', ok: 1, note: '', finished_at: '2026-09-01T10:01:00.000Z',
    found: 0, leftover: 0, messages: 0, kind: 'mail', ...overrides,
  }
}

function board(overrides = {}) {
  return {
    deck: [], deckLimit: 50, undecided: 0, allLimit: 200, sweeps: [], sweepLimit: 10,
    counts: { items: 0, undecided: 0, sweeps: 0, seen: 0 }, label: 'AI hírlevél', gmail: { status: 'ready' },
    ...overrides,
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

const render = (type, props) => renderToStaticMarkup(jsx(type, props))

/**
 * The OPEN bar. The shell owns the fold; what a state looks like once drawn is
 * the body's. The closed bar's one line is pinned separately, on the shell.
 */
const renderStatus = ({ onRefresh, ...props }) => render(StatusBarBody, props)
const noop = () => {}
const decideOk = async (id) => ({ ok: true, id, status: 'saved' })
const noAct = async () => {}

// --- build ---

test('the built bundle carries no React of its own and resolves the host modules', async () => {
  const result = await bundle({ write: false })
  const text = result.outputFiles.map((f) => f.text).join('\n')
  // The two the page imports resolve against the host table; react-dom is
  // imported by nothing here and so appears nowhere, bundled or looked up.
  for (const name of ['react', 'react/jsx-runtime']) {
    assert.ok(text.includes(`host.modules[${JSON.stringify(name)}]`), `${name} resolves against window.swarmclaw.modules`)
  }
  assert.equal(text.includes('react-dom'), false)
  // Strings every React build carries and this bundle must not.
  assert.equal(text.includes('Invalid hook call'), false)
  assert.equal(text.includes('react.production'), false)
  assert.equal(text.includes('react.development'), false)
  assert.ok(text.includes("registerPage('aisignal'") || text.includes('registerPage("aisignal"'))
})

/**
 * The registration contract, run the way the host runs it: the built bundle
 * executed as a classic script in a window that carries `swarmclaw.modules`
 * and a `currentScript` stamped with the extension id. Three things the host
 * registry refuses are pinned here: a `react` that is not the host's own
 * object, an `extensionId` that is not the one on the tag, and a page id
 * other than the one `index.mjs` declares.
 */
test('the built bundle registers the declared page with the host React and the id the loader stamped', async () => {
  const result = await bundle({ write: false })
  const code = result.outputFiles.find((f) => f.path.endsWith('.js')).text
  const registrations = []
  class HTMLElement { constructor(dataset) { this.dataset = dataset } }
  const window = {
    swarmclaw: {
      modules: { react: React, 'react/jsx-runtime': jsxRuntime },
      registerPage: (pageId, component, opts) => registrations.push({ pageId, component, opts }),
    },
  }
  const document = { currentScript: new HTMLElement({ extension: 'aisignal.mjs' }) }
  vm.runInNewContext(code, { window, document, HTMLElement, Error, Object, console }, { filename: 'dist/index.js' })
  assert.equal(registrations.length, 1)
  const [{ pageId, component, opts }] = registrations
  assert.equal(pageId, 'aisignal')
  assert.equal(opts.extensionId, 'aisignal.mjs')
  assert.equal(opts.react, React, 'the very object on window.swarmclaw.modules, not a copy')
  assert.equal(typeof component, 'function')
  // The registered component renders with the props the host passes; before
  // its first load lands it says so rather than drawing an empty board.
  const html = renderToStaticMarkup(jsx(component, { extensionId: 'aisignal.mjs', rpc: async () => ({}) }))
  assert.ok(html.includes('data-extension="aisignal.mjs"'))
  assert.ok(html.includes('Betöltés'))
  assert.equal(html.includes('ais-status'), false)
})

test('the built bundle names the missing host module instead of failing inside React', async () => {
  const result = await bundle({ write: false })
  const code = result.outputFiles.find((f) => f.path.endsWith('.js')).text
  const window = { swarmclaw: { modules: {}, registerPage: () => {} } }
  assert.throws(() => vm.runInNewContext(code, { window, document: { currentScript: null }, Error, Object }), /host module missing: react/)
})

// --- api readers: a malformed answer is refused, not drawn as an empty board ---

test('readBoard refuses a response without its lists instead of yielding an empty board', () => {
  assert.throws(() => readBoard({}), /hiányos.*"deck"/)
  assert.throws(() => readBoard({ ...board(), gmail: { status: 'nope' } }), /"gmail"/)
  assert.throws(() => readBoard({ ...board(), counts: undefined }), /"counts"/)
  assert.throws(() => readBoard(null), /"board"/)
  assert.throws(() => readBoard('<!doctype html>'), /"board"/)
  const ok = readBoard(board({ gmail: { status: 'unavailable', reason: 'provider_disabled' } }))
  assert.deepEqual(ok.gmail, { status: 'unavailable', reason: 'provider_disabled', code: undefined })
  assert.equal(ok.allLimit, 200)
  assert.equal(ok.sweepLimit, 10)
  assert.throws(() => readItemsPage({ items: [] }), /"total"/)
})

test('readBoard requires only what the page reads: no row list beside the deck, no count beside the items', () => {
  // The list asks `items` for its own page. A board that ships no `all` is
  // whole, and one that does is not refused either; nothing reads it.
  assert.equal('all' in board(), false, 'the fixture is the shape the server now sends')
  const plain = readBoard(board())
  assert.equal('all' in plain, false)
  assert.equal('all' in readBoard({ ...board(), all: [item()] }), false)
  assert.deepEqual(Object.keys(readItemsPage({ total: 1, items: [item()] })), ['total', 'items'])
})

// --- words for facts ---

test('describeGmail gives each reason its own sentence and offers the Gmail page only where it is the next step', () => {
  const ready = describeGmail({ status: 'ready' })
  const reasons = ['provider_missing', 'provider_disabled', 'version_mismatch', 'not_declared']
  const lines = reasons.map((reason) => describeGmail({ status: 'unavailable', reason }))
  const error = describeGmail({ status: 'error', code: 'aisignal_contract_check_failed' })

  // Four reasons, four operator actions, four sentences: none folds into
  // another and none folds into the ready one.
  assert.equal(new Set([ready.text, ...lines.map((l) => l.text), error.text]).size, 6)

  // `ready` says the contract resolves and does NOT say the mailbox is
  // connected -- this extension holds no credential and cannot see that.
  assert.equal(ready.page, true)
  assert.match(ready.text, /Gmail lapon/)

  // The link is offered only where the page it points at exists and is the
  // remedy. A provider that is not loaded contributes no page at all.
  assert.deepEqual(lines.map((l) => l.page), [false, false, true, false])
  assert.equal(error.page, false)
  assert.match(error.text, /aisignal_contract_check_failed/)
  assert.match(error.text, /nem tudni/)

  // A reason this page has no word for is shown as it arrived rather than
  // folded into one of the four, and it is not a reason to offer a link.
  const strange = describeGmail({ status: 'unavailable', reason: 'valami_uj' })
  assert.match(strange.text, /valami_uj/)
  assert.equal(strange.page, false)
  const silent = describeGmail({ status: 'unavailable' })
  assert.equal(silent.page, false)
  assert.match(silent.text, /nem mondta meg/)
})

test('sweepOutcome keeps unfinished, failed, nothing and found apart', () => {
  const unfinished = sweep({ finished_at: null })
  const failed = sweep({ ok: 0, note: 'gmail_unauthorized: the credential was refused' })
  const nothing = sweep({ found: 0 })
  const found = sweep({ found: 3 })
  assert.equal(sweepOutcome(unfinished), 'unfinished')
  assert.equal(sweepOutcome(failed), 'failed')
  assert.equal(sweepOutcome(nothing), 'nothing')
  assert.equal(sweepOutcome(found), 'found')
  const sentences = [unfinished, failed, nothing, found].map(describeOutcome)
  assert.equal(new Set(sentences).size, 4)
  assert.match(sentences[0], /nincs lezárva/)
  assert.match(sentences[1], /gmail_unauthorized/)
  assert.match(sentences[2], /0 új sort/)
  assert.match(sentences[3], /3 új sor/)
  // A failure with no finished_at is still reported as not closed: the row
  // says nothing about why, and "failed" would claim more than it knows.
  assert.equal(sweepOutcome(sweep({ ok: 0, finished_at: null })), 'unfinished')
})

test('noteSegments words the two clock segments as what the run did, not as what the agent said', () => {
  const held = noteSegments('frontier_held=clock_ahead')
  assert.deepEqual(held, [{ key: 'frontier_held', text: 'a vízjel nem mozdult: a gép órája előrébb járt a lezáráskor' }])
  const ahead = noteSegments('frontier_ahead=2026-09-05T15:00:00.000Z; skipped=3')
  assert.equal(ahead[0].key, 'frontier_ahead')
  assert.equal(ahead[0].text, 'a tárolt vízjel (2026-09-05T15:00:00.000Z) a jövőben volt, a futás a korábbi biztos ablaktól indult')
  assert.deepEqual(ahead[1], { key: 'skipped', text: 'skipped=3' })
})

test('noteSegments keeps a source that failed apart from one that was never asked', () => {
  const segments = noteSegments('unavailable=reddit,hn; unasked=reddit; dropped=4; frontier=abc')
  assert.deepEqual(segments.map((s) => s.key), ['unavailable', 'unasked', 'dropped', 'frontier'])
  assert.match(segments[0].text, /nem válaszolt: reddit, hn/)
  assert.match(segments[1].text, /meg sem lett kérdezve: reddit/)
  assert.match(segments[2].text, /4 jelölt kimaradt/)
  assert.equal(segments[3].text, 'frontier=abc')
  assert.deepEqual(noteSegments(''), [])
  assert.deepEqual(noteSegments(null), [])
})

test('statusBadge shows an unknown status raw and flagged rather than folding it into a known one', () => {
  assert.deepEqual(statusBadge('saved'), { label: 'mentett', known: true })
  assert.deepEqual(statusBadge('saevd'), { label: 'saevd', known: false })
  assert.deepEqual(statusBadge(''), { label: '(üres státusz)', known: false })
  assert.equal(statusBadge('constructor').known, false)
  assert.equal(statusBadge('constructor').label, 'constructor')
})

test('formatScore and formatDate never throw on a row that is not the shape they expect', () => {
  assert.equal(formatScore(0.5), '0.50')
  assert.equal(formatScore(null), '?')
  assert.equal(formatScore('0.5'), '?')
  assert.equal(formatDate(null), '')
  assert.equal(formatDate('not a date'), 'not a date')
  assert.match(formatDate('2026-09-01T10:00:00.000Z'), /2026/)
})

test('cappedNote names both numbers only when rows are behind the cap', () => {
  assert.equal(cappedNote(200, 200, 'sor'), '')
  assert.equal(cappedNote(3, 3, 'sor'), '')
  assert.equal(cappedNote(200, 4318, 'sor'), '200 sor látszik, összesen 4318')
})

// --- deck state ---

test('stampFor shows a stamp only past the threshold', () => {
  assert.equal(stampFor(0), null)
  assert.equal(stampFor(0.25), null)
  assert.equal(stampFor(0.26), 'save')
  assert.equal(stampFor(-0.25), null)
  assert.equal(stampFor(-0.26), 'archive')
})

test('deckKeyAction ignores editable targets and maps the keys', () => {
  const key = (k, extra = {}) => deckKeyAction({ key: k, metaKey: false, ctrlKey: false, altKey: false, target: null, ...extra })
  assert.equal(key('ArrowLeft'), 'archive')
  assert.equal(key('ArrowRight'), 'save')
  assert.equal(key('Enter'), 'open')
  assert.equal(key('u'), 'undo')
  assert.equal(key('z', { metaKey: true }), 'undo')
  assert.equal(key('Z', { ctrlKey: true }), 'undo')
  assert.equal(key('x'), null)
  assert.equal(key('ArrowLeft', { ctrlKey: true }), null)
  assert.equal(key('ArrowLeft', { altKey: true }), null)
  assert.equal(key('ArrowLeft', { target: { tagName: 'input' } }), null)
  assert.equal(key('u', { target: { tagName: 'TEXTAREA' } }), null)
  assert.equal(key('u', { target: { tagName: 'DIV', isContentEditable: true } }), null)
  assert.equal(key('u', { target: { tagName: 'DIV' } }), 'undo')
  assert.equal(key('u', { target: { tagName: 'BODY', tabIndex: -1 } }), 'undo')
  // A key on a focused control is the control's: Enter activates a button, a
  // link or a summary, and the arrows move along a tablist. The three tags
  // are the ones the review hit; the tabIndex rule catches the rest.
  assert.equal(key('Enter', { target: { tagName: 'BUTTON', tabIndex: 0 } }), null)
  assert.equal(key('Enter', { target: { tagName: 'A', tabIndex: 0 } }), null)
  assert.equal(key('Enter', { target: { tagName: 'SUMMARY' } }), null)
  assert.equal(key('ArrowRight', { target: { tagName: 'BUTTON', tabIndex: 0 } }), null)
  assert.equal(key('ArrowLeft', { target: { tagName: 'button' } }), null)
  assert.equal(key('u', { target: { tagName: 'A' } }), null)
  assert.equal(key('Enter', { target: { tagName: 'DIV', tabIndex: 0 } }), null, 'a div the host made focusable')
  assert.equal(key('Enter', { target: { tagName: 'IFRAME' } }), null)
  assert.equal(key('Enter', { target: { tagName: 'SELECT' } }), null)
})

/**
 * The review's failing sequence: with the deck mounted, Tab to the "Lista"
 * tab, "Gmail lap", "Ment →" or the "Korábbi futások" summary, press
 * Enter, and the control did not activate; the top card's url opened in a
 * new tab instead. Arrow keys on the tablist decided cards. The listener the
 * deck installs must leave the key -- default included -- to the control.
 */
test("the deck's key listener leaves Enter and the arrows to a focused control and takes them from the body", () => {
  const calls = []
  const onKey = deckKeyListener({
    commit: (decision) => calls.push(['commit', decision]),
    open: () => calls.push(['open']),
    undo: () => calls.push(['undo']),
  })
  const press = (key, target) => {
    let prevented = false
    const taken = onKey({ key, metaKey: false, ctrlKey: false, altKey: false, target, preventDefault: () => { prevented = true } })
    return { taken, prevented }
  }
  const controls = [
    { tagName: 'BUTTON', tabIndex: 0, role: 'tab' },   // the "Lista" tab
    { tagName: 'A', tabIndex: 0 },                      // "Gmail lap"
    { tagName: 'BUTTON', tabIndex: 0 },                 // "Ment →"
    { tagName: 'SUMMARY', tabIndex: 0 },                // "Korábbi futások"
  ]
  for (const target of controls) {
    for (const key of ['Enter', 'ArrowRight', 'ArrowLeft', 'u']) {
      assert.deepEqual(press(key, target), { taken: false, prevented: false }, `${key} on ${target.tagName} is the control's`)
    }
  }
  assert.deepEqual(calls, [], 'no url opened, no card decided')

  const body = { tagName: 'BODY', tabIndex: -1 }
  assert.deepEqual(press('Enter', body), { taken: true, prevented: true })
  assert.deepEqual(press('ArrowRight', body), { taken: true, prevented: true })
  assert.deepEqual(press('ArrowLeft', { tagName: 'DIV', tabIndex: -1, className: 'ais-card' }), { taken: true, prevented: true })
  assert.deepEqual(press('u', body), { taken: true, prevented: true })
  assert.deepEqual(press('x', body), { taken: false, prevented: false })
  assert.deepEqual(calls, [['open'], ['commit', 'save'], ['commit', 'archive'], ['undo']])
})

test('a decision leaves the screen at once and counts against the undecided total', () => {
  const state = initialDeck([item({ id: 'a' }), item({ id: 'b' })])
  const begun = beginDecision(state, 'save')
  assert.equal(begun.item.id, 'a')
  assert.deepEqual(begun.state.queue.map((q) => q.id), ['b'])
  assert.deepEqual(begun.state.undo.map((u) => u.item.id), ['a'])
  assert.equal(remainingUndecided(7, begun.state), 6)
  assert.equal(beginDecision(initialDeck([]), 'save'), null)
})

test('deck controller: a decision the write refused comes back to the front with its message and no undo entry', async () => {
  const controller = createDeckController([item({ id: 'a' }), item({ id: 'b' })], async () => { throw new Error('sqlite is read-only') })
  const seen = []
  controller.subscribe(() => seen.push(controller.getState().queue.map((q) => q.id)))
  await controller.commit('save')
  const state = controller.getState()
  // It left first (optimistic), then came back.
  assert.deepEqual(seen[0], ['b'])
  assert.deepEqual(state.queue.map((q) => q.id), ['a', 'b'])
  assert.equal(state.undo.length, 0)
  assert.equal(state.decided, 0)
  assert.match(state.toast, /nem mentődött el: sqlite is read-only/)
})

test('deck controller: a decision that landed on a vanished row is not re-queued and says so', async () => {
  const controller = createDeckController([item({ id: 'a' }), item({ id: 'b' })], async (id) => ({ ok: false, id, status: 'saved' }))
  await controller.commit('archive')
  const state = controller.getState()
  assert.deepEqual(state.queue.map((q) => q.id), ['b'])
  assert.equal(state.undo.length, 0, 'nothing to undo: no row was written')
  assert.equal(state.decided, 0, 'a write that touched no row did not decide anything')
  assert.match(state.toast, /eltűnt/)
})

test('deck controller: a malformed decide answer is a failure, not a landed decision', async () => {
  const controller = createDeckController([item({ id: 'a' })], async () => 'yes')
  await controller.commit('save')
  const state = controller.getState()
  assert.deepEqual(state.queue.map((q) => q.id), ['a'])
  assert.match(state.toast, /hiányos/)
})

test('deck controller: undo is ten deep, newest first, and a failed undo restores the entry', async () => {
  const cards = Array.from({ length: 12 }, (_, i) => item({ id: `c${i}` }))
  let fail = false
  const calls = []
  const controller = createDeckController(cards, async (id, decision) => {
    calls.push([id, decision])
    if (fail) throw new Error('offline')
    return { ok: true, id, status: 'x' }
  })
  for (let i = 0; i < 12; i++) await controller.commit(i % 2 ? 'save' : 'archive')
  assert.equal(controller.getState().undo.length, UNDO_DEPTH)
  assert.equal(controller.getState().undo[0].item.id, 'c11')
  assert.equal(controller.getState().decided, 12)

  await controller.undoLast()
  assert.deepEqual(controller.getState().queue.map((q) => q.id), ['c11'])
  assert.equal(controller.getState().undo.length, UNDO_DEPTH - 1)
  assert.equal(controller.getState().decided, 11)
  assert.deepEqual(calls.at(-1), ['c11', 'undo'])

  fail = true
  await controller.undoLast()
  const state = controller.getState()
  // c10's undo threw: it is not back in the queue, its entry is back on the stack.
  assert.deepEqual(state.queue.map((q) => q.id), ['c11'])
  assert.equal(state.undo[0].item.id, 'c10')
  assert.equal(state.decided, 11)
  assert.match(state.toast, /visszavonás nem sikerült: offline/)

  await controller.undoLast() // still failing; nothing changes but the toast
  assert.deepEqual(controller.getState().queue.map((q) => q.id), ['c11'])
  controller.dismissToast()
  assert.equal(controller.getState().toast, null)
  assert.equal(calls.length, 15)
})

test('deck controller: an undo that lands on a vanished row drops the entry and says so', async () => {
  let vanished = false
  const controller = createDeckController([item({ id: 'a' })], async (id) => ({ ok: !vanished, id, status: 'x' }))
  await controller.commit('save')
  vanished = true
  await controller.undoLast()
  const state = controller.getState()
  assert.deepEqual(state.queue, [])
  assert.equal(state.undo.length, 0)
  assert.match(state.toast, /nincs mit visszavonni/)
})

// --- rendering: a stranger's text arrives as text ---

test('the deck renders a hostile headline as text and refuses a javascript: link', () => {
  const hostile = item({
    headline: '<img src=x onerror=alert(1)>',
    summary: '</div><script>alert(2)</script>',
    why: '"><b>x</b>',
    source_name: '<i>src</i>',
    url: 'javascript:alert(3)',
  })
  const html = render(Deck, { board: board({ deck: [hostile], undecided: 1, sweeps: [sweep()] }), decide: decideOk, onChanged: noop })
  assert.equal(html.includes('<img'), false)
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'))
  assert.equal(html.includes('<script'), false)
  assert.equal(html.includes('<b>x</b>'), false)
  assert.equal(html.includes('<i>src</i>'), false)
  assert.equal(html.includes('href="javascript:'), false)
  assert.ok(html.includes('A link nem megnyitható (nem http/https): javascript:alert(3)'))
  assert.equal(html.includes('ais-stamp'), false, 'no stamp before a drag')
})

test('the deck links an http(s) url with noopener and shows the pile behind the top card', () => {
  const html = render(Deck, {
    board: board({ deck: [item({ id: 'a', url: 'https://example.test/a?x=1&y=2' }), item({ id: 'b' }), item({ id: 'c' }), item({ id: 'd' })], undecided: 4, sweeps: [sweep()] }),
    decide: decideOk, onChanged: noop,
  })
  assert.ok(html.includes('href="https://example.test/a?x=1&amp;y=2"'))
  assert.ok(html.includes('rel="noopener noreferrer"'))
  assert.equal((html.match(/ais-card-behind-/g) || []).length, 2)
  assert.ok(html.includes('Még 4 a pakliban · 4 eldöntetlen összesen'))
})

test('the deck flags a card whose link was never read', () => {
  const html = render(Deck, { board: board({ deck: [item({ link_read: 0 })], undecided: 1, sweeps: [sweep()] }), decide: decideOk, onChanged: noop })
  assert.ok(html.includes('LINK NEM OLVASVA'))
  const read = render(Deck, { board: board({ deck: [item({ link_read: 1 })], undecided: 1, sweeps: [sweep()] }), decide: decideOk, onChanged: noop })
  assert.equal(read.includes('LINK NEM OLVASVA'), false)
})

test('the deck says the pile is capped when more is undecided than was dealt', () => {
  const deck = Array.from({ length: 50 }, (_, i) => item({ id: `c${i}` }))
  const html = render(Deck, { board: board({ deck, deckLimit: 50, undecided: 4318, sweeps: [sweep({ found: 5 })] }), decide: decideOk, onChanged: noop })
  assert.ok(html.includes('Még 50 a pakliban · 4318 eldöntetlen összesen · a pakli 50 kártyás'))
  const whole = render(Deck, { board: board({ deck: deck.slice(0, 3), deckLimit: 50, undecided: 3, sweeps: [sweep({ found: 3 })] }), decide: decideOk, onChanged: noop })
  assert.equal(whole.includes('a pakli 50 kártyás'), false)
})

test('an empty deck tells never swept, all decided and more behind apart', () => {
  const never = render(Deck, { board: board(), decide: decideOk, onChanged: noop })
  const done = render(Deck, { board: board({ sweeps: [sweep({ found: 2 })], undecided: 0 }), decide: decideOk, onChanged: noop })
  const behind = render(Deck, { board: board({ sweeps: [sweep({ found: 2 })], undecided: 120 }), decide: decideOk, onChanged: noop })
  assert.ok(never.includes('Még nem futott sweep'))
  assert.ok(done.includes('minden eldöntve'))
  assert.ok(behind.includes('Még 120 eldöntetlen signal vár'))
  assert.equal(done.includes('Még nem futott sweep'), false)
  assert.equal(behind.includes('minden eldöntve'), false)
})

// --- rendering: the list ---

test('loadList turns a refused query into a refused state carrying the message', async () => {
  const refusing = async () => { throw new Error('q must be at most 200 characters: a shortened search matches more than was asked for') }
  const state = await loadList(refusing, { status: 'all', q: 'x'.repeat(201), limit: 200 })
  assert.equal(state.kind, 'refused')
  assert.match(state.message, /q must be at most 200/)
  const malformed = await loadList(async () => ({ items: [] }), { status: 'all', q: '', limit: 200 })
  assert.equal(malformed.kind, 'refused')
  const calls = []
  const ok = await loadList(async (method, body) => { calls.push([method, body]); return { total: 1, count: 1, items: [item()] } }, { status: 'saved', q: 'a', limit: 200 })
  assert.equal(ok.kind, 'ok')
  assert.deepEqual(Object.keys(ok), ['kind', 'page'], 'the state carries the page and nothing the list does not read')
  assert.deepEqual(calls, [['items', { status: 'saved', q: 'a', order: 'recent', limit: 200 }]])
})

test('the list shows a refused query as its error, not as an empty list', () => {
  const props = { status: 'all', q: 'x'.repeat(201), notice: null, onStatus: noop, onQuery: noop, onNotice: noop, onAct: noAct }
  const refused = render(ListBody, { ...props, state: { kind: 'refused', message: 'q must be at most 200 characters' } })
  assert.ok(refused.includes('A lekérdezést a szerver elutasította'))
  assert.ok(refused.includes('q must be at most 200 characters'))
  assert.equal(refused.includes('0 sor'), false)
  assert.equal(refused.includes('Nincs ilyen sor'), false)
  const empty = render(ListBody, { ...props, q: 'zzz', state: { kind: 'ok', page: { total: 0, items: [] } } })
  assert.ok(empty.includes('0 sor'))
  assert.ok(empty.includes('Nincs ilyen sor erre a keresésre'))
  assert.equal(empty.includes('elutasította'), false)
})

test('a capped list says it is capped, with both numbers', () => {
  const items = Array.from({ length: 200 }, (_, i) => item({ id: `r${i}` }))
  const props = { status: 'all', q: '', notice: null, onStatus: noop, onQuery: noop, onNotice: noop, onAct: noAct }
  const capped = render(ListBody, { ...props, state: { kind: 'ok', page: { total: 4318, items } } })
  assert.ok(capped.includes('4318 sor'))
  assert.ok(capped.includes('200 sor látszik, összesen 4318'))
  const whole = render(ListBody, { ...props, state: { kind: 'ok', page: { total: 200, items } } })
  assert.equal(whole.includes('látszik, összesen'), false)
})

test('the list renders a hostile row as text, flags an unknown status and refuses a data: link', () => {
  const rows = [
    item({ id: 'a', headline: '<script>alert(1)</script>', status: 'saevd', url: 'data:text/html,hi' }),
    item({ id: 'b', status: 'saved', url: 'https://ok.test/' }),
  ]
  const props = { status: 'all', q: '', notice: null, onStatus: noop, onQuery: noop, onNotice: noop, onAct: noAct }
  const html = render(ListBody, { ...props, state: { kind: 'ok', page: { total: 2, items: rows } } })
  assert.equal(html.includes('<script>'), false)
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(html.includes('ais-badge ais-badge-bad">saevd<'))
  assert.ok(html.includes('ais-badge">mentett<'))
  assert.equal(html.includes('href="data:'), false)
  assert.ok(html.includes('nem http/https): data:text/html,hi'))
  assert.ok(html.includes('href="https://ok.test/"'))
})

test('the list shows a decision that failed as a notice', () => {
  const props = { status: 'all', q: '', notice: 'A döntés nem mentődött el: offline', onStatus: noop, onQuery: noop, onNotice: noop, onAct: noAct, state: { kind: 'ok', page: { total: 0, items: [] } } }
  assert.ok(render(ListBody, props).includes('A döntés nem mentődött el: offline'))
})

// --- rendering: the status bar ---

test('the aisignal bar is closed on first draw and shows none of the detail', () => {
  const html = render(StatusBar, { board: board(), managed: { kind: 'ready', schedules: 2 }, onRefresh: noop })
  assert.ok(html.includes('aria-expanded="false"'))
  assert.equal(html.includes('Utolsó sweep:'), false)
  assert.equal(html.includes('címke:'), false)
})

test('an unreachable mailbox is named on the closed bar, because no card will arrive until it is fixed', () => {
  const html = render(StatusBar, {
    board: board({ gmail: { status: 'provider_missing' } }), managed: { kind: 'ready', schedules: 2 }, onRefresh: noop,
  })
  assert.ok(html.includes('aria-expanded="false"'), 'still closed')
  assert.ok(html.includes('ais-warn'))
})

test('a never-scheduled install is named on the closed bar', () => {
  const html = render(StatusBar, {
    board: board(), managed: { kind: 'unscheduled', missing: ['AI Signal sweep'], total: 2 }, onRefresh: noop,
  })
  assert.ok(html.includes('ais-warn'))
})

test('the status bar tells an install that never swept from a sweep that found nothing', () => {
  const never = renderStatus({ managed: null, board: board({ gmail: { status: 'unavailable', reason: 'provider_missing' } }), onRefresh: noop })
  assert.ok(never.includes('Még nem futott sweep'))
  assert.ok(never.includes('a gmail extension nincs telepítve'))
  // No link: the page the link would point at belongs to the extension that is
  // not there, so it would land on the extension route's own "no such page".
  assert.equal(never.includes('href="/x/gmail"'), false)

  const quiet = renderStatus({ managed: null, board: board({ sweeps: [sweep({ found: 0 })], counts: { items: 0, undecided: 0, sweeps: 1, seen: 0 } }), onRefresh: noop })
  assert.ok(quiet.includes('lefutott, 0 új sort talált'))
  assert.equal(quiet.includes('Még nem futott sweep'), false)
  assert.ok(quiet.includes('szerződése elérhető'))
  // And there the link is offered, because the credential's own state is on
  // that page and this one cannot report it.
  assert.ok(quiet.includes('href="/x/gmail"'))
  assert.ok(quiet.includes('Gmail lap'))
  // The old OAuth start route is not linked from this page any more: the
  // consent belongs to the gmail extension now.
  assert.equal(quiet.includes('/api/oauth/google/start'), false)
})

test('the status bar keeps a failed, an unfinished and a truncated sweep distinct and shows their notes as text', () => {
  const failed = renderStatus({ managed: null, board: board({ sweeps: [sweep({ ok: 0, note: 'gmail_unauthorized: <b>refused</b>' })] }), onRefresh: noop })
  assert.ok(failed.includes('hiba: gmail_unauthorized: &lt;b&gt;refused&lt;/b&gt;'))
  assert.equal(failed.includes('<b>refused</b>'), false)
  const unfinished = renderStatus({ managed: null, board: board({ sweeps: [sweep({ finished_at: null })] }), onRefresh: noop })
  assert.ok(unfinished.includes('nincs lezárva'))
  assert.equal(unfinished.includes('hiba:'), false)
  const truncated = renderStatus({ managed: null, board: board({ sweeps: [sweep({ found: 4, leftover: 9 })] }), onRefresh: noop })
  assert.ok(truncated.includes('4 új sor'))
  assert.ok(truncated.includes('9 levél kimaradt a sapka miatt'))
  const research = renderStatus({ managed: null, board: board({ sweeps: [sweep({ kind: 'research', found: 2, note: 'unavailable=reddit,hn; unasked=hn' })] }), onRefresh: noop })
  assert.ok(research.includes('kutatás'))
  assert.ok(research.includes('nem válaszolt: reddit, hn'))
  assert.ok(research.includes('meg sem lett kérdezve: hn'))
})

test('the status bar sends an operator nowhere when the check itself failed', () => {
  const html = renderStatus({ managed: null, board: board({ gmail: { status: 'error', code: 'aisignal_contract_check_failed' } }), onRefresh: noop })
  assert.ok(html.includes('aisignal_contract_check_failed'))
  assert.equal(html.includes('href="/x/gmail"'), false)
  assert.equal(html.includes('nincs telepítve'), false)
})

test('the status bar says the sweep history is capped, from the board&#x27;s own numbers'.replace('&#x27;', "'"), () => {
  const sweeps = Array.from({ length: 10 }, (_, i) => sweep({ id: `s${i}` }))
  const html = renderStatus({ managed: null, board: board({ sweeps, sweepLimit: 10, counts: { items: 0, undecided: 0, sweeps: 43, seen: 0 } }), onRefresh: noop })
  assert.ok(html.includes('Korábbi futások (10 futás látszik, összesen 43)'))
  const whole = renderStatus({ managed: null, board: board({ sweeps: sweeps.slice(0, 3), sweepLimit: 10, counts: { items: 0, undecided: 0, sweeps: 3, seen: 0 } }), onRefresh: noop })
  assert.ok(whole.includes('Korábbi futások (3)'))
  assert.ok(html.includes('címke: AI hírlevél'))
})

// --- the sheet, the build script and the package, read as text ---

/**
 * The two behind-cards are `inset: 0` against the stack, so the stack's box is
 * theirs. With a floor on the stack they hung ~130px below a short top card as
 * a bare panel; the stack must take its height from the card alone.
 */
test('the pile behind the top card is sized by the card, not by a floor on the stack', () => {
  const css = source('ui/style.css')
  const rule = (selector) => {
    const escaped = selector.replace(/[.]/g, '\\.')
    const m = css.match(new RegExp('(?:^|\\n)' + escaped + '\\s*\\{([^}]*)\\}'))
    assert.ok(m, `${selector} is in the sheet`)
    return m[1]
  }
  const stack = rule('.ais-card-stack')
  assert.equal(/min-height|height\s*:/.test(stack), false, `no height of its own: ${stack.trim()}`)
  assert.match(stack, /position:\s*relative/)
  const behind = rule('.ais-card-behind')
  assert.match(behind, /position:\s*absolute/)
  assert.match(behind, /inset:\s*0/)
})

/**
 * The terminology rule covers comments, so the word is not written here
 * either: it is taken from the one place it may appear, esbuild's own option
 * key at the build call, and every other line of the script is checked
 * against it.
 */
test("the build script's comments say extension; esbuild's option key is the one line that does not", () => {
  const lines = source('scripts/build.mjs').split('\n')
  const optionKey = /^\s*(plugins):\s*\[/
  const keyLines = lines.filter((line) => optionKey.test(line))
  assert.equal(keyLines.length, 1, "esbuild's option key stays, once")
  const word = optionKey.exec(keyLines[0])[1].replace(/s$/, '')
  const offending = lines.filter((line) => line.toLowerCase().includes(word) && !optionKey.test(line))
  assert.deepEqual(offending, [])
})

/**
 * `npm test` here runs `node --import tsx` and the tests import react; both
 * resolved from the repo root until they were declared, so the extension's
 * own `npm test` failed anywhere but inside this monorepo. Every package the
 * tests, the page and the build import must be one the package declares.
 */
test("the extension's package declares every package its own test run imports", () => {
  const pkg = JSON.parse(source('package.json'))
  assert.match(pkg.scripts.test, /--import tsx/)
  const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
  const files = ['test', 'ui', 'scripts'].flatMap((dir) => fs.readdirSync(path.join(root, dir)).map((f) => `${dir}/${f}`))
  const imported = new Set()
  for (const file of files) {
    for (const m of source(file).matchAll(/^import (?:[^'"]*from )?['"]([^'".][^'"]*)['"]/gm)) {
      const spec = m[1]
      if (spec.startsWith('node:')) continue
      imported.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])
    }
  }
  assert.ok(imported.has('tsx') || pkg.scripts.test.includes('tsx'))
  for (const name of [...imported, 'tsx'].sort()) {
    assert.ok(declared.includes(name), `${name} is imported but not declared in package.json`)
  }
})

// --- the schedule line: scheduled, not scheduled, and could not ask ---

/** The host's managed-resources summary, as `GET /api/extensions/managed-resources` returns it. */
function summary(schedules, extensionId = 'aisignal.mjs') {
  return { extensions: [{ extensionId, extensionName: 'AI Signal', agents: [], schedules, localFolders: [], gatewayPlatforms: [], setupChecks: [] }], totals: {} }
}
const resolved = (name) => ({ resourceKind: 'schedule', resourceKey: name, displayName: name, status: 'resolved', resourceId: 'x', declarationHash: 'h' })
const missingRef = (name) => ({ resourceKind: 'schedule', resourceKey: name, displayName: name, status: 'missing_ref', resourceId: null, declarationHash: 'h' })

test('the managed-status reader tells every schedule resolved from any schedule missing, and refuses a summary that says nothing about this extension', () => {
  assert.deepEqual(readManagedStatus(summary([resolved('A'), resolved('B')]), 'aisignal.mjs'), { kind: 'ready', schedules: 2 })
  assert.deepEqual(readManagedStatus(summary([resolved('A'), missingRef('B')]), 'aisignal.mjs'), { kind: 'unscheduled', missing: ['B'], total: 2 })
  // A fresh install: nothing was reconciled, so neither schedule resolves.
  assert.deepEqual(readManagedStatus(summary([missingRef('A'), missingRef('B')]), 'aisignal.mjs'), { kind: 'unscheduled', missing: ['A', 'B'], total: 2 })
  // Not this extension, no schedules at all, or not the shape at all: each is
  // refused by name rather than read as "scheduled" or as "not scheduled".
  assert.throws(() => readManagedStatus(summary([resolved('A')], 'other.mjs'), 'aisignal.mjs'), /nem tartalmazza ezt az extensiont/)
  assert.throws(() => readManagedStatus(summary([]), 'aisignal.mjs'), /egyetlen ütemezést sem deklarál/)
  assert.throws(() => readManagedStatus({ extensions: 'no' }, 'aisignal.mjs'), /"extensions"/)
  assert.throws(() => readManagedStatus(null, 'aisignal.mjs'), /"summary"/)
})

test('loadManagedStatus asks the host with the page own credentials and never turns a failed request into an answer', async () => {
  const asked = []
  const answering = (body, ok = true, status = 200) => async (url, init) => { asked.push({ url, init }); return { ok, status, json: async () => body } }

  assert.deepEqual(await loadManagedStatus(answering(summary([resolved('A'), resolved('B')])), 'aisignal.mjs'), { kind: 'ready', schedules: 2 })
  assert.deepEqual(asked[0], { url: MANAGED_RESOURCES_URL, init: { credentials: 'same-origin' } })
  assert.equal(MANAGED_RESOURCES_URL, '/api/extensions/managed-resources')

  assert.deepEqual(await loadManagedStatus(answering(summary([missingRef('A'), missingRef('B')])), 'aisignal.mjs'), { kind: 'unscheduled', missing: ['A', 'B'], total: 2 })
  // A 401, a malformed body and a thrown fetch are three failures of the
  // check, and all three come back as the third state with their reason.
  assert.deepEqual(await loadManagedStatus(answering({}, false, 401), 'aisignal.mjs'), { kind: 'unknown', reason: 'a host 401-tal válaszolt' })
  const malformed = await loadManagedStatus(answering({ extensions: [] }), 'aisignal.mjs')
  assert.equal(malformed.kind, 'unknown')
  assert.match(malformed.reason, /nem tartalmazza ezt az extensiont/)
  const offline = await loadManagedStatus(async () => { throw new Error('offline') }, 'aisignal.mjs')
  assert.deepEqual(offline, { kind: 'unknown', reason: 'offline' })
})

test('the status bar words a never-scheduled install apart from one whose runs are waiting for their slot, and from a check that failed', () => {
  const never = board({ gmail: { status: 'ready' } })
  const scheduled = renderStatus({ managed: { kind: 'ready', schedules: 2 }, board: never, onRefresh: noop })
  assert.ok(scheduled.includes('Még nem futott sweep'), 'no sweep has run')
  assert.ok(scheduled.includes('Ütemezés: mind a 2 futás be van állítva'), 'but two are scheduled')
  assert.equal(scheduled.includes('Reconcile'), false)

  const unscheduled = renderStatus({ managed: { kind: 'unscheduled', missing: ['AI Signal: hírlevél-sweep (2 óránként)', 'AI Signal: KKV-kutatás (naponta 06:30)'], total: 2 }, board: never, onRefresh: noop })
  assert.ok(unscheduled.includes('Még nem futott sweep'), 'no sweep has run')
  assert.ok(unscheduled.includes('Ütemezés: 2 a 2 futásból nincs beállítva (AI Signal: hírlevél-sweep (2 óránként), AI Signal: KKV-kutatás (naponta 06:30))'), 'and none is going to')
  assert.ok(unscheduled.includes('Magától egyetlen sweep sem indul el'))
  assert.ok(unscheduled.includes('Extensions → Managed resources'), 'the remedy is named')
  assert.ok(unscheduled.includes('Reconcile'))
  assert.ok(/class="ais-warn">Ütemezés: 2 a 2/.test(unscheduled), 'the line is flagged')

  const unknown = renderStatus({ managed: { kind: 'unknown', reason: 'a host 500-tal válaszolt' }, board: never, onRefresh: noop })
  assert.ok(unknown.includes('Ütemezés: az ellenőrzés nem sikerült (a host 500-tal válaszolt), nem tudni, be van-e állítva'))
  assert.equal(unknown.includes('nincs beállítva'), false, 'a failed check is not reported as not scheduled')
  assert.equal(unknown.includes('Reconcile'), false, 'and does not send the operator to fix what may not be broken')

  const pending = renderStatus({ managed: null, board: never, onRefresh: noop })
  assert.ok(pending.includes('Ütemezés: ellenőrzés folyamatban'))
  assert.equal(pending.includes('ais-warn">Ütemezés'), false)

  // The line escapes what the host sends, like every other line here.
  const hostile = renderStatus({ managed: { kind: 'unscheduled', missing: ['<b>x</b>'], total: 1 }, board: never, onRefresh: noop })
  assert.ok(hostile.includes('&lt;b&gt;x&lt;/b&gt;'))
  assert.equal(hostile.includes('<b>x</b>'), false)

  assert.deepEqual(describeManaged(null), { text: 'Ütemezés: ellenőrzés folyamatban', trouble: false })
  assert.equal(describeManaged({ kind: 'ready', schedules: 1 }).trouble, false)
  assert.equal(describeManaged({ kind: 'unknown', reason: 'x' }).trouble, true)
})
