# Doksik extension — implementációs terv

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Egy `docs.mjs` SwarmClaw-extension, ami valódi `.md` fájlokat kezel egy operátor által megadott gyökérmappában — grafikus szerkesztővel az operátornak, hat toollal az ügynököknek, ügynökönként automatikus mappával.

**Architecture:** A lemez az igazság, az adatbázis index fölötte. Minden írás (lap, tool, szerződés) fájlt ír **és** azonnal indexel ugyanazon az `index-writer` függvényen át; a fájlfigyelő csak a kívülről érkező változást kapja el, a sajátunkat hash-egyezés alapján kiszűri. Réteges, egyirányú függés: `vault` (lemez) és `db` (index) nem tud a fölöttük lévőkről.

**Tech Stack:** Node ESM (`.mjs`), `node --test` + `tsx`, SQLite a host `ctx.storage`-án át, React + TipTap a lapon, esbuild bundle.

**Specifikáció:** `doc/specs/2026-09-05-doksik-extension-design.md` — minden szakaszra hivatkozunk a feladatoknál.

---

## Global Constraints

Minden feladat követelményei implicit tartalmazzák ezeket.

- **Extension-fájlnév: `docs.mjs`.** Ebből a host `ext_docs_` tábla-előtagot képez (`extensionTablePrefix`, `src/lib/server/extensions/extension-storage.ts`). Minden `CREATE TABLE` neve **kisbetűvel** `ext_docs_`-szal kezdődik — az összehasonlítás kis-nagybetű-érzékeny, a nagybetűs változat nevesített hibával elszáll.
- **Forrásmappa: `extensions/docs/`.** A mappanév egyezik a fájlnévvel, ahogy a `video`, `tts`, `gmail`, `aisignal` moduloknál.
- **Megjelenő név: `Doksik`.** Az `index.mjs` `name` mezője. A lap `label`-je szintén `Doksik`.
- **Lap útvonala: `/x/docs`.** A `path` `/x/<slug>` alakú kell legyen, és egyedi a telepített extensionök között (`validateExtensionPages`).
- **Lap ikonja: `FileText`.** Az `EXTENSION_PAGE_ICON_NAMES` listán rajta van (`src/lib/extension-page-nav.ts`). Listán kívüli név némán a `Puzzle` fallbackot rajzolja.
- **Lap pozíciója: `after:tasks`.** Az `EXTENSION_NAV_ANCHORS` egyetlen eleme a `tasks`; bármi más a záró „Extension Pages" csoportba kerül.
- **`entry` és `css` kötelezően `dist/`-tel kezdődik** (`dist/index.js`, `dist/style.css`). Csak a `<workspace>/dist` szolgálódik ki.
- **A `react`, `react-dom` és `react/jsx-runtime` nem kerülhet a bundle-be.** A host saját React-fájából rendereli a lapot; egy második React-példány minden hookot eldob. Az esbuild `hostModules` plugin oldja fel őket `window.swarmclaw.modules` olvasásokra — a `extensions/tts/scripts/build.mjs` mintája szó szerint átvehető, csak a hibaüzenet előtagja lesz `docs:`.
- **Nyelv:** a kód azonosítói és a kommentek angolul, a felhasználónak és az ügynöknek szóló szövegek (tool-leírások, hibaüzenetek, lap-feliratok, beállítás-címkék) magyarul — ahogy a `video` és `tts` modulban.
- **Minden ügynök-tool hibaformája:** `{ hiba: '<kód>', uzenet: '<mit tegyél>' }`. Az `uzenet` cselekvést ír le, nem állapotot.
- **`ctx.storage` csak egyetlen utasítást futtat hívásonként.** Pontosvesszővel elválasztott köteg nyers driver-hibával elszáll; többes SQL csak migrációként megy.
- **A modul betöltése nem nyithat handle-t és nem olvashat fájlt.** A `setup()` **újrafut minden `data/extensions` alatti írásra**, ezért semmi időzítő, listener vagy fájlolvasás nem történhet modul-szinten. (A `video` modulnak van erre `import-time.test.mjs` tesztje; nekünk is lesz.)
- **Tesztfuttatás:** `node --import tsx --test test/*.test.mjs` a `extensions/docs/` mappából, és a repo gyökeréből az `npm run test:runtime` is futtatja majd, miután a `package.json` `test:runtime` sorába felvettük az `'extensions/docs/test/*.test.mjs'` mintát.
- **Commitok:** feladatonként legalább egy, magyar tárgy nélkül — a repo commit-nyelve angol, tárgysor mondatként, prefix nélkül (lásd `git log`). A fork trailerei kellenek: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` és `Claude-Session: https://claude.ai/code/session_01LnVFFRxaMFKVLGVag5bSte`.

---

## Fájlszerkezet

```
extensions/docs/
  package.json           npm-manifest, devDeps: esbuild, tsx, react, react-dom, @tiptap/*
  index.mjs              a modul deklarációja: name, migrations, setup, tools, rpc, hooks, provides, ui
  src/
    errors.mjs           DocsError + a hibakódok egyetlen listája
    vault.mjs            lemez: útvonal-biztonság, fejléc, atomi írás, mozgatás, kuka
    db.mjs               MIGRATIONS + createRepo(storage)
    permissions.mjs      canWrite(actor, relPath, opts)
    index-writer.mjs     fájl → indexsor; a self-write tábla is itt él
    links.mjs            [[...]] kinyerés, feloldás, visszahivatkozás, átnevezéskori frissítés
    watcher.mjs          ensureWatcher(state) — idempotens indítás/leállítás
    tools.mjs            a hat ügynök-tool
    agent-context.mjs    getAgentContext + getCapabilityDescription + getOperatingGuidance
    contract.mjs         provides.docs
    rpc.mjs              a lap metódusai
  ui/
    host.ts              window.swarmclaw elérése
    api.ts               az rpc típusai és olvasói a lap oldalán
    main.tsx             belépő: registerPage
    fa.tsx               bal hasáb: mappafa, kereső, kuka
    szerkeszto.tsx       közép: TipTap + mentés + ütközéssáv
    panel.tsx            jobb hasáb: meta, verziók, visszahivatkozások
    style.css
  scripts/
    build.mjs            esbuild → dist/
    install.mjs          telepítés a futó desktop app extensions mappájába
  test/
    *.test.mjs
```

Felelősségi határok, amiket a feladatok nem mosnak össze:

- `vault.mjs` **nem tud** az adatbázisról, és nem dönt jogosultságról.
- `db.mjs` **nem nyúl fájlhoz.**
- `permissions.mjs`-nek **nincs mellékhatása**, csak visszaad.
- `index-writer.mjs` a **egyetlen** hely, ami indexsort ír; a lap, a toolok és a figyelő is ezt hívja.
- `watcher.mjs` **nem ír fájlt.**

---

## Feladatsorrend és függések

```
1 errors ─┬─ 2 vault ──┐
          ├─ 4 permissions
          └─ 3 db ─────┴─ 5 links ─ 6 index-writer ─ 7 index.mjs csontváz
                                                       ├─ 8 tools ─ 9 agent-context
                                                       ├─ 10 watcher
                                                       ├─ 11 contract
                                                       ├─ 12 rpc
                                                       └─ 13 UI build ─ 14 fa ─ 15 szerkesztő ─ 16 panel
                                                                                                  └─ 17 install + élő teszt
```

A `links` megelőzi az `index-writer`-t, mert az indexelés minden fájlnál kinyeri a hivatkozásokat — a függés ebbe az irányba mutat.

Az 1–6. feladat tiszta Node, host nélkül tesztelhető. A 7. után a modul betöltődik a futó appban. A 13–16. a lap. A 17. zárja a kört.

**A kódblokkokról:** a tesztek teljes egészében itt vannak — azok rögzítik a viselkedést, és azokat kell szó szerint bemásolni. Az implementációnál a szerkezet, a szignatúrák és a nem nyilvánvaló részek szerepelnek; a magyarázó doc-kommenteket a valódi forrásba írd, ne ide. Egy modul akkor kész, ha a hozzá tartozó összes teszt zölden fut.

---

### Task 1: Hibakódok és a csomag váza

Minden hiba egy helyen születik, hogy a tool-válaszok és a lap ugyanazt a kódot lássa. A feladat egyben létrehozza az npm-csomagot, mert enélkül a következő feladat első lépését sem lehet lefuttatni.

**Files:**
- Create: `extensions/docs/package.json`
- Create: `extensions/docs/src/errors.mjs`
- Create: `extensions/docs/test/errors.test.mjs`
- Modify: `package.json` (repo gyökér, `test:runtime` sor vége)

**Interfaces:**
- Consumes: semmit.
- Produces: `DocsError` (osztály, `code` + `message`), `HIBA` (fagyasztott kódtábla), `hiba(code, uzenet)` → `{ hiba, uzenet }`.

- [ ] **Step 1: Hozd létre a csomagot**

`extensions/docs/package.json`:

```json
{
  "name": "swarmclaw-docs",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node scripts/build.mjs",
    "test": "node --import tsx --test test/*.test.mjs",
    "install:local": "node scripts/install.mjs"
  },
  "devDependencies": {
    "esbuild": "^0.25.0",
    "react": "19.2.3",
    "react-dom": "19.2.3",
    "tsx": "^4.20.6"
  }
}
```

Run: `cd extensions/docs && npm install`
Expected: kész, `node_modules/` létrejön.

- [ ] **Step 2: Írd meg a bukó tesztet**

`extensions/docs/test/errors.test.mjs`:

```js
import assert from 'node:assert/strict'
import test from 'node:test'

import { DocsError, HIBA, hiba } from '../src/errors.mjs'

test('DocsError carries a code from the table', () => {
  const err = new DocsError(HIBA.gyoker_nem_irhato, 'A doksi-gyökér nem írható: /tmp/x')
  assert.ok(err instanceof Error)
  assert.equal(err.code, 'gyoker_nem_irhato')
  assert.equal(err.message, 'A doksi-gyökér nem írható: /tmp/x')
})

test('hiba() builds the tool response shape', () => {
  assert.deepEqual(hiba(HIBA.nincs_jog, 'Ebbe a mappába nem írhatsz.'), {
    hiba: 'nincs_jog',
    uzenet: 'Ebbe a mappába nem írhatsz.',
  })
})

test('the code table is frozen and every value equals its key', () => {
  assert.ok(Object.isFrozen(HIBA))
  for (const [key, value] of Object.entries(HIBA)) assert.equal(value, key)
})
```

- [ ] **Step 3: Futtasd — bukik**

Run: `cd extensions/docs && npm test`
Expected: FAIL — `Cannot find module '../src/errors.mjs'`

- [ ] **Step 4: Írd meg az implementációt**

`extensions/docs/src/errors.mjs` — hét kód, a kulcs és az érték azonos (a teszt ezt rögzíti, hogy a `HIBA.utkozes` és a `'utkozes'` írásmód ne tudjon szétcsúszni):

```js
export const HIBA = Object.freeze({
  gyoker_nem_irhato: 'gyoker_nem_irhato',   // a gyökér nincs beállítva / nem írható
  utvonal_tiltott: 'utvonal_tiltott',       // kilépne a gyökérből, vagy kifelé mutató symlink
  nincs_ilyen_doksi: 'nincs_ilyen_doksi',
  nincs_jog: 'nincs_jog',                   // olvashatja, de nem írhatja
  utkozes: 'utkozes',                       // baseVersion nem egyezik
  mar_letezik: 'mar_letezik',
  rossz_parameter: 'rossz_parameter',
})

export class DocsError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'DocsError'
    this.code = code
  }
}

export function hiba(code, uzenet) {
  return { hiba: code, uzenet }
}
```

A `DocsError`-t a modul belsejében dobjuk; a tool-réteg kapja el, és `hiba()`-alakká fordítja. `src/`-en kívül senki nem dobja és nem kapja el.

- [ ] **Step 5: Futtasd — átmegy**

Run: `cd extensions/docs && npm test`
Expected: PASS — 3 teszt.

- [ ] **Step 6: Vedd fel a tesztet a repo futtatójába**

A repo gyökerének `package.json`-jában a `test:runtime` sor legvégén, a `'extensions/video/test/*.test.mjs'` **után** told be:

```
'extensions/docs/test/*.test.mjs'
```

Run: `npm run test:runtime 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: `# fail 0`, és `# tests` > 1947 (ennyi volt a baseline).

- [ ] **Step 7: Commit**

Tárgysor: `Docs module: the error table every layer names failures from`. Törzs: miért kód és nem naplósor (a tool-válaszok és a lap is erre kapcsol), és miért egyenlő a kulcs az értékkel. Trailerek a Global Constraints szerint.

---

### Task 2: `vault.mjs` — a lemez

Az egyetlen modul, ami fájlt olvas és ír. Semmit nem tud az adatbázisról, és nem dönt jogosultságról.

**Files:**
- Create: `extensions/docs/src/vault.mjs`
- Create: `extensions/docs/test/vault.test.mjs`

**Interfaces:**
- Consumes: `DocsError`, `HIBA` (Task 1).
- Produces:
  - `createVault({ root })` → `{ root, abs, rel, ensureRoot, exists, readDoc, writeDoc, listDocs, move, trash }`
  - `vault.root` — abszolút, `realpathSync`-kel feloldott gyökér
  - `vault.abs(rel)` → abszolút út; dob `utvonal_tiltott`-ot, ha kilépne
  - `vault.rel(abs)` → gyökérhez képesti út, mindig `/` elválasztóval
  - `vault.ensureRoot()` → `void`; dob `gyoker_nem_irhato`-t
  - `vault.readDoc(rel)` → `{ meta, body, raw, size, hash }`; dob `nincs_ilyen_doksi`-t
  - `vault.writeDoc(rel, { meta, body })` → `{ raw, size, hash }` — atomi
  - `vault.listDocs()` → `rel[]`, minden `.md`, a `.swarmdocs/` kihagyva
  - `vault.exists(rel)` → `boolean`
  - `vault.move(fromRel, toRel)` → `void`; dob `mar_letezik`-et
  - `vault.trash(rel, id)` → `{ trashRel }`
  - `parseFrontMatter(raw)` → `{ meta, body }`
  - `serializeDoc(meta, body)` → `raw`
  - `newDocId()` → `'doc_' + 8 hex`
  - `hashOf(text)` → hex sha256

- [ ] **Step 1: Írd meg a teljes teszt-fájlt**

`extensions/docs/test/vault.test.mjs`:

```js
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { HIBA } from '../src/errors.mjs'
import { createVault, hashOf, newDocId, parseFrontMatter, serializeDoc } from '../src/vault.mjs'

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'docs-vault-'))
}

test('abs() refuses to leave the root', () => {
  const root = tempRoot()
  try {
    const vault = createVault({ root })
    for (const bad of ['../elsewhere.md', 'a/../../b.md', '/etc/passwd', 'a/../../']) {
      assert.throws(() => vault.abs(bad), (err) => err.code === HIBA.utvonal_tiltott, `elfogadta: ${bad}`)
    }
    assert.equal(vault.abs('agents/marketing/x.md'), path.join(vault.root, 'agents/marketing/x.md'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('abs() refuses a symlink that points out of the root', () => {
  const root = tempRoot()
  const outside = tempRoot()
  try {
    const vault = createVault({ root })
    fs.symlinkSync(outside, path.join(vault.root, 'kifele'))
    assert.throws(() => vault.abs('kifele/x.md'), (err) => err.code === HIBA.utvonal_tiltott)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test('front matter survives a round trip', () => {
  const meta = {
    id: 'doc_a1b2c3d4',
    title: 'Ügyfélprofil — Morvai: "nagy" ügy',
    owner: 'agent:marketing',
    tags: ['ügyfél', 'avian'],
    created: '2026-09-05T18:22:00.000Z',
    updated: '2026-09-05T18:41:12.000Z',
  }
  const body = '# Cím\n\nSzöveg [[Másik doksi]] után.\n'
  const parsed = parseFrontMatter(serializeDoc(meta, body))
  assert.deepEqual(parsed.meta, meta)
  assert.equal(parsed.body, body)
})

test('a file with no front matter parses as all body', () => {
  const parsed = parseFrontMatter('# Csak cím\n\nSemmi fejléc.\n')
  assert.deepEqual(parsed.meta, {})
  assert.equal(parsed.body, '# Csak cím\n\nSemmi fejléc.\n')
})

test('a broken front matter block is kept as body, not dropped', () => {
  const raw = '---\n  rossz behuzas\ntitle: x\n---\n\nTörzs.\n'
  const parsed = parseFrontMatter(raw)
  assert.deepEqual(parsed.meta, {})
  assert.equal(parsed.body, raw)
})

test('tags round-trip as a list even when empty', () => {
  const parsed = parseFrontMatter(serializeDoc({ id: 'doc_1', title: 'x', tags: [] }, 'y\n'))
  assert.deepEqual(parsed.meta.tags, [])
})

test('writeDoc is atomic and readDoc gives back what was written', () => {
  const root = tempRoot()
  try {
    const vault = createVault({ root })
    vault.ensureRoot()
    const meta = { id: newDocId(), title: 'Teszt', owner: 'user', tags: [] }
    const written = vault.writeDoc('kozos/teszt.md', { meta, body: 'Törzs.\n' })
    assert.equal(written.hash, hashOf(written.raw))

    const read = vault.readDoc('kozos/teszt.md')
    assert.equal(read.meta.id, meta.id)
    assert.equal(read.body, 'Törzs.\n')
    assert.equal(read.hash, written.hash)

    // A rename-hez használt ideiglenes fájl nem maradhat ott.
    assert.deepEqual(fs.readdirSync(path.join(vault.root, 'kozos')), ['teszt.md'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('listDocs finds .md under the root and skips .swarmdocs', () => {
  const root = tempRoot()
  try {
    const vault = createVault({ root })
    vault.ensureRoot()
    vault.writeDoc('agents/a/egy.md', { meta: { id: 'doc_1', title: 'egy' }, body: 'x\n' })
    vault.writeDoc('kozos/ketto.md', { meta: { id: 'doc_2', title: 'kettő' }, body: 'x\n' })
    fs.mkdirSync(path.join(vault.root, '.swarmdocs/trash/doc_9'), { recursive: true })
    fs.writeFileSync(path.join(vault.root, '.swarmdocs/trash/doc_9/harom.md'), 'x')
    fs.writeFileSync(path.join(vault.root, 'kozos/nem-md.txt'), 'x')

    assert.deepEqual(vault.listDocs().sort(), ['agents/a/egy.md', 'kozos/ketto.md'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('move refuses to overwrite, trash preserves the file', () => {
  const root = tempRoot()
  try {
    const vault = createVault({ root })
    vault.ensureRoot()
    vault.writeDoc('kozos/a.md', { meta: { id: 'doc_a', title: 'a' }, body: 'aaa\n' })
    vault.writeDoc('kozos/b.md', { meta: { id: 'doc_b', title: 'b' }, body: 'bbb\n' })

    assert.throws(() => vault.move('kozos/a.md', 'kozos/b.md'), (err) => err.code === HIBA.mar_letezik)

    vault.move('kozos/a.md', 'agents/x/a.md')
    assert.equal(vault.exists('kozos/a.md'), false)
    assert.equal(vault.readDoc('agents/x/a.md').body, 'aaa\n')

    const { trashRel } = vault.trash('kozos/b.md', 'doc_b')
    assert.equal(vault.exists('kozos/b.md'), false)
    assert.ok(fs.readFileSync(path.join(vault.root, trashRel), 'utf8').includes('bbb'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('ensureRoot names an unwritable root instead of failing silently', () => {
  const root = tempRoot()
  try {
    fs.chmodSync(root, 0o500)
    const vault = createVault({ root: path.join(root, 'alatta') })
    assert.throws(() => vault.ensureRoot(), (err) => err.code === HIBA.gyoker_nem_irhato)
  } finally {
    fs.chmodSync(root, 0o700)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('readDoc names a missing file', () => {
  const root = tempRoot()
  try {
    const vault = createVault({ root })
    vault.ensureRoot()
    assert.throws(() => vault.readDoc('nincs.md'), (err) => err.code === HIBA.nincs_ilyen_doksi)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Futtasd — bukik**

Run: `cd extensions/docs && npm test`
Expected: FAIL — `Cannot find module '../src/vault.mjs'`

- [ ] **Step 3: Írd meg az útvonal-réteget**

Ez a rész a modul biztonsági határa. **Két külön ellenőrzés kell, mert mást fognak meg:** a lexikális (`path.relative`) a `..`-t és az abszolút bemenetet fogja meg, syscall előtt; a `realpathSync`-es azt a gyökéren *belüli* symlinket, ami kifelé mutat — lexikailag az az út rendben van, és csak a fájlrendszertől lehet megkérdezni, hova visz. A második ellenőrzés a legközelebbi *létező* ősig sétál fel, mert íráskor a cél még nem létezik.

A gyökeret magát `realpathSync`-kel oldjuk fel, ha létezik: macOS-en a `/tmp` maga is symlink, és e nélkül minden későbbi tartalmazás-vizsgálat elbukna.

```js
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { DocsError, HIBA } from './errors.mjs'

export function hashOf(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

export function newDocId() {
  return `doc_${crypto.randomBytes(4).toString('hex')}`
}

export function createVault({ root }) {
  if (typeof root !== 'string' || root.trim() === '') {
    throw new DocsError(HIBA.gyoker_nem_irhato, 'A doksi-gyökér nincs beállítva. Add meg a Doksik extension beállításainál.')
  }
  const expanded = root.startsWith('~/') ? path.join(os.homedir(), root.slice(2)) : root
  const resolved = path.resolve(expanded)
  const realRoot = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved

  function abs(rel) {
    if (typeof rel !== 'string') throw new DocsError(HIBA.utvonal_tiltott, 'Az útvonal nem szöveg.')
    const joined = path.resolve(realRoot, rel)
    const relative = path.relative(realRoot, joined)
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new DocsError(HIBA.utvonal_tiltott, `Ez az útvonal kilépne a doksi-gyökérből: ${rel}`)
    }
    let probe = joined
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe)
      if (parent === probe) break
      probe = parent
    }
    if (fs.existsSync(probe)) {
      const realRelative = path.relative(realRoot, fs.realpathSync(probe))
      if (realRelative !== '' && (realRelative.startsWith('..') || path.isAbsolute(realRelative))) {
        throw new DocsError(HIBA.utvonal_tiltott, `Ez az útvonal a doksi-gyökéren kívülre mutat: ${rel}`)
      }
    }
    return joined
  }

  function rel(absPath) {
    return path.relative(realRoot, absPath).split(path.sep).join('/')
  }

  // ... a többi metódus a Step 5-ben

  return { root: realRoot, abs, rel }
}
```

- [ ] **Step 4: Írd meg a fejléc-réteget**

A `createVault` **elé**. Szándékosan hatkulcsos YAML-részhalmaz, nem YAML-függőség: amit ez a modul ír, az mind a `serializeDoc`-on megy át, tehát csak idegen fájl lehet más alakú — és arra a szabály az, hogy **ha nem ebbe a részhalmazba parsol, akkor nem fejléc, és az egész fájl törzs. Semmit nem dobunk el.**

```js
const FM_OPEN = '---\n'

export function parseFrontMatter(raw) {
  if (!raw.startsWith(FM_OPEN)) return { meta: {}, body: raw }
  const end = raw.indexOf('\n---\n', FM_OPEN.length - 1)
  if (end === -1) return { meta: {}, body: raw }
  const block = raw.slice(FM_OPEN.length, end + 1)
  const body = raw.slice(end + '\n---\n'.length)
  const meta = {}
  for (const line of block.split('\n')) {
    if (line.trim() === '') continue
    const colon = line.indexOf(':')
    if (colon <= 0 || /^\s/.test(line)) return { meta: {}, body: raw }
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (key === 'tags') {
      if (!value.startsWith('[') || !value.endsWith(']')) return { meta: {}, body: raw }
      const inner = value.slice(1, -1).trim()
      meta.tags = inner === '' ? [] : inner.split(',').map((t) => unquote(t.trim()))
      continue
    }
    meta[key] = unquote(value)
  }
  return { meta, body }
}

function unquote(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  return value
}

function quote(value) {
  const text = String(value)
  if (text === '' || /[:#[\]{}",\n]/.test(text) || text !== text.trim()) {
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return text
}

export function serializeDoc(meta, body) {
  const lines = []
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null) continue
    lines.push(key === 'tags' ? `tags: [${value.map(quote).join(', ')}]` : `${key}: ${quote(value)}`)
  }
  const normalizedBody = body.endsWith('\n') || body === '' ? body : `${body}\n`
  return `${FM_OPEN}${lines.join('\n')}\n---\n${normalizedBody}`
}
```

- [ ] **Step 5: Írd meg a fájlműveleteket**

A `createVault`-on belül, a `rel()` után. A `writeDoc` **ugyanabba a könyvtárba** ír ideiglenes fájlt, majd `rename`-el: a rename egy fájlrendszeren belül atomi, más fájlrendszerre viszont másolás, és a másolás nem az. A temp-név véletlen utótagot kap, hogy két egyidejű írás ne ütközzön rajta.

A `trash` id szerinti **könyvtárba** rak, nem lapos fájlba: két azonos fájlnevű, más mappában lakó doksi így nem ütközik a kukában, és a visszaállításnak elég az id.

```js
  function ensureRoot() {
    try {
      fs.mkdirSync(realRoot, { recursive: true })
      fs.accessSync(realRoot, fs.constants.W_OK)
    } catch {
      throw new DocsError(HIBA.gyoker_nem_irhato, `A doksi-gyökér nem hozható létre vagy nem írható: ${realRoot}`)
    }
  }

  function exists(relPath) {
    return fs.existsSync(abs(relPath))
  }

  function readDoc(relPath) {
    const target = abs(relPath)
    let raw
    try {
      raw = fs.readFileSync(target, 'utf8')
    } catch {
      throw new DocsError(HIBA.nincs_ilyen_doksi, `Nincs ilyen doksi: ${relPath}`)
    }
    const { meta, body } = parseFrontMatter(raw)
    return { meta, body, raw, size: Buffer.byteLength(raw), hash: hashOf(raw) }
  }

  function writeDoc(relPath, { meta, body }) {
    const target = abs(relPath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const raw = serializeDoc(meta, body)
    const tmp = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`
    try {
      fs.writeFileSync(tmp, raw, 'utf8')
      fs.renameSync(tmp, target)
    } catch (err) {
      fs.rmSync(tmp, { force: true })
      throw err
    }
    return { raw, size: Buffer.byteLength(raw), hash: hashOf(raw) }
  }

  function listDocs() {
    const found = []
    const walk = (dirRel) => {
      const dirAbs = dirRel === '' ? realRoot : abs(dirRel)
      for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
        if (entry.name === '.swarmdocs') continue
        const childRel = dirRel === '' ? entry.name : `${dirRel}/${entry.name}`
        if (entry.isDirectory()) walk(childRel)
        else if (entry.isFile() && entry.name.endsWith('.md')) found.push(childRel)
      }
    }
    if (fs.existsSync(realRoot)) walk('')
    return found
  }

  function move(fromRel, toRel) {
    const from = abs(fromRel)
    const to = abs(toRel)
    if (fs.existsSync(to)) throw new DocsError(HIBA.mar_letezik, `Ezen az útvonalon már van doksi: ${toRel}`)
    if (!fs.existsSync(from)) throw new DocsError(HIBA.nincs_ilyen_doksi, `Nincs ilyen doksi: ${fromRel}`)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.renameSync(from, to)
  }

  function trash(relPath, id) {
    const trashRel = `.swarmdocs/trash/${id}/${path.basename(relPath)}`
    const to = abs(trashRel)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.renameSync(abs(relPath), to)
    return { trashRel }
  }
```

A `return` sort cseréld erre:

```js
  return { root: realRoot, abs, rel, ensureRoot, exists, readDoc, writeDoc, listDocs, move, trash }
```

- [ ] **Step 6: Futtasd — minden átmegy**

Run: `cd extensions/docs && npm test`
Expected: PASS — 14 teszt (3 errors + 11 vault).

- [ ] **Step 7: Commit**

Tárgysor: `Docs module: the disk layer, bounded to one root`. Törzs: miért két tartalmazás-ellenőrzés (lexikális vs. realpath, és mit fog meg mindegyik), és miért törzs a nem-parsoló fejléc (semmit nem dobunk el; a hibás fejlécű doksi kap egy újat fölé, ami látható és visszafordítható — egy némán eldobott első bekezdés nem lenne az). Trailerek a Global Constraints szerint.

---

### Task 3: `db.mjs` — a migrációk és az index

Négy tábla, mind `ext_docs_` előtaggal. **Egyik sem az igazság forrása**: a `docs`, az `fts` és a `links` a lemez állapotából újraépíthető; egyedül a `versions` történet, nem állapot.

**Files:**
- Create: `extensions/docs/src/db.mjs`
- Create: `extensions/docs/test/helpers.mjs`
- Create: `extensions/docs/test/db.test.mjs`

**Interfaces:**
- Consumes: semmit a modulon belülről (a `storage` handle kívülről jön).
- Produces:
  - `MIGRATIONS` — `ExtensionMigration[]`
  - `createRepo(storage)` → `repo`
  - `repo.upsertDoc(row)` → `void` — `row`: `{ id, path, title, owner, tags, created, updated, size, hash, version, body }`. A `body` csak az FTS-be megy, a `docs` táblába nem.
  - `repo.getById(id)` / `repo.getByPath(path)` → `row | undefined` (a `tags` már tömb)
  - `repo.listDocs({ folder, owner, tag, includeDeleted, limit })` → `row[]`
  - `repo.search(query, { folder, owner, limit })` → `{ id, path, title, reszlet }[]`
  - `repo.softDelete(id, at)` / `repo.restore(id)` / `repo.purge(id)` → `void`
  - `repo.addVersion(docId, { version, content, author, createdAt })` → `void`
  - `repo.listVersions(docId)` → `{ version, author, createdAt, meret }[]` (tartalom nélkül)
  - `repo.getVersion(docId, version)` → `{ content, author, createdAt } | undefined`
  - `repo.pruneVersions(docId, keep)` → `number` (hány sort dobott)
  - `repo.setLinks(fromId, links)` → `void` — `links`: `{ toId, toRaw }[]`
  - `repo.backlinks(toId)` → `{ fromId, path, title }[]`
  - `repo.unresolvedTo(rawTitle)` → `{ fromId }[]` — a doksi létrejöttekor feloldandó linkek
  - `repo.allPaths()` → `{ id, path, hash }[]` — az újraindexelés kiindulása

- [ ] **Step 1: Írd meg a teszt-segédet**

`extensions/docs/test/helpers.mjs` — vedd át szó szerint a `extensions/tts/test/helpers.mjs` fájlt, csak a doc-kommentben cseréld a `tts`-t `docs`-ra. Miért `node:sqlite` és nem `better-sqlite3`: a host handle natív modul, ami Node vagy Electron ABI-hoz fordult, és tesztből nem nyitható meg másodszor; a kettő ugyanazt az SQL-t beszéli. A `raw` azért kell, mert a migrációk a hoston sem az `exec`-en mennek át (az egyetlen utasítást futtat), hanem egy köteget elfogadó `db.exec()`-en.

```js
import { DatabaseSync } from 'node:sqlite'

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
```

- [ ] **Step 2: Írd meg a teszteket**

`extensions/docs/test/db.test.mjs`:

```js
import assert from 'node:assert/strict'
import test from 'node:test'

import { MIGRATIONS, createRepo } from '../src/db.mjs'
import { memStorage } from './helpers.mjs'

function fresh() {
  const s = memStorage()
  for (const m of MIGRATIONS) s.raw.exec(m.sql)
  return createRepo(s)
}

function doc(over = {}) {
  return {
    id: 'doc_1', path: 'agents/marketing/a.md', title: 'Ügyfélprofil', owner: 'agent:marketing',
    tags: ['ügyfél'], created: '2026-09-05T10:00:00.000Z', updated: '2026-09-05T10:00:00.000Z',
    size: 120, hash: 'h1', version: 1, body: 'Morvai kőműves jegyzet.', ...over,
  }
}

test('every migration table uses the ext_docs_ prefix', () => {
  for (const m of MIGRATIONS) {
    for (const t of m.sql.matchAll(/CREATE (?:VIRTUAL )?TABLE IF NOT EXISTS (\w+)/g)) {
      assert.match(t[1], /^ext_docs_/)
    }
  }
})

test('upsert then read back by id and by path, with tags as a list', () => {
  const r = fresh()
  r.upsertDoc(doc())
  assert.deepEqual(r.getById('doc_1').tags, ['ügyfél'])
  assert.equal(r.getByPath('agents/marketing/a.md').id, 'doc_1')
  assert.equal(r.getById('nincs'), undefined)
})

test('upsert on the same id replaces the row instead of adding one', () => {
  const r = fresh()
  r.upsertDoc(doc())
  r.upsertDoc(doc({ path: 'kozos/a.md', title: 'Új cím', version: 2 }))
  assert.equal(r.listDocs({}).length, 1)
  assert.equal(r.getById('doc_1').title, 'Új cím')
  assert.equal(r.getByPath('agents/marketing/a.md'), undefined)
})

test('search folds Hungarian diacritics both ways', () => {
  const r = fresh()
  r.upsertDoc(doc())
  for (const q of ['ügyfélprofil', 'ugyfelprofil', 'kőműves', 'komuves', 'MORVAI']) {
    assert.equal(r.search(q, {}).length, 1, `nem találta: ${q}`)
  }
  assert.equal(r.search('nincsilyen', {}).length, 0)
})

test('search returns a snippet and can be scoped to a folder', () => {
  const r = fresh()
  r.upsertDoc(doc())
  r.upsertDoc(doc({ id: 'doc_2', path: 'kozos/b.md', title: 'Másik', body: 'Morvai máshol.' }))
  assert.equal(r.search('morvai', {}).length, 2)
  const scoped = r.search('morvai', { folder: 'kozos' })
  assert.equal(scoped.length, 1)
  assert.equal(scoped[0].id, 'doc_2')
  assert.ok(scoped[0].reszlet.includes('Morvai'))
})

test('a soft-deleted doc leaves the listing and the search but keeps its row', () => {
  const r = fresh()
  r.upsertDoc(doc())
  r.softDelete('doc_1', '2026-09-05T12:00:00.000Z')
  assert.equal(r.listDocs({}).length, 0)
  assert.equal(r.search('morvai', {}).length, 0)
  assert.equal(r.listDocs({ includeDeleted: true }).length, 1)
  r.restore('doc_1')
  assert.equal(r.listDocs({}).length, 1)
  assert.equal(r.search('morvai', {}).length, 1)
  r.purge('doc_1')
  assert.equal(r.listDocs({ includeDeleted: true }).length, 0)
})

test('listDocs filters by folder, owner and tag', () => {
  const r = fresh()
  r.upsertDoc(doc())
  r.upsertDoc(doc({ id: 'doc_2', path: 'kozos/b.md', owner: 'user', tags: ['avian'] }))
  assert.equal(r.listDocs({ folder: 'agents/marketing' }).length, 1)
  assert.equal(r.listDocs({ owner: 'user' })[0].id, 'doc_2')
  assert.equal(r.listDocs({ tag: 'ügyfél' })[0].id, 'doc_1')
})

test('versions are listed newest first without content, and pruning keeps the newest', () => {
  const r = fresh()
  r.upsertDoc(doc())
  for (let v = 1; v <= 5; v += 1) {
    r.addVersion('doc_1', { version: v, content: `v${v}`, author: 'user', createdAt: `2026-09-0${v}T00:00:00.000Z` })
  }
  const list = r.listVersions('doc_1')
  assert.equal(list.length, 5)
  assert.equal(list[0].version, 5)
  assert.equal(list[0].content, undefined)
  assert.equal(r.getVersion('doc_1', 3).content, 'v3')

  assert.equal(r.pruneVersions('doc_1', 2), 3)
  assert.deepEqual(r.listVersions('doc_1').map((v) => v.version), [5, 4])
})

test('links resolve to backlinks, and an unresolved one waits by its raw text', () => {
  const r = fresh()
  r.upsertDoc(doc())
  r.upsertDoc(doc({ id: 'doc_2', path: 'kozos/b.md', title: 'Másik' }))
  r.setLinks('doc_2', [{ toId: 'doc_1', toRaw: 'Ügyfélprofil' }, { toId: null, toRaw: 'Nincs még' }])

  const back = r.backlinks('doc_1')
  assert.equal(back.length, 1)
  assert.equal(back[0].fromId, 'doc_2')
  assert.equal(back[0].title, 'Másik')

  assert.deepEqual(r.unresolvedTo('Nincs még').map((l) => l.fromId), ['doc_2'])
  assert.deepEqual(r.unresolvedTo('Ügyfélprofil'), [])
})

test('setLinks replaces the previous set for that document', () => {
  const r = fresh()
  r.upsertDoc(doc())
  r.upsertDoc(doc({ id: 'doc_2', path: 'kozos/b.md', title: 'Másik' }))
  r.setLinks('doc_2', [{ toId: 'doc_1', toRaw: 'Ügyfélprofil' }])
  r.setLinks('doc_2', [])
  assert.deepEqual(r.backlinks('doc_1'), [])
})

test('allPaths gives what a reindex needs', () => {
  const r = fresh()
  r.upsertDoc(doc())
  assert.deepEqual(r.allPaths(), [{ id: 'doc_1', path: 'agents/marketing/a.md', hash: 'h1' }])
})
```

- [ ] **Step 3: Futtasd — bukik**

Run: `cd extensions/docs && npm test`
Expected: FAIL — `Cannot find module '../src/db.mjs'`

- [ ] **Step 4: Írd meg a migrációt**

**A `tokenize='unicode61 remove_diacritics 2'` nem díszítés.** Az alapértelmezett `remove_diacritics 1` a magyar `ő` és `ű` kettős ékezetét nem hajtja össze, tehát a `komuves` nem találná meg a `kőműves`-t. A `2` igen — ez ellenőrzött, és a fenti teszt rögzíti.

Az `fts` önálló FTS5-tábla (nem `content=`-tel külső táblához kötött): a `docs` sorai és az FTS sorai külön írandók, cserébe nincs szinkron-trigger, amit karban kellene tartani.

```js
export const MIGRATIONS = Object.freeze([{
  version: 1,
  sql: `
CREATE TABLE IF NOT EXISTS ext_docs_docs (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  owner TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  created TEXT NOT NULL DEFAULT '',
  updated TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  hash TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ext_docs_docs_owner ON ext_docs_docs (owner);
CREATE INDEX IF NOT EXISTS ext_docs_docs_updated ON ext_docs_docs (updated);

CREATE VIRTUAL TABLE IF NOT EXISTS ext_docs_fts USING fts5(
  doc_id UNINDEXED, title, body,
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS ext_docs_versions (
  doc_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (doc_id, version)
);

CREATE TABLE IF NOT EXISTS ext_docs_links (
  from_id TEXT NOT NULL,
  to_id TEXT,
  to_raw TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ext_docs_links_to ON ext_docs_links (to_id);
CREATE INDEX IF NOT EXISTS ext_docs_links_raw ON ext_docs_links (to_raw);
`,
}])
```

- [ ] **Step 5: Írd meg a repository-t**

`createRepo(storage)` a fenti szignatúrák szerint. A megkötések, amiket be kell tartani:

- **`storage.exec` egyetlen utasítást futtat.** Minden többlépéses művelet (`upsertDoc` = `docs` upsert + `fts` törlés + `fts` beszúrás) `storage.transaction(() => { ... })`-be megy, több `exec` hívással.
- A `tags` a táblában JSON-szöveg, a repóból kifelé mindig tömb. A ki-be alakítás **csak itt** történik; följebb senki nem lát JSON-szöveget.
- Az FTS-ben nincs `deleted_at`, ezért a `softDelete` **kitörli az FTS-sort**, a `restore` visszateszi. Ehhez a `restore`-nak kell a body — a `docs` tábla nem tárolja, tehát a `restore` a hívótól kapja meg, vagy a `versions` legutolsó sorából veszi. **Döntés: a `restore(id)` a `versions` legfrissebb sorából veszi a tartalmat**, mert a kukába tett doksinál mindig van legalább egy verzió (a törlés maga ír egyet, lásd Task 8).
- A `search` `MATCH`-et használ; a felhasználói szöveget **nem** fűzöd össze az SQL-lel, paraméterként megy. Az FTS5 speciális karaktereit (`"`, `*`, `:`, `-`, `^`, `(`, `)`) idézőjelbe zárt kifejezéssé kell alakítani, különben egy `-` jelet tartalmazó keresés szintaxishibával száll el: `const term = '"' + query.replace(/"/g, '""') + '"'`.
- A `folder` szűrő `path LIKE folder || '/%'` alakú, hogy a `kozos` ne fogja meg a `kozosseg/`-et — a `/` a mintában kötelező.

- [ ] **Step 6: Futtasd — átmegy**

Run: `cd extensions/docs && npm test`
Expected: PASS — 25 teszt (3 errors + 11 vault + 11 db).

- [ ] **Step 7: Commit**

Tárgysor: `Docs module: four tables, none of them the truth`. Törzs: hogy a `docs`, az `fts` és a `links` a lemezről újraépíthető és csak a `versions` történet; és hogy a tokenizer `remove_diacritics 2`, mert az `1` a magyar ő/ű kettős ékezetét nem hajtja össze, tehát a `komuves` nem találná a `kőműves`-t.

---

### Task 4: `permissions.mjs` — ki írhat hova

Tiszta függvény, mellékhatás nélkül. Azért külön modul, mert ez az egyetlen hely, ahol a jogosultsági szabály le van írva, és így egyetlen táblázatos teszt fedi le.

**Files:**
- Create: `extensions/docs/src/permissions.mjs`
- Create: `extensions/docs/test/permissions.test.mjs`

**Interfaces:**
- Consumes: semmit.
- Produces:
  - `agentSlug(name, id)` → `string` — kisbetűs, ékezettelenített, `-`-kel elválasztott; ütközésre az `id` első hat karakterével toldva
  - `ownerOf(actor)` → `string` — `'user'`, `'agent:<slug>'` vagy `'ext:<név>'`
  - `homeFolderOf(actor)` → `string | null` — `agents/<slug>`, vagy `null` az operátornál
  - `canWrite(actor, relPath, { kozosMappaNev })` → `boolean`
  - `canRead(actor, relPath)` → `boolean`

Az `actor` alakja: `{ kind: 'user' }`, `{ kind: 'agent', slug }` vagy `{ kind: 'ext', name }`.

- [ ] **Step 1: Írd meg a táblázatos tesztet**

`extensions/docs/test/permissions.test.mjs`:

```js
import assert from 'node:assert/strict'
import test from 'node:test'

import { agentSlug, canRead, canWrite, homeFolderOf, ownerOf } from '../src/permissions.mjs'

const OPTS = { kozosMappaNev: 'kozos' }
const user = { kind: 'user' }
const marketing = { kind: 'agent', slug: 'marketing' }
const kutato = { kind: 'agent', slug: 'kutato' }
const videoExt = { kind: 'ext', name: 'video' }

test('agentSlug strips accents, lowercases and joins with dashes', () => {
  assert.equal(agentSlug('Marketing Ügynök', 'abc123def456'), 'marketing-ugynok')
  assert.equal(agentSlug('Kutató', 'abc123def456'), 'kutato')
  assert.equal(agentSlug('  Több   szóköz ', 'abc123def456'), 'tobb-szokoz')
  // Név nélkül vagy csupa írásjelnél az id az egyetlen, ami marad.
  assert.equal(agentSlug('', 'abc123def456'), 'abc123')
  assert.equal(agentSlug('!!!', 'abc123def456'), 'abc123')
})

test('ownerOf and homeFolderOf name the actor consistently', () => {
  assert.equal(ownerOf(user), 'user')
  assert.equal(ownerOf(marketing), 'agent:marketing')
  assert.equal(ownerOf(videoExt), 'ext:video')
  assert.equal(homeFolderOf(user), null)
  assert.equal(homeFolderOf(marketing), 'agents/marketing')
  assert.equal(homeFolderOf(videoExt), 'agents/video')
})

test('everyone can read everything', () => {
  for (const actor of [user, marketing, videoExt]) {
    for (const p of ['agents/marketing/a.md', 'kozos/b.md', '_sablonok/c.md', '.swarmdocs/trash/doc_1/d.md']) {
      assert.equal(canRead(actor, p), true, `${JSON.stringify(actor)} nem olvashatja: ${p}`)
    }
  }
})

test('the operator can write anywhere outside the internal folders', () => {
  assert.equal(canWrite(user, 'agents/marketing/a.md', OPTS), true)
  assert.equal(canWrite(user, 'kozos/b.md', OPTS), true)
  assert.equal(canWrite(user, '_sablonok/c.md', OPTS), true)
  assert.equal(canWrite(user, 'barmi/mashol.md', OPTS), true)
  // A kuka nem szerkeszthető, csak a kuka-műveleteken át.
  assert.equal(canWrite(user, '.swarmdocs/trash/doc_1/d.md', OPTS), false)
})

test('an agent writes its own folder and the shared one, nothing else', () => {
  assert.equal(canWrite(marketing, 'agents/marketing/a.md', OPTS), true)
  assert.equal(canWrite(marketing, 'agents/marketing/mely/mappa/a.md', OPTS), true)
  assert.equal(canWrite(marketing, 'kozos/b.md', OPTS), true)
  assert.equal(canWrite(marketing, 'kozos/mely/b.md', OPTS), true)

  assert.equal(canWrite(marketing, 'agents/kutato/a.md', OPTS), false)
  assert.equal(canWrite(kutato, 'agents/marketing/a.md', OPTS), false)
  assert.equal(canWrite(marketing, '_sablonok/c.md', OPTS), false)
  assert.equal(canWrite(marketing, '.swarmdocs/trash/doc_1/d.md', OPTS), false)
  assert.equal(canWrite(marketing, 'gyoker-szinten.md', OPTS), false)
})

test('a prefix that only looks like the home folder is refused', () => {
  // 'agents/marketing-2' nem a 'marketing' ügynök mappája.
  assert.equal(canWrite(marketing, 'agents/marketing-2/a.md', OPTS), false)
  assert.equal(canWrite(marketing, 'agents/marketingx/a.md', OPTS), false)
  // ugyanígy a közösnél
  assert.equal(canWrite(marketing, 'kozosseg/b.md', OPTS), false)
})

test('the shared folder name comes from settings, not from a constant', () => {
  const opts = { kozosMappaNev: 'shared' }
  assert.equal(canWrite(marketing, 'shared/b.md', opts), true)
  assert.equal(canWrite(marketing, 'kozos/b.md', opts), false)
})

test('an extension writes its own folder and the shared one', () => {
  assert.equal(canWrite(videoExt, 'agents/video/forgatokonyv.md', OPTS), true)
  assert.equal(canWrite(videoExt, 'kozos/b.md', OPTS), true)
  assert.equal(canWrite(videoExt, 'agents/marketing/a.md', OPTS), false)
})

test('the exact folder path itself is not a writable file path', () => {
  assert.equal(canWrite(marketing, 'agents/marketing', OPTS), false)
  assert.equal(canWrite(marketing, 'kozos', OPTS), false)
})
```

- [ ] **Step 2: Futtasd — bukik**

Run: `cd extensions/docs && npm test`
Expected: FAIL — `Cannot find module '../src/permissions.mjs'`

- [ ] **Step 3: Írd meg az implementációt**

Amire figyelni kell:

- **A prefix-egyezés mindig `/`-re végződő előtaggal megy.** `path.startsWith('agents/marketing')` igazat adna a `agents/marketing-2/a.md`-re is; a helyes vizsgálat `path.startsWith('agents/marketing/')`. A teszt ezt külön fedi, mert ez a klasszikus hiba ebben a fajta kódban.
- **Az ékezettelenítés `normalize('NFD')` + a kombináló jelek eldobása.** Így az `ő` → `o`, az `ű` → `u`, ahogy az FTS tokenizer is teszi.
- **A slug soha nem lehet üres.** Ha a névből nem marad semmi (üres név, csak írásjel), az `id` első hat karaktere a slug — enélkül az ügynök mappája `agents//` lenne.
- A `canWrite` **nem** ellenőrzi, hogy az útvonal a gyökéren belül van-e; azt a `vault.abs()` teszi. Ez a modul csak a szabályt mondja ki.
- A `.swarmdocs/` senkinek nem írható, az `_sablonok/` csak az operátornak.

- [ ] **Step 4: Futtasd — átmegy**

Run: `cd extensions/docs && npm test`
Expected: PASS — 34 teszt (3 + 11 + 11 + 9).

- [ ] **Step 5: Commit**

Tárgysor: `Docs module: one rule for who may write where`. Törzs: hogy azért külön modul, mert a szabály egy helyen legyen leírva és egy táblázatos teszt fedje; és hogy a mappa-előtag mindig `/`-re végződik, különben `agents/marketing-2` átcsúszna `agents/marketing` alá.

---

### Task 5: `links.mjs` — a `[[hivatkozások]]`

**Files:**
- Create: `extensions/docs/src/links.mjs`
- Create: `extensions/docs/test/links.test.mjs`

**Interfaces:**
- Consumes: `repo` (Task 3) a feloldáshoz és az átnevezéshez.
- Produces:
  - `extractLinks(body)` → `string[]` — a `[[...]]` nyers szövegei, sorrendben, ismétlés nélkül. **Kódblokkból és inline kódból nem szed ki semmit.**
  - `resolveLink(repo, raw)` → `id | null` — sorrend: pontos id, pontos cím, kis-nagybetűre érzéketlen cím
  - `linkRowsFor(repo, body)` → `{ toId, toRaw }[]` — a `repo.setLinks` bemenete
  - `renameLinksTo(repo, vault, { docId, oldTitle, newTitle, canWriteFn })` → `{ frissitett: string[], kihagyott: string[] }`

- [ ] **Step 1: Írd meg a teszteket**

`extensions/docs/test/links.test.mjs`:

```js
import assert from 'node:assert/strict'
import test from 'node:test'

import { MIGRATIONS, createRepo } from '../src/db.mjs'
import { extractLinks, linkRowsFor, resolveLink } from '../src/links.mjs'
import { memStorage } from './helpers.mjs'

function fresh() {
  const s = memStorage()
  for (const m of MIGRATIONS) s.raw.exec(m.sql)
  return createRepo(s)
}

function doc(over = {}) {
  return {
    id: 'doc_1', path: 'kozos/a.md', title: 'Ügyfélprofil', owner: 'user', tags: [],
    created: '', updated: '', size: 0, hash: '', version: 1, body: '', ...over,
  }
}

test('extractLinks takes each link once, in order', () => {
  assert.deepEqual(
    extractLinks('Lásd [[Egy]] és [[Kettő]], majd megint [[Egy]].'),
    ['Egy', 'Kettő'],
  )
})

test('extractLinks ignores code fences and inline code', () => {
  const body = [
    'Szöveg [[Valódi]].',
    '',
    '```js',
    'const x = "[[Nem link]]"',
    '```',
    '',
    'Inline `[[Szintén nem]]` után [[Másik valódi]].',
  ].join('\n')
  assert.deepEqual(extractLinks(body), ['Valódi', 'Másik valódi'])
})

test('extractLinks tolerates an unclosed bracket without hanging', () => {
  assert.deepEqual(extractLinks('Fél [[link és vége'), [])
  assert.deepEqual(extractLinks('[[]] üres'), [])
})

test('resolveLink prefers an id, then an exact title, then a case-insensitive one', () => {
  const r = fresh()
  r.upsertDoc(doc())
  r.upsertDoc(doc({ id: 'doc_2', path: 'kozos/b.md', title: 'Másik' }))

  assert.equal(resolveLink(r, 'doc_2'), 'doc_2')
  assert.equal(resolveLink(r, 'Ügyfélprofil'), 'doc_1')
  assert.equal(resolveLink(r, 'ÜGYFÉLPROFIL'), 'doc_1')
  assert.equal(resolveLink(r, 'Nincs ilyen'), null)
})

test('linkRowsFor keeps the raw text even when nothing resolves', () => {
  const r = fresh()
  r.upsertDoc(doc())
  assert.deepEqual(linkRowsFor(r, 'a [[Ügyfélprofil]] és [[Nincs még]]'), [
    { toId: 'doc_1', toRaw: 'Ügyfélprofil' },
    { toId: null, toRaw: 'Nincs még' },
  ])
})
```

- [ ] **Step 2: Futtasd — bukik**

Run: `cd extensions/docs && npm test`
Expected: FAIL — `Cannot find module '../src/links.mjs'`

- [ ] **Step 3: Írd meg a kinyerést**

**A kódblokk-kihagyás nem regexszel megy.** Előbb kimaszkolod a `` ``` ``-kerítéseket és az inline `` ` ``-részeket (a karaktereiket szóközre cserélve, hogy az indexek ne csússzanak el), és a maszkolt szövegen futtatod a `\[\[([^\]\n]+)\]\]` mintát. Így a kódban szereplő `[[...]]` nem lesz link, és a sorszámok is helyesek maradnak, ha később kellenek.

Az üres (`[[]]`) és a nem lezárt link nem link. A visszaadott lista sorrendtartó és ismétlésmentes (`Set`-tel szűrve, de tömbként visszaadva).

- [ ] **Step 4: Írd meg a feloldást és a linkfrissítést**

`resolveLink` három lépcsője a `repo.getById`, majd cím szerinti keresés. **Ehhez a repóban kell egy `repo.findByTitle(title, { caseInsensitive })`** — ha a Task 3-ban nem vetted fel, told be most, és a `db.test.mjs`-be egy sort hozzá.

`renameLinksTo` menete:
1. `repo.backlinks(docId)` — kik hivatkoznak rá.
2. Mindegyik hivatkozónál: ha `canWriteFn(hivatkozó útvonala)` hamis, a `kihagyott` listába kerül, és **nem** nyúlunk hozzá.
3. Egyébként beolvasod a törzsét, a **pontosan `oldTitle`-re** mutató `[[...]]`-eket átírod `newTitle`-re (az id-re hivatkozókat nem bántod), és rendes írásként visszaírod — vagyis a hívó ugyanazon az `index-writer`-en át indexeli újra, verziót kap.
4. Visszaadod, mi frissült és mi maradt ki. A hívó (a `doksi_mozgat` tool és a lap) a `kihagyott` listát megjeleníti.

- [ ] **Step 5: Futtasd — átmegy**

Run: `cd extensions/docs && npm test`
Expected: PASS — 39 teszt.

- [ ] **Step 6: Commit**

Tárgysor: `Docs module: links that a code fence cannot fake`. Törzs: hogy a kinyerés előbb maszkolja a kerítéseket és az inline kódot, mert egy `[[...]]` egy kódpéldában nem hivatkozás; és hogy az átnevezés kihagyja azt a hivatkozót, amibe a hívónak nincs joga írni, és ezt meg is nevezi ahelyett, hogy csendben átírná vagy csendben kihagyná.

---

### Task 6: `index-writer.mjs` — az egyetlen út az indexbe

**Ez a modul a B) szinkron-út lelke.** A lap, a toolok, a szerződés és a figyelő is ezt hívja; a két írási út csak abban különbözik, ki hívja, nem abban, mi történik.

**Files:**
- Create: `extensions/docs/src/index-writer.mjs`
- Create: `extensions/docs/test/index-writer.test.mjs`

**Interfaces:**
- Consumes: `vault` (Task 2), `repo` (Task 3), `linkRowsFor` (Task 5), `newDocId`, `hashOf` (Task 2).
- Produces:
  - `createIndexWriter({ vault, repo, now })` → `writer`
  - `writer.indexPath(rel)` → `{ id, valtozott: boolean, javitottFejlec: boolean }` — beolvas, fejlécet pótol ha kell, upsertel, linkeket ír
  - `writer.indexAll()` → `{ indexelt: number, eltavolitott: number }` — teljes újraindexelés; a lemezről eltűnt sorokat kiszedi
  - `writer.noteSelfWrite(rel, hash)` → `void`
  - `writer.isSelfWrite(rel, hash)` → `boolean`
  - `writer.forgetSelfWrites()` → `void` (teszthez)

A `now` beinjektálható óra (alapból `Date.now`), hogy a self-write lejárat tesztelhető legyen valódi várakozás nélkül.

- [ ] **Step 1: Írd meg a teszteket**

`extensions/docs/test/index-writer.test.mjs`:

```js
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { MIGRATIONS, createRepo } from '../src/db.mjs'
import { createIndexWriter } from '../src/index-writer.mjs'
import { createVault } from '../src/vault.mjs'
import { memStorage } from './helpers.mjs'

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-idx-'))
  const s = memStorage()
  for (const m of MIGRATIONS) s.raw.exec(m.sql)
  const vault = createVault({ root })
  vault.ensureRoot()
  const repo = createRepo(s)
  let clock = 1_000_000
  const writer = createIndexWriter({ vault, repo, now: () => clock })
  return { root, vault, repo, writer, tick: (ms) => { clock += ms }, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

test('indexing a file written by the module keeps its id and title', () => {
  const h = harness()
  try {
    h.vault.writeDoc('kozos/a.md', {
      meta: { id: 'doc_a', title: 'Ügyfélprofil', owner: 'user', tags: ['x'], created: 'c', updated: 'u' },
      body: 'Morvai jegyzet.\n',
    })
    const res = h.writer.indexPath('kozos/a.md')
    assert.equal(res.id, 'doc_a')
    assert.equal(res.javitottFejlec, false)
    assert.equal(h.repo.getById('doc_a').title, 'Ügyfélprofil')
    assert.equal(h.repo.search('morvai', {}).length, 1)
  } finally { h.cleanup() }
})

test('a file with no front matter gets one written back into it', () => {
  const h = harness()
  try {
    fs.mkdirSync(path.join(h.vault.root, 'kozos'), { recursive: true })
    fs.writeFileSync(path.join(h.vault.root, 'kozos/kivulrol.md'), '# Kívülről jött\n\nSzöveg.\n')

    const res = h.writer.indexPath('kozos/kivulrol.md')
    assert.equal(res.javitottFejlec, true)
    assert.match(res.id, /^doc_[0-9a-f]{8}$/)

    // A cím az első '#' sorból jön, és a fejléc tényleg a fájlban van.
    const read = h.vault.readDoc('kozos/kivulrol.md')
    assert.equal(read.meta.id, res.id)
    assert.equal(read.meta.title, 'Kívülről jött')
    assert.equal(read.body, '# Kívülről jött\n\nSzöveg.\n')
  } finally { h.cleanup() }
})

test('a file with no heading falls back to the file name for its title', () => {
  const h = harness()
  try {
    fs.mkdirSync(path.join(h.vault.root, 'kozos'), { recursive: true })
    fs.writeFileSync(path.join(h.vault.root, 'kozos/nincs-cim.md'), 'Csak szöveg.\n')
    const res = h.writer.indexPath('kozos/nincs-cim.md')
    assert.equal(h.repo.getById(res.id).title, 'nincs-cim')
  } finally { h.cleanup() }
})

test('indexing is idempotent: the second run reports no change', () => {
  const h = harness()
  try {
    h.vault.writeDoc('kozos/a.md', { meta: { id: 'doc_a', title: 'A', owner: 'user', tags: [] }, body: 'x\n' })
    assert.equal(h.writer.indexPath('kozos/a.md').valtozott, true)
    assert.equal(h.writer.indexPath('kozos/a.md').valtozott, false)
    assert.equal(h.repo.listDocs({}).length, 1)
  } finally { h.cleanup() }
})

test('two files carrying the same id: the second gets a fresh one', () => {
  const h = harness()
  try {
    h.vault.writeDoc('kozos/a.md', { meta: { id: 'doc_a', title: 'A', owner: 'user', tags: [] }, body: 'x\n' })
    h.vault.writeDoc('kozos/masolat.md', { meta: { id: 'doc_a', title: 'A másolata', owner: 'user', tags: [] }, body: 'x\n' })
    h.writer.indexPath('kozos/a.md')
    const res = h.writer.indexPath('kozos/masolat.md')

    assert.notEqual(res.id, 'doc_a')
    assert.equal(h.repo.getByPath('kozos/a.md').id, 'doc_a')
    assert.equal(h.vault.readDoc('kozos/masolat.md').meta.id, res.id)
  } finally { h.cleanup() }
})

test('links are recorded, and become backlinks once the target exists', () => {
  const h = harness()
  try {
    h.vault.writeDoc('kozos/a.md', { meta: { id: 'doc_a', title: 'A', owner: 'user', tags: [] }, body: 'Lásd [[Cél]].\n' })
    h.writer.indexPath('kozos/a.md')
    assert.deepEqual(h.repo.backlinks('doc_cel'), [])

    h.vault.writeDoc('kozos/cel.md', { meta: { id: 'doc_cel', title: 'Cél', owner: 'user', tags: [] }, body: 'y\n' })
    h.writer.indexPath('kozos/cel.md')
    h.writer.indexPath('kozos/a.md')

    assert.deepEqual(h.repo.backlinks('doc_cel').map((b) => b.fromId), ['doc_a'])
  } finally { h.cleanup() }
})

test('indexAll drops rows whose file is gone', () => {
  const h = harness()
  try {
    h.vault.writeDoc('kozos/a.md', { meta: { id: 'doc_a', title: 'A', owner: 'user', tags: [] }, body: 'x\n' })
    h.vault.writeDoc('kozos/b.md', { meta: { id: 'doc_b', title: 'B', owner: 'user', tags: [] }, body: 'x\n' })
    assert.deepEqual(h.writer.indexAll(), { indexelt: 2, eltavolitott: 0 })

    fs.rmSync(path.join(h.vault.root, 'kozos/b.md'))
    assert.deepEqual(h.writer.indexAll(), { indexelt: 1, eltavolitott: 1 })
    assert.equal(h.repo.getById('doc_b'), undefined)
  } finally { h.cleanup() }
})

test('a self-write is recognised by hash, and a real outside edit is not', () => {
  const h = harness()
  try {
    const w = h.vault.writeDoc('kozos/a.md', { meta: { id: 'doc_a', title: 'A', owner: 'user', tags: [] }, body: 'x\n' })
    h.writer.noteSelfWrite('kozos/a.md', w.hash)
    assert.equal(h.writer.isSelfWrite('kozos/a.md', w.hash), true)

    // Valaki tényleg átírja: a hash már más, tehát nem a mi írásunk.
    const w2 = h.vault.writeDoc('kozos/a.md', { meta: { id: 'doc_a', title: 'A', owner: 'user', tags: [] }, body: 'MÁS\n' })
    assert.equal(h.writer.isSelfWrite('kozos/a.md', w2.hash), false)
  } finally { h.cleanup() }
})

test('a self-write note expires after five seconds', () => {
  const h = harness()
  try {
    const w = h.vault.writeDoc('kozos/a.md', { meta: { id: 'doc_a', title: 'A', owner: 'user', tags: [] }, body: 'x\n' })
    h.writer.noteSelfWrite('kozos/a.md', w.hash)
    h.tick(4_999)
    assert.equal(h.writer.isSelfWrite('kozos/a.md', w.hash), true)
    h.tick(2)
    assert.equal(h.writer.isSelfWrite('kozos/a.md', w.hash), false)
  } finally { h.cleanup() }
})
```

- [ ] **Step 2: Futtasd — bukik**

Run: `cd extensions/docs && npm test`
Expected: FAIL — `Cannot find module '../src/index-writer.mjs'`

- [ ] **Step 3: Írd meg az implementációt**

Az `indexPath(rel)` menete:

1. `vault.readDoc(rel)`.
2. **Fejléc pótlása, ha kell.** Hiányzik az `id`, vagy a fejléc nem parsolt (`meta` üres, de a fájl nem üres), vagy az `id` már **más** útvonalon szerepel az indexben → új `id`, a cím az első `# ` sorból, ha nincs, a fájlnév kiterjesztés nélkül; `created`/`updated` a fájl `mtime`-jából; `owner` az útvonalból (`agents/<slug>/…` → `agent:<slug>`, egyébként `user`). Ezt **visszaírod** a fájlba (`vault.writeDoc`), és a visszakapott hasht használod tovább. `javitottFejlec: true`.
3. **`valtozott`**: az indexben lévő sor `hash`-e egyezik-e az újjal. Ha igen, semmit nem írunk, `valtozott: false` — így az `indexAll` és az idempotencia olcsó.
4. Ha változott: `version` = a meglévő sor verziója + 1, új doksinál 1. `repo.upsertDoc({...})` a törzzsel együtt (az FTS-be az megy).
5. `repo.setLinks(id, linkRowsFor(repo, body))`.
6. **Feloldatlan hivatkozások bekötése:** `repo.unresolvedTo(cím)` — aki eddig erre a *címre* várt, annak a sorát most feloldjuk. Enélkül a link csak akkor kötődne be, amikor a hivatkozó doksit legközelebb újraindexeljük.
7. Minden írás egy `repo` tranzakcióban.

**Amit az `indexPath` nem csinál:** nem ellenőriz jogosultságot (az a hívó dolga), és nem ír verziósort a `versions` táblába. A verzió a *szerkesztés* fogalma, nem az indexelésé — azt a tool- és rpc-réteg írja (Task 8, 12), különben a figyelő minden külső mentésre két sort termelne.

A self-write tábla egy `Map<rel, { hash, at }>`, 5000 ms lejárattal, `now()`-ból olvasva.

- [ ] **Step 4: Futtasd — átmegy**

Run: `cd extensions/docs && npm test`
Expected: PASS — 48 teszt.

- [ ] **Step 5: Commit**

Tárgysor: `Docs module: one function every write into the index goes through`. Törzs: hogy a lap, a toolok és a figyelő ugyanezt hívja, tehát a két írási út csak a hívóban különbözik; hogy a self-write szűrés hash-re néz és nem útvonalra, mert a mentésünk után érkező *valódi* külső átírást különben elnyelnénk; és hogy az indexelés nem ír verziósort, mert a verzió a szerkesztés fogalma és nem az indexelésé.

---

### Task 7: `index.mjs` — a modul betöltődik

Ezután a modul telepíthető és a futó appban látszik: beállításai vannak, a tábláit létrehozza, de még nincs tool és nincs lap.

**Files:**
- Create: `extensions/docs/index.mjs`
- Create: `extensions/docs/test/import-time.test.mjs`
- Create: `extensions/docs/test/index-decl.test.mjs`

**Interfaces:**
- Consumes: `MIGRATIONS` (Task 3), `createVault` (Task 2), `createRepo` (Task 3), `createIndexWriter` (Task 6).
- Produces: `export const state` (a megosztott állapot) és `export default docs` (a modul-deklaráció).

- [ ] **Step 1: Írd meg a betöltési-idő tesztet**

Ez a teszt a modul legfontosabb szerkezeti szabályát őrzi: **a `setup()` újrafut minden `data/extensions` alatti írásra**, tehát a modul-szintű kód nem nyithat handle-t és nem olvashat fájlt.

`extensions/docs/test/import-time.test.mjs`:

```js
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('importing the module opens no handle and reads no file', async () => {
  const readFile = fs.readFileSync
  const watch = fs.watch
  const reads = []
  let watches = 0
  fs.readFileSync = (...args) => { reads.push(String(args[0])); return readFile(...args) }
  fs.watch = (...args) => { watches += 1; return watch(...args) }
  const timers = []
  const setIntervalOrig = globalThis.setInterval
  globalThis.setInterval = (...args) => { timers.push('interval'); return setIntervalOrig(...args) }

  try {
    await import(`../index.mjs?t=${Date.now()}`)
    assert.deepEqual(reads.filter((p) => !p.includes('node_modules')), [])
    assert.equal(watches, 0)
    assert.deepEqual(timers, [])
  } finally {
    fs.readFileSync = readFile
    fs.watch = watch
    globalThis.setInterval = setIntervalOrig
  }
})
```

- [ ] **Step 2: Írd meg a deklaráció-tesztet**

`extensions/docs/test/index-decl.test.mjs`:

```js
import assert from 'node:assert/strict'
import test from 'node:test'

import docs from '../index.mjs'

test('the declaration names the module the way the host expects', () => {
  assert.equal(docs.name, 'Doksik')
  assert.equal(typeof docs.setup, 'function')
  assert.ok(Array.isArray(docs.migrations) && docs.migrations.length >= 1)
})

test('every migration table carries the ext_docs_ prefix, lower case', () => {
  for (const m of docs.migrations) {
    for (const t of m.sql.matchAll(/CREATE (?:VIRTUAL )?TABLE IF NOT EXISTS (\w+)/g)) {
      assert.ok(t[1].startsWith('ext_docs_'), `rossz előtag: ${t[1]}`)
      assert.equal(t[1], t[1].toLowerCase())
    }
  }
})

test('the page declaration satisfies the host validator rules', () => {
  const [page] = docs.ui.pages
  assert.equal(page.id, 'docs')
  assert.equal(page.label, 'Doksik')
  assert.match(page.path, /^\/x\/[a-z0-9][a-z0-9-]*$/)
  assert.match(page.entry, /^dist\/[A-Za-z0-9_./-]+\.js$/)
  assert.match(page.css, /^dist\/[A-Za-z0-9_./-]+\.css$/)
  assert.equal(page.icon, 'FileText')
  assert.equal(page.position, 'after:tasks')
})

test('every settings field has a key, a label and a type', () => {
  const keys = docs.ui.settingsFields.map((f) => f.key)
  assert.deepEqual(keys, ['gyoker', 'figyelesBe', 'verzioMegtartas', 'kozosMappaNev'])
  for (const f of docs.ui.settingsFields) {
    assert.ok(f.label, `nincs címke: ${f.key}`)
    assert.ok(['text', 'number', 'boolean', 'select', 'secret'].includes(f.type))
  }
})

test('the root folder is declared as a managed local folder', () => {
  const [folder] = docs.managedResources.localFolders
  assert.equal(folder.access, 'readWrite')
  assert.ok(folder.displayName)
})

test('setup() can be called twice without throwing', () => {
  const ctx = {
    extensionId: 'docs.mjs',
    tablePrefix: 'ext_docs_',
    storage: { exec() {}, all: () => [], get: () => undefined, transaction: (fn) => fn() },
    settings: () => ({ gyoker: '/tmp/docs-decl-test' }),
    log: { info() {}, warn() {}, error() {} },
  }
  docs.setup(ctx)
  docs.setup(ctx)
})
```

- [ ] **Step 3: Futtasd — bukik**

Run: `cd extensions/docs && npm test`
Expected: FAIL — `Cannot find module '../index.mjs'`

- [ ] **Step 4: Írd meg az `index.mjs`-t**

A `video/index.mjs` mintáját követi. A megosztott `state` **modul-szinten** él, mert a toolok és az rpc-kezelők deklarációkor jönnek létre, és nem zárhatnak körbe egy `ctx`-et, ami csak a `setup()` után létezik. Ezért a `state`-ben **semmi nem lehet időzítő, listener vagy fájlolvasás** — egy újratöltés mindegyikből szivárogtatna egyet. A sima értékadás idempotens, tehát a `setup()` újrafuttatása ingyenes.

```js
import { MIGRATIONS, createRepo } from './src/db.mjs'
import { createIndexWriter } from './src/index-writer.mjs'
import { createVault } from './src/vault.mjs'

export const state = {
  storage: null,
  settings: () => ({}),
  log: console,
  contracts: null,
  repo: null,
  /** Lazily built from the current settings, because the root can change. */
  _vault: null,
  _vaultRoot: null,
  _writer: null,
}

/** The vault and the writer for the root the settings name right now. */
export function vaultOf() { /* … */ }
export function writerOf() { /* … */ }

const docs = {
  name: 'Doksik',
  version: '0.1.0',
  description: 'Markdown-doksik egy mappában: grafikus szerkesztő az operátornak, hat tool az ügynököknek, ügynökönként saját mappa.',
  migrations: MIGRATIONS,
  setup(ctx) {
    state.storage = ctx.storage
    state.settings = ctx.settings
    state.log = ctx.log
    state.contracts = ctx.contracts ?? null
    state.repo = createRepo(ctx.storage)
    state._vault = null
    state._vaultRoot = null
    state._writer = null
  },
  ui: {
    pages: [{
      id: 'docs',
      label: 'Doksik',
      icon: 'FileText',
      path: '/x/docs',
      entry: 'dist/index.js',
      css: 'dist/style.css',
      position: 'after:tasks',
    }],
    settingsFields: [
      { key: 'gyoker', label: 'Doksik gyökérmappája', type: 'text', required: true, placeholder: '~/SwarmClaw/docs', help: 'Ide kerül minden .md fájl. Finderben és Obsidianban is megnyitható.' },
      { key: 'figyelesBe', label: 'Külső szerkesztés figyelése', type: 'boolean', defaultValue: true, help: 'Ha kívülről (Obsidian, Finder) módosul egy doksi, a kereső is frissül.' },
      { key: 'verzioMegtartas', label: 'Megtartott verziók / doksi', type: 'number', defaultValue: 50 },
      { key: 'kozosMappaNev', label: 'Közös mappa neve', type: 'text', defaultValue: 'kozos', help: 'Ebbe minden ügynök írhat.' },
    ],
  },
  managedResources: {
    localFolders: [{
      folderKey: 'docs-root',
      displayName: 'Doksik gyökérmappája',
      description: 'A markdown-doksik mappafája.',
      access: 'readWrite',
    }],
    setupChecks: [{
      checkKey: 'docs_root_writable',
      displayName: 'A doksi-gyökér létezik és írható',
      kind: 'manual',
      required: true,
    }],
  },
}

export default docs
```

A `vaultOf()` a `state.settings().gyoker`-t olvassa; ha az más, mint a `state._vaultRoot`, új vaultot és új writert épít, és eltárolja. Így a beállítás megváltoztatása nem igényel újraindítást, és a gyakori hívás sem épít újra semmit.

**A `pages` most olyan `dist/`-re mutat, ami még nem létezik.** Ez rendben van, és ugyanez volt a helyzet a videó modulnál is a lap elkészülte előtt: a host a lap betöltésekor 404-et ad, a modul többi része működik. A 13. feladat hozza meg a bundle-t.

- [ ] **Step 5: Futtasd — átmegy**

Run: `cd extensions/docs && npm test`
Expected: PASS — 55 teszt.

- [ ] **Step 6: Commit**

Tárgysor: `Docs module: the declaration the host loads`. Törzs: hogy a megosztott állapot modul-szinten él, mert a toolok deklarációkor jönnek létre és nem zárhatnak körbe egy még nem létező ctx-et; és hogy ezért semmi időzítő, listener vagy fájlolvasás nem lehet benne, mert a setup() minden extension-írásra újrafut és mindegyikből szivárogtatna egyet. Az import-time teszt ezt őrzi.

---

### Task 8: `tools.mjs` — a hat ügynök-tool

**Files:**
- Create: `extensions/docs/src/tools.mjs`
- Create: `extensions/docs/test/tools.test.mjs`
- Modify: `extensions/docs/index.mjs` (a `tools` mező)

**Interfaces:**
- Consumes: minden eddigi modul.
- Produces: `createTools(state)` → `ExtensionToolDef[]` — hat elem, a `name` mezőik: `doksi_lista`, `doksi_olvas`, `doksi_keres`, `doksi_ir`, `doksi_mozgat`, `doksi_torol`.
- A szereplő meghatározása: `actorOf(ctx)` → a `ctx.session`-ből, **soha nem a tool paramétereiből**. Ha az LLM mondhatná meg, ki ő, hazudhatna róla.

- [ ] **Step 1: Írd meg a teszteket**

A lényegi esetek, amiket fedni kell (a teszt szerkezete a `harness()`-t a Task 6-ból veszi át, kiegészítve a `createTools(state)` hívással és egy hamis `ctx`-szel):

```js
test('doksi_ir without a folder puts the doc in the calling agent home', async () => { /* … */ })
test('doksi_ir refuses another agent folder by name', async () => { /* … */ })
test('doksi_ir on an existing doc without baseVersion is refused', async () => { /* … */ })
test('doksi_ir with a stale baseVersion returns utkozes and does not write', async () => { /* … */ })
test('doksi_ir with the right baseVersion writes and bumps the version', async () => { /* … */ })
test('doksi_ir writes a version row with the previous content', async () => { /* … */ })
test('doksi_ir prunes versions past the configured limit', async () => { /* … */ })
test('doksi_ir from a template starts from the template body', async () => { /* … */ })
test('doksi_olvas returns the version the agent must send back', async () => { /* … */ })
test('doksi_keres scopes to a folder and folds diacritics', async () => { /* … */ })
test('doksi_lista defaults to own folder plus the shared one', async () => { /* … */ })
test('doksi_mozgat rewrites links and names the ones it could not touch', async () => { /* … */ })
test('doksi_torol moves the file to the trash and leaves the row', async () => { /* … */ })
test('every tool answers a missing root with gyoker_nem_irhato instead of throwing', async () => { /* … */ })
```

Mindegyik teszt teljes törzsét írd meg a fenti nevekkel; a hármas minta végig ugyanaz: felépíted a harness-t, meghívod a toolt egy `{ session: { agentId, agentName } }` alakú ctx-szel, és a visszatérési objektumot állítod. **Az utolsó teszt külön fontos:** egy nem létező vagy nem írható gyökérnél a toolnak `{ hiba: 'gyoker_nem_irhato', uzenet }`-et kell adnia, nem dobnia — az ügynök a szövegből tud cselekedni, egy kivételből nem.

- [ ] **Step 2: Futtasd — bukik**

Run: `cd extensions/docs && npm test`
Expected: FAIL — `Cannot find module '../src/tools.mjs'`

- [ ] **Step 3: Írd meg a toolokat**

Közös burkoló minden toolhoz: `try`/`catch`, ami a `DocsError`-t `hiba(err.code, err.message)`-re fordítja, minden mást pedig egy `rossz_parameter` vagy naplózott belső hibára. **Egyetlen tool sem dobhat.**

A `doksi_ir` menete (ez a legfontosabb):

1. `actor = actorOf(ctx)`; `opts = { kozosMappaNev: settings().kozosMappaNev || 'kozos' }`.
2. **Létrehozás** (nincs `id`): a mappa a megadott `mappa`, vagy `homeFolderOf(actor)`. `canWrite` ellenőrzés → `nincs_jog`. Fájlnév a címből sluggolva, ütközésnél `-2`, `-3` utótag. `sablon` esetén a `_sablonok/<sablon>.md` törzsével indul. Írás, `noteSelfWrite`, `indexPath`, verziósor `version: 1` tartalommal.
3. **Módosítás** (van `id`): `repo.getById` → `nincs_ilyen_doksi`. `canWrite` a doksi jelenlegi útvonalára → `nincs_jog`. **`baseVersion` hiánya `rossz_parameter`**, nem csendes felülírás. Ha `baseVersion !== sor.version` → `hiba('utkozes', …)` a `jelenlegiVerzio` és a `modositotta` mezőkkel, és **semmit nem ír**.
4. Egyezés esetén: `repo.addVersion(id, { version: régi, content: régi törzs, author: ownerOf(actor) })`, majd írás, `noteSelfWrite`, `indexPath`, `repo.pruneVersions(id, verzioMegtartas)`.

Az ütközés `uzenet`-e szó szerint mondja meg a következő lépést: *„A doksit közben módosította <ki>. Olvasd újra a doksi_olvas hívással, fésüld össze a változtatásodat, és írd újra az új verziószámmal."*

A `doksi_torol` a törlés **előtt** ír egy verziósort az aktuális tartalommal — ezért tud a `repo.restore` a legfrissebb verzióból dolgozni (Task 3, Step 5).

- [ ] **Step 4: Kösd be a toolokat**

Az `index.mjs`-ben:

```js
import { createTools } from './src/tools.mjs'
// …
  tools: createTools(state),
```

- [ ] **Step 5: Futtasd — átmegy**

Run: `cd extensions/docs && npm test`
Expected: PASS — 69 teszt.

- [ ] **Step 6: Commit**

Tárgysor: `Docs module: six tools, and a write that has to say what it built on`. Törzs: hogy a baseVersion kötelező módosításnál, mert opcionálisan az ügynök alapból felülírna és az ütközés-figyelés csak akkor működne, ha magától eszébe jut; hogy a hívó kilétét a session adja és nem a tool paramétere; és hogy egyetlen tool sem dob, mert az ügynök a szövegből tud cselekedni, kivételből nem.

---

### Task 9: `agent-context.mjs` — az ügynök tudja, mi létezik

A modul legnagyobb hozadékú része. Egy ügynök, aki nem tudja, hogy van mit olvasnia, soha nem hívja meg a keresőt.

**Files:**
- Create: `extensions/docs/src/agent-context.mjs`
- Create: `extensions/docs/test/agent-context.test.mjs`
- Modify: `extensions/docs/index.mjs` (a `hooks` mező)

**Interfaces:**
- Consumes: `state`, `repo`, `permissions`.
- Produces: `createAgentContext(state)` → `{ getAgentContext, getCapabilityDescription, getOperatingGuidance }`.

- [ ] **Step 1: Írd meg a teszteket**

```js
test('with no docs at all the hook adds nothing', async () => { /* null vagy undefined, nem üres fejléc */ })
test('the calling agent sees its own docs first, then the shared ones', async () => { /* … */ })
test('the listing is capped and the newest survive the cap', async () => { /* 60 doksi, max 30 sor a sajátból */ })
test('the whole block stays under the token budget', async () => { /* hossz-ellenőrzés karakterben */ })
test('a deleted doc does not appear', async () => { /* … */ })
test('an unreadable root does not throw out of the hook', async () => { /* null, és egy warn a logban */ })
```

- [ ] **Step 2: Futtasd — bukik**

Run: `cd extensions/docs && npm test`
Expected: FAIL — `Cannot find module '../src/agent-context.mjs'`

- [ ] **Step 3: Írd meg az implementációt**

- A saját mappa max **30** doksija, `updated` szerint csökkenően, `- <cím> — <útvonal>` sorokként.
- A közös mappa max **10** legutóbb módosítottja, külön alcím alatt.
- **Kemény plafon 1500 token**, amit 4 karakter/token becsléssel 6000 karakterben mérünk. Túllépéskor a lista *rövidül* (sorokat dobunk a végéről), nem csonkul félbe egy soron.
- Ha egyik lista sem ad sort: `return null`. **Üres fejlécet nem szúrunk be** — egy „Doksik:" felirat semmi alatt csak zajt tesz a promptba.
- A hook **soha nem dob**: a beolvasás `try`/`catch`-ben, hibánál `state.log.warn` és `null`. Egy elromlott doksi-gyökér nem akadályozhatja meg az ügynököt abban, hogy beszéljen.

`getCapabilityDescription`: egy sor, hogy ez az ügynök tartós dokumentumokat tud olvasni és írni, és van saját mappája.

`getOperatingGuidance`: mikor írjon doksit (ha az eredmény a fordulat után is értékes), mikor ne (átmeneti gondolatmenet), és hogy módosítás előtt mindig olvasson, mert a `doksi_ir` kéri a `baseVersion`-t.

- [ ] **Step 4: Kösd be**

Az `index.mjs`-ben a `hooks` mezőbe a három függvény.

- [ ] **Step 5: Futtasd — átmegy**

Run: `cd extensions/docs && npm test`
Expected: PASS — 75 teszt.

- [ ] **Step 6: Commit**

Tárgysor: `Docs module: the agent is told what it already has`. Törzs: hogy enélkül az ügynök nem hívja a keresőt, mert nem tudja, hogy van mit keresni; hogy üres tár mellett semmit nem szúrunk be; és hogy a hook nem dobhat, mert egy elromlott gyökér nem akadályozhatja meg az ügynököt a beszédben.

---

### Task 10: `watcher.mjs` — a külső szerkesztés

**Ez a modul egyetlen listenere, és a legkockázatosabb része.** A `setup()` minden `data/extensions` alatti írásra újrafut; egy naivan onnan indított figyelő minden újratöltésnél szivárogtat egy `fs.watch` handle-t.

**Files:**
- Create: `extensions/docs/src/watcher.mjs`
- Create: `extensions/docs/test/watcher.test.mjs`
- Modify: `extensions/docs/index.mjs`

**Interfaces:**
- Consumes: `writer` (Task 6).
- Produces: `createWatcherControl({ watchImpl, now })` → `{ ensureWatcher({ root, enabled, writer, log }), status(), stop() }`.
  - `watchImpl` a beinjektálható `fs.watch` (alapból az igazi) — **a teszt ezen keresztül szimulál eseményt, valódi fájlrendszer-figyelés nélkül.**
  - `status()` → `{ fut: boolean, root: string | null, indultAt: number | null, hiba: string | null }`

- [ ] **Step 1: Írd meg a teszteket**

```js
test('ensureWatcher twice on the same root opens one handle', () => { /* watchImpl hívásszám === 1 */ })
test('ensureWatcher on a new root closes the old handle and opens one', () => { /* close hívva, hívásszám === 2 */ })
test('ensureWatcher with enabled false closes what runs and opens nothing', () => { /* … */ })
test('a change event on a .md file reaches indexPath', () => { /* … */ })
test('a change event on a non-.md file is ignored', () => { /* … */ })
test('an event inside .swarmdocs is ignored', () => { /* … */ })
test('two events on one path within the debounce window index once', () => { /* … */ })
test('an event whose content hash matches a self-write is dropped', () => { /* … */ })
test('an event whose content changed after a self-write is processed', () => { /* … */ })
test('an indexPath that throws is logged and does not kill the watcher', () => { /* status().fut marad true */ })
test('a watch that fails to start is reported in status, not thrown', () => { /* status().hiba megnevezi */ })
```

Írd meg mindegyik teljes törzsét. A `watchImpl` egy kézzel írt duplum, ami eltárolja a callbacket és visszaad egy `{ close }`-t, amin számolod a hívásokat; az eseményt a teszt maga hívja meg. Így a suite nem függ a fájlrendszer időzítésétől, és macOS-en/Linuxon egyformán fut.

- [ ] **Step 2: Futtasd — bukik**

Run: `cd extensions/docs && npm test`
Expected: FAIL — `Cannot find module '../src/watcher.mjs'`

- [ ] **Step 3: Írd meg az implementációt**

- A modul-szintű állapot **egyetlen objektum**: `{ handle, root, indultAt, hiba, debounce: Map }`.
- `ensureWatcher` **mindkét irányban idempotens**: ha már fut ugyanarra a gyökérre és `enabled`, nem csinál semmit; ha más gyökérre, lezárja a régit és újat nyit; ha `enabled` hamis, lezár és nem nyit.
- A `fs.watch` `{ recursive: true }`-val megy. macOS-en és Windowson ez natívan támogatott; Linuxon a Node 20+ emulálja. Ha a `watch` dob, a hiba a `status().hiba`-ba kerül, **nem dobjuk tovább** — a lap ebből rajzolja a „figyelés leállt" sávot.
- Debounce **200 ms útvonalanként**: a szerkesztők több eseményt adnak egy mentésre.
- A feldolgozás: kihagyjuk, ami nem `.md`, ami `.swarmdocs/` alatt van, és amire `writer.isSelfWrite(rel, aktuális hash)` igaz. A többire `writer.indexPath(rel)`, `try`/`catch`-ben — **egy elromlott doksi nem állíthatja meg a figyelőt.**
- A figyelt gyökér más mappa, mint a `data/extensions`, tehát a modul saját írásai nem indítanak host-újratöltést: nincs hurok.

- [ ] **Step 4: Kösd be**

Az `index.mjs` `setup()`-jának **végén** hívd az `ensureWatcher`-t a jelenlegi beállításokkal. Ez azért biztonságos, mert idempotens — pontosan ezért lett az.

- [ ] **Step 5: Futtasd — átmegy**

Run: `cd extensions/docs && npm test`
Expected: PASS — 86 teszt.

- [ ] **Step 6: Commit**

Tárgysor: `Docs module: one watcher, however many times setup runs`. Törzs: hogy a setup() minden extension-írásra újrafut, tehát az indítás idempotens kell legyen, különben minden újratöltés szivárogtat egy handle-t; hogy a self-write szűrés tartalom-hashre néz; és hogy a nem induló figyelő állapotba kerül és nem kivételbe, mert a lap ebből rajzol.

---

### Task 11: `contract.mjs` — amit más extensionök írhatnak

**Files:**
- Create: `extensions/docs/src/contract.mjs`
- Create: `extensions/docs/test/contract.test.mjs`
- Modify: `extensions/docs/index.mjs` (a `provides` mező)

**Interfaces:**
- Produces: `DOCS_CONTRACT = 'docs'` és `createDocsContract(state)` → `{ version: 1, methods: { letesz, olvas } }`.
  - `letesz({ mappa, cim, tartalom, tulajdonos })` → `{ id, utvonal }`
  - `olvas({ id })` → `{ id, cim, utvonal, tartalom, verzio }`

- [ ] **Step 1: Írd meg a teszteket**

```js
test('letesz writes into the calling extension folder by default', () => { /* … */ })
test('letesz refuses another agent folder', () => { /* … */ })
test('olvas gives back what letesz wrote', () => { /* … */ })
test('olvas names a missing id instead of returning undefined', () => { /* … */ })
test('the contract exposes exactly two methods', () => { /* Object.keys(...methods) === ['letesz','olvas'] */ })
```

Az utolsó teszt szándékos: a felület **szűk**, és a host `consumes`-modelljében **a deklaráció maga a hozzáférés** — nincs jóváhagyás, nincs visszavonás, és egy fogyasztót külön letiltani nem lehet. Ezért egy metódus hozzáadása valódi döntés, amit a teszt bukása kényszerít ki.

- [ ] **Step 2–4: Bukó teszt → implementáció → zöld**

A `letesz` a `doksi_ir` létrehozási ágát hívja `{ kind: 'ext', name }` szereplővel. A hívó extension nevét a host adja; ha nem elérhető, `'ext'` a tartalék, és a mappa `agents/ext/`.

Az `index.mjs`-ben:

```js
provides: { [DOCS_CONTRACT]: createDocsContract(state) },
```

`consumes` **nincs** — ez a modul nem olvas más extensiontől semmit.

- [ ] **Step 5: Commit**

Tárgysor: `Docs module: two methods another extension may call`. Törzs: hogy a felület azért ennyire szűk, mert a host modelljében a deklaráció maga a hozzáférés, tehát bővíteni nehezebb visszavonni, mint hozzáadni; és hogy egy teszt rögzíti a metódusok pontos halmazát, hogy a bővítés döntés legyen és ne elsodródás.

---

### Task 12: `rpc.mjs` — amit a lap hív

**Files:**
- Create: `extensions/docs/src/rpc.mjs`
- Create: `extensions/docs/test/rpc.test.mjs`
- Modify: `extensions/docs/index.mjs` (az `rpc` mező)

**Interfaces:**
- Produces: `createRpc(state)` → `Record<string, ExtensionRpcHandler>` a következő metódusokkal:
  - `fa()` → `{ mappak, doksik, gyoker, kozosMappaNev }` — a bal hasáb egész tartalma egy hívásban
  - `olvas({ id })` → `{ meta, tartalom, verzio, utvonal }`
  - `ment({ id, tartalom, cim, tagek, baseVersion })` → `{ verzio }` vagy `{ hiba: 'utkozes', jelenlegiVerzio, modositotta, ovek }`
  - `letrehoz({ mappa, cim, sablon })` → `{ id, utvonal }`
  - `keres({ q, mappa })` → `{ talalatok }`
  - `mozgat({ id, ujUtvonal })` → `{ utvonal, kihagyott }`
  - `atnevez({ id, ujCim })` → `{ cim, frissitett, kihagyott }`
  - `torol({ id })` / `visszaallit({ id })` / `veglegesTorol({ id })`
  - `kuka()` → `{ elemek }`
  - `verziok({ id })` → `{ verziok }` · `verzio({ id, verzio })` → `{ tartalom }` · `visszaallitVerzio({ id, verzio, baseVersion })`
  - `hivatkozok({ id })` → `{ backlinkek }`
  - `sablonok()` → `{ sablonok }`
  - `ugynokok()` → `{ ugynokok }` — a lemezen lévő `agents/<slug>` mappák, hogy a fa nevet és ikont tudjon rajzolni
  - `allapot()` → `{ gyoker, gyokerRendben, figyeloFut, figyeloHiba, doksiSzam }` — ebből rajzol a lap a hibasávokat
  - `ujraindex()` → `{ indexelt, eltavolitott }` · `figyeloUjraindit()` → `status()`

**Az rpc szereplője mindig az operátor** (`{ kind: 'user' }`): a lapot csak ő éri el, a host hitelesítése mögött.

- [ ] **Step 1: Írd meg a teszteket**

```js
test('fa returns folders and docs for an empty root without throwing', async () => { /* … */ })
test('allapot names an unwritable root instead of throwing', async () => { /* gyokerRendben === false */ })
test('ment with a stale baseVersion returns utkozes with the other side content', async () => { /* ovek mező */ })
test('ment with the right baseVersion bumps the version and writes a version row', async () => { /* … */ })
test('atnevez rewrites the links that point at the old title', async () => { /* … */ })
test('torol then kuka then visszaallit round-trips a document', async () => { /* … */ })
test('visszaallitVerzio writes the old content as a new version', async () => { /* nem törli a történetet */ })
test('every handler answers a broken root with a named error, none of them throws', async () => { /* mind a 19 metódus */ })
```

Az utolsó teszt végigmegy **minden** rpc-metóduson egy elromlott gyökérrel, és azt állítja, hogy egyik sem dob. Ez azért kell, mert egy dobó rpc-kezelő a lapon néma 500-as hibaként jelenik meg, ami nem mond semmit az operátornak.

- [ ] **Step 2–4: Bukó teszt → implementáció → zöld**

A `ment` ütközés-ága a `ovek` mezőben visszaadja a másik oldal jelenlegi tartalmát is, hogy a lap a különbséget megjeleníthesse egy második kérés nélkül.

A `visszaallitVerzio` **nem törli** a köztes verziókat: a régi tartalmat új verzióként írja vissza. Így a visszaállítás maga is visszavonható.

Az `index.mjs`-ben: `rpc: createRpc(state),`.

- [ ] **Step 5: Commit**

Tárgysor: `Docs module: what the page may ask, and none of it throws`. Törzs: hogy egy dobó rpc-kezelő a lapon néma 500 lesz, ami az operátornak semmit nem mond, ezért mind a tizenkilenc megnevezett hibát ad; és hogy a mentés ütközésnél a másik oldal tartalmát is visszaadja, hogy a különbség egy kérésből kirajzolható legyen.

---

### Task 13: A lap bundle-je felépül

**Files:**
- Create: `extensions/docs/scripts/build.mjs`
- Create: `extensions/docs/ui/host.ts`
- Create: `extensions/docs/ui/main.tsx`
- Create: `extensions/docs/ui/style.css`
- Create: `extensions/docs/test/ui.test.mjs`
- Modify: `extensions/docs/package.json` (TipTap függőségek)

- [ ] **Step 1: Vedd át a build-szkriptet**

`extensions/tts/scripts/build.mjs` szó szerint, egyetlen cserével: a hibaüzenet előtagja `tts:` helyett `docs:`, és az entry `ui/main.tsx`.

**A `react`, `react-dom` és `react/jsx-runtime` nem kerülhet a bundle-be.** A host a saját React-fájában rendereli a lapot, és egy második React-példány minden hookot eldob. A `hostModules` esbuild-plugin mindhármat `window.swarmclaw.modules` olvasásra oldja fel.

- [ ] **Step 2: Írd meg a bundle-tesztet**

```js
test('the built bundle carries no React source', async () => {
  const out = await bundle({ write: false })
  const code = out.outputFiles[0].text
  assert.ok(!code.includes('react.production'), 'React bekerült a bundle-be')
  assert.ok(code.includes('window.swarmclaw'), 'nem a host tábláját olvassa')
})
test('the bundle registers the page under the id the host injected', async () => { /* … */ })
```

- [ ] **Step 3: Add hozzá a TipTap függőségeket**

`extensions/docs/package.json` → `devDependencies`: `@tiptap/core`, `@tiptap/starter-kit`, `@tiptap/react`, valamint a markdown oda-vissza alakításhoz `marked` (md → HTML) és `turndown` (HTML → md). Rögzített verziókkal.

Run: `cd extensions/docs && npm install && npm run build`
Expected: `dist/index.js` és `dist/style.css` létrejön.

**Nézd meg a bundle méretét:** `ls -lh dist/index.js`. A TipTap+ProseMirror nagyságrendileg 300 kB minifikálatlanul is jóval több; ha 1 MB fölé megy, kapcsold be a `minify: true`-t a build-szkriptben.

- [ ] **Step 4: Commit** — `Docs module: the page bundle, with the host's React and not its own`

---

### Task 14–16: A lap három hasábja

Mindegyik feladat ugyanazzal a ciklussal megy: komponens-teszt (a `ui.test.mjs`-ben, a `video` modul mintája szerint) → implementáció → build → commit.

**Task 14 — `ui/fa.tsx`, bal hasáb.** Nyitható-csukható mappafa a `fa()` rpc-ből; húzd-és-ejtsd mozgatás (`mozgat`); jobbklikk-menü: új doksi, új doksi sablonból (`sablonok()` + `letrehoz`), új mappa, átnevez, töröl. Fent kereső: gépelésre a fa helyére a `keres()` találati listája kerül. Az `agents/` alatti mappák az `ugynokok()` nevét mutatják, nem a slugot. A fa alján **Kuka** (`kuka()`), visszaállítással és — itt és csak itt — végleges törléssel. Az `_sablonok/` és a `.swarmdocs/` nem jelenik meg a fában. Felül a hibasávok az `allapot()`-ból: nem írható gyökér (link a beállításokhoz), leállt figyelő (újraindító gombbal).

**Task 15 — `ui/szerkeszto.tsx`, közép.** TipTap WYSIWYG, `/` paranccsal blokk-beszúró menü (címsor, lista, idézet, kódblokk, táblázat, elválasztó). Betöltés `olvas()`-ból (md → HTML `marked`-del), mentés `ment()`-tel (HTML → md `turndown`-nal) 800 ms tétlenség után és `Cmd+S`-re. **Az ütközéssáv:** ha a `ment()` `utkozes`-t ad, sáv jelenik meg a szerkesztő fölött — „Ezt a doksit közben módosította <ki>" — három gombbal: különbség megnézése (a válasz `ovek` mezőjéből, második kérés nélkül), az enyém maradjon (újraírás a friss verziószámmal), az övék maradjon (helyi szerkesztés eldobása és újratöltés). **Gépi összefésülés nincs** — az operátor dönt.

**Task 16 — `ui/panel.tsx`, jobb hasáb.** Behúzható. Cím, tagek, tulajdonos, útvonal; a `verziok()` listája időbélyeggel és szerzővel, egyenkénti előnézettel (`verzio()`) és visszaállítással (`visszaallitVerzio()`); a `hivatkozok()` visszahivatkozás-listája szövegkörnyezettel. Egy feloldatlan `[[link]]` a szerkesztőben más színt kap, mint egy feloldott — ez a `fa()` válaszában érkező cím-halmazból dől el, külön kérés nélkül.

Mindhárom feladat végén: `npm run build`, majd commit.

---

### Task 17: Telepítés és élő ügynök-teszt

**Files:**
- Create: `extensions/docs/scripts/install.mjs`
- Modify: `doc/specs/2026-09-05-doksik-extension-design.md` (ha bármi eltért a tervtől)

- [ ] **Step 1: Írd meg a telepítő szkriptet**

`extensions/video/scripts/install.mjs` mintájára: megkeresi a desktop app adatkönyvtárát (`~/Library/Application Support/@swarmclawai/swarmclaw/home/data/extensions/`), a workspace-t `.workspaces/docs_mjs/`-be másolja (a `node_modules` és a `test` nélkül, a `dist`-tel együtt), és kiír egy `docs.mjs` shimet:

```js
export { default } from './.workspaces/docs_mjs/index.js'
```

Figyelj rá, hogy az `index.mjs` a workspace-ben `index.js` néven landoljon, ahogy a többi modulnál.

Run: `cd extensions/docs && npm run build && npm run install:local`

- [ ] **Step 2: Kapcsold be és állítsd be**

A futó appban: Extensions → Doksik → engedélyezés, majd a `gyoker` beállítása `~/SwarmClaw/docs`-ra. Ellenőrizd, hogy a bal sávban megjelent a **Doksik** ikon a Tasks után, és a lap betölt.

- [ ] **Step 3: Az élő ügynök-teszt**

A `CLAUDE.md` ezt kötelezővé teszi minden ügynököt érintő útvonalnál, és a fenti egységtesztek egyike sem méri, hogy a `getAgentContext` tényleg eljut-e a promptba. A forgatókönyv:

1. Egy ügynök hozzon létre egy doksit (`doksi_ir`, mappa megadása nélkül) → ellenőrizd, hogy `agents/<slug>/`-ba került, és a lapon látszik.
2. Egy **másik** ügynök keresse meg (`doksi_keres`) és hivatkozzon rá egy saját doksiból `[[...]]`-lal → a visszahivatkozás megjelenik a jobb panelen.
3. Kérdezd meg a második ügynököt tool-hívás **nélkül**, hogy milyen doksik vannak nála — a `getAgentContext`-ből tudnia kell.
4. Írd át a doksit a lapról, majd kérd az első ügynököt, hogy módosítsa a régi `baseVersion`-nel → **ütközést** kell kapnia, és a szövegből tudnia kell, mit tegyen.
5. Nyisd meg a gyökeret Finderben, írj át kívülről egy doksit → a keresőnek pár másodpercen belül az új szöveget kell találnia (ez a figyelő).

- [ ] **Step 4: Zárd a kört**

Run: `npm run lint:baseline` és `npm run test:runtime`
Expected: mindkettő átmegy; a `test:runtime` `# fail 0`, és a tesztszám a baseline 1947 fölött.

Ha az `npx eslint extensions/docs` új jelzést ad, **javítsd a kódot**, ne a szabályt (`CLAUDE.md`). Ha tényleg csökkent a jelzésszám, `npm run lint:baseline:update`.

- [ ] **Step 5: Commit** — `Docs module: installable, and proven with live agents`

---

## Önellenőrzés

**Spec-lefedettség.** A specifikáció szakaszai és a hozzájuk tartozó feladat: 2.1 szinkron-út → 6, 10. · 3 mappaszerkezet → 2, 8. · 3.1 fejléc → 2, 6. · 4 modulok → 2–12. · 4.1 figyelő és `setup()` → 7, 10. · 4.2 self-write → 6, 10. · 5 jogosultság → 4. · 6 adatbázis → 3. · 6.1 `version` → 3, 8. · 7 toolok → 8. · 8 `getAgentContext` → 9. · 9 wiki-linkek → 5. · 10 lap → 13–16. · 10.1 ütközés a lapon → 12, 15. · 10.2 hibasávok → 12, 14. · 11 beállítások → 7. · 12 szerződés → 11. · 13 hibakezelés → 1 és minden feladat. · 14 tesztelés → mindegyik feladat + 17. · 15 kihagyások → nincs feladat, szándékosan.

**Ismert hiányosság.** A 8., 9., 10., 11., 12. és 13. feladatnál a tesztek **nevei és állításai** szerepelnek, a teljes törzsük nem. A minta minden esetben az 1–7. feladat kiírt tesztjeié (`harness()`, temp gyökér, `try`/`finally` takarítás), és a nevek pontosan megmondják, mit kell állítani — de aki ezt a tervet vakon követi, ott több gépelnivalót kap, mint az első hét feladatnál. Ha a végrehajtás átadásra kerül, ezeket a törzseket előbb írd ki.

**Típus-egyezés.** A `writer.indexPath` mindenhol `{ id, valtozott, javitottFejlec }`-et ad; a `repo.search` mindenhol `{ id, path, title, reszlet }`-et; a `canWrite` mindenhol `(actor, relPath, { kozosMappaNev })` alakot vesz; az `actor` mindenhol `{ kind: 'user' | 'agent' | 'ext', … }`. A `repo.findByTitle` a Task 5-ben derül ki, hogy kell — ott is van jelezve, hogy a Task 3-hoz vissza kell nyúlni érte.
