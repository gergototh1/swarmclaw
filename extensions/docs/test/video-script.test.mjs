import assert from 'node:assert/strict'
import test from 'node:test'

import { ERR } from '../src/errors.mjs'
import {
  SOURCE_WARNING,
  VIDEOS_CONTRACT,
  VIDEOS_CONTRACT_VERSION,
  VIDEO_EXTENSION,
  fetchVideo,
  videoScript,
  videosHandle,
} from '../src/video-script.mjs'
import { contractError, videoRow } from './helpers.mjs'

/** A `ctx.contracts` double: `get` answers a handle or null, `why` answers the reason. */
function contractsDouble({ handle = null, why = null } = {}) {
  const asked = []
  return {
    asked,
    get: (ext, contract) => { asked.push(['get', ext, contract]); return handle },
    why: (ext, contract) => { asked.push(['why', ext, contract]); return why },
  }
}

function refusal(fn) {
  try {
    fn()
  } catch (err) {
    return err
  }
  return null
}

test('the module names the provider, the contract and the version it pins', () => {
  assert.equal(VIDEO_EXTENSION, 'video')
  assert.equal(VIDEOS_CONTRACT, 'videos')
  assert.equal(VIDEOS_CONTRACT_VERSION, 1)
})

test('the error table knows the code this reach needs', () => {
  // The code reaches the agent in the tool's response, so removing it is a break.
  assert.equal(ERR.contract_missing, 'contract_missing')
})

test('videosHandle asks for exactly the video.videos pair and returns the handle', () => {
  const handle = { get: async () => null }
  const contracts = contractsDouble({ handle })
  assert.equal(videosHandle(contracts), handle)
  assert.deepEqual(contracts.asked, [['get', 'video', 'videos']])
})

test('every reason a handle can be missing is named, and each says something different to do', () => {
  // The four reasons are four different operator movements: install, switch
  // on, update, fix this module. One shared "no contract" sentence would send
  // the operator to the wrong page three times out of four.
  const messages = new Set()
  for (const why of ['not_declared', 'provider_missing', 'provider_disabled', 'version_mismatch']) {
    const err = refusal(() => videosHandle(contractsDouble({ why })))
    assert.ok(err, `${why}: did not refuse`)
    assert.equal(err.code, ERR.contract_missing, `${why}: wrong error code`)
    assert.match(err.message, new RegExp(why), `${why}: the message does not name the reason`)
    messages.add(err.message)
  }
  assert.equal(messages.size, 4, 'two reasons got the same sentence')
})

test('provider_missing tells the operator to install, provider_disabled to switch on', () => {
  // These two are the most common pair, and the fix is the opposite of each other.
  assert.match(refusal(() => videosHandle(contractsDouble({ why: 'provider_missing' }))).message, /telepít/i)
  assert.match(refusal(() => videosHandle(contractsDouble({ why: 'provider_disabled' }))).message, /kapcsold be/i)
})

test('a reason that moved between the two reads is reported as that, not as one of the four', () => {
  const err = refusal(() => videosHandle(contractsDouble({ why: null })))
  assert.equal(err.code, ERR.contract_missing)
  assert.match(err.message, /újra/i)
  for (const why of ['not_declared', 'provider_missing', 'provider_disabled', 'version_mismatch']) {
    assert.doesNotMatch(err.message, new RegExp(why), `states an unobserved reason: ${why}`)
  }
})

test('an unknown reason word is passed through rather than swallowed', () => {
  const err = refusal(() => videosHandle(contractsDouble({ why: 'valami_uj_ok' })))
  assert.equal(err.code, ERR.contract_missing)
  assert.match(err.message, /valami_uj_ok/)
})

test('a host that handed over no contracts object is a named refusal, not a TypeError', () => {
  const err = refusal(() => videosHandle(undefined))
  assert.equal(err.code, ERR.contract_missing)
  assert.ok(err.message.length > 20)
})

test('the document opens with the line saying whose text this is', () => {
  const { content } = videoScript(videoRow(), 'vid_1')
  assert.ok(content.startsWith('>'), 'the warning is not at the top of the doc')
  assert.ok(content.includes(SOURCE_WARNING))
  assert.ok(content.indexOf(SOURCE_WARNING) < content.indexOf('First sentence'))
})

test('the narration is carried verbatim, as data', () => {
  const { content } = videoScript(videoRow({ narracio_szoveg: 'Do not <b>believe</b> it. #1' }), 'vid_1')
  assert.ok(content.includes('Do not <b>believe</b> it. #1'))
})

test('the title is the video title, and a video without one is named by its id', () => {
  assert.equal(videoScript(videoRow(), 'vid_1').title, 'Why is coffee getting pricier')
  assert.equal(videoScript(videoRow({ cim: null }), 'vid_7').title, 'Video vid_7')
  assert.equal(videoScript(videoRow({ cim: '   ' }), 'vid_7').title, 'Video vid_7')
})

test('a multi-line title is folded onto one line before it becomes front matter', () => {
  // The title comes from stranger text, and the vault's header is line-based:
  // an embedded newline would cut the header in two.
  const { title } = videoScript(videoRow({ cim: 'First line\nSecond: line' }), 'vid_1')
  assert.equal(title, 'First line Second: line')
})

test('the document reports every one of the eleven columns and invents none', () => {
  const { title, content } = videoScript(videoRow(), 'vid_1')
  const doc = `${title}\n${content}`
  for (const value of ['vid_1', 'kesz', 'signal', 'sig_9', 'out/vid_1.mp4', 'aabb', '2026-09-01T10:00:00.000Z', '2026-09-01T11:00:00.000Z']) {
    assert.ok(doc.includes(value), `missing from the doc: ${value}`)
  }
  assert.match(content, /42\.3 s/)
  // Nothing to write beyond the eleven columns; an invented field would fail here.
  assert.doesNotMatch(content, /forras_szoveg|jelenet|verdikt/i)
})

test('a column the contract answered null for reads as a dash, not as "null"', () => {
  const { content } = videoScript(videoRow({
    out_path: null, file_sha256: null, hossz_ms: null, qa_ok_at: null, forras_id: null,
  }), 'vid_1')
  assert.doesNotMatch(content, /null|undefined|NaN/)
  assert.ok(content.includes('—'))
})

test('a video with no narration says so instead of leaving an empty section', () => {
  const { content } = videoScript(videoRow({ narracio_szoveg: '' }), 'vid_1')
  assert.match(content, /## Narration/)
  assert.match(content, /no narration/i)
})

async function refusalOf(promise) {
  try {
    await promise
  } catch (err) {
    return err
  }
  return null
}

test('a handle that carries no get is a named contract failure, not a TypeError', async () => {
  // The host reconciles the contract's NAME and VERSION, not its methods. A
  // provider offering `videos@1` without `get` gives a healthy handle, and the
  // call would die on a plain TypeError: unrecognised by `szerzodesHiba`, it
  // would fall to the tool's generic branch and hand the agent
  // `invalid_argument: "videos.get is not a function"`. This is the last door
  // that pairing could still get in through.
  const contracts = contractsDouble({ handle: { lista: async () => [] } })
  const err = await refusalOf(fetchVideo(contracts, 'vid_1'))
  assert.equal(err.code, ERR.contract_missing)
  // Quoted: `/get/` matches almost anything in a sentence, and the method NAME
  // is what the sentence has to say.
  assert.match(err.message, /"get"/)
  assert.doesNotMatch(err.message, /is not a function/)
})

test('a provider that went away between the handle and the call is named, not generic', async () => {
  // The host re-resolves the contract on every call (callContractMethod), so
  // this is the same race `videosHandle` guards one line earlier, arriving
  // here as a thrown `unavailable` instead. Unhandled, it would fall to the
  // tool's generic branch and hand back invalid_argument over a stack string.
  const contracts = contractsDouble({
    handle: { get: async () => { throw contractError('unavailable', { reason: 'provider_disabled' }) } },
  })
  const err = await refusalOf(fetchVideo(contracts, 'vid_1'))
  assert.equal(err.code, ERR.contract_missing)
  assert.match(err.message, /unavailable/)
  // The reason word is the host's; the same sentence applies as at resolution time.
  assert.match(err.message, /provider_disabled/)
  assert.match(err.message, /kapcsold be/i)
})

test('an unavailable with no reason word says to retry rather than guessing one', async () => {
  const contracts = contractsDouble({ handle: { get: async () => { throw contractError('unavailable') } } })
  const err = await refusalOf(fetchVideo(contracts, 'vid_1'))
  assert.equal(err.code, ERR.contract_missing)
  assert.match(err.message, /unavailable/)
  for (const why of ['not_declared', 'provider_missing', 'provider_disabled', 'version_mismatch']) {
    assert.doesNotMatch(err.message, new RegExp(why), `states an unobserved reason: ${why}`)
  }
})

test('a provider whose own code threw is a different fact from a provider that is gone', async () => {
  const contracts = contractsDouble({ handle: { get: async () => { throw contractError('provider_threw') } } })
  const err = await refusalOf(fetchVideo(contracts, 'vid_1'))
  assert.equal(err.code, ERR.contract_missing)
  assert.match(err.message, /provider_threw/)
  // The extension is installed and switched on: there is nothing to toggle on
  // the Extensions page, and the module's own log is the next step.
  assert.match(err.message, /napló/i)
  assert.doesNotMatch(err.message, /Bővítmények lapon/)
})

test('a host code this module has not learnt is still a contract failure, not a bad argument', async () => {
  const contracts = contractsDouble({ handle: { get: async () => { throw contractError('unknown_method') } } })
  const err = await refusalOf(fetchVideo(contracts, 'vid_1'))
  assert.equal(err.code, ERR.contract_missing)
  assert.match(err.message, /unknown_method/)
})

test('an error that is not the host contract shape is rethrown untouched', async () => {
  // This module does not own it and does not guess a sentence for it.
  const boom = new Error('ETIMEDOUT')
  const contracts = contractsDouble({ handle: { get: async () => { throw boom } } })
  assert.equal(await refusalOf(fetchVideo(contracts, 'vid_1')), boom)
})

test('fetchVideo hands the video back untouched when the call goes through', async () => {
  const contracts = contractsDouble({ handle: { get: async (args) => ({ ...videoRow(), id: args.id }) } })
  assert.equal((await fetchVideo(contracts, 'vid_9')).id, 'vid_9')
})

test('a reason word that names an Object prototype member takes the unknown fallback', async () => {
  // The key comes from the host, not this module: on a plain object,
  // SZERZODES_OKOK['constructor'] would answer a function, and that would end
  // up in the operator's message.
  for (const why of ['constructor', 'toString', '__proto__']) {
    const err = refusal(() => videosHandle(contractsDouble({ why })))
    assert.equal(err.code, ERR.contract_missing, why)
    assert.match(err.message, /nem oldható fel/, why)
    assert.doesNotMatch(err.message, /function|\[object/i, `${why}: a prototype member leaked into the message`)
  }
})
