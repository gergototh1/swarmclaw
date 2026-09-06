# Sablon-galéria: a jelenettípusok megnézhetők és szűrhetők

**Cél:** a videó modul „Sablonok" nézete ne csak számokat mutasson, hanem a
katalógus mind a 24 jelenettípusát: mit csinál, milyen propjai vannak,
JSON-ból küldhető-e — és egy valódi, Remotionnal renderelt állóképet
mindegyikről. Szűrhetően.

## 1. Miért nem elég a mai nézet

`ui/sablonok.tsx` ma a `templates` RPC-t hívja, ami hármat ad vissza:
`sablonStat` (típusonkénti használat / lektori találat / QA-bukás /
visszajelzés / megtartás), `hetiSor`, és a katalógus hash-e. A katalógus
`tipusok`, `leirasok`, `propok`, `kozosPropok` mezői **nem jutnak el a
böngészőig** — pedig a `videoCatalog` tool már mindet kiadja az ügynöknek.

Az operátornak tehát ma kevesebb információja van a sablonokról, mint az
ügynöknek. Ez a specifikáció ezt fordítja meg.

## 2. Mit lát az operátor

Egy rácsba rendezett kártyalista, kártyánként:

- az állókép (a típus egyetlen jelenetként renderelve, 360×640),
- a típus neve,
- a `leirasok[tipus]` mondata — mikor kell ezt a jelenetet használni,
- a kötelező és opcionális propok neve, `mit` szövegükkel lenyitva,
- a `nem küldhető` jelölés, ha a kit-tábla szerint valamelyik propja
  React-csomópont,
- a mai statisztika-oszlopok tömören: használat, megtartás.

A kártyára kattintva nyílik a részletes panel: minden prop `mit` szövege,
a közös propok, és a típusra vonatkozó számok teljes bontása (lektori
találat kódonként, QA-bukás, visszajelzés).

A heti sor táblázata a nézet alján marad, változatlanul.

### 2.1 Szűrők

Egy soron, a rács fölött:

| szűrő | alak | mit tesz |
|---|---|---|
| keresés | szövegmező | a típusnévben, a leírásban és a propnevekben keres, kisbetűre normalizálva, ékezet-érzéketlenül |
| küldhetőség | három állás: mind / csak küldhető / csak nem küldhető | a `kuldhetoTipusok` lista szerint |
| használat | három állás: mind / használt / nem használt | `sablonStat[tipus].hasznalat > 0` |
| előnézet | három állás: mind / van kép / nincs kép | a gyorsítótár állapota szerint |

A szűrők **és** kapcsolatban állnak. A rács fölött mindig ott a
`látható/összes` szám, hogy egy üres rács ne legyen összetéveszthető egy
üres katalógussal.

A szűrők állapota nem tárolódik: az oldal elhagyásával elveszik. Nincs
olyan panasz, amit egy megjegyzett szűrő megoldana, viszont egy megjegyzett
szűrő az, ami miatt egy típus „eltűnik" a következő látogatáskor.

## 3. Az állóképek

### 3.1 Nem kell új kompozíció

A Remotion-projektben a `fos-video` kompozíció (`src/FosVideo.tsx`) a
jelenetlistát **input propból** kapja, és a hosszát is abból számolja
(`fosVideoMetadata`). Egy előnézet ezért egy egyelemű jelenetlista:

```
npx remotion still src/index.ts fos-video <out.png> \
  --props=<props.json> --frame=<n> --scale=0.333
```

Ez ugyanaz a hívási alak, amit `src/render.mjs:399` már használ
(`npx remotion render src/index.ts fos-video …`), tehát ugyanaz a
bináris-feloldás és ugyanaz a PATH-kezelés vonatkozik rá.

**A Remotion-projektbe nem kerül új kompozíció, új komponens és új
kimeneti mappa.** Ez tartja a „a remotion maradjon külön" döntést.

### 3.2 Honnan jönnek a mintaadatok

A katalógus megmondja, hogy a `cimlap` típusnak van egy kötelező `sorok`
propja, és hogy az „a horog sorai, sorrendben" — de **nem** mondja meg,
hogy mi legyen benne. Egy kép rendereléséhez konkrét érték kell.

A mintaértékek a **Remotion-projekt szótárába** kerülnek, a leírás mellé:
`src/kit/szotar.ts` minden `JELENETEK` eleme kap egy `minta` mezőt, és a
`scripts/katalogus-emit.ts` kiadja a `katalogus.generated.json`-be.

Miért ott, és nem a SwarmClaw oldalán:

1. **Fordításkor ellenőrzött.** A szótár `propok` listái ma `satisfies`-szal
   a valódi prop-típusokhoz vannak kötve; egy elírt propnév `tsc --noEmit`-en
   elbukik. A `minta` ugyanígy köthető: egy hibás mintaérték fordítási hiba,
   nem egy néma fekete kép hónapokkal később.
2. **Nincs második fájl.** A `szotar.ts` saját docblockja pontosan ezt írja
   elő: *„Egy helyen a nev es a mondat: nincs kulcs, nincs masodik fajl,
   nincs mit szinkronban tartani."* Egy SwarmClaw-oldali mintatábla
   ugyanaz a második fájl lenne, csak most propértékekre.
3. **A gyorsítótár ingyen ürül.** A minta a katalógusfájl része, tehát
   `katalogusHash` alá esik. Ha egy minta változik, a hash változik, és a
   §3.3 kulcsa miatt a kép magától újragenerálódik.

Ez a specifikáció egyetlen változtatása a Remotion-projektben, és additív:
egy új opcionális mező a szótárban, egy sor a kiadó scriptben.

Ahol egy típus JSON-ból nem küldhető (React-csomópont propja van), ott a
`minta` a küldhető propokat adja meg, a React-csomópontot nem — a kép a
típus küldhető alakját mutatja, mert az ügynök is csak azt tudja megépíteni.

### 3.3 Gyorsítótár

A kép a bővítmény munkakönyvtárában él, nem a Remotion-projektben:

```
<workspace>/sablon-elonezet/<katalogusHash>/<tipus>.png
```

A `katalogusHash` a kulcsban azt jelenti, hogy a katalógus bármely
változása — új típus, átírt prop, átírt minta — új mappát nyit, és a régi
képeket senki nem nézi meg többé. Nincs invalidálandó gyorsítótár: van egy
mappa, ami vagy megvan, vagy nincs.

A régi hash-mappákat a generálás végén takarítja a modul, a legutóbbi
kettőt megtartva (egy Remotion-oldali visszavonás után ne kelljen újra
rendereltetni).

### 3.4 Mikor generálódik

**Soha nem magától.** A rácsban a kép nélküli kártyák helyén egy jelölt
üres keret áll, a nézet tetején pedig egy gomb: „Előnézetek generálása
(N hiányzik)".

Miért nem automatikusan: egy `remotion still` hívás bundle-t épít és egy
fejetlen böngészőt indít. **Mérve: melegen 1,7 mp típusonként** (a webpack
gyorsítótár miatt), tehát 24 típus ~40 mp, hidegen ennél több. Ez nem perces,
de egy oldal megnyitása akkor sem indíthat huszonnégy fejetlen böngészőt az
operátor tudta nélkül.

A generálás **sorosan** fut, típusonként egy folyamat, és a felület
mutatja, hol tart (`7/24 — kartya-csere`). Egy típus bukása nem állítja
meg a többit: a kártyája megkapja a hibakódot, és a menet folytatódik.
A generálás megszakítható; a már elkészült képek megmaradnak.

Egyszerre egy generálás futhat. A második kérés `mar_fut` kóddal
elutasítódik, nem sorba áll.

### 3.5 Hogyan jut a kép a böngészőbe

A `sablonElonezet` RPC egy típus képét adja vissza `data:image/png;base64`
alakban, vagy `null`-t, ha nincs. A kártyák egyenként, lustán kérik le,
ahogy láthatóvá válnak.

Nincs új HTTP-útvonal és nincs `file://` hivatkozás: a `safe-href.ts`
szándékosan tiltja a `file:` sémát, és egy statikus fájlkiszolgáló
útvonal a gazdaréteget módosítaná egy olyan képességért, amit a
bővítmény saját RPC-je megad. Ez a döntés a VPS-telepítést is állja,
ahol a böngésző és a fájlrendszer nem ugyanaz a gép.

Egy kép ~360×640 PNG, jellemzően 30–120 KB; base64-ben 40–160 KB. A rács
lustán tölt, tehát egy görgetésnyi kártya néhány száz KB.

## 4. Hibaállapotok

Amit a nézet meg tud különböztetni, azt meg is különbözteti:

| állapot | mit lát az operátor |
|---|---|
| a `remotionDir` nincs beállítva | a mai `remotion_dir_hianyzik` kód, a rács helyett |
| a katalógus nem olvasható | a mai kód, és a heti sor alatta megmarad |
| a katalógus olvasható, de egy típusnak nincs `minta` mezője | a kártya megvan, a kép helyén `nincs_minta` — nem hiba, hanem hiányzó adat a szótárban |
| a still-render bukott | a kártyán a folyamat kilépési kódja és a `still_bukott` kód |
| `npx` nem oldható fel | a mai `npx_hianyzik` az állapotsávból, a generáló gomb letiltva |

Egy üres rács soha nem néma: vagy a szűrők vannak szűkre húzva (és akkor
a `látható/összes` mutatja), vagy a katalógus nem olvasható (és akkor a kód
ott áll).

## 5. Ami nem része ennek

- **Nincs animált előnézet.** Egy állókép egy jelenetről; a mozgás
  megnézése a Remotion Studio dolga.
- **Nincs prop-szerkesztő.** A galéria olvasható, nem szerkeszthető: a
  jelenetlistát az ügynök állítja össze, a `videoDraft` ellenőrzi.
- **Nincs sablon szerinti indítás.** A kártyáról nem lehet videót nyitni;
  a videó forrása egy jel vagy egy kézi szöveg, nem egy jelenettípus.
- **A heti sor nem változik.**

## 6. Elfogadási feltételek

1. A `templates` RPC kiadja a katalógus `tipusok`, `leirasok`, `propok`,
   `kozosPropok`, `kuldhetoTipusok` mezőit is, és a nézet mind a 24 típust
   megjeleníti.
2. Mind a négy szűrő és a keresés együtt hat, és a `látható/összes` szám
   követi őket.
3. A `szotar.ts` mind a 24 típusához tartozik `minta`, és `npx tsc --noEmit`
   tiszta — tehát minden mintaérték a valódi prop-típusához illeszkedik.
4. A `npm run katalogus` a `minta` mezőt is kiadja, és a
   `katalogus.test.ts` összeveti a szótárral.
5. Egy generálás után mind a 24 típusnak van képe a
   `<workspace>/sablon-elonezet/<katalogusHash>/` mappában.
6. Egy típus bukása nem állítja meg a többit, és a kártyáján ott a kód.
7. A katalógus megváltoztatása után a nézet kép nélküli kártyákat mutat és
   `24 hiányzik`-ot ír a gombra — a régi képek nem jelennek meg újként.
8. Két párhuzamos generálás közül a második `mar_fut` kóddal elutasítódik.
