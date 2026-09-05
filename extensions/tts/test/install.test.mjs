import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

/**
 * The installer, driven against a throwaway home.
 *
 * This extension ships no skills, and that is exactly why the test is here:
 * the removal block is not dormant just because the copy loop has nothing to
 * copy. It reads `shipped-skills.json` -- a plain JSON file that lives inside
 * the data directory, survives every install and is signed by nothing -- and
 * deletes `<home>/skills/<entry>` recursively for every entry the repo no
 * longer ships. With `""` that target is `<home>/skills`; with `".."` it is
 * `<home>`, which under SWARMCLAW_HOME holds the data directory, the database
 * and every installed extension.
 *
 * Every run gets its own SWARMCLAW_HOME under the system temp directory. No
 * real data directory is touched.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(root, 'scripts', 'install.mjs')

test('an install refuses every manifest entry that is not a plain directory name, and leaves the home standing', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tts-install-')))
  try {
    fs.mkdirSync(path.join(home, 'skills'), { recursive: true })
    fs.mkdirSync(path.join(home, 'data'), { recursive: true })
    fs.writeFileSync(path.join(home, 'skills', 'operator-sajat-skill.md'), 'az operátoré')
    fs.writeFileSync(path.join(home, 'data', 'app.db'), 'az adatbázis')
    const ws = path.join(home, 'data', 'extensions', '.workspaces', 'tts_mjs')
    fs.mkdirSync(ws, { recursive: true })
    fs.writeFileSync(path.join(ws, 'shipped-skills.json'), JSON.stringify(['', '..', '.', '../../etc', path.join(home, 'skills'), 7]))

    const run = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...process.env, SWARMCLAW_HOME: home, DATA_DIR: '' },
    })
    assert.equal(run.status, 0, run.stderr || run.stdout)

    assert.equal(fs.existsSync(home), true, 'the home survived')
    assert.equal(fs.existsSync(path.join(home, 'skills')), true, 'the skills layer survived')
    assert.equal(fs.readFileSync(path.join(home, 'skills', 'operator-sajat-skill.md'), 'utf8'), 'az operátoré')
    assert.equal(fs.readFileSync(path.join(home, 'data', 'app.db'), 'utf8'), 'az adatbázis')
    assert.equal(fs.existsSync(path.join(home, 'data', 'extensions', 'tts.mjs')), true, 'the install itself still ran')
    assert.match(run.stderr, /manifest-bejegyzés/)
    for (const entry of ['""', '".."']) assert.ok(run.stderr.includes(entry), `${entry} named in the report`)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
