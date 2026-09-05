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
 * WHAT IS BEING TESTED AND WHY IT IS WORTH A SUBPROCESS. `scripts/install.mjs`
 * is a script, not a module: it does its work at top level and there is
 * nothing to import and call. It also does the one thing in this repo that
 * deletes a directory tree the operator owns -- it removes from `<home>/skills`
 * every directory the previous install recorded in a manifest and the repo no
 * longer ships. That manifest is a plain JSON file inside the data directory,
 * it survives across installs, nothing signs it, and it is read as trusted.
 *
 * An entry of `""` makes the delete target `<home>/skills`; an entry of `".."`
 * makes it `<home>`, which with SWARMCLAW_HOME set holds the data directory,
 * the database and every installed extension. So the manifest is written here
 * with exactly those entries and the run has to leave the home standing.
 *
 * Every run gets its own SWARMCLAW_HOME under the system temp directory, and
 * the script's own resolution order puts an explicit SWARMCLAW_HOME first
 * (DATA_DIR is not set here, so `<home>/data` is where it installs). Nothing
 * here touches a real data directory.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(root, 'scripts', 'install.mjs')

function installInto(home) {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, SWARMCLAW_HOME: home, DATA_DIR: '', REMOTION_DIR: '' },
  })
}

function freshHome() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'video-install-')))
  fs.mkdirSync(path.join(home, 'skills'), { recursive: true })
  fs.mkdirSync(path.join(home, 'data'), { recursive: true })
  fs.writeFileSync(path.join(home, 'skills', 'operator-sajat-skill.md'), 'az operátoré')
  fs.writeFileSync(path.join(home, 'data', 'app.db'), 'az adatbázis')
  return home
}

function writeManifest(home, entries) {
  const ws = path.join(home, 'data', 'extensions', '.workspaces', 'video_mjs')
  fs.mkdirSync(ws, { recursive: true })
  fs.writeFileSync(path.join(ws, 'shipped-skills.json'), `${JSON.stringify(entries, null, 2)}\n`)
}

test('an install refuses every manifest entry that is not a plain directory name, and leaves the home standing', () => {
  const home = freshHome()
  try {
    // Each of these, joined onto `<home>/skills`, names something outside the
    // set of directories this installer ships: the skills layer itself, the
    // home above it, and a path built to walk out of both.
    writeManifest(home, ['', '..', '.', 'video-jelenetlista/../..', path.join(home, 'skills'), '../../etc', 42, null])
    const run = installInto(home)
    assert.equal(run.status, 0, run.stderr || run.stdout)

    assert.equal(fs.existsSync(home), true, 'the home survived')
    assert.equal(fs.existsSync(path.join(home, 'skills')), true, 'the skills layer survived')
    assert.equal(fs.readFileSync(path.join(home, 'skills', 'operator-sajat-skill.md'), 'utf8'), 'az operátoré')
    assert.equal(fs.readFileSync(path.join(home, 'data', 'app.db'), 'utf8'), 'az adatbázis')
    // A refused entry is reported rather than passed over in silence: the
    // operator whose manifest was edited has to be able to see it.
    assert.match(run.stderr, /manifest-bejegyzés/)
    for (const entry of ['""', '".."']) assert.ok(run.stderr.includes(entry), `${entry} named in the report`)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('an install ships the repo skills and removes only a plain name the previous install shipped and the repo dropped', () => {
  const home = freshHome()
  try {
    const shipped = fs.readdirSync(path.join(root, 'skills'))
    assert.ok(shipped.length > 0, 'this extension ships skills; the removal block is live, not dormant')

    // A directory the previous install recorded and the repo no longer has:
    // the one case the removal exists for.
    fs.mkdirSync(path.join(home, 'skills', 'video-regi-skill'), { recursive: true })
    fs.writeFileSync(path.join(home, 'skills', 'video-regi-skill', 'SKILL.md'), 'régi')
    writeManifest(home, ['video-regi-skill'])

    const run = installInto(home)
    assert.equal(run.status, 0, run.stderr || run.stdout)
    assert.equal(fs.existsSync(path.join(home, 'skills', 'video-regi-skill')), false, 'the renamed skill was removed')
    for (const name of shipped) {
      assert.equal(fs.existsSync(path.join(home, 'skills', name, 'SKILL.md')), true, `${name} was shipped`)
    }
    assert.equal(fs.existsSync(path.join(home, 'skills', 'operator-sajat-skill.md')), true, 'a hand-placed skill is not this script\'s to remove')
    const manifest = JSON.parse(fs.readFileSync(path.join(home, 'data', 'extensions', '.workspaces', 'video_mjs', 'shipped-skills.json'), 'utf8'))
    assert.deepEqual(manifest.slice().sort(), shipped.slice().sort())
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
