import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { MIGRATIONS, createRepo } from '../src/db.mjs'

/**
 * An in-memory stand-in for the `ExtensionStorage` handle the host passes to
 * `setup(ctx)`.
 *
 * The host handle wraps `better-sqlite3` on the shared application connection;
 * that is a native module compiled against either Node's or Electron's ABI and
 * cannot be opened twice from a test, so the repository is exercised against
 * `node:sqlite` instead. The two speak the same SQL, and the surface copied
 * here is deliberately the whole contract: `exec` runs exactly one statement
 * (it prepares the SQL, so a semicolon-separated batch throws, same as the
 * host), `all`/`get` read, and `transaction` rolls back and rethrows.
 *
 * `raw` is the extra: migrations do not go through `exec` on the host either,
 * they go through a `db.exec()` path that accepts a whole batch, so the tests
 * apply `MIGRATIONS` through `raw.exec` for the same reason.
 */
export function memStorage() {
  const db = new DatabaseSync(':memory:')
  return {
    exec: (sql, p = []) => { db.prepare(sql).run(...p) },
    all: (sql, p = []) => db.prepare(sql).all(...p),
    get: (sql, p = []) => db.prepare(sql).get(...p),
    transaction: (fn) => {
      db.exec('BEGIN')
      try {
        const r = fn()
        db.exec('COMMIT')
        return r
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
    raw: db,
  }
}

/** A repository over a fresh in-memory database with every migration applied. */
export function freshRepo() {
  const storage = memStorage()
  for (const m of MIGRATIONS) storage.raw.exec(m.sql)
  return { storage, repo: createRepo(storage) }
}

/** A minimal valid scene list and narration, the shape videoDraft stores. */
export const PELDA_JELENETEK = [
  { tipus: 'cimlap', sorok: ['Egy', 'kettő'], kiemelt: 'kettő' },
  { tipus: 'szam', szam: 40, felvezeto: 'Ennyi.' },
  { tipus: 'allitas', mondat: 'Zárlat.' },
]
export const PELDA_NARRACIO = [
  { jelenet: 0, szoveg: 'Első mondat.' },
  { jelenet: 1, szoveg: 'Második mondat.' },
  { jelenet: 2, szoveg: 'Harmadik mondat.' },
]

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'katalogus.generated.json')

/**
 * A throwaway Remotion project for the tests: package.json, the four files
 * render.mjs requires, the catalogue (the fixture the catalogue task ships,
 * or the given text), and a public/ with one image and one symlink that
 * escapes public/.
 *
 * The fixture is read only when this is called, so a suite that does not
 * need a project does not need the fixture either.
 */
export function fakeProject({ catalogText } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-proj-'))
  fs.mkdirSync(path.join(dir, 'src', 'kit'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'public', 'usecase'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), '{}')
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), '')
  fs.writeFileSync(path.join(dir, 'src', 'FosVideo.tsx'), '')
  fs.writeFileSync(path.join(dir, 'src', 'kit', 'katalogus.generated.json'), catalogText ?? fs.readFileSync(FIXTURE, 'utf8'))
  fs.writeFileSync(path.join(dir, 'public', 'usecase', 'kep.png'), 'png-bytes')
  const outside = path.join(dir, 'titkos.txt')
  fs.writeFileSync(outside, 'x')
  fs.symlinkSync(outside, path.join(dir, 'public', 'kifele.png'))
  return dir
}
