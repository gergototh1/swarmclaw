# Doksik: markdown-dokumentumkezelő operátornak és ügynököknek

**Cél:** egy hely, ahol a szöveges dokumentumok laknak — az operátor grafikus
szerkesztőben írja őket, az ügynökök tooljaikkal olvassák, keresik és írják,
mindegyik a saját mappájába. A tárolás sima `.md` fájl a lemezen, nem
adatbázis-sor: a doksi attól még a tiéd, hogy a SwarmClaw kezeli.

---

## 1. Mit old meg, és mit nem

Ma az ügynökök munkájának maradandó része sehol nincs. Amit egy kutató ügynök
összeszed, az a session-előzményben marad; a következő futás nem látja, a másik
ügynök végképp nem. A `shell` és `file` toolokkal írhat ugyan fájlt a
workspace-be, de annak nincs se szerkezete, se felülete, se keresése — és az
operátor nem tud beleírni másképp, mint egy kódszerkesztőben.

Ez a modul azt a hiányt tölti be: **közös, tartós, olvasható szövegtár**, amit
ember és ügynök ugyanúgy ér el.

**Nem ez a modul:** nem fájlszinkron (nincs eszközök közti szinkronizálás), nem
wiki-motor publikálással, nem dokumentum-behúzó (PDF→szöveg: arra a SwarmClaw
magjában külön `documents` tábla van, amit ez a modul nem érint), és nem
verziókezelő rendszer — a verziótörténete kényelmi funkció, nem git.

**Névütközés, tudatosan:** a SwarmClaw magjában létezik egy `documents` és egy
`document_revisions` tábla (`src/types/misc.ts`, `DocumentEntry`). Az egy
behúzó/kivonatoló store `sourcePath`, `method` és `textLength` mezőkkel, nincs
hozzá felület, és nulla sor van benne. Ez a modul **nem azt bővíti**; saját,
`ext_docs_` előtagú tábláiban él, hogy a kettő soha ne keveredjen.

---

## 2. Alapdöntések

Öt döntés, amiből minden más következik. Mind az operátoré, itt a rögzítésük:

| Kérdés | Döntés | Miért |
|---|---|---|
| Hol az igazság? | **Valódi `.md` fájlok a lemezen.** Az adatbázis csak index. | Az ügynökök a meglévő `shell`/`file` tooljaikkal is elérik; gitelhető, Obsidianban megnyitható, a mentés triviális, semmi nem zárul be a SwarmClaw-ba. |
| Ki írhat kinek a mappájába? | **Saját mappa írható, minden más olvasható, plusz egy közös mappa.** | Nincs tudás-siló (az ügynökök építenek egymás anyagára), de senki nem írja felül a másikét véletlenül. |
| Milyen a szerkesztő? | **WYSIWYG, markdownba mentve.** | „Grafikus szerkesztő" alatt ezt szokás érteni: a formázott szövegbe írsz közvetlenül, a fájl mégis tiszta markdown. |
| Hol a gyökérmappa? | **Operátor által megadott normál útvonal**, alapértelmezetten `~/SwarmClaw/docs`. | Illik a „valódi fájlok" döntéshez: ott van, ahol keresed, és az app újratelepítése nem viszi el. |
| Mi történik egyidejű íráskor? | **Verzió-ellenőrzés, ütközésnél jelzés.** | Soha nem tűnik el írás, és mérsékelt munka — a CRDT-alapú együttes szerkesztés v1-ben nagyságrendi túllövés. |

### 2.1 Az index szinkronban tartása

Három út volt:

**A.** A fájl az egyetlen igazság, az indexbe **csak** a figyelő ír. Egy írási
út, a külső szerkesztés semmiben nem különbözik a belsőtől. De a mentés után az
index késik, és ha a figyelő elhal, minden indexelés megáll.

**B. (ez lett)** A saját írás (lap, tool, szerződés) fájlt ír **és azonnal
indexel**; a figyelő kiszűri a saját írásainkat, és csak a kívülről jövő
változásra reagál.

**C.** Nincs perzisztens index, minden keresés a lemezt olvassa. Nincs drift és
nincs figyelő, de pár száz doksi felett lassú, teljes szöveges keresés nincs, és
a verziótörténetet így is külön kellene tárolni.

**B mellett az érv:** azonnali konzisztencia ott, ahol számít (az operátor
mentés után rögtön megtalálja a doksit a keresőben), a figyelő pedig biztonsági
háló és nem főútvonal. Ha a figyelő elhal, a rendszer működik tovább — csak az
Obsidianból érkező szerkesztést nem veszi észre, és ezt a lap ki is írja.

B ára két írási út az indexbe. Ezt egyetlen modul (`index-writer.mjs`) fogja
össze: a lap, a toolok és a figyelő is **ugyanazt a függvényt** hívja, tehát a
két út csak abban különbözik, ki hívja, nem abban, mi történik. A művelet
idempotens (path szerinti upsert), így ha a self-write szűrés téved és a figyelő
mégis lefut a saját írásunkra, az legrosszabb esetben egy fölösleges, azonos
eredményű újraindexelés.

---

## 3. Mi hol van a lemezen

```
<gyökér>/                         beállításból, alap: ~/SwarmClaw/docs
  agents/
    <agent-slug>/                 automatikusan létrejön minden ügynökhöz
      <szabad mappafa>/
        *.md
  kozos/                          mindenki írhatja  (a név beállítható)
  _sablonok/
    *.md                          doksi-sablonok
  .swarmdocs/
    trash/<id>/                   kuka: a törölt doksi fájlja + a helye
```

`agents/<agent-slug>/` a `slugify(agent.name)`-ből jön, ütközésnél az ügynök
id-jének első hat karakterével toldva. A leképezés az indexben tárolt, nem
számított: ha az ügynököt átnevezik, a mappája **marad**, és az index köti
tovább az ügynökhöz. Átnevezés nem mozgat fájlt — mozgatni csak az operátor tud,
a lapról.

### 3.1 A fájl fejléce

Minden doksi YAML front-matterrel kezdődik:

```yaml
---
id: doc_a1b2c3d4
title: Ügyfélprofil — Morvai
owner: agent:marketing        # vagy: user
tags: [ügyfél, avian]
created: 2026-09-05T18:22:00Z
updated: 2026-09-05T18:41:12Z
---

A doksi törzse innentől, sima markdown.
```

**Az `id` a modul gerince.** Ez teszi biztonságossá az átnevezést és a mozgatást
(a sorok, a verziók és a linkek erre hivatkoznak, nem az útvonalra), és ez az,
amire a `[[wiki-link]]`-ek feloldódnak. A `path` ezzel szemben változékony adat.

Fejléc nélküli `.md` fájl (kívülről bemásolt) érvényes doksi: az indexelő
generál neki id-t, a címet az első `#` sorból vagy a fájlnévből veszi, és
**visszaírja** a fejlécet a fájlba. Ez az egyetlen eset, amikor a modul olyan
fájlhoz nyúl, amit nem ő hozott létre — enélkül a bemásolt doksinak nem lenne
stabil azonosítója, tehát linkelni és verziózni sem lehetne.

---

## 4. Modulok

Mindegyik egy dolgot csinál, mindegyik külön tesztelhető, és a függési irány
egyirányú: `vault` és `db` nem tud a fölöttük lévőkről.

| Modul | Felelősség | Amit nem tud |
|---|---|---|
| `src/vault.mjs` | A lemez. Útvonal-feloldás és -normalizálás, a gyökéren kívülre mutató út és a kifelé mutató symlink elutasítása, atomi írás (tmp + rename), a fejléc oda-vissza alakítása. | Semmit az adatbázisról. |
| `src/db.mjs` | Migrációk és lekérdezések a négy tábla fölött. | Nem nyúl fájlhoz. |
| `src/index-writer.mjs` | Egy fájl állapotából indexsor: beolvas, fejlécet fejt, hasht számol, linkeket kinyer, upsertel. **A lap, a toolok és a figyelő is ezt hívja.** | Nem dönt jogosultságról. |
| `src/watcher.mjs` | A gyökér figyelése, debounce, saját írás kiszűrése, `index-writer` hívása. | Nem ír fájlt. |
| `src/permissions.mjs` | Egyetlen függvény: `canWrite(actor, path)`. | Nincs mellékhatása. |
| `src/links.mjs` | `[[...]]` kinyerése, feloldása, visszahivatkozás-lekérdezés, átnevezéskori linkfrissítés. | — |
| `src/tools.mjs` | A hét ügynök-tool. | — |
| `src/rpc.mjs` | A lap metódusai. | — |
| `src/contract.mjs` | A `docs` szerződés más extensionöknek. | — |
| `src/video-forgatokonyv.mjs` | A modul egyetlen kifelé nyúlása: a `video.videos` szerződés feloldása megnevezett elutasítással, és a tizenegy oszlopból markdown. | Nem ír fájlt, nem dönt jogosultságról. |
| `ui/` → `dist/` | A lap (React + TipTap, esbuilddel bundle-özve). | — |

### 4.1 A figyelő és a `setup()` újrafutása

**A figyelő az egyetlen listener a modulban, és ez veszélyforrás.** A host a
`setup()`-ot **minden `data/extensions` alatti írásra újrafuttatja** (a videó
modul `index.js`-ének nyitó kommentje ezt hosszan kifejti). Egy naivan
`setup()`-ból indított figyelő tehát minden újratöltésnél szivárogtat egy
`fs.watch` handle-t.

Ezért:

1. A figyelő állapota modul-szintű, egyetlen objektumban (`{ handle, root,
   startedAt }`).
2. Az indítás idempotens: ha már fut **ugyanarra a gyökérre**, nem csinál
   semmit. Ha más gyökérre fut, lezárja a régit, és újat nyit.
3. A `setup()` csak *jelzi* a kívánt állapotot; a tényleges indítás egy
   `ensureWatcher(root, enabled)` hívás, ami mindkét irányban idempotens.

A figyelt gyökér (`~/SwarmClaw/docs`) **más mappa, mint a `data/extensions`**,
tehát a modul saját írásai nem indítanak host-újratöltést, és nincs hurok.

### 4.2 Saját írás kiszűrése

Az `index-writer` minden általa írt útvonalat felvesz egy `Map<path,
{ hash, at }>` táblába. A figyelő eldobja azt az eseményt, amelynek útvonala
szerepel a táblában **és** a fájl jelenlegi tartalmának hashe egyezik a tárolt
hash-sel. A bejegyzések 5 másodperc után lejárnak.

Hash szerinti egyezést nézünk, nem puszta útvonalat: ha közvetlenül a mentésünk
után valaki *tényleg* átírja kívülről ugyanazt a fájlt, a hash már nem egyezik,
és az eseményt feldolgozzuk. Az útvonal-alapú szűrés ezt elnyelné.

---

## 5. Jogosultság

Egyetlen szabály, egyetlen helyen (`permissions.mjs`):

| Szereplő | Írhat | Olvashat |
|---|---|---|
| operátor (a lapról) | mindent | mindent |
| ügynök | `agents/<saját slug>/**` és `<közös mappa>/**` | mindent |
| másik extension (szerződésen át) | `agents/<a hívó extension neve>/**` és a közös mappa | mindent |

**A hívó kilétét a host adja, nem az LLM.** Az ügynök toolhívásának `ctx`-e
hordozza a session-t, abból jön az ügynök id-je és neve; a tool paraméterei közt
nincs „ki vagyok" mező. Ha lenne, az ügynök hazudhatna róla.

Az `_sablonok/` és a `.swarmdocs/` az ügynökök számára olvasható, nem írható.

---

## 6. Adatbázis

Négy tábla, mind `ext_docs_` előtaggal (a host `extensionTablePrefix`-e
kényszeríti ki). Egyik sem az igazság forrása: mind a lemez állapotából
újraépíthető, egy teljes újraindexelés kivételével a `doc_versions`-t, ami
történet, nem állapot.

**`docs`** — a fájlok indexe.
`id` (a fejlécből), `path` (a gyökérhez képest), `title`, `owner`, `tags`
(JSON-tömb), `created`, `updated`, `size`, `hash`, `version`, `deleted_at`.
Egyedi index a `path`-on és az `id`-n.

**`docs_fts`** — FTS5 virtuális tábla `title` és `body` fölött, `docs.id`-re
kötve. Ebből jön a keresés.

**`doc_versions`** — `doc_id`, `version`, `content`, `author`, `created_at`.
Minden sikeres írásnál keletkezik egy sor a **korábbi** tartalommal. Nyesés:
doksinként a legutóbbi `verzioMegtartas` (alapból 50) marad meg.

**`doc_links`** — `from_id`, `to_id` (feloldott) vagy `to_raw` (feloldatlan),
`resolved`. Innen jön a visszahivatkozás-panel, és ez frissül átnevezéskor.

### 6.1 A `version` mező jelentése

Egész szám, minden sikeres írásnál eggyel nő. **Ez az, amit az ütközés-figyelés
használ**, és nem a fájl mtime-ja: az mtime másodperc-felbontású lehet, órák
elállíthatók, és a másolás megőrzi. A `version` a mi számlálónk, az indexben él,
és a fejlécbe nem kerül bele (a kívülről szerkesztett fájlnál úgysem lenne
igaz).

Kívülről érkező változásnál a figyelő szintén növeli a `version`-t, tehát az
Obsidianban átírt doksi ugyanúgy ütközést okoz egy régi `baseVersion`-nel
érkező ügynök-írásnál. Ez a kívánt viselkedés.

---

## 7. Ügynök-toolok

Hét tool. Mind ugyanazt a hibaformát adja: `{ hiba: "<kód>", uzenet: "<mit
tegyél>" }`, hogy az ügynök a szövegből tudjon cselekedni.

### `doksi_video_forgatokonyv`
`{ videoId }`. Elkéri a `video.videos` szerződés `get`-jével a videót, és a
tizenegy oszlopából doksit ír a hívó saját mappájába (l. 8. pont: **nem** egy
fix `agents/video/` mappába, mert a `canWrite` szerint azt csak egy `video`
slugú ügynök írhatná). A doksi első sora kimondja, hogy a cím és a narráció
ügynök- és idegen szöveg. Minden hívás új doksit ír; a régit nem frissíti.

Négy külön visszautasítás, mert négy külön teendő, és egyik sem néma
kihagyás — egy üres válasz azt hazudná az ügynöknek, hogy nincs mit letenni:

- `rossz_parameter` — nincs `videoId` a hívásban. A hívás alakja a hibás, és
  a szerződéshez hozzá se nyúlunk.
- `nincs_ilyen_video` — a `get` `null`-t adott: a mező ki van töltve, és a
  sor nincs meg (elírás, vagy azóta eltűnt sor). Ez **külön kód** a fentitől,
  mert a teendő más: nem az argumentumot kell javítani, hanem az id-t
  megkeresni. Az üzenet a mező NEVÉT mondja ki, és **soha nem ismétli meg a
  kapott értéket**: a tool-határ naplózza a visszautasítás szövegét, a
  `videoId` sémája pedig hossz nélküli string.
- `szerzodes_hianyzik` — a `video.videos` szerződés nem oldható fel, vagy a
  handle nem hordoz `get`-et, vagy a hívás közben szűnt meg a szolgáltató. Az
  üzenet a host saját okszavát viszi tovább (`provider_missing`,
  `provider_disabled`, `version_mismatch`, `not_declared`, `unavailable`,
  `provider_threw`), mert azok más-más operátori mozdulatok.
- minden más a tool generikus ága, változatlanul.

### `doksi_lista`
Mappafa vagy lapos lista. Szűrhető mappára, ügynökre, tagre. Alapból a hívó
ügynök saját mappája plusz a közös mappa; `mappa: "/"` az egészet adja.
Visszaad: `id`, `cim`, `utvonal`, `tulajdonos`, `frissitve`, `meret`.

### `doksi_olvas`
`id` vagy `utvonal` szerint. Visszaad: fejléc-mezők, teljes tartalom, és a
`verzio`. **A `verzio`-t az ügynöknek meg kell őriznie, ha írni akar.**

### `doksi_keres`
Teljes szöveges keresés (FTS5), találatonként cím, útvonal és egy kiemelt
részlet. Szűrhető mappára és ügynökre. Alapból 20 találat.

### `doksi_ir`
Létrehoz vagy módosít.

- **Létrehozás:** `cim` és `tartalom` kötelező. `mappa` opcionális — ha nincs
  megadva, **automatikusan `agents/<hívó slug>/`-ba kerül**. `sablon`
  megadásával a `_sablonok/` egyik fájljából indul.
- **Módosítás:** `id` és `baseVersion` kötelező. Ha a `baseVersion` nem egyezik
  az aktuálissal, **nem ír**, hanem visszaadja:
  `{ hiba: "utkozes", jelenlegiVerzio, modositotta, uzenet: "A doksit közben
  módosította <ki>. Olvasd újra a doksi_olvas hívással, fésüld össze a
  változtatásodat, és írd újra az új verziószámmal." }`

A `baseVersion` **kötelezővé tétele** a döntés lényege: enélkül az ügynök
alapértelmezetten felülírna, és az ütközés-figyelés csak akkor működne, ha az
ügynök magától eszébe jut használni.

### `doksi_mozgat`
Átnevezés vagy áthelyezés `id` szerint. A rá hivatkozó `[[...]]` linkeket
frissíti minden doksiban (lásd 9.). Jogosultság-ellenőrzés **mindkét** oldalra:
a forrásra és a célra is írási jog kell.

### `doksi_torol`
Kukába (`.swarmdocs/trash/<id>/`), az eredeti útvonal megőrzésével. A sor
`deleted_at`-et kap, kikerül az FTS-ből, de a sor marad — így a rá mutató linkek
„törölt doksira mutat" állapotot kapnak, nem néma semmit. Végleges törlés csak a
lapról.

---

## 8. Az ügynök tudja, mi létezik

**Ez a modul legnagyobb hozadékú része**, és a legolcsóbb. Egy ügynök, aki nem
tudja, hogy van mit olvasnia, soha nem hívja meg a keresőt.

`getAgentContext` hook minden fordulat elé beszúr egy tartalomjegyzéket:

- a hívó ügynök saját mappájának doksicímei, útvonallal, legfeljebb 30, a
  legutóbb módosítottakkal kezdve;
- a közös mappa 10 legutóbb módosított doksija.

Kemény plafon **1500 token**; felette a lista rövidül, nem csonkul félbe egy
soron. Ha az ügynöknek egy doksija sincs és a közös mappa is üres, a hook
**semmit nem szúr be** — nem tesz oda egy üres fejlécet.

Mellé:

- `getCapabilityDescription`: egy sor arról, hogy ez az ügynök tartós
  dokumentumokat tud olvasni és írni.
- `getOperatingGuidance`: mikor írjon doksit (ha az eredmény a fordulat után is
  értékes marad), mikor ne (átmeneti gondolatmenet), és hogy módosítás előtt
  mindig olvasson.

---

## 9. Wiki-linkek

`[[Doksi címe]]` vagy `[[doc_a1b2c3d4]]` a törzsben. A feloldás sorrendje:
pontos id-egyezés, majd pontos cím-egyezés a gyökéren belül, majd
kis-nagybetűre érzéketlen cím-egyezés. Ha egyik sem talál, a link
**feloldatlan** marad — a sor bekerül a `doc_links`-be `to_raw`-val, a lapon
más színnel látszik, és a doksi létrehozásakor feloldódik. Egy feloldatlan link
nem hiba.

**Átnevezéskor** (`doksi_mozgat` vagy a lap átnevezése): a modul megkeresi a rá
hivatkozó doksikat a `doc_links` alapján, és a **címre hivatkozó** linkeket
átírja az új címre. Az id-re hivatkozókat nem kell bántani. Minden érintett
doksi rendes írásnak számít: verziót kap, indexelődik. Ha valamelyik érintett
doksiba a hívónak nincs írási joga, azt a linket **nem** írja át, és a válasz
felsorolja, melyek maradtak.

A lap jobb paneljén a visszahivatkozások listája: melyik doksi hivatkozik erre,
és milyen szövegkörnyezetben.

---

## 10. A lap — `/x/docs`

React-lap a host `/x/<slug>` felületén, a bundle `dist/index.js` +
`dist/style.css`. A `react`, `react-dom` és `react/jsx-runtime` **nem kerül a
bundle-be** — a host `window.swarmclaw.modules` táblájából jön (a videó modul
`scripts/build.mjs`-e ezt már megoldotta, onnan másolható). A TipTap és a
ProseMirror ezzel szemben **bekerül** a bundle-be; ez nagyságrendileg 300 kB
minifikálva, ami egy lokálisan kiszolgált lapnál rendben van, de az első
build után meg kell nézni.

Három hasáb:

**Bal — mappafa.** Nyitható-csukható fa, húzd-és-ejtsd mozgatás, jobbklikk-menü
(új doksi, új doksi sablonból, új mappa, átnevez, töröl). Fent kereső: gépelésre
a fa helyére találati lista kerül. Az `agents/` alatti mappák ügynök-ikont és
-nevet kapnak, nem a slug-ot. A fa alján a **Kuka**: a törölt doksik listája,
visszaállítással és — itt és csak itt — végleges törléssel. Az `_sablonok/` és a
`.swarmdocs/` egyébként nem jelenik meg a fában; a sablonokat a „új doksi
sablonból" menüpont sorolja fel.

**Közép — a szerkesztő.** TipTap WYSIWYG. `/` paranccsal blokk-beszúró menü
(címsor, lista, idézet, kódblokk, táblázat, elválasztó). Automatikus mentés
800 ms tétlenség után, plusz `Cmd+S`. A mentés a jelenlegi `version`-t viszi
magával; a válasz az újat adja vissza.

**Jobb — behúzható panel.** Cím, tagek, tulajdonos, útvonal; verziólista
időbélyeggel és szerzővel, egyenkénti előnézettel és visszaállítással; a
visszahivatkozások listája.

### 10.1 Ütközés a lapon

Ha a mentés `utkozes`-t kap, a szerkesztő fölött sáv jelenik meg:

> **Ezt a doksit közben módosította a Marketing ügynök.**
> [Megnézem a különbséget] [Az enyém maradjon] [Az övék maradjon]

A „megnézem a különbséget" a két változatot mutatja egymás mellett. Az „enyém
maradjon" újraírja a friss verziószámmal; az „övék maradjon" eldobja a helyi
szerkesztést és újratölt. **A gépi összefésülés v1-ben nincs** — az operátor
dönt.

### 10.2 Ha valami nincs rendben

- Gyökér nincs beállítva, vagy nem írható → a lap nem a fát mutatja, hanem egy
  megnevezett üzenetet és a beállítás-panelre mutató linket.
- A figyelő nem fut, pedig be van kapcsolva → halvány sáv a fa fölött: „A külső
  szerkesztés figyelése leállt — [Újraindítom]".

---

## 11. Beállítások

| Kulcs | Típus | Alap | Mire jó |
|---|---|---|---|
| `gyoker` | text, kötelező | `~/SwarmClaw/docs` | A doksik gyökérmappája. |
| `figyelesBe` | boolean | be | Külső szerkesztés figyelése (Obsidian, Finder). |
| `verzioMegtartas` | number | 50 | Hány korábbi verzió maradjon doksinként. |
| `kozosMappaNev` | text | `kozos` | A mindenki által írható mappa neve. |

`managedResources.localFolders`: a gyökér `readWrite` igényként deklarálva, hogy
a host telepítés-ellenőrzése lássa. **Saját ügynököt és routine-t a modul v1-ben
szándékosan nem hoz** — nincs mit ütemezni, amíg nincsenek doksik.

`setupChecks`: egyetlen bejegyzés, „a doksi-gyökér létezik és írható".

---

## 12. Szerződés más extensionöknek

```js
provides: { docs: { /* v1 */ } }
```

Két metódus, szűkre szabva:

- `letesz({ mappa, cim, tartalom, tulajdonos })` — létrehoz egy doksit. A hívó
  extension neve kerül a `owner`-be, ha a `tulajdonos` nincs megadva.
- `olvas({ id })` — egy doksi fejléce és tartalma.

Nincs benne módosítás, törlés és listázás. Egy hívó extension leteheti, amit
termelt, és visszaolvashatja, amit letett — ennél többet egyik jelenlegi
jelölt sem kér.

**Amit ez lehetővé tesz, de nem valósít meg:** az aisignal ide teheti a
kutatási jegyzetet. A másik oldal hozzáírása külön, későbbi munka; ez a
specifikáció csak a fogadó felet építi meg.

**A videó-forgatókönyv a másik irányban valósult meg, szándékosan.** Nem a videó
modul tolja ide a forgatókönyvet ezen a szerződésen át, hanem a Doksik modul
kéri el a `video.videos` szerződéssel (`doksi_video_forgatokonyv`, 7. pont). A
push a termelő ütemezésén történne, és egy `ext:` actor mappájába érkezne — egy
negyedik író a széfben, amit senki nem kért. Húzva a doksi annak az ügynöknek a
nevében jön létre, aki kérte, a saját mappájába, akkor amikor kérte, és a
`service.create` szokásos jogosultság-ellenőrzésén át. Következmény: a `docs`
szerződésnek **továbbra sincs fogyasztója** — a host tiltja, hogy egy extension
saját magát fogyassza, tehát a Doksik saját tooljából nem is lehetne az.

A host `consumes`-modellje szerint a **deklaráció maga a hozzáférés** (a videó
modul `index.js`-e ezt részletesen leírja): nincs jóváhagyás, nincs visszavonás,
és egy fogyasztót külön letiltani nem lehet. Ezért is ilyen szűk a felület.

---

## 13. Hibakezelés

| Eset | Mi történik |
|---|---|
| Gyökér nem létezik vagy nem írható | Minden tool és a lap megnevezett hibát ad (`gyoker_nem_irhato`, az útvonallal). Nem néma bukás, nem üres lista. |
| Írás félbeszakad | Nem fordulhat elő látható módon: tmp fájlba írunk, majd `rename` — az atomi. Csonka doksi nem marad a fán. |
| Gyökéren kívülre mutató útvonal, `..`, kifelé mutató symlink | A `vault.mjs` elutasítja, mielőtt bármi történne. Teszttel fedve. |
| A figyelő elhal | A rendszer működik tovább; a lap jelzi és felkínálja az újraindítást. Az indexelés a saját írásokra változatlanul megy. |
| Ütközés | Nem hiba, hanem strukturált válasz mindkét oldalon (7. és 10.1). |
| Fejléc nélküli vagy hibás fejlécű `.md` | Az indexelő generál id-t, kikövetkezteti a címet, és visszaírja a fejlécet. Hibás YAML esetén a fejléc-blokkot a törzs elejének tekinti, és új fejlécet ír fölé — semmit nem dob el. |
| Két doksi azonos `id`-vel (kézi másolás) | A később indexelt kap új id-t, és a fájlja frissül. A lap jelzi, melyik kettő volt. |

---

## 14. Tesztelés

Egységteszt (`node --test`, a videó modul mintája szerint):

- **`vault`:** útvonal-normalizálás; `..`, abszolút út és kifelé mutató symlink
  elutasítása; fejléc oda-vissza (a kiírt-beolvasott doksi egyenlő az
  eredetivel); atomi írás (megszakítás után az eredeti fájl ép).
- **`permissions`:** tábla-vezérelt teszt minden (szereplő, útvonal) párra,
  beleértve a saját mappa határeseteit és a `.swarmdocs/`-ot.
- **`db` + `index-writer`:** indexelés, FTS-találat ékezetes szóra,
  verzió-nyesés a beállított határnál, idempotencia (kétszeri indexelés
  ugyanazt adja).
- **`links`:** kinyerés kódblokkból *nem*; feloldás mindhárom szabály szerint;
  átnevezés utáni linkfrissítés, beleértve azt az esetet, amikor egy hivatkozó
  doksiba nincs írási jog.
- **Ütközés:** két egymást követő írás azonos `baseVersion`-nel — a második
  elutasítva, a doksi tartalma az elsőé.
- **`watcher`:** injektált fs-eseménnyel, valódi fájlrendszer-figyelés nélkül (a
  videó modul `spawnImpl`-varratának mintájára). Fedendő: a self-write szűrés
  hash-egyezésre, a szűrés *nem*-találata megváltozott hash-nél, és az
  idempotens indítás (kétszeri `ensureWatcher` egy handle-t nyit).
- **`import-time`:** a modul betöltése nem nyit handle-t és nem olvas fájlt (a
  videó modulnak is van ilyen tesztje).

Végül **élő ügynök-teszt a futó appban**: egy ügynök hozzon létre egy doksit,
egy másik olvassa el és hivatkozzon rá, az operátor írja át a lapról, és az
ügynök ütközést kapjon. A `CLAUDE.md` ezt kötelezővé teszi minden ügynököt
érintő útvonalnál, és a fenti egységtesztek egyike sem méri, hogy a
`getAgentContext` tényleg eljut-e a promptba.

---

## 15. Amit szándékosan kihagy

| Kihagyva | Miért, és mi kell hozzá később |
|---|---|
| Képek és csatolmányok | Az operátor vette ki a v1-ből. Egy `_assets/` mappa és relatív hivatkozás kell hozzá; a törlés és a mozgatás lesz tőle bonyolultabb. |
| Élő együttes szerkesztés | Nagyságrendi túllövés: CRDT és állandó kapcsolat kell. A verzió-ellenőrzés ugyanazt a problémát oldja meg elfogadható áron. |
| Több gyökér („vault"-ok) | Minden tool és a lap kapna egy további dimenziót. Utólag hozzátehető, a `docs` táblába egy `vault_id` oszloppal. |
| PDF/docx export, megosztás linkkel | Nincs rá jelenlegi igény. |
| Saját ügynök és ütemezett összefoglaló | Nincs mit összefoglalni, amíg nincsenek doksik. |

Egyik kihagyás sem fest sarokba: mindegyikhez van hely a fenti adatmodellben.

---

## 16. Hol a kód

Host: `~/DEV/swarmclaw-aisignal` (`feat/aisignal-plugin`). Ez az a checkout,
ami ismeri az `/x/<slug>` extension-lapokat, az `/api/extensions/[id]/call`
RPC-t, a per-extension SQLite tárolót és a szerződéseket. A `~/DEV/swarmclaw`
(`local-install`) checkout ezekből egyiket sem ismeri — ott ennek a modulnak
nem lenne grafikus szerkesztője.

```
extensions/docs/
  index.mjs            a modul deklarációja
  package.json
  src/*.mjs            a 4. pont moduljai
  ui/*.tsx, style.css  a lap forrása
  scripts/build.mjs    esbuild → dist/
  scripts/install.mjs  telepítés a futó app extensions mappájába
  test/*.test.mjs
```

A telepített, futó példány a desktop app adatkönyvtárában:
`~/Library/Application Support/@swarmclawai/swarmclaw/home/data/extensions/` —
egy `docs.mjs` shim, ami a `.workspaces/docs_mjs/index.js`-re mutat, ahogy a
videó, a tts és a gmail is.
