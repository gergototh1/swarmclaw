# A kész render megnézése a lapon

**Cél:** az operátor a videó adatlapján megnézze a kész rendert, ott, ahol a
visszajelzést írja róla — ne kelljen Finderben megkeresnie egy fájlt, hogy
utána visszajöjjön ide gépelni.

---

## 1. Mit old meg, és mit nem

A lap ma szövegként mutatja a render kimeneti útját (`ui/video.tsx`,
`vid-path`), és tudatosan nem linkként: a `safeHref` egy `file:` url-t amúgy
is visszautasítana. Az operátor tehát kimásolja az utat, megnyitja a
Finderben, megnézi a videót, visszajön a lapra, és fejből írja le, mi a baj
vele — a huszonharmadik másodpercben.

A javítás-kérés (`doc/specs/2026-09-06-celzott-javitas-design.md`) ezt a
munkát tette a lap közepévé: a kérés jelenetre és időpontra szólhat, és az
idővonalra kattintva töltődik ki mindkettő. Csak épp a videó, amiről szól,
nincs ott.

**Amit ez megold:** lejátszó a videó adatlapján, a legfrissebb kész renderre,
és egy gomb, ami a lejátszó pillanatnyi állásából tölti ki a visszajelzés
időpontját.

**Amit NEM old meg:** a jeleneten belüli szerkesztést, a több render
összehasonlítását, a letöltést és a megosztást. A narrációs mp3-ak külön
lejátszását sem — a hang a videóban benne van.

---

## 2. A hoston kell változtatni, és miért

A bővítmény nem tud fájlt kiszolgálni: a saját asset-útvonala csak a
`dist/`-jét adja (`src/app/api/extensions/[id]/assets/[...path]/route.ts`),
és bővítmény nem vehet fel új route-ot. A hostnak viszont **van** ilyen
útvonala: `GET /api/files/serve?path=…`. Három dolog hiányzik belőle.

| ma | miért baj | mi lesz |
|---|---|---|
| `MAX_SIZE = 10 MB` | a 12,2 MB-os renderünk **413**-at kap | a média streamel, nem egyben olvasódik; a 10 MB-os korlát a NEM-média ágon marad |
| nincs `.mp4` a `MIME_MAP`-ben | `application/octet-stream` + `Content-Disposition: attachment` → letölt, nem játszik le | `video/mp4`, `video/webm`, `video/quicktime`, és `inline` |
| `readFileSync` az egész fájlra | 12 MB a memóriában kérésenként, és nincs tekerés | `fs.createReadStream` a kért tartományra |
| nincs `Range` | a `<video>` `bytes=0-`-t küld és `206`-ot vár; e nélkül nincs tekerés, és egyes böngészők el sem indítják | `206 Partial Content`, `Content-Range`, `Accept-Ranges: bytes` |

**A hitelesítés megvan, és ez dönti el, hogy működik-e.** A host a
**sütit** is elfogadja, nem csak az `x-access-key` fejlécet
(`src/proxy.ts:294-296`). Egy `<video src="/api/files/serve?path=…">` elem
nem tud fejlécet küldeni — de ugyanazt a sütit viszi, amivel a lap
betöltődött, tehát átjut.

### Amit ez kinyit, és amit nem

Ma bárki, akinek megvan az auth sütije, elolvashat ezen az útvonalon
**bármilyen** fájlt a gépről 10 MB-ig. Ez nem ennek a specnek a döntése; ez
az útvonal mai állapota.

A változás annyi: **médiakiterjesztésű** fájlok mérethatár nélkül
olvashatóvá válnak. Nem szélesedik, hogy MELY fájlok érhetők el — a
`blocked` lista (`.env`, `credentials`, `.ssh`, `.gnupg`, `.aws`) és a
`resolveWorkspacePath` érintetlen. A `MAX_SIZE` eredeti dolga a memória
védelme volt (`readFileSync`), és azt a stream jobban végzi: a válasz a kért
tartományhoz kötött, nem a fájl méretéhez.

---

## 3. A lapon

A lejátszó a jobb oszlop tetejére kerül, **az idővonal és a visszajelzés
fölé**. A sorrend a munka sorrendje: megnézed, megjelölöd a pillanatot,
megírod, mi a baj vele.

**Melyik rendert játssza:** a legfrissebb **kész** rendert — pontosan azt,
amit az idővonal is használ (`video.renderek.find(r => r.status === 'kesz')`).
Egy futó render fájlja félkész, és a jelenethatárai sincsenek még kiírva.

**Három különböző tény, három különböző mondat:**

- nincs kész render → *"Nincs kész render, így nincs mit lejátszani."*
- a sor szerint a fájlt a Tisztítás törölte (`torolveAt`) → a törlés
  időpontjával, mert az más teendő: újra kell renderelni
- a sor szerint megvan, de a host nem adja ki (a `<video>` `error`
  eseménye) → *ez a harmadik tény*, és a mondat kimondja, hogy a sor
  szerint ott kellene lennie

**A pillanat átvétele.** A lejátszó alatt egy gomb: **Ezt a pillanatot**.
Kitölti a visszajelzés `Időpont (ms)` mezőjét a lejátszó `currentTime`-jából.
Ez tudatos hozzáadás a puszta „nézzem meg"-hez: a mező már ma is létezik és
az idővonalról töltődik, és az operátor épp azért néz videót, hogy megmondja,
melyik pillanatban van a baj. A jelenet mezőt is kitölti, ha a kész render
jelenethatárai megmondják, melyik jelenetbe esik az a pillanat — ugyanaz az
adat, amiből az idővonal rajzol.

---

## 4. Amit nem építünk

- **Nincs letöltés-gomb.** A fájl útja ott van szövegként, és a Finder egy
  kattintás.
- **Nincs poszter-kép, nincs saját vezérlő.** A böngésző natív `controls`
  attribútuma elég; egy saját lejátszó-felület a kit dolga lenne.
- **Nincs több render összehasonlítása.** A régebbi renderek sorai
  megmaradnak a Renderek szekcióban, útvonallal; ha valaha kell, az külön
  kérés.
- **Nincs hang-lejátszó a narrációs mp3-akhoz.** A hang a videóban van.

---

## 5. Fájlok

- Módosít: `src/app/api/files/serve/route.ts` (média MIME, Range, stream)
- Módosít: `extensions/video/ui/video.tsx`, `ui/style.css`
- Tesztek: `src/app/api/files/serve/route.test.ts` (ha nincs, létrejön),
  `extensions/video/test/ui.test.mjs`
