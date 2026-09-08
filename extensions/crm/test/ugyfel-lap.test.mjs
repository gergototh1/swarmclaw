import assert from 'node:assert/strict'
import test from 'node:test'

import { bundle } from '../scripts/build.mjs'
import {
  esemenyFajtaCimke, feladatStatuszCimke, idovonalOsztaly, lapozottIdovonal, ugyfelFeladatai,
} from '../ui/ugyfel-lap.tsx'

/**
 * A "Korábbiak" gomb a `timeline` rpc-t hívja a lista végén (a legrégebbi
 * eseménynél) lévő `occurred_at`-tal, és a választ hozzáfűzi a meglévő
 * listához. Három eset dönti el, hogy a gomb ezután mit mutat és marad-e
 * látható:
 *
 * 1. A visszakapott lap valódi, korábbi eseményeket hoz -- ezeket a végéhez
 *    kell fűzni, a sorrend megtartásával.
 * 2. A visszakapott lap üres -- nincs több korábbi esemény, a hívónak ezt
 *    kell jeleznie, hogy a gomb eltűnhessen.
 * 3. Az id szerinti szűrés véd, ha egy id mindkét lapon szerepelne -- a repo
 *    (`src/db.mjs` `listEvents`) mostantól a `beforeId`-vel az összetett
 *    `(occurred_at, id)` határon lapoz, ezért ez sem duplikálás, sem
 *    elhagyás formájában nem fordulhat elő; a teszt csak azt pinneli le,
 *    hogy a védekező szűrés önmagában ártalmatlan és nem dob el semmit
 *    feleslegesen.
 */

const eseny = (id, occurredAt) => ({ id, kind: 'note', occurred_at: occurredAt, title: '', excerpt: id })

test('hozzáfűzi az új lapot a meglévő lista végéhez', () => {
  const meglevo = [eseny('e3', '2026-09-03T10:00:00Z'), eseny('e2', '2026-09-02T10:00:00Z')]
  const ujOldal = [eseny('e1', '2026-09-01T10:00:00Z')]
  const eredmeny = lapozottIdovonal(meglevo, ujOldal)
  assert.deepEqual(eredmeny.map((e) => e.id), ['e3', 'e2', 'e1'])
})

test('üres lap esetén a lista változatlan marad', () => {
  const meglevo = [eseny('e3', '2026-09-03T10:00:00Z')]
  const eredmeny = lapozottIdovonal(meglevo, [])
  assert.deepEqual(eredmeny, meglevo)
})

test('a védekező id-szűrés nem dob el semmit, ha egy id mindkét lapon szerepel', () => {
  const meglevo = [eseny('e3', '2026-09-03T10:00:00Z'), eseny('e2', '2026-09-02T10:00:00Z')]
  const ujOldal = [eseny('e2', '2026-09-02T10:00:00Z'), eseny('e1', '2026-09-01T10:00:00Z')]
  const eredmeny = lapozottIdovonal(meglevo, ujOldal)
  assert.deepEqual(eredmeny.map((e) => e.id), ['e3', 'e2', 'e1'])
})

/**
 * A 7. feladat: a host `/api/tasks` GET-je objektumot ad (id -> feladat), a
 * kapcsolat a `customFields.crm_account` mezőn áll -- ezt az `acceptSuggestion`
 * (`src/rpc.mjs`) írja rá elfogadáskor. A szűrésnek ki kell hagynia a más
 * ügyfélhez tartozó és a CRM-en kívülről (customFields nélkül) érkező
 * feladatokat is, és a legfrissebbet kell előre tennie.
 */
const feladat = (id, accountId, createdAt) => ({
  id, title: `Feladat ${id}`, status: 'queued', dueAt: null, createdAt,
  customFields: accountId ? { crm_account: accountId } : undefined,
})

test('csak az adott ügyfélhez tartozó feladatokat adja, a legfrissebbel elöl', () => {
  const feladatok = {
    t1: feladat('t1', 'acc_1', 100),
    t2: feladat('t2', 'acc_2', 200),
    t3: feladat('t3', 'acc_1', 300),
    t4: feladat('t4', null, 400),
  }
  const eredmeny = ugyfelFeladatai(feladatok, 'acc_1')
  assert.deepEqual(eredmeny.map((f) => f.id), ['t3', 't1'])
})

test('üres feladatlistára üres tömböt ad', () => {
  assert.deepEqual(ugyfelFeladatai({}, 'acc_1'), [])
})

/**
 * I6: ez a teszt korabban a `crm-cols` es a `crm-tl-out` STRINGJET kereste a
 * bundle-ben -- de mindketto a JSX `className`-jeben el, tehat sem a
 * `.crm-cols` ket hasabja, sem a 860px-es egyhasabos osszeomlas, sem a
 * `.crm-tl-out` iranyjelzo keretszine nem volt igy vedve (mindharom szabaly
 * torolheto volt zold csomag mellett). A szabalyok torzset most a
 * `test/style.test.mjs` orzi. Itt az marad, amit ez a fajl tud bizonyitani:
 * hogy a HAROM nevesitett grid-terulet tenylegesen ki van adva a DOM-ba,
 * ebben a sorrendben -- ez az, amitol a billentyuzetes fokuszsorrend
 * megegyezik a latvannyal mindket toresponton.
 */
test('az ugyfel lap harom nevesitett grid-teruletet ad ki, DOM-sorrendben', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  const cols = js.indexOf('className: "crm-cols"')
  assert.ok(cols !== -1, 'hianyzik a ket hasab kerete')
  const utana = js.slice(cols, cols + 20000)
  const summary = utana.indexOf('crm-card crm-summary')
  const checks = utana.indexOf('className: "crm-checks"')
  const timeline = utana.indexOf('className: "crm-sec crm-timeline"')
  assert.ok(summary !== -1, 'hianyzik az Osszefoglalo terulet')
  assert.ok(checks !== -1, 'hianyzik az ellenorizendo kartyak terulete')
  assert.ok(timeline !== -1, 'hianyzik az Idovonal terulet')
  assert.ok(
    summary < checks && checks < timeline,
    'a DOM-sorrendnek Osszefoglalo -> checks -> Idovonal-nak kell lennie: 860px alatt '
    + 'ez az egyetlen sorrend, ami nem tolja az (akar 50 elemu) idovonalat az '
    + 'ellenorizendo kartyak fole',
  )
})

test('az idovonal minden esemenynek iranyt ad, ismeretlennek is', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  assert.match(js, /idovonalOsztaly/, 'az irany-lekepezes kiemelt fuggveny')
})

test('az esemeny fajtaja adja az idovonal-osztalyt', () => {
  assert.equal(idovonalOsztaly('email_in'), 'crm-tlitem')
  assert.equal(idovonalOsztaly('email_out'), 'crm-tlitem crm-tl-out')
  assert.equal(idovonalOsztaly('note'), 'crm-tlitem crm-tl-note')
  assert.equal(idovonalOsztaly('barmi_mas'), 'crm-tlitem crm-tl-note')
})

/**
 * F4: a feladat-státusz és az esemény-fajta pillek korábban a nyers
 * (angol) adatértéket mutatták egy egyébként magyar felületen
 * (`in_progress`, `open`, `done`, `note`, `email_in`, `email_out`) --
 * `ugyfelek.tsx` STATUSZ táblázatával egyező mintát követve most magyar
 * feliratot kapnak, ismeretlen értékre a nyers stringgel mint
 * visszaeséssel, hogy egy új/nem listázott érték inkább csúnyán, mint
 * némán tűnjön el.
 */
test('feladatStatuszCimke: ismert statuszra magyar feliratot ad', () => {
  assert.equal(feladatStatuszCimke('open'), 'Nyitott')
  assert.equal(feladatStatuszCimke('in_progress'), 'Folyamatban')
  assert.equal(feladatStatuszCimke('done'), 'Kész')
  assert.equal(feladatStatuszCimke('completed'), 'Kész')
})

test('feladatStatuszCimke: ismeretlen statuszra a nyers erteket adja vissza (visszaeses)', () => {
  assert.equal(feladatStatuszCimke('barmi_ismeretlen'), 'barmi_ismeretlen')
})

test('esemenyFajtaCimke: ismert fajtara magyar feliratot ad', () => {
  assert.equal(esemenyFajtaCimke('note'), 'Jegyzet')
  assert.equal(esemenyFajtaCimke('email_in'), 'Bejövő email')
  assert.equal(esemenyFajtaCimke('email_out'), 'Kimenő email')
})

test('esemenyFajtaCimke: ismeretlen fajtara a nyers erteket adja vissza (visszaeses)', () => {
  assert.equal(esemenyFajtaCimke('barmi_ismeretlen'), 'barmi_ismeretlen')
})


/**
 * I4: az ugy-lista statusz-pillje. A `d.stage` nyersen (angolul) jelent meg
 * -- `new`, `proposal` -- egy sorral a magyar „lezárt" alatt. A szotar az
 * `ugyek.tsx`-e (`szakaszCimke`), nem egy masodik masolat: ket szotar ket
 * helyen elobb-utobb ketfele mond.
 */
test('az ugy-lista pillje a magyar szakasznevet mutatja, lezart ugyre a "lezárt"-at', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  assert.match(
    js,
    /children:\s*d\.closed_at \? "lezárt" : szakaszCimke\(d\.stage\)/,
    'a nyers `d.stage` volt az utolso angol allapotnev a feluleten -- a szotarnak kell megjelennie',
  )
  assert.equal(
    /children:\s*d\.closed_at \? "lezárt" : d\.stage/.test(js), false,
    'a nyers stage-erteket semmi nem irhatja ki kozvetlenul',
  )
})

/**
 * A "Teljes szöveg" gomb akadalymentes neve es a mellette allo, LATHATO
 * fajta-pill ugyanabbol a szotarbol kell hogy jojjon. Kulonben a lathato
 * pill „Bejövő email"-t mond, a kepernyoolvaso pedig „email_in"-t -- ket
 * kulonbozo nyelv ugyanarra az egy esemenyre.
 */
test('a "Teljes szöveg" gomb neve ugyanazt a fajta-cimket hasznalja, mint a lathato pill', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  assert.match(
    js,
    /"aria-label":\s*`\$\{e\.title \|\| esemenyFajtaCimke\(e\.kind\)\} teljes szövege`/,
    'az aria-label meg a nyers `e.kind`-ra esik vissza, mikozben a lathato pill mar magyarul ir',
  )
})
