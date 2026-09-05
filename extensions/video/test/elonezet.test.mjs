import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import {
  ELONEZET_NEVTER, KOCKA, KOCKA_UTAN, MEGTARTOTT_HASHEK, MIN_LATHATO_HOSSZ, SKALA,
  _resetFutas, allapot, elonezetDir, indit, kep, kockaFor, lathatoHosszFor, megszakit, vanMinta,
} from '../src/elonezet.mjs'
import { readCatalog } from '../src/katalogus.mjs'
import { fakeProject } from './helpers.mjs'

const quiet = { info() {}, warn() {}, error() {} }

/**
 * A project, a state and the pieces a test needs to talk about the cache.
 *
 * `mintak` and `mintaKockak` are written over the fixture catalogue rather
 * than read from it, so a test says out loud which types it expects a
 * picture for; the fixture is a copy of the real catalogue and carries all
 * twenty-four.
 */
function harness({ mintak, mintaKockak } = {}) {
  const dir = fakeProject()
  const katFile = path.join(dir, 'src', 'kit', 'katalogus.generated.json')
  if (mintak !== undefined || mintaKockak !== undefined) {
    const kat = JSON.parse(fs.readFileSync(katFile, 'utf8'))
    if (mintak !== undefined) kat.mintak = mintak
    if (mintaKockak !== undefined) kat.mintaKockak = mintaKockak
    fs.writeFileSync(katFile, JSON.stringify(kat))
  }
  const state = { log: quiet, settings: () => ({ remotionDir: dir }) }
  const katalogus = readCatalog(dir)
  _resetFutas()
  return { state, dir, katalogus, hashDir: elonezetDir(dir, katalogus.katalogusHash) }
}

/**
 * A spawn double: no browser, no npx, no process.
 *
 * The same seam `render.mjs` and its tests use -- the implementation is
 * injected, and `resolvingSpawn` hands it the name unchanged because the
 * test's state has no `resolveBinary`. It writes the output file the way the
 * real `remotion still` would and then exits, so the module's "exit 0 and
 * the file is there" success test is exercised rather than bypassed.
 */
function fakeSpawn({ bukjon = [], soha = false, hivasok = [] } = {}) {
  return (cmd, args, opts) => {
    const child = new EventEmitter()
    child.pid = 1234
    child.kill = (jel) => { child.jel = jel; setImmediate(() => child.emit('exit', null, jel)) }
    const outPath = args[4]
    const tipus = path.basename(outPath, '.png')
    hivasok.push({ cmd, args, opts, tipus, props: JSON.parse(fs.readFileSync(args[5].slice('--props='.length), 'utf8')) })
    if (soha) return child
    setImmediate(() => {
      if (bukjon.includes(tipus)) { child.emit('exit', 1, null); return }
      fs.writeFileSync(outPath, 'png-bytes')
      child.emit('exit', 0, null)
    })
    return child
  }
}

/** Polls until `fn()` is true: the run is deliberately not awaited by `indit`. */
async function settle(fn, mit = 'a várt állapot') {
  for (let i = 0; i < 300; i += 1) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`${mit} nem állt be`)
}

const kodja = (fn) => { try { fn(); return null } catch (e) { return e.code } }

test('a type outside the catalogue never reaches a path', async () => {
  const { state, hashDir } = harness()
  for (const rossz of ['../../../etc/passwd', 'nincs-ilyen-tipus', '', '..', 'cimlap/../../x']) {
    const r = kep(state, rossz)
    assert.equal(r.dataUrl, null, rossz)
    assert.equal(r.ok, 'tipus_ismeretlen', rossz)
  }
  // Not one file was named after any of them, and nothing was created.
  assert.equal(fs.existsSync(hashDir), false)
})

test('a declared type whose name is not a filename still never reaches a path', () => {
  // `readCatalog` drops a SAMPLE key the catalogue does not declare, but a
  // catalogue that DECLARES a traversal string declares it for every reader.
  const { state } = harness()
  const dir = fakeProject()
  const katFile = path.join(dir, 'src', 'kit', 'katalogus.generated.json')
  const kat = JSON.parse(fs.readFileSync(katFile, 'utf8'))
  kat.tipusok.push('../../../etc/passwd')
  kat.propok['../../../etc/passwd'] = []
  kat.mintak = { '../../../etc/passwd': { x: 1 } }
  fs.writeFileSync(katFile, JSON.stringify(kat))
  const gonosz = { log: quiet, settings: () => ({ remotionDir: dir }) }
  assert.equal(kep(gonosz, '../../../etc/passwd').ok, 'tipus_ismeretlen')
  // And it is not silently dropped from the bookkeeping either: a list that
  // omitted it would say the gallery is complete when it is not.
  assert.ok(allapot(gonosz).hianyzo.includes('../../../etc/passwd'))
  assert.equal(kep(state, 'cimlap').ok, 'nincs_kep')
})

test('the cache is keyed by the catalogue hash, so a changed catalogue shows nothing stale', () => {
  const { dir } = harness()
  const a = 'a'.repeat(64)
  const b = 'b'.repeat(64)
  const elso = elonezetDir(dir, a)
  const masodik = elonezetDir(dir, b)
  assert.notEqual(elso, masodik)
  assert.ok(elso.startsWith(path.join(dir, 'out', 'swarmclaw', 'sablon-elonezet')))
  assert.equal(ELONEZET_NEVTER, path.join('out', 'swarmclaw', 'sablon-elonezet'))
  // Anything that is not a sha256 hex digest is refused before it is a path.
  for (const rossz of ['../..', 'a'.repeat(63), 'A'.repeat(64), `${a}/x`, '', null, 5]) {
    assert.equal(kodja(() => elonezetDir(dir, rossz)), 'katalogus_hash_hibas', String(rossz))
  }
})

test('a changed catalogue is a different directory, and the old pictures are simply not looked at', async () => {
  const h = harness()
  await indit(h.state, fakeSpawn())
  await settle(() => allapot(h.state).hianyzo.length === 0, 'a teljes menet')
  assert.ok(fs.existsSync(path.join(h.hashDir, 'cimlap.png')))
  // The same project, one word of the catalogue different.
  const katFile = path.join(h.dir, 'src', 'kit', 'katalogus.generated.json')
  const kat = JSON.parse(fs.readFileSync(katFile, 'utf8'))
  kat.mintak.cimlap = { sorok: ['más'], kiemelt: 'más' }
  fs.writeFileSync(katFile, JSON.stringify(kat))
  const a = allapot(h.state)
  assert.notEqual(a.katalogusHash, h.katalogus.katalogusHash)
  assert.deepEqual(a.meglevo, [], 'no picture of the old catalogue is offered for the new one')
  assert.equal(kep(h.state, 'cimlap').ok, 'nincs_kep')
  assert.ok(fs.existsSync(path.join(h.hashDir, 'cimlap.png')), 'the old directory is untouched until a run sweeps it')
})

test('generation never starts by itself: reading the state and asking for a picture spawn nothing', () => {
  const { state, hashDir } = harness()
  const a = allapot(state)
  assert.equal(a.fut, null)
  assert.equal(a.meglevo.length, 0)
  assert.equal(a.hianyzo.length, 24)
  assert.equal(kep(state, 'cimlap').ok, 'nincs_kep')
  assert.equal(fs.existsSync(hashDir), false, 'not even the directory is created by a read')
})

test('a second start is refused by name rather than queued', async () => {
  const { state } = harness()
  const soha = fakeSpawn({ soha: true })
  const elso = await indit(state, soha)
  assert.deepEqual(elso, { indult: true })
  let hiba = null
  try { await indit(state, soha) } catch (e) { hiba = e }
  assert.ok(hiba, 'the second start threw')
  assert.equal(hiba.code, 'mar_fut')
  assert.equal(megszakit().megszakitva, true)
  await settle(() => allapot(state).fut === null, 'a megszakított menet vége')
  // Once it is over, the button works again.
  assert.deepEqual(await indit(state, fakeSpawn()), { indult: true })
  await settle(() => allapot(state).fut === null, 'a második menet vége')
})

test('one failing type does not stop the run, and its code lands on that type', async () => {
  const { state } = harness()
  await indit(state, fakeSpawn({ bukjon: ['lista'] }))
  await settle(() => allapot(state).fut === null, 'a menet vége')
  const a = await allapot(state)
  assert.ok(a.hianyzo.includes('lista'))
  assert.equal(a.meglevo.length, 23, 'the run went on after the failure')
  assert.ok(a.meglevo.includes('cimlap'))
  assert.equal(kep(state, 'lista').ok, 'nincs_kep')
})

test('the run records why each failure failed, by code, and never by the process output', async () => {
  // Four failures with four different causes, and the run reports each one
  // by a code of this module's own: nothing the child printed is read, so
  // nothing a stranger's text became can ride a failure onto the page.
  const { state } = harness({ mintak: { cimlap: { a: 1 }, lista: { a: 1 }, szam: { a: 1 }, allitas: { a: 1 }, cta: { a: 1 } } })
  const spawnImpl = (cmd, args) => {
    const child = new EventEmitter()
    child.kill = (jel) => setImmediate(() => child.emit('exit', null, jel))
    const tipus = path.basename(args[4], '.png')
    if (tipus === 'cta') return child // never exits, so the run is still readable
    setImmediate(() => {
      if (tipus === 'cimlap') child.emit('error', new Error('ENOENT'))
      else if (tipus === 'lista') child.emit('exit', 3, null)
      else if (tipus === 'szam') child.emit('exit', 0, null) // exits fine, writes nothing
      else child.emit('exit', null, 'SIGSEGV')
    })
    return child
  }
  await indit(state, spawnImpl)
  await settle(() => Object.keys(allapot(state).fut.hibak).length === 4, 'a négy hiba')
  const f = allapot(state).fut
  assert.deepEqual(f.hibak.cimlap, { kod: 'inditas_sikertelen' })
  assert.deepEqual(f.hibak.lista, { kod: 'kilepesi_kod', kilepesiKod: 3 })
  assert.deepEqual(f.hibak.szam, { kod: 'nincs_fajl' })
  assert.deepEqual(f.hibak.allitas, { kod: 'megszakadt', jel: 'SIGSEGV' })
  assert.deepEqual(f.kesz, [], 'the run reached all four, so no failure stopped it')
  megszakit()
  await settle(() => allapot(state).fut === null, 'a menet vége')
  const a = allapot(state)
  assert.deepEqual(a.meglevo, [])
  assert.deepEqual([...a.hianyzo].sort(), ['allitas', 'cimlap', 'cta', 'lista', 'szam'])
  assert.equal(a.mintaNelkul.length, 19)
})

test('a type with no sample is reported as such, not as a render failure', async () => {
  const { state } = harness({ mintak: {} })
  const a = await allapot(state)
  assert.deepEqual([...a.mintaNelkul].sort(), [...a.katalogusTipusok].sort())
  assert.deepEqual(a.hianyzo, [])
  assert.equal(kep(state, 'cimlap').ok, 'nincs_minta')
  // And a start over a catalogue with no samples spawns nothing at all.
  const hivasok = []
  await indit(state, fakeSpawn({ hivasok }))
  await settle(() => allapot(state).fut === null, 'a menet vége')
  assert.deepEqual(hivasok, [])
})

test('an empty sample is no sample: it is never drawn and never counted as drawable', async () => {
  // `{}` passes readCatalog's shape check and would render a blank card,
  // which is exactly what "no sample" is there to announce.
  const { state, katalogus } = harness({ mintak: { cimlap: {}, lista: { cim: 'van' } } })
  assert.equal(vanMinta(katalogus, 'cimlap'), false)
  assert.equal(vanMinta(katalogus, 'lista'), true)
  const a = allapot(state)
  assert.ok(a.mintaNelkul.includes('cimlap'))
  assert.deepEqual(a.hianyzo, ['lista'])
  assert.equal(kep(state, 'cimlap').ok, 'nincs_minta')
  const hivasok = []
  await indit(state, fakeSpawn({ hivasok }))
  await settle(() => allapot(state).fut === null, 'a menet vége')
  assert.deepEqual(hivasok.map((h) => h.tipus), ['lista'], 'no browser is spawned for an empty sample')
})

test('a sample whose props are thin is still a sample: keszulek-sor is drawn, not refused', async () => {
  // Its `kepernyok` is legitimately [] -- a required React node array the kit
  // does not route through its filename helper -- and it renders a card with
  // a title and nothing else, exit 0, a valid PNG. That is not a failure.
  const { state, katalogus } = harness()
  assert.deepEqual(katalogus.mintak['keszulek-sor'].kepernyok, [])
  assert.equal(vanMinta(katalogus, 'keszulek-sor'), true)
  const hivasok = []
  await indit(state, fakeSpawn({ hivasok }))
  await settle(() => allapot(state).fut === null, 'a menet vége')
  assert.ok(allapot(state).meglevo.includes('keszulek-sor'))
  assert.ok(!Object.hasOwn(allapot(state), 'hiba'))
})

test('the still call is the proven one, one scene, per-type frame, and a scene that outlasts it', async () => {
  const { state, dir, hashDir } = harness({ mintaKockak: { fordulat: 140, osszegzes: 130 } })
  const hivasok = []
  await indit(state, fakeSpawn({ hivasok }))
  await settle(() => allapot(state).fut === null, 'a menet vége')
  const cimlap = hivasok.find((h) => h.tipus === 'cimlap')
  assert.equal(cimlap.cmd, 'npx')
  assert.deepEqual(cimlap.args.slice(0, 4), ['remotion', 'still', 'src/index.ts', 'fos-video'])
  assert.equal(cimlap.args[4], path.join(hashDir, 'cimlap.png'))
  assert.equal(cimlap.args[6], `--frame=${KOCKA}`)
  assert.equal(cimlap.args[7], `--scale=${SKALA}`)
  assert.equal(cimlap.opts.cwd, dir)
  assert.equal(cimlap.opts.shell, false)
  // One scene, the sample's own props, and a visible length this module writes.
  assert.equal(cimlap.props.hatter, true)
  assert.equal(cimlap.props.lista.length, 1)
  assert.equal(cimlap.props.lista[0].tipus, 'cimlap')
  assert.deepEqual(cimlap.props.lista[0].kiemelt, 'cimlap')
  assert.equal(cimlap.props.lista[0].lathatoHossz, KOCKA + KOCKA_UTAN)
  // The two types the catalogue gives a frame get that frame, and a scene
  // long enough to contain it: a scene that ends at 90 cannot draw 130.
  const fordulat = hivasok.find((h) => h.tipus === 'fordulat')
  assert.equal(fordulat.args[6], '--frame=140')
  assert.equal(fordulat.props.lista[0].lathatoHossz, 140 + KOCKA_UTAN)
  const osszegzes = hivasok.find((h) => h.tipus === 'osszegzes')
  assert.equal(osszegzes.args[6], '--frame=130')
  assert.ok(osszegzes.props.lista[0].lathatoHossz > 130, 'the scene outlasts the frame it is sampled at')
})

test('the frame is per type, with 85 only as the fallback for a catalogue that states none', () => {
  const { katalogus } = harness({ mintaKockak: { fordulat: 140 } })
  assert.equal(kockaFor(katalogus, 'fordulat'), 140)
  assert.equal(kockaFor(katalogus, 'cimlap'), KOCKA)
  const regi = harness({ mintaKockak: undefined }).katalogus
  assert.deepEqual(regi.mintaKockak, {}, 'a catalogue from before the field is not an error')
  assert.equal(kockaFor(regi, 'fordulat'), KOCKA)
  // The length follows the frame, with the spec's 90 as the floor: a scene
  // that ends before the frame it is sampled at cannot draw that frame.
  assert.equal(lathatoHosszFor(KOCKA), KOCKA + KOCKA_UTAN)
  assert.equal(lathatoHosszFor(140), 170)
  assert.equal(lathatoHosszFor(0), MIN_LATHATO_HOSSZ)
  assert.ok(lathatoHosszFor(140) > 140)
})

test('a picture comes back as a data url, and a missing one as a code', async () => {
  const { state } = harness()
  await indit(state, fakeSpawn({ bukjon: ['lista'] }))
  await settle(() => allapot(state).fut === null, 'a menet vége')
  const r = kep(state, 'cimlap')
  assert.equal(r.ok, undefined)
  assert.ok(r.dataUrl.startsWith('data:image/png;base64,'))
  assert.equal(Buffer.from(r.dataUrl.split(',')[1], 'base64').toString(), 'png-bytes')
  assert.deepEqual(kep(state, 'lista'), { dataUrl: null, ok: 'nincs_kep' })
})

test('a cancel stops before the next type and keeps what is already generated', async () => {
  const { state } = harness()
  assert.deepEqual(megszakit(), { megszakitva: false }, 'nothing to cancel is not a lie about a cancel')
  let jelek = 0
  const lassu = (cmd, args) => {
    const child = new EventEmitter()
    const outPath = args[4]
    child.kill = (jel) => { jelek += 1; child.jel = jel }
    setTimeout(() => { fs.writeFileSync(outPath, 'png-bytes'); child.emit('exit', 0, null) }, 20)
    return child
  }
  await indit(state, lassu)
  await settle(() => allapot(state).fut !== null && allapot(state).fut.kesz.length >= 1, 'az első kép')
  assert.deepEqual(megszakit(), { megszakitva: true })
  assert.equal(jelek, 1, 'the child in flight is signalled')
  await settle(() => allapot(state).fut === null, 'a menet vége')
  const a = allapot(state)
  assert.ok(a.meglevo.length >= 1, 'what was generated stays')
  assert.ok(a.hianyzo.length > 0, 'and the rest is still missing')
})

test('the run state the page reads carries counts and codes, never the child process', async () => {
  const { state } = harness()
  await indit(state, fakeSpawn({ soha: true }))
  const f = allapot(state).fut
  assert.equal(f.osszes, 24)
  assert.deepEqual(f.kesz, [])
  assert.deepEqual(f.hibak, {})
  assert.equal(f.megszakitva, false)
  assert.equal(typeof f.indultAt, 'string')
  assert.deepEqual(Object.keys(f).sort(), ['hibak', 'indultAt', 'katalogusHash', 'kesz', 'megszakitva', 'osszes'])
  megszakit()
  await settle(() => allapot(state).fut === null, 'a menet vége')
})

test('old hash directories are swept, the last two kept', async () => {
  const { state, dir } = harness()
  const root = path.join(dir, ELONEZET_NEVTER)
  const regiek = ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)]
  regiek.forEach((h, i) => {
    const d = path.join(root, h)
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'cimlap.png'), 'x')
    fs.utimesSync(d, new Date(1000 + i), new Date(1000 + i))
  })
  await indit(state, fakeSpawn())
  await settle(() => allapot(state).fut === null, 'a menet vége')
  const maradt = fs.readdirSync(root).sort()
  assert.equal(maradt.length, MEGTARTOTT_HASHEK)
  assert.ok(maradt.includes(allapot(state).katalogusHash), 'the current one is kept')
  assert.ok(maradt.includes('3'.repeat(64)), 'and the newest old one')
  assert.ok(!maradt.includes('1'.repeat(64)))
  assert.ok(!maradt.includes('2'.repeat(64)))
})

test('the sweep touches nothing but 64-hex directories of this module own files, and never the namespace root', async () => {
  const { state, dir } = harness()
  const root = path.join(dir, ELONEZET_NEVTER)
  fs.mkdirSync(root, { recursive: true })
  // Four things the sweep must leave exactly where they are.
  const nemHash = path.join(root, 'narracio')
  fs.mkdirSync(nemHash); fs.writeFileSync(path.join(nemHash, 'hang.mp3'), 'audio')
  const rovid = path.join(root, 'a'.repeat(63))
  fs.mkdirSync(rovid); fs.writeFileSync(path.join(rovid, 'cimlap.png'), 'x')
  fs.writeFileSync(path.join(root, `${'4'.repeat(64)}`), 'a file, not a directory')
  // A hash-shaped directory old enough to sweep, holding something that is
  // not this module's: the file stays and so does the directory.
  const idegen = path.join(root, '5'.repeat(64))
  fs.mkdirSync(idegen)
  fs.writeFileSync(path.join(idegen, 'cimlap.png'), 'ours')
  fs.writeFileSync(path.join(idegen, 'video.mp4'), 'not ours')
  fs.utimesSync(idegen, new Date(1000), new Date(1000))
  // And two sweepable ones, so the keep-two rule actually reaches `idegen`.
  for (const h of ['6'.repeat(64), '7'.repeat(64)]) {
    const d = path.join(root, h)
    fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'lista.png'), 'x')
    fs.utimesSync(d, new Date(2000), new Date(2000))
  }
  await indit(state, fakeSpawn())
  await settle(() => allapot(state).fut === null, 'a menet vége')
  assert.ok(fs.existsSync(root), 'the namespace root is never a candidate')
  assert.ok(fs.existsSync(path.join(nemHash, 'hang.mp3')), 'a directory whose name is not 64 hex is not touched')
  assert.ok(fs.existsSync(path.join(rovid, 'cimlap.png')), '63 hex is not 64 hex')
  assert.ok(fs.existsSync(path.join(root, '4'.repeat(64))), 'a file with a hash name is not a hash directory')
  assert.ok(fs.existsSync(idegen), 'a directory holding a file this module did not write stays')
  assert.ok(fs.existsSync(path.join(idegen, 'video.mp4')), 'and so does the file')
  assert.equal(fs.existsSync(path.join(idegen, 'cimlap.png')), false, 'only this module own files are unlinked')
})

test('the props file is temporary: the cache directory holds pictures and nothing else', async () => {
  const { state, hashDir } = harness()
  await indit(state, fakeSpawn({ bukjon: ['lista'] }))
  await settle(() => allapot(state).fut === null, 'a menet vége')
  const maradt = fs.readdirSync(hashDir)
  assert.ok(maradt.length > 0)
  assert.deepEqual(maradt.filter((f) => !f.endsWith('.png')), [], 'no props json is left behind, not even for a failed type')
})
