# Olvasatlan-jelzés a chat-listában és natív értesítés az Electron appban

**Dátum:** 2026-09-09
**Állapot:** terv, jóváhagyásra vár
**Revízió:** 2 — a kódfelmérés kiderítette, hogy a funkció fele már létezik; a
terv ennek megfelelően átalakítva (lásd „Ami ma már megvan").

## A probléma

Ha egy ügynök válaszol egy chatben, amit épp nem nézel, arról az asztalodon
semmi nem szól. Elindítasz egy hosszú CLI-futást, elnavigálsz, és tíz perc múlva
kész — de erről csak akkor szerzel tudomást, ha véletlenül visszanézel.

## Ami ma már megvan

Ezt a szakaszt a terv írása közbeni kódfelmérés adta, és ez szabja meg a munka
tényleges méretét. **Nem nulláról építünk.**

| Ami van | Hol | Mi a baja |
|---|---|---|
| `Session.lastAssistantAt` — szerver-oldali időbélyeg az utolsó ügynök-üzenetről | `src/types/session.ts:94`, karbantartja `message-repository.ts:105-188` | Semmi. **Újrahasznosítjuk.** |
| `lastReadTimestamps` — meddig olvastad az egyes chateket | `src/stores/slices/data-slice.ts:136`, `localStorage` `sc_last_read` kulcs | Kliens-oldali. Újratelepítés után elvész, két ablak széttart, a webes UI és a desktop külön életet él. |
| `markChatRead(id)` | `data-slice.ts:137`, hívja `chat-list.tsx:125` | Csak chat-választáskor fut. **Nem néz fókuszt**, nincs türelmi idő. |
| Olvasatlan-badge a soron | `src/components/chat/chat-card.tsx:156-164` | Működik, csak a fenti rossz tárolóból olvas. |
| `'unread'` szűrő a listában | `chat-list.tsx:21,82` | Ugyanaz. |
| `sessions` WS-topic, 15 mp timer-tartalékkal | `live-query-sync.tsx:90-93`; küldi `notifySessionRunState` (`state.ts:194-196`) és `chat-turn-stream-execution.ts:334` | Semmi. **Nem kell új szerver-esemény.** |

Ami tényleg hiányzik: a szerver-oldali olvasottság, a fókusz-szabály, a hibás
futás jelzése, és az egész natív értesítés.

## Meghozott döntések

| # | Kérdés | Döntés |
|---|---|---|
| 1 | Melyik felület | Csak a chat-lista (`sessions`). A chatroom-ok kimaradnak. |
| 2 | Mikor olvasott | A chat aktív **és** az ablak fókuszban van. 3 mp türelmi idő. Scroll-alapú finomítás nincs. |
| 3 | Mi váltja ki | Ügynök-válasz (`lastAssistantAt`), forrástól függetlenül. Hibás turn is jelez, megkülönböztetve. |
| 4 | Kapcsoló | Globális be/ki **+** per-ügynök némítás. |
| 5 | Állapot helye | Szerver-oldal: `lastReadAt` a `sessions` rekordban — a meglévő `localStorage` **lecserélése**, egyszeri migrációval. |
| 6 | Értesítés útja | Electron **fő-folyamat** (`electron.Notification`), preload + IPC-n keresztül. |

### Miért a fő-folyamat (6)

A funkció épp a háttérben lévő ablakra való, és ott a renderer a leggyengébb:
az Electron `backgroundThrottling` alapból be van kapcsolva, a `useWs` tartaléka
pedig `setInterval`-alapú (`src/hooks/use-ws.ts:31`), tehát egy takart ablakban
lassul vagy megáll. A kattintás-kezeléshez (`win.show()`, `win.focus()`) amúgy is
kell IPC, tehát a fő-folyamatos út nem drágább — ugyanannyi kód, csak egy
helyen. Ráadásul a dock-badge (`app.dock.setBadge`) csak onnan érhető el, és a
`main.ts:81` már ma is nyúl az `app.dock`-hoz.

### Miért nem a `notifyWithPayload`

A `ws-hub.ts:115` tud adatot is küldeni, de a böngésző-oldali kliens **eldobja**:
a `WsCallback` típusa `() => void`, és a `handleMessage` (`src/lib/ws-client.ts:30-41`)
argumentum nélkül hívja a feliratkozókat. Nem nyúlunk ehhez a közös
csővezetékhez egyetlen funkció kedvéért. A kliens a `sessions` topic jelzésére
újratölti a listát, és mindent a szerver-oldali állapotból származtat — egy
igazságforrás, nulla új protokoll.

## Architektúra

Négy egység, mindegyik önállóan érthető és tesztelhető.

### 1. Olvasottság-tár (szerver)

**Mit csinál:** nyilvántartja, meddig olvastad az egyes chateket, és megmondja,
melyik olvasatlan.

Két új mező a `Session` típuson (`src/types/session.ts:53`):

- `lastReadAt?: number | null` — meddig olvastad.
- `lastFailedTurnAt?: number | null` — mikor végződött hibával egy turn.

**Miért kell a második.** A `lastAssistantAt` csak akkor mozdul, ha született
ügynök-üzenet. Egy elhasalt turn gyakran nem hagy maga után üzenetet, tehát a
3. döntés („a hiba is jelezzen") ebből egyedül nem teljesíthető. Egy mező, egy
írási hely, tiszta jelentés — nem kettő.

Származtatás (nincs tárolt boolean, egy igazságforrás):

```
lastActivityAt = max(lastAssistantAt ?? 0, lastFailedTurnAt ?? 0)
unread         = lastActivityAt > (lastReadAt ?? 0)
unreadIsError  = unread && (lastFailedTurnAt ?? 0) >= (lastAssistantAt ?? 0)
```

Írás `patchSession`-nel (`src/lib/server/sessions/session-repository.ts:66`),
nem `saveCollection`-nel: egyelemű módosítás, a bulk-delete őrt nem érinti.
`storage-normalization.ts`: mindkét mező alapértéke `null` betöltéskor.

**Függősége:** csak a session-repository.

### 2. Hibás-turn csatlakozó (szerver)

**Mit csinál:** hibával végződő turn után beírja a `lastFailedTurnAt`-ot.

Egyetlen pont: `src/lib/server/runtime/session-run-manager/drain.ts:129-144`,
a meglévő `emitRunMeta` / `Run finished` log mellé, ahol a `status` már kéznél
van. Csak `status === 'failed'` esetén ír; a `cancelled` **nem** jelez (amit te
szakítottál félbe, arról nem szólunk), a `completed` pedig a `lastAssistantAt`-on
keresztül amúgy is jelez.

Új WS-esemény **nem kell**: a `notifySessionRunState` (`state.ts:194-196`) már
ma is kilövi a `sessions` topicot minden futásállapot-változásra.

**Függősége:** olvasottság-tár.

### 3. Lista-jelzés és olvasottá jelölés (kliens)

**Mit csinál:** megmutatja, melyik chat olvasatlan, és bejelöli olvasottnak azt,
amit nézel.

- A `chat-card.tsx:156-164` meglévő badge-e átáll a szerver-oldali
  származtatásra, és kap egy hibás változatot (`unreadIsError`) — más szín,
  hogy ránézésre megkülönböztethető legyen.
- A `chat-list.tsx:82` `'unread'` szűrője ugyanerre a származtatásra áll át.
- `markChatRead` (`data-slice.ts:137`) a `localStorage` helyett a szerverre ír,
  és a lokális jelölés után `invalidateFingerprint('sessions')` fut
  (`src/stores/set-if-changed.ts`).
- **Egyszeri migráció:** első betöltéskor a meglévő `sc_last_read` értékek
  felmennek a szerverre, aztán a kulcs törlődik. Enélkül minden korábban
  olvasott chat olvasatlanra ugrana.
- Olvasottá jelölés akkor fut, ha `selectActiveSessionId(...)` erre a chatre
  mutat **és** az ablak fókuszban van. Fókuszvesztésnél **3 mp türelmi idő**: ha
  ezen belül visszatér a fókusz, az olvasottság megmarad, és értesítés sem megy
  ki. Ez akadályozza meg, hogy minden ablakváltás hamis olvasatlant szüljön.
- **Ehhez új hook kell.** A meglévő `usePageActive`
  (`src/hooks/use-page-active.ts`) *láthatóságot* mér (`visibilitychange` /
  `visibilityState`), nem fókuszt: egy Electron-ablak, ami látszik, de más app
  van előtte, `visible`-t mond. Kell egy testvér-hook (`useWindowFocused`),
  ugyanazzal a `useSyncExternalStore` mintával, csak `focus`/`blur` eseményekre
  és `document.hasFocus()` pillanatképre. Aki `usePageActive`-ot használ
  helyette, az csendben rossz szabályt épít.
- Az írás egy dedikált `POST /api/chats/:id/read`. **Nem** a meglévő
  `PUT /api/chats/:id`: az `updateChatSession`
  (`src/lib/server/chats/chat-session-service.ts:220`) mezőnkénti fehérlista,
  ami ügynök-újrakötést és route-feloldást is végez — egy olvasás-jelölőért,
  ami chatváltásonként fut, ez pazarlás és mellékhatás-kockázat. Az új route-ot
  a CLAUDE.md kiadási listája szerint fel kell venni a CLI-manifesztbe
  (`src/cli/index.js:658-670` mintájára), különben a route-lefedettségi teszt
  elhasal.

**Függősége:** olvasottság-tár API-n keresztül, session-slice.

### 4. Értesítés-kiküldő (Electron fő-folyamat)

**Mit csinál:** natív értesítést mutat, kezeli a kattintást, vezeti a dock-badge-et.

Új fájlok:

- `electron/preload.ts` — egyetlen `contextBridge` felület két csatornával:
  `notify(payload)` a rendererből ki, `onOpenChat(cb)` a fő-folyamatból be. A
  `webPreferences` (`main.ts:136`) megkapja a `preload` útvonalat; a
  `contextIsolation: true` / `nodeIntegration: false` **változatlan marad**.
- `electron/notifications.ts` — a `Notification` példányosítása, a
  `notification.on('click')` kezelése (`win.show()`, `win.focus()`, majd
  `webContents.send('open-chat', sessionId)`), és az `app.dock.setBadge`.

A renderer annyit tesz, hogy eldönti: *ez most értesítendő-e* — nem ez az aktív
chat vagy nincs fókusz; a globális kapcsoló be van kapcsolva; az ügynök nincs
némítva. A döntés a rendererben marad, mert csak ott ismert a fókusz és az aktív
chat; a kiküldés a fő-folyamatban, mert csak ott megbízható.

**Függősége:** preload-felület. Böngészőben a `window.swarmclaw?.notify`
egyszerűen nincs, és a lista-jelzés attól még működik.

## Beállítások

- **Globális:** `AppSettings` (`src/types/app-settings.ts:23`) új mezője
  `agentReplyNotifications?: boolean`, alapértéke `true`. A beállítások oldalon
  (`src/app/settings/page.tsx`) egy kapcsoló, `HintTip`-pel: mit csinál, és hogy
  a lista-jelzést **nem** kapcsolja ki.
- **Per-ügynök:** `Agent` (`src/types/agent.ts:43`) új mezője
  `replyNotificationsMuted?: boolean`, alapértéke `false`. Az ügynök-lapon az
  `AdvancedSettingsSection`-ben
  (`src/components/shared/advanced-settings-section.tsx`), mert ez power-user
  kapcsoló.
- Mindkettőhöz alapérték a `storage-normalization.ts`-ben.

## Hibakezelés

- **A `Notification` nem támogatott** (`Notification.isSupported() === false`):
  csendben kimarad, a lista-jelzés marad. Egy `log.info` induláskor, nem minden
  alkalommal.
- **Nincs preload-felület** (böngésző): ugyanaz, néma kihagyás.
- **A `POST .../read` elhasal:** a lokális optimista jelölés visszaáll, a jelzés
  újra megjelenik. A legrosszabb, ami történhet, hogy egy pont ott marad.
- **A migráció elhasal:** a `sc_last_read` kulcs **nem** törlődik, a következő
  betöltés újrapróbálja. Inkább fusson kétszer, mint hogy elvesszen.
- **Törölt chat értesítése:** a kattintás nem talál session-t → az ablak előjön,
  a chat nem nyílik meg, egy toast mondja meg, hogy a beszélgetés már nincs meg.

## Tesztelés

Egység:

- Olvasottság-származtatás: `lastAssistantAt` / `lastFailedTurnAt` / `lastReadAt`
  határesetei (mind `null`, egyenlőség, hibás turn a válasz után és előtte).
- Hibás-turn csatlakozó: `failed` ír, `cancelled` és `completed` nem.
- Türelmi idő: fókuszvesztés → 3 mp-en belüli visszatérés → olvasott marad;
  3 mp után → olvasatlan.
- Némítás: globális ki → nincs értesítés, de van lista-jelzés. Ügynök némítva →
  ugyanez, csak arra az ügynökre.
- Migráció: meglévő `sc_last_read` felmegy és a kulcs eltűnik; hibánál marad.
- `storage-normalization`: régi rekord mindkét új mezőre `null`-t kap.

Az új teszteket fel kell venni a `package.json` `test:runtime` listájába —
a suite explicit fájllistával fut, nem glob-bal, tehát ami nincs felsorolva, az
nem is fut le.

Élő (a CLAUDE.md szerint kötelező):

- Két chat, ügynök válaszol a nem-aktívban → megjelenik a jelzés **és** kijön az
  értesítés. Visszakattintás → mindkettő eltűnik.
- Ugyanez háttérbe tett ablakkal — ez a tulajdonképpeni funkció.
- Kattintás az értesítésen → az ablak előjön és a megfelelő chat nyílik meg.

## Kockázat, amit előre kell zárni

**Az ad-hoc aláírt macOS build.** A `SwarmClaw.app` `Signature=adhoc`, bundle id
`ai.swarmclaw.desktop`. A bundle id megvan, ami a szokásos buktató, de hogy egy
ad-hoc aláírt buildből tényleg megjelenik-e a rendszer-értesítés, azt nem lehet
papírból garantálni.

**A 2026-09-09-i próba érvénytelen volt, és ezt itt rögzítjük, hogy senki ne
hivatkozzon rá bizonyítékként.** A spike `npx electron`-nal futott, ami a
GENERIKUS Electron.app identitásával fut (`com.github.Electron`), nem a
SwarmClaw-éval. A `com.apple.ncprefs` 156 regisztrált appja között sem
`com.github.Electron`, sem `ai.swarmclaw.desktop` nem szerepel, tehát a próba
egy olyan bundle-t kérdezett, ami sosem regisztrált értesítésre. A Focus/DND
kizárva. Az egyetlen listán lévő Electron-app (Nimbalyst) rendesen aláírt, tehát
az ad-hoc kérdést nem dönti el.

**Semmilyen mérés nem mutat arra, hogy az ad-hoc aláírás lenne a fal.** A
SwarmClaw identitása viszont nem kölcsönözhető olcsón: egy csomagolt app a saját
asar-ját tölti, nem egy odaadott szkriptet.

**Ezért a kockázat a záró élő ellenőrzésbe kerül**, ahol maga a SwarmClaw.app
küld értesítést, és utána vagy megjelenik a Rendszerbeállítások → Értesítések
listájában, vagy nem. Ha ott bukik, aláírás kell; a tartalék az in-app jelzés
(toast + dock-badge), ami az ablakon belül aláírás nélkül is működik.

## Nem cél

- Chatroom-ok olvasatlan-jelzése.
- Scroll-alapú „meddig láttad" követés.
- Per-chat némítás (a per-ügynök elég; ha hiányozni fog, ráépíthető).
- Értesítés-előzmény vagy külön inbox — a meglévő `notifications` feedet nem
  bántjuk, épp azért, hogy ne fulladjon bele minden egyes válaszba.
- A `ws-client.ts` payload-továbbítása. Külön ügy, külön haszonnal.
