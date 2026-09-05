# Videómodul a SwarmClaw-ban — tervezési specifikáció

Dátum: 2026-09-05. Állapot: tervezési spec, implementáció előtt.

Alapja a `2026-09-04-video-module-decisions.md`: az ott rögzített négy döntés
(saját `ext_video_` táblák; két ügynök, a `lektor` a render **előtt**; a TTS
külön, globális extension szerződéssel és MCP-szerverrel; a határ, amin
négy dolog megy át és `.tsx` soha) ebben a dokumentumban **nem kerül újra
mérlegre**. Ami itt új: a döntések alakja kódban, táblában, toolban és
ütemezésben, valamint az egy nyitott kérdés — hogyan lesznek jobbak a videók
— eldöntve.

A mintája az AI Signal (`extensions/aisignal/`): ugyanaz az extension-váz,
ugyanaz a két munkaszabály, ugyanaz a stílus a kulcsok és a visszautasítások
leírásában. Ahol ez a spec az AI Signaltól eltér, ott megmondja, miért.

## 1. Mi ez, és mi nem

A modul **vezérlőréteg**: nyilvántartja, mi készül; a jelenetlistát az
ügynöktől átveszi és ellenőrzi; a lektort a render elé állítja; a narrációt a
TTS-extensiontől kéri; a rendert **elindítja** a Remotion-projektben; a kész
fájlt **méri**; és a mérésekből, a visszajelzésekből és a beszélgetésekből
javaslatot csinál, amit az operátor fogad el.

Nem render-motor. A Remotion 4.0.508 projekt (`~/DEV/marketing/ai-use-cases/
videos/_remotion`, ~21k sor, saját git, saját `node_modules`) ott marad, ahol
van, és ez a modul **nem ír bele forrást**: se `.tsx`-et, se sablont, se
konfigot. Amit ír, az két saját alkönyvtár a projekt alatt (a narrációs
mp3-ak a `public/narracio/` alá, a kimenet az `out/swarmclaw/` alá), és
semmi más.

Két extension születik, nem egy:

| Extension | Id | Táblák | Mi |
|---|---|---|---|
| Videó | `video.mjs` | `ext_video_` | a vezérlőréteg, ez a spec nagy része |
| Narráció | `tts.mjs` | `ext_tts_` | Soniox TTS: szerződés a kódnak, MCP-szerver az ügynököknek |

A videómodul **fogyaszt** két szerződést (`aisignal.signals` a nyersanyaghoz,
`tts.narration` a hanghoz) és **kínál** egyet (`video.videos`). Ezzel a
szerződés-mechanizmusnak két fogyasztója és két szolgáltatója lesz, ami az
eddigi egy-egy után az első valódi próbája.

Mindkét extension ugyanúgy fut Electronban és VPS-en; a **render** viszont
csak ott fut, ahol a Remotion-projekt, a Chrome Headless Shell és a macOS
rendszerbetűk vannak — ma ez az operátor Macje. VPS-en a modul betölt, a lap
él, a tervezés és a lektorálás megy, a render-tool pedig **névvel** utasít el
(3.4). Ez nem hiba, hanem a decisions-fájl kényszerének a következménye.

## 2. Architektúra

### 2.1 Könyvtárak

```
extensions/video/
  index.mjs              az extension-belépő: migrations, setup, tools, rpc, provides, consumes, ui, managedResources
  src/db.mjs             séma és repository (a KULCSOK szakasz itt él)
  src/katalogus.mjs      a katalógus beolvasása, hash, validálás a jelenetlistára (L-szabályok)
  src/terv.mjs           videoOpen, videoDraft, videoVerdict, videoLessons
  src/narracio.mjs       videoNarrate a tts szerződésen át (N-szabályok)
  src/render.mjs         videoRender, videoRenderStatus, a gyerekfolyamat és a watchdog
  src/qa.mjs             a QA-kapu programként (Q-szabályok), ffprobe/ffmpeg
  src/tanulsag.mjs       videoReviewMaterial, videoPropose, a turn-rögzítő hook
  src/agents.mjs         a két ügynök, a három ütemezés, a promptok
  src/contract.mjs       provides.videos
  src/rpc.mjs            a lap metódusai
  ui/                    React-forrás, a host primitívjeivel
  skills/video-jelenetlista/SKILL.md      a gyártó skillje (mi egy jó jelenetlista)
  skills/video-lektoralas/SKILL.md        a lektor skillje (mit támad, milyen kóddal)
  scripts/install.mjs    ugyanaz a minta, mint az aisignalé (workspace, shim, shipped-skills.json)
  test/

extensions/tts/
  index.mjs, src/db.mjs, src/soniox.mjs, src/contract.mjs, src/rpc.mjs, ui/, mcp/server.mjs, scripts/install.mjs, test/
```

A `setup(ctx)` szinkron és idempotens, mint az aisignalban: a `state`
objektumot tölti (`storage`, `settings`, `log`, `contracts`, `repo`), és
**nem indít** időzítőt, figyelőt vagy feliratkozást — a host minden
újratöltéskor újra hívja, és egy időzítő betöltésenként szivárogna. Ami az
újratöltést túléli (a futó render gyerekfolyamata), azt nem a modul
memóriája, hanem egy tábla tartja számon (3.4).

Az entry modulban **nincs top-level `await`** és nincs fájlolvasás: a host
30 másodperc után feladja az importot, és egy katalógus-beolvasás egy
hiányzó könyvtárból pont az a hiba, ami az importot lógva tartaná. A
katalógust az első tool-hívás olvassa, nem a betöltés.

### 2.2 A határ, kódban

A decisions-fájl négy átmenő dolga így néz ki:

| Irány | Mi | Hol |
|---|---|---|
| Remotion → SwarmClaw | `src/kit/katalogus.generated.json` | `videoCatalog` olvassa, hash-eli, a hash a terv sorára kerül |
| SwarmClaw → Remotion | a jelenetlista | `out/swarmclaw/<videoId>/<draftHash>/props.json`, `{ lista, hatter }` alakban, ahogy a `FosVideo` propja várja |
| SwarmClaw → Remotion | a render-parancs | `spawn(npx, ['remotion', 'render', <entry>, 'FosVideo', <out.mp4>, '--props', <props.json>])`, `shell: false`, `cwd` a projekt |
| Remotion → SwarmClaw | a kész fájl útja és a mérések | a render sorára: `out_path`, `file_sha256`; a QA sorára a mérések |

A `FosVideo` propja ma `{ lista: JelenetLeiro[], narracio?: string, hatter?:
boolean }`; a modul a **jelenetenkénti** narrációt használja (a katalógus
`hang` közös propja), nem az egybefüggő `narracio` sávot, mert a QA-kapu
és a sablon-eredményesség jelenetenként mér, és egy jelenetenkénti mp3 az
egyetlen, ami a mérést a jelenethez köti.

A render-parancs pontos alakja — az entry fájl és az esetleges
`--concurrency` — a projekt saját render-szkriptjéből olvasandó ki az
implementáció első lépéseként, **csak olvasva**. A spec nem találja ki, mert
a projektben áll.

Ami **nem** megy át, mert nem a határ része: a Remotion-projekt `git`
állapota (a modul nem futtat `git`-et ott), a `node_modules` (nem futtat
`npm install`-t), és bármi a `src/` alatt.

### 2.3 Folyamatok

Egy videó élete, a tábla-állapotokkal (3.1):

```
videoOpen ──► nyitott ──videoDraft──► terv ──videoVerdict──┬─► lektoralt ──videoNarrate──► narralt ──videoRender──► renderel
                                       ▲                    │                                                          │
                                       └── új tervverzió ◄──┴─► elbukott                              (gyerekfolyamat kilép)
                                                                                                                       │
                                                              qa_ok ◄─── QA-kapu (program) ───► qa_hiba        render_hiba
```

Minden nyíl **egy** függvény egy fájlban, és a lap ezekből az állapotokból
rajzol. Ami nem tud megtörténni: `renderel` lektori átmenet nélkül;
`qa_ok` a kész fájl ujjlenyomata nélkül; `qa_ok` egy fájlra, amit később
újrarendereltek (új ujjlenyomat → nincs érvényes QA-sor).

A **publikálás nem állapot ebben a modulban.** A `qa_ok` a vég: a fájl a
lemezen van, a lap mutatja az útját, és onnan az operátor viszi tovább. Ez
szándékos (8.).

### 2.4 Az ügynök-hívások útja

Az ügynök a modul tooljait az `extensions` listáján át kapja (a host a
managed agentre magától ráteszi az extension id-t). A tool `execute`-ja
megkapja `ctx.session`-t, benne `agentId`-t: ez az, amiből a modul tudja,
**ki** hívott. Erre két gate épül (3.3, 4.3), és egyikhez sem kell a
managed agent id-jét előre ismerni: a modul a **tettből** tudja a szerepet
— aki tervet adott be, az a szerző; aki verdiktet írt, az a lektor —, és
csak azt ellenőrzi, hogy a kettő nem ugyanaz.

## 3. Adatmodell

Minden tábla `ext_video_` prefixű, a modul migrációiban deklarálva, a host
storage-API-ján. A Studio SQLite-jához a modul **nem nyúl**: nem olvassa és
nem írja. Ami onnan kell (visszajelzések, megtartási görbék), az
fájl-importon jön be (3.6).

### 3.1 Táblák

**`ext_video_videos`** — egy videó, a nyitástól a kész fájlig.

| oszlop | mi |
|---|---|
| `id` TEXT PK | surrogát, `uid()` |
| `cim` TEXT | munkacím |
| `forras_tipus` TEXT | `signal` vagy `kezi` |
| `forras_id` TEXT | `signal` esetén az AI Signal kártya id-je, különben `''` |
| `forras_szoveg` TEXT | a nyersanyag szövege **nyersen**; idegen írta (8.) |
| `status` TEXT | a 2.3 állapotai |
| `nyitotta_agent_id` TEXT | `ctx.session.agentId` a nyitáskor |
| `created_at`, `updated_at` TEXT | |
| `lezarva_at` TEXT NULL | az operátor zárta le a lapról |

**`ext_video_tervek`** — egy jelenetlista-verzió. Egy videónak több van; a
legfrissebb az, amire minden más hivatkozhat.

| oszlop | mi |
|---|---|
| `id` TEXT PK | |
| `video_id` TEXT | |
| `verzio` INTEGER | 1-től, videónként |
| `jelenetek` TEXT | a jelenetlista JSON-ként, pontosan ahogy beadták |
| `narracio` TEXT | jelenetenkénti narráció-szöveg JSON-ként: `[{ jelenet, szoveg }]` |
| `terv_hash` TEXT | sha256 a `jelenetek` és a `narracio` kanonikus JSON-ján |
| `katalogus_hash` TEXT | a katalógus sha256-ja, ami ellen validálva lett |
| `szerzo_agent_id` TEXT | `ctx.session.agentId` a beadáskor |
| `szerzo_session_id` TEXT | |
| `ellenorzes` TEXT | az L-szabályok (5.1) eredménye JSON-ként, figyelmeztetésekkel |
| `created_at` TEXT | |

UNIQUE `(video_id, verzio)`.

**`ext_video_verdiktek`** — a lektor ítélete egy tervverzióról.

| oszlop | mi |
|---|---|
| `id` TEXT PK | |
| `terv_id` TEXT | |
| `terv_hash` TEXT | a terv hash-e **az ítélet pillanatában**, másolva |
| `lektor_agent_id`, `lektor_session_id` TEXT | |
| `verdikt` TEXT | `atmegy` vagy `elbukik` |
| `talalatok` TEXT | JSON: `[{ jelenet, kod, szoveg }]`; `elbukik`-nál nem üres |
| `created_at` TEXT | |

**`ext_video_narraciok`** — egy tervhez tartozó, jelenetenkénti narrációs
fájlkészlet.

| oszlop | mi |
|---|---|
| `terv_id` TEXT | |
| `terv_hash` TEXT | |
| `jelenet` INTEGER | 0-tól, a lista indexe |
| `szoveg_hash` TEXT | a jelenet narráció-szövegének sha256-ja |
| `fajl` TEXT | `public/`-relatív útvonal a Remotion-projektben |
| `hossz_ms` INTEGER | ffprobe-bal mérve |
| `tts_keres_id` TEXT | a tts szerződés válaszából, cache-találatnál is |
| `created_at` TEXT | |

PRIMARY KEY `(terv_id, jelenet)`.

**`ext_video_renderek`** — egy render-indítás.

| oszlop | mi |
|---|---|
| `id` TEXT PK | |
| `video_id`, `terv_id`, `terv_hash` TEXT | |
| `verdikt_id` TEXT | az `atmegy` verdikt, ami alapján indult |
| `status` TEXT | `fut`, `kesz`, `hiba`, `elveszett` |
| `pid` INTEGER NULL | a gyerekfolyamat |
| `props_path`, `out_path`, `log_path` TEXT | a projekt `out/swarmclaw/` alatt |
| `file_sha256` TEXT NULL | a kész fájlé, a kilépés után számolva |
| `hiba_kod`, `hiba_szoveg` TEXT | |
| `platform` TEXT | `process.platform` az indításkor |
| `started_at`, `finished_at` TEXT | |

**`ext_video_qa`** — a QA-kapu egy futása egy kész fájlon.

| oszlop | mi |
|---|---|
| `id` TEXT PK | |
| `render_id` TEXT | |
| `file_sha256` TEXT | a mért fájl ujjlenyomata |
| `szabalykeszlet` INTEGER | a Q-szabályok verziója (5.3) |
| `ok` INTEGER | 1, ha minden szabály átment |
| `meresek` TEXT | JSON: felbontás, fps, hossz, hangfedettség, üres kockák időpontjai |
| `bukasok` TEXT | JSON: `[{ kod, mert, kuszob, at_ms? }]` |
| `checked_at` TEXT | |

UNIQUE `(render_id, file_sha256, szabalykeszlet)`.

**`ext_video_visszajelzesek`** — időkódos, jelenet-szintű visszajelzés.

| oszlop | mi |
|---|---|
| `id` TEXT PK | |
| `video_id` TEXT | |
| `render_id` TEXT NULL | amelyik fájlt nézve született |
| `at_ms` INTEGER NULL | |
| `jelenet` INTEGER NULL | |
| `szoveg` TEXT | nyersen |
| `forras` TEXT | `operator` (a lapról) vagy `import` |
| `created_at` TEXT | |

**`ext_video_megtartas`** — megtartási görbe pontjai.

`(video_id, platform, t_s)` PRIMARY KEY, `arany` REAL, `imported_at` TEXT.

**`ext_video_fordulok`** — a modul ügynökeinek beszélgetés-fordulói, a napi
átnézéshez.

| oszlop | mi |
|---|---|
| `id` TEXT PK | |
| `session_id`, `agent_id` TEXT | |
| `forras` TEXT | a host `source`-a (ütemezett futás, chat, connector) |
| `uzenet` TEXT | az első 4 000 karakter |
| `valasz` TEXT | az első 4 000 karakter |
| `toolok` TEXT | JSON: a hívott tool-nevek és a hibás hívások kódjai |
| `at` TEXT | |
| `atnezve_at` TEXT NULL | melyik napi átnézés dolgozta fel |

**`ext_video_javaslatok`** — a napi átnézés kimenete.

| oszlop | mi |
|---|---|
| `id` TEXT PK | |
| `cel` TEXT | `agent:gyarto`, `agent:lektor`, `skill:video-jelenetlista`, `skill:video-lektoralas`, `szabaly`, `sablon` |
| `fajta` TEXT | `tanulsag`, `szabaly`, `sablon` |
| `cim` TEXT | egy sor |
| `szoveg` TEXT | legfeljebb 400 karakter `tanulsag`-nál; `szabaly`-nál a mérhető feltétel; `sablon`-nál a hiányzó képesség |
| `bizonyitek` TEXT | JSON: forduló-, videó-, verdikt- vagy QA-sor id-k; nem üres |
| `status` TEXT | `nyitott`, `elfogadva`, `elutasitva`, `kodolva` |
| `javasolta_agent_id`, `futas_session_id` TEXT | |
| `dontes_megjegyzes` TEXT | az operátoré |
| `created_at`, `decided_at` TEXT | |

**`ext_video_tanulsagok`** — az elfogadott `tanulsag` javaslatok, ahogy az
ügynök megkapja őket.

`id`, `javaslat_id`, `cel`, `szoveg`, `aktiv` INTEGER, `created_at`,
`visszavonva_at`.

### 3.2 Minden kulcs, és mit gátol

Az AI Signal nyolc hibát talált egyetlen alakban: egy kulcs döntött arról,
hogy egy levél pontozódik-e, miközben vak volt arra, melyik forrást olvassa a
futás. Itt a megfelelő alak: egy kapu, ami **másra** ad engedélyt, mint amit
megnézett. A 2026-08-06-i eset pontosan ez volt — jóváhagyás egy tételre,
36 perccel a fájl előtt. Ezért minden kapu-kulcs a **műtermék**
ujjlenyomatára van kötve, nem a tétel id-jére.

- `ext_video_tervek (video_id, verzio)` UNIQUE — **gátol**: melyik a
  legfrissebb terv. A verdikt, a narráció és a render csak a legfrissebbre
  írható; egy régebbi verzióra érkező hívást a tool névvel utasít el
  (`terv_elavult`), mert az ítélet egy szövegről szól, és a szöveg már más.
- `ext_video_verdiktek.terv_hash` — **gátol**: a render. `videoRender` egy
  `atmegy` verdiktet keres, amelynek `terv_hash`-e **egyenlő** a terv
  jelenlegi `terv_hash`-ével. A verdikt a `terv_id`-re is hivatkozik, de a
  kapu a hash-t nézi, mert az id egy sor neve, a hash pedig a tartalomé.
- `ext_video_verdiktek.lektor_agent_id ≠ ext_video_tervek.szerzo_agent_id` —
  **gátol**: az önlektorálás. `videoVerdict` visszautasítja, ha a hívó
  session `agentId`-je azonos a terv szerzőjével (`onlektoralas`). Nem a
  managed agent id-jét ismeri; azt ismeri, hogy a két tett ugyanattól jött.
- `ext_video_narraciok (terv_id, jelenet)` PK + `terv_hash` — **gátol**: a
  render. Minden jelenethez, amelynek van narráció-szövege, kell egy sor,
  amelynek `szoveg_hash`-e a terv jelenlegi szövegének hash-e. Egy
  átfogalmazott mondat régi mp3-mal nem renderelhető.
- `ext_video_renderek_fut` — részleges UNIQUE INDEX `(status) WHERE status
  = 'fut'` — **gátol**: egyszerre egy render. A render telíti a gépet, és két egyidejű
  futás mindkettőt lassítja a watchdog küszöbe fölé. A refusal kódja
  `render_folyamatban`, és a válasz megnevezi a futó render id-jét.
- `ext_video_qa (render_id, file_sha256, szabalykeszlet)` UNIQUE —
  **gátol**: a `qa_ok`. A videó akkor `qa_ok`, ha van `ok = 1` sor a
  render **jelenlegi** `file_sha256`-jára, a **jelenlegi** szabálykészlettel.
  Egy újrarender új sha-t ad, és a régi pass semmit nem mond róla. Ez a
  2026-08-06-i hiba kapuja: az engedély ahhoz a bájtsorhoz van kötve, ami ki
  fog menni.
- `ext_video_megtartas (video_id, platform, t_s)` PK — jelentés. Semmit nem
  gátol; az importot idempotenssé teszi.
- `ext_video_javaslatok` — jelentés, és egy szűrő: `videoPropose` nem nyit
  új javaslatot, ha ugyanazzal a `(cel, cim)` párral van `nyitott` sor
  (`javaslat_duplikat`). Ez nem index, hanem lookup, és a napi futást
  védi attól, hogy ugyanazt hetente újra javasolja.
- `ext_video_tanulsagok.cel` + `aktiv` — jelentés a `videoLessons` felé.
  Nem gátol; egy tanulság nem kapu.

### 3.3 Ki írhat mit

Az AI Signal egyik legfontosabb tulajdonsága, hogy a mezőket, amelyekre gate
épül, nem a hívó adja, hanem a sor. Itt ugyanez:

- `szerzo_agent_id`, `lektor_agent_id`, `nyitotta_agent_id` a
  `ctx.session.agentId`-ből jön, soha a tool argumentumából.
- `terv_hash` és `file_sha256` a modul számolja; a hívó nem adhat hash-t.
- `status` átmenetet csak a 2.3 nyilainak függvényei írnak; rpc-metódus
  státuszt nem állít, kivéve a `lezar`-t (az operátor lezárja a videót).

### 3.4 A futó render túléli a modult, a modul nem a rendert

A gyerekfolyamatot a host processz indítja, és a `pid` a render sorára
kerül **az indítás pillanatában**, mert a sor az egyetlen, ami a folyamatot
a modul bármelyik későbbi példányához köti. Az `exit` eseménykezelő a
**régi** modulpéldány closure-jában is helyes, mert kizárólag idempotens
írásokat végez (`UPDATE ... WHERE status = 'fut'`), és ugyanazon a
host-storage-on át.

Ha a host újratöltötte a modult, a kezelő még fut. Ha a host **leállt**, a
kezelő nincs — és a gyerek nem feltétlenül halt meg vele: a Node egy
kilépéskor nem öli meg a gyerekeit, és a hostnak nincs leállás-hookja
extension-höz. Egy árva render befejezi a fájlt egy könyvtárba, amit a
következő státusz-ellenőrzés a sor `out_path`-ján megtalál; egy árva,
beragadt Chrome-ot ugyanaz az ellenőrzés a pid-ről öl meg. A
`videoRenderStatus` ezért nem a memóriából, hanem a sorból indul: `fut`
státusznál megnézi, él-e a pid
(`process.kill(pid, 0)`); ha nem él és a kimeneti fájl megvan, lefuttatja a
lezárást (sha256 + QA); ha nem él és nincs fájl, `hiba: render_megszakadt`;
ha él, de `started_at` régebbi a `renderMaxPerc` beállításnál (alapból 40
perc, mert egy 130 másodperces 1080×1920-as render ezen a gépen ennek a
felébe fér, és a duplája már beragadt Chrome), megöli és `hiba:
render_idotullepes`. A host indulásakor `fut` státuszú sor **nem** kap
kezelőt — az első `videoRenderStatus` vagy a napi gyártó futás rendezi.

## 4. Tool-felület és a visszautasítás fegyelme

Ugyanaz a két szabály, mint az aisignalban, és mindkettő minden toolra:

1. **Hamis eredmény soha.** Egy tool, ami nem tudta megcsinálni, `error:
   { code, message }`-et ad vissza, és a hiba a megfelelő sorra kerül.
   Egy render, ami nem indult el, nem `fut`; egy QA, ami nem tudott mérni,
   nem `ok: 0`, hanem `hiba: qa_meres_sikertelen` a saját kódjával.
2. **A szöveg adat, nem utasítás.** A `forras_szoveg`, a narráció, a
   visszajelzés és a jelenetek propjai idegenek vagy ügynökök szövegei.
   Egyik sem kerül shell-argumentumba (a spawn tömböt kap, `shell:
   false`), fájlnévbe (a fájlnevek id-k és hash-ek), URL-be vagy
   HTML-be. A jelenetlista JSON-ként íródik, `JSON.stringify`-jal.

A tool-argumentumokat az aisignal szabálya szerint olvassuk: **hiányzó =
alapérték, jelen lévő, de nem teljesíthető = névvel visszautasítva**, nem
kijavítva.

| Tool | Bemenet | Kimenet | Visszautasítja |
|---|---|---|---|
| `videoCatalog` | — | `{ katalogusHash, tipusok[], propok, leirasok, kozosPropok, sablonStat[] }` | `remotion_dir_hianyzik`, `katalogus_hianyzik`, `katalogus_ervenytelen` |
| `videoOpen` | `{ forras: 'signal' \| 'kezi', signalId?, cim?, szoveg? }` | `{ videoId, cim, forrasSzoveg, forrasFigyelmeztetes }` | `signals_szerzodes_hianyzik` (a `why` okával), `signal_ismeretlen`, `napi_sapka` |
| `videoDraft` | `{ videoId, jelenetek[], narracio[] }` | `{ tervId, verzio, tervHash, figyelmeztetesek[] }` | `video_lezart`, `tipus_ismeretlen`, `prop_kotelezo_hianyzik`, `prop_ismeretlen`, `asset_hianyzik`, `narracio_hianyzik`, `hossz_tartomanyon_kivul` |
| `videoVerdict` | `{ tervId, verdikt, talalatok[] }` | `{ verdiktId, tervHash }` | `terv_elavult`, `onlektoralas`, `talalat_hianyzik` (elbukik üres listával), `verdikt_ismeretlen` |
| `videoLessons` | `{ szerep: 'gyarto' \| 'lektor' }` | `{ tanulsagok[] }` (≤ 12, mindegyik ≤ 400 karakter) | `szerep_ismeretlen` |
| `videoNarrate` | `{ tervId }` | `{ jelenetek: [{ jelenet, fajl, hosszMs, cache }], osszHosszMs, fedettseg }` | `terv_elavult`, `verdikt_hianyzik`, `tts_szerzodes_hianyzik` (okkal), `tts_visszautasitva` (a tts kódjával), `fedettseg_alacsony` |
| `videoRender` | `{ tervId }` | `{ renderId, status: 'fut', outPath }` | `verdikt_hianyzik`, `verdikt_elavult`, `narracio_hianyos`, `render_folyamatban`, `render_host_platform`, `render_eszkoz_hianyzik` |
| `videoRenderStatus` | `{ renderId }` | `{ status, outPath?, fileSha256?, qa?: { ok, meresek, bukasok } }` | `render_ismeretlen` |
| `videoReviewMaterial` | `{ oraVissza? }` (alap 26) | `{ fordulok[], verdiktekVsQa[], visszajelzesek[], nyitottJavaslatok[], elutasitottJavaslatok[], sablonStat[] }` | `ablak_ervenytelen` |
| `videoPropose` | `{ cel, fajta, cim, szoveg, bizonyitek[] }` | `{ javaslatId }` | `cel_ismeretlen`, `fajta_ismeretlen`, `bizonyitek_hianyzik`, `bizonyitek_ismeretlen` (nem létező id), `szoveg_tul_hosszu`, `javaslat_duplikat`, `javaslat_sapka` (futásonként 5) |

Amit egyik tool sem csinál: nem publikál, nem ír ügynököt, nem ír skillt,
nem ír `.tsx`-et, nem futtat `git`-et vagy `npm`-et, nem nyúl a Studio
adatbázisához.

### 4.1 `videoCatalog`

A `katalogus.generated.json`-t a beállított `remotionDir` alól olvassa,
minden híváskor (nincs cache: a fájl a Remotion-repóban változik, és a
modul nem figyeli a repót). A `sablonStat` a 6.3 számai, típusonként.
Visszaadja a `katalogusHash`-t, amit `videoDraft` a terv sorára ír: egy
terv, ami egy másik katalógus ellen lett validálva, mint ami a rendernél
van, `figyelmeztetes: katalogus_valtozott`-tal renderel — nem utasít el,
mert a kit bővülése nem rontja el a régi típust, de a lap kiírja.

### 4.2 `videoDraft` — a határ kényszere

Ez a tool az, ami a decisions-fájl „szerkezetileg dolgozik a sablonokból”
mondatát kódba írja. Nem utasítás, hanem visszautasítás:

- `tipus` csak a katalógus `tipusok` listájából (`tipus_ismeretlen`);
- a típus `kotelezo: true` propjai jelen vannak (`prop_kotelezo_hianyzik`);
- **nincs olyan prop, amit a katalógus nem ismer** a típusra vagy a
  közös propok közt (`prop_ismeretlen`). Ez a legfontosabb a háromból: a
  Remotion figyelmen kívül hagyná az ismeretlen propot, és az ügynök azt
  hinné, hogy megcsinált valamit;
- egy prop, ami a leírása szerint `public/`-beli fájlt nevez (`kepek`,
  `kep`, `hang` és társaik — a katalógus `mit` mezője mondja), csak létező
  fájlra mutathat (`asset_hianyzik`). Képgenerálás nincs (9.);
- minden jelenethez tartozik narráció-szöveg a `narracio` listában
  (`narracio_hianyzik`), mert a QA-kapu 80%-os hangfedettséget kér, és egy
  néma jelenetlista nem tud átmenni rajta;
- a `hang` és a `lathatoHossz` propot a hívó **nem adhatja**
  (`prop_ismeretlen`-nel visszautasítva, külön mondattal): mindkettőt a
  narráció méréséből a modul írja rá a rendernél (4.4).

A többi L-szabály (5.1) figyelmeztetés a terv sorára, nem visszautasítás,
és a `videoDraft` válaszában is ott van.

A `jelenetek` és a `narracio` **változtatás nélkül** tárolódik; a
`terv_hash` a kanonikus (kulcs szerint rendezett) JSON-jukból számolódik.

### 4.3 `videoVerdict`

Az önlektorálás visszautasítása (3.2) a tool egyetlen olyan szabálya, ami
nem az argumentumokról szól. Az `elbukik` verdikt legalább egy találatot
kér, mert egy találat nélküli bukás nem javítható, és a gyártó következő
körének pont a találatokból kell dolgoznia. A találat `kod` mezője a
lektor skilljének kódkészletéből jön (6.2); ismeretlen kód nem
visszautasítás, hanem `figyelmeztetes: kod_ismeretlen` — a kódkészlet
bővülhet a skillben anélkül, hogy a tool tudna róla.

### 4.4 `videoNarrate`

Jelenetenként meghívja a `tts.narration` szerződés `synthesize` metódusát
a jelenet szövegével és a célfájllal (`public/narracio/<videoId>/
<tervHash>/<jelenet>.mp3`). A tts-extension a saját cache-éből válaszol,
ha ugyanaz a szöveg ugyanazzal a hanggal már el volt készítve, és a
válaszban `cache: true` áll. A modul `ffprobe`-bal méri a hosszt, és a
sorra írja.

Ebből a mérésből lesz a jelenet `lathatoHossz`-a a rendernél: a mért
`hossz_ms` kockára váltva, plusz a kit `HANG_ELORETART` előretartása (a
katalógus szerint 10 kocka) és egy záró tartás. A záró tartás kockaszáma a
kit `Film.tsx`/`idovonal` konstansaiból olvasandó ki az implementációban,
olvasva; a spec nem ad rá számot, mert a projektben áll, és egy itt
kitalált szám a projektétől eltérne.

Az `N`-szabályok (5.2) itt futnak; a `fedettseg_alacsony` visszautasítás
azt jelenti, hogy a narrált jelenetek hossza a teljes hossz 80%-a alatt van,
és ilyenkor a narráció-készlet **nem** kerül a sorra, mert egy fedettség
alatti készlettel a render biztosan elbukna a QA-n.

Ha a `tts.narration` szerződés nem oldható fel, a válasz a
`ctx.contracts.why` okát adja vissza szó szerint (`provider_missing`,
`provider_disabled`, `version_mismatch`), mert a három más-más operátori
teendő.

### 4.5 `videoRender` és `videoRenderStatus`

Az indítás előtt, ebben a sorrendben, és mindegyik a saját kódjával:

1. a terv a legfrissebb, és van rá `atmegy` verdikt a jelenlegi hash-sel;
2. minden narrált jelenethez van sor a jelenlegi szöveg-hash-sel;
3. nincs `fut` render (a részleges unique index az utolsó barrier, de a
   tool előbb mondja meg névvel);
4. a platform `darwin`, vagy a `linuxRenderEngedely` beállítás igaz. A
   Remotion-projekt tipográfiája macOS rendszerbetű, mert az egress-gate a
   CDN-betűket blokkolja; egy Linux-host minden meglévő videó tipográfiáját
   megváltoztatná, és a QA ezt nem méri. Ezért a nem-Mac render
   alapértelmezésben visszautasítás, nem figyelmeztetés;
5. a `ffmpeg`, `ffprobe` és `npx` elérhető, a `remotionDir` alatt van
   `package.json`, `src/FosVideo.tsx` és a katalógus, és a Chrome Headless
   Shell jelen van (`npx remotion browser ensure` kilépési kódja 0). Ez
   utóbbi az egyetlen hálózatot igénylő lépés, és csak akkor fut, ha a
   böngésző hiányzik.

Utána: a props-fájl megírása a `hang` és `lathatoHossz` propokkal
kiegészített listával, a gyerekfolyamat indítása, a sor `fut`-ra, a válasz
azonnal. A tool **nem vár** a renderre: egy több perces blokkoló tool-hívás
egy ütemezett futásban a host futás-időkorlátjának a kegyelmén múlna, a
sor-alapú státusz pedig nem.

A `videoRenderStatus` a 3.4 szerint dolgozik, és ha a folyamat kilépett, a
lezárást végzi: sha256, QA-kapu (5.3), a videó státusza `qa_ok` vagy
`qa_hiba`. Ugyanezt teszi az `exit` kezelő; a kettő idempotens egymásra.

### 4.6 `videoReviewMaterial` és `videoPropose`

A napi átnézés két toolja. Az első **csak olvas**, és a nyersanyagot adja
együtt: az utolsó ablak fordulói (`atnezve_at IS NULL` szűréssel, hogy egy
kimaradt nap se vesszen el, és egy forduló se legyen kétszer átnézve), a
verdiktek és a QA-eredmények párba állítva (egy `atmegy` verdikt, aminek a
renderét a QA elbuktatta, a lektor hibája, és ez a legerősebb jel a
készletben), a visszajelzések a videó-, jelenet- és időkód-hivatkozással, a
nyitott és az elutasított javaslatok a megjegyzéssel (hogy ne javasolja
újra, amit már elutasítottak), és a sablon-számok.

A második ír, de **csak a javaslat-táblába**. A bizonyíték nem opcionális,
és létező sorokra kell mutatnia: egy tanulság, aminek nincs bizonyítéka,
vélemény, és a vélemény az, ami a 502 soros visszajelzés-fájlt
termelte. Futásonként legfeljebb öt javaslat, mert a lap, ahol az operátor
dönt, egy ember reggeli öt perce, és ami annál több, azt nem olvassa el.

## 5. Az ellenőrzés programként

Három szabálykészlet, három időpontban, mind a három kód, egyikük sem
ügynök vagy ember. A lektor a negyedik szem, és pont azt nézi, amit ezek
nem tudnak: hogy jó-e a videó.

Minden szabálynak van kódja, küszöbe és **eredete** — melyik valódi hibából
jött. Egy szabály eredet nélkül nem kerül be; ez az, ami a 6.4 `szabaly`
javaslatait is méri.

### 5.1 L — a jelenetlistán, beadáskor (`videoDraft`)

| kód | mit néz | eredet | következmény |
|---|---|---|---|
| L1 | típus a katalógusban | a határ döntése | visszautasít |
| L2 | kötelező propok | a katalógus `kotelezo` | visszautasít |
| L3 | ismeretlen prop | a határ döntése (4.2) | visszautasít |
| L4 | `public/` hivatkozás létezik | a katalógus `mit` mezői | visszautasít |
| L5 | minden jelenetnek van narráció-szövege | a Q4 fedettség | visszautasít |
| L6 | az első jelenet `cimlap` | a katalógus leírása: „A video elso jelenete” | figyelmeztet |
| L7 | narráció-szövegek becsült összhossza 25–130 s között (magyar beszéd ~14 karakter/s) | a Q3 ablak, előrehozva, hogy a TTS-költség a bukás előtt ne menjen el | figyelmeztet |
| L8 | jelenetszám ≥ 3 | egy `cimlap` + `cta` önmagában nem videó; a lektor kódkészletének `tul_keves_tartalom` találatából | figyelmeztet |

A figyelmeztetések a terv `ellenorzes` mezőjére kerülnek, és a lektor
látja őket.

### 5.2 N — a narráció után (`videoNarrate`)

| kód | mit néz | következmény |
|---|---|---|
| N1 | minden narrált jelenetnek van fájlja, `hossz_ms > 0` | visszautasít |
| N2 | a narrált hossz összege ≥ a teljes látható hossz 80%-a | visszautasít (`fedettseg_alacsony`) |
| N3 | a teljes látható hossz 25–130 s | visszautasít (`hossz_tartomanyon_kivul`) |

Az N2 és N3 a Q4 és Q3 **előrehozott** mása. A különbség: itt még nincs
render, tehát egy bukás pár másodperc TTS-idő, nem húsz perc gép.

### 5.3 Q — a kész fájlon (a QA-kapu)

A `qa_gate.py` küszöbei változtatás nélkül; a port a számokat átveszi és
**nem** vezeti le újra. Az eredetük a `qa_gate.py` fejlécében áll, és ott
is marad; ez a spec csak annyit rögzít, amit a port nem változtathat meg.

| kód | mit néz | küszöb | hogyan méri |
|---|---|---|---|
| Q1 | felbontás | 1080×1920 | `ffprobe -show_streams` |
| Q2 | képkockasebesség | ≥ 24 fps | ugyanonnan |
| Q3 | hossz | 25–130 s | `ffprobe -show_format` |
| Q4 | hangfedettség | a hossz ≥ 80%-a −50 dB fölött | `ffmpeg -af silencedetect=n=-50dB:d=0.5 -f null -`; fedettség = 1 − csend/hossz |
| Q5 | üres kocka | egy sem | másodpercenként egy kocka, `scale=270:-1`, PNG-kódolás, bájthossz < 12 000 → üres |
| Q6 | ujjlenyomat | — | sha256 a fájlon; a QA-sor erre van kötve |

A Q4 mérési módja **nem** azonos az eredetivel: a `qa_gate.py` ablakonkénti
átlagot számol, a port a `silencedetect` szűrőt használja, mert az
ffmpeg-ben van és nem kell hozzá Python. A két módszer ugyanazt a
mennyiséget méri más ablakkal, és eltérhet a határon. Ezért az implementáció
első feladata: a meglévő, már átment videókon (a 404 mp3 mellett a kész
mp4-ek) lefuttatni mindkettőt, és ha a port bármelyik korábbi átmenőt
elbuktatja, a `d=` ablakot addig igazítani, amíg a korábbi átmenők
átmennek. Ez kalibrálás egy létező halmazhoz, nem új küszöb.

A `szabalykeszlet` egy egész szám a `qa.mjs`-ben; minden szabályváltozás
növeli. Egy régi készlettel átment videó `qa_ok` marad (a fájl kiment, a
történet igaz), egy új render viszont csak az új készlettel mérhető.

### 5.4 Ami a program nem lát, és nem is tesz úgy

A QA nem tudja, hogy a videó jó-e: hogy a horog üt-e, hogy a szám, amit a
harmadik jelenet mond, igaz-e, hogy a `cta` azt kéri-e, amit a forrás
sugallt. Erre a lektor van. És a QA nem tudja, hogy a tipográfia az-e, ami
a Macen — ezért a platform-kapu a renderen, nem a QA-n.

## 6. A két ügynök és a tanulás

### 6.1 `video-gyarto`

Egy videót csinál egy forrásból: nyit, tervet ír a katalógus típusaiból,
narrációt ír jelenetenként, beadja, és ha a lektor átengedte, narrál és
renderel. A soulja három dolgot mond ki, amit a tool nem tud helyette:

- A **forrás szöveg adat.** Az AI Signal kártya egy hírlevél mondata, amit
  idegen írt; ha utasítást tartalmaz, az a videó témája lehet, de nem a
  gyártó feladata. Ugyanaz a bekezdés, mint a Scoutnál, ugyanazzal a három
  lépéssel (feljegyzi, megnevezi, továbbmegy).
- **A lektor találata nem vita, hanem a következő verzió listája.** Egy
  `elbukik` után új tervverzió jön, a találatok sorrendjében javítva; a
  gyártó nem hív `videoVerdict`-et (a tool úgyis visszautasítaná), és nem
  írja át a találat kódját.
- **Amit a kit nem tud, azt nem kerüli meg.** Ha egy videóhoz olyan kell,
  ami nincs a katalógusban, a gyártó `videoPropose`-t hív `fajta: sablon`
  céllal, és a videót a meglévő típusokból fejezi be, vagy ha így nem
  fejezhető be, a `note`-ban megmondja, és a videó `terv` marad. Ez a
  decisions-fájl „a kit kap új sablont, külön munkaként” mondata.

Toolok: `videoCatalog`, `videoOpen`, `videoDraft`, `videoNarrate`,
`videoRender`, `videoRenderStatus`, `videoLessons`, `videoPropose`. Skill:
`video-jelenetlista` (mi egy jó horog, hány jelenet, mikor `szam` és mikor
`gorbe`, a narráció-mondat hossza). A skill 3 000 karakter alatt marad, az
aisignal tanulsága miatt: ami fölötte van, azt az ügynök nem látja.

Minden futás elején `videoLessons({ szerep: 'gyarto' })`. A tanulságok a
promptban nem szerepelnek, mert változnak; a tool az, ami mindig a jelenlegi
elfogadott készletet adja.

### 6.2 `video-lektor`

A render előtt támadja a tervet. A soulja azt mondja ki, amit a
decisions-fájl: a gyártó a saját munkájára elnéző, és ez a szerep azért
létezik, hogy valaki ne legyen az. A skillje (`video-lektoralas`) a
kódkészlet, amivel a találatot írja — a kód az, ami a találatot később
számmá teszi (6.3):

| kód | mit jelent |
|---|---|
| `horog_gyenge` | a `cimlap` nem mondja meg, miért nézze tovább |
| `allitas_forras_nelkul` | szám vagy állítás, amit a forrás nem tartalmaz |
| `sablon_rossz_helyen` | a típus nem azt fejezi ki, amit a jelenet mond (lista helyett `szam`, `gorbe` egy pont adatra) |
| `narracio_tul_hosszu` | a mondat nem fér a jelenetbe (L7 becslés vagy N-mérés alapján) |
| `tul_keves_tartalom` | a videó nem mond eleget a hosszához képest |
| `cta_nem_kovetkezik` | a felszólítás nem abból jön, amit a videó mondott |
| `utasitas_a_forrasban` | a forrás szöveg ügynöknek szóló utasítást tartalmaz, és a terv követte |
| `ismetles` | két jelenet ugyanazt mondja |

Az `elbukik` mindig találattal; az `atmegy` lehet találat nélküli, de a
lektor akkor is megírja a `note`-ban, mit nézett meg.

Toolok: `videoCatalog`, `videoVerdict`, `videoLessons`, `videoReviewMaterial`,
`videoPropose`. A lektor **nem** kap `videoDraft`-ot: aki tervet ír, az a
gyártó, és a szerep-elválasztás a tool-listán is látszik, nem csak a soulban.

A napi átnézés (6.4) is a lektor futása. Két ügynök van, és a kettő közül
az a reviewer, amelyik a gyártóval szemben áll. A lektor saját hibáit —
`atmegy`, amit a QA elbuktatott — a `videoReviewMaterial` **számként** adja
neki, és egy javaslat, ami a lektor saját ellenőrzését lazítaná, a lapon
pont olyan látható, mint a többi. A harmadik ügynök nem kell; egy
operátori döntés a javaslaton olcsóbb és jobb nála.

### 6.3 Sablon-eredményesség — szám, nem vélemény

A nyitott kérdés második fele: vezessen-e minden sablon saját
eredményességet. **Igen**, és nem tábla, hanem **számítás** a meglévő
sorokból, típusonként:

| mérőszám | miből |
|---|---|
| használat | `ext_video_tervek.jelenetek` — hányszor szerepelt a típus a legfrissebb tervekben |
| lektori találat | `ext_video_verdiktek.talalatok` — a típusra eső találatok, kódonként (a találat `jelenet` indexe → a terv jelenetének típusa) |
| QA-bukás | `ext_video_qa.bukasok[].at_ms` → a render jelenet-határaiból a típus (Q5 üres kocka a leggyakoribb) |
| visszajelzés | `ext_video_visszajelzesek.jelenet` vagy `at_ms` → típus |
| megtartás | a `ext_video_megtartas` görbe esése a jelenet határai között, a videó átlagához képest |

A jelenet-határok a renderelt lista `lathatoHossz` propjaiból és a
kompozíció fps-éből adódnak, és a render sorára kerülnek (`jelenet_hatarok`
JSON) az indításkor, hogy a mérések ehhez a listához kötődjenek, ne a
későbbi tervhez. Ha egy jelenetnek nincs mért hossza (nem fordulhat elő
renderelt listánál, mert a `videoRender` írja rá), a típus mérőszáma
`meretlen`, nem nulla.

A `sablonStat` a `videoCatalog` válaszában és a lap Sablonok nézetén
ugyanaz a számítás. A gyártó látja, hogy a `gorbe` az utolsó tíz videóban
négyszer kapott `sablon_rossz_helyen`-t; ez nem tiltás, hanem szám, és a
gyártó a skillje szerint dönt.

### 6.4 A napi átnézés — javaslat, nem átírás

Az operátor kérése: napi cron, ami az adott ügynökkel átnézi a
beszélgetéseket, és a visszatérő hibákból javítja az ügynököket és a
skilleket. A két felkínált mechanizmus — gépi szabály a visszajelzésből és
sablon-eredményesség — **mellé kerül**, nem helyette, mert a három három
különböző dolgot csinál a nyersanyaggal:

- a cron **prózát** csinál belőle (tanulság a soulhoz vagy a skillhez);
- a szabály-mechanizmus **kódot** (egy L-, N- vagy Q-szabályt);
- a sablon-eredményesség **számot** (6.3).

És pont ez a válasz arra, amit a decisions-fájl kimond: a 502 soros
visszajelzés-fájl az, ami akkor lesz, ha a nyersanyagot csak gyűjtik. A
próza egyedül ugyanoda vezet; ezért a cron kimenete korlátozott (≤ 400
karakter, bizonyítékkal, napi öt), és két másik alak áll mellette, amelyik
nem tud hízni.

**A kikötés, ami nem az operátoré:** az ügynök **javasol**, nem ír át. Egy
rossz tanulság, amit senki nem hagyott jóvá, ugyanúgy állandósul, mint egy
jó. A `videoPropose` az egyetlen író tool a napi futásban, és ez egy
táblába ír. Ügynök-promptot, skillt, szabályt a modul futásidőben **soha**
nem módosít.

**A menet** (a `video-tanulsag-napi` ütemezés, a lektorral):

1. `videoReviewMaterial()` — az átnézetlen fordulók, a verdikt–QA párok, a
   visszajelzések, a nyitott és az elutasított javaslatok, a sablon-számok.
2. A lektor a **visszatérő** mintát keresi, nem az egyszerit: ugyanaz a
   találat-kód három tervben; ugyanaz az operátori mondat két chatben;
   egy `atmegy`, amit a QA elbuktatott. Egyszeri hibából nem lesz
   javaslat — az a következő terv dolga.
3. Legfeljebb öt `videoPropose`, mindegyik a három fajta egyikében,
   bizonyítékkal:
   - `tanulsag` → `cel: agent:gyarto | agent:lektor | skill:…` — egy
     mondat, amit az ügynök a következő futástól megkap;
   - `szabaly` → egy **mérhető** feltétel (pl. „a `szam` jelenet narrációja
     ≤ 6 másodperc”), ami L-, N- vagy Q-szabály lehetne;
   - `sablon` → egy képesség, ami a kitből hiányzik.
4. A futás a `note`-jában megmondja, hány fordulót nézett át, és a tool a
   fordulókat `atnezve_at`-tal jelöli — a **lezáráskor**, nem az
   olvasáskor, hogy egy félbeszakadt futás fordulói visszajöjjenek.

**Hol jelenik meg a javaslat:** a lap Javaslatok nézetén (7.), a
bizonyítékkal, egy kattintásra a hivatkozott videóhoz vagy fordulóhoz. Nem
kerül a chatbe, és nem küld értesítést: a lap az a hely, ahol az operátor
egyben látja, hogy ma mit kér tőle a modul, és egy értesítés hét darabból
öt lenne, ami nem az.

**Hogyan lesz belőle valami** — fajtánként más, és ez a lényeg:

| fajta | elfogadás | mi történik |
|---|---|---|
| `tanulsag` | `decideProposal` a lapon | sor az `ext_video_tanulsagok`-ba, `aktiv = 1`; a cél ügynök a következő `videoLessons`-nál megkapja. Célonként legfeljebb 12 aktív; a 13. elfogadása visszautasítva (`tanulsag_sapka`), amíg az operátor egyet vissza nem von — vagy be nem építi a soulba/skillbe **ebben a repóban, commitként**, ami után a tanulság visszavonható. A sapka az, ami a prózát nem hagyja hízni. |
| `szabaly` | `decideProposal` | `elfogadva` státusz és a lapon „kódolásra vár”. A szabály **kód**, tehát az elfogadása egy fejlesztői feladat ebben a repóban: az L/N/Q-készlet bővül, a `szabalykeszlet` nő, és a szabály sora a javaslat id-jét hordozza. Amikor egy készlet-verzió hivatkozik rá, a javaslat `kodolva` lesz. Egy szabály, amit elfogadtak, de fél éve nem kódoltak, a lapon látszik — ez a lista a fejlesztés backlogja. |
| `sablon` | `decideProposal` | `elfogadva`, és a lapon „a kitre vár”. A munka a Remotion-repóban van, és külön. A javaslat akkor lesz `kodolva`, amikor a `videoCatalog` egy olyan katalógust olvas, amiben a javaslat `szoveg` mezőjében megnevezett típus szerepel. |

Az **elutasítás** megjegyzéssel jár, és a megjegyzés a következő átnézés
nyersanyaga (`elutasitottJavaslatok`): egy javaslat, amit az operátor
egyszer „nem, ez a videó szándékosan ilyen volt” szöveggel elutasított, nem
jön vissza ugyanazzal a címmel (`javaslat_duplikat` az elutasítottakra is
áll 30 napig).

**Mi a bizonyíték arra, hogy ez működik:** a verdikt–QA párok és a
sablon-számok időben. Ha a napi javaslatok jók, a QA-bukások száma
renderenként csökken, és a lektori találatok kódonként ritkulnak. Ez a lap
Sablonok nézetének második fele: nem a típusok, hanem a hetek.

### 6.5 A fordulók rögzítése

Az `afterChatTurn` hook minden olyan futásnál tüzel, ahol a modul be van
kapcsolva a run extension-listájában — ez a két managed agent, és minden
ügynök, amelyre az operátor kézzel rátette a modult. A hook egy sort ír az
`ext_video_fordulok`-ba a 3.1 szerint vágva, és **soha nem dob**: a
hook-hiba a host failure-számlálóját növeli, három után a modul le van
tiltva, és egy le nem írt forduló olcsóbb, mint egy letiltott modul. A
sorok 60 nap után törlődnek a napi átnézés végén.

Egy operátori chat a gyártóval — „ez a szám rossz volt, a forrás 40%-ot
mond” — így kerül a másnapi átnézés elé, a `forras: chat` jelöléssel, és
egy ütemezett futás záró üzenete ugyanoda, `forras: schedule`-lel.

## 7. Ütemezések

Mind a három `taskMode: 'task'` és `taskPrompt`-tal, hogy a host in-flight
őre mérje őket (egy futó feladatra a következő slot `in_flight`-tal
kimarad); mind `Europe/Budapest`; a percek különböznek egymástól és az
aisignal `0`/`30` perceitől, hogy egy scheduler-tick ne indítson kettőt.

| kulcs | cron | ügynök | mit |
|---|---|---|---|
| `video-gyartas-napi` | `15 7 * * *` | gyártó | a `napiSapka` (alapból 1) számú új videó nyitása a legmagasabb `apply_score`-ú mentett AI Signal kártyából, amiből még nincs videó; a `lektoralt` videók narrálása és renderelése; a `fut` renderek státuszának rendezése |
| `video-lektoralas-orankent` | `45 8-20 * * *` | lektor | minden `terv` státuszú videó legfrissebb tervének lektorálása |
| `video-tanulsag-napi` | `20 6 * * *` | lektor | a 6.4 menete |

A gyártó és a lektor egy napon belül így többször átadja egymásnak a
videót: 07:15 terv → 08:45 verdikt → ha elbukott, a gyártó legközelebb
**másnap** 07:15-kor javít. Ez lassú, és szándékosan az: egy napi egy videó
mellett a lassúság ára nulla, a gyorsítás ára pedig egy második gyártó-slot,
ami a render-őrrel ütközne. Ha a `napiSapka` később nő, a gyártó cronja
sűrűsödik, nem a modul változik.

`status: 'active'` mindhárom, az aisignal indoka miatt: egy szünetelve
érkező ütemezést senki nem kapcsol be. Ugyanaz a következmény is:
**friss telepítés után nincs ügynök és nincs ütemezés, amíg az operátor
egyszer nem nyom Reconcile-t**, és a lap állapotsávja ezt mondja is (7.1).

A gyártó és a lektor `heartbeatEnabled: false`, providert nem rögzít, az
aisignal indokával.

## 8. A lap: `/x/video`

Egy oldal, egy `board` betöltés, egy állapotsáv és négy nézet. A host
primitívjeit használja, a 123 CSS-tokent örökli, és nincs benne `innerHTML`,
`dangerouslySetInnerHTML` vagy `eval`. Minden szöveg React-gyerekként
rendereződik; az egyetlen link a forrás kártya `url`-je, `safeHref`-en át.
A fájlútvonal **szövegként** jelenik meg, nem linkként: `file:` sémát a
`safeHref` úgyis elutasít, és egy másolható útvonal az, amit az operátor
kér.

**Állapotsáv.** Egy mondatban, külön tényekként, összemosás nélkül:
a Remotion-könyvtár beállítva és egészséges-e (a `health` kódjaival:
`remotion_dir_hianyzik`, `ffmpeg_hianyzik`, `chrome_hianyzik`,
`platform_nem_mac`); a `tts.narration` és az `aisignal.signals` szerződés
feloldható-e, és ha nem, a `why` oka szó szerint; a managed erőforrások
állapota a host összefoglalójából (**„nincs ütemezés — Reconcile kell”**
külön mondat, nem ugyanaz, mint „ma még nem futott”); a legutóbbi három
futás ideje és kimenetele ütemezésenként; a futó render id-je és eltelt
ideje.

**Sor** (alapnézet). A videók státusz szerinti oszlopokban (2.3), minden
kártyán a cím, a forrás, a legfrissebb terv verziója, a verdikt, a render
és a QA állapota. Egy `qa_hiba` kártya a bukott szabály kódját mutatja, egy
`render_hiba` a hibakódot. Innen nyílik a Videó nézet.

**Videó.** Egy videó mindene: a forrás szövege (nyersen, egy „idegen
szöveg” jelöléssel a doboz fölött), a legfrissebb terv jelenetenként (típus,
propok, narráció-mondat, mért hossz), a verdiktek találatai jelenetre
mutatva, a QA mérései és bukásai, a fájl útja és sha256-ja, egy idővonal a
jelenet-határokkal, rajta a visszajelzések és — ha van — a megtartási
görbe. Itt van a **visszajelzés-beviteli mező**: `at_ms` és `jelenet` a
kattintott idővonal-pontból előtöltve, a szöveg mellé. És a `Lezár` gomb,
ami a videót `lezart`-ra teszi (nem törli).

**Javaslatok.** A nyitott javaslatok fajta szerint, mindegyiknél a
bizonyíték hivatkozásai kattinthatóan, `Elfogad` / `Elutasít` gombbal és
megjegyzés-mezővel. Alatta az elfogadott, de még nem kódolt `szabaly` és a
kitre váró `sablon` javaslatok — ez a backlog. Legalul az aktív
tanulságok célonként, `Visszavon` gombbal, és a célonkénti számláló
(„9/12”).

**Sablonok.** A 6.3 számai típusonként, és a heti sor: renderek, QA-bukások,
lektori találatok kódonként.

### 8.1 RPC

| metódus | mi | ír? |
|---|---|---|
| `board` | a Sor nézet és az állapotsáv egy betöltésben, számokkal és sapkákkal | nem |
| `video` `{ id }` | a Videó nézet mindene | nem |
| `feedback` `{ videoId, renderId?, atMs?, jelenet?, szoveg }` | visszajelzés-sor | igen |
| `lezar` `{ videoId }` | státusz `lezart` | igen |
| `cancelRender` `{ renderId }` | a `fut` render megölése, `hiba: render_megszakitva` | igen |
| `proposals` | a Javaslatok nézet | nem |
| `decideProposal` `{ id, dontes: 'elfogad' \| 'elutasit', megjegyzes }` | a 6.4 táblázata | igen |
| `retireLesson` `{ id }` | `aktiv = 0` | igen |
| `templates` | a Sablonok nézet | nem |
| `importFeedback` `{ sorok: [{ videoId, atMs, jelenet, szoveg }] }` | fájl-import, idempotens `(video_id, at_ms, jelenet, szoveg)` szerint | igen |
| `importRetention` `{ sorok: [{ videoId, platform, tS, arany }] }` | fájl-import, PK szerint idempotens | igen |
| `health` | a `remotionDir` és az eszközök ellenőrzése, a szerződések `why`-a, számok — kulcs- és tokenérték soha | nem |

Az import két metódusa azért rpc és nem tool: az adat az operátoré, a
Studio-ból egy általa futtatott lekérdezéssel jön (`SELECT video_id,
at_ms, scene_no, text FROM feedback` alakban, JSON-ként mentve), és egy
ügynöknek nincs oka betölteni. A `videoId` a Studio-oldali id → modul-id
hozzárendelést kívánja; ezt az operátor a Videó nézeten adja meg
(`forras_id` mezőként), és az import a nem hozzárendelt sorokat névvel
utasítja el, nem dobja el csendben.

## 9. Szerződések

### 9.1 Amit a modul fogyaszt

```js
consumes: [
  { extension: 'aisignal', contract: 'signals', version: 1,
    reason: 'A mentett kártyákból választ videó-nyersanyagot; a kártya szövegét a videó forrásaként tárolja.' },
  { extension: 'tts', contract: 'narration', version: 1,
    reason: 'Jelenetenkénti narrációt kér a tervhez, és a kész mp3 útját és hosszát tárolja.' },
]
```

Mindkettő hiánya **nem betöltési hiba**: a modul betölt, a lap mondja, mi
hiányzik, és az érintett tool a `why` okával utasít el. Egy videómodul,
ami az AI Signal nélkül nem indul, csendben nem indulna; egy, amelyik
`kezi` forrásból dolgozik tovább, hasznos.

A `signals` szerződésen átjövő `summary`, `headline` és `url` **idegen
szöveg**, és a szerződés `summary`-ja ezt ki is mondja. A modul nem
tisztítja (a host `guardUntrustedText`-jét extension-kód nem éri el, és a
mintaillesztés nem is védelem); a modul azt teszi, amit tehet: a szöveget a
`forras_szoveg` mezőn, változatlanul tárolja, a tool válaszában egy
`forrasFigyelmeztetes` mondat mellett adja át, és a két soul a Scout
szabályát viszi tovább. A kimenő csatorna pedig ebben a modulban **nincs**
(10.).

### 9.2 Amit a modul kínál

```js
provides: {
  videos: {
    version: 1,
    summary: 'Kész és készülő videók: lista és egy videó id szerint. A cím, a narráció és a forrás szövege ügynök és idegen szöveg; kimenő csatorna elé csak ellenőrizve.',
    methods: { list, get },
  },
}
```

A vetítés rögzített: `id`, `cim`, `status`, `forras_tipus`, `forras_id`,
`out_path`, `file_sha256`, `hossz_ms`, `narracio_szoveg` (a jelenetek
mondatai összefűzve — egy leendő publikáló modulnak a leírás ebből lesz),
`created_at`, `qa_ok_at`. **Nincs benne** a `forras_szoveg`, a jelenetlista,
a verdiktek és a QA mérései: ezek a lap alakja és a modul belügye, és egy
fogyasztó, aki a jelenetlistát kapja, a Remotion-hoz csatolódna a modul
háta mögött. Metódus később verzióemeléssel jöhet; a szerződés nem nő
azért, mert a lap nőtt.

Ma ennek a szerződésnek nincs fogyasztója. Az aisignal `signals`
szerződése is így indult, és a mechanizmus próbája éppen az, hogy két
szolgáltató és két fogyasztó együtt fut-e.

### 9.3 A `tts` extension

Külön extension, a decisions-fájl szerint globális. Amit itt rögzítünk, az
a felülete; a részletei a saját, rövid implementációs tervében.

**Táblák.** `ext_tts_kerelmek` — `id`, `szolgaltato` (`soniox`), `modell`,
`hang`, `nyelv`, `szoveg_hash`, `szoveg` (nyersen), `fajl` (abszolút út),
`hossz_ms`, `bajt`, `status` (`kesz`, `hiba`), `hiba_kod`, `kerte`
(`contract:<extensionId>` vagy `mcp`), `created_at`. UNIQUE
`(szolgaltato, modell, hang, nyelv, szoveg_hash)` — ez a **cache-kulcs**,
és ez gátol: egy már elkészült mondat nem megy még egyszer a Sonioxhoz.
`ext_tts_napi` — `(nap)` PK, `masodperc` — a napi keret számlálója.

**Beállítások** (`settingsFields`): `apiKey` (`secret`), `endpoint` (alap az
EU végpont), `modell` (alap `tts-rt-v1`), `hang` (alap `Kenji`), `nyelv`
(alap `hu`), `napiKeretMp` (alap 900: egy videó narrációja ≤ 130 s, hat
videó egy nap bőven a felső határ, és egy elszabadult hívássorozat ennél
áll meg).

**Szerződés** `narration v1`, `summary`: „Szöveget mondat-hosszú mp3-má
alakít a beállított hanggal; cache-ből, ha már elkészült. A napi keret és
a szolgáltató egyenlege gátolhatja.” Metódusok: `synthesize({ szoveg,
celFajl, hang?, nyelv? })` → `{ kerelemId, fajl, hosszMs, cache }` vagy
dobás `TtsError`-ral, `code` ∈ `{ tts_kulcs_hianyzik, tts_keret_kimerult,
tts_szolgaltato_visszautasitott, tts_halozat, tts_celfajl_ervenytelen }`;
`status()` → `{ kulcsBeallitva, maiMasodperc, napiKeret }`. A `celFajl`
abszolút út, és a metódus **oda** ír, nem a saját könyvtárába: a fogyasztó
tudja, hova kell a fájl (a Remotion `public/`-ja), a tts nem.

A Soniox egyenleg-kimerülés HTTP-kódját a spec nem tudja: a fiók ma
kimerült, és a felmérés szerint egyik repóban sincs narráció-generáló
szkript, amiben a válasz alakja látszana. Az első éles hívás mondja meg;
addig minden nem-2xx válasz `tts_szolgaltato_visszautasitott` a HTTP
státusszal a `message`-ben, és a kimerülés kódja akkor válik külön kóddá,
amikor egyszer látszott.

**A 404 meglévő mp3.** Bemásolható a cache-be, ha megvan hozzájuk a
szöveg, amiből készültek; hogy a Studio tárolja-e mondatonként a
narráció-szöveget a fájl mellett, a felmérésből nem derült ki. Ha igen, egy
`importCache` rpc `{ szoveg, fajl }` párokból tölti a táblát; ha nem, a
404 fájl a régi videóké marad, és az új narráció az integráció után készül.
Ezt egy `SELECT` a Studio-ban dönti el, amit az operátor futtat.

**MCP-szerver.** `mcp/server.mjs` a workspace-ben, stdio transport, két
tool: `tts_synthesize` és `tts_status`. **Nem** hívja a Sonioxot maga: a
host rpc-jére (`POST /api/extensions/tts/call/synthesize`) továbbít, mert a
kulcs, a cache és a napi keret **egy** helyen él, a host processzben, és
egy második processz, ami maga hív, a keretet megkerülné. Az rpc-t a host
access-key ellenőrzése védi, ezért a McpServerConfig `env`-je viszi a
`SWARMCLAW_BASE_URL`-t és a `SWARMCLAW_ACCESS_KEY`-t. A regisztráció
operátori konfiguráció (Settings → MCP Servers), és a tts lapja a pontos
bejegyzést mutatja másolható alakban — a host nem ad extension-nek
API-t MCP-szerver regisztrálására, és egy install-szkript a host
adatbázisába nem ír. Uninstall után a shim névvel bukik (`404 not_found` a
rpc-től → `tts_extension_hianyzik`), nem csendben.

Amit ez nem old meg: az Electron-app portja dinamikus, és egy újraindítás
után a bejegyzés rossz portra mutat. Hogy a desktop-appban van-e rögzíthető
port, az `electron/server-lifecycle` olvasása dönti el; ha nincs, a shim
a `SWARMCLAW_HOME` alatti port-fájlból olvas, amit a host ír — ez egy kis
host-változás, és a tts tervének része lesz, ha a rögzített port nincs.

## 10. Ami soha nem történhet meg

Az AI Signal mintájára, kimondva:

1. **A modul nem publikál.** Nincs benne connector, nincs benne feltöltő
   tool, és a `qa_ok` a legvégső állapot. Egy kész videó egy fájl egy
   útvonalon; onnan az operátor viszi ki. A publikálás kifelé néző és
   visszavonhatatlan, és ez a modul egy ügynök-sorral dolgozik, amelynek a
   nyersanyagát idegenek írták — a kettő közé egy ember kell, és az az
   operátor.
2. **Idegen szöveg nem lesz utasítás.** A `forras_szoveg`, a
   visszajelzés, a narráció és a propok sztringek: tárolva nyersen,
   átadva mezőn, kirajzolva React-gyerekként. Sehol nem kerülnek shellbe,
   fájlnévbe, URL-be, HTML-be, és nem dönt rajtuk el semmit a kód. A
   `utasitas_a_forrasban` találat-kód az, amivé egy injekciós kísérlet
   válik: sor, nem tett.
3. **Nincs `.tsx`.** A modul a Remotion-projekt `src/` alá nem ír, a
   projektben `git`-et és `npm`-et nem futtat, és két saját alkönyvtáron
   kívül semmit nem érint. Ha egy render-hiba a projekt forrásában van, az
   a Remotion-repó feladata, és a render sora a hibát a log útjával együtt
   mondja meg.
4. **Nincs render lektor nélkül, nincs `qa_ok` mérés nélkül, és egyik
   engedély sem él túl egy változást.** A hash-ek és az ujjlenyomat a
   3.2-ben.
5. **Egy időben egy render.** A gép telítése nem elvi kérdés; a részleges
   unique index a barrier.
6. **Az ügynök nem írja magát.** Sem a soul, sem a skill, sem a szabály
   nem változik futásidőben; a napi cron táblába ír, az operátor dönt, és a
   szabály kód lesz egy commitban. A `<home>/skills` alá a modul futás
   közben soha nem ír — csak az install-szkript, a manifestjével.
7. **A Studio SQLite-jához a modul nem nyúl** — olvasásra sem. Ami onnan
   kell, fájlból jön, az operátor kezéből.
8. **TTS-költség nem megy el kétszer és nem megy el keret fölött.** A
   cache-kulcs és a napi számláló a tts-extensionben, és a `videoNarrate`
   csak a narráció-hash változásakor hív.
9. **Kulcs- és tokenérték nem kerül válaszba, naplóba, sorra.** A `health`
   igen/nem-et mond a kulcsról, nem értéket.

## 11. Telepítés, hiba, eltávolítás

Az AI Signal záró átnézése három olyan hibát talált, amelyek mind a
feladatok **közé** estek: egy telepítés, ami csendben soha nem fut; egy
beragadt extension, ami a szerver indulását blokkolja; egy eltávolított
modul, ami tovább indít fizetős modellhívásokat. Ez a szakasz az, ami ebben
a specben nem hagyja ugyanezt a lyukat.

### 11.1 Telepítés — és mitől fut ténylegesen

Az `scripts/install.mjs` ugyanaz a minta: workspace-másolat (`src/`,
`dist/`, `index.js`, `package.json`), a `video.mjs` shim, a skillek a
`<home>/skills` alá és a `shipped-skills.json` manifest. Ennyi **nem
elég**, és a lap ezt mondja is. Egy telepítés akkor fut, ha az alábbi
mind igaz, és az állapotsáv mindegyikről külön mondatot mond:

| lépés | ki | mi látszik, ha hiányzik |
|---|---|---|
| a `tts` extension telepítve és engedélyezve, `apiKey` beállítva | operátor | `tts.narration`: `provider_missing` / `provider_disabled`; a `videoNarrate` névvel utasít el |
| az `aisignal` engedélyezve | operátor | `signals`: `provider_disabled`; a `videoOpen` `kezi` forrással megy, `signal` nem |
| `remotionDir` beállítva, létező, benne a három kötelező fájl | operátor | `remotion_dir_hianyzik` / `katalogus_hianyzik` |
| `ffmpeg`, `ffprobe`, `npx` a host PATH-ján | operátor | `render_eszkoz_hianyzik`, eszközönként |
| Chrome Headless Shell a projektben | `npx remotion browser ensure` az első rendernél, vagy kézzel | `chrome_hianyzik` |
| **Reconcile** az Extensions → Managed resources lapon | operátor | **„nincs ütemezés — Reconcile kell”**; a Sor üres, és a lap nem mondja, hogy „még nem futott” |

A `setupChecks` deklaráció (`ffmpeg`, `ffprobe`, `npx`, `command` fajta)
a host kártyáján megjelenik, de a host ma nem futtatja őket — a valódi
ellenőrzés a `health` rpc, és a lap onnan olvas. A kettő nem mondhat
mást: a `setupChecks` lista a `health` kódjaiból generálódik, egy helyről.

Az install-szkript a végén kiírja ezt a hat lépést, és azt, hogy melyik
hiányzik még — a `health`-et nem tudja hívni (nincs futó host), de a
könyvtárat, az eszközöket és a PATH-t meg tudja nézni, és megnézi.

### 11.2 Betöltés és futás közbeni hiba

- **Nem blokkol indulást.** Az entry modulban nincs top-level `await`,
  nincs fájl- vagy hálózati művelet; az importnak a 30 másodperces
  host-határ töredéke alatt kell végeznie, és ezt a deploy-smoke teszt
  méri (11.4). A katalógus-olvasás, az eszköz-ellenőrzés és a
  `browser ensure` mind tool- vagy rpc-hívás, sosem betöltés.
- **`setup()` nem hagy hátra semmit.** Szinkron, idempotens, `state`-et
  tölt. Az `exit` kezelő a gyerekfolyamaton nem `setup()`-ban, hanem a
  `videoRender`-ben jön létre, és idempotens írásokat végez (3.4).
- **A hookok nem dobnak.** Az `afterChatTurn` mindent elkap; egy hiba
  `state.log.warn`. Három egymást követő hook- vagy tool-hiba a host
  szabálya szerint letiltja a modult, és ez a modul számára a rosszabb
  irány: egy letiltott videómodul három ütemezése **tovább tüzel** (lásd
  a következő pontot).
- **Letiltott extension ütemezései.** A host `setEnabled(false)` és az
  automatikus letiltás a config-bejegyzést írja és újratölt; a managed
  ütemezésekhez nem nyúl. Az eltávolítás törli őket
  (`extension-managed-teardown.ts`), a letiltás nem. Egy letiltott
  videómodul így naponta tizenöt futást indít egy ügynökkel, amelynek a
  tooljai nincsenek, és mind a tizenöt modellhívás. **Ez host-változás,
  és a modul előfeltétele:** a scheduler `tick()`-je egy
  `managedByExtension`-nel jelölt ütemezést csak akkor indít, ha az
  extension betöltve és engedélyezve van; különben `reason:
  'extension_disabled'`-del kihagyja és lépteti, ugyanúgy, ahogy ma az
  `agent_disabled`-et. Egy hely, mindkét letiltási út (kézi és
  automatikus) ugyanoda ér, és nem kell szünetelés-visszaállítás
  jelölőt cipelni. A tesztje: letiltott extension, `active` managed
  ütemezés, egy tick → nincs feladat, van napló.
- **Render-hibák** a render sorára, kóddal és a log útjával
  (`render_megszakadt`, `render_idotullepes`, `render_kilepesi_kod` a
  kóddal, `render_kimenet_hianyzik`). A watchdog a 3.4-ben.
- **Lemez.** A `out/swarmclaw/<videoId>/` alatt videónként a legutóbbi
  `megtartottRenderek` (alap 3) render marad; a régebbi könyvtárakat a
  napi gyártó futás elején a modul törli — csak a saját alkönyvtára alatt,
  csak olyat, aminek van sora, és a törlés a sorra íródik
  (`out_path = NULL`, `torolve_at`).
- **Egy `fut` sor a host indulása után** kezelő nélkül áll; az első
  `videoRenderStatus` vagy a napi futás rendezi. A lap addig „futó render,
  eltelt idő ismeretlen a host újraindulása óta” mondatot mutat, nem
  „fut”.

### 11.3 Eltávolítás — mit csinál a host, és mit nem

A host `deleteExtension`-je: törli a fájlt és a workspace-t, **törli** a
managed ütemezéseket, **kukába teszi** a managed ügynököket, eltávolítja a
manifest szerinti skill-könyvtárakat, eldobja az `ext_video_` táblákat és a
migrációs sorokat, törli a beállításokat. Ezt a spec nem ismétli meg, csak
támaszkodik rá. Amit a host **nem** csinál, és amit a modulnak vagy az
operátornak kell:

| mi | ki | hogyan |
|---|---|---|
| a futó render gyerekfolyamata | senki nem öli meg: a hostnak nincs uninstall-hookja, és a táblát, amiben a pid áll, az uninstall eldobja | a folyamat befejezi a fájlt egy könyvtárba, amit már senki nem olvas, vagy egy beragadt Chrome-ként marad, amit már semmi nem keres. Ezért a lap `Uninstall előtt` szakasza első lépésként mondja: „állítsd le a futó rendert (`cancelRender`)”, és a `health` a futó rendert az uninstall-útmutató mellett is számmal mutatja |
| `out/swarmclaw/` és `public/narracio/` a Remotion-projektben | operátor | ezek az operátor lemezén vannak, egy másik repóban; a modul nem törli más repó fájljait. A lap `Tisztítás` gombja (rpc `cleanup`) törli mindkettőt, és az uninstall-útmutató első lépése ez |
| a `videos` szerződés fogyasztói | a host: a következő hívásuk `provider_missing` | ma nincs ilyen; ha lesz, a saját lapja mondja |
| a `tts` MCP-regisztráció | operátor | a tts lapja mondja, hogy Settings → MCP Servers alól törlendő; a shim addig `tts_extension_hianyzik`-kal bukik |

A `tts` eltávolítása a videómodult nem töri: a `videoNarrate`
`provider_missing`-gel utasít el, a lap mondja, és a többi állapot megy.

Az **újratelepítés** a hostnál üres táblákkal indul (a drop miatt), és a
Reconcile-t újra kéri; a Remotion-projekt alatti régi fájlok, ha a
`Tisztítás` nem futott, sorok nélkül állnak, és a napi lemez-takarítás nem
nyúl hozzájuk (nincs soruk). A lap `health`-je jelzi, ha az `out/swarmclaw/`
alatt sor nélküli könyvtár van, számmal.

### 11.4 Amit a tesztek lehorgonyoznak

| egység | hogyan |
|---|---|
| a 3.2 minden kulcsa | `db.test.mjs`: régi verzióra verdikt → `terv_elavult`; azonos agent → `onlektoralas`; verdikt régi hash-sel → `verdikt_elavult`; második `fut` render → unique-hiba, tool-szinten `render_folyamatban`; új sha → nincs `qa_ok` |
| `videoDraft` L-szabályai | rögzített katalógus-fixtura ellen: ismeretlen típus, hiányzó kötelező, ismeretlen prop, `hang` kézzel → visszautasítás; L6–L8 figyelmeztetés |
| a QA-kapu | három rögzített mp4-fixtura (`ffmpeg`-gel generálva a tesztben): egy jó, egy néma, egy üres kockával; a mérések és a bukás-kódok; sha-változás voidolja a passt |
| a Q4 kalibrálás | egy szkript a meglévő átment videókon, a `d=` ablak kimenetével — az implementáció része, nem CI |
| render-életciklus | mock-spawn: kilépés 0 fájllal → `kesz` + QA; kilépés 1 → `render_kilepesi_kod`; pid halott fájl nélkül → `render_megszakadt`; `started_at` régi → `render_idotullepes` és kill |
| szerződések | `tts` double: cache-találat, `tts_keret_kimerult` átadva; `signals` hiánya → `videoOpen` `why`-jal |
| a napi átnézés | `videoPropose`: bizonyíték nélkül, nem létező id-vel, duplikát, hatodik javaslat → visszautasítás; elfogadás → tanulság aktív; 13. elfogadás → `tanulsag_sapka` |
| `afterChatTurn` | dobó storage → nincs kivétel, van warn; a sor 4 000-re vágva |
| a promptok a toolok ellen | `agents.test.mjs` mintájára: minden tool- és mezőnév a promptokban létezik; a skillek 3 000 karakter alatt |
| scheduler-kihagyás letiltott extensionre | host-teszt: letiltott extension managed ütemezése egy tick alatt nem indul |
| deploy-smoke | az aisignalé kibővítve: import-idő mérése (< 5 s a 30-as határ alatt bőven), `health` alakja, a lap a shellből, a `videos` szerződés a kártyán |
| UI | Playwright: visszajelzés bevitele idővonal-kattintásból; javaslat elfogadása és megjelenése a tanulságok közt; „Reconcile kell” látszik friss telepítésen |

## 12. Ami az első verzióban szándékosan nincs

- **Publikálás** bármelyik platformra. A `videos` szerződés a leendő
  publikáló modulnak van; az egy külön modul, saját emberi kapuval.
- **Render VPS-en.** A tipográfia és a Chrome miatt; a modul ott betölt és
  tervez, a render `render_host_platform`.
- **Megtartási görbék lekérése** a platformokról. Import fájlból van; hogy
  a Studio ma honnan kapja a 26k sort, a felmérés nem mondta meg, és ezt a
  Studio ingestorának az elolvasása dönti el.
- **Képgenerálás** és bármilyen asset készítése. Csak létező `public/`
  fájl hivatkozható (L4).
- **Új kit-sablon** ebből a repóból. A `sablon` javaslat a Remotion-repó
  backlogja.
- **Egybefüggő narrációs sáv** (`FosVideo.narracio`); a modul jelenetenként
  dolgozik.
- **Több hang, több nyelv.** A tts egy hangot és egy nyelvet állít be.
- **Harmadik ügynök**, automatikus javaslat-elfogadás, a soul vagy a skill
  futásidejű írása.
- **Kézzel írt `.tsx` kompozíció** bármilyen úton; a decisions-fájl
  következménye.
- **Több egyidejű render**, napi egynél több gyártó-slot.

## 13. Amit nem tudunk, és mi döntené el

- **A Soniox kimerült-egyenleg válaszának alakja.** Az első éles hívás
  a feltöltött fiókkal; addig egy közös kód a HTTP-státusszal.
- **A 404 mp3 szövege.** Egy `SELECT` a Studio-ban: van-e mondat a fájl
  mellett. Ha van, cache-import; ha nincs, a régi videóké maradnak.
- **A záró tartás kockaszáma** és a render-parancs pontos entry-je: a
  Remotion-projekt `Film.tsx`/`idovonal` és a render-szkript olvasása,
  csak olvasva, az implementáció első lépéseként.
- **A Q4 `silencedetect` ablaka**: a kalibrálás a meglévő átmenőkön (5.3).
- **A desktop-app portja** a tts MCP-shimhez: az `electron/server-lifecycle`
  olvasása; ha nincs rögzíthető port, egy port-fájl a host részéről.
- **Honnan jönnek a megtartási sorok**: a Studio ingestorának az olvasása.

Egyik sem szám, amit ez a spec kitalálhatna; mindegyik egy fájl vagy egy
hívás, ami megválaszolja.
