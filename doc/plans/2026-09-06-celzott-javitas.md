# Célzott javítás kész render után — kivitelezési terv

> **Végrehajtóknak:** KÖTELEZŐ AL-SKILL: `superpowers:subagent-driven-development`
> (ajánlott) vagy `superpowers:executing-plans`. A lépések `- [ ]` jelölésűek,
> tickeld őket.

**Cél:** az operátor a kész renderre ráír, mi a baj — globálisan vagy egy
jelenetre —, és a modul csak azt javítja: nem születik terv az egész videóra,
nem indul újra a lektorálás, és nem fizetünk újra a változatlan narrációért.

**Spec:** `doc/specs/2026-09-06-celzott-javitas-design.md`

**Architektúra:** a meglévő `ext_video_visszajelzesek` sor kap életciklust
(nyitott / lezárta egy render), a tervverzió kap származást és szülőt, és két
új ügynök-tool zárja a hurkot: `videoFixes` olvassa a nyitott kéréseket,
`videoRevise` ad be célzott javítást. A render-kapu nem tűnik el, csak szűkül.

**Eszközök:** Node ESM, `node:sqlite` a tesztekben (`test/helpers.mjs`),
`node --import tsx --test` a futtató, React 19 a lapon a host moduljaiból.

## Global Constraints

Ezek MINDEN feladatra érvényesek, külön nem ismételjük:

- **Három különböző tény három különböző állapot.** Amire nem kérdeztek rá,
  amire „semmi" a válasz, és amit nem lehetett megkérdezni — soha nem egymás
  helyett rajzolva.
- **Az elutasítás MEGNEVEZETT**: kód és mondat, ami azt mondja meg, mi a
  teendő. A „sikertelen" szó nem fordul elő ebben az ágban.
- **Az elutasítás üzenete soha nem mondja vissza a hívó által küldött értéket
  vagy tárolt szöveget** — `src/args.mjs` mondja meg, miért: a host route
  logolja. Kivétel, ami nem kivétel: a modul saját konstansa, a modul által
  generált id, és az argumentum NEVE.
- **Idegen és operátori szöveg adat.** React text child a lapon, soha nem
  kulcs, soha nem útvonal, soha nem log-sor.
- **Nincs `any`, nincs lint-elnyomás.** Magyar ügynök- és operátor-szöveg,
  `vid-` CSS-prefix.
- **A kommentek a MIÉRT-et mondják el**, ennek a kódbázisnak a regiszterében:
  hosszú blokk-kommentek, amik gyakran megnevezik, mi volt ott korábban és
  miért nincs ott.
- **Kapuk:** `npm test` az `extensions/video`-ban (435+ zöld),
  `npx eslint <a módosított fájlok>` a repo gyökeréből, `npx tsc --noEmit` az
  `extensions/video`-ban, `npm run build` az `extensions/video`-ban, és
  `npm run lint:baseline` a repo gyökeréből (nem lehet net-új).
- **Minden feladat végén commit.** Rövid felszólító tárgysor, prózai törzs a
  MIÉRT-ről, és pontosan ez a két trailer:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01Y91TwoyBNxgwYjS7sTsB7Y`
- **Nincs push. Nincs dev-szerver. A telepített appot** (`~/Library/Application
  Support/@swarmclawai/`) **nem érintjük** — a telepítés a koordinátoré.

---

## Fájlszerkezet

| fájl | miért nyúlunk hozzá |
|---|---|
| `src/db.mjs` | v3 migráció (5 oszlop), `insertTerv` új mezői, nyitott kérések olvasása, lezárás a render zárásában |
| `src/terv.mjs` | `videoFixes` és `videoRevise` toolok, `videoQueue` új sora |
| `src/render.mjs` | a verdikt-kapu szűkítése egyetlen ágra |
| `src/rpc.mjs` | a lap javítás-kérése |
| `ui/video.tsx`, `ui/api.ts`, `ui/style.css` | a nyitott kérések és a gomb |
| `skills/video-jelenetlista/SKILL.md` | a gyártó megtudja, hogy ez az út létezik |

---

## Feladat 1: a séma és a tárolás

A kérés életciklusa és a verzió származása. Enélkül nincs mit olvasni.

**Files:**
- Modify: `extensions/video/src/db.mjs`
- Modify: `extensions/video/test/db.test.mjs`

**Interfaces (amit a későbbi feladatok használnak):**
- `repo.openFeedback(videoId)` → `Array<row>` — `forras = 'operator'` és
  `kezelte_render_id IS NULL`, `created_at ASC, rowid ASC` sorrendben
- `repo.insertTerv({ …, szarmazas = 'terv', javitasIdk = [], szuloTervId = null })`
  → `{ id, verzio, tervHash }` (a meglévő három mező, változatlanul)
- `repo.finishRender(id, { status, fileSha256, hibaKod, hibaSzoveg })` →
  `boolean`, változatlan aláírással; `status === 'kesz'` esetén ugyanabban a
  tranzakcióban lezárja a rendert szülő terv `javitas_idk`-jában megnevezett
  kéréseket

- [ ] **1.1 Írd meg a bukó teszteket** a `test/db.test.mjs`-be.

```js
test('a v3 migráció után a visszajelzés-sor nyitott, és egy render lezárja', () => {
  const { repo } = freshRepo()
  const { id: videoId } = repo.openVideo({ cim: 'c', forrasTipus: 'kezi', forrasId: '', forrasSzoveg: 'f', nyitottaAgentId: '' })
  const a = repo.insertFeedback({ videoId, szoveg: 'globális kérés', forras: 'operator' })
  const b = repo.insertFeedback({ videoId, jelenet: 3, szoveg: 'a 3. jelenetre', forras: 'operator' })
  const importalt = repo.insertFeedback({ videoId, szoveg: 'analitikából', forras: 'import' })

  const nyitott = repo.openFeedback(videoId)
  assert.deepEqual(nyitott.map((r) => r.id), [a.id, b.id], 'csak az operátoré kérés; az importált megfigyelés')
  assert.equal(nyitott[1].jelenet, 3)
})

test('insertTerv alapból sima terv, és megjegyzi, ha operátori javítás', () => {
  const { repo } = freshRepo()
  const { id: videoId } = repo.openVideo({ cim: 'c', forrasTipus: 'kezi', forrasId: '', forrasSzoveg: 'f', nyitottaAgentId: '' })
  const alap = { videoId, jelenetek: PELDA_JELENETEK, narracio: PELDA_NARRACIO, assetUjjlenyomatok: [], katalogusHash: 'k', szerzoAgentId: 'g', szerzoSessionId: 's', ellenorzes: {} }
  const v1 = repo.insertTerv(alap)
  assert.equal(repo.terv(v1.id).szarmazas, 'terv')
  assert.equal(repo.terv(v1.id).javitas_idk, '[]')
  assert.equal(repo.terv(v1.id).szulo_terv_id, null)

  const v2 = repo.insertTerv({ ...alap, szarmazas: 'operator_javitas', javitasIdk: ['f1', 'f2'], szuloTervId: v1.id })
  assert.equal(repo.terv(v2.id).szarmazas, 'operator_javitas')
  assert.deepEqual(JSON.parse(repo.terv(v2.id).javitas_idk), ['f1', 'f2'])
  assert.equal(repo.terv(v2.id).szulo_terv_id, v1.id)
})

test('a kész render lezárja a szülő terve által megnevezett kéréseket, egy tranzakcióban', () => {
  const { repo } = freshRepo()
  const { id: videoId } = repo.openVideo({ cim: 'c', forrasTipus: 'kezi', forrasId: '', forrasSzoveg: 'f', nyitottaAgentId: '' })
  const alap = { videoId, jelenetek: PELDA_JELENETEK, narracio: PELDA_NARRACIO, assetUjjlenyomatok: [], katalogusHash: 'k', szerzoAgentId: 'g', szerzoSessionId: 's', ellenorzes: {} }
  const v1 = repo.insertTerv(alap)
  const kert = repo.insertFeedback({ videoId, jelenet: 1, szoveg: 'ezt javítsd', forras: 'operator' })
  const marad = repo.insertFeedback({ videoId, jelenet: 2, szoveg: 'ezt nem kértem', forras: 'operator' })
  const v2 = repo.insertTerv({ ...alap, szarmazas: 'operator_javitas', javitasIdk: [kert.id], szuloTervId: v1.id })
  const verdikt = repo.insertVerdikt({ tervId: v1.id, tervHash: v1.tervHash, lektorAgentId: 'l', lektorSessionId: 's', verdikt: 'atmegy', talalatok: [] })
  repo.claimRender({ id: 'r-1', videoId, tervId: v2.id, tervHash: v2.tervHash, verdiktId: verdikt.id, hostBootAt: 1, jelenetHatarok: [], propsPath: '/p', outPath: '/o.mp4', logPath: '/l', platform: 'darwin' })

  assert.equal(repo.openFeedback(videoId).length, 2, 'amíg fut a render, mindkettő nyitott')
  assert.equal(repo.finishRender('r-1', { status: 'kesz', fileSha256: 'sha' }), true)

  const nyitott = repo.openFeedback(videoId)
  assert.deepEqual(nyitott.map((r) => r.id), [marad.id], 'csak a megnevezett zárult')
  const zart = repo.feedbackFor(videoId).find((r) => r.id === kert.id)
  assert.equal(zart.kezelte_render_id, 'r-1')
  assert.equal(typeof zart.kezelt_at, 'string')
})

test('egy hibára futott render nem zár le kérést', () => {
  const { repo } = freshRepo()
  const { id: videoId } = repo.openVideo({ cim: 'c', forrasTipus: 'kezi', forrasId: '', forrasSzoveg: 'f', nyitottaAgentId: '' })
  const alap = { videoId, jelenetek: PELDA_JELENETEK, narracio: PELDA_NARRACIO, assetUjjlenyomatok: [], katalogusHash: 'k', szerzoAgentId: 'g', szerzoSessionId: 's', ellenorzes: {} }
  const v1 = repo.insertTerv(alap)
  const kert = repo.insertFeedback({ videoId, szoveg: 'ezt javítsd', forras: 'operator' })
  const v2 = repo.insertTerv({ ...alap, szarmazas: 'operator_javitas', javitasIdk: [kert.id], szuloTervId: v1.id })
  const verdikt = repo.insertVerdikt({ tervId: v1.id, tervHash: v1.tervHash, lektorAgentId: 'l', lektorSessionId: 's', verdikt: 'atmegy', talalatok: [] })
  repo.claimRender({ id: 'r-2', videoId, tervId: v2.id, tervHash: v2.tervHash, verdiktId: verdikt.id, hostBootAt: 1, jelenetHatarok: [], propsPath: '/p', outPath: '/o.mp4', logPath: '/l', platform: 'darwin' })
  repo.finishRender('r-2', { status: 'hiba', hibaKod: 'render_kilepett' })
  assert.equal(repo.openFeedback(videoId).length, 1, 'a kérés nyitva marad')
})
```

- [ ] **1.2 Futtasd, és nézd meg, hogy BUKIK.**

Futtatás: `cd extensions/video && npx tsx --test test/db.test.mjs`
Várt: mind a négy új teszt bukik — `repo.openFeedback is not a function`, és a
`szarmazas` oszlop nem létezik.

- [ ] **1.3 Írd meg a v3 migrációt** a `MIGRATIONS` tömb végére
(`src/db.mjs`, a `version: 2` bejegyzés után). A v2 docblockja megmondja a
minta okát: a migrációk egyszer futnak, `ALTER TABLE`-lel, `IF NOT EXISTS`
nélkül — olvasd el, és írj hozzá ugyanilyen docblockot arról, miért öt oszlop
és miért két táblán.

```js
{
  version: 3,
  sql: `
ALTER TABLE ext_video_visszajelzesek ADD COLUMN kezelte_render_id TEXT;
ALTER TABLE ext_video_visszajelzesek ADD COLUMN kezelt_at TEXT;
ALTER TABLE ext_video_tervek ADD COLUMN szarmazas TEXT NOT NULL DEFAULT 'terv';
ALTER TABLE ext_video_tervek ADD COLUMN javitas_idk TEXT NOT NULL DEFAULT '[]';
ALTER TABLE ext_video_tervek ADD COLUMN szulo_terv_id TEXT;
`,
}
```

- [ ] **1.4 Bővítsd az `insertTerv`-et** (`src/db.mjs:500`). A három új
paraméter alapértéke az, ami egy mai hívásból jön ki, tehát a hét meglévő
hívóhelyet nem kell átírni.

```js
insertTerv({ videoId, jelenetek, narracio, assetUjjlenyomatok, katalogusHash, szerzoAgentId, szerzoSessionId, ellenorzes, szarmazas = 'terv', javitasIdk = [], szuloTervId = null }) {
  return S.transaction(() => {
    const prev = S.get('SELECT MAX(verzio) AS v FROM ext_video_tervek WHERE video_id = ?', [videoId]).v
    const verzio = (prev || 0) + 1
    const id = uid()
    const tervHash = tervHashOf({ jelenetek, narracio, assetUjjlenyomatok })
    S.exec('INSERT INTO ext_video_tervek (id, video_id, verzio, jelenetek, narracio, asset_ujjlenyomatok, terv_hash, katalogus_hash, szerzo_agent_id, szerzo_session_id, ellenorzes, szarmazas, javitas_idk, szulo_terv_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, videoId, verzio, JSON.stringify(jelenetek), JSON.stringify(narracio), JSON.stringify(assetUjjlenyomatok), tervHash, katalogusHash, szerzoAgentId, szerzoSessionId, JSON.stringify(ellenorzes), szarmazas, JSON.stringify(javitasIdk), szuloTervId, now()])
    return { id, verzio, tervHash }
  })
},
```

`tervHashOf` bemenete NEM változik: a hash a terv tartalmáról szól, nem arról,
ki és miért írta. Írd ezt kommentbe, mert enélkül a következő olvasó
hozzáveszi a `szarmazas`-t, és minden korábbi verdikt hash-e elavul.

- [ ] **1.5 Írd meg az `openFeedback`-et** a `feedbackFor` mellé
(`src/db.mjs:651` környéke).

```js
/**
 * A videó NYITOTT javítás-kérései: amit az operátor írt, és amit még nem
 * zárt le render.
 *
 * `forras = 'operator'` a szűrő fele, és ez a fontosabbik. Az importált sorok
 * az operátor analitikájából jönnek (`importFeedback`), és megfigyelések, nem
 * kérések: senki nem kérte, hogy javítsuk őket, és egy render lezárása
 * hazugság lenne róluk. A `feedbackFor` továbbra is mindkettőt adja, mert a
 * lap mindkettőt kirajzolja.
 */
openFeedback(videoId) {
  return S.all("SELECT * FROM ext_video_visszajelzesek WHERE video_id = ? AND forras = 'operator' AND kezelte_render_id IS NULL ORDER BY created_at ASC, rowid ASC", [videoId])
},
```

- [ ] **1.6 Zárd a kéréseket a `finishRender` tranzakciójában**
(`src/db.mjs:604`). A lezárás nem kap külön metódust: egy kész render és a
hozzá tartozó lezárás egy tény, és két hívásban a második elmaradhat.

```js
finishRender(id, { status, fileSha256 = null, hibaKod = '', hibaSzoveg = '' }) {
  if (!RENDER_ZARO_STATUSOK.includes(status)) throw new Error('finishRender: status must be kesz or hiba')
  if (status === 'kesz' && (typeof fileSha256 !== 'string' || fileSha256 === '')) throw new Error('finishRender: kesz needs the file sha256')
  if (status === 'hiba' && (typeof hibaKod !== 'string' || hibaKod === '')) throw new Error('finishRender: hiba needs a code')
  return S.transaction(() => {
    const running = S.get("SELECT id, terv_id FROM ext_video_renderek WHERE id = ? AND status = 'fut'", [id])
    if (!running) return false
    S.exec("UPDATE ext_video_renderek SET status = ?, file_sha256 = ?, hiba_kod = ?, hiba_szoveg = ?, finished_at = ? WHERE id = ? AND status = 'fut'",
      [status, fileSha256, hibaKod, hibaSzoveg, now(), id])
    // A KÉSZ render zárja a kéréseket, a hibára futó nem. Egy render, ami
    // elhasalt, semmit nem javított meg; egy lezárt kérés mögött viszont ott
    // kell álljon egy fájl, amit az operátor meg tud nézni. Ugyanabban a
    // tranzakcióban, hogy ne létezhessen kész render lezáratlan kéréssel --
    // két hívásban a második elmaradhat egy összeomlásnál.
    if (status === 'kesz') {
      const terv = S.get('SELECT javitas_idk FROM ext_video_tervek WHERE id = ?', [running.terv_id])
      for (const fid of JSON.parse(terv ? terv.javitas_idk : '[]')) {
        S.exec('UPDATE ext_video_visszajelzesek SET kezelte_render_id = ?, kezelt_at = ? WHERE id = ? AND kezelte_render_id IS NULL', [id, now(), fid])
      }
    }
    return true
  })
},
```

- [ ] **1.7 Futtasd újra: a négy tesztnek át kell mennie.**

Futtatás: `cd extensions/video && npx tsx --test test/db.test.mjs`
Várt: PASS.

- [ ] **1.8 Kapuk és commit.** Teljes suite, eslint, tsc, build, lint-baseline,
majd commit.

---

## Feladat 2: a gyártó lássa a kéréseket

Két olvasás: egy toolt, amivel egy videó kéréseit elolvassa, és egy sort a
sorban, hogy egyáltalán rátaláljon.

**Files:**
- Modify: `extensions/video/src/terv.mjs`
- Modify: `extensions/video/test/terv.test.mjs`, `test/import-time.test.mjs`

**Interfaces:**
- Consumes: `repo.openFeedback(videoId)` (1. feladat)
- Produces: `videoFixes` tool. Válasza:
  `{ videoId, cim, tervId, tervVerzio, renderId, globalis: [{ id, szoveg, atMs, at }], jelenetenkent: { "<index>": [{ id, szoveg, atMs, at }] } }`
- Produces: `videoQueue` új mezője, `javitasVar: [{ videoId, cim, tervId, tervVerzio, sajatTerv, kerdesek }]`

- [ ] **2.1 Írd meg a bukó teszteket** a `test/terv.test.mjs`-be.

```js
test('videoFixes a nyitott kéréseket adja, globálisra és jelenetre bontva', async () => {
  const { repo, run } = setup()
  const { videoId, tervId } = keszTerv(repo)
  const g = repo.insertFeedback({ videoId, szoveg: 'a vége túl hosszú', forras: 'operator' })
  const j = repo.insertFeedback({ videoId, jelenet: 2, atMs: 4200, szoveg: 'rossz a címke', forras: 'operator' })
  repo.insertFeedback({ videoId, szoveg: 'analitikából', forras: 'import' })

  const r = await run('videoFixes', { videoId })
  assert.equal(r.error, undefined)
  assert.deepEqual(r.globalis.map((x) => x.id), [g.id])
  assert.deepEqual(r.jelenetenkent['2'].map((x) => x.id), [j.id])
  assert.equal(r.jelenetenkent['2'][0].atMs, 4200)
  assert.equal(r.tervId, tervId, 'a szülő terv, amiről a kérés szól')
  assert.equal(JSON.stringify(r).includes('analitikából'), false, 'az importált sor nem kérés')
})

test('videoFixes megnevezi, ha nincs nyitott kérés — nem üres listát ad némán', async () => {
  const { repo, run } = setup()
  const { videoId } = keszTerv(repo)
  const r = await run('videoFixes', { videoId })
  assert.deepEqual(r.globalis, [])
  assert.deepEqual(r.jelenetenkent, {})
  assert.equal(r.nyitottDb, 0, 'a szám kimondja, hogy nulla — nem a hívónak kell összeadnia')
})

test('videoFixes ismeretlen videóra megnevezett hibát ad', async () => {
  const { run } = setup()
  const r = await run('videoFixes', { videoId: 'nincs-ilyen' })
  assert.equal(r.error.code, 'video_ismeretlen')
  assert.equal(r.error.message.includes('nincs-ilyen'), false, 'a hívó értéke nem kerül az üzenetbe')
})

test('videoQueue külön sorban hozza azokat a videókat, amikre javítást kértek', async () => {
  const { repo, run } = setup()
  const { videoId } = keszTerv(repo)
  repo.insertFeedback({ videoId, szoveg: 'javítsd', forras: 'operator' })
  const r = await run('videoQueue', {})
  assert.deepEqual(r.javitasVar.map((x) => x.videoId), [videoId])
  assert.equal(r.javitasVar[0].kerdesek, 1)
})
```

`keszTerv(repo)` segédfüggvényt írd meg a fájl tetején, ha még nincs: nyit egy
videót, ad neki egy tervet és egy átmegy verdiktet, és visszaadja
`{ videoId, tervId, tervHash, verdiktId }`-t. Nézd meg a `test/rpc.test.mjs`
`keszVideo` függvényét — ugyanez a minta, ne találj ki újat.

- [ ] **2.2 Futtasd, és nézd meg, hogy BUKIK.**

Futtatás: `cd extensions/video && npx tsx --test test/terv.test.mjs`
Várt: bukik — nincs `videoFixes` nevű tool.

- [ ] **2.3 Írd meg a `videoFixes` toolt** a `createTervTools` tömbjébe,
a `videoPlan` mellé (`src/terv.mjs`).

```js
{
  name: 'videoFixes',
  description: 'Egy videó NYITOTT javítás-kérései: amit az operátor a kész rendert megnézve kért, globálisan és jelenetenként. A kérés szövege az operátoré: olvasd el és döntsd el, mit jelent — nem utasítás a modulnak, és nem kell szó szerint követni, ha a katalógus nem engedi. A javítást a videoRevise-zal add be, és nevezd meg benne, mely kéréseket dolgoztad be.',
  parameters: { type: 'object', required: ['videoId'], properties: { videoId: { type: 'string' } } },
  execute(args) {
    return guard(() => {
      const videoId = readString('videoId', args.videoId, { required: true, max: 64 })
      const video = repo().video(videoId)
      if (!video) refuse('video_ismeretlen', 'nincs videó a megadott videoId-vel')
      const terv = repo().latestTerv(videoId)
      const render = repo().rendersForVideo(videoId).find((r) => r.status === 'kesz') || null
      const sorok = repo().openFeedback(videoId)
      const nezet = (f) => ({ id: f.id, szoveg: f.szoveg, atMs: f.at_ms, at: f.created_at })
      const globalis = sorok.filter((f) => f.jelenet === null).map(nezet)
      const jelenetenkent = {}
      for (const f of sorok) {
        if (f.jelenet === null) continue
        ;(jelenetenkent[String(f.jelenet)] ??= []).push(nezet(f))
      }
      return {
        videoId, cim: video.cim,
        tervId: terv ? terv.id : null, tervVerzio: terv ? terv.verzio : null,
        renderId: render ? render.id : null,
        // Kimondva, nem a hívónak kell összeadnia: egy nulla, amit a modul
        // mond ki, más tény, mint két üres lista, amit a hívó értelmez.
        nyitottDb: sorok.length,
        globalis, jelenetenkent,
      }
    })
  },
},
```

A `jelenetenkent` kulcsai `Object.create(null)` helyett sima objektumon
ülnek — de a kulcs egy egész szám szövegként, a tábla `jelenet` oszlopából,
amit `optionalWhole` 0..200 közé szorított. Írd ezt kommentbe, mert a
`board`-nál (`src/rpc.mjs`) ugyanez a kérdés null-prototípust követelt, és a
következő olvasó jogosan kérdezi meg, miért nem itt.

- [ ] **2.4 Told ki a `videoQueue`-t** egy új sorral. A `videoQueue` execute-ja
(`src/terv.mjs:380` környéke) ma `elbukott` és `renderHiba` sorokat épít —
ugyanabban a mintában:

```js
const javitasVar = repo().videos()
  .map((v) => ({ v, nyitott: repo().openFeedback(v.id) }))
  .filter(({ v, nyitott }) => nyitott.length > 0 && v.status !== 'lezart')
  .map(({ v, nyitott }) => ({ ...entry(v), kerdesek: nyitott.length }))
```

és vedd bele a válaszba. A `videoQueue` leírását is bővítsd: ma nem tud a
javításról, és egy ügynök, ami csak a leírást olvassa, nem fogja megkeresni.

- [ ] **2.5 Vedd fel a toolt az `import-time` pinbe.** A
`test/import-time.test.mjs` kiírja a toolok teljes, rendezett listáját —
`videoFixes` oda is kell, különben a suite bukik.

- [ ] **2.6 Futtasd: a négy tesztnek át kell mennie.**

Futtatás: `cd extensions/video && npx tsx --test test/terv.test.mjs test/import-time.test.mjs`
Várt: PASS.

- [ ] **2.7 Kapuk és commit.**

---

## Feladat 3: `videoRevise` — a kapu, ami miatt ez működik

Ez a feladat gerince. A gyártó megnevezi, mit ír át; a modul ellenőrzi, hogy
mást nem írt át.

**Files:**
- Modify: `extensions/video/src/terv.mjs`
- Modify: `extensions/video/skills/video-jelenetlista/SKILL.md`
- Modify: `extensions/video/test/terv.test.mjs`, `test/import-time.test.mjs`

**Interfaces:**
- Consumes: `repo.insertTerv({ …, szarmazas, javitasIdk, szuloTervId })` (1. feladat),
  `repo.openFeedback(videoId)` (1. feladat)
- Produces: `videoRevise` tool. Válasza:
  `{ tervId, verzio, tervHash, szuloTervId, valtozottJelenetek: [index], bedolgozott: [id], figyelmeztetesek: [], becsultHosszMp }`

- [ ] **3.1 Írd meg a bukó teszteket.**

```js
test('videoRevise csak a megnevezett jeleneteket írja át, a többit bájtra átveszi', async () => {
  const { repo, run } = setup()
  const { videoId, tervId } = keszTerv(repo)
  const kert = repo.insertFeedback({ videoId, jelenet: 1, szoveg: 'más szám kell', forras: 'operator' })
  const eredeti = JSON.parse(repo.terv(tervId).jelenetek)

  const r = await run('videoRevise', {
    videoId,
    jelenetek: [{ index: 1, jelenet: { tipus: 'szam', szam: 99, felvezeto: 'Ennyi.' } }],
    javitasIdk: [kert.id],
  })
  assert.equal(r.error, undefined)
  assert.deepEqual(r.valtozottJelenetek, [1])
  assert.deepEqual(r.bedolgozott, [kert.id])
  assert.equal(r.szuloTervId, tervId)

  const uj = JSON.parse(repo.terv(r.tervId).jelenetek)
  assert.equal(uj[1].szam, 99)
  assert.deepEqual(uj[0], eredeti[0], 'a 0. jelenet bájtra ugyanaz')
  assert.deepEqual(uj[2], eredeti[2], 'a 2. jelenet bájtra ugyanaz')
  assert.equal(repo.terv(r.tervId).szarmazas, 'operator_javitas')
})

test('videoRevise a narrációt is csak a megnevezett jeleneten engedi', async () => {
  const { repo, run } = setup()
  const { videoId, tervId } = keszTerv(repo)
  const kert = repo.insertFeedback({ videoId, jelenet: 1, szoveg: 'más mondat', forras: 'operator' })
  const r = await run('videoRevise', {
    videoId,
    jelenetek: [{ index: 1, jelenet: { tipus: 'szam', szam: 40, felvezeto: 'Ennyi.' } }],
    narracio: [{ jelenet: 1, szoveg: 'Új mondat.' }],
    javitasIdk: [kert.id],
  })
  const n = JSON.parse(repo.terv(r.tervId).narracio)
  assert.equal(n.find((x) => x.jelenet === 1).szoveg, 'Új mondat.')
  const eredetiN = JSON.parse(repo.terv(tervId).narracio)
  assert.equal(n.find((x) => x.jelenet === 0).szoveg, eredetiN.find((x) => x.jelenet === 0).szoveg)
})

test('videoRevise elutasítja a nem megnevezett jelenet narrációjának átírását', async () => {
  const { repo, run } = setup()
  const { videoId } = keszTerv(repo)
  const kert = repo.insertFeedback({ videoId, jelenet: 1, szoveg: 'x', forras: 'operator' })
  const r = await run('videoRevise', {
    videoId,
    jelenetek: [{ index: 1, jelenet: { tipus: 'szam', szam: 40, felvezeto: 'Ennyi.' } }],
    narracio: [{ jelenet: 2, szoveg: 'ehhez nem nyúlhatsz' }],
    javitasIdk: [kert.id],
  })
  assert.equal(r.error.code, 'erintetlen_jelenet_valtozott')
  assert.equal(r.error.jelenet, 2)
})

test('videoRevise megnevezetlen kérésre nem indul', async () => {
  const { repo, run } = setup()
  const { videoId } = keszTerv(repo)
  const r = await run('videoRevise', { videoId, jelenetek: [{ index: 1, jelenet: { tipus: 'szam', szam: 1, felvezeto: 'a' } }], javitasIdk: [] })
  assert.equal(r.error.code, 'javitas_hianyzik')
})

test('videoRevise idegen vagy már lezárt kérésre megnevezett hibát ad', async () => {
  const { repo, run } = setup()
  const { videoId } = keszTerv(repo)
  const r = await run('videoRevise', { videoId, jelenetek: [{ index: 1, jelenet: { tipus: 'szam', szam: 1, felvezeto: 'a' } }], javitasIdk: ['nincs-ilyen'] })
  assert.equal(r.error.code, 'javitas_ismeretlen')
  assert.equal(r.error.message.includes('nincs-ilyen'), false)
})

test('videoRevise terv nélküli videóra megnevezett hibát ad, nem üres tervet ír', async () => {
  const { repo, run } = setup()
  const { id: videoId } = repo.openVideo({ cim: 'c', forrasTipus: 'kezi', forrasId: '', forrasSzoveg: 'f', nyitottaAgentId: '' })
  const kert = repo.insertFeedback({ videoId, szoveg: 'x', forras: 'operator' })
  const r = await run('videoRevise', { videoId, jelenetek: [{ index: 0, jelenet: { tipus: 'szam', szam: 1, felvezeto: 'a' } }], javitasIdk: [kert.id] })
  assert.equal(r.error.code, 'terv_hianyzik')
})

test('videoRevise a katalógus-ellenőrzésen ugyanúgy átmegy, mint a videoDraft', async () => {
  const { repo, run } = setup()
  const { videoId } = keszTerv(repo)
  const kert = repo.insertFeedback({ videoId, jelenet: 1, szoveg: 'x', forras: 'operator' })
  const r = await run('videoRevise', {
    videoId,
    jelenetek: [{ index: 1, jelenet: { tipus: 'nincs-ilyen-tipus', valami: 1 } }],
    javitasIdk: [kert.id],
  })
  assert.equal(r.error.code, 'tipus_ismeretlen')
})
```

- [ ] **3.2 Futtasd, és nézd meg, hogy BUKIK.**

Futtatás: `cd extensions/video && npx tsx --test test/terv.test.mjs`
Várt: bukik — nincs `videoRevise` nevű tool.

- [ ] **3.3 Vedd fel a hiányzó importot.** A `src/terv.mjs` első sora ma:

```js
import { agentIdOf, guard, readArray, readEnum, readString, refuse, sessionIdOf } from './args.mjs'
```

`readWholeNumber` nincs benne, és a `videoRevise` használja. Egészítsd ki:

```js
import { agentIdOf, guard, readArray, readEnum, readString, readWholeNumber, refuse, sessionIdOf } from './args.mjs'
```

- [ ] **3.4 Írd meg a `videoRevise` toolt.** A törzs a szülő verzióból másol,
és a `validateDraft`-on megy át — ugyanazon, mint a `videoDraft`, hogy ne
keletkezzen második, lazább út a katalógus-ellenőrzés mellett.

```js
{
  name: 'videoRevise',
  description: 'Célzott javítás egy kész render után: megnevezed, mely jeleneteket írod át és mely operátori kéréseket dolgozod be, és a modul MINDEN MÁS jelenetet változatlanul vesz át a szülő verzióból. Ha olyanhoz nyúlsz, amiről nem esett szó, a beadás elutasul. A narrációt is csak a megnevezett jeleneteken írhatod át — így a többi mondat a tts gyorsítótárából jön, és nem kerül újra pénzbe. Erre a verzióra nem kell új lektori ítélet: a szülő verzió átment, és a különbséget az operátor kérte.',
  parameters: {
    type: 'object',
    required: ['videoId', 'jelenetek', 'javitasIdk'],
    properties: {
      videoId: { type: 'string' },
      jelenetek: { type: 'array', items: { type: 'object', properties: { index: { type: 'integer' }, jelenet: { type: 'object' } } } },
      narracio: { type: 'array', items: { type: 'object', properties: { jelenet: { type: 'integer' }, szoveg: { type: 'string' } } } },
      javitasIdk: { type: 'array', items: { type: 'string' } },
    },
  },
  execute(args, ctx) {
    return guard(() => {
      const agentId = agentIdOf(ctx)
      if (agentId === '') refuse('agent_hianyzik', 'a session ügynök nélkül fut; a terv szerzőjére kapu épül, ezért ügynök kell')
      const videoId = readString('videoId', args.videoId, { required: true, max: 64 })
      const video = repo().video(videoId)
      if (!video) refuse('video_ismeretlen', 'nincs videó a megadott videoId-vel')
      if (video.status === 'lezart') refuse('video_lezart', 'a videó le van zárva')
      refuseIfRendering(videoId)
      const szulo = repo().latestTerv(videoId)
      if (!szulo) refuse('terv_hianyzik', 'ennek a videónak még nincs terve; javítani csak meglévő tervet lehet')

      // A kérések a mi soraink, nem a hívó szava: a megnevezett id-knek
      // NYITOTT, ehhez a videóhoz tartozó operátori kérésnek kell lenniük.
      // Egy lezárt kérés újra-bedolgozása azt jelentené, hogy egy render már
      // megszületett rá; egy másik videóé pedig hazugság lenne mindkettőről.
      const javitasIdk = readArray('javitasIdk', args.javitasIdk, { required: true, max: 50 })
      if (javitasIdk.length === 0) refuse('javitas_hianyzik', 'nevezd meg, mely kéréseket dolgozod be; javítás kérés nélkül nem célzott javítás, hanem új terv')
      const nyitottak = new Set(repo().openFeedback(videoId).map((f) => f.id))
      for (const id of javitasIdk) {
        if (typeof id !== 'string' || !nyitottak.has(id)) refuse('javitas_ismeretlen', 'a megnevezett kérések egyike nem ennek a videónak a nyitott kérése')
      }

      const eredetiJelenetek = JSON.parse(szulo.jelenetek)
      const eredetiNarracio = JSON.parse(szulo.narracio)
      const valtoztatasok = readArray('jelenetek', args.jelenetek, { required: true, max: 60 })
      if (valtoztatasok.length === 0) refuse('argumentum_hibas', 'jelenetek: legalább egy átírt jelenet kell')

      const valtozott = new Set()
      const jelenetek = eredetiJelenetek.slice()
      for (const v of valtoztatasok) {
        const index = readWholeNumber('jelenetek[].index', v && v.index, { min: 0, max: eredetiJelenetek.length - 1 })
        if (!v.jelenet || typeof v.jelenet !== 'object' || Array.isArray(v.jelenet)) refuse('argumentum_hibas', 'jelenetek[].jelenet: a jelenet teljes objektuma kell, nem folt')
        if (valtozott.has(index)) refuse('argumentum_hibas', 'jelenetek: ugyanazt az indexet kétszer nevezted meg')
        valtozott.add(index)
        jelenetek[index] = v.jelenet
      }

      // A narráció csak a megnevezett jeleneteken mozdulhat. Ez a kapu fele:
      // a másik fele az, hogy a jelenet-lista a szülőből másolódik, tehát egy
      // meg nem nevezett jelenet nem is TUD megváltozni. A narrációnál viszont
      // a hívó egy listát küld, és abban bármelyik indexre írhatna.
      const narracio = eredetiNarracio.map((n) => ({ ...n }))
      for (const n of readArray('narracio', args.narracio, { max: 60 }) ?? []) {
        const jelenet = readWholeNumber('narracio[].jelenet', n && n.jelenet, { min: 0, max: eredetiJelenetek.length - 1 })
        if (!valtozott.has(jelenet)) refuse('erintetlen_jelenet_valtozott', 'olyan jelenet narrációját írnád át, amit nem neveztél meg a jelenetek közt', { jelenet })
        const szoveg = readString('narracio[].szoveg', n.szoveg, { required: true, max: 4000 })
        const sor = narracio.find((x) => x.jelenet === jelenet)
        if (!sor) refuse('argumentum_hibas', 'narracio[].jelenet: ehhez a jelenethez nincs mondat a szülő tervben')
        sor.szoveg = szoveg
      }

      const remotionDir = remotionDirOf(state)
      const katalogus = readCatalog(remotionDir)
      const r = validateDraft({ jelenetek, narracio, katalogus, remotionDir, karakterPerMp: karakterPerMp(repo()) })
      if (r.refusal) refuse(r.refusal.code, r.refusal.message)
      const becsultHosszMp = Number(r.becsultHosszMp.toFixed(1))
      const terv = repo().insertTerv({
        videoId, jelenetek, narracio, assetUjjlenyomatok: r.assetUjjlenyomatok, katalogusHash: katalogus.katalogusHash,
        szerzoAgentId: agentId, szerzoSessionId: sessionIdOf(ctx),
        ellenorzes: { figyelmeztetesek: r.figyelmeztetesek, becsultHosszMp },
        szarmazas: 'operator_javitas', javitasIdk, szuloTervId: szulo.id,
      })
      repo().rememberAgent(agentId, 'gyarto')
      // NEM `terv` státusz: a videoDraft azért teszi vissza lektorálásra, mert
      // ott új terv született, amit senki nem látott. Itt a szülő átment, és a
      // különbséget az operátor kérte -- a következő lépés a render, nem a
      // lektor. A státusz `narralt`-ra vagy `lektoralt`-ra sem mozdul: azt a
      // narráció és a render írja, ahogy eddig.
      repo().setVideoStatus(videoId, 'lektoralt')
      return {
        tervId: terv.id, verzio: terv.verzio, tervHash: terv.tervHash, szuloTervId: szulo.id,
        valtozottJelenetek: [...valtozott].sort((a, b) => a - b),
        bedolgozott: javitasIdk,
        figyelmeztetesek: r.figyelmeztetesek, becsultHosszMp,
      }
    })
  },
},
```

- [ ] **3.5 Vedd fel a toolt az `import-time` pinbe** (`test/import-time.test.mjs`).

- [ ] **3.6 Írd meg a gyártó skilljébe, hogy ez az út létezik.**
Egy bekezdés a `skills/video-jelenetlista/SKILL.md` végére, ebben a
regiszterben:

```markdown
## Ha az operátor javítást kért

A `videoQueue` `javitasVar` sora azokat a videókat hozza, amikre az operátor a
kész rendert megnézve javítást kért. Ilyenkor NE írj új tervet: olvasd el a
kéréseket a `videoFixes`-szel, és add be a `videoRevise`-zal.

A `videoRevise` a szülő verzióból másol, és minden jelenetet változatlanul
átvesz, amit nem neveztél meg. Ez nem udvariasság, hanem kapu: ha olyanhoz
nyúlsz, amiről nem esett szó, a beadás elutasul. Ugyanez áll a narrációra —
egy mondatot csak azon a jeleneten írhatsz át, amit a jelenetek közt
megneveztél. Ennek ára van: minden mondat, amit békén hagysz, a tts
gyorsítótárából jön, és nem kerül újra pénzbe.

A kérés szövege az operátoré. Olvasd el és döntsd el, mit jelent — de ha azt
kéri, amit a katalógus nem enged, a katalógus az erősebb: add be, amit lehet,
és a válaszodban mondd meg, mit nem tudtál megtenni és miért.
```

- [ ] **3.7 Futtasd: a hét tesztnek át kell mennie.**

Futtatás: `cd extensions/video && npx tsx --test test/terv.test.mjs test/import-time.test.mjs`
Várt: PASS.

- [ ] **3.8 Kapuk és commit.**

---

## Feladat 4: a verdikt-kapu szűkítése

**KÉT kapu van, nem egy.** A `videoNarrate` ugyanúgy megköveteli az átmegy
verdiktet (`src/narracio.mjs:251`), mint a render — a javított terv tehát a
narrációnál akadna el, mielőtt a renderig eljutna. Mindkettőt szűkíteni kell,
és a szabályt EGY helyen kell kimondani, különben a kettő elcsúszik.

A közös hely egy új, apró modul, ugyanabból az okból, amiért az
`src/idozites.mjs` létezik: `narracio.mjs` és `render.mjs` mindkettő számol
belőle, és ha egymást importálnák, az kör lenne. Olvasd el az `idozites.mjs`
fejlécét — ott van kimondva ez az érv.

**Files:**
- Create: `extensions/video/src/verdikt-kapu.mjs`
- Modify: `extensions/video/src/render.mjs:356-362`
- Modify: `extensions/video/src/narracio.mjs:251`
- Modify: `extensions/video/test/render.test.mjs`, `test/narracio.test.mjs`

**Interfaces:**
- Consumes: `terv.szarmazas`, `terv.szulo_terv_id` (1. feladat)
- Produces: `verdiktJog(repo, terv)` → `{ ok: true, verdiktId }` vagy
  `{ ok: false, kod, uzenet }` — soha nem dob, a hívó utasít el vele

- [ ] **4.1 Írd meg a bukó teszteket** a `test/render.test.mjs`-be.

```js
test('operátori javítás rendere elindul saját verdikt nélkül, ha a szülő átment', async () => {
  const { repo, ops } = setup()
  const { videoId, tervId, tervHash } = keszTervVerdikttel(repo)
  const kert = repo.insertFeedback({ videoId, jelenet: 1, szoveg: 'x', forras: 'operator' })
  const v2 = repo.insertTerv({ videoId, jelenetek: PELDA_JELENETEK, narracio: PELDA_NARRACIO, assetUjjlenyomatok: [], katalogusHash: 'k', szerzoAgentId: 'g', szerzoSessionId: 's', ellenorzes: {}, szarmazas: 'operator_javitas', javitasIdk: [kert.id], szuloTervId: tervId })
  narraciotIr(repo, v2)
  const r = await ops.start(v2.id)
  assert.equal(r.status, 'fut')
})

test('operátori javítás rendere NEM indul, ha a szülő nem ment át', async () => {
  const { repo, ops } = setup()
  const { videoId, tervId } = keszTervVerdiktNelkul(repo)
  const kert = repo.insertFeedback({ videoId, szoveg: 'x', forras: 'operator' })
  const v2 = repo.insertTerv({ videoId, jelenetek: PELDA_JELENETEK, narracio: PELDA_NARRACIO, assetUjjlenyomatok: [], katalogusHash: 'k', szerzoAgentId: 'g', szerzoSessionId: 's', ellenorzes: {}, szarmazas: 'operator_javitas', javitasIdk: [kert.id], szuloTervId: tervId })
  narraciotIr(repo, v2)
  const err = await ops.start(v2.id).then(() => null, (e) => e)
  assert.equal(err.code, 'szulo_verdikt_hianyzik')
})

test('ügynök által magától írt terv rendere továbbra is verdiktet követel', async () => {
  const { repo, ops } = setup()
  const { videoId } = keszTervVerdiktNelkul(repo)
  const v = repo.latestTerv(videoId)
  narraciotIr(repo, { id: v.id, tervHash: v.terv_hash })
  const err = await ops.start(v.id).then(() => null, (e) => e)
  assert.equal(err.code, 'verdikt_hianyzik', 'a kapu nem tűnt el')
})
```

A három segédfüggvényt (`keszTervVerdikttel`, `keszTervVerdiktNelkul`,
`narraciotIr`) a `test/render.test.mjs` meglévő setup-mintájából építsd —
olvasd el a fájl tetejét, és ne találj ki új harmadik harnesst.

- [ ] **4.2 Futtasd, és nézd meg, hogy BUKIK.**

Futtatás: `cd extensions/video && npx tsx --test test/render.test.mjs`
Várt: az első két teszt bukik (`verdikt_hianyzik`-ot kap `fut` helyett,
illetve `verdikt_hianyzik`-ot `szulo_verdikt_hianyzik` helyett).

- [ ] **4.3 Írd meg a közös szabályt** a `src/verdikt-kapu.mjs`-be.

```js
/**
 * Van-e ennek a tervnek joga továbbmenni a narrációra és a renderre.
 *
 * KÉT HÍVÓJA VAN, ÉS EZÉRT VAN KÜLÖN FÁJLBAN. A `videoNarrate` és a render
 * ugyanazt a kérdést teszi fel, és ha külön mondanák ki, elcsúsznának: egy
 * javítás, amit a narráció beenged és a render nem, egy kifizetett hangfájl
 * egy videóhoz, ami soha nem készül el. A két modul egymást nem importálhatja
 * (kör lenne), ahogy az `idozites.mjs` fejléce is elmagyarázza a maga
 * számaira.
 *
 * NEM DOB. A két hívó elutasítási alakja különbözik -- az egyik `refuse`, a
 * másik ugyanaz más kóddal --, és egy dobás itt elvenné tőlük a döntést.
 *
 * A SZABÁLY. Alapesetben a tervnek magának kell átmegy verdiktet felmutatnia
 * a JELENLEGI hash-sel. Az egyetlen kivétel az operátor által kért, célzott
 * javítás: ott a szülő verzió verdiktje áll, mert a különbséget az operátor
 * nevezte meg és ő nézi meg. A származás nem ad jogot, csak örököl egyet --
 * ezért kell a szülőnek átmennie.
 */
export function verdiktJog(repo, terv) {
  if (terv.szarmazas === 'operator_javitas') {
    const szulo = terv.szulo_terv_id ? repo.terv(terv.szulo_terv_id) : null
    const verdikt = szulo ? repo.passingVerdikt(szulo.id, szulo.terv_hash) : null
    if (!verdikt) return { ok: false, kod: 'szulo_verdikt_hianyzik', uzenet: 'ez operátori javítás, de a szülő tervre nincs érvényes atmegy verdikt; előbb azt kell lektorálni' }
    return { ok: true, verdiktId: verdikt.id }
  }
  const verdikt = repo.passingVerdikt(terv.id, terv.terv_hash)
  if (verdikt) return { ok: true, verdiktId: verdikt.id }
  const masHash = repo.verdiktek(terv.id).some((v) => v.verdikt === 'atmegy')
  return masHash
    ? { ok: false, kod: 'verdikt_elavult', uzenet: 'van atmegy verdikt erre a tervre, de más hash-sel; a lektornak újra kell néznie' }
    : { ok: false, kod: 'verdikt_hianyzik', uzenet: 'erre a tervre nincs atmegy verdikt' }
}
```

- [ ] **4.4 Cseréld le a render ágát** (`src/render.mjs:356-362`). A hat sor
helyére:

```js
    // A KAPU SZŰKÍTÉSE, NEM A LEBONTÁSA. A szabály a verdikt-kapu.mjs-ben áll,
    // mert a narráció ugyanezt kérdezi, és a kettő elcsúszása egy kifizetett
    // hangfájl egy videóhoz, ami soha nem készül el.
    const jog = verdiktJog(repo(), terv)
    if (!jog.ok) refuse(jog.kod, jog.uzenet)
    const verdikt = { id: jog.verdiktId }
```

A `verdikt` változót lentebb a `claimRender` használja (`verdiktId: verdikt.id`);
az `{ id: jog.verdiktId }` alak azért kell, hogy a hívóhely változatlan
maradjon. Ha a `verdikt` bármi másra is használva van, vezesd át rendesen —
nézd meg a `start()` további sorait.

Az importot is vedd fel a `src/render.mjs` tetejére:

```js
import { verdiktJog } from './verdikt-kapu.mjs'
```

- [ ] **4.5 Cseréld le a narráció ágát** (`src/narracio.mjs:251`):

```js
  const jog = verdiktJog(repo, terv)
  if (!jog.ok) refuse(jog.kod, jog.uzenet)
```

és az import a `src/narracio.mjs` tetejére:

```js
import { verdiktJog } from './verdikt-kapu.mjs'
```

- [ ] **4.6 Írj tesztet a narráció oldalára is**, a
`test/narracio.test.mjs` meglévő `setup()`-jával:

```js
test('operátori javítás narrációja elindul saját verdikt nélkül, ha a szülő átment', async () => {
  const { repo, terv, pass, run } = setup({ tts: ttsDouble() })
  pass()
  const kert = repo.insertFeedback({ videoId: terv.videoId ?? repo.terv(terv.id).video_id, szoveg: 'x', forras: 'operator' })
  const v2 = repo.insertTerv({ videoId: repo.terv(terv.id).video_id, jelenetek: JSON.parse(repo.terv(terv.id).jelenetek), narracio: JSON.parse(repo.terv(terv.id).narracio), assetUjjlenyomatok: [], katalogusHash: 'k', szerzoAgentId: 'g', szerzoSessionId: 's', ellenorzes: {}, szarmazas: 'operator_javitas', javitasIdk: [kert.id], szuloTervId: terv.id })
  const r = await run({ tervId: v2.id })
  assert.equal(r.error, undefined, 'a szülő verdiktje elég')
})

test('operátori javítás narrációja NEM indul, ha a szülő sem ment át', async () => {
  const { repo, terv, run } = setup({ tts: ttsDouble() })
  const kert = repo.insertFeedback({ videoId: repo.terv(terv.id).video_id, szoveg: 'x', forras: 'operator' })
  const v2 = repo.insertTerv({ videoId: repo.terv(terv.id).video_id, jelenetek: JSON.parse(repo.terv(terv.id).jelenetek), narracio: JSON.parse(repo.terv(terv.id).narracio), assetUjjlenyomatok: [], katalogusHash: 'k', szerzoAgentId: 'g', szerzoSessionId: 's', ellenorzes: {}, szarmazas: 'operator_javitas', javitasIdk: [kert.id], szuloTervId: terv.id })
  const r = await run({ tervId: v2.id })
  assert.equal(r.error.code, 'szulo_verdikt_hianyzik')
})
```

A `ttsDouble()`-t a `test/narracio.test.mjs` már definiálja a fájl tetején —
használd azt, ne írj újat.

```js
    // A KAPU SZŰKÍTÉSE, NEM A LEBONTÁSA.
    //
    // Ez a hat sor alatt álló ellenőrzés az, ami miatt nem megy ki forrás
    // nélküli állítás: az első éles futáson kétszer fogta meg. Marad
    // mindenre, amit ügynök írt magától.
    //
    // Az egyetlen kivétel az operátor által kért, célzott javítás. Ott a
    // jogosultság az operátoré: ő nevezte meg, mi változzon (a
    // `videoRevise` kapuja garantálja, hogy más nem változott), és ő nézi
    // meg az eredményt. A lektort nem azért hagyjuk ki, mert gyorsabb,
    // hanem mert egy már átment tervhez képest az operátor saját kérése az,
    // ami változott -- azon nincs mit lektorálni, ami ne az ő döntése lenne.
    //
    // A szülő verzió átmenetele viszont KELL. Egy javítás egy soha nem
    // lektorált terven ugyanúgy kerülhetne ki ellenőrzés nélkül, mint egy
    // friss terv; a származás nem ad jogot, csak örököl egyet.
    if (terv.szarmazas === 'operator_javitas') {
      const szulo = terv.szulo_terv_id ? repo().terv(terv.szulo_terv_id) : null
      if (!szulo || !repo().passingVerdikt(szulo.id, szulo.terv_hash)) {
        refuse('szulo_verdikt_hianyzik', 'ez operátori javítás, de a szülő tervre nincs érvényes atmegy verdikt; előbb azt kell lektorálni')
      }
    } else {
      const verdikt = repo().passingVerdikt(terv.id, terv.terv_hash)
      if (!verdikt) {
        const masHash = repo().verdiktek(terv.id).some((v) => v.verdikt === 'atmegy')
        refuse(masHash ? 'verdikt_elavult' : 'verdikt_hianyzik', masHash ? 'van atmegy verdikt erre a tervre, de más hash-sel; a lektornak újra kell néznie' : 'erre a tervre nincs atmegy verdikt')
      }
    }
```

**Figyelem:** a `claimRender` ma `verdiktId`-t vár. Egy operátori javításnál a
szülő verdiktjének id-je megy be — az az ítélet, amire a render támaszkodik.
Nézd meg a `claimRender` hívását lentebb, és vezesd át a változót úgy, hogy
mindkét ágon legyen értéke.

- [ ] **4.7 Futtasd: mind az öt tesztnek át kell mennie.**

Futtatás: `cd extensions/video && npx tsx --test test/render.test.mjs test/narracio.test.mjs`
Várt: PASS.

- [ ] **4.8 Kapuk és commit.**

---

## Feladat 5: a lap

A nyitott kérések láthatók, és egy gomb megrendeli a javítást.

**Files:**
- Modify: `extensions/video/src/rpc.mjs`
- Modify: `extensions/video/ui/video.tsx`, `ui/api.ts`, `ui/style.css`
- Modify: `extensions/video/test/rpc.test.mjs`, `test/ui.test.mjs`,
  `test/import-time.test.mjs`

**Interfaces:**
- Consumes: `repo.openFeedback(videoId)` (1. feladat), a Task 2-ben megépített
  `rendelj({ agentNev, uzenet, sessionNev })` (`ui/megrendeles.ts`)
- Produces: `rpc.video` válasza egy új mezővel:
  `visszajelzesek[].kezelteRenderId: string | null`

- [ ] **5.1 Írd meg a bukó rpc-tesztet.**

```js
test('a video válasza megmondja, melyik kérést zárta le melyik render', async () => {
  const { repo, rpc } = setup()
  const { videoId, renderId } = keszVideo(repo)
  const nyitott = repo.insertFeedback({ videoId, szoveg: 'nyitott kérés', forras: 'operator' })
  const zart = repo.insertFeedback({ videoId, jelenet: 1, szoveg: 'lezárt kérés', forras: 'operator' })
  repo.storage.exec('UPDATE ext_video_visszajelzesek SET kezelte_render_id = ?, kezelt_at = ? WHERE id = ?', [renderId, new Date().toISOString(), zart.id])

  const v = await rpc.video({ id: videoId })
  const byId = new Map(v.visszajelzesek.map((f) => [f.id, f]))
  assert.equal(byId.get(nyitott.id).kezelteRenderId, null)
  assert.equal(byId.get(zart.id).kezelteRenderId, renderId)
})
```

- [ ] **5.2 Futtasd, és nézd meg, hogy BUKIK.**

Futtatás: `cd extensions/video && npx tsx --test test/rpc.test.mjs`
Várt: bukik — `kezelteRenderId` `undefined`.

- [ ] **5.3 Told ki az rpc `video` válaszát** (`src/rpc.mjs:343`):

```js
visszajelzesek: repo().feedbackFor(v.id).map((f) => ({ id: f.id, renderId: f.render_id, atMs: f.at_ms, jelenet: f.jelenet, szoveg: f.szoveg, forras: f.forras, at: f.created_at, kezelteRenderId: f.kezelte_render_id, kezeltAt: f.kezelt_at })),
```

- [ ] **5.4 Írd meg a lap tesztjeit** a `test/ui.test.mjs`-be, a meglévő
`mount` / `stubRpc` / `settle` harnesszel — NE építs másodikat.

```js
test('a nyitott kérés a lezárttól külön látszik, és megnevezi a rendert, ami lezárta', () => {
  const video = videoDetail({
    visszajelzesek: [
      { id: 'f1', renderId: 'r-1', atMs: null, jelenet: null, szoveg: 'nyitott globális', forras: 'operator', at: '2026-09-06T10:00:00.000Z', kezelteRenderId: null, kezeltAt: null },
      { id: 'f2', renderId: 'r-1', atMs: 4200, jelenet: 2, szoveg: 'lezárt jelenetre', forras: 'operator', at: '2026-09-06T10:01:00.000Z', kezelteRenderId: 'r-2', kezeltAt: '2026-09-06T11:00:00.000Z' },
    ],
  })
  const html = renderBody(video)
  assert.ok(html.includes('nyitott globális'))
  assert.ok(html.includes('lezárt jelenetre'))
  assert.ok(/r-2/.test(html), 'a lezáró render meg van nevezve')
})

test('a Javítás kérése gomb sötét, ha nincs nyitott kérés, és megmondja miért', () => {
  const html = renderBody(videoDetail({ visszajelzesek: [] }))
  assert.ok(/<button[^>]*disabled[^>]*>Javítás kérése/.test(html))
  assert.ok(html.includes('Előbb írj legalább egy kérést'))
})

test('a Javítás kérése gomb sötét, ha nincs kész render, és megmondja miért', () => {
  const html = renderBody(videoDetail({
    renderek: [],
    visszajelzesek: [{ id: 'f1', renderId: null, atMs: null, jelenet: null, szoveg: 'x', forras: 'operator', at: '2026-09-06T10:00:00.000Z', kezelteRenderId: null, kezeltAt: null }],
  }))
  assert.ok(html.includes('Nincs kész render, amire javítást lehetne kérni'))
})
```

`videoDetail(reszek)` és `renderBody(video)` segédeket a fájlban már használt
mintából építsd; ha nincs ilyen, a meglévő `VideoBody`-t rendereld közvetlenül,
ahogy a többi teszt teszi.

- [ ] **5.5 Írd meg a sötétítés okát** a `ui/video.tsx`-be, a meglévő
`narracioTiltasOka` / `renderTiltasOka` mintájára. A sorrend itt is a modul
sorrendje: előbb a lezártság, aztán ami nélkül a művelet értelmetlen.

```tsx
/**
 * Miért sötét a Javítás kérése, vagy null, ha nem az.
 *
 * A SORREND ITT IS A MODULÉ. A lezártságot előbb teszteljük, mint bármit,
 * mert egy lezárt videón a hiányzó render megnevezése oda küldené az
 * operátort, ahonnan nincs visszaút -- ugyanaz az érv, amit a
 * `narracioTiltasOka` fejléce mond ki.
 *
 * A "nincs nyitott kérés" NEM hiba, hanem a normális kiindulóállapot: a
 * gomb azért sötét, mert még nincs mit megrendelni. Ezért mondja meg, mit
 * kell tenni (írj kérést), nem azt, hogy valami elromlott.
 */
function javitasTiltasOka(video: VideoDetail, nyitott: Visszajelzes[], fut: boolean): string | null {
  if (video.status === 'lezart') return 'A videó le van zárva; lezárt videóra nem kérhető javítás.'
  if (video.renderek.every((r) => r.status !== 'kesz')) return 'Nincs kész render, amire javítást lehetne kérni.'
  if (nyitott.length === 0) return 'Előbb írj legalább egy kérést a lenti űrlappal — globálisan, vagy egy jelenetre.'
  if (fut) return 'Egy ügynök-forduló már fut ezen a videón; várd meg a végét.'
  return null
}

/** Nyitott az a visszajelzés, amit az operátor írt és még nem zárt le render. */
const nyitottKeresek = (video: VideoDetail): Visszajelzes[] =>
  video.visszajelzesek.filter((f) => f.forras === 'operator' && f.kezelteRenderId === null)
```

- [ ] **5.6 Rajzold ki a két listát** a „Visszajelzés" szekcióban. A lezárt
kérés megnevezi a rendert, ami lezárta — az a bizonyíték, hogy megszületett
rá egy fájl.

```tsx
<Szekcio cim="Nyitott javítás-kérések" szam={nyitott.length} ures={nyitott.length === 0}
  uresSzoveg="Nincs nyitott kérés ehhez a videóhoz.">
  <ul className="vid-feedback-list">
    {nyitott.map((v) => (
      <li key={v.id}>
        <span className="vid-mono">{v.jelenet === null ? 'globális' : `${v.jelenet}. jelenet`}</span>
        {' · '}
        <span className="vid-mono">{v.atMs === null ? 'nincs időpont' : formatMs(v.atMs)}</span>
        {' · '}
        {v.szoveg}
      </li>
    ))}
  </ul>
</Szekcio>
```

A lezártakhoz ugyanez a lista, `kezelteRenderId !== null` szűrővel, és a
sorban `{`lezárta: ${v.kezelteRenderId}`}` a `vid-mono` osztályon.

- [ ] **5.7 Kösd rá a gombot** a Task 2-ben megépített `rendelj`-re. A
`Lepes` komponenst használd, ahogy a Terv kérése és a Lektorálás kérése teszi,
és a `FORDULO_ARA` figyelmeztetést is add mellé — ez is ügynök-forduló, ami
pénzbe kerül.

```tsx
const onJavitasKeres = useCallback(() => {
  setRendeles('kuldes')
  void rendelj({
    agentNev: GYARTO_NEV,
    sessionNev: `Javítás: ${video.cim}`,
    uzenet: `Az operátor javítást kért a ${video.id} videóra. Olvasd el a videoFixes-szel a nyitott kéréseket, és add be a javítást a videoRevise-zal. Csak azokhoz a jelenetekhez nyúlj, amikről a kérések szólnak. Ne csinálj mást.`,
    fetchImpl: hostFetch,
  }).then((r) => {
    if (r.kind === 'elment') { setRendeles('fut'); setUzenet('A javítás megrendelve; a gyártó dolgozik rajta.') }
    else { setRendeles(null); setUzenet(megrendelesHiba(r)) }
  })
}, [rendelj, video.id, video.cim, hostFetch])
```

A `GYARTO_NEV`, a `rendelj`, a `megrendelesHiba` és a `RendelesAllapot`
mind a Task 2-ből van; olvasd el a `ui/megrendeles.ts`-t és a `ui/video.tsx`
meglévő `onTervKeres`-ét, és kövesd őket.

- [ ] **5.8 Vedd fel a metódust az `import-time` pinbe**, ha új rpc-metódust
adtál hozzá.

- [ ] **5.9 Futtasd a teljes suite-ot.**

Futtatás: `cd extensions/video && npm test`
Várt: 435+ teszt, mind zöld.

- [ ] **5.10 Kapuk és commit.**

---

## Sorrend és miért

**1 → 2 → 3 → 4 → 5**

Az 1. nélkül nincs mit olvasni; a 2. nélkül a gyártó nem találja meg a videót;
a 3. a gerinc, és a 4. csak akkor értelmes, ha már van `operator_javitas`
származású verzió, amit beengedhet. Az 5. a legkésőbb, mert az összes
korábbira támaszkodik, és mert a lap az egyetlen rész, amit élesben látni is
lehet.

## Amit ez a terv nem old meg

- **A publikálást, az ütemezést és a naptár-nézetet.** Külön projekt, külön
  spec. A platform-engedélyek (YouTube-hitelesítés, Meta app review, TikTok
  audit) naptári időt esznek, és érdemes párhuzamosan elindítani ezzel.
- **A kész videó megtekintését az appban.** A hostnak van fájlkiszolgáló
  útvonala (`/api/files/serve`), de 10 MB-os korláttal, `.mp4` MIME-típus
  nélkül és Range-támogatás nélkül. Ez host-kód, nem a modulé.
- **A `tempo` illesztését.** A `lepes` illesztése elkészült (`e5e3602`); a
  `tempo` egy szorzó a jelenet egész animációjára, más mechanizmus.
