# Videó: kézi vezérlés, YouTube-forrás, és az első éles futás — terv

> **Végrehajtóknak:** a lépések `- [ ]` jelölésűek, tickeld őket. A repo
> konvenciója: teszt előbb, minden feladat végén commit, és `npx eslint` a
> változtatott fájlokra.

**Cél:** a videó modul ma kilenc megnyitott videót tárol és **nulla** tervet,
narrációt, rendert és lektori ítéletet — a lánc egyetlen lépést sem tett meg. Ez
a terv három dolgot ad hozzá: kézi fogantyút a lapra, egy második ötletforrást,
és az első végigvitt éles futást.

**Előfeltétel, ami már megvan:** az `a6a860a` commit óta mindhárom modul MCP-ként
is kínálja a tooljait, és a `claude-cli.ts` átadja az ügynökhöz rendelt
szervereket. A `Videó Gyártó` megkapja a Video, Doksik és Soniox MCP-t. **Ez
élesben még nincs igazolva** — lásd a 4. feladatot.

---

## A kiinduló állapot, mérve

| tábla | sorok |
|---|---|
| `ext_video_videos` | 9 (mind `forrás: kezi`) |
| `ext_video_tervek`, `_narraciok`, `_renderek`, `_qa`, `_verdiktek` | 0 |
| `ext_video_javaslatok`, `_tanulsagok`, `_fordulok` | 0 |
| `ext_aisignal_items`, `_sweeps` | 0 |

A lap rpc-je ma ezt tudja: `board`, `video`, `feedback`, `lezar`,
`cancelRender`, `cleanup`, `health`, `proposals`, `decideProposal`,
`templates…`, `importFeedback`, `importRetention`, `retireLesson`.
**Nincs benne** `videoOpen`, `videoPlan`, `videoDraft`, `videoNarrate`,
`videoRender` — ezek csak ügynök-toolként léteznek.

## Két operátori döntés, rögzítve

1. **A gomb megrendeli az ügynöktől, és látod, ahogy halad.** A tervírás és a
   lektorálás érdemi LLM-munka; egy weblap nem tudja elvégezni, csak
   megrendelni. A mechanikus lépések (narráció, render, nyitás) közvetlenül
   futnak, ügynök nélkül.
2. **A YouTube-ág megadott csatornák friss feltöltéseit hozza**, nem kulcsszavas
   keresést. `yt-dlp`-vel, ahogy a Hermes csinálja — **nem kell API-kulcs**.

---

## Feladat 1: a lap el tudja indítani a mechanikus lépéseket

A determinisztikus lépések nem igényelnek ügynököt: a narráció a `tts`
szerződésen megy, a render egy gyerekfolyamat, a nyitás egy sor beszúrása.

**Files:**
- Modify: `extensions/video/src/rpc.mjs`
- Modify: `extensions/video/ui/video.tsx`, `extensions/video/ui/api.ts`
- Modify: `extensions/video/ui/style.css`
- Modify/Create: `extensions/video/test/rpc.test.mjs`, `test/ui.test.mjs`

**Interfaces (új rpc-metódusok):**
- `narral({ tervId })` → ugyanaz, amit a `videoNarrate` tool csinál
- `renderel({ tervId })` → ugyanaz, amit a `videoRender` tool csinál
- `nyit({ forras, forrasSzoveg, cim })` → ugyanaz, amit a `videoOpen` tool

Mindhárom **ugyanazt a szolgáltatás-függvényt hívja**, amit a tool — nem
másolat. Ha a modulban ez ma nincs külön kiemelve, emeld ki: a tool és az rpc
két bejárat, egy szabály. (A Doksik modul `src/service.mjs`-e ugyanezt a mintát
követi, érdemes megnézni.)

- [ ] **1.1** Írd meg a bukó teszteket: mindhárom metódus a megfelelő
      szolgáltatás-hívást végzi, és **egyik sem dob** — elromlott állapotra is
      megnevezett hibát ad (`{ hiba, uzenet }`), mert egy dobó rpc a lapon néma
      500 lesz.
- [ ] **1.2** Írd meg a három metódust az `rpc.mjs`-ben.
- [ ] **1.3** A lapon: a „Terv" szekcióba **Narráció kérése** gomb (ha van terv
      és nincs még narrációja), a „Renderek" szekcióba **Render indítása** (ha
      van narrált terv és nem fut render). Letiltott állapotban a gomb **mondja
      meg, miért** — a modul UX-elve szerint egy sötét vezérlő megindokolja
      magát.
- [ ] **1.4** A „Sor" nézetbe **Új videó** gomb, ami a `nyit`-ot hívja.
- [ ] **1.5** `npm test` a modulban, `npx eslint`, `npm run build`, commit.

---

## Feladat 2: a lap megrendelheti a tervet és a lektorálást

Ez a nehezebb fele. A lap **nem** tud tervet írni — egy ügynök-fordulót indít.

**Mechanizmus.** A lap a böngészőben, a host héjában fut, tehát ugyanúgy hívja a
host saját API-jait, ahogy a `ui/managed-state.ts` már ma is teszi
(`/api/extensions/managed-resources`). A megrendelés:

1. `POST /api/chats` — session a `Videó Gyártó` ügynökkel
2. `POST /api/chats/{id}/chat` — konkrét utasítás, pl. *„Írj tervet a
   `<videoId>` videóhoz a `videoDraft` toollal. Ne csinálj mást."*
3. a lap a `board`/`video` újratöltésével látja, hogy megjelent a terv

**Files:**
- Modify: `extensions/video/ui/video.tsx`, `ui/api.ts`, `ui/style.css`
- Create: `extensions/video/ui/megrendeles.ts` — a két host-hívás egy helyen
- Modify: `extensions/video/test/ui.test.mjs`

- [ ] **2.1** `megrendeles.ts`: `rendelj({ agentNev, uzenet })`. A hívás
      hibáit **megnevezi** — ha nincs ilyen ügynök, azt mondja meg, ne
      „sikertelen"-t. Az ügynököt névvel keresi (`Videó Gyártó`), mert az
      id telepítésenként más.
- [ ] **2.2** Gombok: **Terv kérése** (a „Terv" szekcióban) és **Lektorálás
      kérése** (a legfrissebb tervnél). Mellettük egy sor, ami kimondja, hogy ez
      **ügynök-fordulót indít, ami pénzbe kerül és percekig tarthat** — az
      operátor ne véletlenül kattintson.
- [ ] **2.3** Állapotjelzés: amíg a fordulat fut, a gomb letiltva és a szekció
      fejlécében látszik, hogy folyamatban van. A lap **nem** streameli a
      választ — a bizonyíték az, hogy megjelenik a terv, nem az, hogy mit írt
      közben az ügynök.
- [ ] **2.4** Tesztek: a megrendelő függvény a helyes törzset küldi; hiányzó
      ügynöknél megnevezett hibát ad; a gomb letiltott állapotban indoklást
      mutat.
- [ ] **2.5** Teszt, lint, build, commit.

---

## Feladat 3: YouTube mint második ötletforrás

**Files:**
- Create: `extensions/aisignal/src/youtube.mjs`
- Modify: `extensions/aisignal/src/research.mjs` (a `createResearchTool`
  diszpécsere), `extensions/aisignal/index.mjs` (beállítás-mezők)
- Create: `extensions/aisignal/test/youtube.test.mjs`

**A meglévő minta**, amihez igazodni kell: `fetchHackerNews`, `fetchReddit`,
`fetchGithub` — mind ugyanaz a szignatúra (`{ query, days, fetchImpl,
timeoutMs, deadlineAt }`), mind `{ id: 'forras:azonosito', source, title, … }`
alakot ad vissza, és `PER_SOURCE_LIMIT` (50) darabnál nem hoz többet.

**Amiben viszont más:** ez nem HTTP-JSON, hanem egy **külső bináris**.

```
/Users/tothgergo/DEV/gergototh.co/apps/yt-dlp/bin/yt-dlp
```

- [ ] **3.1** Beállítás-mezők az `index.mjs`-ben:
      `youtubeCsatornak` (text, vesszővel elválasztott csatorna-URL-ek vagy
      `@handle`-ök) és `ytDlpUtvonal` (text, a binárishoz; alapértéke a fenti).
      Üres csatornalista = a forrás **nincs megkérdezve**, és ezt a
      `notAsked` listában meg is nevezi — nem néma nulla.
- [ ] **3.2** `fetchYoutube({ csatornak, days, spawnImpl, … })`: csatornánként
      `yt-dlp "<csatorna>/videos" --flat-playlist --skip-download --playlist-end N
      --print "%(id)s|%(upload_date)s|%(view_count)s|%(title)s"`. Az `upload_date`
      alapján szűr az ablakra.
      **A `spawnImpl` beinjektálható varrat** — a teszt így nem indít
      folyamatot, ahogy a videó modul `spawnImpl`-je sem.
- [ ] **3.3** Ismert buktató, tedd bele: a YouTube SABR-blokkja miatt kellhet
      `--extractor-args "youtube:player_client=android"`. A Hermes skillje ezt
      kötelezőként írja a transcript-letöltésre; a `--flat-playlist` listázásnál
      próbáld ki, és ha kell, tedd bele.
- [ ] **3.4** Hibakezelés: hiányzó bináris → a forrás `unavailable`, megnevezve,
      **a sweep többi forrása fut tovább**. Egy csatorna bukása nem viszi el a
      többit.
- [ ] **3.5** Kösd be a `createResearchTool` diszpécserébe és a tool
      leírásába (ma azt mondja: „Reddit, Hacker News, GitHub").
- [ ] **3.6** Tesztek injektált `spawnImpl`-lel: ablak-szűrés, hiányzó bináris,
      egy csatorna bukása, `PER_SOURCE_LIMIT`, üres lista → `notAsked`.
- [ ] **3.7** Teszt, lint, commit.

---

## Feladat 4: az első éles futás — a modul saját tervének 19. feladata

Ez **nem fejlesztés**, hanem az első valódi végigvitel. Amíg ez nem ment végig
egyszer, semmi nem tudható arról, hogy a lánc működik-e.

- [ ] **4.1** Építsd újra és telepítsd az appot a **jelenlegi `main`-ből** — a
      meglévő `release/SwarmClaw-1.10.0-arm64.dmg` még a híd (`a6a860a`) ELŐTT
      készült, tehát nem tartalmazza a `claude-cli.ts` változást.
- [ ] **4.2** **A híd élő igazolása.** Indíts egy beszélgetést a `Videó
      Gyártó`-val, és nézd meg az `app.log` `claude-cli` init-eseményét: a
      `"tools":[…]` listában **meg kell jelennie** a Video MCP tooljainak. Ez a
      bizonyíték — nem a teszt és nem a fordítás. Ma ez a szám nulla.
- [ ] **4.3** Kérd meg az ügynököt, hogy hívja meg a `videoQueue`-t, és
      számoljon be. Ha ez megvan, a beszélgetés-út él.
- [ ] **4.4** Vidd végig **egy** videót a kilencből, a lapról: terv → lektor →
      narráció → render → QA. Minden lépés után nézd meg a megfelelő táblát.
- [ ] **4.5** Jegyezd fel, mi tört el. **Ez a lépés várhatóan talál hibákat** —
      a lánc soha nem futott, a Doksik modulnál is négy hibát csak az éles
      telepítés hozott elő.
- [ ] **4.6** Futtasd le az `aisignal` sweep-et (most már YouTube-bal is), és
      nézd meg, gyűlik-e ötlet: `ext_aisignal_items` > 0.

---

## Feladat 5: a `videos` szerződésnek legyen fogyasztója

A modul kínálja a `videos` szerződést, de **senki nem használja**. A spec 9.2
szerint a mechanizmus valódi próbája az, ha két szolgáltató és két fogyasztó
együtt fut.

- [ ] **5.1** A Doksik modul `consumes`-szal kérje a `videos` szerződést, és a
      kész forgatókönyvet tegye le doksiként (`agents/video/`). Ez egyben a
      Doksik `docs` szerződésének is első valódi fogyasztója lenne — ma az sincs.
- [ ] **5.2** Teszt, hogy hiányzó szolgáltatónál megnevezett hibát ad
      (`szerzodes_hianyzik`), nem néma kihagyást.

---

## Sorrend és miért

**1 → 4.1–4.3 → 2 → 4.4 → 3 → 4.6 → 5**

Az 1. feladat után már van mit kézzel indítani, a 4.1–4.3 pedig azonnal
megmondja, hogy a híd tényleg működik-e — ha nem, minden más várhat. A 2. csak
akkor értelmes, ha a híd él. A 3. független, de a 4.6 nélkül nem tudni, hogy hoz-e
bármit. Az 5. a legkevésbé sürgős.

## Amit ez a terv nem old meg

- **A `~/.hermes/node` és a `/opt/homebrew/bin/node` következetlensége** az öt
  MCP-bejegyzésben. Működhet mindkettő, de egyfélének kellene lennie.
- **A félkész `platform-mcp`** (`src/lib/server/platform-mcp.ts`,
  `src/app/api/platform-mcp/`, `scripts/platform-mcp/`) — commitolatlanul áll,
  és el kell dönteni, befejezzük-e vagy eldobjuk.
- **A napi ütemezések** akkor is futnak, ha kézzel dolgozol. Ha az első éles
  futás közben zavarnak, szüneteltesd őket.
