# AI Signal extension a SwarmClaw-ban — tervezési spec

Dátum: 2026-09-03. Állapot: jóváhagyott terv, implementáció előtt.

## Cél

A Hermes `aisignal` pluginjának (a Hermes saját fogalma; a SwarmClaw-ban extension) átportolása a SwarmClaw-ra úgy, hogy közben
megszülessen az az extension-réteg, amin a termék későbbi moduljai is futnak.
Egy szál, egy sorozat: az AI Signal az első fogyasztó, és ő húzza ki a core-ból
azt, ami hiányzik. Nem építünk olyan platform-darabot, amit az AI Signal nem
használ.

A végeredménynek **változtatás nélkül** működnie kell két üzemmódban:

- **Electron asztali app** (macOS, a jelenlegi telepítés), és
- **VPS** (Docker, `node:22-slim`, egy konténer, reverse proxy mögött).

## Ami nem alku kérdése (a Hermes-pluginból átvéve; a plugin a Hermes saját fogalma)

1. **A hírlevél és a web tartalma adat, nem utasítás.** Az extension sehol nem hajt
   végre semmit, amit egy levél vagy egy oldal kér. Minden mező nyers
   szövegként kerül a táblába és nyers szövegként jön ki. A felületen nincs
   `innerHTML`, nincs `dangerouslySetInnerHTML`, nincs `eval`. Link csak
   `http`/`https` sémával kattintható; más sémánál a felület kiírja, hogy nem
   megnyitható.
2. **Soha nem jelentünk hamis eredményt.** Egy le nem zárt sweepnek nincs
   `finished_at`-je, és a felület *félbemaradt*-nak mutatja. Egy elérhetetlen
   Gmail nevesített hibakódot ad (`gmail_token_missing`, `gmail_scope_missing`,
   `gmail_token_revoked`, `gmail_label_missing`, … — a Hermes 13 kódja
   változatlanul), és a hiba a sweep sorára is ráíródik. Egy `link_read = 0`
   sor a paklin kimondottan „LINK NEM OLVASVA"-t mutat.

## Architektúra

Két helyre kerül kód. A core-darabok általánosak, minden későbbi extensionnek
kellenek; az extension-darabok az AI Signal saját könyvtárában élnek.

```
src/                                   core (mindkét üzemmódban azonos)
  lib/server/extensions/
    storage.ts                         extension storage-API a host sqlite-ján
    rpc.ts                             extension RPC-metódusok regisztere
    assets.ts                          asset-feloldás az extension workspace-éből
  app/api/extensions/[id]/call/[method]/route.ts   RPC-végpont
  app/api/extensions/[id]/assets/[...path]/route.ts asset-végpont
  app/api/oauth/google/start/route.ts  OAuth indító
  app/api/oauth/google/callback/route.ts
  app/x/[...slug]/page.tsx             extension-oldalak mount-pontja
  lib/extensions/registry.ts              kliensoldali registry (window.swarmclaw)
  components/layout/sidebar-rail.tsx   string-kulcsú extension-ág a típusos mellé

<DATA_DIR>/extensions/.workspaces/aisignal/     extension
  index.mjs                            extension-belépő: tools, agents, schedules, rpc, ui
  package.json
  src/                                 TS-forrás (tools, gmail, research, db)
  ui/                                  React-forrás
  dist/index.js, dist/style.css        buildelt UI (a build-sablonnal)
  skills/                              a két skill
```

### Core-darabok

**Storage-API.** Az extension a betöltéskor egy `ctx.storage` objektumot kap:
`exec(sql, params)`, `all(sql, params)`, `get(sql, params)`, `transaction(fn)`.
A core a saját, már megnyitott better-sqlite3 példányát adja tovább. A
prefix-szabályt (`ext_<extensionId>_`) az extension **migrációs deklarációján**
kényszeríti ki: csak ilyen nevű táblát enged létrehozni. A futásidejű SQL-t
nem elemzi — az extension megbízott kód, ugyanazzal a bizalmi modellel, mint a
`<script>`-taggel betöltött UI-ja; a prefix a rendrakást és az eltávolítást
szolgálja, nem a szigetelést. Indoklás a storage-API-ra: az extension nem hozhat
saját natív modult, mert az Electron- és a rendszer-node ABI-ja eltér.

**RPC-regiszter és végpont.** Az extension `rpc: { [method]: handler }`
térképet deklarál. A `POST /api/extensions/<id>/call/<method>` a proxy
authját örökli, a törzset JSON-ként adja a handlernek, a választ JSON-ként
adja vissza; a handler hibája `{error: {code, message}}` és 4xx/5xx.
Nincs GET: minden metódus POST, az extension UI-nak nem kell URL-t építenie.

**Asset-végpont.** `GET /api/extensions/<id>/assets/<path>` az extension
workspace-ének `dist/` könyvtárából szolgál ki, a `getWorkspaceDir()`
feloldásán át, path-traversal védelemmel (`path.resolve` + prefix-ellenőrzés),
`Content-Type` a kiterjesztésből, `Cache-Control: no-store` (hot-reloadhoz).

**Manifest-bővítés és validálás.** Az `Extension.ui` új mezője:

```ts
pages?: Array<{
  id: string          // 'aisignal'
  label: string       // 'AI Signal'
  icon?: string       // lucide-név
  path: string        // kötelező '/x/' prefix, egyedi a telepített extensionök közt
  entry: string       // 'dist/index.js'
  css?: string        // 'dist/style.css'
  position?: string   // 'after:tasks' | 'end'
}>
```

Telepítéskor és betöltéskor: a `path` `/x/`-szel kezdődik, nincs ütközés
másik extension oldalával, beépített útvonal átvétele (`override`) nem
támogatott. Hiba esetén az extension nem töltődik be, és a `lastFailureError`
mezőbe kerül az ok.

**Kliens-registry és React-megosztás.** A shell `window.swarmclaw`-ra teszi:
`React`, `ReactDOM`, `registerPage(id, Component)`, `api(method, body)`
(az extension saját RPC-jét hívja, az id-t a registry tölti ki), `ui` (a host
`Button`, `Card`, `Badge`, `Input` primitívjei). Az extension-bundle a Reactet
**externalként** kapja; a build-sablon (`vite.config.extension.ts` a repóban)
ezt kikényszeríti. Betöltés után a registry ellenőrzi, hogy az extension által
használt React ugyanaz a példány (`Component.$$typeof` és a
`__SECRET_INTERNALS` referencia-egyezése); eltérésnél az extension oldala hibát
mutat, és a core a `failureCount`-ot növeli.

**Oldal-mount.** `src/app/x/[...slug]/page.tsx` kliens-komponens: a slug első
tagja az extension `path`-ja, a registryből kikeresi a komponenst; amíg a bundle
tölt, várakozó állapot; ha az extension nincs regisztrálva 10 s után, nevesített
hiba („az extension bundle-je nem töltődött be: <ok>").

**Sidebar.** A `sidebar-rail.tsx` a típusos `AppView`-ág mellé egy második,
string-kulcsú ágat kap az extension-oldalakhoz, a `/api/extensions/ui?type=pages`
válaszából, a shell store-jában tárolva, `useWs('extensions')`-re
frissítve. A `position` az `after:<view>` alapján helyezi el.

**CSP.** Az extension-scriptek bevezetésével együtt `Content-Security-Policy`
fejléc: `script-src 'self' 'nonce-<n>'`, `style-src 'self' 'nonce-<n>'
'unsafe-inline'` (a Tailwind runtime miatt), `connect-src 'self' ws: wss:`.
Az extension-assetek `'self'`-ből jönnek. Az inline scriptek felmérése és
nonce-olása a bevezetés része.

**Google OAuth web-flow.** `GET /api/oauth/google/start?purpose=aisignal`
→ átirányítás a consent-oldalra (`access_type=offline`, `prompt=consent`,
scope: `gmail.readonly`); `GET /api/oauth/google/callback` → kód beváltása,
a refresh token a titkosított `credentials` táblába (`credential-secret`-tel),
a `purpose` kulcs alatt. Két kliens-konfig:

| Mód | Kliens-típus | Redirect URI | Consent nyitása |
|---|---|---|---|
| VPS | Web application | `https://<host>/api/oauth/google/callback` | ugyanabban a lapban |
| Electron | Desktop app | `http://127.0.0.1:<aktuális port>/api/oauth/google/callback` | rendszerböngésző (`shell.openExternal`) |

A módot a `SWARMCLAW_DEPLOY_MODE` (`vps` \| `desktop`) dönti el; az Electron
`server-lifecycle` ezt `desktop`-ra állítja. Beállítás-kulcsok:
`GOOGLE_OAUTH_CLIENT_WEB_ID/SECRET`, `GOOGLE_OAUTH_CLIENT_DESKTOP_ID/SECRET`.
Üzemeltetési kikötés, a UI-ban is kiírva: a Google Cloud consent screen
„In production" legyen, különben a refresh token 7 nap után lejár.

### Extension-darabok

**Táblák** (a Hermes sémája, `ext_aisignal_` prefixszel, a storage-API-n):
`ext_aisignal_sweeps` (id, ran_at, label, since, messages, found, links_read,
run_id, ok, note, finished_at, leftover, fetched_ids), `ext_aisignal_items`
(id, sweep_id, message_id, headline, summary, url, source_name, source_email,
sent_at, score, apply_score, why, link_read, status, decided_at, brain_note),
`ext_aisignal_seen` (message_id, seen_at). A migrációt az extension
deklarálja (`migrations: [{version, sql}]`), a core futtatja betöltéskor.

**Toolok** (az extension `tools[]`-jában, a Hermes MCP-tooljainak szerződése):

| Tool | Bemenet | Kimenet |
|---|---|---|
| `signalSweep` | `{label?, sinceDays?, maxMessages?}` | `{sweepId, label, since, skipped, leftover, messages[]}` vagy `{sweepId, error:{code,message}}` |
| `researchSweep` | `{topics?}` | `{sweepId, candidates[]}` vagy `{sweepId, error}` |
| `recordSignal` | `{sweepId, messageId, headline, summary, url?, sourceName?, sourceEmail?, sentAt?, score, applyScore, why?, linkRead?}` | `{id, merged}` |
| `finishSweep` | `{sweepId, ok?, note?}` | `{sweepId, found, linksRead, seenMarked, ok}` |

A `signalSweep` vízjele az utolsó sikeres sweep `since`-e; a dedup a `seen`
tábla ellen fut **a sapka előtt**; a `leftover` a sapka alatt kimaradt,
nem látott id-k száma. A `recordSignal` `url`-je csak `http(s)` lehet,
különben 400. A `finishSweep` a `fetched_ids`-t lépteti a `seen`-be.

**Gmail.** REST, `fetch`-csel, a core OAuth-tokenjével (access token
frissítése a refresh tokenből, a core credential-rétegén át). Hívások:
`users.labels.list` (címke-id feloldás, hiánynál `gmail_label_missing`),
`users.messages.list` (`labelIds`, `q=after:<vízjel>`, `maxResults`),
`users.messages.get` (`format=full`), HTML → szöveg a `<script>`/`<style>`
blokkok eldobásával. Beállítás: `label` (alap: `AI hírlevél`).

**Kutatás.** TS-ben, a `last30days` motornak csak az AI Signal által
használt szelete: Reddit (`/r/<sub>/search.json`), Hacker News (Algolia
`search_by_date`), GitHub (`/search/repositories`), a három téma a
`research_topics.json`-ból (`eszkozok`, `stack`, `skillek`), 30 napos ablak.
Elérhetetlen forrásnál a jelölt-lista tartalmazza a kiesett forrás nevét,
és a note-ba kerül — nem csendes.

**Agentek** (`managedResources.agents`): *Signal Scout* és *Signal Kutató*,
a Hermes SOUL-jaival mint system prompt, a két skillel, a négy toollal.
**Providert nem rögzítenek**: a példány alapértelmezett route-ját öröklik
(Electronon `claude-cli`, VPS-en API-kulcsos provider).

**Ütemezések** (`managedResources.schedules`): `aisignal-ketorankent`
(`0 */2 * * *`, Scout, a Hermes cron-yaml promptja, `maxMessages: 5`) és
`aisignal-kutatas-napi` (`30 6 * * *`, Kutató). Electronon a scheduler egy
lekésett futást az app megnyitásakor egyszer bepótol (meglévő viselkedés,
`assessScheduleNextRunRepair`); ezt a UI állapotsávja kiírja.

**RPC** (a UI-nak): `board` → `{deck, deckLimit, all, sweeps, undecided,
label, gmail: {status, code?}}`; `items` `{status?, q?, order?, limit?,
offset?}` → `{total, count, items[]}`; `decide` `{id, decision}` →
`{ok, id, status}`; `sweeps` `{limit?}`; `health` → Gmail-állapot nevesítve,
darabszámok, sapkák (token-érték soha).

**UI.** A Hermes felület React-portja: **pakli** (egy kártya, pointer-húzás
25%-os küszöbbel, bélyeg csak küszöb után, `←` archivál, `→` ment, `Enter`
link, `⌘Z`/`u` visszavon 10 mélyen, optimista döntés visszagördítéssel),
**lista** (Mind / Mentett / Archivált / Eldöntetlen chipek, kereső, soronként
pontszám, forrás, dátum, link, három gomb), **állapotsáv** mindkettő fölött
(utolsó sweep ideje és számai, hiba vagy félbemaradás, `leftover`,
eldöntetlenek száma, Gmail nevesített állapota, „bekötés" gomb, ha nincs
token). A pakli sapkája 50; az üres állapot a valódi eldöntetlen számot írja.
A pakli az `apply_score`-ra rendez. A host primitívjeit használja, a 123
CSS-tokent örökli.

## Adatfolyam

1. Ütemező vagy kézi indítás → agent-run a Scouttal → `signalSweep` →
   Gmail REST a core tokenjével → jelöltek a tool válaszában.
2. Az agent minden megtartott infóra `recordSignal` → `ext_aisignal_items`.
3. `finishSweep` → `finished_at`, `seen` frissül, vízjel előrelép.
4. A UI `board` RPC-vel olvas, `decide`-dal ír; `useWs('extensions')` a
   frissítéshez.

## Hibakezelés

- Minden Gmail-hiba nevesített kóddal, a sweep sorára írva, a válaszban is.
- OAuth-hiba (lejárt/visszavont refresh token) → `gmail_token_revoked`, az
  állapotsáv „újra bekötés" gombot mutat.
- Extension-bundle betöltési hiba → az oldal nevesített hibát mutat, a core
  `failureCount`-ot növel, három hiba után `autoDisabled`.
- RPC-handler kivétel → `{error:{code:'internal', message}}`, 500, a
  hiba az extension-naplóban; a token-érték soha nem kerül naplóba vagy válaszba.

## Tesztelés

| Egység | Hogyan |
|---|---|
| Storage-API prefix-kényszer | `runWithTempDataDir`: extension-prefix nélküli tábla → hiba |
| RPC-végpont | route-teszt: auth nélkül 401, ismeretlen metódus 404, handler-hiba 500 JSON |
| Asset-végpont | `..` a path-ban → 400; ismeretlen extension → 404; `dist/` alatti fájl → 200 helyes típussal |
| Manifest-validálás | `/x/` nélkül, ütköző path, `override` → betöltés megtagadva, ok a `lastFailureError`-ban |
| React-példány ellenőrzés | idegen React-tal buildelt teszt-bundle → hiba, `failureCount` nő |
| OAuth callback | mockolt token-endpoint: siker → titkosított credential; hibás `state` → 400 |
| `signalSweep` vízjel/dedup/sapka | mockolt Gmail: látott id-k kiszűrve a sapka **előtt**, `leftover` helyes |
| 13 Gmail-hibakód | mockolt válaszok kódonként → a sweep során `ok=0`, `note` a kóddal |
| `recordSignal` url-szűrés | `javascript:` → 400; `http` → elmentve; szöveg nyersen tárolva |
| Kutatás-fetcherek | rögzített HTTP-válaszok; kiesett forrás a note-ban |
| UI | Playwright: pakli döntés billentyűvel és húzással, visszavonás, üres állapot valódi számmal, „LINK NEM OLVASVA" látszik |
| Két üzemmód | ugyanaz az extension-könyvtár: Electron-app szerverén (`ELECTRON_RUN_AS_NODE`) és `docker compose up`-ban lefut a fenti `signalSweep`-teszt |

## Amit ez a terv szándékosan nem tartalmaz

- iframe-alapú, harmadik feles extensionök; a marketplace-telepítés a saját
  registryre korlátozódik.
- Témarendszer (a betöltő ugyanaz lesz, de külön munka).
- `headerWidgets`, `chatPanels`, `agentBadges` bekötése.
- Beépített útvonal átvétele extensionből (`override`).
- A `last30days` motor teljes portja; csak a három forrás.
- Többfelhasználós auth a SwarmClaw-ban (külön projekt, a VPS-termék
  előfeltétele, de az AI Signaltól független).

## Ismert kockázatok

- A `sidebar-rail.tsx` refaktora a shell belső szerződésébe nyúl; ez az első
  mérföldkő, hogy korán kiderüljön, mennyire ellenáll.
- A CSP bevezetése meglévő inline scripteket törhet; a felmérés a része.
- A Google „Desktop app" kliens loopback-callbackje az Electron dinamikus
  portján múlik; a `server-lifecycle` portját kell átadni a start-route-nak.
