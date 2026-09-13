import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'

import { createDocSaver, flushAllEditors, leaveBlockedMessage, trackMountedEditor } from '../ui/doc-saver.ts'
import { failedEdits } from '../ui/doc-store.ts'
import { createSaveQueue } from '../ui/save-queue.ts'

/**
 * The editor's save logic, driven through a fake screen and a fake `rpc` whose
 * every answer is held until the test gives it. What the fake screen records
 * is what the component would have put on screen.
 */

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const afterMicrotasks = () => new Promise((res) => setImmediate(res))

async function settledYet(promise) {
  let settled = false
  void promise.then(() => { settled = true }, () => { settled = true })
  await afterMicrotasks()
  return settled
}

function harness() {
  const calls = []
  const rpc = (method, body) => {
    const reply = deferred()
    calls.push({ method, body, reply, taken: false })
    return reply.promise
  }
  const s = {
    open: null,
    loaded: null,
    deleteBlocked: null,
    deleting: new Set(),
    md: '',
    saved: '',
    dirty: false,
    state: { kind: 'idle' },
    version: 0,
    doc: null,
    titleField: '',
    loadError: null,
    timer: false,
    savedCalls: 0,
  }
  const screen = {
    openId: () => s.open,
    loadedId: () => s.loaded,
    setLoadedId: (docId) => { s.loaded = docId },
    isDeleteBlocked: (docId) => s.deleteBlocked === docId,
    setDeleteBlocked: (docId) => { s.deleteBlocked = docId },
    showDeleting: (docId, on) => { if (on) s.deleting.add(docId); else s.deleting.delete(docId) },
    currentMd: () => s.md,
    savedMd: () => s.saved,
    setSavedMd: (md) => { s.saved = md },
    isDirty: () => s.dirty,
    setDirty: (value) => { s.dirty = value },
    saveState: () => s.state,
    setSaveState: (next) => { s.state = typeof next === 'function' ? next(s.state) : next },
    setVersion: (version) => { s.version = version },
    docTitle: () => s.doc?.title ?? null,
    setDoc: (doc) => { s.doc = doc },
    setDocTitle: (title) => { s.doc = s.doc && { ...s.doc, title } },
    setTitleField: (title) => { s.titleField = title },
    setRawText: (md) => { s.md = md },
    setEditorContent: (md) => { s.md = md },
    setLoadError: (message) => { s.loadError = message },
    cancelAutosave: () => { s.timer = false },
    scheduleAutosave: () => { s.timer = true },
    onSaved: () => { s.savedCalls += 1 },
  }
  const queue = createSaveQueue()
  const saver = createDocSaver({ rpc, queue, screen })
  const show = (md) => { s.md = md }
  return { s, calls, saver, queue, show }
}

/** The next call to `method` nobody has answered yet, once it has gone out. */
async function nextCall(h, method) {
  for (let i = 0; i < 50; i += 1) {
    const call = h.calls.find((c) => c.method === method && !c.taken)
    if (call) {
      call.taken = true
      return call
    }
    await afterMicrotasks()
  }
  assert.fail(`no "${method}" call went out`)
}

const sent = (h, method) => h.calls.filter((c) => c.method === method)

/** The reader opens `docId` and its read is answered. */
async function openDoc(h, docId, { version = 1, content = `${docId} body`, title = `${docId} title` } = {}) {
  h.s.open = docId
  h.saver.open(docId, h.show)
  const read = await nextCall(h, 'read')
  assert.deepEqual(read.body, { id: docId })
  read.reply.resolve({ id: docId, title, path: `${docId}.md`, version, content })
  for (let i = 0; i < 50 && h.s.loaded !== docId; i += 1) await afterMicrotasks()
  assert.equal(h.s.loaded, docId, `${docId} did not load`)
}

/** Opens `docId` without answering its read. */
async function startOpening(h, docId) {
  h.s.open = docId
  h.saver.open(docId, h.show)
  return nextCall(h, 'read')
}

const conflictReply = (currentVersion, theirs) => ({
  error: 'conflict',
  message: 'The doc was changed.',
  currentVersion,
  modifiedBy: 'agent-b',
  theirs,
})

beforeEach(() => failedEdits.clear())

test('canSave: open needs the doc open, loaded needs it loaded, the default also needs no delete out', async () => {
  const h = harness()
  assert.equal(h.saver.canSave(null, 'open'), false)
  const read = await startOpening(h, 'doc_a')
  assert.equal(h.saver.canSave('doc_a', 'open'), true)
  assert.equal(h.saver.canSave('doc_a', 'loaded'), false)
  read.reply.resolve({ id: 'doc_a', title: 'A', path: 'a.md', version: 1, content: 'A' })
  await h.queue.whenIdle()
  assert.equal(h.saver.canSave('doc_a', 'loaded'), true)
  assert.equal(h.saver.canSave('doc_a'), true)
  assert.equal(h.saver.canSave('doc_b', 'open'), false)
  h.s.deleteBlocked = 'doc_a'
  assert.equal(h.saver.canSave('doc_a', 'loaded'), true)
  assert.equal(h.saver.canSave('doc_a'), false)
})

test('nothing is saved while the open doc has not loaded: typing, Cmd+S, rename, view switch', async () => {
  const h = harness()
  await openDoc(h, 'doc_a', { content: 'A' })
  const read = await startOpening(h, 'doc_b')
  // The editor still shows doc_a's text, typed on.
  h.s.md = 'A, typed on during the load'
  h.saver.edited('doc_b')
  assert.equal(h.s.dirty, false, 'typing marked the unloaded doc dirty')
  assert.equal(h.s.timer, false, 'typing started the autosave countdown')
  await h.saver.saveNow('doc_b')
  await h.saver.rename('doc_b', 'A new title')
  h.s.dirty = true
  assert.equal(h.saver.leaveView('doc_b'), 'A, typed on during the load')
  await afterMicrotasks()
  assert.deepEqual(sent(h, 'save'), [])

  read.reply.resolve({ id: 'doc_b', title: 'B', path: 'b.md', version: 4, content: 'B' })
  await h.queue.whenIdle()
  assert.equal(h.s.md, 'B')
  assert.equal(h.s.dirty, false)
  assert.equal(h.saver.canSave('doc_b'), true)
})

test('two saves for one doc go out one at a time, the second on the version the first returned', async () => {
  const h = harness()
  await openDoc(h, 'doc_a', { version: 3, content: 'A' })
  h.s.md = 'A1'
  const first = h.saver.saveNow('doc_a')
  h.s.md = 'A12'
  const second = h.saver.saveNow('doc_a')
  const call1 = await nextCall(h, 'save')
  assert.deepEqual(call1.body, { id: 'doc_a', content: 'A1', baseVersion: 3 })
  await afterMicrotasks()
  assert.equal(sent(h, 'save').length, 1, 'the second save went out before the first came back')
  call1.reply.resolve({ version: 4 })
  const call2 = await nextCall(h, 'save')
  assert.deepEqual(call2.body, { id: 'doc_a', content: 'A12', baseVersion: 4 })
  call2.reply.resolve({ version: 5 })
  await Promise.all([first, second])
  assert.equal(h.s.version, 5)
  assert.equal(h.s.saved, 'A12')
  assert.equal(h.s.state.kind, 'saved')
})

test('a response for a doc that is no longer open writes nothing on screen, but updates the confirmed record', async () => {
  const h = harness()
  await openDoc(h, 'doc_a', { version: 1, content: 'A' })
  h.s.md = 'A edited'
  const saving = h.saver.saveNow('doc_a')
  const call = await nextCall(h, 'save')
  await openDoc(h, 'doc_b', { version: 7, content: 'B' })
  const screenBefore = { version: h.s.version, saved: h.s.saved, md: h.s.md, state: h.s.state, dirty: h.s.dirty, doc: h.s.doc }

  call.reply.resolve({ version: 2 })
  await saving
  assert.deepEqual(
    { version: h.s.version, saved: h.s.saved, md: h.s.md, state: h.s.state, dirty: h.s.dirty, doc: h.s.doc },
    screenBefore,
  )
  assert.equal(h.s.savedCalls, 1, 'the page was not told a save landed')

  // doc_a's next save, a rename flushed from off screen, uses what that save confirmed.
  const rename = h.saver.save('doc_a', null, { title: 'A renamed' })
  const renameCall = await nextCall(h, 'save')
  assert.deepEqual(renameCall.body, { id: 'doc_a', content: 'A edited', title: 'A renamed', baseVersion: 2 })
  renameCall.reply.resolve({ version: 3 })
  await rename
  assert.equal(h.s.doc.title, 'doc_b title', 'the off-screen rename renamed the doc on screen')
})

test('"Keep theirs" voids saves queued before it, and nothing saves until its step finishes', async () => {
  const h = harness()
  await openDoc(h, 'doc_a', { version: 1, content: 'A' })
  h.s.md = 'mine'
  const refused = h.saver.saveNow('doc_a')
  ;(await nextCall(h, 'save')).reply.resolve(conflictReply(2, 'theirs'))
  await refused
  assert.equal(h.s.state.kind, 'conflict')
  const bar = h.s.state

  // One save out, one queued behind it, then the click.
  h.s.md = 'mine, typed on'
  const outNow = h.saver.saveNow('doc_a')
  const outCall = await nextCall(h, 'save')
  h.s.md = 'mine, typed on again'
  const queued = h.saver.saveNow('doc_a')
  const applied = h.saver.keepTheirs(bar)

  assert.equal(h.saver.canSave('doc_a', 'loaded'), false, 'the doc still counts as loaded while theirs waits')
  h.s.md = 'typed while theirs waits'
  h.saver.edited('doc_a')
  assert.equal(h.s.timer, false)
  await h.saver.saveNow('doc_a')

  outCall.reply.resolve(conflictReply(2, 'theirs'))
  await Promise.all([outNow, queued, applied])

  assert.deepEqual(sent(h, 'save').map((c) => c.body.content), ['mine', 'mine, typed on'])
  assert.equal(h.s.md, 'theirs')
  assert.equal(h.s.saved, 'theirs')
  assert.equal(h.s.version, 2)
  assert.equal(h.s.dirty, false)
  assert.deepEqual(h.s.state, { kind: 'idle' })
  assert.equal(h.saver.canSave('doc_a'), true)
  assert.equal(failedEdits.size, 0, 'a voided save recorded a failure')

  // The next save is built on theirs.
  h.s.md = 'theirs, then mine'
  const after = h.saver.saveNow('doc_a')
  const afterCall = await nextCall(h, 'save')
  assert.deepEqual(afterCall.body, { id: 'doc_a', content: 'theirs, then mine', baseVersion: 2 })
  afterCall.reply.resolve({ version: 3 })
  await after
})

test('a conflict while the doc is off screen is recorded, and shown against the doc as loaded next time', async () => {
  const h = harness()
  await openDoc(h, 'doc_a', { version: 1, content: 'A' })
  h.s.md = 'A mine'
  const saving = h.saver.saveNow('doc_a')
  const call = await nextCall(h, 'save')
  await openDoc(h, 'doc_b')

  const refusal = conflictReply(2, 'A theirs then')
  call.reply.resolve(refusal)
  await saving
  assert.deepEqual(h.s.state, { kind: 'idle' }, 'doc_a\'s conflict showed over doc_b')
  assert.deepEqual(failedEdits.get('doc_a'), { mine: 'A mine', title: undefined, conflict: refusal, message: null, baseVersion: 1 })

  await openDoc(h, 'doc_a', { version: 3, content: 'A theirs now' })
  assert.deepEqual(h.s.state, {
    kind: 'conflict',
    docId: 'doc_a',
    conflict: { ...refusal, currentVersion: 3, theirs: 'A theirs now' },
    mine: 'A mine',
    title: undefined,
    restored: true,
  })
  assert.equal(h.s.md, 'A theirs now', 'a restored conflict shows the doc as loaded')
  assert.equal(failedEdits.has('doc_a'), false)
})

test('an error while the doc is off screen is recorded, and shown as not saved when the doc loads on the same version', async () => {
  const h = harness()
  await openDoc(h, 'doc_a', { version: 1, content: 'A' })
  h.s.md = 'A mine'
  const saving = h.saver.saveNow('doc_a')
  const call = await nextCall(h, 'save')
  await openDoc(h, 'doc_b')
  call.reply.resolve({ error: 'io', message: 'The disk is full.' })
  await saving
  assert.deepEqual(h.s.state, { kind: 'idle' })
  assert.equal(failedEdits.get('doc_a')?.message, 'The disk is full.')

  await openDoc(h, 'doc_a', { version: 1, content: 'A' })
  assert.deepEqual(h.s.state, {
    kind: 'unsaved',
    docId: 'doc_a',
    mine: 'A mine',
    message: 'The disk is full.',
    title: undefined,
    baseVersion: 1,
  })

  // "Restore it" puts the edit back and saves it on that same version.
  h.saver.restoreUnsaved(h.s.state)
  assert.equal(h.s.md, 'A mine')
  assert.equal(h.s.timer, true)
  const restored = h.saver.saveNow('doc_a')
  const call2 = await nextCall(h, 'save')
  assert.deepEqual(call2.body, { id: 'doc_a', content: 'A mine', baseVersion: 1 })
  call2.reply.resolve({ version: 2 })
  await restored
})

test('an edit that failed off screen, reopened on a newer version, is shown as a conflict with the doc as loaded', async () => {
  const h = harness()
  await openDoc(h, 'doc_a', { version: 1, content: 'A' })
  h.s.md = 'A mine'
  const saving = h.saver.saveNow('doc_a')
  const call = await nextCall(h, 'save')
  await openDoc(h, 'doc_b')
  call.reply.resolve({ error: 'io', message: 'The disk is full.' })
  await saving

  await openDoc(h, 'doc_a', { version: 2, content: 'A, written by someone else' })
  assert.deepEqual(h.s.state, {
    kind: 'conflict',
    docId: 'doc_a',
    conflict: {
      error: 'conflict',
      message: 'The disk is full.',
      currentVersion: 2,
      modifiedBy: null,
      theirs: 'A, written by someone else',
    },
    mine: 'A mine',
    title: undefined,
    restored: true,
  })

  // "Keep mine" now overwrites the newer version only because the reader chose to.
  const kept = h.saver.keepMine(h.s.state)
  const keptCall = await nextCall(h, 'save')
  assert.deepEqual(keptCall.body, { id: 'doc_a', content: 'A mine', baseVersion: 2 })
  keptCall.reply.resolve({ version: 3 })
  await kept
})

/** What the editor does as the reader moves from the open doc to `docId`. */
async function switchTo(h, docId, loaded) {
  h.saver.leave(h.s.open)
  await openDoc(h, docId, loaded)
}

/** The reader types `text` into the open doc, then Cmd+S; the save is refused with `reply`. */
async function failOnScreen(h, text, reply) {
  h.s.md = text
  h.saver.edited(h.s.open)
  const saving = h.saver.saveNow(h.s.open)
  ;(await nextCall(h, 'save')).reply.resolve(reply)
  await saving
}

test('leaving a doc after its save failed on screen sends the edit again', async () => {
  const h = harness()
  await openDoc(h, 'doc_a', { version: 1, content: 'A' })
  await failOnScreen(h, 'A edited', { error: 'io', message: 'offline' })
  assert.deepEqual(h.s.state, { kind: 'error', message: 'offline' })
  assert.equal(h.s.timer, false, 'a countdown is still waiting, so this is not the case under test')

  await switchTo(h, 'doc_b')
  const retry = await nextCall(h, 'save')
  assert.deepEqual(retry.body, { id: 'doc_a', content: 'A edited', baseVersion: 1 })
  retry.reply.resolve({ version: 2 })
  await h.queue.whenIdle()
  assert.equal(failedEdits.size, 0)
  assert.equal(h.s.md, 'doc_b body')
  assert.deepEqual(h.s.state, { kind: 'idle' })
})

test('if the save sent on leaving fails too, the edit is recorded and shown on reopen', async () => {
  const h = harness()
  await openDoc(h, 'doc_a', { version: 1, content: 'A' })
  await failOnScreen(h, 'A edited', { error: 'io', message: 'offline' })

  await switchTo(h, 'doc_b')
  ;(await nextCall(h, 'save')).reply.resolve({ error: 'io', message: 'still offline' })
  await h.queue.whenIdle()
  assert.deepEqual(failedEdits.get('doc_a'), {
    mine: 'A edited',
    title: undefined,
    conflict: null,
    message: 'still offline',
    baseVersion: 1,
  })

  await switchTo(h, 'doc_a', { version: 1, content: 'A' })
  assert.deepEqual(h.s.state, {
    kind: 'unsaved',
    docId: 'doc_a',
    mine: 'A edited',
    message: 'still offline',
    title: undefined,
    baseVersion: 1,
  })
})

test('leaving sends nothing when the text on screen differs only because the view converted it', async () => {
  const h = harness()
  await openDoc(h, 'doc_a', { version: 1, content: '|a|b|\n|---|---|' })
  // The formatted view hands back `| --- |` for `|---|`; nobody typed.
  h.s.md = '| a | b |\n| --- | --- |'
  await switchTo(h, 'doc_b')
  await h.queue.whenIdle()
  assert.deepEqual(sent(h, 'save'), [])
})

test('leaving while the same text is still being saved does not send it twice', async () => {
  const h = harness()
  await openDoc(h, 'doc_a', { version: 1, content: 'A' })
  h.s.md = 'A edited'
  h.saver.edited('doc_a')
  const saving = h.saver.saveNow('doc_a')
  const call = await nextCall(h, 'save')
  await switchTo(h, 'doc_b')
  call.reply.resolve({ version: 2 })
  await saving
  await h.queue.whenIdle()
  assert.equal(sent(h, 'save').length, 1)
})

test('a conflict bar still up when the reader leaves is recorded with its mine, title and conflict, and offered on reopen', async () => {
  const h = harness()
  await openDoc(h, 'doc_a', { version: 1, content: 'A', title: 'Offer' })
  const refusal = conflictReply(2, 'A theirs')
  const renaming = h.saver.rename('doc_a', 'Offer v2')
  ;(await nextCall(h, 'save')).reply.resolve(refusal)
  await renaming
  assert.equal(h.s.state.kind, 'conflict')

  await switchTo(h, 'doc_b')
  await h.queue.whenIdle()
  assert.equal(sent(h, 'save').length, 1, 'leaving sent the refused save again on the same base')
  assert.deepEqual(failedEdits.get('doc_a'), { mine: 'A', title: 'Offer v2', conflict: refusal, message: null, baseVersion: 2 })

  await switchTo(h, 'doc_a', { version: 2, content: 'A theirs', title: 'Offer' })
  assert.deepEqual(h.s.state, {
    kind: 'conflict',
    docId: 'doc_a',
    conflict: { ...refusal, currentVersion: 2, theirs: 'A theirs' },
    mine: 'A',
    title: 'Offer v2',
    restored: true,
  })
})

test('a conflict bar left behind keeps the text typed after the refusal, without sending it on the refused base', async () => {
  const h = harness()
  await openDoc(h, 'doc_a', { version: 1, content: 'A' })
  const refusal = conflictReply(2, 'A theirs')
  await failOnScreen(h, 'A mine', refusal)
  h.s.md = 'A mine, and more'
  h.saver.edited('doc_a')

  await switchTo(h, 'doc_b')
  await h.queue.whenIdle()
  assert.equal(sent(h, 'save').length, 1)
  assert.equal(failedEdits.get('doc_a')?.mine, 'A mine, and more')
  assert.deepEqual(failedEdits.get('doc_a')?.conflict, refusal)
})

test('text typed during a delete is saved when the reader has switched away and the delete then fails', async () => {
  const h = harness()
  await openDoc(h, 'doc_a', { version: 1, content: 'A' })
  const answer = deferred()
  const removing = h.saver.remove('doc_a', () => answer.promise)
  h.s.md = 'A, typed during the delete'
  h.saver.edited('doc_a')
  assert.equal(h.s.dirty, true)
  assert.equal(h.s.timer, false)

  await switchTo(h, 'doc_b')
  answer.resolve(false)
  await removing
  const call = await nextCall(h, 'save')
  assert.deepEqual(call.body, { id: 'doc_a', content: 'A, typed during the delete', baseVersion: 1 })
  call.reply.resolve({ version: 2 })
  await h.queue.whenIdle()
})

test('a delete goes out after the save already out for its doc, and its failure shows on screen rather than being kept off screen', async () => {
  const h = harness()
  await openDoc(h, 'doc_a', { version: 1, content: 'A' })
  h.s.md = 'A edited'
  const saving = h.saver.saveNow('doc_a')
  const call = await nextCall(h, 'save')
  let asked = 0
  const answer = deferred()
  const removing = h.saver.remove('doc_a', () => { asked += 1; return answer.promise })
  await afterMicrotasks()
  assert.equal(asked, 0, 'the delete went out while a save for the doc was still out')

  call.reply.resolve({ error: 'io', message: 'offline' })
  await saving
  for (let i = 0; i < 50 && asked === 0; i += 1) await afterMicrotasks()
  assert.equal(asked, 1)
  assert.deepEqual(h.s.state, { kind: 'error', message: 'offline' }, 'the doc is still open, so its failure belongs on screen')
  assert.equal(failedEdits.has('doc_a'), false, 'the open doc was wrongly treated as off screen because its delete was out')

  answer.resolve(true)
  await removing
  assert.equal(failedEdits.has('doc_a'), false, 'a trashed doc kept its failed edit')
})

test('a save that fails while a delete is out for the still-open doc is not recorded off screen, and a later save saves it once the delete fails', async () => {
  const h = harness()
  await openDoc(h, 'doc_a', { version: 1, content: 'A' })
  h.s.md = 'A edited'
  h.saver.edited('doc_a')
  const saving = h.saver.saveNow('doc_a')
  const call = await nextCall(h, 'save')
  const answer = deferred()
  const removing = h.saver.remove('doc_a', () => answer.promise)

  call.reply.resolve({ error: 'io', message: 'offline' })
  await saving
  assert.deepEqual(h.s.state, { kind: 'error', message: 'offline' }, 'a save failing on the still-open doc should show on screen, not vanish into failedEdits')
  assert.equal(failedEdits.has('doc_a'), false, 'the open doc was wrongly treated as off screen because its delete was out')

  answer.resolve(false)
  await removing
  assert.equal(failedEdits.has('doc_a'), false)
  assert.equal(h.s.timer, true, 'the delete-failure recovery did not reschedule the text that still differs from saved')

  const retry = h.saver.saveNow('doc_a')
  const retryCall = await nextCall(h, 'save')
  assert.deepEqual(retryCall.body, { id: 'doc_a', content: 'A edited', baseVersion: 1 })
  retryCall.reply.resolve({ version: 2 })
  await retry
  assert.equal(failedEdits.has('doc_a'), false)
  assert.equal(h.s.saved, 'A edited', 'the on-screen text is saved')
  assert.equal(h.s.state.kind, 'saved')
})

test('nothing is saved into a doc once its delete has succeeded, not even on the way out', async () => {
  const h = harness()
  await openDoc(h, 'doc_a', { version: 1, content: 'A' })
  const answer = deferred()
  const removing = h.saver.remove('doc_a', () => answer.promise)
  h.s.md = 'A, typed during the delete'
  h.saver.edited('doc_a')
  answer.resolve(true)
  await removing

  // The page closes the doc after the delete; the editor leaves it on the way.
  h.saver.leave('doc_a')
  h.s.open = null
  h.saver.open(null, h.show)
  await h.queue.whenIdle()
  assert.deepEqual(sent(h, 'save'), [])
})

test('flushAllEditors sends an edit whose save failed on screen, with no countdown waiting', async () => {
  const h = harness()
  await openDoc(h, 'doc_a', { version: 1, content: 'A' })
  await failOnScreen(h, 'A edited', { error: 'io', message: 'offline' })
  const untrack = trackMountedEditor({ flush: () => h.saver.flush('doc_a'), hasBar: () => h.saver.hasBar('doc_a'), queue: h.queue })
  try {
    const flushed = flushAllEditors()
    const retry = await nextCall(h, 'save')
    assert.deepEqual(retry.body, { id: 'doc_a', content: 'A edited', baseVersion: 1 })
    retry.reply.resolve({ version: 2 })
    assert.equal(await flushed, true)
    assert.equal(h.s.state.kind, 'saved')
  } finally {
    untrack()
  }
})

test('flushAllEditors resolves false while a conflict bar is up, even with nothing pending', async () => {
  const h = harness()
  await openDoc(h, 'doc_a', { version: 1, content: 'A' })
  await failOnScreen(h, 'A mine', conflictReply(2, 'A theirs'))
  const untrack = trackMountedEditor({ flush: () => h.saver.flush('doc_a'), hasBar: () => h.saver.hasBar('doc_a'), queue: h.queue })
  try {
    assert.equal(await flushAllEditors(), false)
    assert.equal(sent(h, 'save').length, 1, 'the flush sent the refused edit again on the same base')
  } finally {
    untrack()
  }
})

test('the message for a blocked "Open in Docs" names each doc whose edit was not saved', () => {
  const edit = (title) => ({ mine: 'x', title, conflict: null, message: 'offline', baseVersion: 1 })
  assert.equal(leaveBlockedMessage(new Map()), null)
  assert.equal(
    leaveBlockedMessage(new Map([['doc_a', edit('Offer')]])),
    'An edit to "Offer" could not be saved, so Docs was not opened.',
  )
  assert.equal(
    leaveBlockedMessage(new Map([['doc_a', edit(undefined)], ['doc_b', edit('Plan')], ['doc_c', edit(undefined)]])),
    'Edits to doc_a, "Plan" and doc_c could not be saved, so Docs was not opened.',
  )
})

test('flushAllEditors resolves true when every save lands', async () => {
  const one = harness()
  const two = harness()
  await openDoc(one, 'doc_a')
  await openDoc(two, 'doc_b')
  one.s.md = 'A pending'
  two.s.md = 'B pending'
  const untrack = [
    trackMountedEditor({ flush: () => { void one.saver.save('doc_a', one.s.md) }, hasBar: () => false, queue: one.queue }),
    trackMountedEditor({ flush: () => { void two.saver.save('doc_b', two.s.md) }, hasBar: () => false, queue: two.queue }),
  ]
  try {
    const flushed = flushAllEditors()
    const a = await nextCall(one, 'save')
    const b = await nextCall(two, 'save')
    a.reply.resolve({ version: 2 })
    assert.equal(await settledYet(flushed), false, 'resolved before every save had landed')
    b.reply.resolve({ version: 2 })
    assert.equal(await flushed, true)
  } finally {
    for (const stop of untrack) stop()
  }
})

test('flushAllEditors resolves false when one save fails', async () => {
  const one = harness()
  const two = harness()
  await openDoc(one, 'doc_a')
  await openDoc(two, 'doc_b')
  one.s.md = 'A pending'
  two.s.md = 'B pending'
  const untrack = [
    trackMountedEditor({ flush: () => { void one.saver.save('doc_a', one.s.md) }, hasBar: () => false, queue: one.queue }),
    trackMountedEditor({ flush: () => { void two.saver.save('doc_b', two.s.md) }, hasBar: () => false, queue: two.queue }),
  ]
  try {
    const flushed = flushAllEditors()
    ;(await nextCall(one, 'save')).reply.resolve({ version: 2 })
    ;(await nextCall(two, 'save')).reply.reject(new Error('offline'))
    assert.equal(await flushed, false)
    assert.deepEqual(two.s.state, { kind: 'error', message: 'offline' })
  } finally {
    for (const stop of untrack) stop()
  }
})

test('a rename sends the body as confirmed when the rename starts, not an older one', async () => {
  const h = harness()
  await openDoc(h, 'doc_a', { version: 1, content: 'A' })
  h.s.md = 'A, second body'
  const body = h.saver.saveNow('doc_a')
  const bodyCall = await nextCall(h, 'save')
  // The rename is asked for while the body save is still out: the body
  // confirmed at that moment is still 'A'.
  const rename = h.saver.rename('doc_a', '  A renamed  ')
  bodyCall.reply.resolve({ version: 2 })
  const renameCall = await nextCall(h, 'save')
  assert.deepEqual(renameCall.body, { id: 'doc_a', content: 'A, second body', title: 'A renamed', baseVersion: 2 })
  renameCall.reply.resolve({ version: 3 })
  await Promise.all([body, rename])
  assert.equal(h.s.doc.title, 'A renamed')
  assert.equal(h.s.version, 3)
})

test('a rename to the same or an empty title sends nothing and puts the stored title back', async () => {
  const h = harness()
  await openDoc(h, 'doc_a', { title: 'Offer draft' })
  await h.saver.rename('doc_a', '  Offer draft ')
  await h.saver.rename('doc_a', '   ')
  assert.deepEqual(sent(h, 'save'), [])
  assert.equal(h.s.titleField, 'Offer draft')
})
