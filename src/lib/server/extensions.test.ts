import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getExtensionManager, normalizeMarketplaceExtensionUrl, sanitizeExtensionFilename } from './extensions'
import { canonicalizeExtensionId, expandExtensionIds, extensionIdMatches } from './tool-aliases'
import { DATA_DIR } from './data-dir'
import { runWithTempDataDir } from './test-utils/run-with-temp-data-dir'
import type { Session } from '@/types'

let testExtensionSeq = 0

function uniqueExtensionId(prefix: string): string {
  testExtensionSeq += 1
  return `${prefix}_${Date.now()}_${testExtensionSeq}`
}

describe('extension id canonicalization', () => {
  it('normalizes built-in aliases to canonical extension families', () => {
    assert.equal(canonicalizeExtensionId('session_info'), 'manage_sessions')
    assert.equal(canonicalizeExtensionId('connectors'), 'manage_connectors')
    assert.equal(canonicalizeExtensionId('subagent'), 'spawn_subagent')
    assert.equal(canonicalizeExtensionId('http'), 'web')
    assert.equal(canonicalizeExtensionId('human_loop'), 'ask_human')
    assert.equal(canonicalizeExtensionId('gws'), 'google_workspace')
  })

  it('expands aliases to include the canonical family id', () => {
    const expanded = expandExtensionIds(['session_info', 'http', 'human_loop'])
    assert.equal(expanded.includes('manage_sessions'), true)
    assert.equal(expanded.includes('session_info'), true)
    assert.equal(expanded.includes('http_request'), true)
    assert.equal(expanded.includes('http'), true)
    assert.equal(expanded.includes('ask_human'), true)
    assert.equal(expanded.includes('human_loop'), true)
  })

  it('matches Google Workspace aliases across canonical and CLI-facing names', () => {
    const expanded = expandExtensionIds(['google_workspace'])
    assert.equal(expanded.includes('google_workspace'), true)
    assert.equal(expanded.includes('gws'), true)
    assert.equal(expanded.includes('google-workspace'), true)
    assert.equal(extensionIdMatches(['google_workspace'], 'gws'), true)
    assert.equal(extensionIdMatches(['gws'], 'google-workspace'), true)
  })

  it('does not expand a specific platform tool back into manage_platform', () => {
    const expanded = expandExtensionIds(['manage_schedules'])
    assert.equal(expanded.includes('manage_schedules'), true)
    assert.equal(expanded.includes('manage_platform'), false)
    assert.equal(extensionIdMatches(['manage_platform'], 'manage_schedules'), true)
    assert.equal(extensionIdMatches(['manage_schedules'], 'manage_platform'), false)
  })
})

describe('extension install helpers', () => {
  it('rewrites legacy marketplace URLs to the canonical raw source', () => {
    const normalized = normalizeMarketplaceExtensionUrl('https://github.com/swarmclawai/swarmforge/blob/master/foo/bar.js')
    assert.equal(normalized, 'https://raw.githubusercontent.com/swarmclawai/swarmforge/main/foo/bar.js')
  })

  it('allows .js and .mjs extension filenames and blocks traversal', () => {
    assert.equal(sanitizeExtensionFilename('plugin.js'), 'plugin.js')
    assert.equal(sanitizeExtensionFilename('plugin.mjs'), 'plugin.mjs')
    assert.throws(() => sanitizeExtensionFilename('../plugin.js'), /Invalid filename/)
    assert.throws(() => sanitizeExtensionFilename('plugin'), /Filename must end/)
  })
})

describe('extension manager hook execution', () => {
  it('applies beforeToolExec mutations only for explicitly enabled extensions', async () => {
    const extensionId = uniqueExtensionId('before_tool_exec')
    getExtensionManager().registerBuiltin(extensionId, {
      name: 'Before Tool Exec Test',
      hooks: {
        beforeToolExec: ({ input }) => ({ ...(input || {}), patched: true }),
      },
    })

    const withoutEnable = await getExtensionManager().runBeforeToolExec(
      { toolName: 'shell', input: { original: true } },
      {},
    )
    assert.deepEqual(withoutEnable, { original: true })

    const withEnable = await getExtensionManager().runBeforeToolExec(
      { toolName: 'shell', input: { original: true } },
      { enabledIds: [extensionId] },
    )
    assert.deepEqual(withEnable, { original: true, patched: true })
  })

  it('merges beforePromptBuild context and preserves first system prompt override', async () => {
    const extA = uniqueExtensionId('before_prompt_build_a')
    const extB = uniqueExtensionId('before_prompt_build_b')
    const session = {
      id: 'prompt-hook-session',
      name: 'Prompt Hook Session',
      cwd: process.cwd(),
      user: 'tester',
      provider: 'openai',
      model: 'gpt-test',
      claudeSessionId: null,
      messages: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      extensions: [extA, extB],
    } as unknown as Session

    getExtensionManager().registerBuiltin(extA, {
      name: 'Before Prompt Build A',
      hooks: {
        beforePromptBuild: () => ({
          systemPrompt: 'system A',
          prependContext: 'context A',
          prependSystemContext: 'prepend A',
        }),
      },
    })
    getExtensionManager().registerBuiltin(extB, {
      name: 'Before Prompt Build B',
      hooks: {
        beforePromptBuild: () => ({
          systemPrompt: 'system B',
          prependContext: 'context B',
          appendSystemContext: 'append B',
        }),
      },
    })

    const result = await getExtensionManager().runBeforePromptBuild(
      {
        session,
        prompt: 'base prompt',
        message: 'hello',
        history: [],
        messages: [],
      },
      { enabledIds: [extA, extB] },
    )

    assert.deepEqual(result, {
      systemPrompt: 'system A',
      prependContext: 'context A\n\ncontext B',
      prependSystemContext: 'prepend A',
      appendSystemContext: 'append B',
    })
  })

  it('applies beforeToolCall params merges and block results before legacy beforeToolExec', async () => {
    const extA = uniqueExtensionId('before_tool_call_a')
    const extB = uniqueExtensionId('before_tool_call_b')
    const session = {
      id: 'tool-hook-session',
      name: 'Tool Hook Session',
      cwd: process.cwd(),
      user: 'tester',
      provider: 'openai',
      model: 'gpt-test',
      claudeSessionId: null,
      messages: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      extensions: [extA, extB],
    } as unknown as Session

    getExtensionManager().registerBuiltin(extA, {
      name: 'Before Tool Call A',
      hooks: {
        beforeToolCall: () => ({
          params: { patched: true },
          warning: 'tool warning',
        }),
      },
    })
    getExtensionManager().registerBuiltin(extB, {
      name: 'Before Tool Call B',
      hooks: {
        beforeToolCall: ({ input }) => ({
          block: true,
          blockReason: `blocked with patched=${String(input?.patched)}`,
        }),
        beforeToolExec: () => ({ shouldNotRun: true }),
      },
    })

    const result = await getExtensionManager().runBeforeToolCall(
      {
        session,
        toolName: 'shell',
        input: { original: true },
        runId: 'run-1',
      },
      { enabledIds: [extA, extB] },
    )

    assert.deepEqual(result, {
      input: { original: true, patched: true },
      blockReason: 'blocked with patched=true',
      warning: 'tool warning',
    })
  })

  it('applies beforeModelResolve overrides in extension order', async () => {
    const extA = uniqueExtensionId('before_model_resolve_a')
    const extB = uniqueExtensionId('before_model_resolve_b')
    const session = {
      id: 'model-resolve-session',
      name: 'Model Resolve Session',
      cwd: process.cwd(),
      user: 'tester',
      provider: 'openai',
      model: 'gpt-test',
      claudeSessionId: null,
      messages: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      extensions: [extA, extB],
    } as unknown as Session

    getExtensionManager().registerBuiltin(extA, {
      name: 'Before Model Resolve A',
      hooks: {
        beforeModelResolve: () => ({
          providerOverride: 'ollama',
          modelOverride: 'llama-a',
        }),
      },
    })
    getExtensionManager().registerBuiltin(extB, {
      name: 'Before Model Resolve B',
      hooks: {
        beforeModelResolve: () => ({
          modelOverride: 'llama-b',
          apiEndpointOverride: 'http://127.0.0.1:11434',
        }),
      },
    })

    const result = await getExtensionManager().runBeforeModelResolve(
      {
        session,
        prompt: 'base prompt',
        message: 'hello',
        provider: session.provider,
        model: session.model,
        apiEndpoint: null,
      },
      { enabledIds: [extA, extB] },
    )

    assert.deepEqual(result, {
      providerOverride: 'ollama',
      modelOverride: 'llama-b',
      apiEndpointOverride: 'http://127.0.0.1:11434',
    })
  })

  it('chains toolResultPersist and beforeMessageWrite hooks', async () => {
    const extA = uniqueExtensionId('tool_result_persist_a')
    const extB = uniqueExtensionId('before_message_write_b')
    const session = {
      id: 'message-write-session',
      name: 'Message Write Session',
      cwd: process.cwd(),
      user: 'tester',
      provider: 'openai',
      model: 'gpt-test',
      claudeSessionId: null,
      messages: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      extensions: [extA, extB],
    } as unknown as Session

    getExtensionManager().registerBuiltin(extA, {
      name: 'Tool Result Persist A',
      hooks: {
        toolResultPersist: ({ message, toolName }) => ({
          ...message,
          text: `${message.text} [tool:${toolName}]`,
        }),
      },
    })
    getExtensionManager().registerBuiltin(extB, {
      name: 'Before Message Write B',
      hooks: {
        beforeMessageWrite: ({ message }) => ({
          message: {
            ...message,
            text: `${message.text} [persisted]`,
          },
        }),
      },
    })

    const persisted = await getExtensionManager().runToolResultPersist(
      {
        session,
        message: {
          role: 'assistant',
          text: 'tool output',
          time: Date.now(),
        },
        toolName: 'shell',
        toolCallId: 'call-1',
      },
      { enabledIds: [extA, extB] },
    )
    const writeResult = await getExtensionManager().runBeforeMessageWrite(
      {
        session,
        message: persisted,
        phase: 'assistant_final',
        runId: 'run-1',
      },
      { enabledIds: [extA, extB] },
    )

    assert.equal(writeResult.block, false)
    assert.equal(writeResult.message.text, 'tool output [tool:shell] [persisted]')
  })

  it('blocks subagent spawning when an extension hook rejects it', async () => {
    const extensionId = uniqueExtensionId('subagent_spawning')

    getExtensionManager().registerBuiltin(extensionId, {
      name: 'Subagent Spawning Hook',
      hooks: {
        subagentSpawning: () => ({
          status: 'error',
          error: 'blocked by lifecycle hook',
        }),
      },
    })

    const result = await getExtensionManager().runSubagentSpawning(
      {
        parentSessionId: 'parent-1',
        agentId: 'agent-1',
        agentName: 'Agent One',
        message: 'do the work',
        cwd: process.cwd(),
        mode: 'run',
        threadRequested: false,
      },
      { enabledIds: [extensionId] },
    )

    assert.deepEqual(result, {
      status: 'error',
      error: 'blocked by lifecycle hook',
    })
  })

  it('chains text transforms in extension order', async () => {
    const extA = uniqueExtensionId('transform_a')
    const extB = uniqueExtensionId('transform_b')
    getExtensionManager().registerBuiltin(extA, {
      name: 'Transform A',
      hooks: {
        transformOutboundMessage: ({ text }) => `${text} A`,
      },
    })
    getExtensionManager().registerBuiltin(extB, {
      name: 'Transform B',
      hooks: {
        transformOutboundMessage: ({ text }) => `${text} B`,
      },
    })

    const transformed = await getExtensionManager().transformText(
      'transformOutboundMessage',
      {
        session: {
          id: 's1',
          name: 'Test Session',
          cwd: process.cwd(),
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [],
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
          extensions: [extA, extB],
        } as unknown as Session,
        text: 'base',
      },
      { enabledIds: [extA, extB] },
    )

    assert.equal(transformed, 'base A B')
  })

  it('does not run generic extension hooks unless scope is provided explicitly', async () => {
    const extensionId = uniqueExtensionId('scoped_hook')
    let callCount = 0
    getExtensionManager().registerBuiltin(extensionId, {
      name: 'Scoped Hook Test',
      hooks: {
        afterChatTurn: () => {
          callCount += 1
        },
      },
    })

    await getExtensionManager().runHook(
      'afterChatTurn',
      {
        session: {
          id: 's2',
          name: 'Scoped Hook Session',
          cwd: process.cwd(),
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [],
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
        },
        message: 'hi',
        response: 'hello',
        source: 'chat',
        internal: false,
      },
      {},
    )
    assert.equal(callCount, 0)

    await getExtensionManager().runHook(
      'afterChatTurn',
      {
        session: {
          id: 's3',
          name: 'Scoped Hook Session Enabled',
          cwd: process.cwd(),
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [],
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
          extensions: [extensionId],
        } as unknown as Session,
        message: 'hi',
        response: 'hello',
        source: 'chat',
        internal: false,
      },
      { enabledIds: [extensionId] },
    )
    assert.equal(callCount, 1)
  })

  it('calls setup() once per load, however many synchronous reads happen before the modules are acquired', () => {
    // The synchronous read side of the manager cannot acquire an extension
    // module -- `import()` is async -- so it can be reached on a cold process
    // before anything has been imported. What it must not do there is register
    // half a host and let the real load register the rest, which would run
    // setup() twice for one boot on every extension that happened to be ready
    // first. setup() is where extensions run migrations and take handles; a
    // second call per boot is a duplicated side effect, not a wasted cycle.
    const out = runWithTempDataDir<{
      afterColdLoads: number
      afterEnsureLoaded: number
      afterWarmLoad: number
      afterReload: number
      failure: string
    }>(`
      import fs from 'node:fs'
      import path from 'node:path'
      const extensionsMod = await import('@/lib/server/extensions')
      const { getExtensionManager } = extensionsMod.default || extensionsMod
      const counter = path.join(process.env.DATA_DIR, 'setup-calls')
      const extensionsDir = path.join(process.env.DATA_DIR, 'extensions')
      fs.mkdirSync(extensionsDir, { recursive: true })
      // Written straight to disk rather than through saveExtensionSource, which
      // reloads on the way out and would acquire the module before the cold
      // reads below could happen.
      const source = [
        "import fs from 'node:fs'",
        "const at = " + JSON.stringify(counter),
        "export default {",
        "  name: 'Setup Once',",
        "  setup() {",
        "    const seen = fs.existsSync(at) ? Number(fs.readFileSync(at, 'utf8')) : 0",
        "    fs.writeFileSync(at, String(seen + 1))",
        "  },",
        "  tools: [{ name: 'setup_once_noop', description: 'x', parameters: { type: 'object', properties: {} }, execute: () => 'ok' }],",
        "}",
      ].join('\\n')
      fs.writeFileSync(path.join(extensionsDir, 'setup_once.mjs'), source)

      const read = () => (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0)
      const m = getExtensionManager()
      m.load(); m.load(); m.load()
      const afterColdLoads = read()
      await m.ensureLoaded()
      const afterEnsureLoaded = read()
      m.load(); m.load()
      const afterWarmLoad = read()
      await m.reload()
      const afterReload = read()
      const meta = m.listExtensions().find((e) => e.filename === 'setup_once.mjs')
      console.log(JSON.stringify({
        afterColdLoads,
        afterEnsureLoaded,
        afterWarmLoad,
        afterReload,
        failure: (meta && meta.lastFailureError) || '',
      }))
    `)

    assert.equal(out.failure, '', 'the probe extension must load cleanly')
    assert.equal(out.afterColdLoads, 0, 'a synchronous read before acquisition must not register the extension at all')
    assert.equal(out.afterEnsureLoaded, 1, 'the load that acquires the module runs setup() exactly once')
    assert.equal(out.afterWarmLoad, 1, 'a synchronous read of an already-loaded manager must not run setup() again')
    assert.equal(out.afterReload, 2, 'a reload runs setup() again, once')
  })

  it('records an extension whose import never settles as a failure and finishes the load without it', () => {
    // The boot path awaits ensureLoaded() before the HTTP listener binds
    // (src/instrumentation.ts), and acquisition imports every enabled
    // extension in turn. An entry module with a top-level `await` that never
    // settles used to hold that await open forever: no listener, no
    // /api/healthz, and no Extensions screen to disable it from. A throw was
    // always caught; this is the hang, which a catch cannot see. The deadline
    // is shortened through the environment so the test does not wait 30 s.
    //
    // The sibling extension is there to show the load completed with the
    // hung one recorded and the healthy one registered, rather than the load
    // being abandoned as a whole. The subprocess exiting at all is the third
    // assertion: a pending promise with no timer behind it does not keep the
    // event loop alive, so the host is not kept up by the module it gave up on.
    const out = runWithTempDataDir<{
      elapsedMs: number
      hungFailure: string
      healthyFailure: string
      healthyToolPresent: boolean
    }>(`
      import fs from 'node:fs'
      import path from 'node:path'
      const extensionsMod = await import('@/lib/server/extensions')
      const { getExtensionManager } = extensionsMod.default || extensionsMod
      const extensionsDir = path.join(process.env.DATA_DIR, 'extensions')
      fs.mkdirSync(extensionsDir, { recursive: true })
      fs.writeFileSync(path.join(extensionsDir, 'hung_import.mjs'), [
        "await new Promise(() => {})",
        "export default { name: 'Never Settles', tools: [] }",
      ].join('\\n'))
      fs.writeFileSync(path.join(extensionsDir, 'healthy_sibling.mjs'), [
        "export default {",
        "  name: 'Healthy Sibling',",
        "  tools: [{ name: 'healthy_sibling_noop', description: 'x', parameters: { type: 'object', properties: {} }, execute: () => 'ok' }],",
        "}",
      ].join('\\n'))

      const m = getExtensionManager()
      const startedAt = Date.now()
      await m.ensureLoaded()
      const elapsedMs = Date.now() - startedAt
      const listed = m.listExtensions()
      const hung = listed.find((e) => e.filename === 'hung_import.mjs')
      const healthy = listed.find((e) => e.filename === 'healthy_sibling.mjs')
      const tools = m.getTools(['healthy_sibling.mjs'])
      console.log(JSON.stringify({
        elapsedMs,
        hungFailure: (hung && hung.lastFailureError) || '',
        healthyFailure: (healthy && healthy.lastFailureError) || '',
        healthyToolPresent: tools.some((entry) => entry.tool.name === 'healthy_sibling_noop'),
      }))
    `, { env: { SWARMCLAW_EXTENSION_IMPORT_TIMEOUT_MS: '500' }, timeoutMs: 60_000 })

    assert.match(out.hungFailure, /did not finish importing within 500 ms/, 'the hang is recorded against the extension that hung')
    assert.equal(out.healthyFailure, '', 'the sibling that imports cleanly carries no failure')
    assert.equal(out.healthyToolPresent, true, 'the load completed and registered the sibling')
    assert.ok(out.elapsedMs < 20_000, `ensureLoaded returned in ${out.elapsedMs} ms rather than waiting on the hung import`)
  })

  it('re-executes an edited ESM extension on reload, through the manager', () => {
    // The module-system half of this is pinned on the shipped runtimes by
    // extension-module-loader.test.ts. This is the manager half: that reload()
    // actually re-imports under a new generation and rebuilds from the result,
    // rather than repopulating itself from the module it already had.
    const out = runWithTempDataDir<{ before: string; after: string }>(`
      import fs from 'node:fs'
      import path from 'node:path'
      const extensionsMod = await import('@/lib/server/extensions')
      const { getExtensionManager } = extensionsMod.default || extensionsMod
      const m = getExtensionManager()
      const source = (tag) => \`
        export default {
          name: 'Reload Probe',
          tools: [{ name: 'reload_probe', description: 'x', parameters: { type: 'object', properties: {} }, execute: () => '\${tag}' }],
        }\`
      await m.saveExtensionSource('reload_probe.mjs', source('first'))
      const call = async () => {
        const entry = m.getTools(['reload_probe.mjs']).find((t) => t.tool.name === 'reload_probe')
        return String(await entry.tool.execute({}, { session: {}, message: '' }))
      }
      const before = await call()
      fs.writeFileSync(path.join(process.env.DATA_DIR, 'extensions', 'reload_probe.mjs'), source('second'))
      await m.reload()
      const after = await call()
      console.log(JSON.stringify({ before, after }))
    `)

    assert.equal(out.before, 'first')
    assert.equal(out.after, 'second')
  })

  it('stores dependency-aware extensions in managed workspaces', async () => {
    const filename = `${uniqueExtensionId('workspace_extension')}.js`
    const manager = getExtensionManager()

    await manager.saveExtensionSource(
      filename,
      'module.exports = { name: "Workspace Extension", tools: [] }',
      {
        packageJson: {
          name: 'workspace-extension',
          dependencies: {
            lodash: '^4.17.21',
          },
        },
        packageManager: 'npm',
      },
    )

    const meta = manager.listExtensions().find((ext) => ext.filename === filename)
    assert.equal(meta?.isBuiltin, false)
    assert.equal(meta?.hasDependencyManifest, true)
    assert.equal(meta?.dependencyCount, 1)
    assert.equal(meta?.packageManager, 'npm')
    assert.equal(manager.readExtensionSource(filename).includes('Workspace Extension'), true)

    const shimPath = path.join(DATA_DIR, 'extensions', filename)
    assert.equal(fs.readFileSync(shimPath, 'utf8').includes('Auto-generated extension workspace shim'), true)

    assert.equal(await manager.deleteExtension(filename), true)
  })
})

/**
 * The four defects this block pins all live in the manager: which file an
 * update writes, which file the watcher observes, what a shim contains, and
 * which of two overlapping reloads wins.
 *
 * They run under `node --import tsx`, like every other manager test here, and
 * that is a deliberate split rather than an oversight. tsx transpiles the
 * extension sources below before Node sees them, so nothing here is evidence
 * about how the shipped module system treats an ESM extension -- that half is
 * pinned on plain Node and on Electron's embedded Node by
 * `extensions/extension-module-loader.test.ts`, which drives the loader's own
 * source with no tsx in the way. The manager cannot be driven that way: its
 * import chain opens the SQLite database, and this repo builds the native
 * binding for Node, not for Electron's ABI. What is asserted here is manager
 * behaviour -- path resolution, watcher coverage, reload ordering -- which does
 * not depend on the module system underneath.
 */
describe('extension manager source paths, reloads and watchers', () => {
  it('lands an update on the file a workspace-backed extension actually runs', () => {
    // The regression: updateExtension wrote the download into
    // data/extensions/<name>, which for a workspace-backed extension is only a
    // generated shim. The old workspace entry kept running while the recorded
    // hash and the API response both said the update had landed.
    const out = runWithTempDataDir<{
      before: string
      after: string
      shown: string
      shimIsStillAShim: boolean
      recordedHashMatchesRunningCode: boolean
      requestedUrl: string
    }>(`
      import fs from 'node:fs'
      import path from 'node:path'
      import crypto from 'node:crypto'
      const extensionsMod = await import('@/lib/server/extensions')
      const { getExtensionManager } = extensionsMod.default || extensionsMod
      const m = getExtensionManager()

      const source = (tag) => \`
        export default {
          name: 'Update Probe',
          tools: [{ name: 'update_probe', description: 'x', parameters: { type: 'object', properties: {} }, execute: () => '\${tag}' }],
        }\`

      // A package.json is what moves an extension into a managed workspace and
      // leaves a shim in the extensions directory behind it.
      await m.saveExtensionSource('update_probe.mjs', source('v1'), {
        packageJson: { name: 'update-probe', type: 'module' },
      })

      const call = async () => {
        const entry = m.getTools(['update_probe.mjs']).find((t) => t.tool.name === 'update_probe')
        return entry ? String(await entry.tool.execute({}, { session: {}, message: '' })) : 'missing'
      }
      const before = await call()

      const url = 'https://extensions.example.test/update_probe.mjs'
      m.setMeta('update_probe.mjs', { sourceUrl: url })

      // A stub, not a request: the manager's download path is global fetch, and
      // this test must not reach the network.
      let requestedUrl = ''
      const downloaded = source('v2')
      globalThis.fetch = async (input) => {
        requestedUrl = String(input)
        return new Response(downloaded, { headers: { 'content-type': 'application/javascript' } })
      }

      await m.updateExtension('update_probe.mjs')

      const after = await call()
      const shown = m.readExtensionSource('update_probe.mjs')
      const shim = fs.readFileSync(path.join(process.env.DATA_DIR, 'extensions', 'update_probe.mjs'), 'utf8')
      const config = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'extensions.json'), 'utf8'))
      const recorded = (config['update_probe.mjs'] || {}).sourceHash
      const runningHash = crypto.createHash('sha256').update(shown).digest('hex')

      console.log(JSON.stringify({
        before,
        after,
        shown,
        shimIsStillAShim: shim.includes('Auto-generated extension workspace shim') && !shim.includes('Update Probe'),
        recordedHashMatchesRunningCode: recorded === runningHash,
        requestedUrl,
      }))
    `)

    assert.equal(out.requestedUrl, 'https://extensions.example.test/update_probe.mjs')
    assert.equal(out.before, 'v1')
    assert.equal(out.after, 'v2', 'the update must take effect, not just be recorded')
    assert.equal(out.shown.includes('v2'), true, 'readExtensionSource must show the code that is running')
    assert.equal(out.shimIsStillAShim, true, 'the extensions-dir file stays a shim rather than becoming a second copy of the source')
    assert.equal(
      out.recordedHashMatchesRunningCode,
      true,
      'the recorded sourceHash must describe the code the host is actually running',
    )
  })

  it('installs the newest generation when two reloads overlap, and runs no setup() for a generation that never lands', () => {
    // Reloads used to bump the generation up front and then install by
    // completion order, so a slow older generation could land after a fast
    // newer one and serve stale code, with the newer generation's setup()
    // already run against a module instance the host then dropped.
    //
    // The probe makes the inversion deterministic rather than hoping for it:
    // every evaluation of the extension takes the next ordinal from a file, and
    // the second evaluation -- the one the first reload triggers -- stalls for
    // 300ms while the second reload's evaluation runs to completion.
    const out = runWithTempDataDir<{
      initial: string
      afterRace: string
      setupOrdinals: number[]
    }>(`
      import fs from 'node:fs'
      import path from 'node:path'
      const extensionsMod = await import('@/lib/server/extensions')
      const { getExtensionManager } = extensionsMod.default || extensionsMod

      const dataDir = process.env.DATA_DIR
      const ordinalFile = path.join(dataDir, 'race-evaluations')
      const setupLog = path.join(dataDir, 'race-setups')
      const extensionsDir = path.join(dataDir, 'extensions')
      fs.mkdirSync(extensionsDir, { recursive: true })

      // Written straight to disk: saveExtensionSource would reload on the way
      // out and trip the watcher, and the counts below have to come only from
      // the two reloads this test issues.
      const source = [
        "import fs from 'node:fs'",
        "const ordinalFile = " + JSON.stringify(ordinalFile),
        "const setupLog = " + JSON.stringify(setupLog),
        "const ordinal = (fs.existsSync(ordinalFile) ? Number(fs.readFileSync(ordinalFile, 'utf8')) : 0) + 1",
        "fs.writeFileSync(ordinalFile, String(ordinal))",
        "if (ordinal === 2) await new Promise((resolve) => setTimeout(resolve, 300))",
        "export default {",
        "  name: 'Race Probe',",
        "  setup() { fs.appendFileSync(setupLog, ordinal + '\\\\n') },",
        "  tools: [{ name: 'race_probe', description: 'x', parameters: { type: 'object', properties: {} }, execute: () => String(ordinal) }],",
        "}",
      ].join('\\n')
      fs.writeFileSync(path.join(extensionsDir, 'race_probe.mjs'), source)

      const m = getExtensionManager()
      await m.ensureLoaded()
      const call = async () => {
        const entry = m.getTools(['race_probe.mjs']).find((t) => t.tool.name === 'race_probe')
        return entry ? String(await entry.tool.execute({}, { session: {}, message: '' })) : 'missing'
      }
      const initial = await call()

      const first = m.reload()
      const second = m.reload()
      await Promise.all([first, second])

      const afterRace = await call()
      const setupOrdinals = fs.readFileSync(setupLog, 'utf8').trim().split('\\n').map(Number)
      console.log(JSON.stringify({ initial, afterRace, setupOrdinals }))
    `)

    assert.equal(out.initial, '1', 'the probe must load once before the race')
    const highestSetup = Math.max(...out.setupOrdinals)
    assert.equal(out.setupOrdinals.length, 3, 'one setup() per load: the initial load and the two reloads')
    assert.equal(
      Number(out.afterRace),
      highestSetup,
      'the live extension must be the newest generation that ran setup(), not whichever reload finished first',
    )
    assert.equal(out.afterRace, '3', 'the reload issued last must be the one that lands')
  })

  it('reloads when the managed workspace entry is edited on disk', () => {
    // The extensions-directory watcher is non-recursive and filtered to
    // .js/.mjs basenames, so it never saw a write under
    // extensions/.workspaces/<key>/ -- which since the loader started importing
    // the workspace entry is the file that decides what runs.
    const out = runWithTempDataDir<{ before: string; afterWorkspaceEdit: string }>(`
      import fs from 'node:fs'
      import path from 'node:path'
      const extensionsMod = await import('@/lib/server/extensions')
      const { getExtensionManager } = extensionsMod.default || extensionsMod
      const m = getExtensionManager()
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

      const source = (tag) => \`
        export default {
          name: 'Workspace Watch Probe',
          tools: [{ name: 'workspace_watch_probe', description: 'x', parameters: { type: 'object', properties: {} }, execute: () => '\${tag}' }],
        }\`

      await m.saveExtensionSource('workspace_watch_probe.mjs', source('first'), {
        packageJson: { name: 'workspace-watch-probe', type: 'module' },
      })
      const call = async () => {
        const entry = m.getTools(['workspace_watch_probe.mjs']).find((t) => t.tool.name === 'workspace_watch_probe')
        return entry ? String(await entry.tool.execute({}, { session: {}, message: '' })) : 'missing'
      }
      // Let the save's own debounced watcher reload settle, so what follows is
      // caused by the workspace edit alone.
      await wait(600)
      const before = await call()

      const entryPath = path.join(dataDirWorkspace(), 'index.js')
      fs.writeFileSync(entryPath, source('second'))
      await wait(900)
      const afterWorkspaceEdit = await call()

      console.log(JSON.stringify({ before, afterWorkspaceEdit }))

      function dataDirWorkspace() {
        return path.join(process.env.DATA_DIR, 'extensions', '.workspaces', 'workspace_watch_probe_mjs')
      }
    `)

    assert.equal(out.before, 'first')
    assert.equal(
      out.afterWorkspaceEdit,
      'second',
      'editing the workspace entry the loader imports must trip the watcher',
    )
  })

  it('writes a workspace shim in the module format its own filename implies', () => {
    // The shim is not on the load path any more, but its format still has to be
    // valid: `module.exports = require(...)` in an .mjs file is a syntax error,
    // and it used to overwrite the correct ESM shim an extension's own
    // installer had written.
    const out = runWithTempDataDir<{
      esmShim: string
      cjsShim: string
      esmImported: string
      cjsRequired: string
    }>(`
      import path from 'node:path'
      import fs from 'node:fs'
      import { createRequire } from 'node:module'
      import { pathToFileURL } from 'node:url'
      const extensionsMod = await import('@/lib/server/extensions')
      const { getExtensionManager } = extensionsMod.default || extensionsMod
      const m = getExtensionManager()

      await m.saveExtensionSource(
        'shim_probe.mjs',
        "export default { name: 'ESM Shim Probe', tools: [] }",
        { packageJson: { name: 'shim-probe-esm', type: 'module' } },
      )
      await m.saveExtensionSource(
        'shim_probe.js',
        "module.exports = { name: 'CJS Shim Probe', tools: [] }",
        { packageJson: { name: 'shim-probe-cjs' } },
      )

      const extensionsDir = path.join(process.env.DATA_DIR, 'extensions')
      const esmShimPath = path.join(extensionsDir, 'shim_probe.mjs')
      const cjsShimPath = path.join(extensionsDir, 'shim_probe.js')

      // Loaded, not just pattern-matched: an invalid shim throws here.
      const esmNamespace = await import(pathToFileURL(esmShimPath).href)
      const nodeRequire = createRequire(path.join(extensionsDir, 'noop.js'))
      const cjsExport = nodeRequire(cjsShimPath)

      console.log(JSON.stringify({
        esmShim: fs.readFileSync(esmShimPath, 'utf8'),
        cjsShim: fs.readFileSync(cjsShimPath, 'utf8'),
        esmImported: esmNamespace.default.name,
        cjsRequired: cjsExport.name,
      }))
    `)

    assert.equal(out.esmShim.includes('export { default } from'), true, 'an .mjs shim must be ESM')
    assert.equal(out.esmShim.includes('module.exports'), false, 'an .mjs shim must not contain CommonJS')
    assert.equal(out.cjsShim.includes('module.exports = require('), true, 'a .js shim stays CommonJS')
    assert.equal(out.esmImported, 'ESM Shim Probe')
    assert.equal(out.cjsRequired, 'CJS Shim Probe')
  })

  it('writes no CommonJS require into the shim of a .js extension whose source is an ES module', () => {
    // The fourth format combination, and the only one with no valid bridge. An
    // agent scaffolding through `extension_creator` gets a `.js` filename
    // forced on it while its `packageJson` goes through untouched, so `.js`
    // shim over ESM entry is the shape agent-authored ESM extensions land in.
    // `module.exports = require(<esm entry>)` there loads under a server's
    // Node 22 and raises ERR_REQUIRE_ESM under the desktop app's Node 20.18,
    // and this repo does not ship a file that behaves differently in the two
    // places it runs.
    //
    // Manager-level, so tsx only: `saveExtensionSource` reaches the
    // SQLite-backed storage layer, whose native module is built for one Node
    // ABI at a time. What the shim's *format* does on each shipped runtime is
    // pinned separately by extension-module-loader.test.ts.
    const out = runWithTempDataDir<{
      shim: string
      requireError: string
      toolResult: string
    }>(`
      import path from 'node:path'
      import fs from 'node:fs'
      import { createRequire } from 'node:module'
      const extensionsMod = await import('@/lib/server/extensions')
      const { getExtensionManager } = extensionsMod.default || extensionsMod
      const m = getExtensionManager()

      await m.saveExtensionSource(
        'esm_source_probe.js',
        "export default { name: 'ESM Source Probe', tools: [{ name: 'esm_source_probe', description: 'x', parameters: { type: 'object', properties: {} }, execute: () => 'loaded' }] }",
        { packageJson: { name: 'esm-source-probe', type: 'module' } },
      )

      const extensionsDir = path.join(process.env.DATA_DIR, 'extensions')
      const shimPath = path.join(extensionsDir, 'esm_source_probe.js')
      const nodeRequire = createRequire(path.join(extensionsDir, 'noop.js'))

      let requireError = 'no error'
      try { nodeRequire(shimPath) } catch (err) { requireError = err.message }

      const entry = m.getTools(['esm_source_probe.js']).find((t) => t.tool.name === 'esm_source_probe')
      const toolResult = entry ? String(await entry.tool.execute({}, { session: {}, message: '' })) : 'missing'

      console.log(JSON.stringify({ shim: fs.readFileSync(shimPath, 'utf8'), requireError, toolResult }))
    `)

    assert.equal(out.shim.includes('require('), false, 'a CommonJS shim must not require an ESM entry')
    assert.equal(out.shim.includes('throw new Error('), true, 'the shim must fail the same way on every runtime')
    assert.equal(
      out.shim.includes('./.workspaces/esm_source_probe_js/index.js'),
      true,
      'the shim must name the workspace entry, derived from the workspace constants',
    )
    assert.equal(out.requireError.includes('is an ES module'), true, 'the failure must say why')
    assert.equal(out.toolResult, 'loaded', 'the extension itself still loads: the loader imports the entry, not the shim')
  })

  it('does not count an import of a vanished workspace entry toward auto-disable', () => {
    // Two defects in one sequence. The workspace entry is the file a reinstall
    // replaces, and while it is gone `hasExtensionWorkspace` is false, so
    // resolving the source hands back the extensions-dir shim -- which is
    // still there. Testing that resolved path reported "not vanished" in
    // exactly the case the flag exists for. And `vanished` only ever
    // suppressed the auto-disable *action*: the consecutive-failure count went
    // up anyway, so the genuine failures that followed arrived at the
    // threshold one short.
    //
    // Laid out on disk rather than through saveExtensionSource, and the
    // watcher left to settle between steps, so every failure counted below is
    // one this test asked for.
    const out = runWithTempDataDir<{
      afterVanish: number
      afterFirstBreak: number
      afterSecondBreak: number
      stillEnabled: boolean
      vanishError: string
    }>(`
      import fs from 'node:fs'
      import path from 'node:path'
      const extensionsMod = await import('@/lib/server/extensions')
      const { getExtensionManager } = extensionsMod.default || extensionsMod
      const m = getExtensionManager()
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

      const dataDir = process.env.DATA_DIR
      const extensionsDir = path.join(dataDir, 'extensions')
      const workspaceDir = path.join(extensionsDir, '.workspaces', 'vanish_probe_mjs')
      const entryPath = path.join(workspaceDir, 'index.js')
      fs.mkdirSync(workspaceDir, { recursive: true })
      fs.writeFileSync(path.join(workspaceDir, 'package.json'), '{"name":"vanish-probe","type":"module"}')
      fs.writeFileSync(entryPath, "export default { name: 'Vanish Probe', tools: [] }")
      fs.writeFileSync(
        path.join(extensionsDir, 'vanish_probe.mjs'),
        "export { default } from './.workspaces/vanish_probe_mjs/index.js'",
      )

      const failuresPath = path.join(dataDir, 'extension-failures.json')
      const failure = () => {
        if (!fs.existsSync(failuresPath)) return null
        const state = JSON.parse(fs.readFileSync(failuresPath, 'utf8'))
        return state['vanish_probe.mjs'] || null
      }
      const count = () => (failure() ? failure().count : 0)

      await m.ensureLoaded()

      // The entry an operator's reinstall removes, with the shim left behind.
      fs.rmSync(entryPath)
      await m.reload()
      // The workspace watcher saw that unlink and has a debounced reload of its
      // own coming; let it land so it cannot be mistaken for a later step.
      await wait(900)
      const afterVanish = count()
      const vanishError = failure() ? failure().lastError : ''

      // A genuine failure: the entry is back, and it does not parse.
      fs.writeFileSync(entryPath, 'export default { name: ')
      await m.reload()
      const afterFirstBreak = count()
      await m.reload()
      const afterSecondBreak = count()

      // Written only when something changes it, and an auto-disable is such a
      // change, so an absent file means nothing was disabled.
      const configPath = path.join(dataDir, 'extensions.json')
      const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {}
      const stillEnabled = config['vanish_probe.mjs']?.enabled !== false

      console.log(JSON.stringify({ afterVanish, afterFirstBreak, afterSecondBreak, stillEnabled, vanishError }))
    `)

    assert.equal(out.afterVanish, 0, 'a vanished workspace entry must not advance the consecutive-failure count')
    assert.notEqual(out.vanishError, '', 'the error is still recorded so an operator can see it')
    assert.equal(out.afterFirstBreak, 1, 'the first genuine failure is the first failure')
    assert.equal(out.afterSecondBreak, 2, 'the second genuine failure is the second, not the threshold')
    assert.equal(out.stillEnabled, true, 'two genuine failures must not reach a threshold of three')
  })

  it('reports that an upgraded dependency needs a restart, and that a first install and a no-op reinstall do not', () => {
    // The narrowed cache eviction leaves a workspace's node_modules evaluated
    // once per process on purpose, so an install that upgraded a package
    // reports 'installed' while the copy already loaded is what still runs.
    // Nothing said so outside a loader comment. The flag used to be "there
    // was a node_modules before", which told the operator to restart after a
    // reinstall that changed nothing; it is now whether the manager's own
    // record of the installed tree changed.
    //
    // The package manager is a stub on PATH: the claim under test is about
    // what the host reports, and a real install would be a network request.
    // The stub writes npm's hidden lockfile from a file the test controls, so
    // the same install can be made a no-op or an upgrade at will.
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-stub-npm-'))
    const stubNpm = path.join(binDir, 'npm')
    const lockSource = path.join(binDir, 'lock.json')
    fs.writeFileSync(lockSource, '{"packages":{"node_modules/left-pad":{"version":"1.3.0"}}}')
    fs.writeFileSync(
      stubNpm,
      '#!/bin/sh\nmkdir -p node_modules/left-pad\nprintf \'{"name":"left-pad"}\' > node_modules/left-pad/package.json\n'
      + 'cat "$SWARMCLAW_STUB_LOCK" > node_modules/.package-lock.json\nexit 0\n',
    )
    fs.chmodSync(stubNpm, 0o755)

    try {
      const out = runWithTempDataDir<{
        firstInstall: boolean
        secondInstall: boolean
        thirdInstall: boolean
        fourthInstall: boolean
        hadNodeModulesAfterFirst: boolean
      }>(`
        import fs from 'node:fs'
        import path from 'node:path'
        const extensionsMod = await import('@/lib/server/extensions')
        const { getExtensionManager } = extensionsMod.default || extensionsMod
        const m = getExtensionManager()
        const lockSource = ${JSON.stringify(lockSource)}

        await m.saveExtensionSource(
          'dependency_probe.mjs',
          "export default { name: 'Dependency Probe', tools: [] }",
          { packageJson: { name: 'dependency-probe', type: 'module', dependencies: { 'left-pad': '1.3.0' } } },
        )

        const nodeModules = path.join(
          process.env.DATA_DIR, 'extensions', '.workspaces', 'dependency_probe_mjs', 'node_modules',
        )
        const first = await m.installExtensionDependencies('dependency_probe.mjs')
        const hadNodeModulesAfterFirst = fs.existsSync(nodeModules)
        // Same lockfile: the reinstall resolved to the same tree.
        const second = await m.installExtensionDependencies('dependency_probe.mjs')
        // A different tree: an upgrade this process may already hold the old copy of.
        fs.writeFileSync(lockSource, '{"packages":{"node_modules/left-pad":{"version":"1.3.1"}}}')
        const third = await m.installExtensionDependencies('dependency_probe.mjs')
        // No record of the tree at all: the host cannot tell, and says restart.
        fs.rmSync(path.join(nodeModules, '.package-lock.json'))
        fs.writeFileSync(lockSource, '')
        const fourth = await m.installExtensionDependencies('dependency_probe.mjs')

        console.log(JSON.stringify({
          firstInstall: first.restartRequiredForUpgrades,
          secondInstall: second.restartRequiredForUpgrades,
          thirdInstall: third.restartRequiredForUpgrades,
          fourthInstall: fourth.restartRequiredForUpgrades,
          hadNodeModulesAfterFirst,
        }))
      `, { env: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`, SWARMCLAW_STUB_LOCK: lockSource } })

      assert.equal(out.hadNodeModulesAfterFirst, true, 'the stub package manager must actually populate node_modules')
      assert.equal(out.firstInstall, false, 'a first install has nothing already loaded to go stale')
      assert.equal(out.secondInstall, false, 'a reinstall that resolved to the same tree upgraded nothing this process holds')
      assert.equal(out.thirdInstall, true, 'an install that changed the tree may have upgraded a package this process holds')
      assert.equal(out.fourthInstall, true, 'with no record of the tree the host cannot tell, and errs toward the restart')
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true })
    }
  })
})

describe('extension manager managed resources normalization', () => {
  // `coerceManagedResources` is what actually runs for an externally loaded
  // .mjs/.js extension -- `normalizeExtension` calls it unconditionally, and
  // the result becomes `entry.managedResources` on the loaded extension,
  // which is what `getManagedResources`/`getManagedResourceExtensions` read.
  // `registerBuiltin` (used by every test in
  // extension-managed-resources.test.ts) stores whatever object it is given
  // directly and never touches `coerceManagedResources`, so a `projects`
  // declaration silently dropped by that function would still pass every
  // test in that file. These tests go through the real external-load path
  // via `saveExtensionSource`, which writes the extension's source to disk
  // and reloads it exactly as an install would.
  it('preserves a nested managedResources.projects declaration from an externally loaded extension', () => {
    const out = runWithTempDataDir<{ projects: unknown }>(`
      const extensionsMod = await import('@/lib/server/extensions')
      const { getExtensionManager } = extensionsMod.default || extensionsMod
      const m = getExtensionManager()

      await m.saveExtensionSource('project_nested_probe.mjs', [
        "export default {",
        "  name: 'Project Nested Probe',",
        "  tools: [],",
        "  managedResources: {",
        "    projects: [{ projectKey: 'nested_proj', displayName: 'Nested Project' }],",
        "  },",
        "}",
      ].join('\\n'))

      const managed = m.getManagedResources('project_nested_probe.mjs')
      console.log(JSON.stringify({ projects: managed && managed.projects || null }))
    `)

    assert.deepEqual(out.projects, [{ projectKey: 'nested_proj', displayName: 'Nested Project' }])
  })

  it('preserves the top-level projects alias from an externally loaded extension', () => {
    const out = runWithTempDataDir<{ projects: unknown }>(`
      const extensionsMod = await import('@/lib/server/extensions')
      const { getExtensionManager } = extensionsMod.default || extensionsMod
      const m = getExtensionManager()

      await m.saveExtensionSource('project_alias_probe.mjs', [
        "export default {",
        "  name: 'Project Alias Probe',",
        "  tools: [],",
        "  projects: [{ projectKey: 'alias_proj', displayName: 'Alias Project' }],",
        "}",
      ].join('\\n'))

      const managed = m.getManagedResources('project_alias_probe.mjs')
      console.log(JSON.stringify({ projects: managed && managed.projects || null }))
    `)

    assert.deepEqual(out.projects, [{ projectKey: 'alias_proj', displayName: 'Alias Project' }])
  })
})
