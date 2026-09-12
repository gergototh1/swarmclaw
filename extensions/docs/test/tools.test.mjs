import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createAgentContext } from '../src/agent-context.mjs'
import { MIGRATIONS, createRepo } from '../src/db.mjs'
import { ERR } from '../src/errors.mjs'
import { createIndexWriter } from '../src/index-writer.mjs'
import { createService } from '../src/service.mjs'
import { actorOf, createTools } from '../src/tools.mjs'
import { createVault } from '../src/vault.mjs'
import { contractError, memStorage, videoRow } from './helpers.mjs'

/** A session as the host attaches it to a tool call. */
function agentCtx(agentId, agentName) {
  return { session: { agentId, agentName }, message: '' }
}
const operatorCtx = { session: {}, message: '' }

/**
 * A `ctx.contracts` double. `videos` is the handle `get` answers for the
 * video.videos pair (null when absent), `why` the host's reason for the null.
 */
function contractsDouble({ videos = null, why = null } = {}) {
  return {
    get: (ext, contract) => (ext === 'video' && contract === 'videos' ? videos : null),
    why: () => why,
  }
}

function harness({ root: rootOverride, contracts = null } = {}) {
  const root = rootOverride ?? fs.mkdtempSync(path.join(os.tmpdir(), 'docs-tools-'))
  const s = memStorage()
  for (const m of MIGRATIONS) s.raw.exec(m.sql)
  const repo = createRepo(s)
  const warnings = []
  const log = { info() {}, warn: (m, meta) => warnings.push({ m, meta }), error() {} }

  let service = null
  const serviceOf = () => {
    if (!service) {
      const vault = createVault({ root })
      const writer = createIndexWriter({ vault, repo })
      service = createService({
        vault, writer, repo, sharedFolder: () => 'shared', versionsKept: () => 50,
      })
    }
    return service
  }
  const tools = createTools({ contracts }, { serviceOf, logOf: () => log })
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
  const ctxHooks = createAgentContext({}, { serviceOf, sharedFolder: () => 'shared', logOf: () => log })

  return {
    repo,
    tools,
    byName,
    ctxHooks,
    warnings,
    serviceOf,
    cleanup: () => { if (!rootOverride) fs.rmSync(root, { recursive: true, force: true }) },
  }
}

test('the module exposes exactly the seven declared tools', () => {
  const h = harness()
  try {
    assert.deepEqual(h.tools.map((t) => t.name), [
      'docs_list', 'docs_read', 'docs_search', 'docs_write', 'docs_move', 'docs_delete',
      'docs_video_script',
    ])
    for (const t of h.tools) {
      assert.ok(t.description.length > 20, `description too short: ${t.name}`)
      assert.equal(t.parameters.type, 'object')
      assert.equal(typeof t.execute, 'function')
    }
  } finally { h.cleanup() }
})

test('actorOf reads the agent record the host actually passes', () => {
  // The host builds the tool ctx as `{ ...ctx, ...buildContext }`
  // (src/lib/server/session-tools/index.ts): agentId comes from the outer
  // context, and the whole Agent arrives as agentRecord. In production that
  // second one was missing from the recognition, and the folder would have
  // been `agents/c3377d/` instead of `agents/gtassistant/`.
  assert.deepEqual(
    actorOf({ session: { agentId: 'c3377d2c', agentRecord: { id: 'c3377d2c', name: 'GTassistant' } } }),
    { kind: 'agent', slug: 'gtassistant' },
  )
  // Without a name, the id is the only thing to hold onto -- ugly, but it works.
  assert.deepEqual(actorOf({ session: { agentId: 'c3377d2c' } }), { kind: 'agent', slug: 'c3377d' })
})

test('actorOf reads the session, and no tool argument can override it', () => {
  assert.deepEqual(actorOf(agentCtx('abc123def', 'Marketing Ügynök')), { kind: 'agent', slug: 'marketing-ugynok' })
  assert.deepEqual(actorOf(operatorCtx), { kind: 'user' })
  assert.deepEqual(actorOf(undefined), { kind: 'user' })
  // A faked "actor" field in the call goes nowhere: actorOf looks at the session.
  assert.deepEqual(actorOf({ session: {}, actor: { kind: 'agent', slug: 'fake' } }), { kind: 'user' })
})

test('docs_write without a folder puts the doc in the calling agent home', async () => {
  const h = harness()
  try {
    const res = await h.byName.docs_write.execute(
      { title: 'Customer profile', content: 'Morvai.\n' },
      agentCtx('abc123', 'Marketing'),
    )
    assert.equal(res.path, 'agents/marketing/customer-profile.md')
    assert.equal(res.version, 1)
  } finally { h.cleanup() }
})

test('docs_write reports the title of what it wrote', async () => {
  const { byName } = harness()
  const r = await byName.docs_write.execute({ title: 'Weekly report', content: '# Hi' }, agentCtx('a1', 'Kutato'))
  assert.equal(r.title, 'Weekly report')
  assert.match(r.path, /\.md$/)
})

test('docs_write refuses another agent folder and returns a message, not a throw', async () => {
  const h = harness()
  try {
    const res = await h.byName.docs_write.execute(
      { folder: 'agents/kutato', title: 'Belenyúlás' },
      agentCtx('abc123', 'Marketing'),
    )
    assert.equal(res.error, ERR.forbidden)
    assert.match(res.message, /agents\/marketing/)
  } finally { h.cleanup() }
})

test('docs_write on an existing doc without baseVersion is refused', async () => {
  const h = harness()
  try {
    const ctx = agentCtx('abc123', 'Marketing')
    const made = await h.byName.docs_write.execute({ title: 'A', content: 'egy\n' }, ctx)
    const res = await h.byName.docs_write.execute({ id: made.id, content: 'ketto\n' }, ctx)
    assert.equal(res.error, ERR.invalid_argument)
    assert.match(res.message, /baseVersion/)
    assert.equal((await h.byName.docs_read.execute({ id: made.id }, ctx)).content, 'egy\n')
  } finally { h.cleanup() }
})

test('a conflict comes back with the other side content attached', async () => {
  const h = harness()
  try {
    const ctx = agentCtx('abc123', 'Marketing')
    const made = await h.byName.docs_write.execute({ title: 'A', content: 'egy\n' }, ctx)
    await h.byName.docs_write.execute({ id: made.id, content: 'operatore\n', baseVersion: 1 }, operatorCtx)

    const res = await h.byName.docs_write.execute({ id: made.id, content: 'ugynoke\n', baseVersion: 1 }, ctx)
    assert.equal(res.error, ERR.conflict)
    assert.equal(res.currentVersion, 2)
    assert.equal(res.theirs, 'operatore\n')
    assert.match(res.message, /Read it again/)
  } finally { h.cleanup() }
})

test('docs_list defaults to the own folder plus the shared one', async () => {
  const h = harness()
  try {
    const marketing = agentCtx('abc123', 'Marketing')
    await h.byName.docs_write.execute({ title: 'Sajat' }, marketing)
    await h.byName.docs_write.execute({ folder: 'shared', title: 'Kozos' }, operatorCtx)
    await h.byName.docs_write.execute({ title: 'Masike' }, agentCtx('def456', 'Kutato'))

    const res = await h.byName.docs_list.execute({}, marketing)
    assert.deepEqual(res.docs.map((d) => d.title).sort(), ['Kozos', 'Sajat'])

    const scoped = await h.byName.docs_list.execute({ folder: 'agents/kutato' }, marketing)
    assert.equal(scoped.docs.length, 1, 'reading from another folder is still allowed')
  } finally { h.cleanup() }
})

test('docs_search folds diacritics and reports a snippet', async () => {
  const h = harness()
  try {
    const ctx = agentCtx('abc123', 'Marketing')
    await h.byName.docs_write.execute({ title: 'A', content: 'Kőműves Morvai jegyzet.\n' }, ctx)
    const res = await h.byName.docs_search.execute({ q: 'komuves' }, ctx)
    assert.equal(res.results.length, 1)
    assert.ok(res.results[0].snippet.includes('Kőműves'))
  } finally { h.cleanup() }
})

test('docs_move and docs_delete answer through the same shape', async () => {
  const h = harness()
  try {
    const ctx = agentCtx('abc123', 'Marketing')
    const made = await h.byName.docs_write.execute({ title: 'A' }, ctx)
    const moved = await h.byName.docs_move.execute({ id: made.id, newFolder: 'shared' }, ctx)
    assert.equal(moved.path, 'shared/a.md')

    const removed = await h.byName.docs_delete.execute({ id: made.id }, ctx)
    assert.equal(removed.id, made.id)
    assert.equal((await h.byName.docs_list.execute({}, ctx)).docs.length, 0)
  } finally { h.cleanup() }
})

test('every tool answers an unwritable root with a message rather than throwing', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-locked-'))
  fs.chmodSync(parent, 0o500)
  const h = harness({
    root: path.join(parent, 'alatta'),
    // The seventh tool reaches the root through the contract; without a
    // provider it would refuse earlier, and this test would not be measuring
    // the root at all.
    contracts: contractsDouble({ videos: { get: async () => videoRow() } }),
  })
  try {
    const ctx = agentCtx('abc123', 'Marketing')
    const calls = [
      [h.byName.docs_list, {}],
      [h.byName.docs_read, { id: 'doc_x' }],
      [h.byName.docs_search, { q: 'x' }],
      [h.byName.docs_write, { title: 'X' }],
      [h.byName.docs_move, { id: 'doc_x', newFolder: 'shared' }],
      [h.byName.docs_delete, { id: 'doc_x' }],
      [h.byName.docs_video_script, { videoId: 'vid_1' }],
    ]
    for (const [tool, args] of calls) {
      const res = await tool.execute(args, ctx)
      assert.ok(res.error, `${tool.name} gave no error code`)
      assert.ok(res.message.length > 0, `${tool.name} gave no message`)
    }
  } finally {
    fs.chmodSync(parent, 0o700)
    fs.rmSync(parent, { recursive: true, force: true })
  }
})

test('the agent context adds nothing when there is nothing to list', () => {
  const h = harness()
  try {
    assert.equal(h.ctxHooks.getAgentContext(agentCtx('abc123', 'Marketing')), null)
  } finally { h.cleanup() }
})

test('the agent context lists own documents first, then the shared ones', async () => {
  const h = harness()
  try {
    const ctx = agentCtx('abc123', 'Marketing')
    await h.byName.docs_write.execute({ title: 'Sajat jegyzet' }, ctx)
    await h.byName.docs_write.execute({ folder: 'shared', title: 'Kozos jegyzet' }, operatorCtx)

    const block = h.ctxHooks.getAgentContext(ctx)
    assert.match(block, /Your docs \(agents\/marketing\)/)
    assert.ok(block.indexOf('Sajat jegyzet') < block.indexOf('Kozos jegyzet'))
    assert.match(block, /- Sajat jegyzet — agents\/marketing\/sajat-jegyzet\.md/)
  } finally { h.cleanup() }
})

test('the agent context stays inside its budget and drops whole lines', async () => {
  const h = harness()
  try {
    const ctx = agentCtx('abc123', 'Marketing')
    for (let i = 0; i < 40; i += 1) {
      await h.byName.docs_write.execute({ title: `Doksi ${i} ${'x'.repeat(120)}` }, ctx)
    }
    const block = h.ctxHooks.getAgentContext(ctx)
    assert.ok(block.length <= 6000, `too long: ${block.length}`)
    for (const l of block.split('\n')) {
      assert.ok(l.startsWith('##') || l.startsWith('- '), `truncated line: ${l}`)
    }
  } finally { h.cleanup() }
})

test('a deleted document leaves the agent context', async () => {
  const h = harness()
  try {
    const ctx = agentCtx('abc123', 'Marketing')
    const made = await h.byName.docs_write.execute({ title: 'Eltunik' }, ctx)
    assert.match(h.ctxHooks.getAgentContext(ctx), /Eltunik/)
    await h.byName.docs_delete.execute({ id: made.id }, ctx)
    assert.equal(h.ctxHooks.getAgentContext(ctx), null)
  } finally { h.cleanup() }
})

test('an unreadable root logs a warning and yields no context instead of throwing', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-ctx-locked-'))
  fs.chmodSync(parent, 0o500)
  const h = harness({ root: path.join(parent, 'alatta') })
  try {
    assert.equal(h.ctxHooks.getAgentContext(agentCtx('abc123', 'Marketing')), null)
    assert.equal(h.warnings.length, 1)
  } finally {
    fs.chmodSync(parent, 0o700)
    fs.rmSync(parent, { recursive: true, force: true })
  }
})

test('the guidance tells the agent about baseVersion and about conflicts', () => {
  const h = harness()
  try {
    const guidance = h.ctxHooks.getOperatingGuidance().join('\n')
    assert.match(guidance, /baseVersion/)
    assert.match(guidance, /conflict/i)
    assert.ok(h.ctxHooks.getCapabilityDescription().length > 20)
  } finally { h.cleanup() }
})

test('docs_video_script lays the script down in the calling agent own folder', async () => {
  const h = harness({ contracts: contractsDouble({ videos: { get: async () => videoRow() } }) })
  try {
    const ctx = agentCtx('abc123', 'Videó Gyártó')
    const res = await h.byName.docs_video_script.execute({ videoId: 'vid_1' }, ctx)
    // Not `agents/video/`: canWrite has an agent write its OWN folder, and the
    // caller's slug is its own name, not the provider extension's name.
    assert.equal(res.path, 'agents/video-gyarto/why-is-coffee-getting-pricier.md')
    assert.equal(res.version, 1)

    const doc = await h.byName.docs_read.execute({ id: res.id }, ctx)
    assert.equal(doc.title, 'Why is coffee getting pricier')
    assert.ok(doc.content.includes('First sentence. Second sentence.'))
    assert.ok(doc.content.startsWith('>'), 'the source warning is not at the top')
  } finally { h.cleanup() }
})

test('docs_video_script passes the video id the caller asked for', async () => {
  const asked = []
  const h = harness({ contracts: contractsDouble({ videos: { get: async (args) => { asked.push(args); return videoRow() } } }) })
  try {
    await h.byName.docs_video_script.execute({ videoId: '  vid_1  ' }, agentCtx('abc123', 'Videó'))
    assert.deepEqual(asked, [{ id: 'vid_1' }])
  } finally { h.cleanup() }
})

test('a missing provider is a named refusal and writes nothing', async () => {
  // A silent skip would lie to the agent that there was nothing to lay down.
  const h = harness({ contracts: contractsDouble({ videos: null, why: 'provider_missing' }) })
  try {
    const ctx = agentCtx('abc123', 'Videó Gyártó')
    const res = await h.byName.docs_video_script.execute({ videoId: 'vid_1' }, ctx)
    assert.equal(res.error, ERR.contract_missing)
    assert.match(res.message, /provider_missing/)
    assert.equal((await h.byName.docs_list.execute({}, ctx)).docs.length, 0, 'left a half-finished doc behind')
  } finally { h.cleanup() }
})

test('a video id that names nothing is refused by name, and no empty doc is left behind', async () => {
  // TWO DIFFERENT FACTS, TWO CODES. A missing `videoId` is about the shape of
  // the call; this is about the world: the field is filled in, the row is
  // gone. Sharing one code would have the agent fix its own arguments forever
  // over a row that does not exist.
  //
  // AND THE MESSAGE DOES NOT REPEAT THE ID. The tool boundary logs a
  // refusal's text, and `videoId` is a bare string with no length limit of its
  // own: an agent-assembled id of any size would land in the host log
  // verbatim, and from there in that agent's next prompt.
  const h = harness({ contracts: contractsDouble({ videos: { get: async () => null } }) })
  try {
    const ctx = agentCtx('abc123', 'Videó Gyártó')
    const res = await h.byName.docs_video_script.execute({ videoId: 'vid_nincs' }, ctx)
    assert.equal(res.error, ERR.video_not_found)
    assert.notEqual(res.error, ERR.invalid_argument, 'a missing field and a vanished row are not the same fix')
    assert.match(res.message, /videoId/, 'the field NAME says what to fix')
    assert.equal(res.message.includes('vid_nincs'), false, 'the refusal never repeats the value the caller sent')
    assert.equal((await h.byName.docs_list.execute({}, ctx)).docs.length, 0)
  } finally { h.cleanup() }
})

test('a missing videoId is refused before the contract is touched', async () => {
  let calls = 0
  const h = harness({ contracts: contractsDouble({ videos: { get: async () => { calls += 1; return videoRow() } } }) })
  try {
    const res = await h.byName.docs_video_script.execute({}, agentCtx('abc123', 'Videó'))
    assert.equal(res.error, ERR.invalid_argument)
    assert.match(res.message, /videoId/)
    assert.equal(calls, 0)
  } finally { h.cleanup() }
})

test('a stranger title with a newline in it survives the front matter round trip', async () => {
  // The title comes from stranger text; the vault's header is line-based, so
  // an embedded newline would cut the header in two and the doc would come
  // back titleless.
  const h = harness({ contracts: contractsDouble({ videos: { get: async () => videoRow({ cim: 'Kávé\nár: fel' }) } }) })
  try {
    const ctx = agentCtx('abc123', 'Videó')
    const res = await h.byName.docs_video_script.execute({ videoId: 'vid_1' }, ctx)
    assert.equal((await h.byName.docs_read.execute({ id: res.id }, ctx)).title, 'Kávé ár: fel')
  } finally { h.cleanup() }
})

test('docs_video_script takes no folder and no identity from its arguments', async () => {
  const h = harness({ contracts: contractsDouble({ videos: { get: async () => videoRow() } }) })
  try {
    const res = await h.byName.docs_video_script.execute(
      { videoId: 'vid_1', folder: 'agents/kutato', actor: { kind: 'agent', slug: 'kutato' } },
      agentCtx('abc123', 'Videó Gyártó'),
    )
    assert.equal(res.path, 'agents/video-gyarto/why-is-coffee-getting-pricier.md')
  } finally { h.cleanup() }
})

test('the operator calling the tool lands in the shared folder, not in an agent one', async () => {
  // `create` gives the operator no home folder, so it gets the shared one.
  const h = harness({ contracts: contractsDouble({ videos: { get: async () => videoRow() } }) })
  try {
    const res = await h.byName.docs_video_script.execute({ videoId: 'vid_1' }, operatorCtx)
    assert.equal(res.path, 'shared/why-is-coffee-getting-pricier.md')
  } finally { h.cleanup() }
})

test('a provider that dies at call time reaches the agent as a contract failure, not a bad argument', async () => {
  // The seventh tool is the first whose failures do not originate in this
  // module. The generic branch would give `invalid_argument` over a stack
  // string, and the agent would keep fixing arguments that were never wrong.
  for (const code of ['unavailable', 'provider_threw']) {
    const h = harness({
      contracts: contractsDouble({ videos: { get: async () => { throw contractError(code) } } }),
    })
    try {
      const ctx = agentCtx('abc123', 'Videó Gyártó')
      const res = await h.byName.docs_video_script.execute({ videoId: 'vid_1' }, ctx)
      assert.equal(res.error, ERR.contract_missing, code)
      assert.match(res.message, new RegExp(code), code)
      assert.doesNotMatch(res.message, /The operation failed/, `${code}: fell to the generic branch`)
      assert.equal((await h.byName.docs_list.execute({}, ctx)).docs.length, 0, code)
    } finally { h.cleanup() }
  }
})

test('docs_write names the doc it wrote as a panel reference', async () => {
  const { byName } = harness()
  const who = agentCtx('a1', 'Kutato')
  const created = await byName.docs_write.execute({ title: 'Weekly report', content: '# Hi' }, who)
  assert.deepEqual(created.panel, { id: created.id, title: 'Weekly report' })

  const changed = await byName.docs_write.execute({ id: created.id, baseVersion: created.version, title: 'Weekly report v2' }, who)
  assert.deepEqual(changed.panel, { id: created.id, title: 'Weekly report v2' })
})

test('a failed docs_write carries no panel reference', async () => {
  const { byName } = harness()
  const r = await byName.docs_write.execute({ content: 'no title' }, agentCtx('a1', 'Kutato'))
  assert.equal(r.error, 'invalid_argument')
  assert.equal('panel' in r, false)
})
