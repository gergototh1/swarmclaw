# Fülek és oldalsáv-szerkesztő — terv

Dátum: 2026-09-11
Állapot: jóváhagyott terv, implementációs terv előtt

## Cél

Több modulban párhuzamosan dolgozni (jegyzet → CRM → vissza a chatre) úgy, hogy
a visszatérés egy kattintás vagy egy billentyű legyen, ne 3–4 menükattintás, és
a modul ott várjon, ahol hagytam. Mellé: a rail tartalma és elrendezése legyen
szerkeszthető.

## Kiinduló állapot (a kódból)

- `src/lib/app/recent-items.ts` minden útvonalváltást naplóz, de csak a Home
  „Legutóbb megnyitott” blokkja olvassa, és a `/x/...` bővítmény-oldalakat nem
  ismeri fel.
- A CRM (`extensions/crm/ui/main.tsx`) és a Doksik (`extensions/docs/ui/main.tsx`)
  a belső helyét (nézet, nyitott ügyfél, nyitott doksi) `useState`-ben tartja,
  nem az URL-ben. Elnavigáláskor az oldal lebomlik, a hely elvész.
- A `/x/[[...slug]]` route a mély útvonalat (`/x/crm/...`) már a prefixéhez
  tartozó oldalra oldja fel — csak az al-útvonal nem jut el az oldal-komponenshez.
- A rail egy fix táblából (`NAV_SECTIONS`, `src/lib/app/nav-sections.ts`) épül;
  felhasználói testreszabás nincs.
- A CSP `frame-ancestors 'none'`-t ad (`src/lib/content-security-policy.ts`).
  Jelenleg report-only, tehát hatástalan, de `SWARMCLAW_CSP_ENFORCE=1` mellett
  minden iframe-be töltést tiltana.
- A parancspaletta (`src/components/shared/command-palette.tsx`) listázza a
  beépített nézeteket, a bővítmény-oldalakat nem.
- A Doksi-szerkesztő (`extensions/docs/ui/szerkeszto.tsx`) lebontáskor
  **törli** a függő automatikus mentés időzítőjét: az utolsó `AUTOSAVE_MS`-nyi
  gépelés elvész, ha doksit vált a felhasználó. Meglévő hiba.
- React 19.2.3 / Next 16.2.4. A Next maga is `<Activity mode="hidden">`-del
  tartja életben a korábbi útvonalakat (`layout-router.js`, csak
  `cacheComponents` mellett, max. 3). Saját fül-hosthoz ez nem használható:
  az oldalaink a globális `usePathname()`-ből és a store `currentAgentId`-jéből
  olvasnak, így egy rejtett chat-fül az aktív fül tartalmára váltana.

## Referencia: hogyan csinálják mások

| App | Megoldás |
|---|---|
| Orca (a telepített csomagban ellenőrizve) | A nem aktív fül mountolva marad, csak `visibility: hidden` / `display: none`; a terminál fut tovább. Nyitott fülek és aktív fül munkafánként perzisztálva; fültípusonkénti „nemrég bezárt” verem a visszanyitáshoz. |
| Chrome | A fülek élnek; memórianyomásnál a régóta nem használtakat kiüríti, visszatéréskor URL-ből tölti újra. |
| VS Code | A rejtett webview alapból leáll és elmentett állapotból épül újra; élve tartás (`retainContextWhenHidden`) opcionális és drága. |
| Obsidian | Fülek perzisztálva (fájl, görgetés, mód); újraindítás után a háttérfülek lustán töltődnek. |

Közös minta, amit követünk: a fül egy perzisztálható leírás (URL, cím); a
legutóbb használt néhány él, a többi kiürül és URL-ből tér vissza; a beírt
szöveg a fültől függetlenül mentődik.

## Döntések

1. **Böngésző-szerű fülek, kézzel.** Új fül „+”-szal, billentyűvel vagy
   ⌘-kattintással; a navigáció az aktív fülön történik. Új fül a Home-on indul.
2. **Élve tartás plafonnal, fülenkénti iframe-mel.** Legfeljebb 6 keret él;
   a legrégebben használt elalszik, és URL-ből tér vissza.
3. **Oldalsáv-szerkesztő:** kitűzés felső szintre, elrejtés, áthelyezés
   szekciók között, sorrend. Helyben, a railen szerkeszthető.

## 1. Fülek felépítése

### Két üzemmód, egy app

- **Gazda** — a legfelső ablak, asztali szélességen (≥768px). Rendereli a
  railt, a fülsort és a fül-kereteket. A route `children`-jét nem rendereli.
- **Fül** — iframe-ben fut, `name="sc-tab:<id>"` attribútummal (a `window.name`
  túléli a kereten belüli navigációt). Csak a route tartalmát rendereli: nincs
  rail, nincs fülsor. A mellékhatásos komponensek csak a gazdában futnak:
  `ReplyNotifier`, hangjelzés, a csillag-értesítés, a `DashboardShell`
  billentyűparancsai.
- **Mobil** (<768px) — nincs fül, a mai működés marad.
- **Vészkapcsoló:** `appSettings.tabsEnabled` (alapértelmezés: `true`).
  `false` esetén a gazda a mai módon rendereli a `children`-t.

### Fül-modell

`src/lib/app/tabs.ts` — tiszta függvények; mellé egy zustand store.

```ts
interface Tab { id: string; url: string; title?: string }
interface TabsState {
  tabs: Tab[]            // sorrendben
  activeId: string
  lastUsed: string[]     // LRU sorrend, legutóbbi elöl
  closed: Tab[]          // bezárt fülek verme, max. 10
}
```

- Perzisztálás: `localStorage` `sc_tabs_v1`, eszközönként (mint a böngésző).
  Beolvasáskor validálva; sérült vagy hiányzó érték → egyetlen Home fül.
- Az utolsó fül bezárása egy Home fület hagy; nulla fül nincs.
- **Plafon:** `MAX_LIVE_FRAMES = 6`. A 7. kerethez a `lastUsed` szerinti
  legrégebbi keret lebomlik; a fül a sávban marad, aktiváláskor az URL-jéből
  újra létrejön.
- **A kiürítendő keretet előbb megkérjük, csak utána bontjuk le.** A gazda a
  lebomlásra kiszemelt keretnek egy flush-üzenetet küld, és csak a keret
  nyugtázása után távolítja el az iframe-et a DOM-ból. Az iframe puszta
  eltávolítása nem hívja meg megbízhatóan a `pagehide`-ot, és a benne futó
  React-fa cleanupját sem futtatja le, tehát a szerkesztő flush-a enélkül nem
  futna le, és egy még el nem mentett gépelés veszne el — pontosan az
  ellentéte annak, amit a terv máshol ígér: hogy a beírt szöveg a fültől
  függetlenül mentődik.

### Kommunikáció

`postMessage`, csak azonos origin, és csak ha `event.source` egy ismert keret
`contentWindow`-ja.

| Irány | Üzenet | Jelentés |
|---|---|---|
| fül → gazda | `ready` | a keret betöltött |
| fül → gazda | `location { url }` | a fül URL-je megváltozott |
| fül → gazda | `title { text \| null }` | a bővítmény-oldal `setTitle`-je |
| fül → gazda | `open-tab { url }` | ⌘-/középső kattintás belső linken |
| fül → gazda | `shortcut { action }` | fülkezelő billentyű vagy ⌘K a kereten belül |
| fül → gazda | `auth-required` | lejárt bejelentkezés |
| gazda → fül | `navigate { href, panel? }` | navigálj ide (rail, paletta); `panel` (`toggle` / `open` / `close`) a fül oldalpanelje, mert az a kereten belül él |

### Navigáció

- A gazda címsora az aktív fül URL-jét mutatja (`history.replaceState`), így
  újratöltés és könyvjelző működik. Egy könyvjelzőből érkező URL a meglévő
  fülek mellé új fülként nyílik, ha nem egyezik egyikkel sem.
- Rail-kattintás → `navigate` az aktív fülnek. ⌘-kattintás vagy középső
  kattintás → új fül.
- A ⌘K paletta a gazdában él, az aktív fülbe navigál, és kiegészül a
  bővítmény-oldalakkal. A navigáció a `navigate { href }` üzenettel az aktív
  fül keretébe megy, nem a gazda saját routerén keresztül egyenesen a
  `children`-be — a mai paletta (`command-palette.tsx`) a bővítmény-oldalakat
  még közvetlenül a routeren tolja át, ami a gazda ablakban a fülsávot és a
  railt magát cserélné le. Ezt át kell kötni az üzenetküldésre, mielőtt a
  gazda/fül mód él.

### Billentyűk

| Művelet | Asztali app (Electron) | Böngésző |
|---|---|---|
| Új fül (Home) | ⌘T | ⌥T |
| Fül bezárása | ⌘W | ⌥W |
| Bezárt fül visszanyitása | ⌘⇧T | ⌥⇧T |
| Következő / előző fül | ⌃Tab / ⌃⇧Tab | ⌥→ / ⌥← |
| n-edik fül (9 = utolsó) | ⌘1–9 | ⌥1–9 |

A böngésző a ⌘T/⌘W/⌃Tab-ot nem engedi elvenni, ezért van külön kiosztás. Ezen
felül: középső kattintás a fülön = bezárás, húzás = átrendezés.

### CSP

Az app policyja `frame-ancestors 'self'`. A `/s/<token>` megosztási oldalak saját
policyt kapnak `frame-ancestors 'none'`-nal — ahogy a mostani komment is írja:
beágyazhatóságot route-onként kell adni, nem a közös direktívát lazítani.

### Ismert korlátok (a megvalósítás után)

- **A Doksi mentési sora ablakonként, tehát fülenként él.** Két fülön ugyanaz a
  doksi nem várja ki egymás mentését; a második fül mentése ilyenkor valódi
  ütközést kap, amit az ütközés-sáv mutat.
- **A böngésző saját Vissza gombja** a keretek közös előzményén lép, így egy
  háttérben lévő fület is visszaléptethet.
- **768 px alá keskenyítve** (vagy a fülek kikapcsolásakor) az app csak a
  következő újratöltéskor vált sima módba. Addig a gazda marad, mert a váltás
  minden fül-keretet flush nélkül bontana le, és a mentetlen szerkesztések
  elvesznének (a nyitott fülek listája újratöltés után is megmarad).
- **Asztali appban a ⇧⌘T** a bezárt fül visszanyitása, így ott már nem a Tasks
  gyorsbillentyűje; az ablak bezárása ⇧⌘W.
- **A fül ikonja** a szekció ikonja (bővítmény-oldalnál a saját ikonja); a külön
  `VIEW_ICONS` tábla a 3. szakaszban készül.
- **Egy fül, amelynek a flush-a nem sikerül** (pl. a Doksi ütközést tart egy
  másik doksin), életben marad, akkor is, ha ezzel túllépi a hat élő keretet.
  Bezárni csak a figyelmeztető toast „Close anyway” gombjával lehet, és az
  mentés nélkül zár.
- **A `sc_tabs_v1` kulcsot a böngésző minden ablaka közösen használja.** Két
  ablak nem tart külön fül-listát: amelyik utoljára ír, annak az állapota marad
  meg, és a következő betöltés azt kapja.
- **A háttérben lévő keretek tovább futnak** (lekérdezések, websocket,
  időzítők), így minden élő fül CPU-t és memóriát használ; a hat élő keretes
  plafon csak ezt korlátozza, nem függeszti fel őket.
- **A fülek kikapcsolása (`tabsEnabled`)** a következő újratöltéskor lép
  életbe, ugyanazért, amiért a 768 px alá keskenyítés. Bekapcsolni egy sima
  ablakban azonnal lehet, mert ott nincs lebontandó keret.
- **Az app saját gyorsbillentyűi** (pl. ⌘N) a füleken belül is futnak, és arra
  a fülre hatnak, amelyikben a fókusz van, nem a gazdára.

## 2. Bővítmény-oldalak helye az URL-ben, fülcímek

### Host API (visszafelé kompatibilis)

Az oldal-komponens props-ai `{ extensionId, rpc }` mellé:

- `subPath: string` — a `page.path` utáni rész, vezető `/` nélkül (pl.
  `ugyfelek/abc123`, vagy `''`).
- `navigate(subPath: string, opts?: { replace?: boolean }): void`
- `setTitle(text: string | null): void`

Régi bundle, amely ezeket nem használja, a mai módon működik.

### CRM

A nézet és a nyitott ügyfél a `subPath`-ból származik, nem `useState`-ből.

| URL | Nézet |
|---|---|
| `/x/crm` | Ma |
| `/x/crm/ugyfelek` | ügyféllista |
| `/x/crm/ugyfelek/<accountId>` | ügyféllap; cím: „CRM · <ügyfélnév>” |
| `/x/crm/ugyek` | ügyek |

Ismeretlen `subPath` → Ma nézet.

### Doksik

`/x/docs/<docId>` (egy szegmens, `encodeURIComponent`-tel); cím:
„Doksik · <doksi címe>”. Nem létező `docId` → üres szerkesztő, a fa látszik.

**Hibajavítás:** a szerkesztő lebontáskor és `pagehide`-kor az időzítő
törlése helyett azonnal ment, ha a markdown eltér a szerver által utoljára
visszaigazolttól. A `pagehide`-kori mentés best-effort: a host `rpc`-je nem
ad `keepalive` opciót, így egy bezáródó oldal a kérést elvághatja. Doksiváltás
és appon belüli navigáció esetén a mentés biztosan kimegy.

### Fülcím és ikon

A gazda állítja elő az URL-ből:

- beépített nézet → `VIEW_LABELS[view]` + `VIEW_ICONS[view]`;
- `/agents/<id>`, `/chat/<id>` → az ágens / beszélgetés neve (a
  `recent-item-label` logikája); ha törölték, a nézet neve;
- bővítmény-oldal → a saját `label` + `icon`, vagy a `setTitle` szövege.

A `setTitle` szövege a `Tab.title`-be mentődik, így az alvó fül is a pontos
címet mutatja. Ehhez a hívásnak a nyers cím-szöveget kell megőriznie, nem csak
a `document.title`-be összeállított formát (pl. „Doksik · <cím>”) — a fül-modell
a `title { text | null }` üzenethez és a `Tab.title` mezőhöz is a nyers
szöveget várja, nem a gazda saját, előtaggal ellátott változatát.

## 3. Oldalsáv-szerkesztő

### Adatmodell

`appSettings.railLayout` — szerveroldalon, így az asztali app és a böngésző
ugyanazt látja. `undefined` = a mai alapértelmezett rail.

```ts
type RailItemRef = `view:${AppView}` | `page:${string}/${string}` // extensionId/pageId
interface RailLayout {
  version: 1
  pinned: RailItemRef[]
  sectionOrder: NavSectionId[]
  sections: Partial<Record<NavSectionId, RailItemRef[]>>
  hidden: (RailItemRef | `section:${NavSectionId}`)[]
}
```

### Feloldás

Egyetlen tiszta függvény:
`resolveRailLayout(NAV_SECTIONS, extensionPages, layout) → ResolvedRail`.

- A felhasználó által elhelyezett pont oda kerül, ahová tette, abban a
  sorrendben.
- Kitűzött pont kikerül a szekciójából, és a szekciók fölött jelenik meg.
- A layoutban nem szereplő pont (új nézet, új bővítmény-oldal) az alapszekciója
  végére kerül — semmi nem tűnhet el. A `nav-sections.test.ts` teljességi
  tesztje erre is kiterjed.
- Nem létező hivatkozás (eltávolított bővítmény) nem renderelődik, de a
  tárolt layoutban marad, így újratelepítéskor a helyére kerül.
- A `direct` szekciók (Home, Chat) sorként rendezhetők és rejthetők; pontjuk
  nincs.
- A Settings (footer) szekció rögzített: nem rejthető, nem mozgatható, a pontjai
  sem vihetők ki belőle.

### Kitűzött sorok

Saját ikonnal állnak a szekciók fölött; a keskeny (52px) railen ikonként,
tooltippel. Ehhez új tábla: `VIEW_ICONS: Record<AppView, ...>` (a fülek is
használják). A bővítmény-oldalak a meglévő ikonjukat kapják.

### Szerkesztő mód

- Belépés: „Testreszabás” gomb a rail alján; kilépés: „Kész”.
- Minden szekció kinyílik; a rejtett pontok halványan a helyükön látszanak.
- Soronként: fogantyú (natív HTML5 drag & drop, mint `task-card.tsx`; nincs új
  függőség), 👁 (rejtés), 📌 (kitűzés).
- Billentyűzetes alternatíva: soronkénti „⋯” menü — Fel, Le, „Áthelyezés ide:
  <szekció>”.
- Minden változás azonnal mentődik (`updateSettings`, optimista). Nincs Mégse.
  „Visszaállítás” megerősítés után `railLayout: null`.
- Szerkeszteni csak asztali nézetben lehet; a mobil fiók ugyanazt a feloldott
  layoutot mutatja.

### Elérhetőség

Rejtett pont ⌘K-val elérhető marad (a paletta a bővítmény-oldalakat is
listázza, lásd 1. rész).

### Szerveroldal

A `PUT /settings` ma bármilyen kulcsot `Object.assign`-nal elment. A
`railLayout`-ot zod-séma validálja; érvénytelen alak esetén a mező nem íródik
felül (400-as válasz a mezőre hivatkozva). A kliens a feloldásnál is
defenzíven olvassa.

## 4. Hibakezelés

- Keret 20 mp-en belül nem küld `ready`-t → a fülön „Nem töltött be ·
  Újratöltés”; a többi fül érintetlen.
- `auth-required` bármelyik fülből → a gazda egyszer kéri a bejelentkezést,
  utána minden keretet újratölt.
- `localStorage` elérhetetlen → a fülek memóriában működnek.
- Fülből érkező, ismeretlen típusú vagy idegen forrású üzenet → eldobva.

## 5. Tesztelés

Unit (tiszta függvények):

- `tabs.ts`: nyitás, zárás, utolsó fül zárása, visszanyitás, átrendezés,
  aktiválás, alvó keret kiválasztása (LRU), sérült mentés beolvasása.
- `resolveRailLayout`: elhelyezés, új pont a végén, ismeretlen hivatkozás
  eldobása, kitűzés, rejtés, rögzített Settings, teljesség.
- `railLayout` zod-séma; fülcím előállítása; billentyű-kiosztás (Electron vs.
  böngésző).
- CSP: `frame-ancestors 'self'` az appra, `'none'` a `/s/` route-ra.

Bővítmények:

- CRM: `subPath` ↔ nézet leképezés oda-vissza.
- Doksik: lebontáskor függő mentés lefut.

Élő (dev-browser / nextjs-visual-verification):

1. 3 fül (chat, CRM-ügyfél, doksi); félkész CRM-űrlap; váltás és vissza →
   a tartalom megvan.
2. 7. fül megnyitása → a legrégebbi alszik; aktiválva URL-ből tér vissza.
3. Újratöltés → a fülek visszajönnek.
4. CRM kitűzése, Protocols elrejtése, Doksik áthelyezése; újratöltés → megmarad.
5. 6 élő keret memóriája lemérve, az eredmény a PR-ban.
6. Asztali build: ⌘T / ⌘W / ⌘⇧T.

## 6. Szállítási sorrend

Három önálló szakasz, mindegyik külön implementációs tervvel és commit-sorral:

1. **Mélylinkek** — host API (`subPath`, `navigate`, `setTitle`), CRM és Doksik
   URL-je, Doksi-mentési javítás, bővítmény-oldalak a palettában.
2. **Fülek** — gazda/fül mód, fül-store, keretek, üzenetek, billentyűk, CSP,
   `VIEW_ICONS`, vészkapcsoló.
3. **Oldalsáv-szerkesztő** — `railLayout` séma és feloldás, szerkesztő mód,
   szerveroldali validálás. (Az 1. és a 3. nem függ a 2.-tól; a `VIEW_ICONS`
   amelyik előbb készül el, abban születik meg.)

## Nem cél

- Fülek szinkronizálása eszközök között.
- Osztott nézet (két fül egymás mellett).
- Saját szekciók létrehozása, átnevezése.
- Fülek a mobil nézetben.
