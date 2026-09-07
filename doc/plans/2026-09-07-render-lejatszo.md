# A kész render megnézése a lapon — kivitelezési terv

> **Végrehajtóknak:** KÖTELEZŐ AL-SKILL: `superpowers:subagent-driven-development`
> vagy `superpowers:executing-plans`. A lépések `- [ ]` jelölésűek, tickeld őket.

**Cél:** az operátor a videó adatlapján megnézze a kész rendert, ott, ahol a
visszajelzést írja róla.

**Spec:** `doc/specs/2026-09-07-render-lejatszo-design.md`

**Architektúra:** a host fájlkiszolgáló útvonala megtanul médiát streamelni
`Range`-dzsel; a lap egy `<video>` elemet tesz a jobb oszlop tetejére, ami
ugyanazzal a sütivel jut át, amivel a lap betöltődött.

## Global Constraints

- **Három különböző tény három különböző állapot.**
- **Az elutasítás MEGNEVEZETT**: mondat, ami megmondja, mi a teendő. A
  „sikertelen" szó nem fordul elő ebben az ágban.
- **Egy sötét vezérlő megindokolja magát**, látható szövegként, nem `title=`-ben.
- **Idegen és operátori szöveg adat**: React text child, soha nem kulcs, nem
  útvonal, nem log-sor, és `href`-be csak `safeHref`-en át.
- **Nincs `any`, nincs lint-elnyomás.** Magyar operátor-szöveg, `vid-` prefix.
- **A kommentek a MIÉRT-et mondják el**, ennek a kódbázisnak a regiszterében.
- **Kapuk:** `npm run test:runtime` (vagy a módosított fájlokra szűkítve),
  `npm test` az `extensions/video`-ban, `npx eslint <a módosított fájlok>` a
  repo gyökeréből, `npx tsc --noEmit` az `extensions/video`-ban,
  `npm run build` az `extensions/video`-ban, `npm run lint:baseline` a gyökérből.
- **Minden feladat végén commit.** Üzenet fájlból (`git commit -F`), rövid
  felszólító tárgysor, prózai törzs a MIÉRT-ről, és pontosan ez a két trailer:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01Y91TwoyBNxgwYjS7sTsB7Y`
- **Nincs push. Nincs dev-szerver. A telepített appot nem érintjük.**

---

## Feladat 1: a host kiszolgálja a médiát

**Files:**
- Modify: `src/app/api/files/serve/route.ts`
- Create: `src/app/api/files/serve/route.test.ts`
- Modify: `package.json` (a `test:runtime` sor)

**Interfaces (amit a 2. feladat használ):**
- `GET /api/files/serve?path=<abszolút út>` egy `.mp4`/`.webm`/`.mov`/`.m4v`
  fájlra: `200` teljes törzzsel, vagy `Range` fejléc esetén `206` +
  `Content-Range`. Mindkettőn `Accept-Ranges: bytes` és
  `Content-Disposition: inline`.

- [ ] **1.1 Vedd fel az új tesztfájlt a `test:runtime` listába.** A
`package.json` `test:runtime` szkriptje MINDEN tesztfájlt névvel sorol fel;
ami nincs benne, az soha nem fut. Tedd a
`src/app/api/files/serve/route.test.ts`-t a szomszédos
`src/app/api/search/route.test.ts` mellé.

- [ ] **1.2 Írd meg a bukó teszteket.** A minta a
`src/app/api/extensions/[id]/assets/route.test.ts`: `node:test`, és a route-ot
importálva hívja, ideiglenes könyvtárral. Nézd meg, mielőtt írsz.

```ts
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { GET } from './route'

/** Egy ideiglenes mp4, amit a route kiszolgálhat. A tartalom nem videó -- a route bájtokat mozgat, nem dekódol. */
function tempMp4(bytes: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-'))
  const file = path.join(dir, 'video.mp4')
  fs.writeFileSync(file, Buffer.alloc(bytes, 7))
  return file
}

const kerd = (file: string, range?: string) =>
  GET(new Request(`http://localhost/api/files/serve?path=${encodeURIComponent(file)}`,
    range ? { headers: { range } } : undefined))

describe('files/serve media', () => {
  it('egy mp4-et lejátszhatóként ad ki, nem letöltésként', async () => {
    const res = await kerd(tempMp4(1024))
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'video/mp4')
    assert.equal(res.headers.get('content-disposition'), 'inline')
    assert.equal(res.headers.get('accept-ranges'), 'bytes')
    assert.equal(res.headers.get('content-length'), '1024')
  })

  it('a 10 MB-os korlát nem áll a médiára -- ezért nem lehetett eddig megnézni a rendert', async () => {
    const res = await kerd(tempMp4(12 * 1024 * 1024))
    assert.equal(res.status, 200, 'ez 413 volt, és emiatt nem indult el a lejátszó')
  })

  it('a 10 MB-os korlát a NEM-médiára megmarad', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-'))
    const file = path.join(dir, 'nagy.txt')
    fs.writeFileSync(file, Buffer.alloc(11 * 1024 * 1024, 65))
    const res = await GET(new Request(`http://localhost/api/files/serve?path=${encodeURIComponent(file)}`))
    assert.equal(res.status, 413)
  })

  it('Range-re 206-tal és a kért szelettel válaszol', async () => {
    const res = await kerd(tempMp4(1000), 'bytes=100-199')
    assert.equal(res.status, 206)
    assert.equal(res.headers.get('content-range'), 'bytes 100-199/1000')
    assert.equal(res.headers.get('content-length'), '100')
    assert.equal((await res.arrayBuffer()).byteLength, 100)
  })

  it('nyitott végű Range a fájl végéig tart -- ezt küldi a <video> először', async () => {
    const res = await kerd(tempMp4(1000), 'bytes=0-')
    assert.equal(res.status, 206)
    assert.equal(res.headers.get('content-range'), 'bytes 0-999/1000')
  })

  it('a fájl végén túli Range 416-ot ad, a méretet megnevezve', async () => {
    const res = await kerd(tempMp4(1000), 'bytes=5000-6000')
    assert.equal(res.status, 416)
    assert.equal(res.headers.get('content-range'), 'bytes */1000')
  })

  it('értelmezhetetlen Range-et nem talál ki: a teljes fájlt adja 200-zal', async () => {
    const res = await kerd(tempMp4(1000), 'bytes=abc')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-length'), '1000')
  })

  it('a tiltott útvonalak a médiára is tiltottak maradnak', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-'))
    fs.mkdirSync(path.join(dir, '.ssh'))
    const file = path.join(dir, '.ssh', 'titok.mp4')
    fs.writeFileSync(file, Buffer.alloc(16, 7))
    const res = await GET(new Request(`http://localhost/api/files/serve?path=${encodeURIComponent(file)}`))
    assert.equal(res.status, 403)
  })
})
```

- [ ] **1.3 Futtasd, és nézd meg, hogy BUKIK.**

Futtatás: `npx tsx --test src/app/api/files/serve/route.test.ts`
Várt: a média-tesztek buknak — `application/octet-stream`, `attachment`,
`413` a 12 MB-osra, és nincs `206`.

- [ ] **1.4 Írd meg a route-ot.** A meglévő szerkezet marad (paraméter,
`resolveWorkspacePath`, `blocked`, `statSync`); a méret-ellenőrzés és a
kiszolgálás ága kettéválik.

```ts
/**
 * A média-kiterjesztések: ezeken a válasz STREAMEL, és nem áll rájuk a
 * MAX_SIZE.
 *
 * MIÉRT NEM A MÉRETKORLÁT VÉDI ŐKET. A MAX_SIZE dolga a memória volt: a
 * `readFileSync` az egész fájlt beolvassa, tehát egy nagy fájl egy kérésenként
 * annyi memóriát kötött le. Egy streamnél a válasz a KÉRT tartományhoz
 * kötött, nem a fájl méretéhez, tehát a korlát azt már nem véd.
 *
 * AMIT NEM SZÉLESÍT. Hogy MELY fájlok érhetők el, azt a `blocked` lista és a
 * `resolveWorkspacePath` dönti el, és egyik sem változik. A médiának csak a
 * mérethatára tűnik el -- egy 12 MB-os render azért nem volt megnézhető, mert
 * két megabájttal átlépte.
 */
const MEDIA_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
}

/**
 * A `Range` fejléc egyetlen bájt-tartománya, vagy null.
 *
 * NULL HÁROM KÜLÖNBÖZŐ OKBÓL, ÉS MINDHÁROM UGYANAZT JELENTI ITT: nincs
 * fejléc, nem `bytes=` alakú, vagy több tartományt kér (`bytes=0-9,20-29`).
 * A hívó mindháromra a teljes fájlt adja 200-zal, mert egy tartomány, amit
 * ez a route nem ért, nem tartomány, amit kitalálhat: a `<video>` úgyis
 * újrakérdez, ha a szerver nem darabol.
 *
 * A `bytes=-500` (az utolsó 500 bájt) benne van, mert azt a böngészők
 * tényleg küldik.
 */
function bajtTartomany(fejlec: string | null, meret: number): { start: number; end: number } | null {
  if (!fejlec) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(fejlec.trim())
  if (!m) return null
  const [, nyersStart, nyersEnd] = m
  if (nyersStart === '' && nyersEnd === '') return null
  if (nyersStart === '') {
    const hossz = Number(nyersEnd)
    if (!Number.isSafeInteger(hossz) || hossz <= 0) return null
    return { start: Math.max(0, meret - hossz), end: meret - 1 }
  }
  const start = Number(nyersStart)
  if (!Number.isSafeInteger(start)) return null
  const end = nyersEnd === '' ? meret - 1 : Number(nyersEnd)
  if (!Number.isSafeInteger(end)) return null
  return { start, end: Math.min(end, meret - 1) }
}
```

és a `GET` végén, a `stat.isFile()` ellenőrzés UTÁN:

```ts
  const ext = path.extname(resolved).toLowerCase()
  const mediaType = MEDIA_MIME[ext] ?? null

  if (mediaType) {
    const tartomany = bajtTartomany(req.headers.get('range'), stat.size)
    // A fájl végén túli kérés a HTTP saját válaszát kapja, a mérettel: e
    // nélkül a <video> egy üres 206-ot kapna és a lejátszás megállna anélkül,
    // hogy bárki megtudná, miért.
    if (tartomany && (tartomany.start >= stat.size || tartomany.start > tartomany.end)) {
      return new NextResponse(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } })
    }
    const start = tartomany ? tartomany.start : 0
    const end = tartomany ? tartomany.end : stat.size - 1
    const stream = fs.createReadStream(/*turbopackIgnore: true*/ resolved, { start, end })
    return new NextResponse(stream as unknown as ReadableStream, {
      status: tartomany ? 206 : 200,
      headers: {
        'Content-Type': mediaType,
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
        'Content-Disposition': 'inline',
        ...(tartomany ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {}),
      },
    })
  }

  if (stat.size > MAX_SIZE) {
    return NextResponse.json({ error: 'File too large' }, { status: 413 })
  }
```

**Ellenőrizd magad, ne a tervet:** a `NextResponse` konstruktora Node-stream
törzset elfogad-e ebben a Next-verzióban. Ha nem, `Readable.toWeb(stream)` a
`node:stream` modulból az áthidalás. A `as unknown as` cast a tervben egy
javaslat, nem parancs — ha van tisztább alak, azt írd, és mondd meg, miért.

- [ ] **1.5 Futtasd: a nyolc tesztnek át kell mennie.** Utána a teljes
`npm run test:runtime` (vagy legalább a route-teszt + `src/proxy.test.ts`).

- [ ] **1.6 Kapuk és commit.**

---

## Feladat 2: a lejátszó a lapon

**Files:**
- Modify: `extensions/video/ui/video.tsx`, `ui/style.css`
- Modify: `extensions/video/test/ui.test.mjs`

**Interfaces:**
- Consumes: az 1. feladat route-ja.
- `RenderRow` már hordozza: `outPath`, `status`, `torolveAt`, `jelenetHatarok`.

- [ ] **2.1 Írd meg a bukó teszteket** a `test/ui.test.mjs`-be, a meglévő
`mount` / `stubRpc` / `settle` harnesszel. NE építs másodikat.

```js
test('a kész render lejátszója a forrás útjából épül, és a lap sütijével jut át', () => {
  const html = renderBody(videoDetail({
    renderek: [{ ...keszRenderSor(), outPath: '/out/sw/v/r1/video.mp4' }],
  }))
  assert.ok(html.includes('/api/files/serve?path=%2Fout%2Fsw%2Fv%2Fr1%2Fvideo.mp4'), 'az útvonal kódolva megy a query-be')
  assert.ok(/<video[^>]*controls/.test(html))
})

test('nincs kész render: a lejátszó helyén az az egy mondat áll', () => {
  const html = renderBody(videoDetail({ renderek: [] }))
  assert.ok(html.includes('Nincs kész render, így nincs mit lejátszani.'))
  assert.equal(/<video/.test(html), false)
})

test('a Tisztítás által törölt fájl más tény, mint a hiányzó render', () => {
  const html = renderBody(videoDetail({
    renderek: [{ ...keszRenderSor(), torolveAt: '2026-09-07T10:00:00.000Z' }],
  }))
  assert.ok(html.includes('A render fájljait a Tisztítás törölte'))
  assert.equal(/<video/.test(html), false)
  assert.equal(html.includes('Nincs kész render'), false, 'a két mondat nem cserélhető fel')
})

test('a futó render fájlja nem játszható le: a lejátszó a legfrissebb KÉSZ renderre néz', () => {
  const html = renderBody(videoDetail({
    renderek: [{ ...keszRenderSor(), renderId: 'r-fut', status: 'fut', outPath: '/out/fut.mp4' },
               { ...keszRenderSor(), renderId: 'r-kesz', outPath: '/out/kesz.mp4' }],
  }))
  assert.ok(html.includes('kesz.mp4'))
  assert.equal(html.includes('fut.mp4'), false)
})
```

`keszRenderSor()` segédet a fájl meglévő `videoDetail` fixture-mintájából
építsd; ha már van ilyen alakú helper, azt használd.

- [ ] **2.2 Futtasd, és nézd meg, hogy BUKIK.**

Futtatás: `cd extensions/video && npx tsx --test test/ui.test.mjs`
Várt: nincs `<video>` a kimenetben.

- [ ] **2.3 Írd meg a lejátszó szekciót**, a jobb oszlop tetejére, az
`Idővonal` elé. A sorrend a munka sorrendje: megnézed, megjelölöd a
pillanatot, megírod, mi a baj.

```tsx
/**
 * A kész render fájljának url-je a host saját kiszolgáló útvonalán.
 *
 * MIÉRT MEHET EZ EGY `src`-BE, AMIKOR A LAP MINDEN MÁS ÚTVONALAT SZÖVEGKÉNT
 * MUTAT. A `vid-path` mezők azért szövegek, mert egy `file:` url-t a
 * `safeHref` visszautasít, és joggal: az a böngészőt küldené a lemezre. Ez
 * nem az: ez a host saját, azonos eredetű api-ja, ugyanaz, amit a lap minden
 * más hívása használ, és az `outPath` a modul saját sora, nem idegen szöveg.
 * `encodeURIComponent`, mert egy útvonalban lehet `?`, `&` és `#`.
 */
function renderUrl(outPath: string): string {
  return `/api/files/serve?path=${encodeURIComponent(outPath)}`
}
```

A szekció három állapota — és ez a lényeg: **három különböző tény, három
különböző mondat**, egyik sem a másik helyett:

```tsx
<Szekcio cim="Videó">
  {keszRender === null
    ? <p className="vid-sec-ures">Nincs kész render, így nincs mit lejátszani.</p>
    : keszRender.torolveAt !== null
      ? <p className="vid-sec-ures">A render fájljait a Tisztítás törölte ({formatDate(keszRender.torolveAt)}); a megnézéséhez újra kell renderelni.</p>
      : keszRender.outPath === null
        ? <p className="vid-sec-ures">Ezen a render-soron nincs kimeneti út, így nincs mit lejátszani.</p>
        : (
          <>
            <video className="vid-lejatszo" controls preload="metadata" src={renderUrl(keszRender.outPath)} ref={videoRef} />
            <p className="vid-sec-lab">{lejatszoHiba ?? 'A sor szerinti fájl, a host kiszolgálóján át.'}</p>
          </>
        )}
</Szekcio>
```

A negyedik tény a `<video>` `onError`-jából jön: a sor szerint ott a fájl, de
a host nem adja ki. **Ez nem ugyanaz, mint a törlés** — a törlést a modul
tudja, ezt nem —, és a mondat mondja ki, hogy a sor szerint ott kellene
lennie.

- [ ] **2.4 A pillanat átvétele.** A lejátszó alá egy gomb, ami a
`currentTime`-ból tölti a visszajelzés `Időpont (ms)` mezőjét, és — ha a kész
render `jelenetHatarok`-ja megmondja, melyik jelenetbe esik — a `Jelenet`
mezőt is. Ugyanaz az `onPick` callback, amit az idővonal hív, tehát nincs
második út ugyanahhoz az állapothoz:

```tsx
const onPillanat = useCallback(() => {
  const el = videoRef.current
  if (!el) return
  const atMs = Math.round(el.currentTime * 1000)
  const hatar = keszRender?.jelenetHatarok.find((h) => atMs >= h.kezdetMs && atMs < h.vegMs) ?? null
  onPick({ atMs, jelenet: hatar ? hatar.jelenet : null })
}, [onPick, keszRender])
```

A gomb sötét, ha nincs mit lejátszani — és megmondja, miért, a `Lepes`-sel,
ahogy a lap minden más sötét vezérlője.

- [ ] **2.5 CSS.** `.vid-lejatszo { width: 100%; max-width: 360px; border-radius: …; background: #000 }` — 9:16 videó, tehát a szélesség korlátozása a lényeg, különben egy álló videó kitolja az oszlopot. Nézd meg a `style.css` meglévő értékeit, és azokhoz igazodj.

- [ ] **2.6 Futtasd: a négy tesztnek át kell mennie**, plusz a teljes suite.

- [ ] **2.7 Kapuk és commit.**

---

## Sorrend és miért

**1 → 2.** A lap lejátszója egy url, ami a route nélkül 413-at ad; a route
viszont önmagában is igazolható, és a 2. feladat tesztje nem a hoston fut.

## Amit ez a terv nem old meg

- A letöltést, a poszter-képet, a saját vezérlőt, több render
  összehasonlítását és a narrációs mp3-ak külön lejátszását — mind a spec 4.
  szakaszában, indoklással.
- Azt, hogy a `resolveWorkspacePath` bármely létező abszolút utat elfogad.
  Ez az útvonal mai állapota, nem ennek a specnek a döntése.
