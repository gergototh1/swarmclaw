import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { normalizeContractExtensionId, validateExtensionContracts } from './extension-contracts'

/**
 * The shipped extensions' `provides` and `consumes` declarations, run through
 * the host validator that will actually decide whether they load.
 *
 * WHY THIS EXISTS. Every extension in this repo has its own unit suite, and
 * those suites reach the contract methods the way a consumer does -- by name,
 * off the object the extension builds. That proves the method works. It proves
 * nothing at all about whether the host will accept the declaration the method
 * is published under, because no extension suite ever calls
 * `validateExtensionContracts`. The gap is not hypothetical: a `markRead`
 * method shipped green through three suites (326/361/310 passing) and then
 * failed `load.contracts` on the host, because contract and method names are
 * held to `^[a-z][a-z0-9_]{0,63}$` and camelCase is not in it. The whole gmail
 * extension refused to load, which took the mailbox away from every consumer
 * of it.
 *
 * WHAT IT ASSERTS, and why these two and not more:
 *
 *   1. The host accepts each declaration. This is the real validator, imported
 *      from the host, not a copy of its rules -- a copy would go stale exactly
 *      when the rule it copies changes.
 *   2. Every `consumes` entry names a contract some shipped extension actually
 *      `provides`, at the same version. The host answers an unmet consumption
 *      with `null` at call time rather than refusing the load, so this class of
 *      mistake is silent by design: the operator installs both extensions, the
 *      UI shows the grant, and the consumer's handle is null forever.
 *
 * WHAT IT DOES NOT ASSERT. That a method a consumer calls exists on the
 * provider. Method calls live in the consumer's code, not its manifest, and
 * checking them from here would mean parsing that code. The extensions' own
 * suites cover the call sites.
 *
 * The modules are loaded through a runtime-built URL rather than a static
 * import so `tsc` never pulls the extension trees into the app's type graph:
 * they are separate workspaces with their own dependencies.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

/** The ids the host keys these extensions on -- the file name, `.mjs` and all. */
const SHIPPED = ['gmail.mjs', 'aisignal.mjs', 'crm.mjs']

interface ExtensionModule {
  provides?: unknown
  consumes?: unknown
}

async function loadExtension(id: string): Promise<ExtensionModule> {
  const dir = id.replace(/\.mjs$/, '')
  const url = pathToFileURL(path.join(REPO_ROOT, 'extensions', dir, 'index.mjs')).href
  const mod = (await import(url)) as { default: ExtensionModule }
  return mod.default
}

for (const id of SHIPPED) {
  test(`${id} declares contracts the host will accept`, async () => {
    const ext = await loadExtension(id)
    const result = validateExtensionContracts(id, ext.provides, ext.consumes)
    assert.equal(
      result.ok,
      true,
      `${id} would fail to load at stage load.contracts: ${result.ok ? '' : result.error}`,
    )
  })
}

test('every consumed contract is provided by a shipped extension at the same version', async () => {
  const loaded = await Promise.all(
    SHIPPED.map(async (id) => {
      const ext = await loadExtension(id)
      const result = validateExtensionContracts(id, ext.provides, ext.consumes)
      assert.equal(result.ok, true, `${id} does not validate, so its declarations cannot be matched up`)
      if (!result.ok) throw new Error('unreachable')
      return { id, declarations: result.declarations }
    }),
  )

  const provided = new Map<string, number>()
  for (const { id, declarations } of loaded) {
    for (const [contract, definition] of Object.entries(declarations.provides)) {
      provided.set(`${normalizeContractExtensionId(id)}:${contract}`, definition.version)
    }
  }

  for (const { id, declarations } of loaded) {
    for (const consumption of declarations.consumes) {
      const key = `${normalizeContractExtensionId(consumption.extension)}:${consumption.contract}`
      const version = provided.get(key)
      assert.notEqual(
        version,
        undefined,
        `${id} consumes "${key}" but no shipped extension provides it: the handle would be null at every call`,
      )
      assert.equal(
        version,
        consumption.version,
        `${id} consumes "${key}" at v${consumption.version} but the provider serves v${version}: the host refuses with version_mismatch`,
      )
    }
  }
})
