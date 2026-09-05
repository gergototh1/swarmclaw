# Sablon-galéria — megvalósítási terv

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a videó modul „Sablonok" nézete mutassa a katalógus mind a 24
jelenettípusát — leírással, propokkal és egy Remotionnal renderelt
állóképpel —, szűrhetően.

**Architecture:** a mintaadatok a Remotion-projekt szótárában élnek és a
katalógusfájlba kerülnek; a SwarmClaw a `fos-video` kompozíciót hívja meg
egyelemű jelenetlistával (`remotion still`), a képet a katalógus hash-e alá
gyorsítótárazza, és a lapnak `data:` URL-ként adja ki. Új Remotion-kompozíció
nincs.

**Tech Stack:** Node ESM (`.mjs`), `node:child_process`, React 19 + esbuild a
lapon, TypeScript a Remotion-projektben.

**Spec:** `doc/specs/2026-09-05-sablon-galeria-design.md` — a döntések és az
indoklásuk ott vannak, ez a fájl a lépéssor.

## Global Constraints

- **A Remotion-projektbe csak additív változás megy.** Új kompozíció, új
  komponens, új kimeneti mappa nincs; a `minta` mező és a kiadó script egy
  sora az egész.
- **A `tipus` soha nem kerül nyers szövegként útvonalba.** Minden fájlnév
  előtt a típusnak át kell mennie a `katalogus.tipusok` tagsági vizsgálatán.
  Ez a modul egészére érvényes szabály (lásd `katalogus.mjs` docblock).
- **Egy hibaüzenet sem ismétli meg a hívó szövegét.** A modul saját szótárából
  való kód és a katalógus szava mehet bele, más nem.
- **A gyorsítótár kulcsa a `katalogusHash`.** Nincs invalidálás, csak új mappa.
- **Nincs automatikus generálás.** Oldalbetöltés nem indít rendert.
- **Magyar felület, magyar kódnevek** — a modul meglévő szokása szerint.
- **A meglévő tesztek nem gyengülhetnek.** `npm test` az `extensions/video`
  alatt a feladat végén zöld, és nem kevesebb teszttel, mint az elején.

---

### Task 1: A mintaadatok a Remotion-szótárban

**Repó:** `/Users/tothgergo/DEV/marketing/ai-use-cases/videos/_remotion`
(KÜLÖN REPÓ — külön commit oda; a SwarmClaw repóban ez a feladat nem
változtat semmit.)

**Files:**
- Modify: `src/kit/szotar.ts`
- Modify: `scripts/katalogus-emit.ts`
- Modify: `src/kit/__tests__/katalogus.test.ts`
- Regenerate: `src/kit/katalogus.generated.json` (a `npm run katalogus` írja)

**Interfaces:**
- Produces: a `katalogus.generated.json` kap egy `mintak` mezőt:
  `Record<string, Record<string, unknown>>` — típusnév → egy jelenet propjai
  a `tipus` kulcs NÉLKÜL.

**Kontextus.** A `szotar.ts` a jelenettípusok egyetlen forrása: minden elem
`{tipus, mikor, propok}`, és a `propok` listák `satisfies`-szal a valódi
prop-típusokhoz vannak kötve, tehát egy elírt propnév `tsc --noEmit`-en
elbukik. A saját docblockja mondja ki, miért itt: *„Egy helyen a nev es a
mondat: nincs kulcs, nincs masodik fajl, nincs mit szinkronban tartani."*
A mintaérték ugyanabba a kategóriába tartozik, mint a mondat.

- [ ] **Step 1: A `minta` mező típusa**

A `Prop<T>` mellé kerül a jelenet-elem mintája. A `JELENETEK` elemei ma
`{tipus, mikor, propok}` alakúak; mindegyik kap egy `minta` mezőt, amely a
típus saját props-típusa a `tipus` kulcs nélkül:

```ts
/**
 * EGY JELENET, AMIT LE LEHET RENDERELNI.
 *
 * A `propok` megmondja, milyen mezoi vannak a tipusnak; ez megmondja, mi
 * legyen bennuk ahhoz, hogy a jelenet KEPKENT is megnezheto legyen. A
 * FounderOS ebbol rendel egy allokepet a sablon-galeriaba: egyelemu
 * jelenetlista, `fos-video`, egy kocka.
 *
 * A tipusa a jelenet sajat props-tipusa, tehat egy elirt vagy elavult
 * mezonev itt is `npx tsc --noEmit`-en hibazik -- ugyanaz a vedelem, ami a
 * `propok` listakon mar all.
 *
 * AMI JSON-BOL NEM KULDHETO, AZ IDE SEM KERUL. Ahol egy prop React-csomopont
 * (pl. `cimlap.grafika`, `kartya-csere.kartyak[].jel`), ott a minta a nelkul
 * all: a galeria azt a alakot mutatja, amit egy ugynok is meg tud epiteni.
 */
type Minta<T> = Omit<T, 'tipus'>
```

- [ ] **Step 2: Minta minden típushoz**

Mind a 24 `JELENETEK` elem kap egy `minta`-t. A tartalom szabály:

1. **Minden kötelező prop szerepel.** A `propok` lista `kotelezo: true`
   elemei kivétel nélkül.
2. **Opcionális prop csak akkor, ha a kép enélkül félrevezető** — pl. egy
   `hatter`, ami nélkül a címlap nem azt mutatja, amit általában.
3. **A szöveg magyar, rövid és a típusról szól**, nem kitalált termékről:
   a `cimlap` mintája a címlapról szóljon. Így a galéria kártyája
   önmagyarázó.
4. **React-csomópont propot nem ad meg** (a `kit-tabla.mjs` `kuldheto:
   false` esetei és a `mit` szövegben „React-csomopont"-ként jelölt propok).
5. **Fájlnevet váró prop csak akkor kap értéket, ha a `public/` mappában
   tényleg ott a fájl.** Ellenőrizd `ls public/`-kal; ha nincs alkalmas
   kép, hagyd el az opcionális prop-ot.
6. **`lathatoHossz` NEM kerül a mintába** — azt a SwarmClaw írja a render
   előtt (spec 3.1).

Példa a `cimlap`-ra és az `atvezeto`-ra, a meglévő elem alakjához igazítva:

```ts
{
  tipus: 'cimlap',
  mikor: 'A video elso jelenete. Kimondja, mirol lesz szo.',
  propok: [ /* valtozatlan */ ],
  minta: {
    sorok: ['Igy nez ki egy', 'cimlap'],
    kiemelt: 'cimlap',
  } satisfies Minta<CimlapProps>,
},
{
  tipus: 'atvezeto',
  mikor: 'Temavaltasnal hasznald: megmondja, hogy ami jon, mas, mint ami eddig volt.',
  propok: [ /* valtozatlan */ ],
  minta: {
    sorszam: '02',
    nev: 'Atvezeto',
  } satisfies Minta<AtvezetoProps>,
},
```

A maradék 22-t ugyanígy, a saját props-típusukkal. Olvasd el mindegyik
típus komponensét (`src/kit/jelenetek*.tsx`, `Diagram.tsx`, `Film.tsx`),
mielőtt mintát írsz hozzá: a `mit` szöveg nem mindig mondja meg, milyen
alakot vár egy mező (pl. a `kartya-csere.kartyak` elemei objektumok
`cim`/`szam`/`leiras` mezőkkel, ahol a `szam` string).

- [ ] **Step 3: A kiadó script adja ki**

`scripts/katalogus-emit.ts`:

```ts
const ki = {
  generatedFrom: 'src/kit/szotar.ts',
  tipusok: JELENETEK.map((j) => j.tipus),
  leirasok: Object.fromEntries(JELENETEK.map((j) => [j.tipus, j.mikor])),
  propok: Object.fromEntries(JELENETEK.map((j) => [j.tipus, j.propok])),
  // A minta: amivel a tipus KEPKENT is megnezheto. A FounderOS ebbol
  // rendel allokepet; itt van, mert a szotar a tipusok egyetlen forrasa.
  mintak: Object.fromEntries(JELENETEK.map((j) => [j.tipus, j.minta])),
  kozosPropok: KOZOS_PROPOK,
};
```

- [ ] **Step 4: A teszt, ami nem hagyja elavulni**

`src/kit/__tests__/katalogus.test.ts` — új eset, a meglévők mintájára:

```ts
it('minden tipusnak van mintaja, es a minta minden kotelezo propot megad', () => {
  for (const j of JELENETEK) {
    expect(j.minta, `${j.tipus}: nincs minta`).toBeDefined();
    const kotelezo = j.propok.filter((p) => p.kotelezo).map((p) => p.nev);
    for (const nev of kotelezo) {
      expect(Object.hasOwn(j.minta, nev), `${j.tipus}.${nev}: kotelezo, de a mintabol hianyzik`).toBe(true);
    }
  }
});

it('a kiadott katalogus mintai megegyeznek a szotareval', () => {
  const kiadott = JSON.parse(fs.readFileSync(KATALOGUS, 'utf8'));
  for (const j of JELENETEK) {
    expect(kiadott.mintak[j.tipus]).toEqual(j.minta);
  }
});
```

(A `KATALOGUS` konstanst a fájl már használja a többi esetben; ha más a
neve, azt használd.)

- [ ] **Step 5: Kiadás és típusellenőrzés**

```bash
npx tsc --noEmit
npm run katalogus
npx vitest run src/kit/__tests__/katalogus.test.ts
```

Elvárt: `tsc` néma; a kiadás `kiadva: ... (24 tipus)`; a tesztek zöldek.

- [ ] **Step 6: Minden minta tényleg renderelhető**

Ez a lépés az, ami elválasztja a „típushelyes" mintát a „megnézhető"
mintától. Írj egy eldobható scriptet, ami minden típusra lefuttat egy
still-rendert, és jelenti, melyik bukott:

```bash
node - <<'EOF'
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const kat = JSON.parse(fs.readFileSync('src/kit/katalogus.generated.json', 'utf8'));
fs.mkdirSync('/tmp/sablon-proba', { recursive: true });
const bukott = [];
for (const tipus of kat.tipusok) {
  const minta = kat.mintak[tipus];
  if (!minta) { bukott.push([tipus, 'nincs minta']); continue; }
  const props = { lista: [{ tipus, ...minta, lathatoHossz: 90 }], hatter: true };
  fs.writeFileSync('/tmp/sablon-proba/p.json', JSON.stringify(props));
  try {
    execFileSync('npx', ['remotion', 'still', 'src/index.ts', 'fos-video',
      `/tmp/sablon-proba/${tipus}.png`, '--props=/tmp/sablon-proba/p.json',
      '--frame=85', '--scale=0.333'], { stdio: 'pipe' });
  } catch (e) { bukott.push([tipus, String(e.stderr || e).slice(-400)]); }
}
console.log(bukott.length === 0 ? 'MIND RENDBEN' : JSON.stringify(bukott, null, 2));
EOF
```

Minden bukott típus mintáját javítsd, amíg a lista üres nem lesz. **Nézd is
meg néhány képet** (a `Read` eszközzel): egy üres vagy fekete kép
típushelyes mintából is jöhet, és az a galéria szempontjából ugyanolyan
haszontalan, mint egy hiba.

- [ ] **Step 7: Commit (a Remotion-repóban)**

```bash
git add src/kit/szotar.ts scripts/katalogus-emit.ts src/kit/__tests__/katalogus.test.ts src/kit/katalogus.generated.json
git commit -m "A szotar mondja meg azt is, hogy nez ki egy tipus"
```

**NE pusholj.** Ebben a repóban van egy korábbi, még ki nem küldött commit;
a küldés az operátor döntése.

---

### Task 2: A katalógus és a `templates` RPC kiadja a típusokat

**Files:**
- Modify: `extensions/video/src/katalogus.mjs`
- Modify: `extensions/video/src/rpc.mjs` (a `templates` metódus)
- Modify: `extensions/video/ui/api.ts` (a `Templates` típus és `readTemplates`)
- Test: `extensions/video/test/katalogus.test.mjs`, `extensions/video/test/rpc.test.mjs`

**Interfaces:**
- Consumes: a Task 1-ben kiadott `mintak` mező.
- Produces: `readCatalog(dir)` visszaadja a `mintak`-at is; a `templates`
  RPC válasza a mai három mező mellett:
  `tipusok: string[]`, `leirasok: Record<string,string>`,
  `propok: Record<string, {nev,kotelezo,mit}[]>`, `kozosPropok`,
  `kuldhetoTipusok: string[]`, `nemKuldhetoTipusok: string[]`,
  `mintaHianyzik: string[]`.

- [ ] **Step 1: A bukó teszt — a katalógus olvassa a mintákat**

`extensions/video/test/katalogus.test.mjs`, a fájl meglévő fixture-alakját
használva:

```js
test('readCatalog carries the samples, and an old project without them is not an error', () => {
  const dir = katalogusDir({ mintak: { cimlap: { sorok: ['a'] } } })
  assert.deepEqual(readCatalog(dir).mintak, { cimlap: { sorok: ['a'] } })
  // A Remotion project from before the samples existed still loads: the
  // module is one repo behind sometimes, and a missing sample costs a
  // picture, not the catalogue.
  const regi = katalogusDir({})
  assert.deepEqual(readCatalog(regi).mintak, {})
})

test('readCatalog refuses a samples field that is not an object of objects', () => {
  assert.throws(() => readCatalog(katalogusDir({ mintak: { cimlap: 'nem objektum' } })), /katalogus_ervenytelen/)
  assert.throws(() => readCatalog(katalogusDir({ mintak: ['lista'] })), /katalogus_ervenytelen/)
})
```

Futtasd: bukjon.

- [ ] **Step 2: `readCatalog` — a `mintak` beolvasása**

`katalogus.mjs`, a meglévő alakellenőrzés mintájára. A `mintak` **opcionális**:

```js
  // The samples are what makes a type viewable as a picture (spec 3.2). They
  // are OPTIONAL on purpose: this module and the Remotion project are two
  // repositories and one is sometimes a commit behind, and a catalogue
  // without samples must cost the gallery its pictures, not the whole page.
  // What is not optional is the shape: a type's sample is a plain object of
  // props or the file is refused, because a string or an array here would
  // reach `remotion still` as the scene's props.
  const mintak = Object.hasOwn(parsed, 'mintak') ? parsed.mintak : {}
  if (!plainObject(mintak)) refuse('katalogus_ervenytelen', 'a katalógus mintak mezője nem objektum')
  for (const tipus of Object.keys(mintak)) {
    if (!plainObject(mintak[tipus])) refuse('katalogus_ervenytelen', `a(z) ${tipus} típus mintája nem objektum`)
  }
  return { katalogusHash: sha256(text), tipusok: parsed.tipusok, propok: parsed.propok, leirasok: parsed.leirasok, kozosPropok: parsed.kozosPropok, mintak, file }
```

Futtasd a tesztet: zöld.

- [ ] **Step 3: A bukó teszt — a `templates` RPC kiadja a katalógust**

`extensions/video/test/rpc.test.mjs`:

```js
test('templates hands the page the catalogue itself, not only the numbers', async () => {
  const { rpc } = harness({ remotion: true })
  const r = await rpc.templates()
  assert.ok(r.tipusok.includes('cimlap'))
  assert.equal(typeof r.leirasok.cimlap, 'string')
  assert.ok(Array.isArray(r.propok.cimlap))
  assert.ok(Array.isArray(r.kozosPropok))
  assert.ok(r.kuldhetoTipusok.length > 0)
  // Which types have no sample is a fact the page shows on the card, so it
  // is answered here rather than inferred from an empty picture.
  assert.ok(Array.isArray(r.mintaHianyzik))
})

test('templates without a readable project still answers the weekly row and says the code', async () => {
  const { rpc } = harness({ remotion: false })
  const r = await rpc.templates()
  assert.equal(r.tipusok, null)
  assert.ok(typeof r.hiba === 'string')
  assert.ok(Array.isArray(r.hetiSor))
})
```

(A `harness` a fájl meglévő segédje; ha más a neve vagy más az alakja, azt
használd — ne írj újat.)

- [ ] **Step 4: A `templates` metódus bővítése**

`rpc.mjs`. **Az `import`-ok közé** kell a `KULDHETO_TIPUSOK`,
`NEM_KULDHETO_TIPUSOK` és `tablaHianyai` a `./kit-tabla.mjs`-ből:

```js
    /**
     * The catalogue as the page needs it: the numbers of spec 6.3, and the
     * vocabulary those numbers are about.
     *
     * Until now this answered only the statistics, which left the operator
     * knowing LESS about the templates than the agent does -- `videoCatalog`
     * hands the agent every type, its prose and its props. The gallery is
     * that same answer, drawn.
     *
     * A project that cannot be read still answers `hetiSor`: those numbers
     * come from stored rows and do not need the Remotion checkout. Every
     * catalogue-derived field is `null` in that case, never an empty list --
     * an empty `tipusok` would draw as "this kit has no templates".
     */
    async templates() {
      const { katalogus, hiba } = catalogOrCode(state)
      if (!katalogus) {
        return {
          hiba, katalogusHash: null, sablonStat: null, hetiSor: hetiSor(repo()),
          tipusok: null, leirasok: null, propok: null, kozosPropok: null,
          kuldhetoTipusok: null, nemKuldhetoTipusok: null, mintaHianyzik: null, tablaHianyok: null,
        }
      }
      return {
        hiba: null,
        katalogusHash: katalogus.katalogusHash,
        sablonStat: sablonStat(repo(), katalogus),
        hetiSor: hetiSor(repo()),
        tipusok: katalogus.tipusok,
        leirasok: katalogus.leirasok,
        propok: katalogus.propok,
        kozosPropok: katalogus.kozosPropok,
        kuldhetoTipusok: KULDHETO_TIPUSOK,
        nemKuldhetoTipusok: NEM_KULDHETO_TIPUSOK,
        mintaHianyzik: katalogus.tipusok.filter((t) => !Object.hasOwn(katalogus.mintak, t)),
        tablaHianyok: tablaHianyai(katalogus),
      }
    },
```

- [ ] **Step 5: A lap olvasója**

`ui/api.ts`: bővítsd a `Templates` típust és a `readTemplates` alakellenőrzést
a fenti mezőkkel. A meglévő olvasó mintáját kövesd — minden új mező vagy a
várt alak, vagy `null`; **egy rossz alakú mező nem dönti el az egész lapot**,
mert a `sablonStat` és a `hetiSor` attól még használható.

- [ ] **Step 6: Tesztek és commit**

```bash
cd extensions/video && npm test
git add extensions/video/src/katalogus.mjs extensions/video/src/rpc.mjs extensions/video/ui/api.ts extensions/video/test
git commit -m "The page gets the catalogue, not only its statistics"
```

---

### Task 3: Előnézet-generálás és gyorsítótár

**Files:**
- Create: `extensions/video/src/elonezet.mjs`
- Create: `extensions/video/test/elonezet.test.mjs`
- Modify: `extensions/video/src/rpc.mjs` (négy új metódus)
- Modify: `extensions/video/index.mjs` (ha az `elonezet` állapotot kell tárolni)

**Interfaces:**
- Consumes: `readCatalog(dir).mintak`, `remotionDirOf(state)`,
  `resolvingSpawn(state, spawn)` (`src/binaries.mjs`).
- Produces:
  - `ELONEZET_NEVTER = 'out/swarmclaw/sablon-elonezet'`
  - `elonezetDir(remotionDir, katalogusHash) -> string`
  - `allapot(state) -> { katalogusHash, meglevo, hianyzo, mintaNelkul, fut }`
  - `indit(state, spawnImpl?) -> { indult: true }` vagy refuse `mar_fut`
  - `megszakit() -> { megszakitva: boolean }`
  - `kep(state, tipus) -> { dataUrl } | { dataUrl: null, ok }`

**Kontextus.** A `render.mjs` már ugyanezt a bináris-feloldást használja
(`resolvingSpawn`, `spawnOptionsFor`), és ugyanezt a kimeneti névteret
(`OUT_NEVTER = 'out/swarmclaw'`). Ez a modul azt a mintát követi, nem újat.
Olvasd el a `render.mjs` `indit` függvényét, mielőtt írsz.

- [ ] **Step 1: A bukó tesztek**

`extensions/video/test/elonezet.test.mjs`. A spawn injektálva van, tehát a
tesztek nem indítanak böngészőt:

```js
test('a type outside the catalogue never reaches a path', async () => {
  const { state } = harness()
  const r = await kep(state, '../../../etc/passwd')
  assert.equal(r.dataUrl, null)
  assert.equal(r.ok, 'tipus_ismeretlen')
})

test('the cache is keyed by the catalogue hash, so a changed catalogue shows nothing stale', () => {
  const { state, dir } = harness()
  const elso = elonezetDir(dir, 'aaa')
  const masodik = elonezetDir(dir, 'bbb')
  assert.notEqual(elso, masodik)
  assert.ok(elso.startsWith(path.join(dir, 'out', 'swarmclaw', 'sablon-elonezet')))
})

test('a second start is refused by name rather than queued', async () => {
  const { state } = harness()
  const soha = () => fakeSpawn({ soha: true })   // nem lép ki
  await indit(state, soha)
  await assert.rejects(() => indit(state, soha), /mar_fut/)
})

test('one failing type does not stop the run, and its code lands on the type', async () => {
  const { state } = harness()
  const spawnImpl = fakeSpawn({ bukjon: ['lista'] })
  await indit(state, spawnImpl)
  const a = await allapot(state)
  assert.ok(a.hianyzo.includes('lista'))
  assert.ok(a.meglevo.length > 0, 'the run went on after the failure')
})

test('a type with no sample is reported as such, not as a render failure', async () => {
  const { state } = harness({ mintak: {} })
  const a = await allapot(state)
  assert.deepEqual(a.mintaNelkul.sort(), a.katalogusTipusok.sort())
})

test('old hash directories are swept, the last two kept', async () => { /* ... */ })
```

Írd meg a `harness`-t és a `fakeSpawn`-t a fájl tetején; a `render.mjs`
tesztjeiben van már spawn-dublőr, azt vedd mintának.

- [ ] **Step 2: `elonezet.mjs`**

A vezető docblock mondja ki, mi ez és mi nem:

```js
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { refuse } from './args.mjs'
import { resolvingSpawn } from './binaries.mjs'
import { readCatalog, remotionDirOf } from './katalogus.mjs'

/**
 * A picture of each scene type, and the cache it lives in.
 *
 * WHAT THIS IS NOT: a renderer. `fos-video` already draws any scene list
 * handed to it as input props (the Remotion project's own composition), so a
 * preview is a ONE-SCENE list built from the catalogue's sample, and this
 * file is the process call and the bookkeeping around it. Nothing here knows
 * how a scene is drawn, and that is the point: the kit changes in the other
 * repository and this file does not follow it.
 *
 * THE CACHE HAS NO INVALIDATION. Its key is the catalogue hash, so a changed
 * catalogue -- a new type, a reworded prop, a different sample -- is a
 * different directory, and the old pictures are simply never looked at
 * again. There is no rule to get wrong about when a picture is stale.
 *
 * IT NEVER RUNS BY ITSELF. A page load must not spawn twenty-four headless
 * browsers, so generation is a call the operator makes.
 */
export const ELONEZET_NEVTER = path.join('out', 'swarmclaw', 'sablon-elonezet')
/**
 * The frame taken out of the one-scene video.
 *
 * MEASURED, not chosen: at frame 60 `osszegzes`, `magyarazott`, `lista`,
 * `fordulat` and `cta` are still mid-animation and the picture shows a
 * half-built scene. Every one of the 24 types was rendered at both 60 and 85
 * while the samples were written; at 85 all of them have settled and none has
 * begun to leave. A gallery of half-drawn cards is worse than no gallery,
 * because it misreports what the template looks like.
 */
export const KOCKA = 85
/** The scene's visible length in frames, written here and never taken from a sample (spec 3.2). */
export const LATHATO_HOSSZ = 90
/** 1080x1920 scaled to 360x640: a card in a grid, not a poster. */
export const SKALA = 0.333
/** Hash directories kept when a run finishes: the current one and the one before it. */
export const MEGTARTOTT_HASHEK = 2
/** One still on a warm bundle measured 1.7s; a minute is a hang, not a slow machine. */
export const STILL_TIMEOUT_MS = 60_000
```

Ezután:

- `elonezetDir(remotionDir, hash)` — `path.join(remotionDir, ELONEZET_NEVTER, hash)`.
  A `hash` a `sha256` hexje, tehát útvonalban biztonságos; **mégis** ellenőrizd
  `/^[0-9a-f]{64}$/`-fel, mielőtt útvonalba kerül, és `refuse`-olj, ha nem az.
- `kepUt(dir, tipus)` — `path.join(dir, `${tipus}.png`)`, **csak azután**,
  hogy a `tipus` átment a `katalogus.tipusok.includes(tipus)` vizsgálaton.
- `allapot(state)` — beolvassa a katalógust, listázza a meglévő fájlokat,
  és három listát ad: `meglevo`, `hianyzo` (van minta, nincs kép),
  `mintaNelkul`. Plusz `fut` (a modulszintű futás állapota vagy `null`).
- `indit(state, spawnImpl = spawn)` — modulszintű `let futas = null` zár.
  Ha `futas !== null`, `refuse('mar_fut', 'már fut egy generálás')`.
  Egyébként sorosan végigmegy a `hianyzo` listán:
  props JSON ideiglenes fájlba, `npx remotion still src/index.ts fos-video
  <ki> --props=<p.json> --frame=85 --scale=0.333`, `cwd: remotionDir`,
  `spawnOptionsFor`-on át. Egy típus bukása a `futas.hibak[tipus]`-ba
  kerül a kilépési kóddal, és a menet **folytatódik**.
  A végén takarít (lásd lent), és `futas = null`.
- `megszakit()` — megjelöli a futást; a következő típus előtt megáll, a
  futó gyerekfolyamatot `kill`-eli. A már elkészült képek maradnak.
- `kep(state, tipus)` — `{ dataUrl: 'data:image/png;base64,...' }` vagy
  `{ dataUrl: null, ok: 'nincs_kep' | 'tipus_ismeretlen' | 'nincs_minta' }`.
- takarítás: a futás végén a `ELONEZET_NEVTER` alatti hash-mappákat
  mtime szerint rendezve az utolsó `MEGTARTOTT_HASHEK`-en túliakat törli.
  **Csak olyan mappát töröl, aminek a neve 64 hexjegy** — semmi mást, és
  soha nem a névtér gyökerét.

- [ ] **Step 3: A négy RPC-metódus**

`rpc.mjs`:

```js
    /** One template's picture as a data URL, or null with a code. The grid asks per card, as cards become visible. */
    async templatePreview(body = {}) {
      need(typeof body.tipus === 'string' && body.tipus.length <= 64, 'tipus: szöveg kell')
      return kep(state, body.tipus)
    },
    /** Starts the generation of every missing picture. Refuses a second run by name; it does not queue. */
    async templatePreviewStart() { return indit(state) },
    /** Where a run is, or null. The page polls this while a run is on. */
    async templatePreviewStatus() { return allapot(state) },
    /** Stops the run before the next type. What is already generated stays. */
    async templatePreviewCancel() { return megszakit() },
```

- [ ] **Step 4: Tesztek zöldek, commit**

```bash
cd extensions/video && npm test
git add extensions/video/src/elonezet.mjs extensions/video/src/rpc.mjs extensions/video/test/elonezet.test.mjs
git commit -m "A picture of each scene type, cached under the catalogue hash"
```

---

### Task 4: A galéria

**Files:**
- Modify: `extensions/video/ui/sablonok.tsx`
- Modify: `extensions/video/ui/style.css`
- Modify: `extensions/video/test/ui.test.mjs`

**Interfaces:**
- Consumes: a Task 2 `Templates` alakja, a Task 3 négy RPC-metódusa.

**Kontextus.** A mai `sablonok.tsx` `SablonokBody`-ra és `Sablonok`-ra van
osztva; a teszt a `Body`-t rendereli. Ez a felosztás marad.

- [ ] **Step 1: A szűrő-állapot külön modulban**

A szűrés tiszta függvény, tehát tesztelhető render nélkül. Vedd mintának
az `ui/idovonal-state.ts`-t, ami pontosan ezért létezik.

Create: `extensions/video/ui/sablon-szuro.ts`

```ts
export type Kuldhetoseg = 'mind' | 'kuldheto' | 'nem'
export type Hasznalat = 'mind' | 'hasznalt' | 'nem'
export type Elonezet = 'mind' | 'van' | 'nincs'

export interface Szuro {
  kereses: string
  kuldhetoseg: Kuldhetoseg
  hasznalat: Hasznalat
  elonezet: Elonezet
}

export const URES_SZURO: Szuro = { kereses: '', kuldhetoseg: 'mind', hasznalat: 'mind', elonezet: 'mind' }

/**
 * Accent-insensitive, case-insensitive normalisation.
 *
 * The catalogue's prose is Hungarian and the operator types Hungarian, but
 * the prose in `katalogus.generated.json` is written without accents while a
 * search for "atvezeto" and one for "átvezető" must find the same card. NFD
 * splits a letter from its accent and the range strips the accents.
 */
export const normal = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** The types that pass every filter, in the catalogue's own order. */
export function szurtTipusok(...): string[] { /* ... */ }
```

A `szurtTipusok` a keresést a **típusnévben, a leírásban és a propnevekben**
futtatja, és a négy szűrőt ÉS-sel köti.

- [ ] **Step 2: A szűrő tesztjei**

`test/ui.test.mjs`-be, a `idovonal-state` tesztjei mellé: ékezet-érzéketlen
keresés, propnévre keresés, a három hármas állás, és hogy üres szűrővel
minden típus megmarad, az eredeti sorrendben.

- [ ] **Step 3: A galéria felépítése**

`sablonok.tsx`. A `SablonokBody` kap egy szűrő-sort, egy rácsot és a mai
két táblázatot alatta. Kártyánként: kép (vagy jelölt üres keret), típusnév,
leírás, `használat: N`, `nem küldhető` jelölés. A kártya `<button>`, ami
kinyitja a részletpanelt.

**A kép lustán töltődik.** Egy `IntersectionObserver` figyeli a kártyát, és
csak láthatóvá váláskor hívja a `templatePreview`-t. Az `observer` nincs a
szerver-renderben, tehát a `Body` képek nélkül is teljes értékű — a teszt
ezt rendereli.

**A rács fölött mindig ott a `látható/összes` szám.**

- [ ] **Step 4: A generáló gomb**

A nézet tetején: `Előnézetek generálása (N hiányzik)`. Futás közben a
gomb helyén a haladás (`7/24 — kartya-csere`) és egy `Megszakít`. A lap
2 másodpercenként hívja a `templatePreviewStatus`-t, amíg fut.

A gomb **le van tiltva**, ha `templates.hiba !== null`, vagy ha a health
szerint `npx` hiányzik.

- [ ] **Step 5: A nézet tesztjei**

A `SablonokBody`-t renderelve: 24 kártya; egy szűrő szűkít és a szám követi;
a `nincs_minta` a kártyán jelenik meg és nem hibaként; katalógus-hiba
esetén a kód áll ott és nem üres rács; a heti sor akkor is megvan.

- [ ] **Step 6: CSS**

`ui/style.css`: rács (`grid-template-columns: repeat(auto-fill, minmax(150px, 1fr))`),
kártya, 9:16 arányú képkeret, üres keret jelölése, szűrősor. A meglévő
`--color-*` változókat használd, ne új színeket.

- [ ] **Step 7: Tesztek, build, commit**

```bash
cd extensions/video && npm test && npm run build
git add extensions/video/ui extensions/video/test/ui.test.mjs
git commit -m "The templates view becomes a gallery you can filter"
```

---

### Task 5: Élesben

**Files:** nincs új; ez a feladat ellenőriz.

- [ ] **Step 1: Telepítés a futó appba**

```bash
cd extensions/video && npm run build && npm run install:local
```

- [ ] **Step 2: Generálás fejetlenül**

Futtasd a Task 3 `indit`-ját a telepített munkakönyvtárból, valódi
`spawn`-nal, és mérd az időt. Elvárt: 24 kép a
`<remotionDir>/out/swarmclaw/sablon-elonezet/<hash>/` alatt.

- [ ] **Step 3: Nézd meg a képeket**

Olvass be legalább hatot a `Read` eszközzel. Egy üres vagy fekete kép hiba,
akkor is, ha a folyamat 0-val lépett ki — jelentsd, melyik típus az.

- [ ] **Step 4: Jelentés**

Írd meg: hány kép készült, mennyi idő alatt, melyik típusnak nincs mintája,
melyik bukott, és mit lát az operátor a lapon.
