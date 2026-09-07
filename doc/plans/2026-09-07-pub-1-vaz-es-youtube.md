# PUB-1: a publikáló modul váza és a YouTube — kivitelezési terv

> **Végrehajtóknak:** KÖTELEZŐ AL-SKILL: `superpowers:subagent-driven-development`
> vagy `superpowers:executing-plans`. A lépések `- [ ]` jelölésűek, tickeld őket.

**Cél:** álljon fel az `extensions/publish` modul, vegye át a kész videókat a
`videos` szerződésen, csináljon belőlük kiadást platformonkénti ágakkal,
ütemezze sávokba, rajzoljon naptárat — és a négy platform közül a **YouTube**
menjen végig élesben.

**Spec:** `doc/specs/2026-09-07-publikalas-design.md` (a teljes kép, mind a
négy platformmal). Ez a terv a spec 1–5., 7., 8. szakaszát építi meg, és a 6.
szakaszból csak a YouTube-ot. A Meta a PUB-2, a TikTok a PUB-3.

**Architektúra:** új bővítmény a CRM mintájára. A kiadás egy sor, alatta
platformonként egy ág. A kiküldést fix ütemű deklarált ütemezés hajtja, ami
egy ügynököt ébreszt, az pedig egyetlen toolt hív.

**Eszközök:** Node ESM, `node:sqlite` a tesztekben, `node --import tsx --test`,
React 19 a host moduljaiból. A host oldalán TypeScript.

## Global Constraints

- **Három különböző tény három különböző állapot.** Ebben a modulban ez a
  legélesebb: egy platform, aminek nincs fiókja, egy platform, ami elbukott,
  és egy platform, ami még nem jött el — három állapot, sosem egymás helyett.
- **Az elutasítás MEGNEVEZETT**: kód és mondat, ami megmondja, mi a teendő.
  A „sikertelen" szó nem fordul elő.
- **Az elutasítás üzenete soha nem mondja vissza a hívó értékét vagy tárolt
  szöveget.** A modul saját konstansa, a saját generált id-je és az argumentum
  NEVE nem az.
- **Idegen és ügynök-szöveg adat.** A platformra kimenő szöveget ügynök írta:
  React text child a lapon, soha nem HTML, és `href`-be csak ellenőrizve.
- **Nincs `any`, nincs lint-elnyomás.** Magyar operátor- és ügynök-szöveg,
  `pub-` CSS-prefix.
- **A kommentek a MIÉRT-et mondják el**, a testvérmodulok regiszterében.
- **Kapuk:** `npm test` az `extensions/publish`-ben, `npx eslint <módosított>`
  a repo gyökeréből, `npx tsc --noEmit`, `npm run build` a modulban, és
  `npm run lint:baseline` a gyökérből.
- **Minden feladat végén commit**, üzenet fájlból (`git commit -F`), a két
  trailerrel:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01Y91TwoyBNxgwYjS7sTsB7Y`
- **Nincs push. Nincs dev-szerver. A telepített appot nem érintjük.**

## Két dolog, amit a végrehajtás elején tudni kell

1. **Az 5. feladat HOST-kódot módosít** (a Google scope-allowlist). A host
   `app.asar`-ba fordul, tehát az élesben próbához **Electron-újraépítés** kell
   — a bővítmény önmagában forrón újratölt, a host nem.
2. **A minta a CRM modul** (`extensions/crm/`): teljes bővítmény lappal,
   MCP-híddal, ügynökkel, 3 683 sor. Olvasd el a szerkezetét, mielőtt bármit
   írsz; ne találj ki új elrendezést.

---

## Feladat 1: a modul váza és a szerződés-olvasás

**Files:**
- Create: `extensions/publish/package.json`, `index.mjs`, `src/db.mjs`,
  `scripts/build.mjs`, `scripts/install.mjs`, `src/mcp-bridge.mjs`,
  `mcp/server.mjs`
- Create: `extensions/publish/test/db.test.mjs`, `test/helpers.mjs`,
  `test/import-time.test.mjs`
- Modify: `package.json` (`test:runtime`), `extensions/mcp-shim-parity.test.mjs`

**Interfaces (a későbbi feladatoknak):**
- `MIGRATIONS` — a négy tábla (`ext_publish_fiokok`, `_kiadasok`, `_agak`, `_savok`)
- `createRepo(storage)` → a repository; ebben a feladatban csak a fiók- és
  kiadás-alapműveletek
- `videosHandle(state)` → a `video.videos@1` fogadója, vagy megnevezett
  elutasítás (`szerzodes_hianyzik`)

- [ ] **1.1 Másold a CRM váz-fájljait**, és igazítsd az azonosítókat.
`extensions/crm/package.json`, `scripts/build.mjs`, `scripts/install.mjs`,
`src/mcp-bridge.mjs` és `mcp/server.mjs` a minta. Az `mcp-bridge.mjs`
**bájtazonos** a testvérmoduloké val (`extensions/mcp-shim-parity.test.mjs`
ezt ellenőrzi), a `mcp/server.mjs`-ben csak az `EXTENSION_ID` és a
`SERVER_INFO` extension-specifikus.

- [ ] **1.2 Vedd fel az új suite-ot a `test:runtime` listába.** A
`package.json` `test:runtime` szkriptje MINDEN tesztfájlt névvel vagy
glob-bal sorol fel; ami nincs benne, soha nem fut. A testvérmodulok globjai
mellé kerül: `'extensions/publish/test/*.test.mjs'`.

- [ ] **1.3 Írd meg a bukó séma-teszteket** (`test/db.test.mjs`), a
`extensions/video/test/helpers.mjs` `memStorage()`/`freshRepo()` mintájára —
azt másold, ne találj ki harmadikat.

```js
test('a kiadás ágai platformonként egy sor, és a kiadás nem duplázódik', () => {
  const { repo } = freshRepo()
  const k = repo.ujKiadas({ videoId: 'v1' })
  assert.equal(k.allapot, 'vazlat')
  repo.ujAg({ kiadasId: k.id, platform: 'youtube' })
  repo.ujAg({ kiadasId: k.id, platform: 'tiktok' })
  assert.deepEqual(repo.agak(k.id).map((a) => a.platform), ['youtube', 'tiktok'])
  assert.throws(() => repo.ujAg({ kiadasId: k.id, platform: 'youtube' }), /platform/,
    'egy kiadáson egy platform egyszer szerepel')
})

test('a fiók platformonként és külső id szerint egyedi', () => {
  const { repo } = freshRepo()
  repo.fiokotIr({ platform: 'youtube', kulsoId: 'UC1', nev: 'A csatornám' })
  repo.fiokotIr({ platform: 'youtube', kulsoId: 'UC1', nev: 'Átnevezve' })
  assert.equal(repo.fiokok().length, 1, 'ugyanaz a fiók frissül, nem duplázódik')
  assert.equal(repo.fiokok()[0].nev, 'Átnevezve')
})
```

- [ ] **1.4 Futtasd, és nézd meg, hogy BUKIK.**
`cd extensions/publish && npx tsx --test test/db.test.mjs` — nincs `createRepo`.

- [ ] **1.5 Írd meg a `MIGRATIONS`-t és a repository alapját.** A séma a spec
3. szakasza. A `video` modul `src/db.mjs`-e a regiszter: a fájl tetején egy
táblázat, ami minden olvasásról megmondja, mit kapuz. Írj ilyet.

Az ágak egyedisége **indexen** álljon, ne csak a kódban:
`CREATE UNIQUE INDEX ... ON ext_publish_agak (kiadas_id, platform)`.

- [ ] **1.6 Kösd be a `videos` szerződést.** Az `index.mjs` `consumes`
bejegyzése:

```js
consumes: [
  { extension: 'video', contract: 'videos', version: 1, reason: 'A kész, QA-átment videókból csinál kiadást: a fájl útját, az ujjlenyomatát, a hosszát és a narráció szövegét olvassa.' },
],
```

és a fogadó a `extensions/docs/src/video-forgatokonyv.mjs` `videoLekerdez`
mintájára — **olvasd el**, mert az négy különböző okot nevez meg a `null`-ra,
és külön kezeli azt, hogy a szolgáltató HÍVÁS KÖZBEN tűnik el. Ugyanaz kell
ide is; ne írd újra rosszabbul.

- [ ] **1.7 Futtasd, kapuk, commit.**

---

## Feladat 2: a kiadás és az ágai — az állapot, ami nem hazudik

Ez a feladat gerince. A kiadás állapota négy ág sorsából következik, és a
spec 5. szakasza kimondja, melyik kombináció mit jelent.

**Files:**
- Create: `extensions/publish/src/allapot.mjs`
- Modify: `extensions/publish/src/db.mjs`
- Create: `extensions/publish/test/allapot.test.mjs`

**Interfaces:**
- `kiadasAllapot(agak)` → `'vazlat' | 'utemezve' | 'kesz' | 'reszben' | 'hiba' | 'nincs_hova'`
  — tiszta függvény, nem olvas adatbázist, nem dob

- [ ] **2.1 Írd meg a bukó teszteket.**

```js
import { kiadasAllapot } from '../src/allapot.mjs'
const ag = (platform, allapot) => ({ platform, allapot })

test('minden összekötött ág kiment: kesz', () => {
  assert.equal(kiadasAllapot([ag('youtube', 'kesz'), ag('tiktok', 'kesz')]), 'kesz')
})
test('egy kiment, egy elbukott: reszben — és NEM kesz', () => {
  assert.equal(kiadasAllapot([ag('youtube', 'kesz'), ag('tiktok', 'hiba')]), 'reszben')
})
test('egyik sem ment ki: hiba', () => {
  assert.equal(kiadasAllapot([ag('youtube', 'hiba'), ag('tiktok', 'hiba')]), 'hiba')
})
test('a fiók nélküli ág nem várakoztat és nem buktat', () => {
  assert.equal(kiadasAllapot([ag('youtube', 'kesz'), ag('tiktok', 'nincs_fiok')]), 'kesz')
})
test('EGYETLEN fiók sincs összekötve: nincs_hova, nem kesz', () => {
  // Ez a modul legrosszabb hazugsága lenne: nulla ágból nulla ment ki, tehát
  // a "minden ág kiment" ÜRESEN igaz, és a lap azt írná, publikálva van
  // valami, ami sehol nincs fent.
  assert.equal(kiadasAllapot([ag('youtube', 'nincs_fiok'), ag('tiktok', 'nincs_fiok')]), 'nincs_hova')
  assert.equal(kiadasAllapot([]), 'nincs_hova')
})
test('amíg bármelyik vár, a kiadás utemezve', () => {
  assert.equal(kiadasAllapot([ag('youtube', 'kesz'), ag('tiktok', 'var')]), 'utemezve')
})
```

- [ ] **2.2 Futtasd, és nézd meg, hogy BUKIK.**

- [ ] **2.3 Írd meg a `kiadasAllapot`-ot.** Külön fájlban és tiszta
függvényként, mert ez az a szabály, amit a lap, az ütemező és a jelentés
egyaránt kérdez — és ha három helyen mondanák ki, elcsúsznának. A docblock
mondja meg, miért `nincs_hova` az üres eset, és hogy a `nincs_fiok` miért nem
számít se sikernek, se bukásnak.

- [ ] **2.4 Futtasd, kapuk, commit.**

---

## Feladat 3: sávok, ütemezés és az, ami esedékes

**Files:**
- Create: `extensions/publish/src/utemezes.mjs`
- Modify: `extensions/publish/src/db.mjs`, `index.mjs`
- Create: `extensions/publish/test/utemezes.test.mjs`

**Interfaces:**
- `kovetkezoSzabadSav(savok, foglaltak, most)` → `{ savId, idopont }` vagy `null`
- `esedekes(kiadasok, most)` → azok a kiadások, amiknek ideje eljött
- `SCHEDULES` — egy deklarált, fix ütemű futás az `index.mjs`-ben

- [ ] **3.1 Írd meg a bukó teszteket.** A sáv-számtan tiszta függvény, tehát
injektált „most"-tal tesztelhető, óra nélkül.

```js
test('a jóváhagyott kiadás a következő SZABAD sávba áll', () => {
  const savok = [{ id: 's1', nap: 1, ora: 9, perc: 0 }, { id: 's2', nap: 1, ora: 18, perc: 0 }]
  const most = new Date('2026-09-07T07:00:00.000Z')
  assert.equal(kovetkezoSzabadSav(savok, [], most).savId, 's1')
  const foglalt = [{ savId: 's1', idopont: '2026-09-07T09:00:00.000Z' }]
  assert.equal(kovetkezoSzabadSav(savok, foglalt, most).savId, 's2')
})

test('nincs több szabad sáv: null, nem az első újra', () => {
  const savok = [{ id: 's1', nap: 1, ora: 9, perc: 0 }]
  const most = new Date('2026-09-07T10:00:00.000Z')
  // A mai 09:00 elment; a következő ugyanaz a sáv a KÖVETKEZŐ héten.
  const r = kovetkezoSzabadSav(savok, [], most)
  assert.ok(r !== null && Date.parse(r.idopont) > most.getTime(), 'soha nem ad múltbeli időpontot')
})

test('esedekes: a megadott idő UTÁNI első futás viszi ki', () => {
  const k = [{ id: 'k1', idopont: '2026-09-07T09:00:00.000Z', allapot: 'utemezve' }]
  assert.deepEqual(esedekes(k, new Date('2026-09-07T08:59:00.000Z')).map((x) => x.id), [])
  assert.deepEqual(esedekes(k, new Date('2026-09-07T09:07:00.000Z')).map((x) => x.id), ['k1'])
})

test('esedekes csak utemezve állapotút hoz — vázlatot soha', () => {
  const k = [{ id: 'k1', idopont: '2026-09-07T09:00:00.000Z', allapot: 'vazlat' }]
  assert.deepEqual(esedekes(k, new Date('2026-09-07T10:00:00.000Z')), [])
})
```

- [ ] **3.2 Futtasd, és nézd meg, hogy BUKIK.**

- [ ] **3.3 Írd meg az `utemezes.mjs`-t.** A docblock mondja ki a spec 7.
szakaszának ellentmondás-feloldását: a deklarált ütemezés statikus, a sávok
operátori adat, ezért a modul **fix ütemben** fut, és a sáv csak azt mondja
meg, melyik időpontra kerül a kiadás — nem az ütemezőt vezérli. És mondja ki
a csúszást: minden kiadás a megadott idő utáni első futáskor megy ki.

- [ ] **3.4 Deklaráld az ütemezést** az `index.mjs`-ben, a `video` modul
`SCHEDULES`-ének mintájára (`extensions/video/src/agents.mjs`). Fix ütem,
alapból 15 perc. A `taskPrompt` egyetlen dolgot kér: hívja meg a
„tedd ki, aminek eljött az ideje" toolt, és számoljon be.

- [ ] **3.5 Futtasd, kapuk, commit.**

---

## Feladat 4: az író és a lektor

**Files:**
- Create: `extensions/publish/src/agents.mjs`, `src/szoveg.mjs`
- Create: `extensions/publish/skills/publikalas-szoveg/SKILL.md`,
  `skills/publikalas-lektoralas/SKILL.md`
- Modify: `extensions/publish/index.mjs`
- Create: `extensions/publish/test/agents.test.mjs`, `test/szoveg.test.mjs`

**Interfaces:**
- `LEKTOR_KODOK` — ennek a modulnak a SAJÁT zárt listája
- `PLATFORM_KORLATOK` — platformonként a hosszkorlátok, egy helyen
- toolok: `publishDraft` (megírja a négy szöveget), `publishVerdict`
  (lektori ítélet), `publishDue` (tedd ki, aminek eljött az ideje)

- [ ] **4.1 Írd meg a bukó teszteket.** A hosszkorlát ellenőrzése tiszta
függvény; a toolok a `video` modul tool-tesztjeinek mintájára.

```js
test('a platform hosszkorlátját túllépő szöveg megnevezve utasul el', async () => {
  const { run } = setup()
  const r = await run('publishDraft', { kiadasId: 'k1', szovegek: [
    { platform: 'youtube', cim: 'x'.repeat(101), leiras: 'y' },
  ] })
  assert.equal(r.error.code, 'szoveg_tul_hosszu')
  assert.equal(r.error.platform, 'youtube')
  assert.equal(r.error.message.includes('xxx'), false, 'a hívó szövege nem kerül az üzenetbe')
})

test('a lektori kódlista zárt, és a videó modul szavát használja, ahol a jelentés ugyanaz', () => {
  assert.ok(LEKTOR_KODOK.includes('allitas_forras_nelkul'),
    'egy tényre egy név: az operátor ne tanuljon kettőt')
  assert.ok(LEKTOR_KODOK.includes('hashtag_kitalalt'))
  assert.equal(new Set(LEKTOR_KODOK).size, LEKTOR_KODOK.length)
})
```

- [ ] **4.2 Futtasd (BUKIK), majd írd meg.** A `PLATFORM_KORLATOK` egy
helyen álljon: a YouTube cím 100, a leírás 5000 karakter; a többi platform
számát a PUB-2/PUB-3 tölti ki, és **addig `null`**, nem kitalált szám.
Egy `null` korlát azt jelenti, hogy ezt a platformot még nem mértük fel — és
a draft tool ezt megnevezve mondja meg, nem enged át némán.

- [ ] **4.3 Írd meg a két skillt.** A `video` modul
`skills/video-jelenetlista/SKILL.md` a regiszter. **Van egy 3000 karakteres
host-korlát** az inline skill-törzsre
(`INLINED_SKILL_CHAR_CAP`, `src/lib/server/skills/runtime-skill-resolver.ts`) —
a `video` modul tesztje ezt pinneli, csináld ugyanígy.

- [ ] **4.4 Futtasd, kapuk, commit.**

---

## Feladat 5: a YouTube — és a host scope-allowlistje

**Files:**
- Modify: `src/app/api/oauth/google/start/route.ts` (HOST)
- Create: `extensions/publish/src/platform/youtube.mjs`
- Create: `extensions/publish/test/youtube.test.mjs`
- Modify: `src/app/api/oauth/google/oauth-route.test.ts` (HOST)

**Interfaces:**
- `feltolt({ fajl, cim, leiras, cimkek, getToken, fetchImpl, szarazFutas })`
  → `{ url, kulsoId }` vagy megnevezett elutasítás
- `KVOTA_EGYSEG_FELTOLTES`, `KVOTA_NAPI_ALAP` — a modul saját konstansai

- [ ] **5.1 Vedd fel a `publish` purpose-t a host allowlistjébe.**
`src/app/api/oauth/google/start/route.ts` `SCOPES` táblája ma két bejegyzést
ismer (`aisignal`, `gmail`), és egy nem listázott purpose **nem kap
beleegyezési URL-t** — szándékosan, hogy egy hívó ne szélesíthesse a saját
jogosultságát. Olvasd el a fájl tetején álló indoklást, és írj ugyanolyat.

```ts
  // A feltöltés a legszűkebb scope, ami elvégzi: `youtube.upload` beszúrni
  // tud, és semmi mást. A `youtube` és a `youtube.force-ssl` a csatorna
  // olvasását és szerkesztését is megadná -- egy token, ami videót töröl,
  // nem az, amire ennek a modulnak szüksége van.
  publish: ['https://www.googleapis.com/auth/youtube.upload'],
```

**A host-teszt is kell hozzá**: a `src/app/api/oauth/google/oauth-route.test.ts`
pinneli, mely purpose-ok engedettek — vedd fel, és nézd meg, hogy a teszt
tényleg bukna a bejegyzés nélkül.

- [ ] **5.2 Írd meg a bukó adapter-teszteket**, injektált `fetchImpl`-lel.
**Egyetlen teszt sem megy ki a hálózatra.**

```js
test('a kvóta ELŐRE fog, nem a feltöltés közben', async () => {
  const r = await feltolt({ ...alap(), maiEgysegek: KVOTA_NAPI_ALAP - 1, fetchImpl: sohaNeHivd })
  assert.equal(r.error.code, 'kvota_elfogyott')
  assert.equal(r.error.message.includes('1600'), true, 'a modul saját száma benne lehet')
})

test('a száraz futás mindent összerak, de nem küld', async () => {
  const hivasok = []
  const r = await feltolt({ ...alap(), szarazFutas: true, fetchImpl: (...a) => { hivasok.push(a); throw new Error('nem szabad') } })
  assert.equal(hivasok.length, 0)
  assert.equal(r.szaraz, true)
  assert.equal(typeof r.kerés, 'object', 'a kérés ellenőrizhető anélkül, hogy kiment volna')
})

test('a token hiányát megnevezi, és nem a hálózatnak tulajdonítja', async () => {
  const r = await feltolt({ ...alap(), getToken: async () => { const e = new Error('nincs'); e.code = 'no_credential'; throw e } })
  assert.equal(r.error.code, 'fiok_nincs_osszekotve')
})
```

- [ ] **5.3 Futtasd (BUKIK), majd írd meg az adaptert.** Két dolgot mondj ki
a docblockban:

- **A kvóta a dokumentációból van, nem mérésből.** Egy feltöltés 1600 egység,
  a napi alap 10 000 — nagyjából hat videó naponta. Az első éles feltöltésnél
  ellenőrizni kell. A modul a SAJÁT számlálójából utasít el, MIELŐTT nekifut:
  egy kvótába futó feltöltés a videót is elveszítheti félúton.
- **A száraz futás nem teszt-kapcsoló, hanem a modul része.** Három platform
  kódja hetekig nem próbálható élesben; a száraz futás az, ami addig is
  megmutatja, hogy a kérés összeáll.

- [ ] **5.4 Futtasd, kapuk, commit.** A host-tesztet is futtasd:
`npx tsx --test src/app/api/oauth/google/oauth-route.test.ts`.

---

## Feladat 6: a naptár és a lap

**Files:**
- Create: `extensions/publish/ui/main.tsx`, `ui/naptar.tsx`, `ui/kiadas.tsx`,
  `ui/fiokok.tsx`, `ui/api.ts`, `ui/host.ts`, `ui/style.css`
- Modify: `extensions/publish/src/rpc.mjs`, `index.mjs`
- Create: `extensions/publish/test/ui.test.mjs`

- [ ] **6.1 Másold a lap-vázat a CRM-ből** (`extensions/crm/ui/`): `host.ts`,
`main.tsx` regisztráció, az `api.ts` olvasó-fegyelme (megnevezett hiányzó
mező, nem üres eredmény). A teszt-harness a `extensions/video/test/ui.test.mjs`
tetején álló hook-hajtó (`mount`, `stubRpc`, `settle`) — **azt másold**, ne
építs harmadikat.

- [ ] **6.2 Írd meg a bukó teszteket.**

```js
test('egy kiadás EGY bejegyzés a naptárban, négy platform-jelzővel', () => {
  const html = renderNaptar(naptarFixture({ agak: [
    { platform: 'youtube', allapot: 'kesz' }, { platform: 'facebook', allapot: 'var' },
    { platform: 'instagram', allapot: 'hiba' }, { platform: 'tiktok', allapot: 'nincs_fiok' },
  ] }))
  assert.equal(elofordulas(html, 'pub-bejegyzes'), 1, 'egy bejegyzés, nem négy')
  for (const p of ['youtube', 'facebook', 'instagram', 'tiktok']) assert.ok(html.includes(p))
})

test('a vázlat láthatóan más, mint a jóváhagyott', () => {
  const v = renderNaptar(naptarFixture({ allapot: 'vazlat' }))
  const j = renderNaptar(naptarFixture({ allapot: 'jovahagyva' }))
  assert.notEqual(v, j)
  assert.ok(v.includes('jóváhagyásra vár'))
})

test('a naptár megmondja, mikor megy ki ténylegesen, nem csak a kért időt', () => {
  const html = renderNaptar(naptarFixture({ idopont: '2026-09-07T09:00:00.000Z' }))
  assert.ok(/negyed ór|következő futás/.test(html),
    'a csúszás ki van mondva; egy percre pontosat ígérő naptár rosszabb, mint amelyik megmondja a pontosságát')
})

test('a nincs_hova nem kesz: a lap kimondja, hogy sehol nincs fent', () => {
  const html = renderNaptar(naptarFixture({ allapot: 'nincs_hova' }))
  assert.ok(html.includes('Egyetlen platform sincs összekötve'))
  assert.equal(html.includes('Kiment'), false)
})
```

- [ ] **6.3 Futtasd (BUKIK), majd írd meg a lapot.** Három nézet: naptár
(heti, sávokra osztva), kiadás-részletek (a négy szöveg, jóváhagyás,
ágankénti állapot és URL), fiókok (összekötés, és megnevezve az, ami hiányzik).

- [ ] **6.4 Futtasd, kapuk, commit.**

---

## Sorrend és miért

**1 → 2 → 3 → 4 → 5 → 6**

Az 1. nélkül nincs hova írni; a 2. az a szabály, amire a 3. és a 6. is
támaszkodik; a 4. adja a szöveget, amit az 5. kitesz; a 6. mindre épül, és ez
az egyetlen rész, amit élesben látni is lehet.

## Amit ez a terv nem old meg

- **A Metát és a TikTokot.** PUB-2 és PUB-3, amint az app review és az audit
  megvan. A `PLATFORM_KORLATOK` addig `null`-t tart nekik, nem kitalált számot.
- **A teljesítmény visszamérését.** A `ext_video_megtartas` importja létezik;
  összekötni külön ügy.
- **A több fiókot platformonként.** A séma megengedi, a felület egyet kezel.
