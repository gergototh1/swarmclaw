import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Every file a `--test` script names has to be a file that exists.
 *
 * Node's test runner treats a path it cannot find as nothing at all: no
 * warning, no non-zero exit, just one fewer file in the run. So a typo in one
 * of these very long script lines does not break CI — it quietly empties part
 * of the suite, and the tests keep "passing" because they are no longer being
 * run.
 *
 * That is not hypothetical. A missing space in `test:runtime` glued
 * `markdown-blocks-render.test.ts` onto `brand-logo.test.ts`, and the two of
 * them dropped out of the suite together: the brand-logo test had not run
 * since the commit that introduced the typo, and the render-equality test that
 * guards the whole per-block rendering promise never ran at all. Both files
 * were green the entire time, because nothing executed them.
 *
 * A glob is allowed to expand to several files but not to none, for the same
 * reason: a pattern that matches nothing silently drops whatever it used to
 * cover.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../../..')

interface Scripts { [name: string]: string }

const scripts = (JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Scripts }).scripts

/** The script lines that hand file paths to a test runner. */
const RUNNER_SCRIPT = /(?:^|\s)(?:node|tsx)\s+--test(?:\s|$)/

/** The path arguments of a runner script: everything that is not the runner or a flag. */
function testPaths(script: string): string[] {
  return script.split(/\s+/).filter((arg) => arg !== 'node' && arg !== 'tsx' && !arg.startsWith('-'))
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory()
}

/** Expand a `*` pattern the way the shell that runs these scripts does: `*` stays inside one segment. */
function expandGlob(pattern: string): string[] {
  let matches = ['']
  for (const segment of pattern.split('/')) {
    if (!segment.includes('*')) {
      matches = matches
        .filter((base) => existsSync(resolve(REPO_ROOT, base, segment)))
        .map((base) => (base ? `${base}/${segment}` : segment))
      continue
    }
    const escaped = segment.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    const segmentRe = new RegExp(`^${escaped.join('[^/]*')}$`)
    const next: string[] = []
    for (const base of matches) {
      const dir = resolve(REPO_ROOT, base)
      if (!isDirectory(dir)) continue
      for (const entry of readdirSync(dir)) {
        if (segmentRe.test(entry)) next.push(base ? `${base}/${entry}` : entry)
      }
    }
    matches = next
  }
  return matches
}

const runnerScripts = Object.entries(scripts).filter(([, script]) => RUNNER_SCRIPT.test(script))

describe('package.json test scripts', () => {
  it('has runner scripts to check', () => {
    assert.ok(runnerScripts.length > 0, 'no `node --test` / `tsx --test` script found in package.json')
    assert.ok(
      runnerScripts.some(([name]) => name === 'test:runtime'),
      'test:runtime must be one of the scripts this guard covers',
    )
  })

  for (const [name, script] of runnerScripts) {
    it(`${name} names only paths that exist`, () => {
      const paths = testPaths(script)
      assert.ok(paths.length > 0, `${name} passes no test paths`)
      const missing = paths.filter((path) => (
        path.includes('*')
          ? expandGlob(path).length === 0
          : !existsSync(resolve(REPO_ROOT, path))
      ))
      assert.deepEqual(
        missing,
        [],
        `${name} names ${missing.length} path(s) that do not exist; node --test skips them without a word`,
      )
    })
  }
})
