import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'

import { buildClaudePrintArgs, renderPromptForCli, CliUtilityChatModel } from './cli-utility-model'

/*
 * MIÉRT VAN EZ.
 *
 * A `buildLLM` minden hívója LangChain chat-modellt vár, a
 * `resolveGenerationModelConfig` viszont minden CLI-providert eldob
 * (`NON_LANGGRAPH_PROVIDER_IDS`). Ezen a telepítésen MINDEN agent CLI-n fut és
 * egyetlen LLM API-kulcs sincs beállítva, tehát a segédhívások kivétel nélkül
 * elszállnak: az `app.log`-ban 696 sor "No generation-compatible model" --
 * working-state 351, session-run 176, message-classifier 169 --, a napi
 * konszolidáció és a dream-ciklus pedig némán kihagyja magát.
 *
 * A megoldás nem helyi modell (gyenge gépen az drága), hanem az, ami már be van
 * kötve: maga a Claude CLI, egyszeri `--print` hívásként. Lemérve:
 * `echo "Reply with exactly: OK" | claude --print --model claude-haiku-...`
 * -> "OK", exit 0.
 *
 * Ez kizárólag segédhívásra való. A 17 `buildLLM`-hívó egyike sem használ
 * `bindTools`-t, `stream`-et vagy `withStructuredOutput`-ot -- mind sima
 * `llm.invoke(...)` --, tehát a szöveg-be/szöveg-ki adapter mindegyiknek elég.
 */
describe('buildClaudePrintArgs', () => {
  it('asks for a one-shot answer on the chosen model', () => {
    const args = buildClaudePrintArgs({ model: 'claude-haiku-4-5-20251001' })
    assert.ok(args.includes('--print'), args.join(' '))
    assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'claude-haiku-4-5-20251001'])
  })

  it('starts the helper with no MCP servers at all', () => {
    // Ez nem ágens-forduló, hanem egy kivonatoló kérdés. Toolokkal a segédhívás
    // elkezdene dolgozni: fájlt olvasna, delegálna, memóriát írna -- és a
    // platform-híd magát hívná vissza egy körben.
    const args = buildClaudePrintArgs({ model: 'm' })
    assert.ok(args.includes('--strict-mcp-config'), args.join(' '))
  })

  it('never resumes a conversation', () => {
    // Egy segédhívás sosem folytatás: a saját promptján kívül semmit nem lát.
    assert.equal(buildClaudePrintArgs({ model: 'm' }).includes('--resume'), false)
  })

  it('asks for json when the caller wants a json object', () => {
    const args = buildClaudePrintArgs({ model: 'm', responseFormat: 'json_object' })
    assert.deepEqual(
      args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2),
      ['--output-format', 'json'],
    )
  })

  it('leaves the output format alone for plain text', () => {
    assert.equal(buildClaudePrintArgs({ model: 'm' }).includes('--output-format'), false)
  })
})

describe('renderPromptForCli', () => {
  it('keeps the system message ahead of the human one', () => {
    const rendered = renderPromptForCli([
      new SystemMessage('Te egy kivonatoló vagy.'),
      new HumanMessage('Mit tanultunk?'),
    ])
    assert.ok(rendered.indexOf('Te egy kivonatoló vagy.') < rendered.indexOf('Mit tanultunk?'), rendered)
  })

  it('labels the roles so a single prompt stays readable', () => {
    const rendered = renderPromptForCli([new SystemMessage('S'), new HumanMessage('H')])
    assert.match(rendered, /System:/)
    assert.match(rendered, /Human:/)
  })

  it('renders a lone human message without ceremony', () => {
    assert.equal(renderPromptForCli([new HumanMessage('csak ennyi')]).trim(), 'csak ennyi')
  })
})

describe('CliUtilityChatModel', () => {
  const runOk = (out: string) => async () => ({ code: 0, stdout: out, stderr: '' })

  it('returns what the CLI printed', async () => {
    const model = new CliUtilityChatModel({ model: 'm', binary: '/bin/claude', run: runOk('  megvan  ') })
    const answer = await model.invoke([new HumanMessage('kérdés')])
    assert.equal(String(answer.content), 'megvan')
  })

  it('unwraps the json envelope the CLI prints in json mode', async () => {
    // `--output-format json` egy burkot ad vissza, amiben a válasz a `result`
    // mezőben ül; a hívó a saját JSON-jét várja, nem a burkot.
    const envelope = JSON.stringify({ type: 'result', subtype: 'success', result: '{"facts":[]}' })
    const model = new CliUtilityChatModel({ model: 'm', binary: '/bin/claude', responseFormat: 'json_object', run: runOk(envelope) })
    const answer = await model.invoke([new HumanMessage('kérdés')])
    assert.equal(String(answer.content), '{"facts":[]}')
  })

  it('throws when the CLI fails, so the caller\'s own catch takes over', async () => {
    // Minden hívó best-effort `catch`-be van csomagolva; egy néma üres válasz
    // viszont rosszabb, mint egy hiba -- azt hinnék, nem volt mit kivonatolni.
    const model = new CliUtilityChatModel({
      model: 'm',
      binary: '/bin/claude',
      run: async () => ({ code: 1, stdout: '', stderr: 'boom' }),
    })
    await assert.rejects(model.invoke([new HumanMessage('x')]), /boom|exit/i)
  })

  it('throws rather than answering nothing when the CLI prints nothing', async () => {
    const model = new CliUtilityChatModel({ model: 'm', binary: '/bin/claude', run: runOk('   ') })
    await assert.rejects(model.invoke([new HumanMessage('x')]), /empty/i)
  })

  it('reports a missing binary as a configuration problem', async () => {
    const model = new CliUtilityChatModel({ model: 'm', binary: null, run: runOk('x') })
    await assert.rejects(model.invoke([new HumanMessage('x')]), /not found|binary/i)
  })

  it('identifies itself, so a log line says which model answered', () => {
    const model = new CliUtilityChatModel({ model: 'claude-haiku-4-5-20251001', binary: '/bin/claude', run: runOk('x') })
    assert.match(model._llmType(), /cli/)
  })
})

/*
 * A fék ott van, ahol a költés.
 *
 * A CLI-adapter az alapértelmezett út, és ez az, ami az előfizetést költi -- a
 * fék tehát ide való, nem a 17 hívó mindegyikébe külön. Egy megtagadott hívás
 * dob, mert minden hívó best-effort `catch`-be van csomagolva; egy néma üres
 * válasz azt hitetné el velük, hogy nem volt mit kivonatolni.
 */
describe('CliUtilityChatModel budget', () => {
  const runOk = async () => ({ code: 0, stdout: 'ok', stderr: '' })

  it('refuses when the budget says no, and does not start the process', async () => {
    let started = 0
    const model = new CliUtilityChatModel({
      model: 'm',
      binary: '/bin/claude',
      run: async () => { started++; return { code: 0, stdout: 'ok', stderr: '' } },
      claim: () => ({ ok: false, reason: 'daily_cap' }),
    })
    await assert.rejects(model.invoke([new HumanMessage('x')]), /daily_cap|budget/i)
    assert.equal(started, 0, 'a refused call must not spawn anything')
  })

  it('releases its slot even when the CLI fails', async () => {
    let released = 0
    const model = new CliUtilityChatModel({
      model: 'm',
      binary: '/bin/claude',
      run: async () => ({ code: 1, stdout: '', stderr: 'boom' }),
      claim: () => ({ ok: true }),
      release: () => { released++ },
    })
    await assert.rejects(model.invoke([new HumanMessage('x')]))
    assert.equal(released, 1, 'a leaked slot shrinks the concurrency limit for good')
  })

  it('releases its slot on success too', async () => {
    let released = 0
    const model = new CliUtilityChatModel({
      model: 'm', binary: '/bin/claude', run: runOk,
      claim: () => ({ ok: true }),
      release: () => { released++ },
    })
    await model.invoke([new HumanMessage('x')])
    assert.equal(released, 1)
  })
})

/*
 * Build és teszt közben nem indul processz.
 *
 * A `SWARMCLAW_BUILD_MODE` azt jelenti, hogy a folyamat nem éles kiszolgálás --
 * next build, teszt-futtatás. Ilyenkor egy segédhívás valódi CLI-processzt
 * indítana, valódi kvótát költene, és a tesztek eredménye a hálózattól függene.
 * Két memória-teszt pont ezen bukott meg: a tartalék ágat vizsgálták, és
 * hirtelen valódi összefoglalót kaptak.
 */
describe('CliUtilityChatModel outside production', () => {
  it('refuses to spawn under the test runner', async () => {
    // A node test runner a `NODE_TEST_CONTEXT`-et állítja; a build a
    // `SWARMCLAW_BUILD_MODE`-ot. Mindkettő elég.
    const started = 0
    {
      // Szándékosan NINCS injektált runner: ez az az eset, amikor valódi
      // processzt indítana.
      const model = new CliUtilityChatModel({
        model: 'm',
        binary: '/bin/claude',
        claim: () => ({ ok: true }),
        release: () => {},
      })
      await assert.rejects(model.invoke([new HumanMessage('x')]), /build|test/i)
      assert.equal(started, 0)
    }
  })
})
