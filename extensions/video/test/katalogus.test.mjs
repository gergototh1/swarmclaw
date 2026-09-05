import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { FPS, HANG_ELORETART, OVERLAP, UTOLSO_ZARO_TARTAS, ZARO_TARTAS, fedettseg, idovonal, lathatoHossz } from '../src/idozites.mjs'
import { ASSET_PROPOK, KIT_TABLA, KULDHETO_TIPUSOK, NEM_KULDHETO_TIPUSOK, assetUtvonal, ellenorizProp, tablaHianyai } from '../src/kit-tabla.mjs'
import { createCatalogTool, readCatalog, remotionDirOf, validateDraft } from '../src/katalogus.mjs'
import { PELDA_JELENETEK, PELDA_NARRACIO, fakeProject, freshRepo } from './helpers.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(here, 'fixtures', 'katalogus.generated.json')

const draft = (dir, jelenetek, narracio = PELDA_NARRACIO) => validateDraft({ jelenetek, narracio, katalogus: readCatalog(dir), remotionDir: dir })

test('the kit table covers every type and prop of the real catalogue, names the six asset props and the five unsendable types', () => {
  const kat = readCatalog(fakeProject())
  assert.deepEqual(tablaHianyai(kat), [])
  assert.equal(kat.tipusok.length, 24)
  assert.deepEqual([...NEM_KULDHETO_TIPUSOK].sort(), ['cta', 'kartya-csere', 'keszulek-sor', 'nagyitas', 'osztott'])
  assert.equal(KULDHETO_TIPUSOK.length, 19)
  assert.deepEqual([...ASSET_PROPOK].sort(), ['allitas.hatterPergo', 'allitas.hatterVideo', 'cimlap.kepek', 'idezet.kep', 'kep-allitas.kep', 'lista.kep'])
  for (const tipus of kat.tipusok) assert.ok(KIT_TABLA[tipus], tipus)
  // The table lists nothing the catalogue lacks either: a stale name here would be a prop the check accepts and the kit ignores.
  for (const [tipus, t] of Object.entries(KIT_TABLA)) {
    const katNevek = kat.propok[tipus].map((p) => p.nev)
    for (const nev of Object.keys(t.propok)) assert.ok(katNevek.includes(nev), `${tipus}.${nev} is in the table but not in the catalogue`)
  }
})

test('tablaHianyai names a type, a prop and a common prop the table does not have', () => {
  const kat = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  kat.tipusok.push('hologram')
  kat.propok.hologram = [{ nev: 'x', kotelezo: true, mit: '' }]
  kat.propok.szam.push({ nev: 'szinatmenet', kotelezo: false, mit: '' })
  kat.kozosPropok.push({ nev: 'arnyek', kotelezo: false, mit: '' })
  assert.deepEqual(tablaHianyai(kat), ['szam.szinatmenet', 'hologram', 'kozos.arnyek'])
})

test('readCatalog refuses a missing dir, a missing file and a malformed file by name', () => {
  const code = (fn) => { try { fn(); return null } catch (e) { return e.code } }
  assert.equal(code(() => readCatalog(path.join(os.tmpdir(), 'nincs-ilyen'))), 'katalogus_hianyzik')
  const dir = fakeProject(); fs.unlinkSync(path.join(dir, 'src', 'kit', 'katalogus.generated.json'))
  assert.equal(code(() => readCatalog(dir)), 'katalogus_hianyzik')
  assert.equal(code(() => readCatalog(fakeProject({ catalogText: '{"tipusok": "x"}' }))), 'katalogus_ervenytelen')
  assert.equal(code(() => readCatalog(fakeProject({ catalogText: 'nope' }))), 'katalogus_ervenytelen')
  assert.equal(code(() => readCatalog(fakeProject({ catalogText: '[]' }))), 'katalogus_ervenytelen')
  assert.equal(code(() => readCatalog(fakeProject({ catalogText: '{"tipusok":["szam"],"propok":{},"leirasok":{},"kozosPropok":[]}' }))), 'katalogus_ervenytelen')
  assert.equal(code(() => readCatalog(fakeProject({ catalogText: '{"tipusok":["szam"],"propok":{"szam":[{"nev":"szam"}]},"leirasok":{},"kozosPropok":[]}' }))), 'katalogus_ervenytelen')
  assert.equal(readCatalog(fakeProject()).katalogusHash.length, 64)
})

test('remotionDirOf reads the setting on every call and refuses a blank or a dir without package.json', () => {
  const code = (fn) => { try { fn(); return null } catch (e) { return e.code } }
  let remotionDir = ''
  const state = { settings: () => ({ remotionDir }) }
  assert.equal(code(() => remotionDirOf(state)), 'remotion_dir_hianyzik')
  remotionDir = path.join(os.tmpdir(), 'nincs-ilyen')
  assert.equal(code(() => remotionDirOf(state)), 'remotion_dir_hianyzik')
  remotionDir = `  ${fakeProject()}  `
  assert.equal(remotionDirOf(state), remotionDir.trim())
})

test('a valid plan passes with no refusal and its asset fingerprints', () => {
  const dir = fakeProject()
  const r = draft(dir, [{ tipus: 'cimlap', sorok: ['a', 'b'] }, { tipus: 'lista', felsorolas: ['x'], kep: 'usecase/kep.png' }, { tipus: 'allitas', mondat: 'Z.' }])
  assert.equal(r.refusal, null)
  assert.deepEqual(r.figyelmeztetesek, ['L7:hossz_tartomanyon_kivul'])
  assert.deepEqual(r.assetUjjlenyomatok.map((a) => a.utvonal), ['usecase/kep.png'])
  assert.equal(r.assetUjjlenyomatok[0].sha256.length, 64)
})

test('every shape and enumeration of the sendable set accepts a value the kit accepts', () => {
  const dir = fakeProject()
  const mind = [
    { tipus: 'cimlap', sorok: ['a', 'b'], kiemelt: 'b', hatter: 'kepek', kepek: ['usecase/kep.png'], lepes: 8, meret: 96, racs: false },
    { tipus: 'atvezeto', sorszam: '01', nev: 'n', meret: 96 },
    { tipus: 'lista', cim: 'c', felsorolas: ['x'], kep: 'usecase/kep.png', makett: 'telefon', zaroSor: 'z', lepes: 40 },
    { tipus: 'allitas', mondat: 'm', kiemelt: ['m'], masodik: 's', meret: 80, hatterVideo: 'usecase/kep.png', hatterVideoTeljes: true, hatterPergo: ['usecase/kep.png'] },
    { tipus: 'szam', felvezeto: 'f', szam: 40, utoszo: 'u', meret: 150 },
    { tipus: 'gorbe', cim: 'c', ertekek: [1, 2, 3], zaroSzam: 3, egyseg: '%', teljes: false, tempo: 0.5 },
    { tipus: 'oszlop', cim: 'c', adatok: [{ cimke: 'a', ertek: 1 }, { cimke: 'b', ertek: 2, szin: '#fff', cimkeSzin: '#000' }], egyseg: 'x', teljes: true, tempo: 1 },
    { tipus: 'koriv', cim: 'c', szazalek: 40, alaSzoveg: 'a', tempo: 1 },
    { tipus: 'osszehuzas', cim: 'c', rol: 'a', ra: 'b', arany: 0.3, savMeret: 76, savSuly: 800, tempo: 1 },
    { tipus: 'idezet', idezet: 'i', kitol: 'k', hol: 'h', kep: 'usecase/kep.png', egyben: true, tempo: 1 },
    { tipus: 'racs', cim: 'c', elemek: [{ szoveg: 'a' }], oszlop: 3 },
    { tipus: 'szam-racs', cim: 'c', szamok: [{ ertek: 1, cimke: 'a' }, { ertek: 2, cimke: 'b', utotag: '%' }] },
    { tipus: 'kep-allitas', kep: 'usecase/kep.png', sor: 's', doles: -3, grafikaMeret: 700 },
    { tipus: 'lepessor', cim: 'c', lepesek: ['a', 'b'] },
    { tipus: 'osszetetel', cim: 'c', reszek: [{ cimke: 'a', ertek: 1, szin: '#4f7cff' }] },
    { tipus: 'bizonyitek', allitas: 'a', kulcsszo: 'a', adatok: [{ cimke: 'a', ertek: 1 }], egyseg: 'x' },
    { tipus: 'fordulat', problemak: ['p'], megoldas: 'm' },
    { tipus: 'magyarazott', cim: 'c', reszek: [{ cimke: 'a', ertek: 1, szin: '#fff', magyarazat: 'm' }] },
    { tipus: 'osszegzes', cim: 'c', reszek: [{ ertek: 1, cimke: 'a' }], osszegCimke: 'o', utotag: 'u' },
    { tipus: 'allitas', mondat: 'Z.' },
  ]
  assert.equal(mind.length, KULDHETO_TIPUSOK.length + 1)
  const r = draft(dir, mind, mind.map((_, i) => ({ jelenet: i, szoveg: 'x'.repeat(30) })))
  assert.equal(r.refusal, null)
  assert.deepEqual(r.figyelmeztetesek, [])
  assert.equal(r.assetUjjlenyomatok.length, 6)
})

test('each refusal has its own code', () => {
  const dir = fakeProject()
  const code = (jelenetek, narracio) => draft(dir, jelenetek, narracio).refusal?.code ?? null
  const ok = { tipus: 'allitas', mondat: 'Z.' }
  const two = (j) => [{ tipus: 'cimlap', sorok: ['a'] }, j, ok]
  assert.equal(code(two({ tipus: 'hologram', x: 1 })), 'tipus_ismeretlen')
  assert.equal(code(two({ tipus: 'constructor' })), 'tipus_ismeretlen')
  assert.equal(code(two({ tipus: 'szam' })), 'prop_kotelezo_hianyzik')
  assert.equal(code(two({ tipus: 'szam', szam: 1, ize: 2 })), 'prop_ismeretlen')
  assert.equal(code(two({ tipus: 'szam', szam: 1, constructor: 2 })), 'prop_ismeretlen')
  assert.equal(code(two({ tipus: 'szam', szam: 1, hang: 'x.mp3' })), 'prop_ismeretlen')
  assert.equal(code(two({ tipus: 'szam', szam: 1, lathatoHossz: 90 })), 'prop_ismeretlen')
  assert.equal(code(two({ tipus: 'cta', sorok: [{ ikon: 'bell', kicsi: 'a', nagy: 'b' }] })), 'tipus_nem_kuldheto')
  assert.equal(code(two({ tipus: 'nagyitas', kep: 'usecase/kep.png', felirat: 'f' })), 'tipus_nem_kuldheto')
  assert.equal(code(two({ tipus: 'cimlap', sorok: ['a'], grafika: 'x' })), 'prop_nem_kuldheto')
  assert.equal(code(two({ tipus: 'allitas', mondat: 'm', grafika: 'x' })), 'prop_nem_kuldheto')
  assert.equal(code(two({ tipus: 'racs', cim: 'c', elemek: [{ szoveg: 'a', jel: 'bell' }] })), 'prop_nem_kuldheto')
  assert.equal(code(two({ tipus: 'cimlap', sorok: 'string' })), 'prop_alak_hibas')
  assert.equal(code(two({ tipus: 'cimlap', sorok: [] })), 'prop_alak_hibas')
  assert.equal(code(two({ tipus: 'cimlap', sorok: ['a', ''] })), 'prop_alak_hibas')
  assert.equal(code(two({ tipus: 'szam', szam: '40' })), 'prop_alak_hibas')
  assert.equal(code(two({ tipus: 'szam', szam: Number.NaN })), 'prop_alak_hibas')
  assert.equal(code(two({ tipus: 'szam', szam: 1, racs: 'igen' })), 'prop_alak_hibas')
  assert.equal(code(two({ tipus: 'gorbe', cim: 'c', ertekek: ['1'] })), 'prop_alak_hibas')
  assert.equal(code(two({ tipus: 'gorbe', cim: 'c', ertekek: [1], teljes: 'true' })), 'prop_alak_hibas')
  assert.equal(code(two({ tipus: 'osszehuzas', cim: 'c', rol: 'a', ra: 'b', arany: 1.5 })), 'prop_alak_hibas')
  assert.equal(code(two({ tipus: 'oszlop', cim: 'c', adatok: [{ cimke: 'a' }] })), 'prop_alak_hibas')
  assert.equal(code(two({ tipus: 'oszlop', cim: 'c', adatok: [{ cimke: 'a', ertek: '1' }] })), 'prop_alak_hibas')
  assert.equal(code(two({ tipus: 'oszlop', cim: 'c', adatok: [{ cimke: 'a', ertek: 1, ize: 1 }] })), 'prop_alak_hibas')
  assert.equal(code(two({ tipus: 'oszlop', cim: 'c', adatok: ['a'] })), 'prop_alak_hibas')
  assert.equal(code(two({ tipus: 'oszlop', cim: 'c', adatok: [] })), 'prop_alak_hibas')
  assert.equal(code(two({ tipus: 'osszetetel', cim: 'c', reszek: [{ cimke: 'a', ertek: 1 }] })), 'prop_alak_hibas')
  assert.equal(code(two({ tipus: 'cimlap', sorok: ['a'], hatter: 'valami' })), 'prop_ertek_ismeretlen')
  assert.equal(code(two({ tipus: 'lista', felsorolas: ['a'], makett: 'tablet' })), 'prop_ertek_ismeretlen')
  assert.equal(code(two({ tipus: 'lista', felsorolas: ['a'], kep: '../x.png' })), 'asset_utvonal_ervenytelen')
  assert.equal(code(two({ tipus: 'lista', felsorolas: ['a'], kep: '/etc/passwd' })), 'asset_utvonal_ervenytelen')
  assert.equal(code(two({ tipus: 'lista', felsorolas: ['a'], kep: 'kifele.png' })), 'asset_utvonal_ervenytelen')
  assert.equal(code(two({ tipus: 'lista', felsorolas: ['a'], kep: 'usecase/nincs.png' })), 'asset_hianyzik')
  assert.equal(code(two({ tipus: 'cimlap', sorok: ['a'], kepek: ['usecase/kep.png', 'usecase/nincs.png'] })), 'asset_hianyzik')
  assert.equal(code(two({ tipus: 'szam', szam: 1 }), [{ jelenet: 0, szoveg: 'a' }, { jelenet: 2, szoveg: 'c' }]), 'narracio_hianyzik')
  assert.equal(code(two({ tipus: 'szam', szam: 1 }), [{ jelenet: 0, szoveg: 'a' }, { jelenet: 1, szoveg: '  ' }, { jelenet: 2, szoveg: 'c' }]), 'narracio_hianyzik')
  assert.equal(code(two({ tipus: 'szam', szam: 1 }), [{ jelenet: 0, szoveg: 'a' }, { jelenet: 1, szoveg: 'b' }, { jelenet: 7, szoveg: 'c' }]), 'argumentum_hibas')
  assert.equal(code(two({ tipus: 'szam', szam: 1 }), [{ jelenet: 0, szoveg: 'a' }, { jelenet: 0, szoveg: 'b' }, { jelenet: 1, szoveg: 'c' }]), 'argumentum_hibas')
  assert.equal(code(two({ tipus: 'szam', szam: 1 }), 'nope'), 'argumentum_hibas')
  assert.equal(code([], PELDA_NARRACIO), 'argumentum_hibas')
  assert.equal(code('nope', PELDA_NARRACIO), 'argumentum_hibas')
  assert.equal(code(two('nope')), 'argumentum_hibas')
  assert.equal(code(two(['szam'])), 'argumentum_hibas')
})

test('a refusal names the scene, the rule and the closed list, never the text the agent sent', () => {
  const dir = fakeProject()
  const message = (j) => draft(dir, [{ tipus: 'cimlap', sorok: ['a'] }, j, { tipus: 'allitas', mondat: 'Z.' }]).refusal.message
  const unknownType = message({ tipus: 'hologram-TITKOS' })
  assert.match(unknownType, /^jelenet 1:/)
  assert.doesNotMatch(unknownType, /TITKOS/)
  assert.match(unknownType, /cimlap, atvezeto, lista/)
  const unknownProp = message({ tipus: 'szam', szam: 1, 'ize-TITKOS': 2 })
  assert.match(unknownProp, /^jelenet 1 \(szam\):/)
  assert.doesNotMatch(unknownProp, /TITKOS/)
  assert.match(unknownProp, /felvezeto, szam, utoszo, meret/)
  const unknownField = message({ tipus: 'oszlop', cim: 'c', adatok: [{ cimke: 'a', ertek: 1, 'ize-TITKOS': 1 }] })
  assert.match(unknownField, /^jelenet 1 \(oszlop\)\.adatok: 0\. elem/)
  assert.doesNotMatch(unknownField, /TITKOS/)
  assert.match(unknownField, /cimke, ertek, szin, cimkeSzin/)
  const badPath = message({ tipus: 'lista', felsorolas: ['a'], kep: '../TITKOS.png' })
  assert.match(badPath, /^jelenet 1 \(lista\)\.kep:/)
  assert.doesNotMatch(badPath, /TITKOS/)
  const missing = message({ tipus: 'lista', felsorolas: ['a'], kep: 'usecase/TITKOS.png' })
  assert.doesNotMatch(missing, /TITKOS/)
  const missingInList = message({ tipus: 'cimlap', sorok: ['a'], kepek: ['usecase/kep.png', 'usecase/TITKOS.png'] })
  assert.match(missingInList, /^jelenet 1 \(cimlap\)\.kepek\[1\]:/)
  assert.doesNotMatch(missingInList, /TITKOS/)
  const badEnum = message({ tipus: 'cimlap', sorok: ['a'], hatter: 'TITKOS' })
  assert.doesNotMatch(badEnum, /TITKOS/)
  assert.match(badEnum, /csillagok, csillagok-remotion, racs, tiszta, kepek, kep-teljes, kep-sotet/)
  assert.match(message({ tipus: 'cta', sorok: [] }), /sorok\[\]\.ikon/)
  assert.match(message({ tipus: 'racs', cim: 'c', elemek: [{ szoveg: 'a', jel: 'x' }] }), /0\. elem\.jel: React-csomópont/)
})

test('L6, L8 and L9 warn; L7 warns on both ends; a good long plan has no warning', () => {
  const dir = fakeProject()
  const r = draft(dir, [{ tipus: 'szam', szam: 1 }, { tipus: 'lista', felsorolas: ['a'] }], [{ jelenet: 0, szoveg: 'a'.repeat(400) }, { jelenet: 1, szoveg: 'b' }])
  assert.deepEqual(r.figyelmeztetesek, ['L6:elso_nem_cimlap', 'L8:tul_keves_tartalom', 'L9:zarlat_nem_allitas'])
  const long = draft(dir, PELDA_JELENETEK, [{ jelenet: 0, szoveg: 'a'.repeat(1000) }, { jelenet: 1, szoveg: 'b'.repeat(1000) }, { jelenet: 2, szoveg: 'c' }])
  assert.deepEqual(long.figyelmeztetesek, ['L7:hossz_tartomanyon_kivul'])
  const good = draft(dir, PELDA_JELENETEK, [{ jelenet: 0, szoveg: 'a'.repeat(200) }, { jelenet: 1, szoveg: 'b'.repeat(200) }, { jelenet: 2, szoveg: 'c'.repeat(200) }])
  assert.deepEqual(good.figyelmeztetesek, [])
  assert.equal(Math.round(good.becsultHosszMp), 43)
  // The measured ratio replaces the estimate when the caller hands one over.
  const measured = validateDraft({ jelenetek: PELDA_JELENETEK, narracio: good.figyelmeztetesek.length === 0 ? [{ jelenet: 0, szoveg: 'a'.repeat(200) }, { jelenet: 1, szoveg: 'b'.repeat(200) }, { jelenet: 2, szoveg: 'c'.repeat(200) }] : [], katalogus: readCatalog(dir), remotionDir: dir, karakterPerMp: 20 })
  assert.equal(measured.becsultHosszMp, 30)
})

test('a catalogue newer than the table: an unused extra prop warns, a used one is refused naming the table', () => {
  const kat = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  kat.propok.szam.push({ nev: 'szinatmenet', kotelezo: false, mit: 'új' })
  const dir = fakeProject({ catalogText: JSON.stringify(kat) })
  const unused = draft(dir, PELDA_JELENETEK)
  assert.equal(unused.refusal, null); assert.ok(unused.figyelmeztetesek.includes('katalogus_valtozott'))
  const used = draft(dir, [{ tipus: 'cimlap', sorok: ['a'] }, { tipus: 'szam', szam: 1, szinatmenet: 'x' }, { tipus: 'allitas', mondat: 'z' }])
  assert.equal(used.refusal.code, 'prop_ismeretlen'); assert.match(used.refusal.message, /katalogus_valtozott/)
  kat.tipusok.push('hologram'); kat.propok.hologram = [{ nev: 'x', kotelezo: true, mit: '' }]
  const dir2 = fakeProject({ catalogText: JSON.stringify(kat) })
  const usedType = draft(dir2, [{ tipus: 'cimlap', sorok: ['a'] }, { tipus: 'hologram', x: 1 }, { tipus: 'allitas', mondat: 'z' }])
  assert.equal(usedType.refusal.code, 'tipus_ismeretlen'); assert.match(usedType.refusal.message, /hologram.*katalogus_valtozott/)
})

test('assetUtvonal normalises nothing: the stored value is the given value, and only inside public/', () => {
  const dir = fakeProject()
  assert.equal(assetUtvonal(dir, 'usecase/kep.png').utvonal, 'usecase/kep.png')
  assert.equal(assetUtvonal(dir, './usecase/kep.png').code, 'asset_utvonal_ervenytelen')
  assert.equal(assetUtvonal(dir, 'usecase/./kep.png').code, 'asset_utvonal_ervenytelen')
  assert.equal(assetUtvonal(dir, 'usecase\\kep.png').code, 'asset_utvonal_ervenytelen')
  assert.equal(assetUtvonal(dir, 'usecase//kep.png').code, 'asset_utvonal_ervenytelen')
  assert.equal(assetUtvonal(dir, 'usecase/kep.png/').code, 'asset_utvonal_ervenytelen')
  assert.equal(assetUtvonal(dir, 'usecase/kep png.png').code, 'asset_utvonal_ervenytelen')
  assert.equal(assetUtvonal(dir, 'usecase/kép.png').code, 'asset_utvonal_ervenytelen')
  assert.equal(assetUtvonal(dir, 'c:usecase/kep.png').code, 'asset_utvonal_ervenytelen')
  assert.equal(assetUtvonal(dir, 'usecase/kep.png\n').code, 'asset_utvonal_ervenytelen')
  assert.equal(assetUtvonal(dir, '').code, 'asset_utvonal_ervenytelen')
  assert.equal(assetUtvonal(dir, 42).code, 'asset_utvonal_ervenytelen')
  assert.equal(assetUtvonal(dir, 'usecase').code, 'asset_hianyzik')
  assert.equal(assetUtvonal(dir, 'kifele.png').code, 'asset_utvonal_ervenytelen')
  assert.equal(assetUtvonal(path.join(os.tmpdir(), 'nincs-ilyen'), 'usecase/kep.png').code, 'asset_hianyzik')
})

test('assetUtvonal is case-exact on every filesystem, and follows a symlink that stays inside public/', () => {
  const dir = fakeProject()
  assert.equal(assetUtvonal(dir, 'usecase/KEP.png').code, 'asset_hianyzik')
  assert.equal(assetUtvonal(dir, 'USECASE/kep.png').code, 'asset_hianyzik')
  fs.symlinkSync(path.join(dir, 'public', 'usecase', 'kep.png'), path.join(dir, 'public', 'belul.png'))
  const r = assetUtvonal(dir, 'belul.png')
  assert.equal(r.utvonal, 'belul.png')
  assert.equal(r.sha256, assetUtvonal(dir, 'usecase/kep.png').sha256)
})

test('ellenorizProp answers only about props the table has', () => {
  assert.equal(ellenorizProp('szam', 'szam', 40), null)
  assert.equal(ellenorizProp('szam', 'szam', '40').code, 'prop_alak_hibas')
  assert.equal(ellenorizProp('cimlap', 'grafika', 'x').code, 'prop_nem_kuldheto')
  assert.equal(ellenorizProp('osszehuzas', 'arany', 1), null)
  assert.equal(ellenorizProp('osszehuzas', 'arany', -0.1).code, 'prop_alak_hibas')
  assert.throws(() => ellenorizProp('szam', 'ize', 1), /KIT_TABLA/)
  assert.throws(() => ellenorizProp('hologram', 'x', 1), /KIT_TABLA/)
  assert.throws(() => ellenorizProp('szam', 'constructor', 1), /KIT_TABLA/)
})

test('the frame arithmetic: visible length, timeline bounds and coverage', () => {
  assert.equal(FPS, 30); assert.equal(HANG_ELORETART, 10); assert.equal(OVERLAP, 14)
  assert.equal(lathatoHossz(2000, false), HANG_ELORETART + 60 + ZARO_TARTAS)
  assert.equal(lathatoHossz(2000, true), HANG_ELORETART + 60 + UTOLSO_ZARO_TARTAS)
  assert.equal(lathatoHossz(2001, false), HANG_ELORETART + 61 + ZARO_TARTAS)
  const t = idovonal([2000, 3000])
  assert.deepEqual(t.elemek, [
    { jelenet: 0, kezdetKocka: 0, lathato: 78, kezdetMs: 0, vegMs: 2600 },
    { jelenet: 1, kezdetKocka: 78, lathato: 145, kezdetMs: 2600, vegMs: 7433 },
  ])
  assert.equal(t.teljesKocka, 78 + 145 + OVERLAP)
  assert.equal(t.teljesMs, Math.round(((78 + 145 + OVERLAP) / FPS) * 1000))
  assert.equal(fedettseg([]), 0)
  assert.equal(fedettseg([2000, 3000]), 5000 / t.teljesMs)
  assert.deepEqual(idovonal([]), { elemek: [], teljesKocka: OVERLAP, teljesMs: Math.round((OVERLAP / FPS) * 1000) })
})

test('videoCatalog reads the file on every call and refuses a missing project by name', async () => {
  const { repo } = freshRepo()
  let remotionDir = ''
  const tool = createCatalogTool({ settings: () => ({ remotionDir }), repo })
  assert.equal(tool.name, 'videoCatalog')
  assert.equal((await tool.execute({})).error.code, 'remotion_dir_hianyzik')
  remotionDir = fakeProject()
  const first = await tool.execute({})
  assert.equal(first.error, undefined)
  assert.equal(first.tipusok.length, 24)
  assert.equal(first.kuldhetoTipusok.length, 19)
  assert.deepEqual(first.tablaHianyok, [])
  assert.equal(first.sablonStat.szam.hasznalat, 0)
  assert.equal(first.becsultKarakterPerMasodperc, 14)
  const kat = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  kat.propok.szam.push({ nev: 'szinatmenet', kotelezo: false, mit: 'új' })
  fs.writeFileSync(path.join(remotionDir, 'src', 'kit', 'katalogus.generated.json'), JSON.stringify(kat))
  const second = await tool.execute({})
  assert.notEqual(second.katalogusHash, first.katalogusHash)
  assert.deepEqual(second.tablaHianyok, ['szam.szinatmenet'])
  fs.unlinkSync(path.join(remotionDir, 'src', 'kit', 'katalogus.generated.json'))
  assert.equal((await tool.execute({})).error.code, 'katalogus_hianyzik')
})
