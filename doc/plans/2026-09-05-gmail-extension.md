# Gmail-extension — implementációs terv

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Egy `gmail` extension a SwarmClaw-ban, két ajtóval — `provides.mailbox` v1 szerződés a kódnak (valódi lapkurzorral, rögzített ablakkal, és egy mezővel, ami megmondja, teljes volt-e a listázás) és MCP-szerver az ügynököknek (keresés, olvasás, címkézés, piszkozat, kimenő sor) —, egy Google-hitelesítés mögött. A kimenő oldal piszkozatnál áll meg: küldeni csak az operátor tud, a lapról, egy hash-hez kötött kattintással. Az AI Signal Gmail-kliense ide költözik, és az AI Signal ezután a szerződést fogyasztja.

**Architecture:** Az extension a `tts` alakját követi (`tools: []`, szerződés + MCP-shim + lap, egy közös implementáció alattuk) és az AI Signal fegyelmét (zárt hibakészlet, kulcsok kommentálva, `hiányzó = alapérték / jelen lévő és nem teljesíthető = névvel visszautasítva`, az idegen szöveg adat). A Gmail REST kliens az `extensions/aisignal/src/gmail.mjs` (573 sor, 57 teszt) változatlan átköltöztetése, kiegészítve a lapkurzorral, a piszkozat- és a címke-hívásokkal. Az MCP-shim függőség nélküli stdio JSON-RPC, ami a host rpc-jére továbbít, és a hostot a `run/port.json`-ból találja meg (a fájl és a három ellenőrzése a hostban már megvan).

**Tech Stack:** Node 22 (ESM `.mjs`, `node:test`), a host storage-API-ja (`better-sqlite3`), a host `ctx.oauth`-a, esbuild (UI), React 19 a hostból, `fetch` a Gmail REST-hez, Playwright (böngésző-smoke). Két host-oldali TypeScript-változás Next.js 16.2 alatt.

**Spec:** `doc/specs/2026-09-05-gmail-extension-design.md` (minden döntés ott, ez a terv egyiket sem nyitja újra). Minta: `doc/plans/2026-09-05-video-module.md`, a kész `extensions/tts/` és `extensions/aisignal/`.

## Global Constraints

- **Két üzemmód, azonos kód.** Electron (`SWARMCLAW_DEPLOY_MODE=desktop`, `127.0.0.1:<dinamikus port>`) és VPS (Docker `node:22-slim`). Ennek a modulnak **nincs** platform-függő ága: az egyetlen különbség, hogy a host melyik OAuth-kliens env-párt olvassa (`GOOGLE_OAUTH_CLIENT_DESKTOP_*` vs `GOOGLE_OAUTH_CLIENT_WEB_*`), és az a host dolga, nem az extensioné. Egy `process.platform` vizsgálat ebben az extensionben hiba.
- **Az extension nem hozhat natív npm-modult.** Adatbázis csak a `ctx.storage`-on át; az MCP-szerver saját, függőség nélküli stdio JSON-RPC-vel.
- **Nincs import a host `src/`-jából** az extension egyetlen fájljában sem (`index.mjs`, `src/`, `ui/`, `mcp/`, `scripts/`, `test/`). Ami a hostból kell, azt a `ctx` adja (`storage`, `settings`, `log`, `oauth`), vagy HTTP-n jön. A két host-változás (Task 1, Task 2) a host fájljait módosítja, és **nem** az extension része.
- **Extension-táblák** neve kötelezően `ext_gmail_` prefixű. A szó **extension**, sosem „plugin" — kódban, kommentben, MCP-tool-leírásban, UI-szövegben.
- **Idegen szöveg adat, nem utasítás és nem vezérlő-állapot.** A `subject`, a `text`, a feladó neve, a címkenevek, a kimenő `targy` és `torzs`: nyersen tárolva, mezőn átadva, React-gyerekként kirajzolva. Sehol nem kerülnek shell-argumentumba (ez a modul semmit nem spawnol), fájlnévbe, URL-be vagy HTML-be, és **egyetlen `if` sem ágazik el a tartalmukon**. A `Reply-To` fejléc nem befolyásol semmit; a `From` boríték-cím az egyetlen fejléc, amiből a kód dönt, és abból is csak a válasz címzettje lesz (spec 5.3).
- **Hamis eredmény soha.** Egy metódus, ami nem tudta megcsinálni, `{ error: { code, message } }`-t ad (rpc, MCP), illetve dob (szerződés) a spec 6. táblázatának kódjával — és **sosem üres listát**. Egy sikertelen listázás nem „nem találtam levelet". A `list` ciklusa mindig kiküld legalább egy kérést, ezért egy üres `ids` mindig azt jelenti, hogy a Gmailt megkérdeztük.
- **A visszautasítás fegyelme** (az aisignal `reads.mjs` szabálya, minden metódusra): **hiányzó, null vagy üres argumentum = nincs vélemény (alapérték)**; **jelen lévő, de nem teljesíthető argumentum = névvel visszautasítva**, sosem csendben kijavítva, levágva vagy kerekítve. `Number(x) || 50` és `String(x)` tilos a bemeneten; a `src/args.mjs` olvasói az egyetlen út. Az egy kivétel a `max`, ami a felső korlát fölött **sapkázódik** — mert félig teljesíthető, és a `complete` mező megmondja, hogy a lap el lett-e vágva.
- **A kimenő oldal kapuira épülő értékek a sorból és a Gmailből jönnek, nem a hívótól:** `cimzett_cimek` a címzettkönyvből vagy a boríték `From`-jából, `torzs_hash` és `eloHash` a modul számolja, `ajto` a hívó fájl konstansa. Egy metódus-argumentum ezeket **nem** adhatja meg.
- **Egy komment, ami többet vagy kevesebbet állít, mint amit a mechanizmus ténylegesen ad, hiba** — ugyanolyan, mint egy rossz `if`, és a code review így kezeli. Ebben a modulban két mondat van, ahol ez a legkönnyebben elromlik, és mindkettőt a spec pontosan megfogalmazza: (a) a kérés-határidő a token-szakaszt **versenyezteti**, nem szakítja meg (spec 4.4); (b) a `releaseDraft` rpc-korlátja **nem** véd egy azonos eredetű böngésző-bundle ellen, és a `megerosites` hash sem — az elavult vagy kicserélt piszkozat ellen véd (spec 5.4). Aki ezekre „garantálja"/„soha"/„megakadályozza" szót ír, hibát ír.
- **Minden tesztfájl regisztrálva van egy npm-scriptben.** A gyökér `package.json` `test:runtime`-jába kerül `'extensions/gmail/test/*.test.mjs'` (Task 3 első lépése), a smoke-tesztek `test:e2e:gmail` és `test:deploy:gmail` néven. Egy tesztfájl, ami létezik, de egyetlen script sem futtatja, nem létezik.
- **A tesztek a szállított futtatókörnyezetet gyakorolják, ahol az számít.** A `tsx --test` a `.mjs`-t CJS-re fordítja; a termék nem. Ami a modul-rendszeren vagy a folyamathatáron múlik — az entry import-ideje, az MCP-shim stdio-ja és port-fájl-olvasása, a deploy-smoke — azt **sima `node`-dal** indított alfolyamat méri (`test/import-time.test.mjs`, `test/mcp.test.mjs`, `test/deploy.smoke.mjs`). Egy zöld `tsx`-teszt ezekről semmit nem mond.
- **`any` tilos** a TypeScript-fájlokban (host és `ui/` egyaránt); `unknown` + szűkítés. **Lint-szabályt elnyomni tilos** semmilyen formában (`eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `// biome-ignore`, `NOSONAR`). Ahol a kód nem megy át, a kódot kell átírni.
- **Kulcs- és tokenérték nem kerül válaszba, naplóba, sorra.** A `health` igen/nem-et mond a hitelesítésről. A deploy-smoke szó szerint keresi a válaszokban a `refresh_token`, `access_token` és `CLIENT_SECRET` sztringeket, és bukik, ha megtalálja.
- **Minden feladat:** `npm run lint:baseline` → `No net-new lint issues detected`; `npm run type-check` tiszta; az érintett tesztek zölden. Az extension-tesztek: `npx tsx --test extensions/gmail/test/<fájl>` a gyökérből (ott van `tsx`).
- **Commit-üzenet:** rövid felszólító cím + miért; nincs gondolatjel (em dash). A törzs után kötelező két trailer:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` és
  `Claude-Session: https://claude.ai/code/session_01NjTCGWAUDjCaEaocZBiGLG`
- **Extension-azonosító = a fájlnév** (`gmail.mjs`); workspace-kulcs `gmail_mjs`; tábla-prefix `ext_gmail_`; az rpc-útvonal `/api/extensions/gmail.mjs/call/<method>`.
- **`setup(ctx)` szinkron és idempotens**, csak a `state`-et tölti; **nem** indít időzítőt, figyelőt, feliratkozást, és nem olvas fájlt. Az entry modulban nincs top-level `await`, fájl- vagy hálózati művelet.
- **Az AI Signal frontierjéhez nem nyúlunk.** A `ext_aisignal_frontier`, a `ext_aisignal_seen`, a `leftover`/`drained` szétválasztás, a `latestTrustworthySince` és a `TRUNCATED_NOTE` marad, ahol van. A Task 11 **egyetlen** sort változtat a `drained` számításában, és azt a sort a feladat szó szerint kiírja.
- **Ez a terv a `~/dev/swarmclaw` repóhoz nem nyúl.** Minden munka a `swarmclaw-aisignal` forkban van.

## Párhuzamosítás

Három független lánc és egy közös zárás. Egy feladatot akkor lehet elkezdeni, ha a függőségei commitolva vannak.

| Lánc | Feladatok | Függ |
|---|---|---|
| **H — host** | Task 1 (`gmail` purpose + `googleClientConfigured`), Task 2 (reconcile a szállított termékből) | egymástól nem; semmitől |
| **G — az extension magja** | Task 3 → Task 4 → (Task 5 ∥ Task 6) → Task 7 → Task 8 → (Task 9 ∥ Task 10) | Task 5 és Task 6 egymástól független, mindkettő a 4-re épül; Task 7 a 6-ra (`kimeno` sor) és a 4-re (`sendDraft`, `getDraft`); Task 8 az 5-re és a 7-re; Task 9 és Task 10 a 8-ra |
| **A — az AI Signal átállása** | Task 11 | Task 8 (a szerződés) **és** Task 1 (a `gmail` purpose) |
| **Zárás** | Task 12 → Task 13 → Task 14 | Task 12 a 9, 10, 11 után; Task 13 a 12 után; Task 14 minden után |

**Ténylegesen párhuzamosítható párok:** (Task 1 ∥ Task 2), (Task 5 ∥ Task 6), (Task 9 ∥ Task 10). A H-lánc a G-lánccal is párhuzamos egészen a Task 11-ig — de a Task 1 **kell**, mielőtt bárki élőben beköti a postafiókot, mert addig a `gmail` purpose nem létezik.

**Serial kényszer, amit nem szabad megkerülni:**

- **Task 12 (telepítés, hiba, eltávolítás) nem előzheti meg a modult.** Pont azt nézi, ami a feladatok **közé** esik, és egy félkész modulon nem lehet megnézni.
- **Task 14 (élő futás mindkét módban) az utolsó.**
- **Task 11 nem előzheti meg a Task 1-et**, mert a `gmail` purpose nélkül nincs mihez bekötni, és a sweep kétóránként bukna.
- **Ügynökök, amelyek commitolnak, nem futhatnak egyszerre.** Két párhuzamosnak jelölt feladat (pl. Task 5 és Task 6) **implementálható** párhuzamosan, de a `git commit` sorosítandó: legutóbb két egyszerre commitoló ügynök összeütközött, és az egyikük munkája beleolvadt a másik commitjába. A gyakorlati szabály: párhuzamos ág külön worktree-ben dolgozik, vagy a második ügynök a commitig vár. Egy ág, ami nem commitol, nem kész.

---

## Fájlstruktúra

**Host — módosított fájlok** (Task 1, Task 2)

| Fájl | Változás |
|---|---|
| `src/app/api/oauth/google/start/route.ts` | `SCOPES` új `gmail` bejegyzés; a hiányzó kliens 500 helyett megnevezett 409 |
| `src/app/api/oauth/google/callback/route.ts` | `RETURN_PATH` új `gmail: '/x/gmail'` bejegyzés |
| `src/lib/server/oauth/google.ts` | `isGoogleClientConfigured()` export |
| `src/lib/server/extensions.ts` | `ctx.oauth.googleClientConfigured` |
| `src/types/extension.ts` | az `oauth` blokk harmadik mezője |
| `src/app/settings/page.tsx` | az `ExtensionManager` nézet bekötése |
| `src/cli/index.js`, `src/cli/spec.js` | `extensions reconcile` nevesített parancs |
| `package.json` | új tesztfájlok a `test:runtime`-ban; `test:e2e:gmail`, `test:deploy:gmail` |
| `Dockerfile` | a `gmail` extension build és másolás |

**`extensions/gmail/`** (Task 3–10)

| Fájl | Felelősség |
|---|---|
| `package.json`, `.gitignore`, `scripts/build.mjs`, `scripts/install.mjs` | minta az aisignal / a tts |
| `index.mjs` | `state`, `migrations`, `setup`, `tools: []`, `rpc`, `provides.mailbox`, `ui.pages`, `ui.settingsFields` |
| `src/hibak.mjs` | `GmailError`, `refuse`, `guard`, `HIBA_KODOK` (a teljes zárt készlet) |
| `src/args.mjs` | `readString`, `readEnum`, `readWholeNumber`, `readArray`, `readBoolean` |
| `src/db.mjs` | a négy tábla, `createRepo`, `sha256`, `canonicalJson`, `torzsHashOf`, `uid`, `now` |
| `src/client.mjs` | a Gmail REST kliens: az aisignal `gmail.mjs`-e + lapkurzor + drafts + labels |
| `src/mime.mjs` | `buildMime`, `base64url` — a kimenő üzenet alakja, semmi más |
| `src/olvasas.mjs` | `UZENET_MEZOK`, `projectUzenet`, `createOlvasas`, `createCimkezes`, `CIMKE_TILTOTT` |
| `src/cimzettek.mjs` | `createCimzettek` (könyv + feloldás), `HANDLE_RE` |
| `src/kimeno.mjs` | `createPiszkozat` (draft), `naploKiserlet`, `AJTOK`, a keretek |
| `src/kiadas.mjs` | `createKiadas` (`releaseDraft`, `discardDraft`, `outbox`), `eloHashOf` |
| `src/contract.mjs` | `provides.mailbox` v1, `OUTBOX_MEZOK` |
| `src/rpc.mjs` | a lap és a shim metódusai |
| `src/health.mjs` | `HEALTH_CODES` (egy hely), `runHealth` |
| `mcp/server.mjs` | stdio JSON-RPC shim, `SHIM_METODUSOK` hat név |
| `ui/main.tsx`, `ui/api.ts`, `ui/host.ts`, `ui/status-bar.tsx`, `ui/kimeno.tsx`, `ui/cimzettek.tsx`, `ui/kiserletek.tsx`, `ui/style.css` | a lap |
| `test/helpers.mjs`, `test/args.test.mjs`, `test/db.test.mjs`, `test/client.test.mjs`, `test/olvasas.test.mjs`, `test/cimzettek.test.mjs`, `test/kimeno.test.mjs`, `test/kiadas.test.mjs`, `test/contract.test.mjs`, `test/rpc.test.mjs`, `test/mcp.test.mjs`, `test/ui.test.mjs`, `test/import-time.test.mjs`, `test/e2e.smoke.mjs`, `test/deploy.smoke.mjs` | |
| `scripts/gmail-deploy-smoke.mjs` (a repó gyökerének `scripts/` alatt) | az `aisignal-deploy-smoke.mjs` mintája |

**`extensions/aisignal/`** (Task 11)

| Fájl | Változás |
|---|---|
| `src/gmail.mjs` | **törölve** (átköltözött) |
| `test/gmail.test.mjs` | **törölve** (átköltözött) |
| `src/sweep.mjs` | `gmailFor` helyett szerződés-handle; `OAUTH_PURPOSE` törölve; a `drained` egy sora |
| `src/rpc.mjs` | a `gmailHealth` blokk helyett a `gmail` extensionre mutató mondat |
| `index.mjs` | `consumes` blokk; a `hasGoogleCredential` dep eltávolítva |
| `ui/status-bar.tsx`, `ui/format.ts` | a bekötés-gomb helyett link a `/x/gmail` lapra |
| `test/sweep.test.mjs` | a gmail-dublőr helyett szerződés-dublőr |

---

## H-lánc: a két host-változás

### Task 1: a `gmail` purpose, a scope-ja, és a hiányzó Google-kliens megnevezve

**Files:**
- Modify: `src/app/api/oauth/google/start/route.ts`, `src/app/api/oauth/google/callback/route.ts`
- Modify: `src/lib/server/oauth/google.ts` (a `resolveGoogleClient` mellé, ~161. sor)
- Modify: `src/lib/server/extensions.ts` (a `ctx.oauth` blokk, ~1813. sor), `src/types/extension.ts` (~803. sor)
- Modify: `src/app/api/oauth/google/oauth-route.test.ts`, `src/lib/server/oauth/google.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `isGoogleClientConfigured(): boolean` (`google.ts`); `ExtensionContext['oauth']['googleClientConfigured']: () => boolean`; a `SCOPES.gmail` bejegyzés; `RETURN_PATH.gmail`; a start-route `409` válasza `{ error: 'google_oauth_client_missing', mode }` törzzsel.
- Consumes: semmit.

Miért: két külön hiányzás. (a) A `SCOPES` map ma egyetlen purpose-t ismer (`aisignal`, `gmail.readonly`), és egy nem listázott purpose 400-at kap — a `gmail` extension bekötése enélkül nem indul el. (b) A `resolveGoogleClient()` egy hiányzó kliensre `Error('google_oauth_client_missing')`-et dob, amit a start-route **500-zal** ad vissza egy nyers JSON-törzsben; és mivel a `getGoogleAccessToken` egy hiányzó hitelesítőre `gmail_token_missing`-gel dob **előbb**, a kliens hiánya soha nem látszik az extension felől. A lap ezért nem tudja kikapcsolni a gombot, és az operátor egy üres fülön kap egy 500-at — pontosan az, ami ma történik.

- [ ] **Step 1: `isGoogleClientConfigured`**

`src/lib/server/oauth/google.ts`, közvetlenül a `resolveGoogleClient` után:

```ts
/**
 * Whether an OAuth client is configured for the deploy mode this process is
 * running in. Not "whether an account is connected": that is
 * `hasGoogleCredential`, and the two fail for different reasons and want
 * different sentences on a page.
 *
 * It exists because the credential check runs first everywhere else. With no
 * client and no credential, `getGoogleAccessToken` throws
 * `gmail_token_missing`, an extension reports "not connected", the operator
 * presses Connect, and the consent route is the first thing that ever
 * mentions the missing client -- in a response body, on a blank tab.
 */
export function isGoogleClientConfigured(): boolean {
  return resolveGoogleClientOrNull() !== null
}
```

- [ ] **Step 2: a purpose és a visszatérési útvonal**

`src/app/api/oauth/google/start/route.ts`:

```ts
const SCOPES: Record<string, string[]> = {
  aisignal: ['https://www.googleapis.com/auth/gmail.readonly'],
  // The smallest single scope that covers reading, searching, drafting,
  // sending a draft and labelling. Labelling is what forces it: applying a
  // label is users.messages.modify, which neither gmail.readonly nor
  // gmail.compose covers. Asking for three narrower scopes alongside it would
  // narrow nothing -- Google grants the union -- and would only put three
  // sentences on the consent screen instead of one.
  //
  // What is deliberately absent: https://mail.google.com/ and gmail.settings.*
  // So no path in this app, bug included, can permanently delete a message or
  // change a mailbox setting.
  gmail: ['https://www.googleapis.com/auth/gmail.modify'],
}
```

és a `catch` ágban, a meglévő 500 elé:

```ts
  } catch (err) {
    const message = err instanceof Error ? err.message : 'oauth_failed'
    // A missing client is the operator's configuration, not a server fault, and
    // it is the one failure here with a fixed remedy: two environment variables
    // and a restart. 409 so a page can tell it apart from a real 500 and print
    // that remedy instead of a stack.
    if (message === 'google_oauth_client_missing') {
      return NextResponse.json({ error: message, mode: resolveGoogleDeployMode() }, { status: 409 })
    }
    return NextResponse.json({ error: message }, { status: 500 })
  }
```

(`resolveGoogleDeployMode` importálandó a `@/lib/server/oauth/google`-ből, a `buildGoogleAuthUrl` és a `resolveCallbackOrigin` mellé.)

`src/app/api/oauth/google/callback/route.ts`:

```ts
const RETURN_PATH: Record<string, string> = { aisignal: '/x/aisignal', gmail: '/x/gmail' }
```

- [ ] **Step 3: `ctx.oauth.googleClientConfigured`**

`src/types/extension.ts`, az `oauth` blokkban a meglévő két mező mellé:

```ts
  googleClientConfigured: () => boolean
```

`src/lib/server/extensions.ts`, a `ctx.oauth` objektumban a meglévő két sor mellé:

```ts
      googleClientConfigured: () => isGoogleClientConfigured(),
```

és a fájl tetején az importba az `isGoogleClientConfigured`.

- [ ] **Step 4: Tesztek**

`src/lib/server/oauth/google.test.ts`: `isGoogleClientConfigured` mindkét módban, id nélkül, secret nélkül, mindkettővel.
`src/app/api/oauth/google/oauth-route.test.ts`: `purpose=gmail` env nélkül → **409**, a törzsben `google_oauth_client_missing` és a `mode`; `purpose=gmail` env-vel → 302 a consent URL-re, benne a `gmail.modify` scope; `purpose=nincsilyen` → 400 `unknown purpose`.

`package.json` `test:runtime`: a két fájl bekerül, ha még nincs benne.

- [ ] **Step 5: Gates + commit**

```bash
npm run type-check && npm run lint:baseline
npx tsx --test src/lib/server/oauth/google.test.ts src/app/api/oauth/google/oauth-route.test.ts
git add src/lib/server/oauth/google.ts src/lib/server/extensions.ts src/types/extension.ts src/app/api/oauth/google package.json
git commit -m "Add the gmail OAuth purpose and let an extension see a missing Google client"
```

### Task 2: a managed erőforrások összehangolása a szállított termékből

**Files:**
- Modify: `src/app/settings/page.tsx`
- Modify: `src/cli/index.js`, `src/cli/spec.js`
- Create: `src/cli/reconcile.test.js` vagy a meglévő CLI-teszt bővítése

**Interfaces:**
- Produces: az `ExtensionManager` nézet mountolva a Settings oldalon; `swarmclaw extensions reconcile [--extension-id <id>]` nevesített CLI-parancs.
- Consumes: `POST /api/extensions/managed-resources` `{"action":"reconcile"}` (megvan).

Miért, és ez ellenőrzött tény: a Reconcile gombot tartó nézet, `src/views/settings/extension-manager.tsx`, **sehonnan nincs importálva** — a `src/app/settings/page.tsx` tizenöt testvérét importálja a `@/views/settings/*` alól, és ez nincs köztük; nincs `next/dynamic`, nincs string-útvonalas hivatkozás sem. (A grep félrevezet: a `src/lib/server/extensions.ts`-beli szerver oldali `class ExtensionManager` nagyon is él.) A CLI-ből elérhető, de csak a generikus, útvonalra képzett igén át (`extensions managed-resources-action` egy `{"action":"reconcile"}` törzzsel), és a súgó sehol nem mondja meg az `action` sztringet. A `reconcileExtensionManagedResources` egyetlen produkciós hívója az az egy route; **semmi nem hívja telepítéskor, engedélyezéskor vagy indulásnál.** Az AI Signal lapja közben azt írja az operátornak, hogy nyomja meg a Reconcile gombot azon az oldalon, ami nem elérhető.

Ez a `gmail` extensionnek magának nem kell (nincs managed erőforrása, spec 12.1), de a fogyasztóinak igen, és a hírlevél-modul biztosan bele fog futni. Kicsi, önálló, és most a legolcsóbb megcsinálni.

- [ ] **Step 1: A nézet bekötése**

`src/app/settings/page.tsx`: az `ExtensionManager` importja a többi `@/views/settings/*` mellé, és a komponens beillesztése oda, ahova a többi settings-nézet kerül. A meglévő tizenöt beillesztés alakját kell követni; ez a feladat **nem** ír új nézetet, csak mountol egy meglévőt.

- [ ] **Step 2: Nevesített CLI-parancs**

`src/cli/index.js`, az `extensions` csoportban, a `managed-resources-action` mellé (az nem törlődik: a generikus alak marad, ez egy felfedezhető név mellé):

```js
cmd('reconcile', 'POST', '/extensions/managed-resources', 'Create or update the agents and schedules an extension declares', {
  expectsJsonBody: true,
  fixedBody: { action: 'reconcile' },
  options: [{ flag: '--extension-id <id>', bodyKey: 'extensionId', description: 'Only this extension; omit for all' }],
}),
```

**Ellenőrizendő az implementáció első lépéseként:** a `cmd()` helper támogatja-e a `fixedBody`-t és az `options`-t. Ha nem, akkor **nem** kell bővíteni a helpert: elég egy kézzel írt parancsdefiníció ugyanabban a fájlban, ami ugyanezt a törzset küldi. A `src/cli/spec.js` tükrözze, amit az `index.js` kap.

- [ ] **Step 3: Teszt**

Egy teszt, ami a CLI-manifestből ellenőrzi, hogy létezik `extensions reconcile`, `POST`-ol a `/extensions/managed-resources` útvonalra, és a törzse `action: 'reconcile'`. A tényleges összehangolás lefutását a `extension-managed-resources.test.ts` már fedi; ez a teszt csak azt, hogy van egy felfedezhető út odáig.

- [ ] **Step 4: Gates + commit**

```bash
npm run type-check && npm run lint:baseline
git add src/app/settings/page.tsx src/cli
git commit -m "Make reconciling extension managed resources reachable from the shipped product"
```

---

## G-lánc: az extension magja

### Task 3: váz, hibakészlet, argumentum-olvasók, séma

**Files:**
- Create: `extensions/gmail/package.json`, `.gitignore`, `scripts/build.mjs`, `scripts/install.mjs`, `index.mjs`, `src/hibak.mjs`, `src/args.mjs`, `src/db.mjs`, `test/helpers.mjs`, `test/args.test.mjs`, `test/db.test.mjs`
- Modify: `package.json` (gyökér, `test:runtime`)

**Interfaces:**
- Produces (`src/hibak.mjs`): `class GmailError extends Error { code, extra }`; `refuse(code, message, extra?)` (dob); `guard(fn)` (`GmailError` → `{ error: { code, message, ...extra } }`; szerződés-hiba → `gmail_szerzodes_hiba`; minden más továbbdob); `HIBA_KODOK` (fagyasztott tömb, a spec 6.4 teljes készlete).
- Produces (`src/args.mjs`): `readString(what, raw, { required?, max?, code? })`, `readEnum(what, raw, allowed, { fallback?, code? })`, `readWholeNumber(what, raw, { min, max, fallback, code? })` (a `max` fölött **sapkáz**, a `min` alatt visszautasít), `readArray(what, raw, { required?, max?, code? })`, `readBoolean(what, raw, { fallback })`.
- Produces (`src/db.mjs`): `MIGRATIONS`; `KIMENO_ALLAPOTOK`, `AJTOK`; `sha256(input)`, `canonicalJson(value)`, `torzsHashOf({ cimek, targy, torzs })`, `uid()`, `now()`; `createRepo(storage)` az alábbi metódusokkal.
- Produces (`index.mjs`): `state = { storage, settings, log, oauth, repo, clientFactory, fetchImpl }` (az utolsó kettő teszt-seam, produkcióban `null`).

- [ ] **Step 1: `package.json`, `.gitignore`, `build.mjs`, `install.mjs`**

Az `extensions/tts/` megfelelőinek másolatai, `name: "swarmclaw-gmail"`-lel, `gmail_mjs` workspace-kulccsal, `gmail.mjs` shimmel. **A skill-blokk kimarad**: ennek a modulnak nincs skillje, tehát nincs `shipped-skills.json` sem. A telepítési lépések kiírását a Task 12 adja hozzá.

- [ ] **Step 2: `src/hibak.mjs`**

A `HIBA_KODOK` a spec 6.4 két listája egy fagyasztott tömbben. A fájl fejkommentje mondja ki a két szabályt: egy tárolt sorban álló kód betűzése nem változik (ezért marad a tizenkét `gmail_*_failed`/`gmail_token_*` angol alak), és a `google_oauth_client_missing` az egyetlen, ami nem `gmail_` előtagú, mert a host sztringje és az operátor arra fog keresni.

Egy teszt rögzíti, hogy minden `refuse()` hívás a repóban olyan kódot használ, ami a `HIBA_KODOK`-ban benne van (grep a `src/`-en, nem futásidejű ellenőrzés).

- [ ] **Step 3: `src/args.mjs`**

A négy olvasó közül a `readArray` az, amit a legkönnyebb elrontani, ezért ez van kiírva:

```js
/**
 * A list argument. Absent, null or blank means no opinion and yields []; a
 * present value that is not an array is refused rather than wrapped.
 *
 * Wrapping is the tempting shortcut and it is the bug: `labelIds: 'INBOX'`
 * wrapped into `['INBOX']` looks helpful right up to the caller that passes
 * `'INBOX,UNREAD'`, and iterating that string yields its characters. The
 * query then carries one label filter per letter, and Gmail answers an empty
 * list rather than an error.
 */
export function readArray(what, raw, { required = false, max = 50, code = 'gmail_argumentum_alak' } = {}) {
  if (raw == null || raw === '') {
    if (required) refuse(code, `${what} kotelezo`)
    return []
  }
  if (!Array.isArray(raw)) refuse(code, `${what} tomb kell legyen, nem ${typeof raw}`)
  if (raw.length > max) refuse(code, `${what} legfeljebb ${max} elem lehet, ${raw.length} erkezett`)
  return raw
}
```

A `readWholeNumber` az aisignal `reads.mjs`-ének megfelelője: `Number.isSafeInteger`, a `min` alatt visszautasít, a `max` fölött **sapkáz** (`Math.min`) — ez a Global Constraints egy kivétele, és a komment megnevezi, miért szabad itt sapkázni (a `complete` mező megmondja, hogy a lap el lett-e vágva).

- [ ] **Step 4: `src/db.mjs` — a négy tábla**

A spec 3.1 szerint, egy migrációban. A fájl tetején a **KULCSOK** kommentblokk a spec 3.2 négy pontjával; az aisignal `db.mjs`-ének `EVERY KEY IN THIS SCHEMA, AND WHAT IT GATES` alakját követve.

`createRepo(storage)` metódusai (a későbbi feladatok ezeket a neveket használják, tehát itt dőlnek el):
`cimzett(handle)`, `cimzettek({ elo })`, `addCimzett({ handle, cim, megjegyzes })`, `retireCimzett(handle)`, `eloCimzettCount()`,
`insertKimeno(row)`, `setKimenoDraftId(id, draftId)`, `kimeno(id)`, `kimenok({ allapot, limit, offset })`, `countKimeno({ allapot })`, `markSzerkesztve(id, { targy, torzs, cimzettCimek, torzsHash })`, `markKiadva(id, { gmailMessageId, konyvonKivul, kiadvaAt })`, `markElvetve(id)`, `setKimenoHiba(id, kod, szoveg)`,
`insertKiserlet({ ajto, kod, mit })`, `kiserletek(limit)`,
`bumpNapi(nap, mezo)`, `napi(nap)`, `counts()`.

`torzsHashOf({ cimek, targy, torzs })` a három érték kanonikus (kulcs szerint rendezett) JSON-jának sha256-ja; a `cimek` tömb **rendezve** megy bele, hogy két azonos címhalmaz más sorrendben ugyanazt a hasht adja.

- [ ] **Step 5: `index.mjs` váz**

`state`, `migrations`, szinkron `setup`, `tools: []`, `ui.pages` (`/x/gmail`, `icon: 'Mail'` — ellenőrizendő, hogy szerepel-e az `EXTENSION_PAGE_ICON_NAMES`-ben, `src/lib/extension-page-nav.ts`; ha nem, a listából a legközelebbi, és a komment mondja meg, miért az), `ui.settingsFields` (`napiPiszkozat` 20, `napiKiadas` 10). Az `rpc` és a `provides` a Task 8-ban kerül be; addig `rpc: {}` és nincs `provides`.

- [ ] **Step 6: Tesztek + gates + commit**

`test/args.test.mjs`: minden olvasó a három esetre (hiányzó → alapérték, jó → érték, jelen lévő rossz → névvel visszautasítva); a `readArray` sztringre és a `readWholeNumber` sapkázására külön eset.
`test/db.test.mjs`: a spec 3.2 négy kulcsa; `torzsHashOf` sorrend-függetlensége a címeken; a `bumpNapi` idempotenciája.

`package.json` (gyökér) `test:runtime`: `'extensions/gmail/test/*.test.mjs'`.

```bash
npx tsx --test extensions/gmail/test/*.test.mjs && npm run type-check && npm run lint:baseline
git add extensions/gmail package.json
git commit -m "Scaffold the gmail extension with its schema, error set and argument readers"
```

### Task 4: a Gmail-kliens átköltöztetése és a lapkurzor

**Files:**
- Create: `extensions/gmail/src/client.mjs`, `extensions/gmail/src/mime.mjs`, `extensions/gmail/test/client.test.mjs`, `extensions/gmail/test/mime.test.mjs`
- Read-only: `extensions/aisignal/src/gmail.mjs`, `extensions/aisignal/test/gmail.test.mjs` (a törlésük a Task 11)

**Interfaces:**
- Produces: `createGmail({ getToken, fetchImpl })` → `{ mailbox, labels, list, get, createDraft, getDraft, sendDraft, deleteDraft, modifyLabels }`; `OAUTH_PURPOSE = 'gmail'`; `clientFor(state)`; `REQUEST_TIMEOUT_MS`, `MAX_PAGES`, `sinceQuery`, `stripHtml`; `buildMime({ cimek, targy, torzs, inReplyTo? })`, `base64url(s)`. A `GmailError` **nincs** újraexportálva: a kliens a `hibak.mjs`-ből importálja, mint mindenki más.
- Consumes: `src/hibak.mjs`, `src/args.mjs`.

`clientFor` és `OAUTH_PURPOSE` szándékosan **itt** van, nem az olvasó rétegben: a Task 5 és a Task 6 párhuzamos, és mindkettőnek kell egy kliens. Ha az egyikük definiálná, a másik függene tőle, és a párhuzamosság hazugság volna.

```js
/**
 * The one place a Gmail client is built in production. `state.clientFactory`
 * is the test seam, declared on the shared state in index.mjs so it is visible
 * beside setup()'s own keys rather than hidden here.
 */
export const OAUTH_PURPOSE = 'gmail'

export function clientFor(state) {
  if (state.clientFactory) return state.clientFactory()
  return createGmail({ getToken: () => state.oauth.getGoogleAccessToken(OAUTH_PURPOSE), fetchImpl: state.fetchImpl || undefined })
}
```

Egy konstans, egy hely: a `health.mjs` (Task 8) ugyanezt az `OAUTH_PURPOSE`-t kérdezi a `hasGoogleCredential`-tól, és két másolat két hely volna, ahol elcsúszhat.

- [ ] **Step 1: Az átköltöztetés, változtatás nélkül**

`extensions/aisignal/src/gmail.mjs` átmásolása `extensions/gmail/src/client.mjs`-be. **A fejkomment és minden függvénykomment változatlanul marad**: a határidő versenyeztetése, a `sinceQuery` egynapos hátralépése, a `mediaType` paraméter-levágása, a `collect` `detached` számlálója — mindegyik egy megtörtént hibából jött, és a spec 4.4 tételesen felsorolja őket.

Két változás a másoláson:
- a `GmailError` és a `TOKEN_CODES` a `src/hibak.mjs`-ből jön importtal, nem itt van definiálva;
- a `listIds` átnevezve `list`-re és átalakítva a Step 2 szerint.

`extensions/aisignal/test/gmail.test.mjs` átmásolása `extensions/gmail/test/client.test.mjs`-be, ugyanezekkel az igazításokkal. **Az 57 esetből egy sem törlődik.** A `listIds`-t érintő esetek a Step 2-ben kapnak új elvárást; a többi változatlan.

Run: `npx tsx --test extensions/gmail/test/client.test.mjs` → a `listIds` esetek pirosak, a többi zöld. Ez az a pillanat, amikor látszik, hogy a másolás nem vitt el semmit.

- [ ] **Step 2: A lapkurzor**

A `listIds` helyére:

```js
/**
 * One page of message ids: `{ ids, nextCursor, complete, stoppedOn }`.
 *
 * `nextCursor` is Gmail's own `nextPageToken`, passed back out untouched and
 * taken back in untouched. This module never builds one and never reads inside
 * one.
 *
 * `complete` is the field the operator's existing Gmail MCP server cannot
 * answer: it has maxResults and no page token, so a caller that gets its cap
 * back cannot tell "this is all of them" from "there is more and it was cut".
 * The AI Signal frontier turns on exactly that bit.
 *
 * The invariant, pinned by a test:
 *   complete === (nextCursor === null) === (stoppedOn === null)
 * Three names for one fact, kept because callers use different halves: the
 * sweep uses the bit, an agent uses the cursor, the log uses which bound.
 *
 * The loop always sends at least one request -- `ids` starts empty and `limit`
 * is at least 1 -- so an empty `ids` always means Gmail was asked and had
 * nothing, never that nothing was asked.
 */
async function list({ labelIds = [], q = '', max, cursor = null }) {
  const limit = readWholeNumber('max', max, { min: 1, max: 500, fallback: 50 })
  const ids = []
  let pageToken = cursor == null ? '' : readString('cursor', cursor, { max: 4096, code: 'gmail_kurzor_ervenytelen' })
  let stoppedOn = null

  for (let page = 0; ; page += 1) {
    // The cap first: when both bounds land on the same page, the caller's own
    // limit is the one it can act on.
    if (ids.length >= limit) { stoppedOn = 'cap'; break }
    if (page >= MAX_PAGES) { stoppedOn = 'page_ceiling'; break }

    const qs = new URLSearchParams({ maxResults: String(Math.min(100, limit - ids.length)) })
    // labelIds is an array, read by readArray. A comma-separated string here
    // would iterate its characters; see readArray's comment.
    for (const id of labelIds) qs.append('labelIds', id)
    if (q) qs.set('q', q)
    if (pageToken) qs.set('pageToken', pageToken)

    const body = await call(`/messages?${qs}`, 'gmail_list_failed')
    if (body.messages != null && !Array.isArray(body.messages)) throw unexpectedShape('message list with no messages array')
    // A page entry with no id is not an id. Pushing `undefined` would put a
    // hole in the list that only surfaces as a failed fetch much later.
    for (const m of body.messages || []) if (m?.id) ids.push(m.id)

    pageToken = typeof body.nextPageToken === 'string' ? body.nextPageToken : ''
    // Gmail says there is nothing after this page, so the walk is complete --
    // whichever bound would have stopped it next.
    if (!pageToken) break
  }

  // Gmail treats maxResults as a hint, so trim rather than trust it.
  return { ids: ids.slice(0, limit), nextCursor: pageToken || null, complete: pageToken === '', stoppedOn }
}
```

Miért helyes a `stoppedOn` a végén feltétel nélkül: a ciklus csak akkor lép új iterációba, ha az előző `pageToken`-je nem üres (különben a `break` már lefutott), tehát `stoppedOn` **csak** akkor kap értéket, amikor van élő token. Amikor a cap pont az utolsó lapon telik be, a `if (!pageToken) break` előbb fut le, `stoppedOn` marad `null`, és `complete` igaz — ugyanaz a normalizálás, amit a régi `truncated ? stoppedOn : null` végzett, csak most a vezérlésből következik, nem egy második ternáriusból.

A `client.test.mjs` `listIds`-esetei átírva erre a négy mezőre, plusz négy új eset: kurzor átadva és visszakapva változatlanul; kurzorral indított hívás; `complete: true` cap-stopnál kimerült utolsó lapon; `gmail_kurzor_ervenytelen` nem sztring kurzorra.

- [ ] **Step 3: `src/mime.mjs`**

Egy `text/plain; charset=UTF-8` üzenet RFC 5322 fejlécekkel és base64url törzzsel. `To`, `Subject`, `In-Reply-To`, `References`, `MIME-Version`, `Content-Type`, `Content-Transfer-Encoding: base64`. A `Subject` **RFC 2047 szerint kódolva** (`=?UTF-8?B?…?=`), mert a magyar tárgy nem ASCII, és egy nyers UTF-8 tárgysor a Gmailnél elakad.

Egyetlen szabály, amit a fájl fejkommentje kimond: **a fejlécértékekben `\r` és `\n` nem lehet.** Ha a `targy` vagy egy cím sortörést tartalmaz, a `buildMime` `gmail_mezo_nem_tamogatott`-tal utasít el — nem escape-el, nem vág. Ez az egyetlen hely az egész modulban, ahol idegen eredetű szöveg struktúrába kerül, tehát ez az egyetlen hely, ahol egy injekció alakot ölthetne.

`test/mime.test.mjs`: magyar ékezetes tárgy kódolása; sortörés a tárgyban és a címben → visszautasítva; `In-Reply-To` és `References` jelenléte válasznál és hiánya nem-válasznál.

- [ ] **Step 4: A négy új Gmail-hívás**

`createDraft({ raw })` → `POST /drafts` `{ message: { raw } }` → `{ draftId, messageId }`, `gmail_draft_failed`.
`getDraft(draftId)` → `GET /drafts/{id}?format=full` → ugyanaz a vetület, mint a `get`-nél, plusz a `To` fejléc (a kiadás-ellenőrzéshez kell, spec 5.4).
`sendDraft(draftId)` → `POST /drafts/send` `{ id }` → `{ messageId }`, `gmail_send_failed`.
`deleteDraft(draftId)` → `DELETE /drafts/{id}`.
`modifyLabels(id, { addLabelIds, removeLabelIds })` → `POST /messages/{id}/modify`, `gmail_cimkezes_sikertelen`.

Mind a `call()`-on át, tehát mind ugyanazt a határidőt és hibaleképzést kapja. A `call` kap egy `{ method, body }` opciót; az alapértelmezés GET, hogy a meglévő hívók változatlanok maradjanak.

- [ ] **Step 5: Gates + commit**

```bash
npx tsx --test extensions/gmail/test/*.test.mjs && npm run type-check && npm run lint:baseline
git add extensions/gmail
git commit -m "Move the Gmail REST client into its own extension and give it a page cursor"
```

### Task 5: az olvasó felület és a vetítés (Task 6-tal párhuzamos)

**Files:**
- Create: `extensions/gmail/src/olvasas.mjs`, `extensions/gmail/test/olvasas.test.mjs`

**Interfaces:**
- Produces: `UZENET_MEZOK` (fagyasztott), `projectUzenet(row)`, `createOlvasas(state)` → `{ mailbox, labels, list, get }`, `createCimkezes(state)` → `{ label }`, `CIMKE_TILTOTT`.
- Consumes: Task 3 (`args`, `hibak`), Task 4 (`clientFor`, `UZENET_MEZOK`-hoz a kliens `get`-je).

- [ ] **Step 1: A vetítés**

```js
export const UZENET_MEZOK = Object.freeze([
  'id', 'threadId', 'labelIds', 'subject', 'fromName', 'fromEmail',
  'sentAt', 'text', 'textInAttachment', 'sizeEstimate',
])
```

A fájl fejkommentje a spec 4.3 tételes indoklása: mi marad ki és miért — a nyers MIME, a fejléctábla (kiemelten az `Authentication-Results`, ami ítéletnek olvasódik, és nem az), a `to`/`cc`/`bcc`, a mellékletek, a `snippet`, a `historyId`. És a másik fele: ez a réteg **nem tisztít**, mert az elhitetné a hívóval, hogy a szöveg tiszta, miközben csak ez az egy út nyúlt hozzá; amit garantál, az az, hogy innen semmi tárolt tartalom nem vezérel semmit.

`get({ id, format })`: `readEnum('format', format, ['text'], { fallback: 'text', code: 'gmail_formatum_nem_kuldheto' })`. Egy `'raw'`, `'full'` vagy `'metadata'` így **névvel** bukik, nem csendben lecserélődik.

- [ ] **Step 2: Címkézés**

```js
/**
 * Labels an agent may not touch. TRASH and SPAM move mail somewhere the
 * operator has to go and find it, and in an agent's hands that is near enough
 * to destructive; SENT and DRAFT are Gmail's own bookkeeping and setting them
 * by hand desynchronises the mailbox from itself.
 *
 * Permanent deletion is not on this list because it is not reachable at all:
 * the grant this extension asks for (gmail.modify) does not cover it, and no
 * method here calls users.messages.delete.
 */
export const CIMKE_TILTOTT = Object.freeze(['TRASH', 'SPAM', 'SENT', 'DRAFT'])
```

`label({ id, hozzaad, elvesz })`: mindkét lista `readArray`-jel; bármelyikben egy tiltott id → `gmail_cimke_tiltott` a névvel; üres mindkettő → `gmail_argumentum_alak`.

- [ ] **Step 3: Tesztek + gates + commit**

A spec 12.4 első három sora: a lapozó a szerződés felőli hívással; a `labelIds` tömb-volta; a vetítés egy teljes fixtura ellen (a válaszban **nincs** `to`, `cc`, `bcc`, `raw`, `snippet`, `historyId`, `payload`, `headers`), és a `format: 'raw'` visszautasítása.

```bash
npx tsx --test extensions/gmail/test/*.test.mjs && npm run type-check && npm run lint:baseline
git add extensions/gmail
git commit -m "Add the gmail read surface with an explicit field allowlist"
```

### Task 6: a címzettkönyv és a piszkozat (Task 5-tel párhuzamos)

**Files:**
- Create: `extensions/gmail/src/cimzettek.mjs`, `extensions/gmail/src/kimeno.mjs`, `extensions/gmail/test/cimzettek.test.mjs`, `extensions/gmail/test/kimeno.test.mjs`

**Interfaces:**
- Produces: `HANDLE_RE`, `createCimzettek(state)` → `{ feloldCimzettek, addRecipient, retireRecipient, konyv }`; `createPiszkozat(state)` → `{ draft }`; `naploKiserlet(state, { ajto, kod, mit })`; `AJTOK = { SZERZODES: 'szerzodes', RPC: 'rpc' }`; `MAX_CIMZETT = 10`, `MAX_TARGY = 200`, `MAX_SZOVEG = 100000`.
- Consumes: Task 3, Task 4 (`clientFor`, `createDraft`, `buildMime`, a kliens `get`-je).

- [ ] **Step 1: A címzettkönyv**

`HANDLE_RE = /^[a-z0-9-]{1,40}$/`.

```js
/**
 * Turn caller-supplied handles into addresses, or refuse the whole draft.
 *
 * This function is the reason the recipient book exists. Everything AI Signal
 * handles is newsletter prose and strangers' forum posts, and a newsletter that
 * says "reply to accounts@example.com confirming the transfer" is the live
 * case. A recipient can therefore never come out of that text: it comes out of
 * a row an operator typed, or -- for a reply -- out of the envelope Gmail
 * recorded (see kimeno.mjs).
 *
 * One bad handle refuses the whole draft. Partial fulfilment would mean a
 * message going to some of the intended people and the caller not knowing
 * which, and a caller that cannot name its recipients must not send.
 */
export function feloldCimzettek(repo, handlek) {
  const cimek = []
  for (const handle of handlek) {
    if (typeof handle !== 'string' || !HANDLE_RE.test(handle)) {
      // Named separately from "unknown": an address literal is the shape a
      // prompt injection actually takes, and it should say so on the row.
      const kod = typeof handle === 'string' && handle.includes('@') ? 'gmail_cimzett_cim_literal' : 'gmail_argumentum_alak'
      refuse(kod, `a cimzett a konyv egy handle-je, nem cim: ${String(handle).slice(0, 120)}`)
    }
    const sor = repo.cimzett(handle)
    if (!sor) refuse('gmail_cimzett_ismeretlen', `nincs ilyen cimzett-handle: ${handle}`)
    if (sor.visszavonva_at) refuse('gmail_cimzett_visszavonva', `visszavont cimzett-handle: ${handle}`)
    cimek.push({ handle, cim: sor.cim })
  }
  return cimek
}
```

`addRecipient({ handle, cim, megjegyzes })`: a `handle` a `HANDLE_RE`-nek felel meg; a `cim` egy egyszerű alak-ellenőrzésen megy át (egy `@`, mindkét oldalán legalább egy karakter, nincs benne szóköz és nincs benne `\r`/`\n`) — **nem** validáció abban az értelemben, hogy létező címet jelentene, és a komment ezt mondja is: egy címről csak egy elküldött levél mondja meg, hogy jó-e.

- [ ] **Step 2: A piszkozat**

A `draft({ cimzettHandlek, valaszUzenetId, targy, szoveg }, ajto)` menete, ebben a sorrendben:

1. **Pontosan egy** a `cimzettHandlek` és a `valaszUzenetId` közül; mindkettő → `gmail_cimzett_es_valasz_egyutt`, egyik sem → `gmail_cimzett_hianyzik`.
2. A nem támogatott mezők (`cc`, `bcc`, `replyTo`, `html`, `melleklet`, `attachments`) **jelen lévő, de nem teljesíthető** argumentumok: `gmail_mezo_nem_tamogatott` a mező nevével. Nem csendben figyelmen kívül hagyva.
3. `targy` és `szoveg` hossz-ellenőrzés (`gmail_targy_tul_hosszu`, `gmail_szoveg_tul_hosszu`), vágás nélkül.
4. Napi keret (`gmail_piszkozat_keret_kimerult`).
5. A címzettek: handle-ekből a Step 1 szerint, **vagy** válasz esetén a Step 3 szerint.
6. **A sor először.** `insertKimeno({ allapot: 'piszkozat', gmail_draft_id: '', … })`, aztán a Gmail `createDraft`, aztán `setKimenoDraftId`. Ez a sorrend a spec 12.2 utolsó pontja: fordítva egy sikerült Gmail-hívás és egy elbukott sorírás után egy piszkozat állna a Gmailben, amit a modul nem ismer, és senki nem venné észre. Így a legrosszabb eset egy `gmail_draft_id: ''` sor, ami a lapon `hiba`-ként látszik és törölhető.
7. Minden visszautasítás egy `ext_gmail_kiserletek` sort ír a kóddal és a kérttel (2 000 karakterre vágva) — **a visszautasítás dobása előtt**, hogy egy dobás ne vigye el a nyomot.

- [ ] **Step 3: A válasz**

```js
/**
 * A reply's recipient comes out of the envelope, not out of the message.
 *
 * The `From` address Gmail parsed is the sole recipient. Reply-To is
 * deliberately not honoured: the sender wrote that header, and following it is
 * exactly "a recipient derived from untrusted text" -- the one thing this whole
 * outbound design exists to prevent. Cc is not carried over either, so the
 * circle of recipients cannot grow because a message went to many people.
 *
 * The cost is real and small: someone who set a Reply-To gets the reply at
 * their From address instead. That is less bad than a header that redirects our
 * mail.
 */
```

A `valaszUzenetId`-ből: `client.get({ id })` — de a **kliens** `get`-je, nem az olvasó réteg vetülete, mert itt kell a `Message-ID` fejléc és a `From`, amit a vetület nem ad ki. Ez az egyetlen hely a modulban, ahol egy nyers fejléc kód elé kerül, és a komment ezt kimondja. Üres vagy elemezhetetlen `From` → `gmail_valasz_cimzett_olvashatatlan`.

Tárgy: az eredeti, `Re: ` előtaggal, ha még nincs rajta (kis/nagybetűre nem érzékeny összehasonlítás az elején, egyetlen előtag, nem `Re: Re: Re:`).

- [ ] **Step 4: Tesztek + gates + commit**

A spec 12.4 „címzettkönyv" és „válasz-piszkozat" sorai teljesen. Külön eset: a `Reply-To` és a `Cc` fejlécet hordozó fixtura után a felépített MIME-ban **egyik cím sem szerepel**.

```bash
npx tsx --test extensions/gmail/test/*.test.mjs && npm run type-check && npm run lint:baseline
git add extensions/gmail
git commit -m "Add the recipient book and the draft path, with no recipient from untrusted text"
```

### Task 7: a kiadás

**Files:**
- Create: `extensions/gmail/src/kiadas.mjs`, `extensions/gmail/test/kiadas.test.mjs`

**Interfaces:**
- Produces: `createKiadas(state)` → `{ releaseDraft, discardDraft, outbox }`; `eloHashOf(draft)`.
- Consumes: Task 3, Task 4 (`getDraft`, `sendDraft`, `deleteDraft`), Task 6 (`AJTOK`, a `kimeno` sorok).

- [ ] **Step 1: A fájl fejkommentje — a három mondat, ami nem túlozhat**

A spec 5.4 három állítása, szó szerinti pontossággal:

- egy ügynök tool-hurka nem éri el — **igen**;
- egy szerver oldali szerződés-fogyasztó nem éri el — **igen**;
- egy böngésző-bundle a saját, bejelentkezett lapján nem éri el — **nem**, és a `megerosites` hash sem zárja be ezt a rést; amit zár, az az elavult vagy kicserélt piszkozat.

És a mondat, amiért a kapu egyáltalán ember: **egyik ajtón sem érkezik ellenőrizhető hívó-azonosság** (a szerződés-handle birtokosi képesség, az rpc a host access key-e mögött van, nem egy sessioné), tehát az `ajto` oszlop az ajtót rögzíti, nem a hívót — és ha nincs kit felelősségre vonni, a kimenetért egy embernek kell felelnie.

- [ ] **Step 2: `releaseDraft` — a sorrend**

Nyolc lépés, a spec 5.4 szerint, ebben a sorrendben, mindegyik saját kóddal:

1. `kimenoId` → sor; nincs → `gmail_kimeno_ismeretlen`.
2. `allapot !== 'piszkozat'` → `gmail_kimeno_allapot`. **Nem** idempotens „már kiment, rendben": egy második kattintás után az operátornak tudnia kell, hogy nem ment ki kétszer.
3. `client.getDraft(row.gmail_draft_id)` — **friss olvasás a Gmailből**, nem a sorból.
4. `eloHash = eloHashOf(elo)` a `(cimek, targy, torzs)` hármason, ugyanazzal a `torzsHashOf`-fal, mint amivel a sor készült.
5. `megerosites !== eloHash` → `gmail_lap_elavult`. **És innen nem megy tovább:** a tesztnek rögzítenie kell, hogy a fake `sendDraft` ilyenkor nem hívódik.
6. `eloHash !== row.torzs_hash` → **nem visszautasítás.** `markSzerkesztve` a friss mezőkkel, és a válasz jelöli. Aki szerkeszthette, kizárólag az operátor a saját kliensében, mert a hitelesítés csak ebben a modulban él.
7. Az élő címzettek közül a könyvben nem szereplők `konyvonKivul`-ba. **Nem visszautasítás**: egy cím, amit egy ember a saját postafiókjában beírt, döntés — de a lap kiírja, mert egy cím, ami döntés nélkül jelent meg, pont az, ami ellen ez épül, és a kettőt csak ember tudja megkülönböztetni.
8. Napi kiadási keret, `sendDraft`, `markKiadva`.

- [ ] **Step 3: `discardDraft` és `outbox`**

`discardDraft`: `deleteDraft` a Gmailen, aztán `markElvetve`. Ebben a sorrendben, mert egy törölt Gmail-piszkozat és egy `piszkozat` sor együtt egy `gmail_draft_failed`-del látszik a lapon, fordítva viszont egy `elvetve` sor mellett egy élő piszkozat maradna a Gmailben, amit már senki nem keres.

`outbox({ allapot, limit, offset })`: a repo `kimenok` + `countKimeno`, `{ total, count, items }` alakban. **A vetület a Task 8-ban dől el** (a szerződésé szűkebb, mint a lapé), itt a teljes sor megy vissza.

- [ ] **Step 4: Tesztek + gates + commit**

A spec 12.4 „a kiadás" és „a keretek" sorai.

```bash
npx tsx --test extensions/gmail/test/*.test.mjs && npm run type-check && npm run lint:baseline
git add extensions/gmail
git commit -m "Add the release path: a person, a fresh read and a hash bound to the bytes"
```

### Task 8: a szerződés, az rpc és a health

**Files:**
- Create: `extensions/gmail/src/contract.mjs`, `extensions/gmail/src/rpc.mjs`, `extensions/gmail/src/health.mjs`, `extensions/gmail/test/contract.test.mjs`, `extensions/gmail/test/rpc.test.mjs`
- Modify: `extensions/gmail/index.mjs`

**Interfaces:**
- Produces: `MAILBOX_CONTRACT = 'mailbox'`, `MAILBOX_CONTRACT_VERSION = 1`, `createMailboxContract(state)`, `OUTBOX_MEZOK`; `createRpc(state, { workspaceDir, portFile })`; `HEALTH_CODES`, `runHealth(state)`.
- Consumes: Task 5, Task 6, Task 7.

- [ ] **Step 1: `src/contract.mjs`**

Hat metódus: `mailbox`, `labels`, `list`, `get`, `draft`, `outbox`. A fejkomment az aisignal `contract.mjs`-ének alakját követi: **miért ez a hat és miért nem a többi**, egyenként — `releaseDraft`, `label`, `addRecipient`, `health`, `mcpConfig` —, és **mit nem tud ez az oldal a határról**: a handle birtokosi képesség, semmi nem érkezik arról, ki kérdez, és az egyetlen szűkítés az, hogy kevesebb metódust deklarálunk.

```js
export const OUTBOX_MEZOK = Object.freeze([
  'id', 'allapot', 'cimzettHandlek', 'targy', 'torzsHash',
  'gmailDraftId', 'gmailMessageId', 'ajto', 'createdAt', 'kiadvaAt', 'hibaKod',
])
```

A komment mondja ki, miért nincs benne a `torzs` és a `cimzett_cimek`: az `outbox` nem tud egy fogyasztóra szűkíteni, mert nem tudja, ki hívja; ha kiadná a törzset, bármelyik fogyasztó elolvashatná bármelyik másikét, és ha kiadná a feloldott címeket, a címzettkönyvet lehetne végigolvasni egy metóduson, ami azt mondja magáról, hogy „kimenő sor". A saját piszkozata címeit a hívó a `draft` válaszában kapja meg.

A `draft` a szerződésen `AJTOK.SZERZODES`-szel hív; az rpc-n `AJTOK.RPC`-vel. Két konstans két fájlban, nem argumentum.

- [ ] **Step 2: `src/health.mjs`**

```js
export const HEALTH_CODES = Object.freeze([
  'google_oauth_client_missing', 'gmail_hitelesites_hianyzik', 'gmail_scope_missing',
  'gmail_token_revoked', 'gmail_cimzettkonyv_ures', 'gmail_port_fajl_hianyzik',
])
```

`runHealth(state)`: `ctx.oauth.googleClientConfigured()` (Task 1) → `hasGoogleCredential('gmail')` → `repo.eloCimzettCount()` → a port-fájl megléte és élő pidje. **Ebben a sorrendben**, mert a kliens hiánya az első fal, és a hitelesítő hiánya egy kliens nélkül félrevezető mondat volna.

Visszaad: `{ hibak: [{ kod, mode? }], postafiok, keretek, szamok }`. Kulcs- és tokenérték soha.

Egy teszt rögzíti, hogy a `HEALTH_CODES` minden eleméhez van lap-mondat (Task 10), és minden lap-mondathoz van kód — egy helyről, hogy a kettő ne csúszhasson szét.

- [ ] **Step 3: `src/rpc.mjs`**

A spec 6.3 táblázata. A fejkomment a tts `rpc.mjs`-ének indoklását követi: ez a szélesebb a kettő közül, mert az útvonal mögött csak a saját bundle és a kézzel regisztrált shim áll, és **ide kerül az az egy metódus, ami az operátor kezéből ír** (`releaseDraft`). Egy metódus hozzáadása itt semmit nem ad a szerződéshez.

`mcpConfig`: a másolható bejegyzés, `env.SWARMCLAW_PORT_FILE`-lal, a tts `mcpConfig`-jának alakjában.

- [ ] **Step 4: `index.mjs` befejezése**

`rpc: createRpc(state, { workspaceDir, portFile: resolvePortFile() })` és
`provides: { [MAILBOX_CONTRACT]: createMailboxContract(state) }`.
A `resolvePortFile()` a tts `index.mjs`-ének másolata, a `SWARMCLAW_HOME` / `DATA_DIR` szabállyal és azzal a kommenttel, hogy ez a host szabályának **második másolata**, amit innen nem lehet ellenőrizni, és a lap ezért mutatja meg az útvonalat.

- [ ] **Step 5: Tesztek + gates + commit**

`test/contract.test.mjs`: `Object.keys(methods)` **pontosan** a hat név; `releaseDraft`, `label`, `addRecipient`, `health`, `mcpConfig` nincs köztük; az `outbox` vetületében nincs `torzs` és nincs `cimzett_cimek`; a `summary` tartalmazza az „idegen"/„a fogyasztó őrzi" mondatot.

```bash
npx tsx --test extensions/gmail/test/*.test.mjs && npm run type-check && npm run lint:baseline
git add extensions/gmail
git commit -m "Offer the mailbox contract, the page rpc and the health codes"
```

### Task 9: az MCP-szerver (Task 10-zel párhuzamos)

**Files:**
- Create: `extensions/gmail/mcp/server.mjs`, `extensions/gmail/test/mcp.test.mjs`

**Interfaces:**
- Produces: `SHIM_METODUSOK` (hat név); a shim kódjai: `gmail_port_fajl_beallitatlan`, `swarmclaw_nem_fut`, `swarmclaw_kulcs_beallitatlan`, `swarmclaw_kulcs_ervenytelen`, `gmail_extension_hianyzik`, `mcp_ismeretlen_metodus`, `host_hiba`.
- Consumes: Task 8 (az rpc metódusai), a host `run/port.json`-ja.

- [ ] **Step 1: A shim**

Az `extensions/tts/mcp/server.mjs` felépítése változatlanul: stdio JSON-RPC, `PROTOCOL_VERSION`, a port-fájl három ellenőrzése (alak; boot-idő majd pid; `GET /api/healthz` `service: "swarmclaw"`), minden tool-híváson újra. Az `EXTENSION_ID` `'gmail.mjs'`.

A hat tool a spec 6.2 táblázata szerint. A leírásukban két dolog kötelező, mert egy ügynök ezt olvassa el, mielőtt dönt:

- a `gmail_search` leírása mondja ki, hogy a `query` **szó szerint** megy a Gmailnek, nincs fuzzy illesztés és nincs természetes nyelvi átírás, és hogy a lapozás a `cursor`/`nextCursor` páron megy;
- a `gmail_draft` leírása mondja ki, hogy **piszkozatot ír, nem küld**, és hogy a kiadás az operátoré a `/x/gmail` lapon.

- [ ] **Step 2: Az allowlist**

```js
/**
 * The rpc methods this shim will forward, and the whole of them.
 *
 * `releaseDraft`, `discardDraft`, `addRecipient` and `retireRecipient` are
 * absent on purpose: releasing is the operator's act (spec 5.4) and the
 * recipient book is the operator's gate (spec 3.3). A name outside this list is
 * refused here, so reaching one of them from an agent takes two mistakes -- one
 * here and one in rpc.mjs -- and a test pins both.
 */
const SHIM_METODUSOK = Object.freeze(['search', 'read', 'labels', 'label', 'draft', 'outbox'])
```

- [ ] **Step 3: Teszt a szállított futtatókörnyezeten**

`test/mcp.test.mjs` **sima `node`-dal** (`process.execPath`) indítja a shimet egy scratch port-fájllal és egy kis fake HTTP-szerverrel, ami a rpc-t utánozza. Esetek: `tools/list` hat toolt ad; `gmail_search` átadja a kurzort és visszaadja a `complete`-et; hiányzó port-fájl → `gmail_port_fajl_beallitatlan`; halott pid → `swarmclaw_nem_fut` a `reason`-nel; `releaseDraft` mint tool-név → `mcp_ismeretlen_metodus`, és a fake szerver **nem kap kérést**; egy 404-es rpc → `gmail_extension_hianyzik`.

- [ ] **Step 4: Gates + commit**

```bash
node --test extensions/gmail/test/mcp.test.mjs && npx tsx --test extensions/gmail/test/*.test.mjs && npm run type-check && npm run lint:baseline
git add extensions/gmail
git commit -m "Add the gmail MCP server with the page cursor the existing one cannot give"
```

### Task 10: a lap (Task 9-cel párhuzamos)

**Files:**
- Create: `extensions/gmail/ui/*`, `extensions/gmail/test/ui.test.mjs`

**Interfaces:**
- Consumes: Task 8 (`board`, `health`, `outbox`, `releaseDraft`, `discardDraft`, `addRecipient`, `retireRecipient`, `attempts`, `mcpConfig`).

- [ ] **Step 1: Az állapotsáv**

A `HEALTH_CODES` mind a hat kódjához **külön mondat**, összemosás nélkül, a spec 7.3 táblázata szerint. A `google_oauth_client_missing` mondata megnevezi a módot (`desktop`/`vps`) és a két env-változót.

**A bekötés gomb kikapcsolva, ha nincs kliens** — nem eltüntetve, hanem letiltva a mondattal. Ma az aisignal lapja egy sima `<a href>`-et ad, és a route 500-zal válaszol; ez a lap ezt nem ismételheti meg. A Task 1 409-e a tartalék: ha a gomb mégis megnyomódik (verseny a health és a kattintás közt), a válasz olvasható.

- [ ] **Step 2: A Kimenő nézet**

A `piszkozat` tételek elöl, mindegyiken: a címzettek handle-lel **és** címmel, a tárgy, a **teljes** törzs (nem levágva — amit ki fog küldeni, azt látnia kell), a „szerkesztve a Gmailben" jelölés, a könyvön kívüli címzettek kiemelve, és a **Kiadás** / **Elvetés** gomb.

A Kiadás a megjelenített törzs hash-ét küldi `megerosites`-ként. **A hash-t a szerver számolja és a `board` adja** — a lap nem számol sha256-ot a böngészőben, mert akkor két implementációnak kellene bájtra egyeznie, és a második elcsúszása egy néma `gmail_lap_elavult`-lá válna minden kiadáson.

- [ ] **Step 3: A Címzettek és a Kísérletek nézet**

A könyv, egy űrlappal és `Visszavon` gombbal; a lap kiírja, hogy **ez az egyetlen hely, ahol e-mail-cím keletkezik ehhez a modulhoz**. A Kísérletek nézet az `ext_gmail_kiserletek` sorai, a kért szöveg „idegen szöveg" jelöléssel a doboz fölött.

Legalul a másolható MCP-bejegyzés és az **`Uninstall előtt`** szakasz (spec 12.3): add ki vagy vesd el minden piszkozatot; törlendő hitelesítők (`google-oauth:gmail`, és ha a Task 11 megvolt, `google-oauth:aisignal`); a törlés nem visszavonás; az MCP-bejegyzés törlése; és a címzettkönyv másolható kiírása, mert az újratelepítés üres táblákkal indul.

- [ ] **Step 4: Gates + commit**

Nincs `innerHTML`, nincs `dangerouslySetInnerHTML`, nincs `eval`; minden szöveg React-gyerekként. `test/ui.test.mjs` a tiszta függvényekre (a mondat-leképezés, a formázás).

```bash
npm run build --prefix extensions/gmail && npx tsx --test extensions/gmail/test/*.test.mjs && npm run type-check && npm run lint:baseline
git add extensions/gmail
git commit -m "Add the gmail page: status, outbound queue, recipient book and refusals"
```

---

## A-lánc: az AI Signal átállása

### Task 11: az AI Signal a `mailbox` szerződést fogyasztja

**Files:**
- Delete: `extensions/aisignal/src/gmail.mjs`, `extensions/aisignal/test/gmail.test.mjs`
- Modify: `extensions/aisignal/index.mjs`, `src/sweep.mjs`, `src/rpc.mjs`, `ui/status-bar.tsx`, `ui/format.ts`, `test/sweep.test.mjs`, `test/rpc.test.mjs`

**Interfaces:**
- Consumes: Task 8 (`mailbox` v1), Task 1 (a `gmail` purpose).
- Produces: `consumes: [{ extension: 'gmail', contract: 'mailbox', version: 1, reason: … }]` az aisignal manifesztjén.

- [ ] **Step 1: A négy hívás**

| ma | ezután |
|---|---|
| `gmail.labelId(label)` | `mb.labels()` → pontos (kis/nagybetű-érzékeny) névegyezés a hívó oldalán; nincs találat → `gmail_label_missing`; nincs `labels` tömb → `gmail_unexpected`. **Az illesztés pontos marad**, ugyanazzal az indokkal, ami ma is áll: a Gmail két, csak kisbetűben eltérő címkét is enged, és a case összehajtása a rossz postafiókot söpörné |
| `gmail.mailbox()` | `mb.mailbox()` → `{ address }` |
| `gmail.listIds({ labelId, since, max })` | `mb.list({ labelIds: [labelId], q: sinceQuery(since), max })` — a `sinceQuery` a `gmail` extensionből jön, az `mb.list` `q`-jaként |
| `gmail.getMessage(id)` | `mb.get({ id })` |

`gmailFor(state)` törlődik; helyette:

```js
function mailboxFor(state) {
  if (state.gmailFactory) return state.gmailFactory()
  return state.contracts.get('gmail', 'mailbox', 1)
}
```

A `state.gmailFactory` **neve marad**, hogy a meglévő tesztek szerkezete ne boruljon, de a kommentje kimondja, hogy mostantól a **szerződés-handle** dublőrje, nem a kliensé.

- [ ] **Step 2: Az egy sor, ami a frontiert érinti**

```js
// ma:
// const drained = listed.truncated === false && leftover === 0
// ezután:
const drained = listed.complete === true && leftover === 0
```

Az `=== true` (nem `listed.complete`, nem `!listed.truncated`) szándékos, és ugyanaz a szándék, mint ma: **bármi, ami nem kifejezett igen — `undefined` egy régi handle-től, `null`, hiányzó mező —, nyitva hagyja az ablakot.** Az a széles irány, és ez a fájl azt tévedheti.

Ehhez tartozik egy teszt, ami ezt a *hiányt* gyakorolja: egy dublőr, ami `complete` nélküli objektumot ad vissza, `drained: false`-t kell adjon, és a frontier nem mozdulhat.

A `listStoppedOn` a `note`-ba írása változatlan, és továbbra is **csak diagnosztika**: soha nem olvassa vissza semmi vezérlő-állapotként.

- [ ] **Step 3: `consumes`, a hitelesítés és a lap**

`extensions/aisignal/index.mjs`:

```js
  consumes: [
    { extension: 'gmail', contract: 'mailbox', version: 1,
      reason: 'A hirlevel-cimke uzeneteit listazza es olvassa be; a levelek szoveget sajat kartyakent tarolja.' },
  ],
```

`state.oauth` és a `hasGoogleCredential` dep törlődik az `index.mjs`-ből és az `rpc.mjs`-ből; az `OAUTH_PURPOSE` a `sweep.mjs`-ből. **A helyükre `state.contracts` kerül**, mert az aisignal `state`-jén ma nincs ilyen kulcs (a `setup(ctx)` négy dolgot vesz át, és a `contracts` nincs köztük) — a `setup` egy sorral bővül (`state.contracts = ctx.contracts`), és a `state` deklarációja is, hogy a seam ott legyen látható, ahol a többi. A lap `gmail` állapota a szerződés feloldhatóságából jön (`ctx.contracts.why`: `provider_missing`, `provider_disabled`, `version_mismatch` — mindhárom **más operátori teendő**, tehát szó szerint kerül a válaszba), és a „Gmail bekötése" gomb helyett link a `/x/gmail` lapra.

- [ ] **Step 4: Az élő telepítés átállása (spec 10.2)**

Ez a lépés kézi, és a sorrend kötött:

1. `node extensions/gmail/scripts/install.mjs`, majd az extension engedélyezése — **az aisignal frissítése előtt**.
2. A Task 1 env-változói beállítva, a host újraindítva.
3. `/x/gmail` → **Gmail bekötése** → consent a `gmail` purpose-szal → `google-oauth:gmail` sor a `credentials` táblában.
4. Csak most az aisignal frissítése (`node extensions/aisignal/scripts/install.mjs`).
5. Ellenőrzés: a frontier-sor `(mail, <cím>, <címke-id>)` kulcson **változatlan**; a következő sweep ugyanonnan folytatja; a `ext_aisignal_sweeps` új sora `ok = 1`.

Amit rögzíteni kell a commit-üzenetben: a frontier `frontier` és `moved_at` értéke az átállás előtt és után. Ha megváltozott, az hiba, és a feladat nincs kész.

- [ ] **Step 5: Gates + commit**

```bash
npx tsx --test extensions/aisignal/test/*.test.mjs extensions/gmail/test/*.test.mjs
npm run type-check && npm run lint:baseline
git add extensions/aisignal
git commit -m "Move AI Signal onto the gmail mailbox contract and drop its own client"
```

---

## Zárás

### Task 12: telepítés, hiba, eltávolítás — a feladatok közé eső lyukak

Ez a feladat **csak** azt nézi, ami az AI Signal és a videómodul ágán a feladatok közé esett. Új képességet nem ad.

**Files:**
- Modify: `extensions/gmail/scripts/install.mjs` (a záró jelentés)
- Create: `extensions/gmail/test/import-time.test.mjs`, `extensions/gmail/test/deploy.smoke.mjs`, `scripts/gmail-deploy-smoke.mjs`
- Modify: `package.json` (`test:deploy:gmail`), `Dockerfile`

- [ ] **Step 1: Az install-szkript záró jelentése (spec 12.1)**

A hat sor a spec 12.1 táblázatából. A szkript **nem tudja hívni** a `health`-et (nincs futó host), de meg tudja nézni a `run/port.json`-t, és **meg tudja nézni a saját folyamatában** a négy env-változót — az utóbbi félrevezető lehet, ha a hostot más környezettel indítják, ezért az a sor `[ ? ]`-lel jön, a mondattal, hogy a hostot kell megnézni.

A videómodul mintája szerint: `[ ok]` / `[ ! ]` / `[ ? ]` jelölés, és minden hiányzó sor mellé az, hogy mit kell tenni.

**Ami nincs a listán, és a szkript ezt ki is írja:** Reconcile. Ennek a modulnak nincs managed erőforrása, tehát nincs mit összehangolni — és a szkript megnevezi a Task 2-t, hogy egy jövőbeli fogyasztó tudja, hova nyúljon.

- [ ] **Step 2: Import-idő és betöltési alak a szállított futtatókörnyezeten**

`test/import-time.test.mjs` a videómodul mintája szerint, **sima `node`-dal** (`process.execPath`, `--input-type=module`):

- az import ideje < 5 s (a host 30 s-os határa alatt bőven);
- `name`, `tools.length === 0`, `Object.keys(rpc)` a Task 8 listája, `Object.keys(provides)` `['mailbox']`, nincs `consumes`, nincs `hooks`, `managedResources` hiányzik vagy üres, `migrations.length === 1`, `typeof setup === 'function'`;
- az `index.mjs` szövegében nincs `^\s*await\s`, nincs `readFileSync`, `readdirSync`, `setInterval(`, `setTimeout(`, `fetch(`.

- [ ] **Step 3: Deploy-smoke a futó hoston**

`test/deploy.smoke.mjs` az aisignal smoke-ja szerint: (1) `/api/healthz`, belépés; (2) `/api/extensions` bejegyzés `gmail.mjs`-re — `toolCount: 0`, `hasUI`, nincs `lastFailureError`, `contractsProvided` tartalmazza `{ contract: 'mailbox', version: 1 }`-et; (3) `?type=pages` a `/x/gmail` lappal, a `dist/index.js` és `dist/style.css` kiszolgálva; (4) `/x/gmail` a shellel; (5) rpc `health` (a `hibak` tömb; a válasz szövegében **nincs** `refresh_token`, `access_token`, `CLIENT_SECRET`), `board`, `mcpConfig` (az `env.SWARMCLAW_PORT_FILE` létező fájl, benne élő pid); (6) a shim `process.execPath`-szal indítva a `mcpConfig` `args`-ával és `env`-jével → `tools/list` hat toolt ad a **futó host** ellen; (7) `DATA_DIR`-rel: az `ext_migrations` sora `gmail.mjs`-re, a négy tábla, a workspace-ben nincs `.node` fájl.

`scripts/gmail-deploy-smoke.mjs`: az `aisignal-deploy-smoke.mjs` másolata. `package.json`: `"test:deploy:gmail": "node ./scripts/gmail-deploy-smoke.mjs"`.

- [ ] **Step 4: Dockerfile**

```dockerfile
RUN cd /app/extensions/gmail && npm ci && npm run build && rm -rf node_modules
```
és
```dockerfile
COPY --from=base /app/extensions/gmail ./extensions/gmail
```
Új rendszercsomag nem kell: ez a modul semmit nem spawnol.

- [ ] **Step 5: A három lyuk kézzel, sorban, és a látottak rögzítése**

Friss testhome-on (`rm -rf ~/dev/swarmclaw-testhome`), szabad porton:

1. **Telepítés, ami nem fut.** `install.mjs` → a jelentés `[ ? ]` sorai; dev szerver **a Google env-változók nélkül**; `/x/gmail` → „Nincs Google OAuth-kliens konfigurálva (mód: …)", a bekötés gomb kikapcsolva. Egy `mailbox` szerződés-hívás → `google_oauth_client_missing`. Env-változókkal újraindítva → a mondat „a postafiók nincs bekötve"-re vált. Bekötés után → a cím látszik. Egyik állapot sem néz tétlennek, és egyik sem mond 500-at.
2. **Beragadás.** `SWARMCLAW_EXTENSION_IMPORT_TIMEOUT_MS=100`-zal indítva: a `gmail` betölt (az import-idő teszt száma messze alatta); egy szándékosan lógó próba-extension a testhome-ba (`await new Promise(() => {})`) → a host indul, a kártya `load.import_timeout`-ot mutat, a `gmail` él. A próbafájl törlendő.
3. **Letiltás.** Extensions → Gmail → letilt. Az aisignal következő sweepje `provider_disabled`-del **névvel bukik**, a frontier nem mozdul, és a hiba a lapon látszik. Engedélyezés után a következő sweep megy. (Managed ütemezése ennek a modulnak nincs, tehát a videómodul `extension_disabled` esete itt nem áll fenn — és ezt a lépés jegyzőkönyve mondja ki, nem hallgatja el.)
4. **Eltávolítás.** Egy nyitott piszkozattal próbálva: a lap `Uninstall előtt` szakasza; `Elvetés` → a Gmail-piszkozat eltűnt; törlés → `sqlite3 … ".tables" | grep -c ext_gmail_` → 0; a `google-oauth:gmail` sor **megmarad** (a host nem törli), és a Credentials felületén kézzel törölhető; a shim egy MCP-hívásra `gmail_extension_hianyzik`-kal válaszol, nem csendben. Újratelepítés → üres táblák, **üres címzettkönyv**.

Amit ezek közül a gép másképp csinál, mint a terv mondja, az ebben a feladatban javítandó, és a javítás a commit-üzenetbe kerül.

- [ ] **Step 6: Gates + commit**

```bash
npm run build:ci && npm run test:deploy:gmail
node --test extensions/gmail/test/import-time.test.mjs extensions/gmail/test/mcp.test.mjs
npx tsx --test extensions/gmail/test/*.test.mjs && npm run type-check && npm run lint:baseline
git add extensions/gmail scripts/gmail-deploy-smoke.mjs package.json Dockerfile
git commit -m "Own install, failure and uninstall for the gmail extension"
```

### Task 13: böngésző-smoke Playwrighttal

**Files:**
- Create: `extensions/gmail/test/e2e.smoke.mjs`
- Modify: `package.json` (`test:e2e:gmail`)

Az aisignal `test/e2e.smoke.mjs` felépítésével (build, scratch-telepítés, dev szerver szabad porton, seed a repón át, Playwright). A seed: két címzett a könyvben (egy élő, egy visszavont), egy `piszkozat` kimenő sor `<script>alert(1)</script>` tárggyal, egy `kiadva` sor, és két `ext_gmail_kiserletek` sor (`gmail_cimzett_cim_literal` és `gmail_cimzett_ismeretlen`).

Forgatókönyv:

1. `/x/gmail` betölt **Google env-változók nélkül**: az állapotsáv a `google_oauth_client_missing` mondatát mutatja a móddal, és a bekötés gomb `disabled`.
2. A `<script>` tárgy **szövegként** jelenik meg (a `.gm-root` alatt a DOM-ban nincs `script` elem).
3. A `piszkozat` kártyán a címzett handle **és** cím látszik; a törzs teljes egészében.
4. `Kiadás` → a fake Gmail (a seed-elt `gmail_draft_id`-hoz a smoke saját HTTP-dublőrje) → a sor `kiadva`, a `gmail_message_id` látszik.
5. A `Kiadás` egy második kattintásra tiltva vagy `gmail_kimeno_allapot`-ot mutat — nem küld másodszor.
6. Címzettek fül → új handle felvétele, a visszavont sor `visszavonva` jelöléssel.
7. Kísérletek fül → a két sor a kódjával, „idegen szöveg" jelöléssel a doboz fölött.
8. Konzol: nulla hiba (a `Report-only` CSP-sorokon kívül).

`package.json`: `"test:e2e:gmail": "node extensions/gmail/test/e2e.smoke.mjs"`.
Commit: `git commit -am "Add a browser smoke test for the gmail page"`.

### Task 14: mindkét üzemmód és az élő futás

- [ ] **Step 1: Electron-mód, az app saját szerverével** — `SWARMCLAW_DEPLOY_MODE=desktop` és a `GOOGLE_OAUTH_CLIENT_DESKTOP_*` pár. Ellenőrzés: `/extensions` mindhárom extension hibátlan; `/x/gmail` betölt; a bekötés végigmegy a **változó porton** (ez az, amiért Desktop app kliens kell, nem Web); `run/port.json` a home alatt, a pid az app szerveréé; a MCP-bejegyzés felvéve → egy ügynök `gmail_search`-e a valódi postafiókból ad választ, kurzorral.

- [ ] **Step 2: VPS-mód Dockerben** — `docker compose build && up`; `docker compose exec app node extensions/gmail/scripts/install.mjs`; a `GOOGLE_OAUTH_CLIENT_WEB_*` pár és a `SWARMCLAW_PUBLIC_ORIGIN`; ugyanaz az ellenőrzés. Elvárás: **semmi nem viselkedik másképp**, mint desktopon — ha valami mégis, az a Global Constraints megsértése, és ebben a lépésben javítandó.

- [ ] **Step 3: Élő futás a Macen (a repo CLAUDE.md kötelezővé teszi)**

Sorrendben, egy valódi postafiókon:

1. Egy ügynök chatből, az MCP-szerverrel: `gmail_search` a hírlevél-címkére, `max: 3` → három id és egy `nextCursor`; ugyanaz a hívás a kurzorral → a **következő** három, átfedés nélkül; addig lapozva, amíg `complete: true`. **Ez az a bizonyíték, amiért ez az extension létezik**, és a kimenete a commit-üzenetbe kerül.
2. `gmail_read` az elsőre → a vetület; a válaszban **nincs** `to`, `cc`, `raw`, `snippet`.
3. `gmail_label` egy próbacímkével oda-vissza; `gmail_label` `TRASH`-sel → `gmail_cimke_tiltott`.
4. Egy címzett felvétele a könyvbe a lapon (az operátor saját második címe).
5. `gmail_draft` arra a handle-re → a piszkozat megjelenik a **valódi Gmail Drafts mappájában**, és a `/x/gmail` lapon.
6. `gmail_draft` egy **cím-literállal** → `gmail_cimzett_cim_literal`, és a Kísérletek nézetben megjelenik a sor. Ez az injekció-eset élő próbája.
7. A lapon **Kiadás** → a levél megérkezik. Ez az első kimenő levél, amit ez a rendszer valaha küldött; a `gmail_message_id` a commit-üzenetbe kerül.
8. Válasz-piszkozat: `gmail_draft` a most érkezett levél id-jével → a piszkozat címzettje a `From`, és **nem** a `Reply-To`, ha a levélen van ilyen (a 4. lépés címéről érdemes egy `Reply-To`-s levelet küldeni, hogy ez ténylegesen mérve legyen).
9. Az AI Signal kétóránkénti sweepje egy teljes körben, a szerződésen át: `ok = 1`, és a frontier lép.

- [ ] **Step 4: Rögzítés**

- Az 1. lépés kurzoros lapozásának kimenete (id-k, `complete` váltása) a commit-üzenetbe.
- A `gmail.modify` consent képernyőjének tényleges szövege és az, hogy verifikáció nélkül átment-e (spec 14. első nyitott pontja) → a `start/route.ts` `SCOPES` kommentjébe, a dátummal.
- Ha egy `drafts.send` nem-2xx-et adott, a **valódi** státuszkód és törzsalak a `client.mjs` fejkommentjébe és egy rögzített tesztesetbe; ha egy külön kód indokolt, az felkerül a `HIBA_KODOK`-ba.
- Az Electron consent útja (azonos lap vagy rendszerböngésző, spec 14. harmadik pontja) egy mondatban a `ui/status-bar.tsx` kommentjébe.

- [ ] **Step 5: Commit**

```bash
git add extensions/gmail extensions/aisignal src/app/api/oauth/google
git commit -m "Verify the gmail extension in both deploy modes with a live mailbox and one sent message"
```

---

## Önellenőrzés (a terv a spec ellen)

| Spec-követelmény | Task |
|---|---|
| 1.1 A lapozás és a determinizmus, mint a meglévő MCP két hiánya | 4 (`list`), 9 (`gmail_search` leírása), 14 Step 3.1 (élő bizonyíték) |
| 1.3 Két ajtó egy hitelesítés mögött | 8 (`contract` + `rpc`), 9 (shim), 4 (`clientFor`, `OAUTH_PURPOSE`) |
| 1.4 Nem levelezőprogram: nincs beállítás, nincs végleges törlés, nincs melléklet, nincs szál | 1 (a scope), 5 (`CIMKE_TILTOTT`), 6 (`gmail_mezo_nem_tamogatott`) |
| 2.1 Könyvtárak, szinkron `setup`, nincs top-level await | 3, 12 (`import-time.test.mjs`) |
| 2.2 A shim a hostra továbbít, port-fájlból | 9 |
| 2.4 `tools: []`, és az ára (nincs `agentId`) | 3 (a váz), 7 (a fejkomment) |
| 3.1 Négy tábla a spec oszlopaival | 3 |
| 3.2 Minden kulcs: a könyv mint killswitch, `torzs_hash`, `allapot`, a két napi számláló, a kísérletek nem gátolnak | 3 (séma + teszt), 6, 7 |
| 3.3 Ki írhat mit: a könyv csak a lapról, a hash-eket a modul, az `ajto` konstans | 3, 6, 7, 8 |
| 3.4 Nem tárol levéltörzset olvasásból; a frontier a fogyasztóé | 3 (nincs cache-tábla), 11 (a frontier érintetlen) |
| 4.1 `nextCursor`, `complete`, `stoppedOn` és az invariáns | 4 |
| 4.2 A `q` szó szerint; `sinceQuery` változatlanul | 4, 9 |
| 4.3 `UZENET_MEZOK` és a hét tételes kizárás; nem tisztít | 5 |
| 4.4 A kliens változatlan része: határidő, zárt kódkészlet, `unexpectedShape`, `sinceQuery` | 4 Step 1 (az 57 teszt zölden) |
| 5.1 Három lépés; a piszkozat mint felülvizsgálati felület | 6, 7, 10 |
| 5.2 Címzettkönyv, `gmail_cimzett_cim_literal`, nincs részleges teljesítés | 6 |
| 5.3 A válasz a borítékból; nincs `Reply-To`, nincs `Cc`, nincs reply-all | 6 Step 3 |
| 5.4 A kiadás nyolc lépése; mit véd és mit nem; a hívó-azonosság hiánya | 7 |
| 5.5 Két keret, három napló-tábla, nincs kulcsérték | 3, 6, 7, 10 |
| 5.6 A választás, az ára, és az `auto_kiadas` mint jelölt utómunka | 7 (a fejkomment), 10 (a lap mondata) |
| 6.1 A szerződés hat metódusa és az öt kizárás; `OUTBOX_MEZOK` | 8 |
| 6.2 Hat MCP-tool, nincs `gmail_send`, `CIMKE_TILTOTT`, az allowlist | 5, 9 |
| 6.3 Az rpc tizennégy metódusa; miért szélesebb | 8 |
| 6.4 A zárt kódkészlet és a két betűzési szabály | 3 (`HIBA_KODOK` + grep-teszt) |
| 7.1 A kliens, a két env-pár, a redirect URI, az „In production" | 1, 10 (az állapotsáv mondata), 12 Step 1 |
| 7.2 A `gmail.modify` és az indoklása; a grant a valódi hatósugár | 1 (a `SCOPES` komment), 10 (a lap szövege) |
| 7.3 A hat health-kód és a hat lap-mondat, egy helyről | 8 (`HEALTH_CODES`), 10 |
| 8. A lap három nézete; nincs `innerHTML`; a hash a szerverről | 10, 13 |
| 8.1 Az rpc-táblázat | 8 |
| 9. `consumes` nincs; `provides.mailbox` v1 | 3, 8 |
| 10.1 Mi költözik, mi marad; a négy hívás | 4, 11 |
| 10.2 Egy működő telepítés az átállás közben, a kötött sorrenddel | 11 Step 4 |
| 11. A tíz „soha" | 7 (1.), 6 (2.), 5 (3.), 1+5 (4.), 3+5+6 (5.), 7 (6.), 6+8 (7.), 8+12 (8.), 3 (9.), 3 (10.) |
| 12.1 A hat telepítési lépés; nincs Reconcile-igény, de a lyuk megnevezve | 2, 12 Step 1 |
| 12.2 Nem blokkol indulást; a hitelesítés hibái nem betöltési hibák; a sor a Gmail-hívás előtt | 6 Step 2, 12 Step 2 |
| 12.3 `Uninstall előtt`; a törlés nem visszavonás; az üres címzettkönyv | 10 Step 3, 12 Step 5 |
| 12.4 A tizenhét teszt-sor | 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13 |
| 13. Ami nincs | — (nem feladat; a 14 Step 4 rögzíti, ami eldőlt) |
| 14. Amit nem tudunk | 14 Step 4 (mindhárom pont) |

**Nevek, amiket egy későbbi feladat használ, és a korábbi definiál:**
`GmailError`, `refuse`, `guard`, `HIBA_KODOK` (3 → mind); `readString`, `readEnum`, `readWholeNumber`, `readArray`, `readBoolean` (3 → mind); `MIGRATIONS`, `createRepo` metódusai, `sha256`, `canonicalJson`, `torzsHashOf`, `uid`, `now` (3 → 6, 7, 8);
`createGmail` (`mailbox`, `labels`, `list`, `get`, `createDraft`, `getDraft`, `sendDraft`, `deleteDraft`, `modifyLabels`), `REQUEST_TIMEOUT_MS`, `MAX_PAGES`, `sinceQuery`, `stripHtml` (4 → 5, 6, 7, 11); `buildMime`, `base64url` (4 → 6);
`clientFor`, `OAUTH_PURPOSE` (4 → 5, 6, 7, `health.mjs`); `UZENET_MEZOK`, `projectUzenet`, `createOlvasas`, `createCimkezes`, `CIMKE_TILTOTT` (5 → 8);
`HANDLE_RE`, `createCimzettek`, `feloldCimzettek`, `createPiszkozat`, `naploKiserlet`, `AJTOK`, `MAX_CIMZETT`, `MAX_TARGY`, `MAX_SZOVEG` (6 → 7, 8);
`createKiadas`, `eloHashOf` (7 → 8);
`MAILBOX_CONTRACT`, `MAILBOX_CONTRACT_VERSION`, `createMailboxContract`, `OUTBOX_MEZOK`, `createRpc`, `HEALTH_CODES`, `runHealth` (8 → index, 9, 10, 11, 12);
`SHIM_METODUSOK` (9 → 12);
`isGoogleClientConfigured`, `ctx.oauth.googleClientConfigured`, `SCOPES.gmail`, `RETURN_PATH.gmail` (1 → 8, 10, 11).

**Amit ez a terv nem old meg, és a spec is így hagyja:** a `releaseDraft` nem véd egy azonos eredetű böngésző-bundle ellen (spec 5.4); a modul nem tud ellenőrizhető hívó-azonosságot rögzíteni (spec 5.4); és a `gmail.modify` grant tud küldeni, akkor is, ha ebben az extensionben nincs olyan út, ami ember nélkül küld (spec 7.2). Mindhárom kimondva áll a kódban is, és egyik sem takarható el egy kommenttel, ami többet állít.
